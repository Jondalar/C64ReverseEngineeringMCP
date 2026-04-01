import { decodeInstruction, hasFallthrough, isBranchInstruction, isCallInstruction, isJumpInstruction } from "../lib/mos6502";
import { analyzeIrqHandlerEvidence, isValidIrqHandler } from "./irq-analysis";
import { CrossReference, InstructionFact, MemoryMapping, ProbableCodeAnalysis, SegmentCandidate } from "./types";
import { clampConfidence, createCoverageMap, findUnclaimedRegions, formatAddress, segmentLength, toOffset } from "./utils";

interface DiscoverProbableCodeOptions {
  buffer: Buffer;
  mapping: MemoryMapping;
  candidateRegions: Array<{ start: number; end: number }>;
  confirmedCodeCandidates: SegmentCandidate[];
}

interface IslandProbe {
  instructions: InstructionFact[];
  xrefs: CrossReference[];
  confidence: number;
  reasons: string[];
}

interface ReferenceSupport {
  directOpcodeRefs: number;
  branchRefs: number;
  wordRefs: number;
  vectorRefs: number;
}

const MAX_ISLAND_INSTRUCTIONS = 48;
const MAX_ISLAND_BYTES = 192;
const MIN_ISLAND_CONFIDENCE = 0.76;
const SUSPICIOUS_MNEMONICS = new Set(["slo", "rla", "sre", "rra", "isc", "dcp", "anc", "alr", "arr", "xaa", "ahx", "shx", "shy", "tas", "las", "lax", "sax"]);
const ANCHOR_MNEMONICS = new Set(["lda", "ldx", "ldy", "sta", "stx", "sty", "jsr", "jmp", "cmp", "and", "ora", "inc", "dec", "nop", "sei", "cli", "clc", "sec"]);

function isHardwareAddress(address: number | undefined): boolean {
  return address !== undefined && ((address >= 0xd000 && address <= 0xd02e) || (address >= 0xd400 && address <= 0xd418) || address === 0xdd00);
}

function isUsefulStore(mnemonic: string): boolean {
  return mnemonic === "sta" || mnemonic === "stx" || mnemonic === "sty";
}

function referenceType(mnemonic: string): CrossReference["type"] {
  if (mnemonic === "jsr") {
    return "call";
  }
  if (mnemonic === "jmp") {
    return "jump";
  }
  return "branch";
}

function signedByte(value: number): number {
  return value >= 0x80 ? value - 0x100 : value;
}

function collectBranchRefs(buffer: Buffer, mapping: MemoryMapping): Map<number, number> {
  const refs = new Map<number, number>();
  const branchOpcodes = new Set([0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0]);

  for (let offset = 0; offset < buffer.length - 1; offset += 1) {
    const opcode = buffer[offset];
    if (!branchOpcodes.has(opcode)) {
      continue;
    }

    const source = mapping.startAddress + offset;
    const target = (source + 2 + signedByte(buffer[offset + 1])) & 0xffff;
    if (target < mapping.startAddress || target > mapping.endAddress) {
      continue;
    }

    refs.set(target, (refs.get(target) ?? 0) + 1);
  }

  return refs;
}

function collectVectorRefs(buffer: Buffer, mapping: MemoryMapping): Map<number, number> {
  const refs = new Map<number, number>();

  for (let offset = 0; offset < buffer.length - 9; offset += 1) {
    if (
      buffer[offset] === 0xa9 &&
      buffer[offset + 2] === 0x8d &&
      buffer[offset + 3] === 0x14 &&
      buffer[offset + 4] === 0x03 &&
      buffer[offset + 5] === 0xa9 &&
      buffer[offset + 7] === 0x8d &&
      buffer[offset + 8] === 0x15 &&
      buffer[offset + 9] === 0x03
    ) {
      const target = buffer[offset + 1] | (buffer[offset + 6] << 8);
      if (target >= mapping.startAddress && target <= mapping.endAddress) {
        refs.set(target, (refs.get(target) ?? 0) + 1);
      }
    }
  }

  return refs;
}

