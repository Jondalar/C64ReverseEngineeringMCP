import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import {
  AnalysisReport,
  CopyRoutineFact,
  CrossReference,
  DisplayStateFact,
  DisplayTransferFact,
  HardwareWriteObservation,
  IndirectPointerConstructionFact,
  InstructionFact,
  RamAccessFact,
  RamHypothesis,
  Segment,
  SegmentKind,
  SplitPointerTableFact,
  TableUsageFact,
} from "../analysis/types";
import { AnnotationsIndex, buildAnnotationsIndex, loadAnnotations } from "./annotations";
import { convertKickAsmToTass } from "./tass-converter";
import { findC64IoMetadata, formatC64IoAddress, isC64IoAddress } from "./c64-symbols";
import { getPlatformOverrides, type PlatformTag } from "../platform-knowledge/index";

// Spec 048: per-render platform override. Set at the top of
// disassemblePrgToKickAsm; consulted by the comment generators.
let activePlatform: PlatformTag = "c64";
import { decodeInstruction, DecodedInstruction, isBranchInstruction, isCallInstruction, isJumpInstruction } from "./mos6502";
import { hex16, hex8 } from "./format";
import { lookupKernalAbi, RegisterName } from "./kernal-abi";

interface PrgImage {
  loadAddress: number;
  data: Buffer;
}

interface PrgDisasmOptions {
  entryPoints?: number[];
  title?: string;
  analysisPath?: string;
  // Spec 048: optional platform tag. Default is "c64". When
  // "c1541", renderer overlays the c1541 ZP / IO / ROM tables on
  // top of the existing C64 lookups so drive disasm gets correct
  // labels.
  platform?: "c64" | "c1541";
}

interface InstructionIndex {
  byAddress: Map<number, DecodedInstruction>;
  ownerByAddress: Map<number, DecodedInstruction>;
}

interface RenderAnalysisContext {
  report: AnalysisReport;
  prg: PrgImage;
  segments: Segment[];
  instructions: Map<number, InstructionFact>;
  labelSet: Set<number>;
  instructionOwnerByAddress: Map<number, number>;
  segmentOwnerByAddress: Map<number, number>;
  xrefsByTarget: Map<number, Array<{ xref: CrossReference; provenance: "confirmed" | "probable" }>>;
  copyFacts: CopyRoutineFact[];
  pointerFacts: IndirectPointerConstructionFact[];
  tableFacts: TableUsageFact[];
  splitPointerFacts: SplitPointerTableFact[];
  displayStates: DisplayStateFact[];
  displayTransfers: DisplayTransferFact[];
  ramAccesses: RamAccessFact[];
  ramHypotheses: RamHypothesis[];
  vicWrites: HardwareWriteObservation[];
  sidWrites: HardwareWriteObservation[];
  copyFactsByStart: Map<number, CopyRoutineFact[]>;
  pointerFactsByStart: Map<number, IndirectPointerConstructionFact[]>;
  tableFactsByStart: Map<number, TableUsageFact[]>;
  displayTransfersByStart: Map<number, DisplayTransferFact[]>;
  annotations?: AnnotationsIndex;
  operandOverrides: Map<number, string>;
}

function cloneSegment(base: Segment, start: number, end: number, kind = base.kind): Segment {
  return {
    kind,
    start,
    end,
    length: end - start + 1,
    score: base.score,
    analyzerIds: [...base.analyzerIds],
    xrefs: [...base.xrefs],
    preview: undefined,
    attributes: base.attributes ? { ...base.attributes } : undefined,
  };
}

interface InferredVicTargets {
  bankBases: number[];
  screenAddresses: number[];
  charsetAddresses: number[];
  bitmapAddresses: number[];
}

type CrossReferenceMap = Map<number, number[]>;

function readPrg(prgPath: string): PrgImage {
  const file = readFileSync(prgPath);
  if (file.length < 2) {
    throw new Error(`PRG too small: ${prgPath}`);
  }

  return {
    loadAddress: file.readUInt16LE(0),
    data: file.subarray(2),
  };
}

function maybeLoadAnalysis(prgPath: string, requestedPath?: string): AnalysisReport | undefined {
  const explicitPath = requestedPath ? resolve(requestedPath) : undefined;
  if (explicitPath && existsSync(explicitPath)) {
    return JSON.parse(readFileSync(explicitPath, "utf8")) as AnalysisReport;
  }

  const parsed = parse(prgPath);
  const candidates = [
    resolve(dirname(prgPath), `${parsed.name}_analysis.json`),
    resolve(dirname(prgPath), "analysis.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8")) as AnalysisReport;
    }
  }

  return undefined;
}

// Global annotation index set during rendering — used by makeLabel for semantic names
let activeAnnotations: AnnotationsIndex | undefined;

function makeLabel(address: number): string {
  const lbl = activeAnnotations?.labelsByAddress.get(address);
  if (lbl) {
    return lbl.label;
  }
  return `W${hex16(address).toUpperCase()}`;
}

function formatHex8(value: number): string {
  return hex8(value).toUpperCase();
}

function formatHex16(value: number): string {
  return hex16(value).toUpperCase();
}

function formatAddress(value: number): string {
  return `$${formatHex16(value)}`;
}

function formatOffset(value: number): string {
  return value <= 0xff ? `$${formatHex8(value)}` : `$${formatHex16(value)}`;
}

function formatPlainOffset(value: number): string {
  return `${value}`;
}

function decodeLinear(loadAddress: number, data: Buffer): DecodedInstruction[] {
  const instructions: DecodedInstruction[] = [];
  let offset = 0;

  while (offset < data.length) {
    const instruction = decodeInstruction(data, offset, loadAddress);
    instructions.push(instruction);
    offset += instruction.size;
  }

  return instructions;
}

function buildInstructionIndex(instructions: DecodedInstruction[]): InstructionIndex {
  const byAddress = new Map<number, DecodedInstruction>();
  const ownerByAddress = new Map<number, DecodedInstruction>();

  for (const instruction of instructions) {
    byAddress.set(instruction.address, instruction);
    for (let index = 0; index < instruction.size; index += 1) {
      ownerByAddress.set((instruction.address + index) & 0xffff, instruction);
    }
  }

  return { byAddress, ownerByAddress };
}

function collectLabels(instructions: DecodedInstruction[], index: InstructionIndex, _entryPoints: number[]): Set<number> {
  const labels = new Set<number>();

  if (instructions.length > 0) {
    labels.add(instructions[0].address);
  }

  for (const instruction of instructions) {
    const targetAddress = instruction.targetAddress;
    if (targetAddress === undefined) {
      continue;
    }

    const owner = index.ownerByAddress.get(targetAddress);
    if (owner !== undefined) {
      labels.add(owner.address);
    }

    if (isBranchInstruction(instruction) || isCallInstruction(instruction) || isJumpInstruction(instruction)) {
      const direct = index.byAddress.get(targetAddress);
      if (direct !== undefined) {
        labels.add(direct.address);
      }
    }
  }

  return labels;
}

function collectCrossReferences(instructions: DecodedInstruction[], labels: Set<number>, index: InstructionIndex): CrossReferenceMap {
  const xrefs: CrossReferenceMap = new Map();

  for (const instruction of instructions) {
    const targetAddress = instruction.targetAddress;
    if (targetAddress === undefined) {
      continue;
    }

    const owner = index.ownerByAddress.get(targetAddress);
    if (!owner || !labels.has(owner.address)) {
      continue;
    }

    const refs = xrefs.get(owner.address) ?? [];
    refs.push(instruction.address);
    xrefs.set(owner.address, refs);
  }

  return xrefs;
}

function findCodeLabelExpression(
  address: number,
  labels: Set<number>,
  instructionOwnerByAddress: Map<number, number>,
): string | undefined {
  // Prefer exact target labels over owner+offset. This keeps normal
  // branch/jump rendering stable while still allowing owner-relative
  // notation for unlabeled code bytes (for example self-mod patches).
  if (labels.has(address)) {
    return makeLabel(address);
  }

  const instructionOwner = instructionOwnerByAddress.get(address);
  if (instructionOwner !== undefined) {
    if (!labels.has(instructionOwner)) {
      return undefined;
    }
    const offset = address - instructionOwner;
    return offset === 0 ? makeLabel(instructionOwner) : `${makeLabel(instructionOwner)}+${formatPlainOffset(offset)}`;
  }

  return undefined;
}

function findOperandExpression(
  address: number,
  labels: Set<number>,
  instructionOwnerByAddress: Map<number, number>,
  segmentOwnerByAddress: Map<number, number>,
): string | undefined {
  if (isC64IoAddress(address)) {
    return formatC64IoAddress(address);
  }

  const codeExpression = findCodeLabelExpression(address, labels, instructionOwnerByAddress);
  if (codeExpression) {
    return codeExpression;
  }

  const segmentOwner = segmentOwnerByAddress.get(address);
  if (segmentOwner !== undefined && labels.has(segmentOwner)) {
    const offset = address - segmentOwner;
    return offset === 0 ? makeLabel(segmentOwner) : `${makeLabel(segmentOwner)}+${formatOffset(offset)}`;
  }

  return undefined;
}

function operandTextFromFact(
  instruction: Pick<InstructionFact, "addressingMode" | "operandValue" | "targetAddress">,
  labels: Set<number>,
  instructionOwnerByAddress: Map<number, number>,
  segmentOwnerByAddress: Map<number, number>,
  operandOverride?: string,
): string {
  if (operandOverride !== undefined) {
    return operandOverride;
  }
  const operand = instruction.operandValue ?? 0;
  const targetAddress = instruction.targetAddress;
  const targetExpression =
    targetAddress !== undefined
      ? findOperandExpression(targetAddress, labels, instructionOwnerByAddress, segmentOwnerByAddress)
      : undefined;

  switch (instruction.addressingMode) {
    case "impl":
      return "";
    case "acc":
      return "";
    case "imm":
      return `#$${formatHex8(operand)}`;
    case "zp":
      return `$${formatHex8(operand)}`;
    case "zp,x":
      return `$${formatHex8(operand)},x`;
    case "zp,y":
      return `$${formatHex8(operand)},y`;
    case "abs":
      return targetExpression ?? `$${formatHex16(operand)}`;
    case "abs,x":
      return `${targetExpression ?? `$${formatHex16(operand)}`},x`;
    case "abs,y":
      return `${targetExpression ?? `$${formatHex16(operand)}`},y`;
    case "ind":
      return `(${targetExpression ?? `$${formatHex16(operand)}`})`;
    case "(zp,x)":
      return `($${formatHex8(operand)},x)`;
    case "(zp),y":
      return `($${formatHex8(operand)}),y`;
    case "rel":
      return targetExpression ?? `$${formatHex16(targetAddress ?? operand)}`;
    default:
      return "";
  }
}

function commentTextFromTarget(targetAddress: number | undefined): string {
  if (targetAddress === undefined) {
    return "";
  }

  const metadata = findC64IoMetadata(targetAddress);
  if (!metadata) {
    return "";
  }

  return `// ${metadata.comment}`;
}

/* ── Contextual per-instruction comment generator ─────────────────────── */

