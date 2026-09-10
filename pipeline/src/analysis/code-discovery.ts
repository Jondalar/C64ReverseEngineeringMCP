import { decodeInstruction, hasFallthrough, isBranchInstruction, isCallInstruction, isJumpInstruction } from "../lib/mos6502";
import { hex16 } from "../lib/format";
import { BasicProgramInfo, detectBasicProgram } from "./prg";
import { BasicBlock, CodeAnalysis, CrossReference, EntryPoint, EntryPointRejection, InstructionFact, MemoryMapping, SegmentCandidate } from "./types";
import { clampConfidence, createCoverageMap, findUnclaimedRegions, formatAddress, segmentLength, toOffset } from "./utils";

interface DiscoverCodeOptions {
  binaryName: string;
  buffer: Buffer;
  mapping: MemoryMapping;
  entryPoints: EntryPoint[];
}

function controlFlowReferenceType(mnemonic: string): CrossReference["type"] {
  if (mnemonic === "jsr") {
    return "call";
  }
  if (mnemonic === "jmp") {
    return "jump";
  }
  return "branch";
}

function makeOperandText(targetAddress: number | undefined): string {
  if (targetAddress === undefined) {
    return "";
  }
  return `$${hex16(targetAddress).toUpperCase()}`;
}

/** Read one byte at an absolute address from the image (undefined if out of range). */
function peekByte(buffer: Buffer, mapping: MemoryMapping, address: number): number | undefined {
  const offset = toOffset(address & 0xffff, mapping);
  if (offset === undefined || offset < 0 || offset >= buffer.length) {
    return undefined;
  }
  return buffer[offset];
}

/**
 * Spec 758 §3.1 + §3.2 — recover code entry points that recursive descent cannot
 * reach by following control flow:
 *  - §3.1 single indirect `jmp ($abs)`: the 16-bit pointer stored at $abs.
 *  - §3.2 self-modified `jmp`/`jsr` operand: `lda #lo / sta J+1 / lda #hi /
 *    sta J+2` patches the target into a `jmp`/`jsr` instruction's operand bytes.
 * Both yield EXACT targets (real code), so seeding them never promotes data.
 */
function recoverSeeds(instructions: InstructionFact[], buffer: Buffer, mapping: MemoryMapping): number[] {
  const seeds = new Set<number>();
  const inRange = (addr: number): boolean => addr >= mapping.startAddress && addr <= mapping.endAddress;

  // §3.1 — single indirect jump: resolve the pointer at the operand address.
  for (const ins of instructions) {
    if (ins.mnemonic === "jmp" && ins.addressingMode === "ind" && ins.operandValue !== undefined) {
      const base = ins.operandValue & 0xffff;
      const lo = peekByte(buffer, mapping, base);
      const hi = peekByte(buffer, mapping, (base + 1) & 0xffff);
      if (lo !== undefined && hi !== undefined) {
        const target = (lo | (hi << 8)) & 0xffff;
        if (inRange(target)) seeds.add(target);
      }
    }
  }

  // §3.2 — self-modified jmp/jsr operand. Map each absolute jmp/jsr's operand
  // byte addresses to the instruction, then watch `lda #imm` → `sta <operand byte>`.
  const operandByteOwner = new Map<number, number>(); // operand-byte address → jmp/jsr address
  for (const ins of instructions) {
    if ((ins.mnemonic === "jmp" || ins.mnemonic === "jsr") && ins.addressingMode === "abs") {
      operandByteOwner.set((ins.address + 1) & 0xffff, ins.address);
      operandByteOwner.set((ins.address + 2) & 0xffff, ins.address);
    }
  }
  const patch = new Map<number, { lo?: number; hi?: number }>(); // jmp/jsr address → patched bytes
  const ordered = [...instructions].sort((a, b) => a.address - b.address);
  let lastImm: number | undefined;
  for (const ins of ordered) {
    if (ins.mnemonic === "lda" && ins.addressingMode === "imm") {
      lastImm = ins.operandValue;
    } else if (ins.mnemonic === "sta" && ins.addressingMode === "abs" && ins.operandValue !== undefined && lastImm !== undefined) {
      const owner = operandByteOwner.get(ins.operandValue & 0xffff);
      if (owner !== undefined) {
        const entry = patch.get(owner) ?? {};
        if ((ins.operandValue & 0xffff) === ((owner + 1) & 0xffff)) entry.lo = lastImm;
        else entry.hi = lastImm;
        patch.set(owner, entry);
      }
    }
  }
  for (const [, e] of patch) {
    if (e.lo !== undefined && e.hi !== undefined) {
      const target = (e.lo | (e.hi << 8)) & 0xffff;
      if (inRange(target)) seeds.add(target);
    }
  }

  return [...seeds];
}

