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

function parseHex(hex: string): number {
  return parseInt(hex.replace(/^\$/, ""), 16);
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
    segmentsByStart.set(start, seg);
    segmentAnnotations.push({ start, end, annotation: seg });
  }
  for (const lbl of annotations.labels) {
    labelsByAddress.set(parseHex(lbl.address), lbl);
  }
  for (const rt of annotations.routines) {
    routinesByAddress.set(parseHex(rt.address), rt);
  }
  for (const pt of annotations.pointerTables ?? []) {
    pointerTables.push({
      start: parseHex(pt.start),
      end: parseHex(pt.end),
      stride: pt.stride ?? 2,
      endian: pt.endian ?? "little",
      annotation: pt,
    });
  }
  for (const jt of annotations.jumpTables ?? []) {
    jumpTables.push({
      start: parseHex(jt.start),
      end: parseHex(jt.end),
      kind: jt.kind,
      annotation: jt,
    });
  }
  for (const imm of annotations.immediates ?? []) {
    const address = parseHex(imm.address);
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