function probeIsland(
  address: number,
  buffer: Buffer,
  mapping: MemoryMapping,
  regionEnd: number,
  support: ReferenceSupport,
): IslandProbe | undefined {
  const instructions: InstructionFact[] = [];
  const xrefs: CrossReference[] = [];
  let cursor = address;
  let bytesConsumed = 0;
  let controlFlowCount = 0;
  let usefulStoreCount = 0;
  let hardwareTouchCount = 0;
  let immediateLoadCount = 0;
  let undocumentedCount = 0;

  while (instructions.length < MAX_ISLAND_INSTRUCTIONS && bytesConsumed < MAX_ISLAND_BYTES && cursor <= regionEnd) {
    const offset = toOffset(cursor, mapping);
    if (offset === undefined) {
      return undefined;
    }

    const decoded = decodeInstruction(buffer, offset, mapping.startAddress);
    if (decoded.address !== cursor || decoded.isUnknown || decoded.mnemonic === "jam") {
      return undefined;
    }

    const fallthroughAddress = hasFallthrough(decoded) ? (cursor + decoded.size) & 0xffff : undefined;
    const fact: InstructionFact = {
      address: cursor,
      opcode: decoded.opcode,
      size: decoded.size,
      bytes: decoded.bytes,
      mnemonic: decoded.mnemonic,
      addressingMode: decoded.mode,
      operandText: decoded.targetAddress !== undefined ? formatAddress(decoded.targetAddress) : "",
      operandValue: decoded.operand,
      targetAddress: decoded.targetAddress,
      fallthroughAddress,
      isKnownOpcode: true,
      isUndocumented: decoded.isUndocumented,
      isControlFlow: Boolean(decoded.targetAddress) || !hasFallthrough(decoded),
      provenance: "probable_code",
    };

    instructions.push(fact);
    bytesConsumed += decoded.size;

    if (decoded.targetAddress !== undefined) {
      xrefs.push({
        sourceAddress: cursor,
        targetAddress: decoded.targetAddress,
        type: referenceType(decoded.mnemonic),
        mnemonic: decoded.mnemonic,
        operandText: fact.operandText,
        confidence: 0.72,
        note: "Observed in a structured but not recursively confirmed code island.",
      });
    }

    if (fact.isControlFlow) {
      controlFlowCount += 1;
    }
    if (isUsefulStore(fact.mnemonic)) {
      usefulStoreCount += 1;
    }
    if (isHardwareAddress(fact.targetAddress)) {
      hardwareTouchCount += 1;
    }
    if (fact.mnemonic === "lda" && fact.addressingMode === "imm") {
      immediateLoadCount += 1;
    }
    if (fact.isUndocumented) {
      undocumentedCount += 1;
    }

    const endsIsland =
      fact.mnemonic === "rts" ||
      fact.mnemonic === "rti" ||
      fact.mnemonic === "jmp" ||
      fact.mnemonic === "brk";
    if (endsIsland) {
      break;
    }

    if (fallthroughAddress === undefined || fallthroughAddress > regionEnd) {
      break;
    }
    cursor = fallthroughAddress;
  }

  const minimumInstructions = support.vectorRefs >= 1 ? 3 : 5;
  if (instructions.length < minimumInstructions) {
    return undefined;
  }

  const last = instructions[instructions.length - 1];
  const hasStructuredEnding = last.mnemonic === "rts" || last.mnemonic === "rti" || last.mnemonic === "jmp";
  if (!hasStructuredEnding) {
    return undefined;
  }

  const hardReferenceCount = support.directOpcodeRefs + support.vectorRefs;
  if (hardReferenceCount === 0) {
    return undefined;
  }

  if (last.mnemonic === "rti" && !isValidIrqHandler(instructions, support.vectorRefs >= 1)) {
    return undefined;
  }

  if (
    hardwareTouchCount === 0 &&
    !(
      controlFlowCount >= 2 &&
      instructions.length >= 8 &&
      usefulStoreCount >= 2 &&
      hardReferenceCount >= 1
    )
  ) {
    return undefined;
  }

  const illegalRatio = undocumentedCount / instructions.length;
  if (illegalRatio > 0.35) {
    return undefined;
  }

  const irqEvidence = analyzeIrqHandlerEvidence(instructions, support.vectorRefs >= 1);
  const score = Math.min(
    0.88,
    clampConfidence(
    0.2 +
      Math.min(0.18, instructions.length * 0.012) +
      (hasStructuredEnding ? 0.18 : 0) +
      (controlFlowCount >= 1 ? 0.1 : 0) +
      (controlFlowCount >= 2 ? 0.05 : 0) +
      (usefulStoreCount >= 2 ? 0.08 : 0) +
      (hardwareTouchCount >= 1 ? 0.18 : 0) +
      (hardwareTouchCount >= 3 ? 0.05 : 0) +
      (support.directOpcodeRefs >= 1 ? 0.12 : 0) +
      (support.branchRefs >= 1 ? 0.08 : 0) +
      (support.vectorRefs >= 1 ? 0.24 : 0) +
      (support.wordRefs >= 2 && hardReferenceCount >= 1 ? 0.05 : 0) +
      (immediateLoadCount >= 1 ? 0.05 : 0) -
      (illegalRatio > 0.2 ? 0.18 : 0),
    ),
  );

  if (score < MIN_ISLAND_CONFIDENCE) {
    return undefined;
  }

  const reasons = [
    `Linear probe decoded ${instructions.length} consecutive instructions before a structured terminator.`,
    `${controlFlowCount} control-flow instruction(s) were observed inside the island.`,
    usefulStoreCount >= 2
      ? `${usefulStoreCount} store instruction(s) suggest stateful routine behavior rather than passive data.`
      : "Store activity is limited, so this remains a weaker code hypothesis.",
    hardwareTouchCount >= 1
      ? `${hardwareTouchCount} hardware-touching instruction(s) hit VIC/SID/CIA2 registers.`
      : "No direct hardware access was seen in this island.",
    last.mnemonic === "rti"
      ? irqEvidence.hasVectorReference && (irqEvidence.touchesRasterLine || irqEvidence.acknowledgesVicIrq || irqEvidence.chainsToKernalIrqTail)
        ? `RTI terminator is backed by IRQ-style evidence (${[
            irqEvidence.touchesRasterLine ? "$D012" : "",
            irqEvidence.acknowledgesVicIrq ? "$D019" : "",
            irqEvidence.chainsToKernalIrqTail ? "KERNAL tail jump" : "",
          ]
            .filter(Boolean)
            .join(", ")}).`
        : "RTI terminator is not enough on its own; this island needs a real IRQ entry and handler context."
      : support.vectorRefs >= 1
      ? `${support.vectorRefs} system-vector setup(s) point at the island start, so this is likely an IRQ/dispatcher entry.`
      : support.directOpcodeRefs >= 1
      ? `${support.directOpcodeRefs} direct JSR/JMP target reference(s) to the island start were found in the binary.`
      : support.branchRefs >= 1
        ? `${support.branchRefs} branch target reference(s) to the island start were found in the binary.`
        : "No inbound opcode/vector reference to the island start was found.",
  ];

  return {
    instructions,
    xrefs,
    confidence: score,
    reasons,
  };
}

