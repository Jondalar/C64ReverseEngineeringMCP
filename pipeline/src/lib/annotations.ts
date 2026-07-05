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

// One annotation entry the loader could not apply (tolerant skip — the rest still
// apply). `hint` names the likely fix (e.g. a mistyped field key) so the drop is
// actionable in the tool output instead of silently lost.
export interface SkippedAnnotation {
  section: "segment" | "label" | "routine" | "pointerTable" | "jumpTable" | "immediate";
  reason: string;
  hint?: string;
}

export interface AnnotationsIndex {
  segmentsByStart: Map<number, SegmentAnnotation>;
  segmentAnnotations: Array<{ start: number; end: number; annotation: SegmentAnnotation }>;
  labelsByAddress: Map<number, LabelAnnotation>;
  routinesByAddress: Map<number, RoutineAnnotation>;
  pointerTables: PointerTableIndexEntry[];
  jumpTables: JumpTableIndexEntry[];
  immediatesByAddress: Map<number, ImmediateIndexEntry>;
  // Entries dropped during indexing (tolerant skip). Surfaced by disasm_prg so a
  // mistyped field key (`addr`/`name`) is visible, not silently lost.
  skipped: SkippedAnnotation[];
}

// Total (never throws): a manual annotation JSON may omit an address field, so
// `hex` can be undefined at runtime despite the type. Returns NaN on missing /
// unparseable input; callers skip that one entry (see buildAnnotationsIndex) so
// the remaining hand-written annotations still apply instead of the whole
// pipeline dying on `parseHex(undefined)`.
function parseHex(hex: string | undefined): number {
  return parseInt(String(hex ?? "").replace(/^\$/, ""), 16);
}

// When a required field is missing, look for a COMMON mistyped key on the raw entry
// (the analyst wrote `addr` for `address`, `name` for a label's `label`, etc.) and
// return a targeted "did you mean" hint. Returns undefined when nothing obvious.
function mistypedKeyHint(entry: unknown, expected: string, aliases: string[]): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const present = aliases.find((a) => a in (entry as Record<string, unknown>));
  if (present) return `field "${present}" should be "${expected}"`;
  return `missing "${expected}"`;
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
  const skipped: SkippedAnnotation[] = [];
  // Collect only; the caller (prg-disasm) prints one ordered summary so the drop is
  // visible in the disasm_prg tool output, not scattered across the pipeline log.
  const noteSkip = (s: SkippedAnnotation) => { skipped.push(s); };

  // Tolerant skip: a manual annotations JSON may omit a whole section (`?? []`) or a
  // required field per entry — the bad entry is dropped (recorded in `skipped`) and the
  // rest still apply, instead of the pipeline dying on `.segments is not iterable`.
  for (const seg of annotations.segments ?? []) {
    const start = parseHex(seg.start);
    const end = parseHex(seg.end);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      noteSkip({
        section: "segment",
        reason: `unparseable range start=${seg.start} end=${seg.end}`,
        hint: Number.isNaN(start) ? mistypedKeyHint(seg, "start", ["from", "begin", "addr", "address"]) : mistypedKeyHint(seg, "end", ["to", "stop"]),
      });
      continue;
    }
    segmentsByStart.set(start, seg);
    segmentAnnotations.push({ start, end, annotation: seg });
  }
  const usedLabels = new Set<string>();
  for (const lbl of annotations.labels ?? []) {
    const addr = parseHex(lbl.address);
    if (Number.isNaN(addr)) {
      noteSkip({
        section: "label",
        reason: `unparseable address=${lbl.address} (label=${lbl.label ?? "?"})`,
        hint: mistypedKeyHint(lbl, "address", ["addr", "offset", "pc"]),
      });
      continue;
    }
    if (!lbl.label) {
      noteSkip({ section: "label", reason: `address ${lbl.address} has no label`, hint: mistypedKeyHint(lbl, "label", ["name", "ident", "symbol"]) });
      continue;
    }
    labelsByAddress.set(addr, lbl);
    usedLabels.add(lbl.label);
  }
  for (const rt of annotations.routines ?? []) {
    const addr = parseHex(rt.address);
    if (Number.isNaN(addr)) {
      noteSkip({
        section: "routine",
        reason: `unparseable address=${rt.address} (name=${rt.name ?? "?"})`,
        hint: mistypedKeyHint(rt, "address", ["addr", "offset", "pc"]),
      });
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
      noteSkip({ section: "pointerTable", reason: `unparseable range start=${pt.start} end=${pt.end}` });
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
      noteSkip({ section: "jumpTable", reason: `unparseable range start=${jt.start} end=${jt.end}` });
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
      noteSkip({ section: "immediate", reason: `unparseable address=${imm.address}`, hint: mistypedKeyHint(imm, "address", ["addr", "offset", "pc"]) });
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
    skipped,
  };
}

// Normalize a hand-written annotations JSON into a safe shape: a non-object file or a
// missing required section (segments / labels / routines) is coerced to [] so the
// indexer never dies on `.labels is not iterable`. Individual bad ENTRIES are dropped
// later (tolerant skip, recorded in AnnotationsIndex.skipped).
function normalizeAnnotationsFile(raw: unknown): AnnotationsFile {
  const obj = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    version: typeof obj.version === "number" ? obj.version : 1,
    binary: typeof obj.binary === "string" ? obj.binary : "",
    segments: arr(obj.segments) as SegmentAnnotation[],
    labels: arr(obj.labels) as LabelAnnotation[],
    routines: arr(obj.routines) as RoutineAnnotation[],
    pointerTables: arr(obj.pointerTables) as PointerTableAnnotation[],
    jumpTables: arr(obj.jumpTables) as JumpTableAnnotation[],
    immediates: arr(obj.immediates) as ImmediateAnnotation[],
  };
}

export function loadAnnotations(prgPath: string, explicitPath?: string): AnnotationsFile | undefined {
  if (explicitPath) {
    const p = resolve(explicitPath);
    if (existsSync(p)) {
      return normalizeAnnotationsFile(JSON.parse(readFileSync(p, "utf8")));
    }
  }

  const parsed = parse(prgPath);
  const candidates = [
    resolve(dirname(prgPath), `${parsed.name}_annotations.json`),
    resolve(dirname(prgPath), "annotations.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return normalizeAnnotationsFile(JSON.parse(readFileSync(candidate, "utf8")));
    }
  }

  return undefined;
}
