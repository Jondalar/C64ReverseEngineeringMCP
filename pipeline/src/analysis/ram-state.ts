import {
  AnalyzerContext,
  CodeProvenance,
  CodeSemantics,
  IndexedRegister,
  InstructionFact,
  RamAccessFact,
  RamAccessKind,
  RamAddressDomain,
  RamHypothesis,
  RamHypothesisKind,
  Segment,
} from "./types";
import { clampConfidence, formatAddress } from "./utils";

const DIRECT_ADDRESSING_MODES = new Set(["zp", "zp,x", "zp,y", "abs", "abs,x", "abs,y"]);
const INDIRECT_ZERO_PAGE_MODES = new Set(["(zp),y"]);
const READ_MNEMONICS = new Set(["lda", "ldx", "ldy", "cmp", "cpx", "cpy", "adc", "sbc", "and", "ora", "eor", "bit"]);
const WRITE_MNEMONICS = new Set(["sta", "stx", "sty"]);
const READ_MODIFY_WRITE_MNEMONICS = new Set(["inc", "dec", "asl", "lsr", "rol", "ror"]);

interface AggregatedRamAccess {
  address: number;
  domain: RamAddressDomain;
  directReads: number[];
  directWrites: number[];
  indexedReads: number[];
  indexedWrites: number[];
  indirectReads: number[];
  indirectWrites: number[];
  readModifyWrites: number[];
  immediateWriteValues: number[];
  provenances: Set<CodeProvenance>;
}

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

function classifyRamDomain(address: number): RamAddressDomain {
  if (address <= 0x00ff) {
    return "zero_page";
  }
  if (address <= 0x01ff) {
    return "stack_page";
  }
  if (address <= 0x03ff) {
    return "system_workspace";
  }
  if (address <= 0xcfff) {
    return "main_ram";
  }
  return "high_ram";
}

function isStaticRamAddress(address: number): boolean {
  if (address < 0x0000 || address > 0xffff) {
    return false;
  }
  if (address >= 0xd000 && address <= 0xdfff) {
    return false;
  }
  return true;
}

function getStaticTargetAddress(instruction: InstructionFact): number | undefined {
  if (!DIRECT_ADDRESSING_MODES.has(instruction.addressingMode)) {
    return undefined;
  }
  const address = instruction.targetAddress ?? instruction.operandValue;
  if (address === undefined || !isStaticRamAddress(address)) {
    return undefined;
  }
  return address;
}

function getIndirectZeroPageBase(instruction: InstructionFact): number | undefined {
  if (!INDIRECT_ZERO_PAGE_MODES.has(instruction.addressingMode)) {
    return undefined;
  }
  if (instruction.operandValue === undefined) {
    return undefined;
  }
  if (instruction.operandValue < 0 || instruction.operandValue > 0xff) {
    return undefined;
  }
  return instruction.operandValue;
}

function inferImmediateWriteValue(
  instructions: InstructionFact[],
  index: number,
  instruction: InstructionFact,
): number | undefined {
  const previous = instructions[index - 1];
  if (!previous || previous.address + previous.size !== instruction.address || previous.addressingMode !== "imm") {
    return undefined;
  }

  if (instruction.mnemonic === "sta" && previous.mnemonic === "lda") {
    return previous.operandValue;
  }
  if (instruction.mnemonic === "stx" && previous.mnemonic === "ldx") {
    return previous.operandValue;
  }
  if (instruction.mnemonic === "sty" && previous.mnemonic === "ldy") {
    return previous.operandValue;
  }

  return undefined;
}

function ensureAggregate(map: Map<number, AggregatedRamAccess>, address: number): AggregatedRamAccess {
  const existing = map.get(address);
  if (existing) {
    return existing;
  }

  const aggregate: AggregatedRamAccess = {
    address,
    domain: classifyRamDomain(address),
    directReads: [],
    directWrites: [],
    indexedReads: [],
    indexedWrites: [],
    indirectReads: [],
    indirectWrites: [],
    readModifyWrites: [],
    immediateWriteValues: [],
    provenances: new Set<CodeProvenance>(),
  };
  map.set(address, aggregate);
  return aggregate;
}