function overlapsExisting(candidate: SegmentCandidate, chosen: SegmentCandidate[]): boolean {
  return chosen.some((existing) => candidate.start <= existing.end && existing.start <= candidate.end);
}

function trimLeadingNoise(instructions: InstructionFact[], xrefs: CrossReference[]): { instructions: InstructionFact[]; xrefs: CrossReference[] } {
  const headWindow = instructions.slice(0, Math.min(4, instructions.length));
  const anchoredHead =
    headWindow.length >= 3 &&
    ANCHOR_MNEMONICS.has(instructions[0].mnemonic) &&
    headWindow.every((instruction) => !SUSPICIOUS_MNEMONICS.has(instruction.mnemonic) && !instruction.isUndocumented);
  if (anchoredHead) {
    return { instructions, xrefs };
  }

  const limit = Math.min(8, instructions.length - 4);
  let bestStartIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let startIndex = 0; startIndex <= limit; startIndex += 1) {
    const window = instructions.slice(startIndex, Math.min(instructions.length, startIndex + 8));
    if (window.length < 4) {
      continue;
    }

    const first = window[0];
    const suspiciousCount = window.slice(0, 3).filter((instruction) => SUSPICIOUS_MNEMONICS.has(instruction.mnemonic)).length;
    const hardwareTouchCount = window.filter((instruction) => isHardwareAddress(instruction.targetAddress)).length;
    const structuredCount = window.filter(
      (instruction) =>
        ANCHOR_MNEMONICS.has(instruction.mnemonic) || instruction.mnemonic.startsWith("b") || instruction.mnemonic === "rts" || instruction.mnemonic === "rti",
    ).length;
    const firstAnchorBonus = ANCHOR_MNEMONICS.has(first.mnemonic) ? 0.8 : 0;
    const score = firstAnchorBonus + structuredCount * 0.22 + hardwareTouchCount * 0.45 - suspiciousCount * 0.5 - startIndex * 0.08;

    if (score > bestScore) {
      bestScore = score;
      bestStartIndex = startIndex;
    }
  }

  if (bestStartIndex === 0) {
    return { instructions, xrefs };
  }

  const startAddress = instructions[bestStartIndex].address;
  return {
    instructions: instructions.slice(bestStartIndex),
    xrefs: xrefs.filter((xref) => xref.sourceAddress >= startAddress),
  };
}