/** Spec 829 D4.1 — the `basic` candidate for a walked BASIC V2 program.
 *  ONE segment over the whole program: the chain walk proved where it starts
 *  and ends, so there is nothing for a byte-shape analyzer to subdivide. Its
 *  reasons carry every extracted fact, INCLUDING the unresolved ones — that is
 *  where `detectBasicSysEntry` deliberately does not put them, because there
 *  they would be filed under one target address instead of under the program. */
function makeBasicCandidate(program: BasicProgramInfo): SegmentCandidate {
  const factReasons = program.facts.map((fact) => {
    const where = `line ${fact.lineNumber}, token at ${formatAddress(fact.site)}`;
    if (fact.kind === "load") {
      return `LOAD ${fact.fileName !== undefined ? `"${fact.fileName}"` : "(name unresolved)"} (${where}).`;
    }
    const verb = fact.kind.toUpperCase();
    if (fact.value === undefined) {
      return `${verb} UNRESOLVED: ${fact.expression ?? "expression not constant"} (${where}).`;
    }
    return `${verb} ${formatAddress(fact.value)} (${fact.value}), ${fact.confidence} (${where}).`;
  });

  return {
    analyzerId: "code",
    kind: "basic",
    start: program.start,
    end: program.end,
    score: {
      confidence: clampConfidence(0.99),
      reasons: [
        `Tokenized BASIC V2 ${program.isStub ? "SYS launcher" : "program"}: the line-record chain walked cleanly over ` +
          `${program.lineCount} line(s) from ${formatAddress(program.start)} to ${formatAddress(program.end)} (Spec 829 D2).`,
        `Not 6502 — the disassembler renders this region as data, not instructions (Spec 829 D6, issue #11).`,
        `Machine code discovery resumes at ${formatAddress(program.firstAddressAfter)} (Spec 829 D4.1).`,
        ...factReasons,
      ],
    },
    attributes: {
      basicLineCount: program.lineCount,
      basicFirstAddressAfter: program.firstAddressAfter,
      basicFacts: program.facts,
    },
  };
}

