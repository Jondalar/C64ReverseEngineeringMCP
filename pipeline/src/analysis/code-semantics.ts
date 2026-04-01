import {
  AnalyzerContext,
  CodeProvenance,
  CodeSemantics,
  CopyRoutineFact,
  HardwareTargetedCopyFact,
  IndexedRegister,
  IndirectPointerConstructionFact,
  InstructionFact,
  SegmentKind,
  SidDataSourceFact,
  SplitPointerTableFact,
  TableUsageFact,
} from "./types";
import { clampConfidence, formatAddress, toOffset } from "./utils";

const INDEXED_MODES = new Map<string, IndexedRegister>([
  ["abs,x", "x"],
  ["abs,y", "y"],
]);

function getInstructionPools(context: AnalyzerContext): Array<{ provenance: CodeProvenance; instructions: InstructionFact[] }> {
  const pools: Array<{ provenance: CodeProvenance; instructions: InstructionFact[] }> = [];
  if (context.discoveredCode?.instructions.length) {
    pools.push({ provenance: "confirmed_code", instructions: context.discoveredCode.instructions });
  }
  if (context.probableCode?.instructions.length) {
    pools.push({ provenance: "probable_code", instructions: context.probableCode.instructions });
  }
  return pools;
}

function isAbsoluteIndexedAccess(instruction: InstructionFact): instruction is InstructionFact & { targetAddress: number } {
  return instruction.targetAddress !== undefined && INDEXED_MODES.has(instruction.addressingMode);
}

function isHardwareAddress(address: number): boolean {
  return (address >= 0xd000 && address <= 0xdfff) || address === 0xdd00;
}