const MNEMONIC_DESCRIPTIONS: Record<string, string> = {
  lda: "A =", ldx: "X =", ldy: "Y =",
  sta: "store A →", stx: "store X →", sty: "store Y →",
  tax: "X = A", tay: "Y = A", txa: "A = X", tya: "A = Y",
  tsx: "X = SP", txs: "SP = X",
  pha: "push A", pla: "pull A", php: "push flags", plp: "pull flags",
  clc: "clear carry", sec: "set carry", cli: "enable IRQ", sei: "disable IRQ",
  cld: "clear decimal", sed: "set decimal", clv: "clear overflow",
  nop: "no-op",
  rts: "return", rti: "return from interrupt", brk: "software break",
  inx: "X++", iny: "Y++", dex: "X--", dey: "Y--",
  inc: "increment", dec: "decrement",
  asl: "shift left (×2)", lsr: "shift right (÷2)", rol: "rotate left", ror: "rotate right",
  and: "A &=", ora: "A |=", eor: "A ^=",
  bit: "test bits", cmp: "compare A", cpx: "compare X", cpy: "compare Y",
  adc: "A +=", sbc: "A -=",
  jmp: "jump →", jsr: "call", beq: "branch if =", bne: "branch if ≠",
  bcs: "branch if carry set", bcc: "branch if carry clear",
  bmi: "branch if negative", bpl: "branch if positive",
  bvs: "branch if overflow", bvc: "branch if no overflow",
};

const C64_KERNAL: Record<number, string> = {
  0xFFD2: "CHROUT (print char)", 0xFFCF: "CHRIN (read char)", 0xFFE4: "GETIN (get key)",
  0xFFE1: "STOP (check stop key)", 0xFFCC: "CLRCHN (clear channels)",
  0xFF81: "CINT (init screen)", 0xFFA5: "ACPTR (serial in)", 0xFFA8: "CIOUT (serial out)",
  0xFFBA: "SETLFS", 0xFFBD: "SETNAM", 0xFFC0: "OPEN", 0xFFC3: "CLOSE",
  0xFFD5: "LOAD", 0xFFD8: "SAVE", 0xEA81: "KERNAL IRQ return",
};

const ZP_COMMON: Record<number, string> = {
  0x01: "CPU port (ROM/IO banking)",
  0x00: "CPU DDR",
};

function generateInstructionComment(
  instruction: InstructionFact,
  prevInstruction: InstructionFact | undefined,
  context: RenderAnalysisContext,
): string {
  const parts: string[] = [];
  const target = instruction.targetAddress;
  const operand = instruction.operandValue;
  const mode = instruction.addressingMode;
  const mnem = instruction.mnemonic;

  // 1. IO register comment (existing behavior, but we extend it)
  if (target !== undefined) {
    const ioMeta = findC64IoMetadata(target);
    if (ioMeta) {
      // For stores: try to include the value being written
      if (mnem.startsWith("st") && prevInstruction) {
        const prevOp = prevInstruction.operandValue;
        if (prevInstruction.mnemonic.startsWith("ld") && prevInstruction.addressingMode === "imm" && prevOp !== undefined) {
          parts.push(`${ioMeta.comment} = $${hex8(prevOp)} (${prevOp})`);
        } else if (prevInstruction.mnemonic === "and" && prevInstruction.addressingMode === "imm") {
          parts.push(`${ioMeta.comment} (masked)`);
        } else {
          parts.push(ioMeta.comment);
        }
      } else {
        parts.push(ioMeta.comment);
      }
      return `// ${parts.join(" | ")}`;
    }
  }

  // 2. KERNAL call (or platform-specific ROM symbol — Spec 048)
  if ((mnem === "jsr" || mnem === "jmp") && target !== undefined) {
    const overrides = getPlatformOverrides(activePlatform);
    if (overrides.rom[target]) {
      return `// ${overrides.rom[target]}`;
    }
    if (C64_KERNAL[target]) {
      return `// ${C64_KERNAL[target]}`;
    }
  }

  // 3. Zero-page stores/loads with known meaning (platform overlay first)
  if (mode === "zp" && operand !== undefined) {
    const overrides = getPlatformOverrides(activePlatform);
    if (overrides.zp[operand]) {
      const desc = MNEMONIC_DESCRIPTIONS[mnem] ?? mnem;
      return `// ${desc} ${overrides.zp[operand]}`;
    }
    if (ZP_COMMON[operand]) {
      const desc = MNEMONIC_DESCRIPTIONS[mnem] ?? mnem;
      return `// ${desc} ${ZP_COMMON[operand]}`;
    }
  }

  // 4. Self-modifying code: STA into code region
  if (mnem === "sta" && target !== undefined) {
    const ownerAddr = context.instructionOwnerByAddress.get(target);
    if (ownerAddr !== undefined && ownerAddr !== target) {
      const offset = target - ownerAddr;
      return `// self-mod: patch operand at ${makeLabel(ownerAddr)}+${offset}`;
    }
  }

  // 5. Branch instructions: describe condition
  if (isBranchInstruction({ mnemonic: mnem } as DecodedInstruction) && target !== undefined) {
    const desc = MNEMONIC_DESCRIPTIONS[mnem] ?? mnem;
    const dir = target < instruction.address ? "(back/loop)" : "(forward)";
    return `// ${desc} → ${makeLabel(target)} ${dir}`;
  }

  // 6. JSR to local subroutine
  if (mnem === "jsr" && target !== undefined && context.labelSet.has(target)) {
    return `// call ${makeLabel(target)}`;
  }

  // 7. JMP
  if (mnem === "jmp" && target !== undefined) {
    if (target === instruction.address) {
      return "// infinite loop (halts here, IRQ-driven from now)";
    }
    return `// jump → ${makeLabel(target)}`;
  }

  // 8. Immediate loads: show decimal + context
  if (mode === "imm" && operand !== undefined && mnem.startsWith("ld")) {
    const reg = mnem === "lda" ? "A" : mnem === "ldx" ? "X" : "Y";
    if (operand >= 0x20 && operand <= 0x7E) {
      return `// ${reg} = $${hex8(operand)} (${operand}, '${String.fromCharCode(operand)}')`;
    }
    return `// ${reg} = $${hex8(operand)} (${operand})`;
  }

  // 9. Compare immediate: show what we're comparing against
  if (mode === "imm" && operand !== undefined && (mnem === "cmp" || mnem === "cpx" || mnem === "cpy")) {
    const reg = mnem === "cmp" ? "A" : mnem === "cpx" ? "X" : "Y";
    return `// ${reg} == $${hex8(operand)} (${operand})?`;
  }

  // 10. RTS/RTI
  if (mnem === "rts") return "// return";
  if (mnem === "rti") return "// return from interrupt";

  // 11. Stack ops
  if (mnem === "sei") return "// disable interrupts";
  if (mnem === "cli") return "// enable interrupts";
  if (mnem === "pha") return "// push A to stack";
  if (mnem === "pla") return "// pull A from stack";
  if (mnem === "php") return "// push flags to stack";
  if (mnem === "plp") return "// pull flags from stack";

  // 12. Transfer instructions
  if (MNEMONIC_DESCRIPTIONS[mnem] && !target && (mode === "impl" || mode === "acc")) {
    return `// ${MNEMONIC_DESCRIPTIONS[mnem]}`;
  }

  // 13. Indexed access to non-IO addresses (table access)
  if ((mode === "abs,x" || mode === "abs,y") && target !== undefined && !isC64IoAddress(target)) {
    const reg = mode === "abs,x" ? "X" : "Y";
    const desc = MNEMONIC_DESCRIPTIONS[mnem] ?? mnem;
    return `// ${desc} ${makeLabel(target)}[${reg}]`;
  }

  // 14. Indirect addressing
  if (mode === "(zp),y" && operand !== undefined) {
    return `// ${MNEMONIC_DESCRIPTIONS[mnem] ?? mnem} ($${hex8(operand)}),Y (indirect indexed)`;
  }
  if (mode === "(zp,x)" && operand !== undefined) {
    return `// ${MNEMONIC_DESCRIPTIONS[mnem] ?? mnem} ($${hex8(operand)},X) (indexed indirect)`;
  }

  // No comment for truly trivial instructions
  return "";
}

function requiresUndocumentedByteRendering(instruction: Pick<InstructionFact, "isUndocumented">): boolean {
  return instruction.isUndocumented;
}

function requiresExactWidthRendering(
  instruction: Pick<InstructionFact, "addressingMode" | "operandValue" | "targetAddress">,
): boolean {
  const operand = instruction.targetAddress ?? instruction.operandValue;
  if (operand === undefined) {
    return false;
  }

  return (
    (instruction.addressingMode === "abs" || instruction.addressingMode === "abs,x" || instruction.addressingMode === "abs,y") &&
    operand >= 0x0000 &&
    operand <= 0x00ff
  );
}

function renderInstructionBytesWithDecodedComment(
  instruction: Pick<InstructionFact, "bytes" | "mnemonic" | "addressingMode" | "operandValue" | "targetAddress">,
  labels: Set<number>,
  instructionOwnerByAddress: Map<number, number>,
  segmentOwnerByAddress: Map<number, number>,
): { asm: string; comment: string } {
  const asm = `.byte ${instruction.bytes.map((value) => `$${formatHex8(value)}`).join(", ")}`;
  const operand = operandTextFromFact(instruction, labels, instructionOwnerByAddress, segmentOwnerByAddress);
  const decoded = operand ? `${instruction.mnemonic} ${operand}` : instruction.mnemonic;
  return {
    asm,
    comment: `// exact-width ${decoded}`,
  };
}

function renderUndocumentedInstructionBytes(instruction: Pick<InstructionFact, "bytes" | "mnemonic" | "opcode">): { asm: string; comment: string } {
  const bytes = instruction.bytes.map((value) => `$${formatHex8(value)}`).join(", ");
  return {
    asm: `.byte ${bytes}`,
    comment: `// undocumented ${instruction.mnemonic} (opcode $${formatHex8(instruction.opcode)})`,
  };
}

function labelCommentText(address: number, xrefs: CrossReferenceMap): string {
  const refs = xrefs.get(address);
  if (!refs || refs.length === 0) {
    return "";
  }

  const uniqueRefs = Array.from(new Set(refs));
  const rendered = uniqueRefs.slice(0, 4).map((ref) => makeLabel(ref)).join(", ");
  const suffix = uniqueRefs.length > 4 ? ", ..." : "";
  return ` // referenced from ${rendered}${suffix}`;
}

