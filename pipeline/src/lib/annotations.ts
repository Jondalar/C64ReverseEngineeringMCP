import { readFileSync, existsSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { SegmentKind } from "../analysis/types";

export interface SegmentAnnotation {
  start: string;        // hex address, e.g. "09A9"
  end: string;          // hex address, e.g. "09AA"
  kind: SegmentKind;    // reclassified segment type
  label?: string;       // semantic label, e.g. "sprite_scroller_flag"
  comment?: string;     // human-readable explanation
}

export interface LabelAnnotation {
  address: string;      // hex address
  label: string;        // semantic name, e.g. "main_entry"
  comment?: string;     // optional inline comment for the label
}

export type RegisterName = "a" | "x" | "y";

export type RegisterRole =
  | "length"
  | "device"
  | "logical"
  | "secondary"
  | "verify-flag"
  | "msg-flag"
  | "timeout-flag"
  | "byte"
  | "zp-pointer"
  | "row"
  | "column"
  | "carry-direction";

export interface PointerPairAnnotation {
  low: RegisterName;
  high: RegisterName;
}

export interface RoutineAbi {
  registers?: Partial<Record<RegisterName, RegisterRole>>;
  pointerPairs?: PointerPairAnnotation[];
}

export interface RoutineAnnotation {
  address: string;      // hex start address of routine
  name: string;         // descriptive routine name
  comment: string;      // what the routine does (block comment)
  abi?: RoutineAbi;     // calling convention used by pre-JSR immediate rewrite
}

export interface PointerTableAnnotation {
  start: string;        // hex start address
  end: string;          // hex end address (inclusive)
  stride?: 2;           // future: support 1-byte tables; default 2 (.word)
  endian?: "little" | "big"; // default little
  comment?: string;
}

export interface JumpTableAnnotation {
  start: string;
  end: string;
  kind: "jmp" | "jsr" | "word"; // jmp/jsr table = 3-byte rows, word = 2-byte rows
  comment?: string;
}

export type ImmediateRewriteKind = "lo-of" | "hi-of";

export interface ImmediateAnnotation {
  address: string;      // hex address of the lda/ldx/ldy #imm instruction
  kind: ImmediateRewriteKind;
  label: string;        // target label name (must exist in labels[] or be a known segment label)
  comment?: string;
}

export interface AnnotationsFile {
  version: number;
  binary: string;       // which PRG this annotates
  segments: SegmentAnnotation[];
  labels: LabelAnnotation[];
  routines: RoutineAnnotation[];
  pointerTables?: PointerTableAnnotation[];
  jumpTables?: JumpTableAnnotation[];
  immediates?: ImmediateAnnotation[];
}

export interface PointerTableIndexEntry {
  start: number;
  end: number;
  stride: number;
  endian: "little" | "big";
  annotation: PointerTableAnnotation;
}

export interface JumpTableIndexEntry {
  start: number;
  end: number;
  kind: JumpTableAnnotation["kind"];
  annotation: JumpTableAnnotation;
}

export interface ImmediateIndexEntry {
  address: number;
  kind: ImmediateRewriteKind;
  label: string;
  annotation: ImmediateAnnotation;
}

export interface AnnotationsIndex {
  segmentsByStart: Map<number, SegmentAnnotation>;
  segmentAnnotations: Array<{ start: number; end: number; annotation: SegmentAnnotation }>;
  labelsByAddress: Map<number, LabelAnnotation>;
  routinesByAddress: Map<number, RoutineAnnotation>;
  pointerTables: PointerTableIndexEntry[];
  jumpTables: JumpTableIndexEntry[];
  immediatesByAddress: Map<number, ImmediateIndexEntry>;
}

// Total (never throws): a manual annotation JSON may omit an address field, so
// `hex` can be undefined at runtime despite the type. Returns NaN on missing /
// unparseable input; callers skip that one entry (see buildAnnotationsIndex) so
// the remaining hand-written annotations still apply instead of the whole
// pipeline dying on `parseHex(undefined)`.
function parseHex(hex: string | undefined): number {
  return parseInt(String(hex ?? "").replace(/^\$/, ""), 16);
}

// A routine's `name` is descriptive prose ("Turn advance"); turn it into a valid
// 6502-assembler label identifier (`Turn_advance`) so promoting it to a label
// can't break the rebuild. Returns undefined if nothing usable remains.
function toLabelIdent(name: string): string | undefined {
  const s = name.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "_$1");
  return s.length ? s : undefined;
}