function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function deriveAccessKind(access: AggregatedRamAccess): RamAccessKind {
  const readCount = access.directReads.length + access.indexedReads.length + access.indirectReads.length;
  const writeCount = access.directWrites.length + access.indexedWrites.length + access.indirectWrites.length + access.readModifyWrites.length;

  if (readCount > 0 && writeCount > 0) {
    return "readwrite";
  }
  if (writeCount > 0) {
    return "write";
  }
  return "read";
}

function accessReasonPrefix(address: number, access: AggregatedRamAccess): string[] {
  const reasons = [`Static RAM address ${formatAddress(address)} is touched from decoded code, so it is a good state/label candidate.`];
  if (access.domain === "zero_page") {
    reasons.push("Lives in zero page, which strongly suggests pointer, scratch, or hot-path state usage.");
  } else if (access.domain === "system_workspace") {
    reasons.push("Lives in page 2/3 system workspace, so this may be a KERNAL vector/flag or a game-owned override of system RAM.");
  }
  return reasons;
}

function collectRamAccesses(context: AnalyzerContext): RamAccessFact[] {
  const aggregates = new Map<number, AggregatedRamAccess>();

  for (const pool of getInstructionPools(context)) {
    for (let index = 0; index < pool.instructions.length; index += 1) {
      const instruction = pool.instructions[index];
      const address = getStaticTargetAddress(instruction);
      if (address !== undefined) {
        const aggregate = ensureAggregate(aggregates, address);
        aggregate.provenances.add(pool.provenance);

        if (READ_MNEMONICS.has(instruction.mnemonic)) {
          if (instruction.addressingMode === "abs,x" || instruction.addressingMode === "abs,y" || instruction.addressingMode === "zp,x" || instruction.addressingMode === "zp,y") {
            aggregate.indexedReads.push(instruction.address);
          } else {
            aggregate.directReads.push(instruction.address);
          }
        } else if (WRITE_MNEMONICS.has(instruction.mnemonic)) {
          if (instruction.addressingMode === "abs,x" || instruction.addressingMode === "abs,y" || instruction.addressingMode === "zp,x" || instruction.addressingMode === "zp,y") {
            aggregate.indexedWrites.push(instruction.address);
          } else {
            aggregate.directWrites.push(instruction.address);
          }

          const immediateValue = inferImmediateWriteValue(pool.instructions, index, instruction);
          if (immediateValue !== undefined) {
            aggregate.immediateWriteValues.push(immediateValue);
          }
        } else if (READ_MODIFY_WRITE_MNEMONICS.has(instruction.mnemonic)) {
          aggregate.readModifyWrites.push(instruction.address);
        }
      }

      const indirectBase = getIndirectZeroPageBase(instruction);
      if (indirectBase !== undefined) {
        const aggregate = ensureAggregate(aggregates, indirectBase);
        aggregate.provenances.add(pool.provenance);
        if (READ_MNEMONICS.has(instruction.mnemonic)) {
          aggregate.indirectReads.push(instruction.address);
        } else if (WRITE_MNEMONICS.has(instruction.mnemonic) || READ_MODIFY_WRITE_MNEMONICS.has(instruction.mnemonic)) {
          aggregate.indirectWrites.push(instruction.address);
        }
      }
    }
  }

  return Array.from(aggregates.values())
    .map((aggregate) => {
      const directReads = uniqueSorted(aggregate.directReads);
      const directWrites = uniqueSorted(aggregate.directWrites);
      const indexedReads = uniqueSorted(aggregate.indexedReads);
      const indexedWrites = uniqueSorted(aggregate.indexedWrites);
      const indirectReads = uniqueSorted(aggregate.indirectReads);
      const indirectWrites = uniqueSorted(aggregate.indirectWrites);
      const readModifyWrites = uniqueSorted(aggregate.readModifyWrites);
      const immediateWriteValues = uniqueSorted(aggregate.immediateWriteValues);
      const provenances = Array.from(aggregate.provenances).sort();

      const touchCount =
        directReads.length +
        directWrites.length +
        indexedReads.length +
        indexedWrites.length +
        indirectReads.length +
        indirectWrites.length +
        readModifyWrites.length;
      const confidence = clampConfidence(
        0.42 +
          Math.min(0.24, touchCount * 0.02) +
          (provenances.includes("confirmed_code") ? 0.16 : 0.06) +
          (aggregate.domain === "zero_page" ? 0.08 : 0),
      );

      return {
        address: aggregate.address,
        domain: aggregate.domain,
        access: deriveAccessKind(aggregate),
        directReads,
        directWrites,
        indexedReads,
        indexedWrites,
        indirectReads,
        indirectWrites,
        readModifyWrites,
        immediateWriteValues,
        provenances,
        confidence,
        reasons: [
          ...accessReasonPrefix(aggregate.address, aggregate),
          `Reads=${directReads.length + indexedReads.length + indirectReads.length}, writes=${directWrites.length + indexedWrites.length + indirectWrites.length + readModifyWrites.length}.`,
          provenances.includes("confirmed_code")
            ? "At least one touch comes from recursively confirmed code."
            : "Current evidence comes only from probable-code islands.",
        ],
      } satisfies RamAccessFact;
    })
    .sort((left, right) => left.address - right.address);
}