function buildAnalysisContext(report: AnalysisReport, prg: PrgImage): RenderAnalysisContext {
  const segments = [...report.segments].sort((left, right) => left.start - right.start);
  const instructions = new Map<number, InstructionFact>();
  const instructionOwnerByAddress = new Map<number, number>();
  const segmentOwnerByAddress = new Map<number, number>();

  for (const instruction of report.codeAnalysis?.instructions ?? []) {
    instructions.set(instruction.address, instruction);
    for (let offset = 0; offset < instruction.size; offset += 1) {
      instructionOwnerByAddress.set(instruction.address + offset, instruction.address);
    }
  }

  for (const instruction of report.probableCodeAnalysis?.instructions ?? []) {
    instructions.set(instruction.address, instruction);
    for (let offset = 0; offset < instruction.size; offset += 1) {
      instructionOwnerByAddress.set(instruction.address + offset, instruction.address);
    }
  }

  const labelSet = new Set<number>();
  for (const segment of segments) {
    labelSet.add(segment.start);
    for (let address = segment.start; address <= segment.end; address += 1) {
      segmentOwnerByAddress.set(address, segment.start);
    }
  }

  for (const instruction of instructions.values()) {
    const targetAddress = instruction.targetAddress;
    if (targetAddress === undefined) {
      continue;
    }
    if (targetAddress < report.mapping.startAddress || targetAddress > report.mapping.endAddress) {
      continue;
    }
    const instructionOwner = instructionOwnerByAddress.get(targetAddress);
    if (instructionOwner !== undefined && instructionOwner !== targetAddress) {
      // Mid-instruction target — typical self-mod operand patch. Label only
      // the owning instruction so the renderer emits `<owner>+<offset>`
      // instead of an undeclared label that falls inside the operand bytes.
      labelSet.add(instructionOwner);
    } else {
      labelSet.add(targetAddress);
      if (instructionOwner !== undefined) {
        labelSet.add(instructionOwner);
      }
    }
  }

  const xrefsByTarget = new Map<number, Array<{ xref: CrossReference; provenance: "confirmed" | "probable" }>>();
  const addXrefs = (xrefs: CrossReference[] | undefined, provenance: "confirmed" | "probable"): void => {
    for (const xref of xrefs ?? []) {
      if (xref.type === "fallthrough") {
        continue;
      }

      const targetInMapping =
        xref.targetAddress >= report.mapping.startAddress && xref.targetAddress <= report.mapping.endAddress;
      if (!targetInMapping) {
        continue;
      }

      const instructionOwner = instructionOwnerByAddress.get(xref.targetAddress);
      if (instructionOwner !== undefined) {
        if (instructionOwner !== xref.targetAddress) {
          // Mid-instruction xref target — label the owner only so we emit
          // `<owner>+<offset>` for self-mod-style patches.
          labelSet.add(instructionOwner);
        } else {
          labelSet.add(xref.targetAddress);
        }
      }
      // No `else`: when the xref points into a non-code region (no
      // instruction owner) we deliberately do NOT mint a free-standing
      // label at the target. The render path falls back to either
      // `<segment-label>+<offset>` (when the target sits inside a
      // labelled data segment) or a raw `$XXXX` operand. That avoids
      // emitting a label reference that has no declaration, which is
      // the false-positive code-island branch failure mode.
      const existing = xrefsByTarget.get(xref.targetAddress) ?? [];
      existing.push({ xref, provenance });
      xrefsByTarget.set(xref.targetAddress, existing);
    }
  };

  addXrefs(report.codeAnalysis?.xrefs, "confirmed");
  addXrefs(report.probableCodeAnalysis?.xrefs, "probable");

  const groupByStart = <T extends { start: number }>(facts: T[] | undefined): Map<number, T[]> => {
    const map = new Map<number, T[]>();
    for (const fact of facts ?? []) {
      const existing = map.get(fact.start) ?? [];
      existing.push(fact);
      map.set(fact.start, existing);
    }
    return map;
  };

  return {
    report,
    prg,
    segments,
    instructions,
    labelSet,
    instructionOwnerByAddress,
    segmentOwnerByAddress,
    xrefsByTarget,
    copyFacts: report.codeSemantics?.copyRoutines?.filter((fact) => fact.provenance === "confirmed_code") ?? [],
    pointerFacts: report.codeSemantics?.indirectPointers?.filter((fact) => fact.provenance === "confirmed_code") ?? [],
    tableFacts: report.codeSemantics?.tableUsages?.filter((fact) => fact.provenance === "confirmed_code") ?? [],
    splitPointerFacts: report.codeSemantics?.splitPointerTables?.filter((fact) => fact.provenance === "confirmed_code") ?? [],
    displayStates: report.codeSemantics?.displayStates ?? [],
    displayTransfers: report.codeSemantics?.displayTransfers ?? [],
    ramAccesses: report.codeSemantics?.ramAccesses ?? [],
    ramHypotheses: report.codeSemantics?.ramHypotheses ?? [],
    vicWrites: report.hardwareEvidence?.vicWrites ?? [],
    sidWrites: report.hardwareEvidence?.sidWrites ?? [],
    copyFactsByStart: groupByStart(report.codeSemantics?.copyRoutines?.filter((fact) => fact.provenance === "confirmed_code")),
    pointerFactsByStart: groupByStart(report.codeSemantics?.indirectPointers?.filter((fact) => fact.provenance === "confirmed_code")),
    tableFactsByStart: groupByStart(report.codeSemantics?.tableUsages?.filter((fact) => fact.provenance === "confirmed_code")),
    displayTransfersByStart: groupByStart(report.codeSemantics?.displayTransfers),
    operandOverrides: new Map<number, string>(),
  };
}

function buildAnnotatedSegments(segments: Segment[], annotations?: AnnotationsIndex["segmentAnnotations"]): Segment[] {
  if (!annotations || annotations.length === 0) {
    return segments;
  }
  const splitSegments: Segment[] = [];
  for (const segment of segments) {
    let contained = annotations.filter(({ start, end }) => start >= segment.start && end <= segment.end);
    const hasStrictContained = contained.some(({ start, end }) => start !== segment.start || end !== segment.end);
    if (hasStrictContained) {
      contained = contained.filter(({ start, end }) => start !== segment.start || end !== segment.end);
    }
    if (contained.length === 0) {
      splitSegments.push(segment);
      continue;
    }

    let cursor = segment.start;
    let emittedAny = false;
    for (const entry of contained) {
      if (entry.start < cursor) {
        continue;
      }

      if (entry.start > cursor) {
        splitSegments.push(cloneSegment(segment, cursor, entry.start - 1));
      }

      splitSegments.push(cloneSegment(segment, entry.start, entry.end, entry.annotation.kind));
      emittedAny = true;
      cursor = entry.end + 1;
    }

    if (!emittedAny) {
      splitSegments.push(segment);
      continue;
    }

    if (cursor <= segment.end) {
      splitSegments.push(cloneSegment(segment, cursor, segment.end));
    }
  }

  return splitSegments.sort((left, right) => left.start - right.start);
}

function applyAnnotationSegmentSplits(context: RenderAnalysisContext): void {
  const splitSegments = buildAnnotatedSegments(context.segments, context.annotations?.segmentAnnotations);
  context.segments = splitSegments;
  context.segmentOwnerByAddress.clear();
  for (const segment of context.segments) {
    context.labelSet.add(segment.start);
    for (let address = segment.start; address <= segment.end; address += 1) {
      context.segmentOwnerByAddress.set(address, segment.start);
    }
  }
}

// Walk back N instructions from `fromAddress`, returning the most-recent
// `lda/ldx/ldy #imm` per register. The closest immediate to the call wins.
function collectRecentImmediateLoads(
  fromAddress: number,
  context: RenderAnalysisContext,
  windowSize: number,
): Map<RegisterName, { address: number; value: number }> {
  const result = new Map<RegisterName, { address: number; value: number }>();
  let cursor: number | undefined = fromAddress;
  for (let step = 0; step < windowSize; step += 1) {
    if (cursor === undefined) break;
    const prev = previousInstructionAt(cursor, context);
    if (!prev) break;
    cursor = prev.address;
    if (prev.addressingMode !== "imm" || prev.operandValue === undefined) continue;
    const reg: RegisterName | undefined =
      prev.mnemonic === "lda" ? "a" :
      prev.mnemonic === "ldx" ? "x" :
      prev.mnemonic === "ldy" ? "y" : undefined;
    if (!reg) continue;
    if (!result.has(reg)) {
      result.set(reg, { address: prev.address, value: prev.operandValue });
    }
  }
  return result;
}

function resolvePointerLabel(pointer: number, context: RenderAnalysisContext): string | undefined {
  if (context.labelSet.has(pointer)) {
    return makeLabel(pointer);
  }
  return undefined;
}

interface ResolvedRoutineAbi {
  pointerPairs: Array<{ low: RegisterName; high: RegisterName }>;
}

function resolveRoutineAbi(address: number, context: RenderAnalysisContext): ResolvedRoutineAbi | undefined {
  const annotated = context.annotations?.routinesByAddress.get(address);
  if (annotated?.abi?.pointerPairs && annotated.abi.pointerPairs.length > 0) {
    return { pointerPairs: annotated.abi.pointerPairs.map((pair) => ({ low: pair.low, high: pair.high })) };
  }
  const kernal = lookupKernalAbi(address);
  if (kernal?.pointerPairs && kernal.pointerPairs.length > 0) {
    return { pointerPairs: kernal.pointerPairs.map((pair) => ({ low: pair.low, high: pair.high })) };
  }
  return undefined;
}

// For each `JSR <routine>` whose ABI declares pointer-pair registers, walk back
// looking for the immediate loads and rewrite the operand text to `#<label` /
// `#>label` when the constructed pointer hits a labelled address. Pulls ABI
// from both the pre-baked KERNAL table and user annotations.
function applyKernalAbiOperandOverrides(context: RenderAnalysisContext): void {
  const PRE_JSR_WINDOW = 8;
  for (const instruction of context.instructions.values()) {
    if (instruction.mnemonic !== "jsr") continue;
    const target = instruction.targetAddress;
    if (target === undefined) continue;
    const abi = resolveRoutineAbi(target, context);
    if (!abi) continue;

    const recent = collectRecentImmediateLoads(instruction.address, context, PRE_JSR_WINDOW);

    for (const pair of abi.pointerPairs) {
      const lo = recent.get(pair.low);
      const hi = recent.get(pair.high);
      if (!lo || !hi) continue;
      const pointer = ((hi.value & 0xff) << 8) | (lo.value & 0xff);
      const label = resolvePointerLabel(pointer, context);
      if (!label) continue;
      context.operandOverrides.set(lo.address, `#<${label}`);
      context.operandOverrides.set(hi.address, `#>${label}`);
    }
  }
}

// Detect zero-page pointer construction:
//
//   lda #lo   /   sta $fb
//   lda #hi   /   sta $fc
//
// (or with X/Y, or with the high half stored first). When the combined
// (hi<<8)|lo points at a labelled address, rewrite the immediate operands as
// `#<label` / `#>label` so the pointer becomes relocatable in source form.
function applyZpPointerSetupOverrides(context: RenderAnalysisContext): void {
  interface ZpStoreEvent {
    listIndex: number;
    storeInstructionAddress: number;
    zpAddress: number;
    immediateValue: number;
    immediateInstructionAddress: number;
  }

  const instructions = Array.from(context.instructions.values()).sort((left, right) => left.address - right.address);
  const events: ZpStoreEvent[] = [];

  const findRecentImmediate = (
    listIndex: number,
    register: RegisterName,
  ): { value: number; address: number } | undefined => {
    const lookback = 4;
    for (let step = 1; step <= lookback; step += 1) {
      const idx = listIndex - step;
      if (idx < 0) return undefined;
      const cand = instructions[idx]!;
      // Reject if the candidate clobbers our register without producing an immediate
      const mnem = cand.mnemonic;
      if (cand.addressingMode === "imm" && cand.operandValue !== undefined) {
        if (register === "a" && mnem === "lda") return { value: cand.operandValue, address: cand.address };
        if (register === "x" && mnem === "ldx") return { value: cand.operandValue, address: cand.address };
        if (register === "y" && mnem === "ldy") return { value: cand.operandValue, address: cand.address };
      }
      if (clobbersRegister(cand, register)) return undefined;
    }
    return undefined;
  };

  for (let i = 0; i < instructions.length; i += 1) {
    const inst = instructions[i]!;
    if (inst.addressingMode !== "zp" || inst.operandValue === undefined) continue;
    let register: RegisterName | undefined;
    if (inst.mnemonic === "sta") register = "a";
    else if (inst.mnemonic === "stx") register = "x";
    else if (inst.mnemonic === "sty") register = "y";
    if (!register) continue;
    const imm = findRecentImmediate(i, register);
    if (!imm) continue;
    events.push({
      listIndex: i,
      storeInstructionAddress: inst.address,
      zpAddress: inst.operandValue,
      immediateValue: imm.value,
      immediateInstructionAddress: imm.address,
    });
  }

  const PAIR_WINDOW = 8;
  for (let i = 0; i < events.length; i += 1) {
    const a = events[i]!;
    for (let j = i + 1; j < events.length; j += 1) {
      const b = events[j]!;
      if (b.listIndex - a.listIndex > PAIR_WINDOW) break;
      let low: ZpStoreEvent | undefined;
      let high: ZpStoreEvent | undefined;
      if (b.zpAddress === a.zpAddress + 1) {
        low = a;
        high = b;
      } else if (b.zpAddress === a.zpAddress - 1) {
        low = b;
        high = a;
      } else {
        continue;
      }
      const pointer = ((high.immediateValue & 0xff) << 8) | (low.immediateValue & 0xff);
      const label = resolvePointerLabel(pointer, context);
      if (!label) continue;
      if (!context.operandOverrides.has(low.immediateInstructionAddress)) {
        context.operandOverrides.set(low.immediateInstructionAddress, `#<${label}`);
      }
      if (!context.operandOverrides.has(high.immediateInstructionAddress)) {
        context.operandOverrides.set(high.immediateInstructionAddress, `#>${label}`);
      }
      break;
    }
  }
}

