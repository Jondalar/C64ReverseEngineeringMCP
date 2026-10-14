import { readFileSync, existsSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { SegmentKind } from "../analysis/types";

export interface SegmentAnnotation {
  start: string;        // hex address, e.g. "09A9"
  end: string;          // hex address, e.g. "09AA"
  kind: SegmentKind;    // reclassified segment type
  label?: string;       // semantic label, e.g. "sprite_scroller_flag"
  comment?: string;     // human-readable explanation
  /**
   * Spec 842 — which address space `start`/`end` are in, when a `relocations`
   * entry covers them. A relocated byte genuinely has two addresses: where it is
   * STORED in the payload, and where it RUNS after the copy.
   *
   *   "runtime" (the default under a relocation) — the `.pseudopc` address. This is
   *     what a human reads off the listing, what a breakpoint takes, and what the
   *     graph is keyed on.
   *   "file" — the stored position in the PRG.
   *
   * Outside any relocation the two are identical and this field changes nothing.
   * Omitted, the space is INFERRED: a range inside a relocation's runtime window is
   * runtime, one inside the file image is file. State it explicitly when a value
   * could be read as either.
   */
  space?: "runtime" | "file";
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
  name: string;         // descriptive routine name — the one required field beside `address`
  /**
   * What the routine does, rendered as the block comment above it.
   *
   * OPTIONAL, and the type said `string` while the loader never checked it. A
   * `routines[]` entry carrying only an address and a name was accepted —
   * `[annotations] applied 81, skipped 0` — and then killed the renderer on
   * `comment.split("\n")`. A name without prose is a legitimate annotation: it
   * names the routine and renames its label, which is most of what a routine
   * entry is for. So the field is optional here and the renderer prints the
   * name header alone when it is absent. The graph importer already treated it
   * this way (`comment: … ? … : null`); this is the half that disagreed.
   */
  comment?: string;
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

/**
 * Two parallel one-byte tables, one holding the low bytes and one the high bytes of
 * `count` addresses (`LDA lo,X / STA zp / LDA hi,X / STA zp+1`). The interleaved
 * `pointerTables` cannot say this; without it the listing prints raw `.byte`s where
 * every entry has a target with a name.
 */
export interface SplitTableAnnotation {
  lo: string;           // hex address of the low-byte table
  hi: string;           // hex address of the high-byte table
  count?: number;       // entries; both tables are `count` bytes. Required unless `reject` is given.
  adjust?: number;      // stored = target - adjust. An RTS dispatch stores target-1, so adjust: 1. Default 0.
  base?: string;        // a name from labels[] / routines[] / a segment label: every entry renders as <(base+off) / >(base+off)
  comment?: string;
  reject?: string;      // "this is not a pointer table, because …" — closes the finding without declaring anything
}

export type ImmediateRewriteKind = "lo-of" | "hi-of";

export interface ImmediateAnnotation {
  address: string;      // hex address of the lda/ldx/ldy #imm instruction
  kind: ImmediateRewriteKind;
  label: string;        // target label name (must exist in labels[] or be a known segment label)
  comment?: string;
}

/**
 * What a stretch of the I/O window IS at run time, where the machine's default is not it.
 *
 * `$D000-$DFFF` is I/O while `$01` says so (the default) and RAM or character ROM otherwise; the
 * bytes cannot say which, because the banking is the program's state, not an operand. The project
 * declares it. `routines` limits the declaration to the code of those routines (a depacker that
 * writes under the I/O window with `$01` at `$34`): a routine is its entry address and everything
 * reachable from it by fall-through, branches and `jmp` — a `jsr` callee is its own routine.
 */
export interface MemoryMapAnnotation {
  start: string;        // hex address inside $D000-$DFFF
  end: string;          // hex address inside $D000-$DFFF, inclusive
  as: "io" | "ram" | "charrom";
  routines?: string[];  // hex entry addresses; absent = the declaration holds for the whole listing
}

export interface AnnotationsFile {
  version: number;
  binary: string;       // which PRG this annotates
  segments: SegmentAnnotation[];
  labels: LabelAnnotation[];
  routines: RoutineAnnotation[];
  pointerTables?: PointerTableAnnotation[];
  jumpTables?: JumpTableAnnotation[];
  splitTables?: SplitTableAnnotation[];
  immediates?: ImmediateAnnotation[];
  memoryMap?: MemoryMapAnnotation[];
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

export interface SplitTableIndexEntry {
  lo: number;
  hi: number;
  count: number;
  adjust: number;
  /** the name `base` carries, with the address the loader found it at */
  base?: { name: string; address: number };
  /** set = a rejection: it declares nothing and renders nothing */
  rejected?: string;
  annotation: SplitTableAnnotation;
}

export interface ImmediateIndexEntry {
  address: number;
  kind: ImmediateRewriteKind;
  label: string;
  annotation: ImmediateAnnotation;
}

export interface MemoryMapIndexEntry {
  start: number;
  end: number;
  as: MemoryMapAnnotation["as"];
  /** the entry addresses the declaration is limited to; empty = the whole listing */
  routines: number[];
}

// One annotation entry the loader could not apply (tolerant skip — the rest still
// apply). `hint` names the likely fix (e.g. a mistyped field key) so the drop is
// actionable in the tool output instead of silently lost.
export interface SkippedAnnotation {
  section: "segment" | "label" | "routine" | "pointerTable" | "jumpTable" | "splitTable" | "immediate" | "memoryMap";
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
  splitTables: SplitTableIndexEntry[];
  immediatesByAddress: Map<number, ImmediateIndexEntry>;
  /** Spec 908 D3 — what the project says $D000-$DFFF is at run time, in file order (a later entry wins where two overlap) */
  memoryMap: MemoryMapIndexEntry[];
  // Entries dropped during indexing (tolerant skip). Surfaced by disasm_prg so a
  // mistyped field key (`addr`/`name`) is visible, not silently lost.
  skipped: SkippedAnnotation[];
}

// Total (never throws): a manual annotation JSON may omit an address field, so
// `hex` can be undefined at runtime despite the type. Returns NaN on missing /
// unparseable input; callers skip that one entry (see buildAnnotationsIndex) so
// the remaining hand-written annotations still apply instead of the whole
// pipeline dying on `parseHex(undefined)`.
export function parseHex(hex: string | undefined): number {
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
  const splitTables: SplitTableIndexEntry[] = [];
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
    // Spec 833 §5c — an explicit label was the one population NOTHING guarded.
    // `usedLabels` protected routines (BUG-033) and, since 833 D2, segments;
    // two `labels[]` entries carrying the same name at different addresses both
    // got a definition, KickAssembler stopped at "already defined", and the
    // byte-identical rebuild this file exists to protect went red — with no
    // line anywhere saying why. It is the only defect in this family that fails
    // loudly in the assembler instead of quietly in the listing.
    //
    // First wins, in file order, and the loser is REPORTED: the tolerant-skip
    // summary is where a human already looks for "why did my annotation not
    // apply", and the address keeps its auto-label so the rebuild stays green.
    if (usedLabels.has(lbl.label)) {
      const firstAt = [...labelsByAddress.entries()].find(([, l]) => l.label === lbl.label)?.[0];
      noteSkip({
        section: "label",
        reason: `duplicate label name "${lbl.label}" at ${lbl.address}` +
          (firstAt !== undefined ? ` — already defined at $${firstAt.toString(16).toUpperCase().padStart(4, "0")}` : ""),
        hint: "two definitions of one identifier break the rebuild; the first wins and this address keeps its auto-label",
      });
      continue;
    }
    // The same ADDRESS twice used to let the last entry win silently, which is
    // the same defect with the operands swapped.
    const existing = labelsByAddress.get(addr);
    if (existing) {
      noteSkip({
        section: "label",
        reason: `address ${lbl.address} already labelled "${existing.label}" — "${lbl.label}" ignored`,
        hint: "one address carries one name; remove the duplicate entry",
      });
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
    // `name` is the one field a routine entry cannot do without: it is what the
    // header prints and what renames the label. The renderer used to reach for
    // `.name.toUpperCase()` on whatever the loader had stored, so an entry that
    // only carried an address crashed it in the same place a missing `comment`
    // did. Required here means reported here — by section, address and the key
    // that was probably meant.
    if (typeof rt.name !== "string" || rt.name.trim() === "") {
      noteSkip({
        section: "routine",
        reason: `routine at ${rt.address} has no name`,
        hint: mistypedKeyHint(rt, "name", ["label", "title", "ident", "symbol", "routine"]),
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
  // Spec 833 D2 — a segment annotation's label names the segment START, and
  // until now that name reached nothing: the segment loop above fills
  // `segmentsByStart` and `segmentAnnotations` only, so it never entered
  // `labelsByAddress` and `makeLabel` could not answer with it. The name existed
  // in the file, in the graph, and in the segment's block comment — and nowhere
  // in the listing, on the analysis path as much as the legacy one. The only
  // `labelsByAddress.set` for a segment start was `overlayRelocLabels`, which is
  // the relocation path.
  //
  // Precedence is the one that already exists here: an explicit label wins (set
  // first), then a routine (BUG-033 above), then a segment. Same collision rule
  // too — a duplicate identifier keeps the auto-label rather than minting a
  // second definition of the same name and breaking the rebuild. The segment's
  // `comment` is deliberately NOT carried onto the label: it is already rendered
  // as the segment's block comment, and it is free-form multi-line prose that
  // has no business on an inline label line.
  for (const { start, annotation } of segmentAnnotations) {
    if (!annotation.label || labelsByAddress.has(start)) continue;
    const ident = toLabelIdent(annotation.label);
    if (!ident || usedLabels.has(ident)) continue;
    labelsByAddress.set(start, { address: annotation.start, label: ident });
    usedLabels.add(ident);
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
  // A split table is validated as a whole file (`splitTableProblems`) and REFUSED there; what
  // reaches this loop is well-formed except for what only an index can answer, so an entry that
  // still fails (a name nothing defines) is skipped by name like every other section.
  for (const st of annotations.splitTables ?? []) {
    const lo = parseHex(st.lo);
    const hi = parseHex(st.hi);
    if (Number.isNaN(lo) || Number.isNaN(hi)) {
      noteSkip({ section: "splitTable", reason: `unparseable lo=${st.lo} hi=${st.hi}` });
      continue;
    }
    if (st.reject !== undefined) {
      if (typeof st.reject !== "string" || st.reject.trim() === "") { noteSkip({ section: "splitTable", reason: `$${hex4(lo)}/$${hex4(hi)}: reject is empty` }); continue; }
      splitTables.push({ lo, hi, count: 0, adjust: 0, rejected: st.reject.trim(), annotation: st });
      continue;
    }
    let base: SplitTableIndexEntry["base"];
    if (st.base !== undefined) {
      const named = [...labelsByAddress.entries()].find(([, l]) => l.label === st.base);
      const seg = segmentAnnotations.find((s) => s.annotation.label === st.base || (s.annotation.label && toLabelIdent(s.annotation.label) === st.base));
      const address = named?.[0] ?? seg?.start;
      if (address === undefined) {
        noteSkip({ section: "splitTable", reason: `$${hex4(lo)}/$${hex4(hi)}: base "${st.base}" names no label, routine or segment label in this file` });
        continue;
      }
      base = { name: named?.[1].label ?? toLabelIdent(st.base) ?? st.base, address };
    }
    splitTables.push({ lo, hi, count: st.count as number, adjust: st.adjust ?? 0, ...(base ? { base } : {}), annotation: st });
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
    splitTables,
    immediatesByAddress,
    memoryMap: indexMemoryMap(annotations.memoryMap, noteSkip),
    skipped,
  };
}

/** The I/O window: a `memoryMap` entry outside it declares nothing the listing could act on. */
const IO_WINDOW_FIRST = 0xd000;
const IO_WINDOW_LAST = 0xdfff;

function indexMemoryMap(entries: MemoryMapAnnotation[] | undefined, noteSkip: (s: SkippedAnnotation) => void): MemoryMapIndexEntry[] {
  const out: MemoryMapIndexEntry[] = [];
  for (const [i, entry] of (entries ?? []).entries()) {
    const start = parseHex(entry?.start);
    const end = parseHex(entry?.end);
    const where = `memoryMap[${i}]`;
    if (Number.isNaN(start) || Number.isNaN(end)) {
      noteSkip({ section: "memoryMap", reason: `${where}: unparseable range start=${entry?.start} end=${entry?.end}`, hint: mistypedKeyHint(entry, "start", ["from", "begin", "addr", "address"]) });
      continue;
    }
    if (end < start || start < IO_WINDOW_FIRST || end > IO_WINDOW_LAST) {
      noteSkip({ section: "memoryMap", reason: `${where}: $${start.toString(16).toUpperCase()}-$${end.toString(16).toUpperCase()} is not a range inside $D000-$DFFF`, hint: "memoryMap says what the I/O window is at run time; nothing outside it" });
      continue;
    }
    if (entry.as !== "io" && entry.as !== "ram" && entry.as !== "charrom") {
      noteSkip({ section: "memoryMap", reason: `${where}: as=${JSON.stringify(entry.as)}`, hint: 'as is "io", "ram" or "charrom"' });
      continue;
    }
    const routines: number[] = [];
    let bad = false;
    for (const r of entry.routines ?? []) {
      const address = parseHex(r);
      if (Number.isNaN(address)) { noteSkip({ section: "memoryMap", reason: `${where}: unparseable routine address ${JSON.stringify(r)}` }); bad = true; break; }
      routines.push(address & 0xffff);
    }
    if (bad) continue;
    out.push({ start, end, as: entry.as, routines });
  }
  return out;
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
    splitTables: arr(obj.splitTables) as SplitTableAnnotation[],
    immediates: arr(obj.immediates) as ImmediateAnnotation[],
    memoryMap: arr(obj.memoryMap) as MemoryMapAnnotation[],
  };
}

/**
 * The annotations file contradicts itself and nothing was rendered.
 *
 * Its own class so the CLI can tell it apart from a crash: a refusal is an
 * answer and is printed as one, where the caller is looking, without a Node
 * stack trace in front of it.
 */
export class AnnotationsFileRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnnotationsFileRefusal";
  }
}

/** One segment entry as the file wrote it, for a message a human can go and fix. */
function describeSegment(seg: SegmentAnnotation): string {
  const range = `$${String(seg.start ?? "").replace(/^\$/, "").toUpperCase()}-$${String(seg.end ?? "").replace(/^\$/, "").toUpperCase()}`;
  return `${range}  ${seg.kind ?? "unknown"}${seg.label ? `  "${seg.label}"` : ""}`;
}

/**
 * BUG-060 defect 2 — two `segments` entries may not share a start address.
 *
 * A segment START is the id everything downstream is keyed on: the renderer's
 * `segmentsByStart`, and the knowledge graph's `segment:<hex4>`. Two entries on
 * one start are therefore not a harmless repeat but a contradiction, and until
 * now nothing looked at it. `segmentsByStart` silently kept the LAST entry while
 * `segmentAnnotations` kept BOTH, so the listing was overlaid with two claims
 * about one range — and the graph importer got as far as writing rows before its
 * ledger threw `migration_log: …/segment:43a8 logged twice` and rolled the whole
 * import back. The listing still rebuilt byte-identical, so the only sign that
 * the graph had got nothing was that one line, under a green verdict.
 *
 * So the file is refused HERE, before a byte is rendered, with the offending
 * pair named — the same shape the name-length rule already refuses in.
 *
 * OVERLAP is not this. Two ranges that overlap at distinct starts are legal and
 * useful (Spec 055 reshapes across analysis boundaries); only the shared start
 * is ambiguous, and only it is refused.
 */
export function assertNoDuplicateSegmentStarts(file: AnnotationsFile, path: string): void {
  const byStart = new Map<number, SegmentAnnotation[]>();
  for (const seg of file.segments ?? []) {
    const start = parseHex(seg.start);
    if (Number.isNaN(start)) continue; // a mistyped range is a tolerant skip, reported by the indexer
    const bucket = byStart.get(start);
    if (bucket) bucket.push(seg); else byStart.set(start, [seg]);
  }
  const clashes = [...byStart.entries()].filter(([, entries]) => entries.length > 1).sort((a, b) => a[0] - b[0]);
  if (clashes.length === 0) return;

  const lines = [`${path}`, ""];
  for (const [start, entries] of clashes) {
    lines.push(`${entries.length} segments declare the same start $${start.toString(16).toUpperCase().padStart(4, "0")}:`);
    for (const seg of entries) lines.push(`  - ${describeSegment(seg)}`);
  }
  lines.push("");
  lines.push(
    "A segment start is the id the listing and the knowledge graph are both keyed on, so two entries on one "
    + "start are a contradiction, not a repeat: the listing would be overlaid with both and the graph import "
    + "would be rolled back whole. Give each range its own start, or merge them into one entry. Ranges that "
    + "OVERLAP at different starts are fine and are not what this refuses.",
  );
  throw new AnnotationsFileRefusal(lines.join("\n"));
}

const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, "0");
const STRICT_HEX = /^(?:\$|0x)?[0-9a-fA-F]{1,4}$/;
const CODE_SEGMENT_KINDS = new Set(["code", "basic_stub"]);

export interface SplitTableProblem {
  /** `splitTables[2]`, the entry as the file wrote it */
  where: string;
  reason: string;
}

/**
 * Every reason a `splitTables[]` entry cannot be taken, naming the entry.
 *
 * Refused, not skipped: the entry is what closes a found table (an obligation), so
 * one that is silently dropped would leave a table "decided" in the file and
 * undecided in the listing. The checks that need the analysis (a `code` segment
 * under the range) are made by the renderer, which has it; this function holds
 * everything the FILE and the image can answer.
 *
 * `src/server-tools/annotation-file.ts` states the same rules for the writing
 * doors (`src/` is ESM, this is CommonJS, neither imports the other);
 * `scripts/e2e-903-split-tables.mjs` runs one corpus through both.
 */
export function splitTableProblems(file: AnnotationsFile, image?: { start: number; end: number }): SplitTableProblem[] {
  const problems: SplitTableProblem[] = [];
  const entries = file.splitTables ?? [];
  const names = new Set<string>();
  for (const l of file.labels ?? []) if (l?.label) names.add(l.label);
  for (const r of file.routines ?? []) if (r?.name) { const id = toLabelIdent(r.name); if (id) names.add(id); names.add(r.name); }
  for (const s of file.segments ?? []) if (s?.label) { names.add(s.label); const id = toLabelIdent(s.label); if (id) names.add(id); }

  const taken: Array<{ where: string; ranges: Array<[number, number]> }> = [];
  (file.pointerTables ?? []).forEach((pt, i) => {
    const a = parseHex(pt?.start), b = parseHex(pt?.end);
    if (!Number.isNaN(a) && !Number.isNaN(b)) taken.push({ where: `pointerTables[${i}]`, ranges: [[a, b]] });
  });
  (file.jumpTables ?? []).forEach((jt, i) => {
    const a = parseHex(jt?.start), b = parseHex(jt?.end);
    if (!Number.isNaN(a) && !Number.isNaN(b)) taken.push({ where: `jumpTables[${i}]`, ranges: [[a, b]] });
  });
  (file.segments ?? []).forEach((seg, i) => {
    if (!CODE_SEGMENT_KINDS.has(String(seg?.kind))) return;
    const a = parseHex(seg.start), b = parseHex(seg.end);
    if (!Number.isNaN(a) && !Number.isNaN(b)) taken.push({ where: `segments[${i}] (${seg.kind})`, ranges: [[a, b]] });
  });

  const seenPairs = new Map<string, string>();
  entries.forEach((e, i) => {
    const where = `splitTables[${i}]`;
    const bad = (reason: string): void => { problems.push({ where, reason }); };
    if (!e || typeof e !== "object") { bad("is not an object"); return; }
    const loOk = typeof e.lo === "string" && STRICT_HEX.test(e.lo.trim());
    const hiOk = typeof e.hi === "string" && STRICT_HEX.test(e.hi.trim());
    if (!loOk) { bad(`lo=${JSON.stringify(e.lo)} is not a hex address`); return; }
    if (!hiOk) { bad(`hi=${JSON.stringify(e.hi)} is not a hex address`); return; }
    const lo = parseHex(e.lo.trim()), hi = parseHex(e.hi.trim());
    const id = `$${hex4(lo)}/$${hex4(hi)}`;
    const pair = `${lo}:${hi}`;
    const first = seenPairs.get(pair);
    if (first) { bad(`${id} is already decided by ${first} — one entry per (lo, hi)`); return; }
    seenPairs.set(pair, where);

    if (e.reject !== undefined) {
      if (typeof e.reject !== "string" || e.reject.trim() === "") {
        bad(`${id}: reject is empty — say why this is not a pointer table (a rejection with no reason is not a decision)`);
      }
      return;
    }
    if (typeof e.count !== "number" || !Number.isInteger(e.count) || e.count < 1) {
      bad(`${id}: count must be a whole number of at least 1 (got ${JSON.stringify(e.count)})`);
      return;
    }
    if (e.adjust !== undefined && (typeof e.adjust !== "number" || !Number.isInteger(e.adjust) || Math.abs(e.adjust) > 0xffff)) {
      bad(`${id}: adjust must be a whole number (an RTS dispatch stores target-1, so adjust: 1), got ${JSON.stringify(e.adjust)}`);
      return;
    }
    if (e.base !== undefined && (typeof e.base !== "string" || !names.has(e.base))) {
      bad(`${id}: base ${JSON.stringify(e.base)} names no label, routine or segment label in this file`);
      return;
    }
    const loEnd = lo + e.count - 1, hiEnd = hi + e.count - 1;
    if (loEnd > 0xffff || hiEnd > 0xffff) { bad(`${id}: count ${e.count} runs a table past $FFFF`); return; }
    if (image) {
      for (const [name, a, b] of [["low", lo, loEnd], ["high", hi, hiEnd]] as const) {
        if (a < image.start || b > image.end) {
          bad(`${id}: the ${name} table $${hex4(a)}-$${hex4(b)} is outside the image $${hex4(image.start)}-$${hex4(image.end)}`);
          return;
        }
      }
    }
    if (lo <= hiEnd && hi <= loEnd) { bad(`${id}: the low table $${hex4(lo)}-$${hex4(loEnd)} and the high table $${hex4(hi)}-$${hex4(hiEnd)} overlap`); return; }
    for (const t of taken) {
      for (const [a, b] of t.ranges) {
        if ((lo <= b && loEnd >= a) || (hi <= b && hiEnd >= a)) {
          bad(`${id}: overlaps ${t.where} $${hex4(a)}-$${hex4(b)}${t.where.startsWith("segments") ? " — a split table is data, never code" : ""}`);
          return;
        }
      }
    }
    taken.push({ where, ranges: [[lo, loEnd], [hi, hiEnd]] });
  });
  return problems;
}

/** The file contradicts itself about its split tables: refuse it, naming every entry. */
export function assertSplitTablesValid(file: AnnotationsFile, path: string, image?: { start: number; end: number }): void {
  const problems = splitTableProblems(file, image);
  if (problems.length === 0) return;
  const lines = [`${path}`, "", `${problems.length} splitTables ${problems.length === 1 ? "entry" : "entries"} refused:`];
  for (const p of problems) lines.push(`  ${p.where}  ${p.reason}`);
  lines.push("", "A split-table entry closes a found table, so one that is dropped quietly would leave it decided in the file and undecided in the listing. Fix the entries; nothing was rendered.");
  throw new AnnotationsFileRefusal(lines.join("\n"));
}

export function loadAnnotations(prgPath: string, explicitPath?: string): AnnotationsFile | undefined {
  const read = (p: string): AnnotationsFile => {
    const file = normalizeAnnotationsFile(JSON.parse(readFileSync(p, "utf8")));
    assertNoDuplicateSegmentStarts(file, p);
    assertSplitTablesValid(file, p);
    return file;
  };

  if (explicitPath) {
    const p = resolve(explicitPath);
    if (existsSync(p)) {
      return read(p);
    }
  }

  const parsed = parse(prgPath);
  const candidates = [
    resolve(dirname(prgPath), `${parsed.name}_annotations.json`),
    resolve(dirname(prgPath), "annotations.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return read(candidate);
    }
  }

  return undefined;
}