function addHypothesis(
  hypotheses: RamHypothesis[],
  start: number,
  end: number,
  kind: RamHypothesisKind,
  confidence: number,
  labelHint: string,
  relatedAddresses: number[],
  reasons: string[],
): void {
  hypotheses.push({
    start,
    end,
    kind,
    confidence: clampConfidence(confidence),
    labelHint,
    relatedAddresses: uniqueSorted(relatedAddresses),
    reasons,
  });
}

function buildSingleAddressHypotheses(ramAccesses: RamAccessFact[]): RamHypothesis[] {
  const hypotheses: RamHypothesis[] = [];

  for (const access of ramAccesses) {
    const writes = access.directWrites.length + access.indexedWrites.length + access.readModifyWrites.length;
    const reads = access.directReads.length + access.indexedReads.length;
    const smallImmediateSet = access.immediateWriteValues.every((value) => value === 0 || value === 1);

    if (access.domain === "zero_page" && access.access === "readwrite" && writes >= 3 && reads >= 1 && access.readModifyWrites.length === 0) {
      addHypothesis(
        hypotheses,
        access.address,
        access.address,
        "buffer",
        0.46,
        `zp_work_${access.address.toString(16).toUpperCase().padStart(2, "0")}`,
        [access.address],
        [
          `Zero-page address ${formatAddress(access.address)} is both read and written from multiple sites.`,
          "This is consistent with hot-path scratch state or a byte-sized work variable.",
        ],
      );
    }

    if (access.access === "readwrite" && smallImmediateSet && writes >= 2 && reads >= 1) {
      addHypothesis(
        hypotheses,
        access.address,
        access.address,
        "flag",
        0.58,
        `flag_${access.address.toString(16).toUpperCase().padStart(4, "0")}`,
        [access.address],
        [
          `Address ${formatAddress(access.address)} is written with a small immediate set (${access.immediateWriteValues.map((value) => `$${value.toString(16).toUpperCase().padStart(2, "0")}`).join(", ")}) and later read back.`,
          "That pattern is more consistent with a flag/mode byte than with arbitrary data.",
        ],
      );
    }

    if (access.readModifyWrites.length >= 2 && writes >= 2) {
      addHypothesis(
        hypotheses,
        access.address,
        access.address,
        "counter",
        0.6,
        `counter_${access.address.toString(16).toUpperCase().padStart(4, "0")}`,
        [access.address],
        [
          `Address ${formatAddress(access.address)} is updated with INC/DEC/shift-style read-modify-write instructions.`,
          "That pattern often indicates a counter, timer, or packed state byte.",
        ],
      );
    }

    if (access.domain === "system_workspace" && access.access !== "read") {
      addHypothesis(
        hypotheses,
        access.address,
        access.address,
        "mode_flag",
        0.42,
        `sys_override_${access.address.toString(16).toUpperCase().padStart(4, "0")}`,
        [access.address],
        [
          `Page-2/page-3 address ${formatAddress(access.address)} is overwritten by game code.`,
          "This is often a KERNAL flag/vector override or borrowed system workspace.",
        ],
      );
    }
  }

  return hypotheses;
}