function clobbersRegister(instruction: InstructionFact, register: RegisterName): boolean {
  const m = instruction.mnemonic;
  if (register === "a") {
    if (m === "lda" || m === "pla" || m === "txa" || m === "tya") return true;
    if (m === "and" || m === "ora" || m === "eor" || m === "adc" || m === "sbc") return true;
    if (m === "asl" || m === "lsr" || m === "rol" || m === "ror") return instruction.addressingMode === "acc";
  }
  if (register === "x") {
    if (m === "ldx" || m === "tax" || m === "tsx" || m === "inx" || m === "dex") return true;
  }
  if (register === "y") {
    if (m === "ldy" || m === "tay" || m === "iny" || m === "dey") return true;
  }
  if (m === "jsr") return true; // callee may clobber any register
  return false;
}

// User-supplied immediate overrides win over heuristic-driven KERNAL rewrites:
// the annotation explicitly names the label, so respect it last.
function applyAnnotationImmediateOverrides(context: RenderAnalysisContext): void {
  const annotations = context.annotations;
  if (!annotations) return;
  for (const entry of annotations.immediatesByAddress.values()) {
    const prefix = entry.kind === "lo-of" ? "#<" : "#>";
    context.operandOverrides.set(entry.address, `${prefix}${entry.label}`);
  }
}

function reclassifySegmentRanges(
  context: RenderAnalysisContext,
  ranges: Array<{ start: number; end: number; kind: SegmentKind }>,
): void {
  if (ranges.length === 0) return;
  const newSegments: Segment[] = [];
  for (const segment of context.segments) {
    const overlapping = ranges
      .filter((r) => r.start <= segment.end && r.end >= segment.start)
      .map((r) => ({
        start: Math.max(r.start, segment.start),
        end: Math.min(r.end, segment.end),
        kind: r.kind,
      }))
      .sort((left, right) => left.start - right.start);
    if (overlapping.length === 0) {
      newSegments.push(segment);
      continue;
    }
    let cursor = segment.start;
    for (const range of overlapping) {
      if (range.start > cursor) {
        newSegments.push(cloneSegment(segment, cursor, range.start - 1));
      }
      newSegments.push(cloneSegment(segment, range.start, range.end, range.kind));
      cursor = range.end + 1;
    }
    if (cursor <= segment.end) {
      newSegments.push(cloneSegment(segment, cursor, segment.end));
    }
  }
  context.segments = newSegments.sort((left, right) => left.start - right.start);
  context.segmentOwnerByAddress.clear();
  for (const segment of context.segments) {
    context.labelSet.add(segment.start);
    for (let address = segment.start; address <= segment.end; address += 1) {
      context.segmentOwnerByAddress.set(address, segment.start);
    }
  }
}

// Apply pointerTables[] and jumpTables[] annotations: reclassify the listed
// ranges so the renderer emits them as data tables rather than raw bytes, and
// seed the label set with each entry's target so cross-references resolve.
function applyAnnotationDataTables(context: RenderAnalysisContext, prg: PrgImage): void {
  const annotations = context.annotations;
  if (!annotations) return;

  const ranges: Array<{ start: number; end: number; kind: SegmentKind }> = [];

  for (const pt of annotations.pointerTables) {
    ranges.push({ start: pt.start, end: pt.end, kind: "pointer_table" });
    seedWordTableTargets(prg, pt.start, pt.end, pt.endian, context);
  }

  for (const jt of annotations.jumpTables) {
    if (jt.kind === "word") {
      ranges.push({ start: jt.start, end: jt.end, kind: "pointer_table" });
      seedWordTableTargets(prg, jt.start, jt.end, "little", context);
    } else {
      // jmp / jsr table: each row is 3 bytes (opcode, lo, hi). Treat as code
      // and record each target so it gets a label.
      ranges.push({ start: jt.start, end: jt.end, kind: "code" });
      seedJumpTableTargets(prg, jt.start, jt.end, context);
    }
  }

  reclassifySegmentRanges(context, ranges);
}

function seedWordTableTargets(
  prg: PrgImage,
  start: number,
  end: number,
  endian: "little" | "big",
  context: RenderAnalysisContext,
): void {
  for (let address = start; address + 1 <= end; address += 2) {
    const offset = address - prg.loadAddress;
    if (offset < 0 || offset + 1 >= prg.data.length) break;
    const a = prg.data[offset]!;
    const b = prg.data[offset + 1]!;
    const target = endian === "little" ? a | (b << 8) : (a << 8) | b;
    context.labelSet.add(target);
  }
}

function seedJumpTableTargets(prg: PrgImage, start: number, end: number, context: RenderAnalysisContext): void {
  for (let address = start; address + 2 <= end; address += 3) {
    const offset = address - prg.loadAddress;
    if (offset < 0 || offset + 2 >= prg.data.length) break;
    const lo = prg.data[offset + 1]!;
    const hi = prg.data[offset + 2]!;
    const target = lo | (hi << 8);
    context.labelSet.add(target);
  }
}

function decodeInstructionFactAtAddress(prg: PrgImage, address: number): InstructionFact | undefined {
  const offset = address - prg.loadAddress;
  if (offset < 0 || offset >= prg.data.length) {
    return undefined;
  }

  const decoded = decodeInstruction(prg.data, offset, prg.loadAddress);
  return {
    address: decoded.address,
    opcode: decoded.opcode,
    size: decoded.size,
    bytes: decoded.bytes,
    mnemonic: decoded.mnemonic,
    addressingMode: decoded.mode,
    operandText: "",
    operandValue: decoded.operand,
    targetAddress: decoded.targetAddress,
    fallthroughAddress: decoded.address + decoded.size,
    isKnownOpcode: !decoded.isUnknown,
    isUndocumented: decoded.isUndocumented,
    isControlFlow:
      isBranchInstruction(decoded)
      || isCallInstruction(decoded)
      || isJumpInstruction(decoded)
      || decoded.mnemonic === "rts"
      || decoded.mnemonic === "rti"
      || decoded.mnemonic === "brk",
    provenance: "probable_code",
  };
}

function labelCommentTextFromAnalysis(
  address: number,
  xrefsByTarget: Map<number, Array<{ xref: CrossReference; provenance: "confirmed" | "probable" }>>,
): string {
  const refs = xrefsByTarget.get(address);
  if (!refs || refs.length === 0) {
    return "";
  }

  const rendered = Array.from(
    new Map(
      refs.map((entry) => [
        `${entry.xref.sourceAddress}:${entry.provenance}`,
        `${makeLabel(entry.xref.sourceAddress)}${entry.provenance === "probable" ? "(p)" : ""}`,
      ]),
    ).values(),
  );

  return ` // referenced from ${rendered.slice(0, 4).join(", ")}${rendered.length > 4 ? ", ..." : ""}`;
}

function inferVicTargetsFromHardware(context: RenderAnalysisContext): InferredVicTargets {
  const bankBases = new Set<number>();
  const screenAddresses = new Set<number>();
  const charsetAddresses = new Set<number>();
  const bitmapAddresses = new Set<number>();

  const dd00Writes = context.vicWrites.filter(
    (write) => write.registerAddress === 0xdd00 && write.inferredValue !== undefined && write.source === "confirmed_code",
  );
  const d018Writes = context.vicWrites.filter(
    (write) => write.registerAddress === 0xd018 && write.inferredValue !== undefined && write.source === "confirmed_code",
  );

  for (const write of dd00Writes) {
    const value = write.inferredValue ?? 0;
    bankBases.add(0xc000 - ((value & 0x03) * 0x4000));
  }

  if (bankBases.size === 0) {
    bankBases.add(0x0000);
    bankBases.add(0x4000);
    bankBases.add(0x8000);
    bankBases.add(0xc000);
  }

  for (const write of d018Writes) {
    const value = write.inferredValue ?? 0;
    for (const base of bankBases) {
      screenAddresses.add(base + ((value >> 4) & 0x0f) * 0x0400);
      charsetAddresses.add(base + ((value >> 1) & 0x07) * 0x0800);
      bitmapAddresses.add(base + ((value & 0x08) !== 0 ? 0x2000 : 0x0000));
    }
  }

  return {
    bankBases: Array.from(bankBases).sort((left, right) => left - right),
    screenAddresses: Array.from(screenAddresses).sort((left, right) => left - right),
    charsetAddresses: Array.from(charsetAddresses).sort((left, right) => left - right),
    bitmapAddresses: Array.from(bitmapAddresses).sort((left, right) => left - right),
  };
}

function factInRange<T extends { start: number; end: number }>(segment: Segment, facts: T[]): T[] {
  return facts.filter((fact) => fact.start <= segment.end && fact.end >= segment.start);
}

function touchesAddressInSegment(addresses: number[], segment: Segment): boolean {
  return addresses.some((address) => address >= segment.start && address <= segment.end);
}

function classifySplitPointerFact(fact: SplitPointerTableFact): string {
  const targets = fact.sampleTargets;
  if (targets.length >= 4) {
    const deltas = targets.slice(1).map((target, index) => target - targets[index]);
    const sameStride = deltas.length > 0 && deltas.every((delta) => delta === deltas[0]);
    if (sameStride && deltas[0] === 0x28) {
      return "screen_row_table";
    }
  }
  if (fact.pointerBase === 0x1d) {
    return "jump_dispatch_table";
  }
  if (fact.pointerBase === 0x12) {
    return "work_pair_or_state_table";
  }
  if (fact.pointerBase === 0x03 || fact.pointerBase === 0x06) {
    return "low_ram_structure_table";
  }
  return "generic_split_pointer_table";
}

function segmentPointerTargets(segment: Segment, context: RenderAnalysisContext): number[] {
  return factInRange(segment, context.pointerFacts)
    .map((fact) => fact.constantTarget)
    .filter((target): target is number => target !== undefined)
    .filter((target, index, items) => items.indexOf(target) === index)
    .sort((left, right) => left - right);
}

function displayStateForSegment(segment: Segment, context: RenderAnalysisContext): DisplayStateFact | undefined {
  return context.displayStates.find((state) => state.start === segment.start && state.end === segment.end);
}

function displayTransfersForSegment(segment: Segment, context: RenderAnalysisContext): DisplayTransferFact[] {
  return context.displayTransfers.filter((transfer) => transfer.start >= segment.start && transfer.start <= segment.end);
}