function formatByte(value: number | undefined): string {
  if (value === undefined) {
    return "unknown";
  }
  return `$${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

function collectTableUsages(instructions: InstructionFact[], provenance: CodeProvenance): TableUsageFact[] {
  const facts: TableUsageFact[] = [];

  for (let index = 0; index < instructions.length; index += 1) {
    const first = instructions[index];
    if (!isAbsoluteIndexedAccess(first) || isHardwareAddress(first.targetAddress)) {
      continue;
    }

    const indexRegister = INDEXED_MODES.get(first.addressingMode)!;
    const window = [first];
    for (let cursor = index + 1; cursor < instructions.length && cursor <= index + 5; cursor += 1) {
      const candidate = instructions[cursor];
      if (!isAbsoluteIndexedAccess(candidate) || isHardwareAddress(candidate.targetAddress)) {
        break;
      }
      if (INDEXED_MODES.get(candidate.addressingMode) !== indexRegister) {
        break;
      }
      if (candidate.address - window[window.length - 1].address > 12) {
        break;
      }
      window.push(candidate);
    }

    if (window.length < 2) {
      continue;
    }

    const readCount = window.filter((instruction) => instruction.mnemonic.startsWith("ld") || instruction.mnemonic === "cmp" || instruction.mnemonic === "adc" || instruction.mnemonic === "sbc" || instruction.mnemonic === "and" || instruction.mnemonic === "ora" || instruction.mnemonic === "eor").length;
    const writeCount = window.filter((instruction) => instruction.mnemonic.startsWith("st")).length;
    const operation = readCount > 0 && writeCount > 0 ? "mixed" : writeCount > 0 ? "write" : "read";
    const tableBases = Array.from(new Set(window.map((instruction) => instruction.targetAddress))).sort((left, right) => left - right);
    const confidence = clampConfidence(
      0.52 +
        Math.min(0.18, window.length * 0.05) +
        (operation === "mixed" ? 0.08 : 0) +
        (provenance === "confirmed_code" ? 0.12 : 0),
    );

    facts.push({
      start: window[0].address,
      end: window[window.length - 1].address + window[window.length - 1].size - 1,
      instructionAddresses: window.map((instruction) => instruction.address),
      tableBases,
      indexRegister,
      operation,
      provenance,
      confidence,
      reasons: [
        `${window.length} consecutive absolute-indexed ${operation} access(es) use ${indexRegister.toUpperCase()} as the table index.`,
        `Referenced bases cluster around ${tableBases.map(formatAddress).join(", ")}.`,
        provenance === "confirmed_code"
          ? "Pattern comes from recursively confirmed code."
          : "Pattern comes from a probable code island and should be interpreted carefully.",
      ],
    });
    index += window.length - 1;
  }

  return facts;
}

function collectCopyRoutines(instructions: InstructionFact[], provenance: CodeProvenance): CopyRoutineFact[] {
  const facts: CopyRoutineFact[] = [];

  for (let index = 0; index < instructions.length; index += 1) {
    const branch = instructions[index];
    if (branch.addressingMode !== "rel" || branch.targetAddress === undefined || branch.targetAddress >= branch.address) {
      continue;
    }

    const loopInstructions = instructions.filter(
      (instruction) => instruction.address >= branch.targetAddress! && instruction.address <= branch.address,
    );
    if (loopInstructions.length < 4 || loopInstructions.length > 24) {
      continue;
    }

    const register =
      loopInstructions.some((instruction) => instruction.mnemonic === "inx" || instruction.mnemonic === "dex")
        ? "x"
        : loopInstructions.some((instruction) => instruction.mnemonic === "iny" || instruction.mnemonic === "dey")
          ? "y"
          : undefined;
    if (!register) {
      continue;
    }

    const stores = loopInstructions.filter(
      (instruction) =>
        instruction.mnemonic.startsWith("st") &&
        instruction.targetAddress !== undefined &&
        instruction.addressingMode === `abs,${register}` &&
        !isHardwareAddress(instruction.targetAddress),
    );
    if (stores.length < 2) {
      continue;
    }

    const reads = loopInstructions.filter(
      (instruction) =>
        instruction.mnemonic === "lda" &&
        instruction.targetAddress !== undefined &&
        instruction.addressingMode === `abs,${register}` &&
        !isHardwareAddress(instruction.targetAddress),
    );
    const immediateLoads = loopInstructions.filter((instruction) => instruction.mnemonic === "lda" && instruction.addressingMode === "imm");
    const mode: "copy" | "fill" = reads.length >= 1 ? "copy" : "fill";

    const destinationBases = Array.from(new Set(stores.map((instruction) => instruction.targetAddress!))).sort((left, right) => left - right);
    const sourceBases = Array.from(new Set(reads.map((instruction) => instruction.targetAddress!))).sort((left, right) => left - right);
    const fillValue = mode === "fill" ? immediateLoads[immediateLoads.length - 1]?.operandValue : undefined;
    const confidence = clampConfidence(
      0.62 +
        Math.min(0.12, stores.length * 0.03) +
        (mode === "copy" ? 0.08 : 0.06) +
        (destinationBases.length >= 3 ? 0.08 : 0) +
        (provenance === "confirmed_code" ? 0.08 : 0),
    );

    facts.push({
      start: loopInstructions[0].address,
      end: branch.address + branch.size - 1,
      loopBranchAddress: branch.address,
      destinationBases,
      sourceBases,
      indexRegister: register,
      mode,
      fillValue,
      provenance,
      confidence,
      reasons: [
        `Backward branch at ${formatAddress(branch.address)} forms a loop over ${loopInstructions.length} instructions.`,
        `${stores.length} indexed store(s) target ${destinationBases.map(formatAddress).join(", ")}.`,
        mode === "copy"
          ? `${reads.length} indexed load(s) suggest a copy loop from ${sourceBases.map(formatAddress).join(", ")}.`
          : immediateLoads.length >= 1
            ? `Immediate accumulator load suggests a fill loop with value ${formatByte(fillValue)}.`
            : "Indexed stores repeat without a matching indexed source load, which is more consistent with a fill/clear loop than a copy loop.",
        provenance === "confirmed_code"
          ? "Loop comes from recursively confirmed code."
          : "Loop comes from a probable code island and should be validated by reading the routine.",
      ],
    });
  }

  return facts;
}

function classifyHardwareDestination(address: number): HardwareTargetedCopyFact["destinationRole"] {
  if (address >= 0xd800 && address <= 0xdbe7) return "color_ram";
  if (address >= 0x0400 && address <= 0x07e7) return "screen_ram";
  if (address >= 0xd400 && address <= 0xd418) return "sid";
  if (address >= 0xd000 && address <= 0xd02e) return "vic";
  return "other_hardware";
}

function sourceKindForRole(role: HardwareTargetedCopyFact["destinationRole"]): SegmentKind {
  switch (role) {
    case "color_ram": return "color_source";
    case "screen_ram": return "screen_source";
    case "sid": return "music_data";
    case "vic": return "lookup_table";
    default: return "lookup_table";
  }
}

function collectHardwareTargetedCopies(instructions: InstructionFact[], provenance: CodeProvenance): HardwareTargetedCopyFact[] {
  const facts: HardwareTargetedCopyFact[] = [];

  for (let index = 0; index < instructions.length; index += 1) {
    const branch = instructions[index];
    if (branch.addressingMode !== "rel" || branch.targetAddress === undefined || branch.targetAddress >= branch.address) {
      continue;
    }

    const loopInstructions = instructions.filter(
      (instruction) => instruction.address >= branch.targetAddress! && instruction.address <= branch.address,
    );
    if (loopInstructions.length < 3 || loopInstructions.length > 24) {
      continue;
    }

    const register =
      loopInstructions.some((instruction) => instruction.mnemonic === "inx" || instruction.mnemonic === "dex")
        ? "x"
        : loopInstructions.some((instruction) => instruction.mnemonic === "iny" || instruction.mnemonic === "dey")
          ? "y"
          : undefined;
    if (!register) {
      continue;
    }

    const hwStores = loopInstructions.filter(
      (instruction) =>
        instruction.mnemonic.startsWith("st") &&
        instruction.targetAddress !== undefined &&
        instruction.addressingMode === `abs,${register}` &&
        isHardwareAddress(instruction.targetAddress),
    );
    if (hwStores.length === 0) {
      continue;
    }

    const reads = loopInstructions.filter(
      (instruction) =>
        instruction.mnemonic === "lda" &&
        instruction.targetAddress !== undefined &&
        instruction.addressingMode === `abs,${register}` &&
        !isHardwareAddress(instruction.targetAddress),
    );
    const immediateLoads = loopInstructions.filter((instruction) => instruction.mnemonic === "lda" && instruction.addressingMode === "imm");
    const mode: "copy" | "fill" = reads.length >= 1 ? "copy" : "fill";

    const destinationBases = Array.from(new Set(hwStores.map((instruction) => instruction.targetAddress!))).sort((left, right) => left - right);
    const sourceBases = Array.from(new Set(reads.map((instruction) => instruction.targetAddress!))).sort((left, right) => left - right);
    const fillValue = mode === "fill" ? immediateLoads[immediateLoads.length - 1]?.operandValue : undefined;

    const role = classifyHardwareDestination(destinationBases[0]);
    const sourceClassification = sourceKindForRole(role);

    const confidence = clampConfidence(
      0.72 +
        (mode === "copy" ? 0.10 : 0.04) +
        (provenance === "confirmed_code" ? 0.08 : 0) +
        (role !== "other_hardware" ? 0.06 : 0),
    );

    facts.push({
      start: loopInstructions[0].address,
      end: branch.address + branch.size - 1,
      loopBranchAddress: branch.address,
      sourceBases,
      destinationBases,
      indexRegister: register,
      mode,
      fillValue,
      destinationRole: role,
      sourceClassification,
      provenance,
      confidence,
      reasons: [
        `Backward branch at ${formatAddress(branch.address)} forms a loop writing to hardware ${destinationBases.map(formatAddress).join(", ")}.`,
        `Hardware destination classified as ${role}.`,
        mode === "copy"
          ? `Source data at ${sourceBases.map(formatAddress).join(", ")} classified as ${sourceClassification}.`
          : `Fill loop with value ${formatByte(fillValue)}.`,
      ],
    });
  }

  return facts;
}

function isSidRegisterRange(address: number): boolean {
  return address >= 0xd400 && address <= 0xd418;
}

function collectSidDataSources(
  context: AnalyzerContext,
  instructions: InstructionFact[],
  provenance: CodeProvenance,
): SidDataSourceFact[] {
  const facts: SidDataSourceFact[] = [];

  // Find code regions that write to SID registers
  const sidWriteAddresses = new Set<number>();
  for (const inst of instructions) {
    if (
      inst.mnemonic.startsWith("st") &&
      inst.targetAddress !== undefined &&
      isSidRegisterRange(inst.targetAddress)
    ) {
      sidWriteAddresses.add(inst.address);
    }
  }

  if (sidWriteAddresses.size === 0) return facts;

  // Find routines that contain SID writes — look for data sources they read from
  // Pattern 1: indexed reads near SID writes (e.g. LDA $XXXX,X ... STA $D400,Y)
  for (let index = 0; index < instructions.length; index += 1) {
    const inst = instructions[index];
    if (!inst.mnemonic.startsWith("st") || inst.targetAddress === undefined || !isSidRegisterRange(inst.targetAddress)) {
      continue;
    }

    // Look backwards for the data source within 8 instructions
    for (let back = Math.max(0, index - 8); back < index; back += 1) {
      const source = instructions[back];
      if (source.mnemonic !== "lda" || source.targetAddress === undefined) continue;
      if (isHardwareAddress(source.targetAddress)) continue;

      // Indexed read → data table being fed to SID
      if (INDEXED_MODES.has(source.addressingMode)) {
        const existing = facts.find((f) => f.dataSourceAddress === source.targetAddress);
        if (existing) continue;

        facts.push({
          driverStart: inst.address,
          driverEnd: inst.address + inst.size - 1,
          dataSourceAddress: source.targetAddress,
          linkType: "indexed_read",
          provenance,
          confidence: clampConfidence(0.74 + (provenance === "confirmed_code" ? 0.10 : 0)),
          reasons: [
            `Code at ${formatAddress(inst.address)} writes to SID register ${formatAddress(inst.targetAddress)}.`,
            `Data is loaded via indexed read from ${formatAddress(source.targetAddress)}.`,
            "Source address likely contains music or sound effect data.",
          ],
        });
      }
    }
  }

  // Pattern 2: indirect reads (LDA ($zp),Y) in routines with SID writes
  // Group instructions into routine-sized windows around SID writes
  const sidRoutineStarts = new Set<number>();
  for (const addr of sidWriteAddresses) {
    // Find the nearest backward JSR/entry or start-of-function marker
    const nearbyStart = instructions.find((i) => i.address <= addr && addr - i.address < 128)?.address;
    if (nearbyStart !== undefined) sidRoutineStarts.add(nearbyStart);
  }

  for (const inst of instructions) {
    if (inst.mnemonic !== "lda" || inst.addressingMode !== "(zp),y") continue;
    if (inst.operandValue === undefined) continue;

    // Is this near SID writes?
    const nearSid = instructions.some(
      (other) =>
        other.mnemonic.startsWith("st") &&
        other.targetAddress !== undefined &&
        isSidRegisterRange(other.targetAddress) &&
        Math.abs(other.address - inst.address) < 64,
    );
    if (!nearSid) continue;

    // Find the pointer setup that tells us where ($zp) points
    const zpBase = inst.operandValue;
    // Look for immediate pointer construction targeting this ZP pair
    // (handled via indirectPointers later, but we note the ZP base)
    const existing = facts.find((f) => f.linkType === "indirect_read" && f.dataSourceAddress === zpBase);
    if (existing) continue;

    facts.push({
      driverStart: inst.address,
      driverEnd: inst.address + inst.size - 1,
      dataSourceAddress: zpBase, // ZP pointer base; actual target resolved later
      linkType: "indirect_read",
      provenance,
      confidence: clampConfidence(0.65 + (provenance === "confirmed_code" ? 0.10 : 0)),
      reasons: [
        `Indirect read LDA ($${zpBase.toString(16).toUpperCase().padStart(2, "0")}),Y near SID writes.`,
        "Pointer at this zero-page pair likely references music or SFX data.",
      ],
    });
  }

  return facts;
}

function collectIndirectPointers(instructions: InstructionFact[], provenance: CodeProvenance): IndirectPointerConstructionFact[] {
  const facts: IndirectPointerConstructionFact[] = [];

  for (let index = 0; index < instructions.length - 3; index += 1) {
    const a = instructions[index];
    const b = instructions[index + 1];
    const c = instructions[index + 2];
    const d = instructions[index + 3];

    if (a.mnemonic !== "lda" || c.mnemonic !== "lda" || b.mnemonic !== "sta" || d.mnemonic !== "sta") {
      continue;
    }
    if (b.addressingMode !== "zp" || d.addressingMode !== "zp") {
      continue;
    }
    if (b.operandValue === undefined || d.operandValue === undefined || d.operandValue !== ((b.operandValue + 1) & 0xff)) {
      continue;
    }

    const lowSource = a.targetAddress ?? (a.addressingMode === "imm" ? a.operandValue : undefined);
    const highSource = c.targetAddress ?? (c.addressingMode === "imm" ? c.operandValue : undefined);
    const constantTarget =
      a.addressingMode === "imm" && c.addressingMode === "imm" && a.operandValue !== undefined && c.operandValue !== undefined
        ? a.operandValue | (c.operandValue << 8)
        : undefined;
    const confidence = clampConfidence(
      0.66 +
        (constantTarget !== undefined ? 0.14 : 0.06) +
        (provenance === "confirmed_code" ? 0.08 : 0),
    );

    facts.push({
      start: a.address,
      end: d.address + d.size - 1,
      zeroPageBase: b.operandValue,
      provenance,
      confidence,
      constantTarget,
      lowByteSource: lowSource,
      highByteSource: highSource,
      reasons: [
        `Zero-page pointer ${formatAddress(b.operandValue)}-${formatAddress(d.operandValue)} is assembled by consecutive load/store pairs.`,
        constantTarget !== undefined
          ? `Both bytes are immediate, yielding constant target ${formatAddress(constantTarget)}.`
          : "Pointer bytes are loaded dynamically, so the final target depends on runtime state.",
        provenance === "confirmed_code"
          ? "Pointer setup comes from recursively confirmed code."
          : "Pointer setup comes from a probable code island and should be validated in context.",
      ],
    });
    index += 3;
  }

  return facts;
}

function sampleSplitPointerTargets(
  context: AnalyzerContext,
  lowTableBase: number,
  highTableBase: number,
  limit = 8,
): number[] {
  const targets: number[] = [];
  for (let index = 0; index < limit; index += 1) {
    const lowOffset = toOffset(lowTableBase + index, context.mapping);
    const highOffset = toOffset(highTableBase + index, context.mapping);
    if (lowOffset === undefined || highOffset === undefined) {
      break;
    }
    const target = context.buffer[lowOffset] | (context.buffer[highOffset] << 8);
    targets.push(target);
  }
  return targets;
}

function collectSplitPointerTables(
  context: AnalyzerContext,
  instructions: InstructionFact[],
  provenance: CodeProvenance,
): SplitPointerTableFact[] {
  const facts: SplitPointerTableFact[] = [];

  for (let index = 0; index < instructions.length - 3; index += 1) {
    const a = instructions[index];
    const b = instructions[index + 1];
    const c = instructions[index + 2];
    const d = instructions[index + 3];

    if (a.mnemonic !== "lda" || c.mnemonic !== "lda" || b.mnemonic !== "sta" || d.mnemonic !== "sta") {
      continue;
    }
    if (a.targetAddress === undefined || c.targetAddress === undefined) {
      continue;
    }
    if (!INDEXED_MODES.has(a.addressingMode) || a.addressingMode !== c.addressingMode) {
      continue;
    }
    if (b.addressingMode !== "zp" || d.addressingMode !== "zp") {
      continue;
    }
    if (b.operandValue === undefined || d.operandValue === undefined || d.operandValue !== ((b.operandValue + 1) & 0xff)) {
      continue;
    }
    if (isHardwareAddress(a.targetAddress) || isHardwareAddress(c.targetAddress)) {
      continue;
    }
    if (Math.abs(a.targetAddress - c.targetAddress) <= 1) {
      continue;
    }

    const indexRegister = INDEXED_MODES.get(a.addressingMode)!;
    const sampleTargets = sampleSplitPointerTargets(context, a.targetAddress, c.targetAddress);
    const inRangeRatio =
      sampleTargets.length > 0
        ? sampleTargets.filter((target) => target >= context.mapping.startAddress && target <= context.mapping.endAddress).length / sampleTargets.length
        : 0;
    const uniqueRatio = sampleTargets.length > 0 ? new Set(sampleTargets).size / sampleTargets.length : 0;

    const confidence = clampConfidence(
      0.58 +
        (provenance === "confirmed_code" ? 0.12 : 0.04) +
        Math.min(0.14, inRangeRatio * 0.14) +
        Math.min(0.08, uniqueRatio * 0.08),
    );

    facts.push({
      start: a.address,
      end: d.address + d.size - 1,
      lowTableBase: a.targetAddress,
      highTableBase: c.targetAddress,
      pointerBase: b.operandValue,
      indexRegister,
      provenance,
      confidence,
      sampleTargets,
      reasons: [
        `Code builds zero-page pointer ${formatAddress(b.operandValue)}-${formatAddress(d.operandValue)} from indexed tables ${formatAddress(a.targetAddress)} and ${formatAddress(c.targetAddress)}.`,
        `Both loads use ${indexRegister.toUpperCase()} as the shared index register.`,
        sampleTargets.length > 0
          ? `${Math.round(inRangeRatio * 100)}% of the first ${sampleTargets.length} reconstructed targets fall inside the mapped binary.`
          : "No target samples could be reconstructed from the mapped range.",
        provenance === "confirmed_code"
          ? "Pattern comes from recursively confirmed code."
          : "Pattern comes from a probable code island and should be validated manually.",
      ],
    });

    index += 3;
  }

  return facts;
}

function dedupeByRange<T extends { start: number; end: number }>(facts: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const fact of facts) {
    const key = `${fact.start}:${fact.end}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(fact);
  }
  return deduped.sort((left, right) => left.start - right.start);
}