export function discoverCode(options: DiscoverCodeOptions): CodeAnalysis {
  // Spec 829 D4.1 — a BASIC program at the head of the image is walked BEFORE
  // recursive descent starts, so descent can be kept out of it. The ML the
  // program SYSes into sits AFTER the program's terminator and is still
  // discovered normally: the entry point for it came from the SYS itself.
  const basicProgram = detectBasicProgram(options.buffer, options.mapping);
  const insideBasic = (address: number): boolean =>
    basicProgram !== undefined && address >= basicProgram.start && address < basicProgram.firstAddressAfter;

  // An entry point that lands INSIDE the tokenized program is not an entry
  // point into code — most often it is deriveEntryPoints' `prg_header`
  // fallback pointing at $0801, which is exactly how a pure BASIC program used
  // to get disassembled as 6502 from its first token byte.
  //
  // Spec 838 D3c — the queue carries the SEED each walk descended from, so a
  // region promoted out of `unknown` can name what reached it. Without that a
  // wrong promotion is merely plausible; with it, it is visible.
  const queue: Array<{ address: number; root: number }> = options.entryPoints
    .map((entryPoint) => entryPoint.address)
    .filter((address) => !insideBasic(address))
    .map((address) => ({ address, root: address }));
  const visitedStarts = new Set<number>();
  const claimedBytes = new Map<number, number>();
  const instructions: InstructionFact[] = [];
  const xrefs: CrossReference[] = [];
  const leaders = new Set<number>(queue.map((item) => item.address));
  /** instruction start → the seed address whose walk first reached it (Spec 838 D3c) */
  const rootByStart = new Map<number, number>();
  /** addresses where a walk stopped because another decode already owned the bytes (Spec 838 D3a) */
  const blockedStarts = new Set<number>();

  // Spec 758 — recursive descent is run to a FIXED POINT: after the flow-reachable
  // queue drains, recover extra seeds (indirect-jump pointers §3.1, self-modified
  // jmp/jsr operands §3.2) that flow analysis can't reach, queue them, and descend
  // again. The recovered seeds are EXACT jump targets (real code), so this stays
  // rebuild-safe (no speculative data→code promotion — that is the coherence pass).
  for (let iteration = 0; iteration < 8; iteration += 1) {
  while (queue.length > 0) {
    const { address: startAddress, root } = queue.shift()!;
    let address = startAddress;

    while (address >= options.mapping.startAddress && address <= options.mapping.endAddress) {
      if (visitedStarts.has(address)) {
        break;
      }

      // Spec 829 D4.1 — never decode into the tokenized program, whichever way
      // the walk got here (fallthrough off the end of a preceding run, or a
      // branch/jump target that happens to land in the token bytes).
      if (insideBasic(address)) {
        break;
      }

      const offset = toOffset(address, options.mapping);
      if (offset === undefined) {
        break;
      }

      const instruction = decodeInstruction(options.buffer, offset, options.mapping.startAddress);
      if (instruction.address !== address) {
        break;
      }

      if (instruction.isUnknown) {
        break;
      }

      let overlapsExisting = false;
      for (let index = 0; index < instruction.size; index += 1) {
        const claimedBy = claimedBytes.get(address + index);
        if (claimedBy !== undefined && claimedBy !== address) {
          overlapsExisting = true;
          break;
        }
      }

      if (overlapsExisting) {
        // Spec 838 D3a, the byte-level twin of the refused entry point: two
        // seeds decode the same bytes at two alignments and this walk lost.
        // Whether that costs anything depends on where the other decode starts,
        // so it is recorded now and judged after the descent has finished.
        blockedStarts.add(address);
        break;
      }

      visitedStarts.add(address);
      rootByStart.set(address, root);
      for (let index = 0; index < instruction.size; index += 1) {
        claimedBytes.set(address + index, address);
      }

      const fallthroughAddress = hasFallthrough(instruction) ? (address + instruction.size) & 0xffff : undefined;
      instructions.push({
        address,
        opcode: instruction.opcode,
        size: instruction.size,
        bytes: instruction.bytes,
        mnemonic: instruction.mnemonic,
        addressingMode: instruction.mode,
        operandText: makeOperandText(instruction.targetAddress),
        operandValue: instruction.operand,
        targetAddress: instruction.targetAddress,
        fallthroughAddress,
        isKnownOpcode: true,
        isUndocumented: instruction.isUndocumented,
        isControlFlow: Boolean(instruction.targetAddress) || !hasFallthrough(instruction),
        provenance: "confirmed_code",
      });

      if (instruction.targetAddress !== undefined) {
        xrefs.push({
          sourceAddress: address,
          targetAddress: instruction.targetAddress,
          type: controlFlowReferenceType(instruction.mnemonic),
          mnemonic: instruction.mnemonic,
          operandText: makeOperandText(instruction.targetAddress),
          confidence: 0.95,
        });
      }

      if (isCallInstruction(instruction) && instruction.targetAddress !== undefined) {
        queue.push({ address: instruction.targetAddress, root });
        leaders.add(instruction.targetAddress);
      } else if (isJumpInstruction(instruction)) {
        if (instruction.mode === "abs" && instruction.targetAddress !== undefined) {
          queue.push({ address: instruction.targetAddress, root });
          leaders.add(instruction.targetAddress);
        }
        break;
      } else if (isBranchInstruction(instruction) && instruction.targetAddress !== undefined) {
        queue.push({ address: instruction.targetAddress, root });
        leaders.add(instruction.targetAddress);
        if (fallthroughAddress !== undefined) {
          leaders.add(fallthroughAddress);
          address = fallthroughAddress;
          continue;
        }
        break;
      } else if (!hasFallthrough(instruction)) {
        break;
      }

      if (fallthroughAddress === undefined) {
        break;
      }

      xrefs.push({
        sourceAddress: address,
        targetAddress: fallthroughAddress,
        type: "fallthrough",
        mnemonic: instruction.mnemonic,
        operandText: makeOperandText(fallthroughAddress),
        confidence: 0.6,
      });

      address = fallthroughAddress;
    }
  }

    // Recover seeds the flow could not reach (§3.1 indirect / §3.2 self-mod).
    const recovered = recoverSeeds(instructions, options.buffer, options.mapping);
    let addedSeed = false;
    for (const seed of recovered) {
      if (!visitedStarts.has(seed) && seed >= options.mapping.startAddress && seed <= options.mapping.endAddress) {
        queue.push({ address: seed, root: seed });
        leaders.add(seed);
        addedSeed = true;
      }
    }
    if (!addedSeed) {
      break;
    }
  }

  // ---------------------------------------------------------------- Spec 838 D3a
  //
  // An entry point that never became an instruction start was DROPPED, and until
  // now it was dropped in silence — the reported symptom (issue #16): the caller
  // supplies an address, the listing does not change, and nothing says why.
  //
  // The decision is TELL, not split. Three reasons, in order of weight:
  //  1. `already_code` needs no split — the address IS an instruction start; the
  //     entry was satisfied by another walk, nothing was lost.
  //  2. `inside_instruction` COULD be split, and must not be: honouring it means
  //     decoding the same bytes twice at two alignments, and only one of the two
  //     can be emitted. The byte-identical rebuild (D3c) is the guarantee that
  //     would pay for it. The conflict is real information, so the covering
  //     instruction and the seed that claimed it are both named and the human
  //     decides — the analyzer does not silently pick a winner.
  //  3. everything else (`out_of_range`, `inside_basic`, `undecodable`) is a
  //     refusal with an obvious cause, which was equally invisible before.
  const rejectedEntryPoints: EntryPointRejection[] = [];
  for (const entryPoint of options.entryPoints) {
    const address = entryPoint.address;
    if (visitedStarts.has(address)) {
      const root = rootByStart.get(address);
      if (root === address) continue; // this entry seeded its own walk
      rejectedEntryPoints.push({
        address,
        source: entryPoint.source,
        reason: "already_code",
        detail: root === undefined
          ? "already an instruction start"
          : `already an instruction start — reached first from ${formatAddress(root)}; the entry added nothing and cost nothing`,
      });
      continue;
    }
    if (insideBasic(address)) {
      rejectedEntryPoints.push({
        address,
        source: entryPoint.source,
        reason: "inside_basic",
        detail: `inside the tokenized BASIC program ${formatAddress(basicProgram!.start)}-${formatAddress(basicProgram!.firstAddressAfter - 1)} (Spec 829 D4.1) — not seeded`,
      });
      continue;
    }
    const owner = claimedBytes.get(address);
    if (owner !== undefined && owner !== address) {
      rejectedEntryPoints.push({
        address,
        source: entryPoint.source,
        reason: "inside_instruction",
        detail:
          `IGNORED: it lands inside the instruction at ${formatAddress(owner)}, which was decoded from seed ` +
          `${formatAddress(rootByStart.get(owner) ?? owner)}. Seeding it would need the same bytes decoded twice ` +
          `at two alignments and only one can be emitted, so nothing was promoted here. If this address is the ` +
          `real entry, the decode at ${formatAddress(owner)} is the thing that is wrong.`,
      });
      continue;
    }
    const offset = toOffset(address, options.mapping);
    const decoded = offset === undefined ? undefined : decodeInstruction(options.buffer, offset, options.mapping.startAddress);
    rejectedEntryPoints.push({
      address,
      source: entryPoint.source,
      reason: "undecodable",
      detail: decoded === undefined || decoded.isUnknown
        ? `the byte there is not a decodable opcode — not seeded`
        : `decode started but produced no instruction — not seeded`,
    });
  }

  // Spec 838 D3a — bytes no decode ended up owning because two seeds disagreed
  // about the alignment. Measured on Wasteland block2: supplying the 190-address
  // entry list strands 3 single bytes this way. They are the residue of the same
  // conflict the `inside_instruction` refusal names, and deciding which decode is
  // right is exactly the guess this analyzer must not make — so it says so.
  const strandedByDecodeConflict: Array<{ address: number; blockedBy: number; blockerSeed: number }> = [];
  for (const address of [...blockedStarts].sort((left, right) => left - right)) {
    if (claimedBytes.has(address)) continue;
    let blocker: number | undefined;
    for (let index = 0; index < 3; index += 1) {
      const owner = claimedBytes.get(address + index);
      if (owner !== undefined) { blocker = owner; break; }
    }
    if (blocker === undefined) continue;
    strandedByDecodeConflict.push({ address, blockedBy: blocker, blockerSeed: rootByStart.get(blocker) ?? blocker });
  }

  const sortedInstructions = instructions.sort((left, right) => left.address - right.address);
  const codeCandidates = buildCodeCandidates(sortedInstructions, options.entryPoints, rootByStart);
  // Spec 829 D4.1 — ONE `basic` segment over the whole program, emitted next to
  // the code candidates so it is in the coverage map below. That is what keeps
  // the probable-code linear scanner (which rakes every UNCLAIMED region) from
  // re-deriving 6502 across the token bytes the descent above just refused.
  if (basicProgram) {
    codeCandidates.unshift(makeBasicCandidate(basicProgram));
  }
  const basicBlocks = buildBasicBlocks(sortedInstructions, leaders);
  const coverage = createCoverageMap(options.mapping, codeCandidates);
  const unclaimedRegions = findUnclaimedRegions(options.mapping, coverage);

  return {
    entryPoints: options.entryPoints,
    instructions: sortedInstructions,
    basicBlocks,
    xrefs,
    codeCandidates,
    unclaimedRegions,
    rejectedEntryPoints,
    strandedByDecodeConflict,
    seedRoots: [...rootByStart.entries()].sort((l, r) => l[0] - r[0]).map(([address, rootAddress]) => ({ address, root: rootAddress })),
  };
}