export function buildAnnotationsIndex(annotations: AnnotationsFile): AnnotationsIndex {
  const segmentsByStart = new Map<number, SegmentAnnotation>();
  const segmentAnnotations: Array<{ start: number; end: number; annotation: SegmentAnnotation }> = [];
  const labelsByAddress = new Map<number, LabelAnnotation>();
  const routinesByAddress = new Map<number, RoutineAnnotation>();
  const pointerTables: PointerTableIndexEntry[] = [];
  const jumpTables: JumpTableIndexEntry[] = [];
  const immediatesByAddress = new Map<number, ImmediateIndexEntry>();

  for (const seg of annotations.segments) {
    const start = parseHex(seg.start);
    const end = parseHex(seg.end);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      console.warn(`[annotations] skipping segment with unparseable range: start=${seg.start} end=${seg.end}`);
      continue;
    }
    segmentsByStart.set(start, seg);
    segmentAnnotations.push({ start, end, annotation: seg });
  }
  const usedLabels = new Set<string>();
  for (const lbl of annotations.labels) {
    const addr = parseHex(lbl.address);
    if (Number.isNaN(addr)) {
      console.warn(`[annotations] skipping label with unparseable address: ${lbl.address} (${lbl.label})`);
      continue;
    }
    labelsByAddress.set(addr, lbl);
    usedLabels.add(lbl.label);
  }
  for (const rt of annotations.routines) {
    const addr = parseHex(rt.address);
    if (Number.isNaN(addr)) {
      console.warn(`[annotations] skipping routine with unparseable address: ${rt.address} (${rt.name ?? "?"})`);
      continue;
    }
    routinesByAddress.set(addr, rt);
    // BUG-033 (secondary): a named routine RENAMES the auto-label (`WC000:` →
    // `turn_advance:`), matching reloc `subSegments[].label`. The descriptive name
    // is sanitised to a valid assembler identifier; rebuild stays byte-identical
    // (labels are symbolic). Explicit labels win (set first, above); collisions
    // (with an explicit label or another routine) keep the auto-label + the
    // routine's header comment block (no silent duplicate-label rebuild break).
    if (rt.name && !labelsByAddress.has(addr)) {
      const ident = toLabelIdent(rt.name);
      if (ident && !usedLabels.has(ident)) {
        labelsByAddress.set(addr, { address: rt.address, label: ident });
        usedLabels.add(ident);
      }
    }
  }
  for (const pt of annotations.pointerTables ?? []) {
    const start = parseHex(pt.start);
    const end = parseHex(pt.end);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      console.warn(`[annotations] skipping pointer-table with unparseable range: start=${pt.start} end=${pt.end}`);
      continue;
    }
    pointerTables.push({
      start,
      end,
      stride: pt.stride ?? 2,
      endian: pt.endian ?? "little",
      annotation: pt,
    });
  }
  for (const jt of annotations.jumpTables ?? []) {
    const start = parseHex(jt.start);
    const end = parseHex(jt.end);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      console.warn(`[annotations] skipping jump-table with unparseable range: start=${jt.start} end=${jt.end}`);
      continue;
    }
    jumpTables.push({
      start,
      end,
      kind: jt.kind,
      annotation: jt,
    });
  }
  for (const imm of annotations.immediates ?? []) {
    const address = parseHex(imm.address);
    if (Number.isNaN(address)) {
      console.warn(`[annotations] skipping immediate with unparseable address: ${imm.address}`);
      continue;
    }
    immediatesByAddress.set(address, {
      address,
      kind: imm.kind,
      label: imm.label,
      annotation: imm,
    });
  }

  segmentAnnotations.sort((left, right) => left.start - right.start || left.end - right.end);

  return {
    segmentsByStart,
    segmentAnnotations,
    labelsByAddress,
    routinesByAddress,
    pointerTables,
    jumpTables,
    immediatesByAddress,
  };
}

export function loadAnnotations(prgPath: string, explicitPath?: string): AnnotationsFile | undefined {
  if (explicitPath) {
    const p = resolve(explicitPath);
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf8")) as AnnotationsFile;
    }
  }

  const parsed = parse(prgPath);
  const candidates = [
    resolve(dirname(prgPath), `${parsed.name}_annotations.json`),
    resolve(dirname(prgPath), "annotations.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8")) as AnnotationsFile;
    }
  }

  return undefined;
}
