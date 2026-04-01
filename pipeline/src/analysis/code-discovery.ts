import { decodeInstruction, hasFallthrough, isBranchInstruction, isCallInstruction, isJumpInstruction } from "../lib/mos6502";
import { hex16 } from "../lib/format";
import { BasicBlock, CodeAnalysis, CrossReference, EntryPoint, InstructionFact, MemoryMapping, SegmentCandidate } from "./types";
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

export function discoverCode(options: DiscoverCodeOptions): CodeAnalysis {
  const queue = options.entryPoints.map((entryPoint) => entryPoint.address);
  const visitedStarts = new Set<number>();
  const claimedBytes = new Map<number, number>();
  const instructions: InstructionFact[] = [];
  const xrefs: CrossReference[] = [];
  const leaders = new Set<number>(queue);

  while (queue.length > 0) {
    const startAddress = queue.shift()!;
    let address = startAddress;

    while (address >= options.mapping.startAddress && address <= options.mapping.endAddress) {
      if (visitedStarts.has(address)) {
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
        break;
      }

      visitedStarts.add(address);
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
        queue.push(instruction.targetAddress);
        leaders.add(instruction.targetAddress);
      } else if (isJumpInstruction(instruction)) {
        if (instruction.mode === "abs" && instruction.targetAddress !== undefined) {
          queue.push(instruction.targetAddress);
          leaders.add(instruction.targetAddress);
        }
        break;
      } else if (isBranchInstruction(instruction) && instruction.targetAddress !== undefined) {
        queue.push(instruction.targetAddress);
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

  const sortedInstructions = instructions.sort((left, right) => left.address - right.address);
  const codeCandidates = buildCodeCandidates(sortedInstructions, options.entryPoints);
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
  };
}

function buildCodeCandidates(instructions: InstructionFact[], entryPoints: EntryPoint[]): SegmentCandidate[] {
  if (instructions.length === 0) {
    return [];
  }

  const entrySet = new Set(entryPoints.map((entryPoint) => entryPoint.address));
  const basicStubEntries = new Set(
    entryPoints.filter((entryPoint) => entryPoint.source === "basic_sys").map((entryPoint) => entryPoint.address),
  );
  const candidates: SegmentCandidate[] = [];
  let runStart = instructions[0].address;
  let runEnd = instructions[0].address + instructions[0].size - 1;
  let runEntry = entrySet.has(runStart);
  let runBasicStub = basicStubEntries.has(runStart);

  for (const instruction of instructions.slice(1)) {
    const instructionStart = instruction.address;
    const instructionEnd = instruction.address + instruction.size - 1;
    if (instructionStart <= runEnd + 1) {
      runEnd = Math.max(runEnd, instructionEnd);
      continue;
    }

    candidates.push(makeCodeCandidate(runStart, runEnd, runEntry, runBasicStub));
    runStart = instructionStart;
    runEnd = instructionEnd;
    runEntry = entrySet.has(runStart);
    runBasicStub = basicStubEntries.has(runStart);
  }

  candidates.push(makeCodeCandidate(runStart, runEnd, runEntry, runBasicStub));
  return candidates;
}

function makeCodeCandidate(start: number, end: number, entryPoint: boolean, basicStubEntry: boolean): SegmentCandidate {
  const kind = basicStubEntry ? "basic_stub" : "code";
  return {
    analyzerId: "code",
    kind,
    start,
    end,
    score: {
      confidence: clampConfidence(kind === "basic_stub" ? 0.99 : 0.94),
      reasons: [
        `Recursive traversal reached ${segmentLength(start, end)} bytes from a trusted entry point.`,
        `Control-flow edges remained valid within ${formatAddress(start)}-${formatAddress(end)}.`,
        basicStubEntry
          ? "Entry point comes from a detected BASIC SYS stub."
          : entryPoint
            ? "Region starts at an explicit execution entry/trampoline."
            : "Region consists of reachable instructions rather than a naive linear opcode run.",
      ],
    },
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