function buildCodeCandidates(
  instructions: InstructionFact[],
  entryPoints: EntryPoint[],
  rootByStart: Map<number, number>,
): SegmentCandidate[] {
  if (instructions.length === 0) {
    return [];
  }

  const entrySet = new Set(entryPoints.map((entryPoint) => entryPoint.address));
  const entryByAddress = new Map(entryPoints.map((entryPoint) => [entryPoint.address, entryPoint] as const));
  const basicStubEntries = new Set(
    entryPoints.filter((entryPoint) => entryPoint.source === "basic_sys").map((entryPoint) => entryPoint.address),
  );
  const candidates: SegmentCandidate[] = [];
  let runStart = instructions[0].address;
  let runEnd = instructions[0].address + instructions[0].size - 1;
  let runEntry = entrySet.has(runStart);
  let runBasicStub = basicStubEntries.has(runStart);
  let runRoots = new Set<number>([rootByStart.get(runStart) ?? runStart]);

  const flush = (): void => {
    candidates.push(makeCodeCandidate(runStart, runEnd, runEntry, runBasicStub, runRoots, entryByAddress));
  };

  for (const instruction of instructions.slice(1)) {
    const instructionStart = instruction.address;
    const instructionEnd = instruction.address + instruction.size - 1;
    if (instructionStart <= runEnd + 1) {
      runEnd = Math.max(runEnd, instructionEnd);
      const root = rootByStart.get(instructionStart);
      if (root !== undefined) runRoots.add(root);
      continue;
    }

    flush();
    runStart = instructionStart;
    runEnd = instructionEnd;
    runEntry = entrySet.has(runStart);
    runBasicStub = basicStubEntries.has(runStart);
    runRoots = new Set<number>([rootByStart.get(runStart) ?? runStart]);
  }

  flush();
  return candidates;
}