export function extractCodeSemantics(context: AnalyzerContext): CodeSemantics {
  const tableUsages: TableUsageFact[] = [];
  const copyRoutines: CopyRoutineFact[] = [];
  const hardwareTargetedCopies: HardwareTargetedCopyFact[] = [];
  const sidDataSources: SidDataSourceFact[] = [];
  const indirectPointers: IndirectPointerConstructionFact[] = [];
  const splitPointerTables: SplitPointerTableFact[] = [];

  for (const pool of getInstructionPools(context)) {
    tableUsages.push(...collectTableUsages(pool.instructions, pool.provenance));
    copyRoutines.push(...collectCopyRoutines(pool.instructions, pool.provenance));
    hardwareTargetedCopies.push(...collectHardwareTargetedCopies(pool.instructions, pool.provenance));
    sidDataSources.push(...collectSidDataSources(context, pool.instructions, pool.provenance));
    indirectPointers.push(...collectIndirectPointers(pool.instructions, pool.provenance));
    splitPointerTables.push(...collectSplitPointerTables(context, pool.instructions, pool.provenance));
  }

  return {
    tableUsages: dedupeByRange(tableUsages),
    copyRoutines: dedupeByRange(copyRoutines),
    hardwareTargetedCopies: dedupeByRange(hardwareTargetedCopies),
    sidDataSources,
    indirectPointers: dedupeByRange(indirectPointers),
    splitPointerTables: dedupeByRange(splitPointerTables),
    displayStates: [],
    displayTransfers: [],
    ramAccesses: [],
    ramHypotheses: [],
  };
}