function buildPointerHypotheses(codeSemantics: Pick<CodeSemantics, "indirectPointers">): RamHypothesis[] {
  const hypotheses: RamHypothesis[] = [];

  for (const pointer of codeSemantics.indirectPointers) {
    const labelHint =
      pointer.constantTarget !== undefined
        ? `zp_ptr_${pointer.constantTarget.toString(16).toUpperCase().padStart(4, "0")}`
        : `zp_ptr_${pointer.zeroPageBase.toString(16).toUpperCase().padStart(2, "0")}`;

    addHypothesis(
      hypotheses,
      pointer.zeroPageBase,
      (pointer.zeroPageBase + 1) & 0xff,
      "pointer_pair",
      pointer.confidence,
      labelHint,
      [pointer.zeroPageBase, (pointer.zeroPageBase + 1) & 0xff],
      [...pointer.reasons],
    );

    if (pointer.constantTarget !== undefined) {
      addHypothesis(
        hypotheses,
        pointer.constantTarget,
        pointer.constantTarget,
        "pointer_target",
        clampConfidence(pointer.confidence - 0.08),
        `ptr_target_${pointer.constantTarget.toString(16).toUpperCase().padStart(4, "0")}`,
        [pointer.constantTarget],
        [
          `Zero-page pointer ${formatAddress(pointer.zeroPageBase)} resolves to constant target ${formatAddress(pointer.constantTarget)} here.`,
          "This target is a strong candidate for a table, buffer, or dispatch structure.",
        ],
      );
    }
  }

  return hypotheses;
}

function buildTableHypotheses(codeSemantics: Pick<CodeSemantics, "tableUsages" | "copyRoutines">): RamHypothesis[] {
  const hypotheses: RamHypothesis[] = [];
  const grouped = new Map<string, { bases: number[]; reasons: string[]; confidence: number; kind: RamHypothesisKind }>();

  for (const fact of codeSemantics.tableUsages) {
    if (fact.tableBases.length === 0) {
      continue;
    }
    const key = `table:${fact.tableBases.join(",")}`;
    grouped.set(key, {
      bases: fact.tableBases,
      reasons: fact.reasons,
      confidence: fact.confidence,
      kind: "table",
    });
  }

  for (const fact of codeSemantics.copyRoutines) {
    const bases = [...fact.destinationBases].sort((left, right) => left - right);
    if (bases.length === 0) {
      continue;
    }
    const key = `copy:${bases.join(",")}`;
    grouped.set(key, {
      bases,
      reasons: fact.reasons,
      confidence: fact.confidence,
      kind: fact.destinationBases.length >= 3 ? "state_block" : "buffer",
    });
  }

  for (const entry of grouped.values()) {
    const start = entry.bases[0];
    const end = entry.bases[entry.bases.length - 1];
    const kind = entry.kind;
    const labelHint =
      kind === "state_block"
        ? `state_block_${start.toString(16).toUpperCase().padStart(4, "0")}`
        : kind === "buffer"
          ? `buffer_${start.toString(16).toUpperCase().padStart(4, "0")}`
          : `table_${start.toString(16).toUpperCase().padStart(4, "0")}`;

    addHypothesis(
      hypotheses,
      start,
      end,
      kind,
      entry.confidence,
      labelHint,
      entry.bases,
      [
        `Indexed or loop-based accesses cluster around ${entry.bases.map(formatAddress).join(", ")}.`,
        ...entry.reasons,
      ],
    );
  }

  return hypotheses;
}

function dedupeHypotheses(hypotheses: RamHypothesis[]): RamHypothesis[] {
  const deduped = new Map<string, RamHypothesis>();

  for (const hypothesis of hypotheses) {
    const key = `${hypothesis.kind}:${hypothesis.start}:${hypothesis.end}:${hypothesis.labelHint}`;
    const existing = deduped.get(key);
    if (!existing || existing.confidence < hypothesis.confidence) {
      deduped.set(key, hypothesis);
    }
  }

  return Array.from(deduped.values()).sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return left.start - right.start;
  });
}

export function extractRamStateFacts(
  context: AnalyzerContext,
  codeSemantics: Pick<CodeSemantics, "tableUsages" | "copyRoutines" | "indirectPointers">,
  _segments: Segment[],
): Pick<CodeSemantics, "ramAccesses" | "ramHypotheses"> {
  const ramAccesses = collectRamAccesses(context);
  const ramHypotheses = dedupeHypotheses([
    ...buildSingleAddressHypotheses(ramAccesses),
    ...buildPointerHypotheses(codeSemantics),
    ...buildTableHypotheses(codeSemantics),
  ]);

  return {
    ramAccesses,
    ramHypotheses,
  };
}

function formatValues(values: number[]): string {
  if (values.length === 0) {
    return "-";
  }
  return values.map((value) => `$${value.toString(16).toUpperCase().padStart(2, "0")}`).join(", ");
}