function summarizeSpritePointerSeeds(
  segment: Segment,
  context: RenderAnalysisContext,
): string[] {
  const state = displayStateForSegment(segment, context);
  if (!state?.bankBase) {
    return [];
  }

  const instructions = segmentInstructions(segment, context);
  const immediateByAddress = new Map<number, number>();

  for (let index = 0; index < instructions.length - 1; index += 1) {
    const load = instructions[index];
    const store = instructions[index + 1];
    if (
      load.mnemonic === "lda" &&
      load.addressingMode === "imm" &&
      load.operandValue !== undefined &&
      store.mnemonic === "sta" &&
      store.addressingMode === "abs" &&
      store.operandValue !== undefined &&
      store.operandValue >= 0x40c1 &&
      store.operandValue <= 0x40c8
    ) {
      immediateByAddress.set(store.operandValue, load.operandValue);
    }
  }

  const sorted = Array.from(immediateByAddress.entries()).sort((left, right) => left[0] - right[0]);
  if (sorted.length < 2) {
    return [];
  }

  const resolved = sorted
    .map(([address, value]) => `${makeLabel(address)}=$${formatHex8(value)}->${formatAddress(state.bankBase! + value * 64)}`)
    .slice(0, 8);

  return resolved;
}

function isSpriteUploadSegment(segment: Segment, context: RenderAnalysisContext): boolean {
  const instructions = segmentInstructions(segment, context);
  const writesSpritePositions = instructions.some(
    (instruction) =>
      instruction.mnemonic.startsWith("st") &&
      instruction.targetAddress !== undefined &&
      instruction.targetAddress >= 0xd000 &&
      instruction.targetAddress <= 0xd00f,
  );
  const writesSpritePointers = instructions.some(
    (instruction) =>
      instruction.mnemonic.startsWith("st") &&
      instruction.targetAddress !== undefined &&
      ((instruction.targetAddress >= 0xc3f8 && instruction.targetAddress <= 0xc3ff) ||
        (instruction.targetAddress >= 0xc7f8 && instruction.targetAddress <= 0xc7ff)),
  );
  return writesSpritePositions && writesSpritePointers;
}

function writesSpriteSeedTables(segment: Segment, context: RenderAnalysisContext): boolean {
  const instructions = segmentInstructions(segment, context);
  return instructions.some(
    (instruction) =>
      instruction.mnemonic.startsWith("st") &&
      instruction.targetAddress !== undefined &&
      instruction.targetAddress >= 0x40af &&
      instruction.targetAddress <= 0x417c,
  );
}

function spritePointerPageSelection(segment: Segment, context: RenderAnalysisContext): string | undefined {
  const instructions = segmentInstructions(segment, context);
  const readsMode = instructions.some(
    (instruction) =>
      instruction.mnemonic === "lda" &&
      instruction.targetAddress === 0x09aa,
  );
  const compares13 = instructions.some(
    (instruction) =>
      instruction.mnemonic === "cmp" &&
      instruction.addressingMode === "imm" &&
      instruction.operandValue === 0x13,
  );
  const writesC3 = instructions.some(
    (instruction) =>
      instruction.mnemonic.startsWith("st") &&
      instruction.targetAddress !== undefined &&
      instruction.targetAddress >= 0xc3f8 &&
      instruction.targetAddress <= 0xc3ff,
  );
  const writesC7 = instructions.some(
    (instruction) =>
      instruction.mnemonic.startsWith("st") &&
      instruction.targetAddress !== undefined &&
      instruction.targetAddress >= 0xc7f8 &&
      instruction.targetAddress <= 0xc7ff,
  );

  if (readsMode && compares13 && writesC3 && writesC7) {
    return "W09AA == #$13 selects sprite-pointer page $C7F8; otherwise $C3F8 is used";
  }
  return undefined;
}

function summarizeSpriteStateTables(segment: Segment, context: RenderAnalysisContext): string[] {
  const instructions = segmentInstructions(segment, context);
  const touched = new Set<number>();

  for (const instruction of instructions) {
    if (
      instruction.targetAddress !== undefined &&
      instruction.targetAddress >= 0x40af &&
      instruction.targetAddress <= 0x417c
    ) {
      touched.add(instruction.targetAddress);
    }
  }

  const parts: string[] = [];
  const hasColor = Array.from(touched).some((address) => address >= 0x40af && address <= 0x40b6);
  const hasPointer = Array.from(touched).some((address) => address >= 0x40c1 && address <= 0x40c8);
  const hasX = Array.from(touched).some((address) => address >= 0x4163 && address <= 0x416c);
  const hasY = Array.from(touched).some((address) => address >= 0x4175 && address <= 0x417e);

  if (hasColor) {
    parts.push("W40AF.. holds sprite colors");
  }
  if (hasPointer) {
    parts.push("W40C1.. holds sprite pointer values");
  }
  if (hasX) {
    parts.push("W4163.. holds sprite X positions");
  }
  if (hasY) {
    parts.push("W4175.. holds sprite Y positions");
  }

  return parts;
}

function formatDisplayState(state: DisplayStateFact): string {
  const parts: string[] = [];
  if (state.bankBase !== undefined) {
    parts.push(`bank ${formatAddress(state.bankBase)}`);
  }
  if (state.screenAddress !== undefined) {
    parts.push(`screen ${formatAddress(state.screenAddress)}`);
  }
  if (state.bitmapAddress !== undefined && state.bitmapModeEnabled) {
    parts.push(`bitmap ${formatAddress(state.bitmapAddress)}`);
  } else if (state.charsetAddress !== undefined) {
    parts.push(`charset ${formatAddress(state.charsetAddress)}`);
  }
  if (state.bitmapModeEnabled) {
    parts.push(state.multicolorEnabled ? "multicolor bitmap" : "hires bitmap");
  } else if (state.multicolorEnabled !== undefined) {
    parts.push(state.multicolorEnabled ? "multicolor text/charset" : "hires text/charset");
  }
  return parts.join(", ");
}

function formatDisplayTransfer(transfer: DisplayTransferFact): string {
  const role = transfer.role === "unknown" ? "display-data" : transfer.role;
  const helper = transfer.helperRoutine !== undefined ? ` via ${formatAddress(transfer.helperRoutine)}` : "";
  return `${formatAddress(transfer.sourceAddress)} -> ${formatAddress(transfer.destinationAddress)} (${role}${helper})`;
}

function hasDisplayDisablePattern(segment: Segment, context: RenderAnalysisContext): boolean {
  const instructions = segmentInstructions(segment, context);
  for (let index = 0; index < instructions.length - 2; index += 1) {
    const a = instructions[index];
    const b = instructions[index + 1];
    const c = instructions[index + 2];
    if (
      a.mnemonic === "lda" &&
      a.targetAddress === 0xd011 &&
      b.mnemonic === "and" &&
      b.addressingMode === "imm" &&
      b.operandValue === 0xef &&
      c.mnemonic === "sta" &&
      c.targetAddress === 0xd011
    ) {
      return true;
    }
  }
  return false;
}

function segmentInstructions(segment: Segment, context: RenderAnalysisContext): InstructionFact[] {
  const items: InstructionFact[] = [];
  for (const instruction of context.instructions.values()) {
    if (instruction.address >= segment.start && instruction.address <= segment.end) {
      items.push(instruction);
    }
  }
  return items.sort((left, right) => left.address - right.address);
}

function summarizeRamTouches(segment: Segment, context: RenderAnalysisContext): string[] {
  const scoreAccess = (access: RamAccessFact): number =>
    access.directReads.length +
    access.directWrites.length +
    access.indexedReads.length +
    access.indexedWrites.length +
    access.indirectReads.length * 2 +
    access.indirectWrites.length * 2 +
    access.readModifyWrites.length * 2;

  const isGenericHypothesis = (hypothesis: RamHypothesis | undefined): boolean =>
    !hypothesis ||
    (hypothesis.kind === "table" && /^table_[0-9A-F]{4}$/i.test(hypothesis.labelHint));

  const touched = context.ramAccesses
    .filter(
      (access) =>
        touchesAddressInSegment(access.directReads, segment) ||
        touchesAddressInSegment(access.directWrites, segment) ||
        touchesAddressInSegment(access.indexedReads, segment) ||
        touchesAddressInSegment(access.indexedWrites, segment) ||
        touchesAddressInSegment(access.indirectReads, segment) ||
        touchesAddressInSegment(access.indirectWrites, segment) ||
        touchesAddressInSegment(access.readModifyWrites, segment),
    )
    .map((access) => {
      const hypotheses = context.ramHypotheses
        .filter((hypothesis) => access.address >= hypothesis.start && access.address <= hypothesis.end)
        .sort((left, right) => right.confidence - left.confidence);
      const preferredHypothesis = hypotheses.find((hypothesis) => !isGenericHypothesis(hypothesis)) ?? hypotheses[0];
      return { access, hypothesis: preferredHypothesis };
    })
    .sort((left, right) => {
      const leftGeneric = isGenericHypothesis(left.hypothesis);
      const rightGeneric = isGenericHypothesis(right.hypothesis);
      if (leftGeneric !== rightGeneric) {
        return leftGeneric ? 1 : -1;
      }
      const scoreDelta = scoreAccess(right.access) - scoreAccess(left.access);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.access.address - right.access.address;
    })
    .slice(0, 6)
    .map((access) => {
      return !isGenericHypothesis(access.hypothesis)
        ? `${formatAddress(access.access.address)} (${access.hypothesis!.kind}${access.hypothesis!.labelHint ? `:${access.hypothesis!.labelHint}` : ""})`
        : formatAddress(access.access.address);
    });

  return touched;
}

function summarizeHardwareTargets(segment: Segment, context: RenderAnalysisContext): string[] {
  const registers = [
    ...context.vicWrites.filter((write) => write.instructionAddress >= segment.start && write.instructionAddress <= segment.end),
    ...context.sidWrites.filter((write) => write.instructionAddress >= segment.start && write.instructionAddress <= segment.end),
  ]
    .map((write) => formatC64IoAddress(write.registerAddress))
    .filter((value, index, items) => items.indexOf(value) === index)
    .slice(0, 6);
  return registers;
}

function findKernalLoaderCallSequence(segment: Segment, context: RenderAnalysisContext): {
  setnamAddress: number;
  setlfsAddress: number;
  loadAddress: number;
} | undefined {
  const instructions = segmentInstructions(segment, context);
  for (let i = 0; i < instructions.length; i++) {
    const first = instructions[i]!;
    if (first.mnemonic !== "jsr" || first.targetAddress !== 0xffbd) {
      continue;
    }
    let setlfs: InstructionFact | undefined;
    let load: InstructionFact | undefined;
    for (let j = i + 1; j < Math.min(i + 16, instructions.length); j++) {
      const candidate = instructions[j]!;
      if (!setlfs && candidate.mnemonic === "jsr" && candidate.targetAddress === 0xffba) {
        setlfs = candidate;
        continue;
      }
      if (setlfs && candidate.mnemonic === "jsr" && candidate.targetAddress === 0xffd5) {
        load = candidate;
        break;
      }
    }
    if (setlfs && load) {
      return {
        setnamAddress: first.address,
        setlfsAddress: setlfs.address,
        loadAddress: load.address,
      };
    }
  }
  return undefined;
}

function previousInstructionAt(address: number, context: RenderAnalysisContext): InstructionFact | undefined {
  for (let delta = 1; delta <= 3; delta += 1) {
    const candidate = context.instructions.get(address - delta);
    if (candidate && candidate.fallthroughAddress === address) {
      return candidate;
    }
  }
  return undefined;
}

function readPrgByte(address: number, context: RenderAnalysisContext): number | undefined {
  const offset = address - context.prg.loadAddress;
  if (offset < 0 || offset >= context.prg.data.length) {
    return undefined;
  }
  return context.prg.data[offset];
}

function decodeLoaderFilename(address: number, length: number, context: RenderAnalysisContext): string | undefined {
  if (length <= 0 || length > 32) {
    return undefined;
  }
  const chars: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const value = readPrgByte(address + index, context);
    if (value === undefined || value < 0x20 || value > 0x7e) {
      return undefined;
    }
    chars.push(String.fromCharCode(value));
  }
  return chars.join("");
}