export function discoverProbableCode(options: DiscoverProbableCodeOptions): ProbableCodeAnalysis {
  const chosenCandidates: SegmentCandidate[] = [];
  const chosenInstructions: InstructionFact[] = [];
  const chosenXrefs: CrossReference[] = [];
  const directOpcodeRefs = new Map<number, number>();
  const branchRefs = collectBranchRefs(options.buffer, options.mapping);
  const vectorRefs = collectVectorRefs(options.buffer, options.mapping);
  const wordRefs = new Map<number, number>();

  for (let offset = 0; offset < options.buffer.length - 1; offset += 1) {
    const address = options.mapping.startAddress + offset;
    const word = options.buffer[offset] | ((options.buffer[offset + 1] ?? 0) << 8);
    wordRefs.set(word, (wordRefs.get(word) ?? 0) + 1);

    if (offset < options.buffer.length - 2) {
      const opcode = options.buffer[offset];
      if (opcode === 0x20 || opcode === 0x4c || opcode === 0x6c) {
        const target = options.buffer[offset + 1] | (options.buffer[offset + 2] << 8);
        directOpcodeRefs.set(target, (directOpcodeRefs.get(target) ?? 0) + 1);
      }
    }
  }

  for (const region of options.candidateRegions) {
    const probes: SegmentCandidate[] = [];
    const probeDetails = new Map<number, IslandProbe>();

    for (let address = region.start; address <= region.end; address += 1) {
      const probe = probeIsland(address, options.buffer, options.mapping, region.end, {
        directOpcodeRefs: directOpcodeRefs.get(address) ?? 0,
        branchRefs: branchRefs.get(address) ?? 0,
        wordRefs: wordRefs.get(address) ?? 0,
        vectorRefs: vectorRefs.get(address) ?? 0,
      });
      if (!probe) {
        continue;
      }

      const trimmed = trimLeadingNoise(probe.instructions, probe.xrefs);
      if (trimmed.instructions.length < 5) {
        continue;
      }

      const start = trimmed.instructions[0].address;
      const end = trimmed.instructions[trimmed.instructions.length - 1].address + trimmed.instructions[trimmed.instructions.length - 1].size - 1;
      const candidate: SegmentCandidate = {
        analyzerId: "probable-code",
        kind: "code",
        start,
        end,
        score: {
          confidence: probe.confidence,
          reasons: [
            ...probe.reasons,
            trimmed.instructions[0].address !== probe.instructions[0].address
              ? `Trimmed ${trimmed.instructions[0].address - probe.instructions[0].address} noisy leading byte(s) before the first plausible routine head.`
              : "Routine head already aligned to the first plausible instruction.",
            `Island spans ${segmentLength(start, end)} bytes at ${formatAddress(start)}-${formatAddress(end)}.`,
            "Region is not yet reachable from trusted entry points, so it remains a probable code island.",
          ],
        },
        xrefs: trimmed.xrefs,
        attributes: {
          provenance: "probable_code",
          instructionCount: trimmed.instructions.length,
        },
      };
      probes.push(candidate);
      probeDetails.set(start, {
        ...probe,
        instructions: trimmed.instructions,
        xrefs: trimmed.xrefs,
      });
    }

    probes.sort((left, right) => {
      if (right.score.confidence !== left.score.confidence) {
        return right.score.confidence - left.score.confidence;
      }
      if (left.start !== right.start) {
        return left.start - right.start;
      }
      return segmentLength(right.start, right.end) - segmentLength(left.start, left.end);
    });

    for (const candidate of probes) {
      if (overlapsExisting(candidate, chosenCandidates)) {
        continue;
      }

      chosenCandidates.push(candidate);
      const probe = probeDetails.get(candidate.start);
      if (!probe) {
        continue;
      }
      chosenInstructions.push(...probe.instructions);
      chosenXrefs.push(...probe.xrefs);
    }
  }

  const coverage = createCoverageMap(options.mapping, [...options.confirmedCodeCandidates, ...chosenCandidates]);
  const remaining = findUnclaimedRegions(options.mapping, coverage);

  return {
    instructions: chosenInstructions.sort((left, right) => left.address - right.address),
    xrefs: chosenXrefs.sort((left, right) => left.sourceAddress - right.sourceAddress),
    codeCandidates: chosenCandidates.sort((left, right) => left.start - right.start),
    notes: [
      `${chosenCandidates.length} probable code island(s) were recovered from unclaimed regions.`,
      `${remaining.length} unclaimed region(s) remain after subtracting probable code islands.`,
    ],
  };
}