function formatRefs(addresses: number[], limit = 6): string {
  if (addresses.length === 0) {
    return "-";
  }
  const shown = addresses.slice(0, limit).map(formatAddress);
  return addresses.length > limit ? `${shown.join(", ")}, ...` : shown.join(", ");
}

export function renderRamStateMarkdown(report: { binaryName: string; codeSemantics?: CodeSemantics; codeAnalysis?: { instructions: InstructionFact[] } }): string {
  const ramAccesses = report.codeSemantics?.ramAccesses ?? [];
  const ramHypotheses = report.codeSemantics?.ramHypotheses ?? [];
  const instructions = report.codeAnalysis?.instructions ?? [];
  const instructionIndexByAddress = new Map<number, number>(instructions.map((instruction, index) => [instruction.address, index]));

  const lines: string[] = [];
  lines.push(`# RAM State Facts for ${report.binaryName}`);
  lines.push("");
  lines.push("Generated from deterministic analysis facts.");
  lines.push("");
  lines.push("## Address Candidates");
  lines.push("");

  for (const access of ramAccesses) {
    lines.push(`### ${formatAddress(access.address)}`);
    lines.push(`- domain: \`${access.domain}\``);
    lines.push(`- access: \`${access.access}\``);
    lines.push(`- direct reads: ${access.directReads.length} (${formatRefs(access.directReads)})`);
    lines.push(`- direct writes: ${access.directWrites.length} (${formatRefs(access.directWrites)})`);
    lines.push(`- indexed reads: ${access.indexedReads.length} (${formatRefs(access.indexedReads)})`);
    lines.push(`- indexed writes: ${access.indexedWrites.length} (${formatRefs(access.indexedWrites)})`);
    lines.push(`- indirect reads: ${access.indirectReads.length} (${formatRefs(access.indirectReads)})`);
    lines.push(`- indirect writes: ${access.indirectWrites.length} (${formatRefs(access.indirectWrites)})`);
    lines.push(`- read/modify/write: ${access.readModifyWrites.length} (${formatRefs(access.readModifyWrites)})`);
    lines.push(`- immediate write values: ${formatValues(access.immediateWriteValues)}`);
    lines.push(`- confidence: ${access.confidence.toFixed(2)}`);
    for (const reason of access.reasons) {
      lines.push(`- reason: ${reason}`);
    }

    const contextAddresses = uniqueSorted([
      ...access.directReads,
      ...access.directWrites,
      ...access.indexedReads,
      ...access.indexedWrites,
      ...access.indirectReads,
      ...access.indirectWrites,
      ...access.readModifyWrites,
    ]).slice(0, 4);

    if (contextAddresses.length > 0 && instructions.length > 0) {
      lines.push("- contexts:");
      for (const contextAddress of contextAddresses) {
        const index = instructionIndexByAddress.get(contextAddress);
        if (index === undefined) {
          continue;
        }
        const start = Math.max(0, index - 4);
        const end = Math.min(instructions.length, index + 6);
        lines.push(`  - around ${formatAddress(contextAddress)}:`);
        for (const instruction of instructions.slice(start, end)) {
          const marker = instruction.address === contextAddress ? ">" : " ";
          const operand =
            instruction.operandValue !== undefined
              ? ` ${instruction.addressingMode} ${instruction.operandText || formatAddress(instruction.operandValue)}`
              : instruction.operandText
                ? ` ${instruction.addressingMode} ${instruction.operandText}`
                : "";
          lines.push(`    - \`${marker} ${formatAddress(instruction.address)}  ${instruction.mnemonic}${operand}\``);
        }
      }
    }
    lines.push("");
  }

  lines.push("## Purpose Hypotheses");
  lines.push("");
  for (const hypothesis of [...ramHypotheses].sort((left, right) => left.start - right.start)) {
    const range =
      hypothesis.start === hypothesis.end
        ? formatAddress(hypothesis.start)
        : `${formatAddress(hypothesis.start)}-${formatAddress(hypothesis.end)}`;
    lines.push(`### ${range}  ${hypothesis.kind}`);
    lines.push(`- label hint: \`${hypothesis.labelHint}\``);
    lines.push(`- confidence: ${hypothesis.confidence.toFixed(2)}`);
    lines.push(`- related: ${hypothesis.relatedAddresses.map(formatAddress).join(", ")}`);
    for (const reason of hypothesis.reasons) {
      lines.push(`- reason: ${reason}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