function inferLoaderFilenameCandidates(
  segment: Segment,
  helperStart: number,
  context: RenderAnalysisContext,
): string[] {
  const refs = segmentInstructions(segment, context)
    .filter((instruction) => instruction.mnemonic === "jsr" && instruction.targetAddress === helperStart)
    .map((instruction) => instruction.address);
  const names = new Set<string>();
  for (const callAddress of refs) {
    const p1 = previousInstructionAt(callAddress, context);
    const p2 = p1 ? previousInstructionAt(p1.address, context) : undefined;
    const p3 = p2 ? previousInstructionAt(p2.address, context) : undefined;
    const p4 = p3 ? previousInstructionAt(p3.address, context) : undefined;
    const p5 = p4 ? previousInstructionAt(p4.address, context) : undefined;
    const p6 = p5 ? previousInstructionAt(p5.address, context) : undefined;

    if (
      p1?.mnemonic === "pla" &&
      p2?.mnemonic === "tax" &&
      p3?.mnemonic === "lda" &&
      p3.addressingMode === "abs,x" &&
      p3.operandValue !== undefined &&
      p4?.mnemonic === "pha" &&
      p5?.mnemonic === "ldy" &&
      p5.addressingMode === "abs,x" &&
      p5.operandValue !== undefined &&
      p6?.mnemonic === "lda" &&
      p6.addressingMode === "abs,x" &&
      p6.operandValue !== undefined
    ) {
      const lengthTable = p6.operandValue;
      const lowTable = p3.operandValue;
      const highTable = p5.operandValue;
      for (let index = 0; index < 64; index += 1) {
        const length = readPrgByte(lengthTable + index, context);
        const low = readPrgByte(lowTable + index, context);
        const high = readPrgByte(highTable + index, context);
        if (length === undefined || low === undefined || high === undefined) {
          break;
        }
        if (length === 0) {
          break;
        }
        const pointer = low | (high << 8);
        const filename = decodeLoaderFilename(pointer, length, context);
        if (!filename) {
          break;
        }
        names.add(filename);
      }
      continue;
    }

    const regValues = new Map<string, number>();
    let cursor = callAddress;
    for (let steps = 0; steps < 8; steps += 1) {
      const prev = previousInstructionAt(cursor, context);
      if (!prev) {
        break;
      }
      if (
        (prev.mnemonic === "lda" || prev.mnemonic === "ldx" || prev.mnemonic === "ldy") &&
        prev.addressingMode === "imm" &&
        prev.operandValue !== undefined
      ) {
        regValues.set(prev.mnemonic[2]!.toUpperCase(), prev.operandValue);
      }
      cursor = prev.address;
    }
    const length = regValues.get("A");
    const low = regValues.get("X");
    const high = regValues.get("Y");
    if (length !== undefined && low !== undefined && high !== undefined) {
      const filename = decodeLoaderFilename(low | (high << 8), length, context);
      if (filename) {
        names.add(filename);
      }
    }
  }
  return Array.from(names).sort();
}

function inferSegmentPurpose(segment: Segment, context: RenderAnalysisContext): string[] {
  const notes: string[] = [];
  const instructions = segmentInstructions(segment, context);
  const splitFacts = factInRange(segment, context.splitPointerFacts);
  const copyFacts = factInRange(segment, context.copyFacts);
  const displayTransfers = displayTransfersForSegment(segment, context);
  const displayState = displayStateForSegment(segment, context);
  const hardwareTargets = summarizeHardwareTargets(segment, context);
  const pointerTargets = segmentPointerTargets(segment, context);
  const vicTargets = inferVicTargetsFromHardware(context);
  const kernalLoader = findKernalLoaderCallSequence(segment, context);
  const loaderFilenames = kernalLoader ? inferLoaderFilenameCandidates(segment, kernalLoader.setnamAddress, context) : [];
  const hasBitmapTarget = pointerTargets.some((target) => vicTargets.bitmapAddresses.includes(target));
  const hasScreenTarget = pointerTargets.some((target) => vicTargets.screenAddresses.includes(target));
  const hasColorTarget = pointerTargets.some((target) => target >= 0xd800 && target <= 0xdbff);

  if (kernalLoader) {
    notes.push("likely disk loader wrapper via KERNAL SETNAM/SETLFS/LOAD");
    if (loaderFilenames.length > 0) {
      notes.push(`loads disk files such as ${loaderFilenames.slice(0, 6).map((name) => `"${name}"`).join(", ")}`);
    }
  }
  if (instructions.some((instruction) => instruction.mnemonic === "jmp" && instruction.targetAddress === 0x0100)) {
    notes.push("likely external dispatch / returns control to resident loader or menu");
  }
  if (
    instructions.some((instruction) => instruction.mnemonic.startsWith("st") && instruction.targetAddress === 0xde00) &&
    instructions.some((instruction) => instruction.mnemonic.startsWith("st") && instruction.targetAddress === 0xd418)
  ) {
    notes.push("likely cartridge-backed digi playback path");
  }
  if (splitFacts.some((fact) => classifySplitPointerFact(fact) === "screen_row_table")) {
    notes.push("likely row-based screen update or renderer helper");
  }
  if (splitFacts.some((fact) => classifySplitPointerFact(fact) === "jump_dispatch_table")) {
    notes.push("likely state/command dispatcher using indirect JMP");
  }
  if (writesSpriteSeedTables(segment, context) && !isSpriteUploadSegment(segment, context)) {
    notes.push("prepares sprite state tables that are later uploaded into VIC sprite registers");
  }
  if (isSpriteUploadSegment(segment, context)) {
    notes.push("uploads sprite X/Y/color state and sprite-pointer bytes into the active VIC bank");
  }
  if (displayTransfers.length >= 3) {
    notes.push("likely stages one full display phase from source assets into bitmap/screen/color targets");
  } else if (displayTransfers.length > 0) {
    notes.push("likely stages display assets into active VIC memory");
  }
  if (hasBitmapTarget && hasScreenTarget && hasColorTarget) {
    notes.push("likely uploads a full bitmap + screen + color triplet for one splash/image phase");
  } else if (hasScreenTarget && hasColorTarget) {
    notes.push("likely uploads screen matrix plus color RAM for a display phase");
  }
  if (copyFacts.some((fact) => fact.destinationBases.some((base) => base >= 0xc000 && base <= 0xc7ff))) {
    notes.push("moves or fills visible screen-space data");
  }
  if (hasDisplayDisablePattern(segment, context)) {
    notes.push("temporarily blanks the display while reconfiguring VIC state or uploading assets");
  }
  if (
    hardwareTargets.some((target) => target === "$D011" || target === "$D016" || target === "$D018" || target === "$DD00") &&
    segment.start < 0x1000
  ) {
    notes.push("display / VIC initialisation path");
  }
  if (displayState?.bitmapModeEnabled && displayState.bitmapAddress !== undefined && displayTransfers.length > 0) {
    notes.push("active display state is already configured before the transfer sequence starts");
  }
  return notes.slice(0, 3);
}

function renderSegmentContext(segment: Segment, context: RenderAnalysisContext): string[] {
  if (!(segment.kind === "code" || segment.kind === "basic_stub")) {
    return [];
  }

  const lines: string[] = [];
  const purpose = inferSegmentPurpose(segment, context);
  const ram = summarizeRamTouches(segment, context);
  const splitFacts = factInRange(segment, context.splitPointerFacts);
  const copyFacts = factInRange(segment, context.copyFacts);
  const displayState = displayStateForSegment(segment, context);
  const displayTransfers = displayTransfersForSegment(segment, context);
  const spritePointerSeeds = summarizeSpritePointerSeeds(segment, context);
  const spriteStateTables = summarizeSpriteStateTables(segment, context);
  const spritePageSelection = spritePointerPageSelection(segment, context);
  const hardware = summarizeHardwareTargets(segment, context);
  const kernalLoader = findKernalLoaderCallSequence(segment, context);
  const loaderFilenames = kernalLoader ? inferLoaderFilenameCandidates(segment, kernalLoader.setnamAddress, context) : [];
  const pointerTargets = segmentPointerTargets(segment, context);
  const vicTargets = inferVicTargetsFromHardware(context);

  if (
    purpose.length === 0 &&
    ram.length === 0 &&
    splitFacts.length === 0 &&
    copyFacts.length === 0 &&
    displayTransfers.length === 0 &&
    hardware.length === 0 &&
    !displayState
  ) {
    return lines;
  }

  lines.push("// ROUTINE CONTEXT");
  for (const note of purpose) {
    lines.push(`// likely: ${note}`);
  }
  if (ram.length > 0) {
    lines.push(`// key RAM: ${ram.join(", ")}`);
  }
  if (splitFacts.length > 0) {
    const tables = splitFacts
      .slice(0, 4)
      .map((fact) => `${formatAddress(fact.lowTableBase)}/${formatAddress(fact.highTableBase)} -> ${classifySplitPointerFact(fact)}`);
    lines.push(`// split tables: ${tables.join("; ")}`);
  }
  if (displayState) {
    lines.push(`// display state: ${formatDisplayState(displayState)}`);
  }
  const assetTargets = pointerTargets
    .map((target) => {
      if (vicTargets.bitmapAddresses.includes(target)) {
        return `${formatAddress(target)}(bitmap)`;
      }
      if (vicTargets.screenAddresses.includes(target)) {
        return `${formatAddress(target)}(screen)`;
      }
      if (vicTargets.charsetAddresses.includes(target)) {
        return `${formatAddress(target)}(charset)`;
      }
      if (target >= 0xd800 && target <= 0xdbff) {
        return `${formatAddress(target)}(color)`;
      }
      return undefined;
    })
    .filter((target): target is string => target !== undefined)
    .filter((target, index, items) => items.indexOf(target) === index);
  if (assetTargets.length > 0) {
    lines.push(`// asset targets: ${assetTargets.join(", ")}`);
  }
  if (copyFacts.length > 0) {
    const copies = copyFacts
      .slice(0, 3)
      .map((fact) =>
        `${fact.mode} ${fact.destinationBases.slice(0, 2).map(formatAddress).join(", ")} via ${fact.indexRegister.toUpperCase()}`,
      );
    lines.push(`// data movement: ${copies.join("; ")}`);
  }
  if (displayTransfers.length > 0) {
    lines.push(`// display transfers: ${displayTransfers.slice(0, 4).map(formatDisplayTransfer).join("; ")}`);
  }
  if (spritePointerSeeds.length > 0) {
    lines.push(`// sprite pointers: ${spritePointerSeeds.join("; ")}`);
  }
  if (spriteStateTables.length > 0) {
    lines.push(`// sprite tables: ${spriteStateTables.join("; ")}`);
  }
  if (spritePageSelection) {
    lines.push(`// sprite pointer page: ${spritePageSelection}`);
  }
  if (hardware.length > 0) {
    lines.push(`// hardware touched: ${hardware.join(", ")}`);
  }
  if (kernalLoader) {
    lines.push(
      `// kernal loader path: SETNAM @ ${formatAddress(kernalLoader.setnamAddress)}, SETLFS @ ${formatAddress(kernalLoader.setlfsAddress)}, LOAD @ ${formatAddress(kernalLoader.loadAddress)}`,
    );
    if (loaderFilenames.length > 0) {
      lines.push(`// loader file names: ${loaderFilenames.map((name) => `"${name}"`).join(", ")}`);
    }
  }
  return lines;
}