/**
 * Spec 838 D3c — a run that only the graph reached must SAY which seed reached
 * it. The reason line names the seed address and its origin, and
 * `attributes.seededBy` carries the same thing structured, so a wrong promotion
 * shows up as a named claim rather than as a plausible-looking listing.
 */
function makeCodeCandidate(
  start: number,
  end: number,
  entryPoint: boolean,
  basicStubEntry: boolean,
  roots: Set<number>,
  entryByAddress: Map<number, EntryPoint>,
): SegmentCandidate {
  const kind = basicStubEntry ? "basic_stub" : "code";
  const seeded = [...roots]
    .sort((l, r) => l - r)
    .map((address) => ({ address, entry: entryByAddress.get(address) }))
    .filter((item): item is { address: number; entry: EntryPoint } => item.entry !== undefined);
  const graphSeeds = seeded.filter((item) => item.entry.source === "graph");
  const otherSeeds = seeded.filter((item) => item.entry.source !== "graph");
  const seedLine = graphSeeds.length > 0
    ? `${otherSeeds.length === 0 ? "Reached ONLY because the graph named a seed" : "Also reached from a graph seed"}: ${graphSeeds
        .map((item) => `${formatAddress(item.address)} (${item.entry.seedOrigin ?? "graph"}) — ${item.entry.reason}`)
        .join("; ")} [Spec 838 D3b]`
    : undefined;
  return {
    analyzerId: "code",
    kind,
    start,
    end,
    score: {
      confidence: clampConfidence(kind === "basic_stub" ? 0.99 : 0.94),
      reasons: [
        ...(seedLine ? [seedLine] : []),
        `Recursive traversal reached ${segmentLength(start, end)} bytes from a trusted entry point.`,
        `Control-flow edges remained valid within ${formatAddress(start)}-${formatAddress(end)}.`,
        basicStubEntry
          ? "Entry point comes from a detected BASIC SYS stub."
          : entryPoint
            ? "Region starts at an explicit execution entry/trampoline."
            : "Region consists of reachable instructions rather than a naive linear opcode run.",
      ],
    },
    attributes: seeded.length > 0
      ? {
          seededBy: seeded.map((item) => ({
            address: item.address,
            source: item.entry.source,
            origin: item.entry.seedOrigin,
            reason: item.entry.reason,
          })),
        }
      : undefined,
  };
}