function segmentHeader(segment: Segment, context?: RenderAnalysisContext): string[] {
  // Check for annotation override
  const annotation = context?.annotations?.segmentsByStart.get(segment.start);
  const displayKind = annotation?.kind ?? segment.kind;
  const confidence = segment.score.confidence.toFixed(2);
  const analyzers = annotation
    ? [...segment.analyzerIds, "llm-annotation"].join(",")
    : segment.analyzerIds.join(",");
  const lines: string[] = [];

  // Add annotation block comment if present
  if (annotation?.comment) {
    const label = annotation.label ?? displayKind;
    lines.push(`/* ═══════════════════════════════════════════════════════════════`);
    lines.push(` * ${label.toUpperCase()} (${formatAddress(segment.start)}-${formatAddress(segment.end)})`);
    for (const commentLine of annotation.comment.split("\n")) {
      lines.push(` * ${commentLine}`);
    }
    lines.push(` * ═══════════════════════════════════════════════════════════════ */`);
  }

  // Add routine annotation if this address has one
  const routineAnnotation = context?.annotations?.routinesByAddress.get(segment.start);
  if (routineAnnotation && !annotation?.comment) {
    lines.push(`/* ═══════════════════════════════════════════════════════════════`);
    lines.push(` * ${routineAnnotation.name.toUpperCase()}`);
    for (const commentLine of routineAnnotation.comment.split("\n")) {
      lines.push(` * ${commentLine}`);
    }
    lines.push(` * ═══════════════════════════════════════════════════════════════ */`);
  }

  lines.push(
    `// SEGMENT ${formatAddress(segment.start)}-${formatAddress(segment.end)}  ${displayKind}  confidence=${confidence}  analyzers=${analyzers}`,
  );

  const reclassified = annotation !== undefined && displayKind !== segment.kind;

  if (reclassified) {
    lines.push(`// Reclassified from ${segment.kind} by semantic analysis.`);
  }

  // When reclassified, suppress the old analyzer's reasons and preview — they describe the wrong type
  if (!reclassified && segment.score.reasons.length > 0) {
    lines.push(`// ${segment.score.reasons[0]}`);
  }

  if (!reclassified && segment.kind === "code" && segment.analyzerIds.includes("probable-code") && !segment.analyzerIds.includes("code")) {
    lines.push("// probable code island: structured routine, but not yet reached from trusted entry points");
  }

  if (!reclassified) {
    const previewLines = segment.preview?.[0]?.lines?.slice(0, 2) ?? [];
    for (const preview of previewLines) {
      lines.push(`// ${preview}`);
    }
  }

  if (context) {
    lines.push(...renderSegmentContext(segment, context));
  }

  return lines;
}

function renderCopyFact(fact: CopyRoutineFact): string {
  const dest = fact.destinationBases.slice(0, 4).map(formatAddress).join(", ");
  const moreDest = fact.destinationBases.length > 4 ? ", ..." : "";
  if (fact.mode === "fill") {
    const value = fact.fillValue === undefined ? "dynamic" : `#$${formatHex8(fact.fillValue)}`;
    return `// SEMANTICS fill-loop -> ${dest}${moreDest} value=${value} via ${fact.indexRegister.toUpperCase()}`;
  }
  const src = fact.sourceBases.slice(0, 4).map(formatAddress).join(", ");
  const moreSrc = fact.sourceBases.length > 4 ? ", ..." : "";
  return `// SEMANTICS copy-loop ${src || "dynamic source"}${moreSrc ? moreSrc : ""} -> ${dest}${moreDest} via ${fact.indexRegister.toUpperCase()}`;
}

function renderPointerFact(fact: IndirectPointerConstructionFact): string {
  const zpLow = `$${formatHex8(fact.zeroPageBase)}`;
  const zpHigh = `$${formatHex8((fact.zeroPageBase + 1) & 0xff)}`;
  if (fact.constantTarget !== undefined) {
    return `// SEMANTICS zp-pointer ${zpLow}/${zpHigh} := ${formatAddress(fact.constantTarget)}`;
  }
  return `// SEMANTICS zp-pointer ${zpLow}/${zpHigh} built dynamically`;
}

function renderTableFact(fact: TableUsageFact): string {
  const bases = fact.tableBases.slice(0, 4).map(formatAddress).join(", ");
  const suffix = fact.tableBases.length > 4 ? ", ..." : "";
  return `// SEMANTICS table-${fact.operation} ${bases}${suffix} indexed by ${fact.indexRegister.toUpperCase()}`;
}

function renderDisplayTransferFact(fact: DisplayTransferFact): string {
  const helper = fact.helperRoutine !== undefined ? ` via ${formatAddress(fact.helperRoutine)}` : "";
  const role = fact.role === "unknown" ? "display-data" : fact.role;
  return `// DISPLAY TRANSFER ${formatAddress(fact.sourceAddress)} -> ${formatAddress(fact.destinationAddress)} (${role}${helper})`;
}

function emitByteRange(
  data: Buffer,
  loadAddress: number,
  start: number,
  end: number,
  lines: string[],
  analysis?: Pick<RenderAnalysisContext, "labelSet" | "xrefsByTarget">,
  suppressStartLabel = false,
): void {
  let address = start;
  while (address <= end) {
    if (analysis && analysis.labelSet.has(address) && !(suppressStartLabel && address === start)) {
      lines.push(`${makeLabel(address)}:${labelCommentTextFromAnalysis(address, analysis.xrefsByTarget)}`);
    }

    let chunkEnd = Math.min(end, address + 15);
    if (analysis) {
      for (let probe = address + 1; probe <= chunkEnd; probe += 1) {
        if (analysis.labelSet.has(probe)) {
          chunkEnd = probe - 1;
          break;
        }
      }
    }

    const offset = address - loadAddress;
    const chunkLength = chunkEnd - address + 1;
    const bytes = Array.from(data.subarray(offset, offset + chunkLength)).map((value) => `$${formatHex8(value)}`);
    lines.push(`      .byte ${bytes.join(", ")}`);
    address += chunkLength;
  }
}

function emitPointerTableSegment(
  prg: PrgImage,
  segment: Segment,
  lines: string[],
  analysis: RenderAnalysisContext,
): void {
  let address = segment.start;
  while (address + 1 <= segment.end) {
    if (analysis.labelSet.has(address) && address !== segment.start) {
      lines.push(`${makeLabel(address)}:${labelCommentTextFromAnalysis(address, analysis.xrefsByTarget)}`);
    }
    const offset = address - prg.loadAddress;
    const lo = prg.data[offset];
    const hi = prg.data[offset + 1];
    if (lo === undefined || hi === undefined) break;
    const target = (hi << 8) | lo;
    const expr = findOperandExpression(target, analysis.labelSet, analysis.instructionOwnerByAddress, analysis.segmentOwnerByAddress)
      ?? `$${formatHex16(target)}`;
    lines.push(`      .word ${expr}`);
    address += 2;
  }
  if (address <= segment.end) {
    emitByteRange(prg.data, prg.loadAddress, address, segment.end, lines, analysis, true);
  }
}

function canRenderAsKickAsmText(bytes: number[]): boolean {
  return bytes.every((value) => value >= 0x20 && value <= 0x7e);
}

function escapeKickAsmText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

// Spec 019 Bug 8: render PETSCII spans as `.byte` lists with an inline
// ASCII comment instead of `.text`. KickAssembler `.text` translates
// PETSCII to screen-codes by default, which silently breaks byte-identity
// for PRGs that store raw PETSCII (CHROUT-style print routines). `.byte`
// always rebuilds byte-identical; the inline comment preserves human
// readability. Annotation-driven `.text` rendering can be reintroduced
// later via an explicit override that also emits a KickAss `.encoding`
// directive.
function emitPetsciiTextSegment(prg: PrgImage, segment: Segment, lines: string[]): void {
  const offset = segment.start - prg.loadAddress;
  const bytes = Array.from(prg.data.subarray(offset, offset + segment.length));
  emitBytesWithAsciiComment(bytes, lines);
}

function emitBytesWithAsciiComment(bytes: number[], lines: string[]): void {
  const chunkSize = 16;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.slice(index, index + chunkSize);
    const hex = chunk.map((value) => `$${formatHex8(value)}`).join(", ");
    const ascii = chunk
      .map((value) => (value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : "."))
      .join("");
    lines.push(`      .byte ${hex.padEnd(16 * 5)} // "${ascii.replace(/"/g, '\\"')}"`);
  }
}

function spriteRowComment(bytes: number[]): string {
  return bytes
    .map((value) => {
      let bits = "";
      for (let bit = 7; bit >= 0; bit -= 1) {
        bits += (value & (1 << bit)) !== 0 ? "#" : ".";
      }
      return bits;
    })
    .join("");
}

function emitSpriteSegment(prg: PrgImage, segment: Segment, lines: string[]): void {
  const totalLength = segment.end - segment.start + 1;
  const fullBlocks = Math.floor(totalLength / 64);
  let address = segment.start;

  for (let blockIndex = 0; blockIndex < fullBlocks; blockIndex += 1) {
    const blockAddress = address;
    lines.push(`// SPRITE ${blockIndex} @ ${formatAddress(blockAddress)}`);
    for (let row = 0; row < 21; row += 1) {
      const offset = blockAddress - prg.loadAddress + row * 3;
      const rowBytes = Array.from(prg.data.subarray(offset, offset + 3));
      const rendered = rowBytes.map((value) => `$${formatHex8(value)}`).join(", ");
      lines.push(`      .byte ${rendered.padEnd(14)} // row ${row.toString().padStart(2, "0")}  ${spriteRowComment(rowBytes)}`);
    }
    const paddingOffset = blockAddress - prg.loadAddress + 63;
    const padding = prg.data[paddingOffset] ?? 0;
    lines.push(`      .byte $${formatHex8(padding)}             // pad`);
    lines.push("");
    address += 64;
  }

  if (address <= segment.end) {
    lines.push(`// sprite remainder ${formatAddress(address)}-${formatAddress(segment.end)}`);
    emitByteRange(prg.data, prg.loadAddress, address, segment.end, lines);
  }
}

function renderAnalysisPreface(context: RenderAnalysisContext): string[] {
  const lines: string[] = [];
  const earlySegments = context.segments.slice(0, 20);
  const importantAssets = context.segments.filter((segment) =>
    segment.kind === "bitmap_source" ||
    segment.kind === "screen_source" ||
    segment.kind === "color_source" ||
    segment.kind === "charset_source" ||
    segment.kind === "hires_bitmap" ||
    segment.kind === "multicolor_bitmap" ||
    segment.kind === "screen_ram" ||
    segment.kind === "petscii_text",
  );
  const entryPoints = context.report.entryPoints.map((entryPoint) => `${formatAddress(entryPoint.address)} (${entryPoint.source})`);
  const remainingCount = Math.max(0, context.segments.length - earlySegments.length);

  lines.push("/*");
  lines.push("Working map");
  lines.push("");
  if (entryPoints.length > 0) {
    lines.push(`Entry points: ${entryPoints.join(", ")}`);
    lines.push("");
  }
  lines.push("Early / structural segments");
  for (const segment of earlySegments) {
    lines.push(`${formatAddress(segment.start)}-${formatAddress(segment.end)}  ${segment.kind}`);
  }
  lines.push("");
  if (remainingCount > 0) {
    lines.push(`... ${remainingCount} more segments omitted in this header view`);
    lines.push("");
  }
  if (importantAssets.length > 0) {
    lines.push("Key asset-like regions");
    for (const segment of importantAssets.slice(0, 12)) {
      lines.push(`${formatAddress(segment.start)}-${formatAddress(segment.end)}  ${segment.kind}`);
    }
    if (importantAssets.length > 12) {
      lines.push(`... ${importantAssets.length - 12} more asset-like regions omitted`);
    }
    lines.push("");
  }
  lines.push("Companion reports");
  lines.push("  analysis/.../RAM_STATE_FACTS.md");
  lines.push("  analysis/.../POINTER_TABLE_FACTS.md");
  lines.push("*/");
  lines.push("");
  return lines;
}

function renderAddressAliasLabels(context: RenderAnalysisContext, prg: PrgImage): string[] {
  const lines: string[] = [];
  const codeLikeSegments = buildAnnotatedSegments(context.segments, context.annotations?.segmentAnnotations)
    .filter((segment) => segment.kind === "code" || segment.kind === "basic_stub");
  const instructionStarts = new Set<number>();
  for (const segment of codeLikeSegments) {
    let address = segment.start;
    while (address <= segment.end) {
      const instruction = context.instructions.get(address) ?? decodeInstructionFactAtAddress(prg, address);
      if (!instruction) {
        address += 1;
        continue;
      }
      instructionStarts.add(instruction.address);
      address += instruction.size;
    }
  }
  const segmentStarts = new Set(codeLikeSegments.map((segment) => segment.start));
  const aliasAddresses = Array.from(context.labelSet)
    .filter((address) =>
      codeLikeSegments.some((segment) => address >= segment.start && address <= segment.end) &&
      !segmentStarts.has(address) &&
      !instructionStarts.has(address) &&
      !context.instructionOwnerByAddress.has(address),
    )
    .sort((left, right) => left - right);

  if (aliasAddresses.length === 0) {
    return lines;
  }

  lines.push("// Address aliases for labels that point into operand/data bytes inside decoded code segments");
  for (const address of aliasAddresses) {
    lines.push(`      .label ${makeLabel(address)} = ${formatAddress(address)}`);
  }
  lines.push("");
  return lines;
}

function renderCodeSegment(
  segment: Segment,
  prg: PrgImage,
  context: RenderAnalysisContext,
  lines: string[],
): void {
  let address = segment.start;
  let prevInstruction: InstructionFact | undefined;
  while (address <= segment.end) {
    const instruction = context.instructions.get(address) ?? decodeInstructionFactAtAddress(prg, address);
    if (!instruction) {
      emitByteRange(prg.data, prg.loadAddress, address, address, lines);
      address += 1;
      continue;
    }

    if (context.labelSet.has(instruction.address)) {
      lines.push(`${makeLabel(instruction.address)}:${labelCommentTextFromAnalysis(instruction.address, context.xrefsByTarget)}`);
    }
    for (const fact of context.copyFactsByStart.get(instruction.address) ?? []) {
      lines.push(renderCopyFact(fact));
    }
    for (const fact of context.pointerFactsByStart.get(instruction.address) ?? []) {
      lines.push(renderPointerFact(fact));
    }
    for (const fact of context.tableFactsByStart.get(instruction.address) ?? []) {
      lines.push(renderTableFact(fact));
    }
    for (const fact of context.displayTransfersByStart.get(instruction.address) ?? []) {
      lines.push(renderDisplayTransferFact(fact));
    }

    let asm: string;
    let targetComment: string;
    if (requiresUndocumentedByteRendering(instruction)) {
      const rendered = renderUndocumentedInstructionBytes(instruction);
      asm = rendered.asm;
      targetComment = rendered.comment;
    } else if (requiresExactWidthRendering(instruction)) {
      const rendered = renderInstructionBytesWithDecodedComment(
        instruction,
        context.labelSet,
        context.instructionOwnerByAddress,
        context.segmentOwnerByAddress,
      );
      asm = rendered.asm;
      targetComment = rendered.comment;
    } else {
      const operand = operandTextFromFact(
        instruction,
        context.labelSet,
        context.instructionOwnerByAddress,
        context.segmentOwnerByAddress,
        context.operandOverrides.get(instruction.address),
      );
      asm = operand ? `${instruction.mnemonic.padEnd(5)}${operand}` : instruction.mnemonic;
      targetComment = generateInstructionComment(instruction, prevInstruction, context);
      // Fall back to simple IO comment if generator returned empty
      if (!targetComment) {
        targetComment = commentTextFromTarget(instruction.targetAddress);
      }
    }
    const probableComment =
      instruction.provenance === "probable_code" && !targetComment ? "// probable code" : instruction.provenance === "probable_code" ? `${targetComment} | probable code` : targetComment;
    lines.push(`      ${asm.padEnd(34)}${probableComment}`.trimEnd());

    if (instruction.mnemonic === "jmp" || instruction.mnemonic === "rts" || instruction.mnemonic === "rti") {
      lines.push("");
    }

    prevInstruction = instruction;
    address += instruction.size;
  }
}

function renderWithAnalysis(prg: PrgImage, analysis: RenderAnalysisContext, lines: string[]): void {
  lines.push(...renderAnalysisPreface(analysis));
  for (const segment of buildAnnotatedSegments(analysis.segments, analysis.annotations?.segmentAnnotations)) {
    lines.push(...segmentHeader(segment, analysis));

    if (!(segment.kind === "code" || segment.kind === "basic_stub") && analysis.labelSet.has(segment.start)) {
      lines.push(`${makeLabel(segment.start)}:${labelCommentTextFromAnalysis(segment.start, analysis.xrefsByTarget)}`);
    }

    if (segment.kind === "code" || segment.kind === "basic_stub") {
      renderCodeSegment(segment, prg, analysis, lines);
    } else if (segment.kind === "petscii_text") {
      const hasInteriorLabels = Array.from(analysis.labelSet).some((address) => address > segment.start && address <= segment.end);
      if (hasInteriorLabels) {
        emitByteRange(prg.data, prg.loadAddress, segment.start, segment.end, lines, analysis, true);
      } else {
        emitPetsciiTextSegment(prg, segment, lines);
      }
    } else if (segment.kind === "sprite") {
      // If annotation reclassifies this segment, render as plain bytes instead of sprite art
      const annotationOverride = analysis.annotations?.segmentsByStart.get(segment.start);
      const effectiveKind = annotationOverride?.kind ?? segment.kind;
      const hasInteriorLabels = Array.from(analysis.labelSet).some((address) => address > segment.start && address <= segment.end);
      if (effectiveKind !== "sprite" || hasInteriorLabels) {
        emitByteRange(prg.data, prg.loadAddress, segment.start, segment.end, lines, analysis, true);
      } else {
        emitSpriteSegment(prg, segment, lines);
      }
    } else if (segment.kind === "pointer_table") {
      emitPointerTableSegment(prg, segment, lines, analysis);
    } else {
      emitByteRange(prg.data, prg.loadAddress, segment.start, segment.end, lines, analysis, true);
    }

    lines.push("");
  }
}

function renderLegacy(prg: PrgImage, entryPoints: number[], lines: string[]): void {
  const instructions = decodeLinear(prg.loadAddress, prg.data);
  const index = buildInstructionIndex(instructions);
  const labels = collectLabels(instructions, index, entryPoints);
  const xrefs = collectCrossReferences(instructions, labels, index);
  const ownerByAddress = new Map<number, number>();
  for (const instruction of instructions) {
    for (let offset = 0; offset < instruction.size; offset += 1) {
      ownerByAddress.set(instruction.address + offset, instruction.address);
    }
  }

  for (const instruction of instructions) {
    if (labels.has(instruction.address)) {
      lines.push(`${makeLabel(instruction.address)}:${labelCommentText(instruction.address, xrefs)}`);
    }

    const asm = instruction.isUnknown
      ? `.byte $${formatHex8(instruction.bytes[0])}`
      : (() => {
          if (requiresUndocumentedByteRendering(instruction)) {
            return renderUndocumentedInstructionBytes(instruction).asm;
          }
          const operand = operandTextFromFact(
            {
              addressingMode: instruction.mode,
              operandValue: instruction.operand,
              targetAddress: instruction.targetAddress,
            },
            labels,
            ownerByAddress,
            ownerByAddress,
          );
          return operand ? `${instruction.mnemonic.padEnd(5)}${operand}` : instruction.mnemonic;
        })();
    const comment = instruction.isUnknown
      ? ""
      : requiresUndocumentedByteRendering(instruction)
        ? renderUndocumentedInstructionBytes(instruction).comment
        : commentTextFromTarget(instruction.targetAddress);
    lines.push(`      ${asm.padEnd(34)}${comment}`.trimEnd());

    if (!instruction.isUnknown && (instruction.mnemonic === "jmp" || instruction.mnemonic === "rts" || instruction.mnemonic === "rti")) {
      lines.push("");
    }
  }
}

export function disassemblePrgToKickAsm(prgPath: string, outputPath: string, options: PrgDisasmOptions = {}): void {
  // Spec 048: set per-render platform override. Default c64.
  activePlatform = options.platform ?? "c64";
  const resolvedPrgPath = resolve(prgPath);
  const prg = readPrg(resolvedPrgPath);
  const analysisReport = maybeLoadAnalysis(resolvedPrgPath, options.analysisPath);
  const analysisContext = analysisReport ? buildAnalysisContext(analysisReport, prg) : undefined;

  // Load semantic annotations if available
  // Search for annotations next to the PRG, next to the output ASM, and next to the analysis JSON
  const annotationsFile = loadAnnotations(resolvedPrgPath)
    ?? (outputPath ? loadAnnotations(resolve(outputPath)) : undefined)
    ?? (options.analysisPath ? loadAnnotations(resolve(options.analysisPath)) : undefined);
  if (annotationsFile && analysisContext) {
    analysisContext.annotations = buildAnnotationsIndex(annotationsFile);
    applyAnnotationSegmentSplits(analysisContext);
    applyAnnotationDataTables(analysisContext, prg);
  }
  activeAnnotations = analysisContext?.annotations;

  if (analysisContext) {
    applyKernalAbiOperandOverrides(analysisContext);
    applyZpPointerSetupOverrides(analysisContext);
    applyAnnotationImmediateOverrides(analysisContext);
  }

  const packerHints = analysisReport?.packerHints ?? [];
  const lines: string[] = [
    "//****************************",
    "//  TRXDis ASM",
    "//  ",
    "//  Source in KickAssembler format",
    analysisContext ? "//  Analysis-driven rendering enabled" : "//  Legacy linear rendering",
    annotationsFile ? "//  Semantic annotations applied" : "//  No semantic annotations found",
  ];
  if (packerHints.length > 0) {
    lines.push("//  ");
    lines.push("//  WARNING: input looks compressed — disassembly is of the packed payload, not real code");
    for (const hint of packerHints) {
      lines.push(`//    PACKER: ${hint.format} (conf=${hint.confidence.toFixed(2)})${hint.unpackedSize !== undefined ? `, unpacked ≈ ${hint.unpackedSize} bytes` : ""}`);
    }
    lines.push("//  Run the matching depacker tool (e.g. depack_exomizer_sfx) and re-analyze the unpacked output.");
  }
  lines.push("//****************************");
  lines.push("");
  lines.push("      .cpu _6502");
  lines.push("");
  lines.push("");
  lines.push(`      .pc = $${formatHex16(prg.loadAddress)} "code"`);
  lines.push("");

  if (analysisContext) {
    lines.push(...renderAddressAliasLabels(analysisContext, prg));
    renderWithAnalysis(prg, analysisContext, lines);
  } else {
    renderLegacy(prg, options.entryPoints ?? [], lines);
  }

  activeAnnotations = undefined;
  const kickAsmOutput = `${lines.join("\n")}\n`;
  writeFileSync(outputPath, kickAsmOutput, "utf8");

  // Also emit 64tass version alongside the KickAssembler output
  const tassPath = outputPath.replace(/\.asm$/i, ".tass");
  if (tassPath !== outputPath) {
    writeFileSync(tassPath, convertKickAsmToTass(kickAsmOutput), "utf8");
  }
}