function buildBasicBlocks(instructions: InstructionFact[], leaders: Set<number>): BasicBlock[] {
  const blocks: BasicBlock[] = [];
  if (instructions.length === 0) {
    return blocks;
  }

  const leaderList = Array.from(leaders).sort((left, right) => left - right);
  const leaderSet = new Set(leaderList);
  let currentBlockStart: number | undefined;
  let currentBlockEnd = 0;
  let currentSuccessors: number[] = [];

  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (currentBlockStart === undefined) {
      currentBlockStart = instruction.address;
    } else if (leaderSet.has(instruction.address) && instruction.address !== currentBlockStart) {
      blocks.push({
        start: currentBlockStart,
        end: currentBlockEnd,
        successors: Array.from(new Set(currentSuccessors)).sort((left, right) => left - right),
      });
      currentBlockStart = instruction.address;
      currentSuccessors = [];
    }

    currentBlockEnd = instruction.address + instruction.size - 1;

    if (instruction.targetAddress !== undefined) {
      currentSuccessors.push(instruction.targetAddress);
    }
    if (instruction.fallthroughAddress !== undefined) {
      currentSuccessors.push(instruction.fallthroughAddress);
    }
  }

  if (currentBlockStart !== undefined) {
    blocks.push({
      start: currentBlockStart,
      end: currentBlockEnd,
      successors: Array.from(new Set(currentSuccessors)).sort((left, right) => left - right),
    });
  }

  return blocks;
}
