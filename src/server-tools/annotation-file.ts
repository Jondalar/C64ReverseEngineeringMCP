// The annotations file, as a shape this server can BUILD — not only read.
//
// Measured, from a run watched live: five subagents each wrote their own generator
// (`genA.py`, `B_gen.py`, `C_gen.py`, `D_gen.py`, `E_gen.py`) to turn a tuple list into
// the annotations JSON, because nothing here took "here are 40 segments and 60 routines,
// write the file". They agreed on neither the file name nor the spelling of an address,
// so the step that combined them had to undo both — `s["start"].upper().lstrip("$")`.
//
// Two rules follow, and this module is where they live:
//
//   ONE SPELLING. `$43a8`, `0x43A8` and `43a8` all come out `43A8`. The loader strips a
//   `$` and the doc allows either form, so nothing DOWNSTREAM breaks on a mixed file —
//   but every consumer written by hand then has to normalise, and one of them will not.
//
//   REFUSED ON THE WAY IN. The loader is deliberately tolerant: a mistyped key is
//   skipped and the rest still apply, which is right when a human wrote the file by hand
//   and wrong when a tool is writing it. A tool knows what it meant. So every rule the
//   loader would enforce LATER — and every one it would quietly skip — is checked HERE,
//   against the whole file, and a single offender means nothing is written at all.
//
// The rules are the loader's own, read off `pipeline/src/lib/annotations.ts` and
// `src/knowledge-graph/migrate/migrate.ts`:
//
//   - a segment start is the id the listing (`segmentsByStart`) and the graph
//     (`segment:<hex4>`) are both keyed on, so two entries may not share one (BUG-060);
//   - a routine's one required field beside `address` is `name`;
//   - an address carries one name, and a name belongs to one address — the second
//     definition of an identifier is what breaks the assembler, and it is the only
//     annotation defect that fails loudly instead of quietly;
//   - a project created since 2026-09-19 stores no name over `naming.maxLabelLength`,
//     and `disasm` refuses such a file before it renders anything;
//   - the importer reads the stem off the FILE NAME (`…/core_4300_annotations.json` →
//     `core_4300`) and keys every row it writes on it, so the name is not cosmetic.

import { basename, dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { maxLabelLength, namesTooLong, tooLongMessage } from "../project-knowledge/naming.js";

// ---------------------------------------------------------------- the shape

export interface SegmentEntry {
  start: string;
  end: string;
  kind: string;
  label?: string;
  comment?: string;
  space?: "runtime" | "file";
}
export interface LabelEntry { address: string; label: string; comment?: string }
export interface RoutineEntry { address: string; name: string; comment?: string }
export interface PointerTableEntry { start: string; end: string; stride?: number; endian?: "little" | "big"; comment?: string }
export interface JumpTableEntry { start: string; end: string; kind: "jmp" | "jsr" | "word"; comment?: string }
export interface ImmediateEntry { address: string; kind: "lo-of" | "hi-of"; label: string; comment?: string }

export interface AnnotationsDocument {
  version: 1;
  binary: string;
  segments: SegmentEntry[];
  labels: LabelEntry[];
  routines: RoutineEntry[];
  pointerTables?: PointerTableEntry[];
  jumpTables?: JumpTableEntry[];
  immediates?: ImmediateEntry[];
}

/** One entry the file may not carry, named where the caller wrote it. */
export interface Problem {
  /** `segments[2]`, `labels[0]` — the caller's own index, so the entry is findable. */
  where: string;
  reason: string;
  hint?: string;
}

/** The raw sections as a caller hands them over: any shape, checked here. */
export interface RawSections {
  segments?: unknown[];
  labels?: unknown[];
  routines?: unknown[];
  pointerTables?: unknown[];
  jumpTables?: unknown[];
  immediates?: unknown[];
}

export const KNOWN_SEGMENT_KINDS = [
  "basic_stub", "basic", "code", "text", "screen_code_text", "petscii_text", "sprite",
  "charset", "charset_source", "screen_ram", "screen_source", "bitmap", "hires_bitmap",
  "multicolor_bitmap", "bitmap_source", "color_source", "sid_driver", "music_data",
  "sid_related_code", "pointer_table", "lookup_table", "state_variable",
  "compressed_data", "dead_code", "padding", "unknown",
] as const;

// ------------------------------------------------------------ one spelling

/**
 * The canonical spelling of an address: bare uppercase hex, at least four digits.
 *
 * Accepts what the doc allows a human to write (`43A8`, `$43a8`) and what a generator
 * tends to emit (`0x43A8`), and returns the one form the file is written in. Returns
 * undefined when it is not an address at all — the caller turns that into a Problem
 * naming the entry, rather than writing NaN into a file nobody will check again.
 *
 * A JSON NUMBER is deliberately not accepted: `4300` is $10CC if it is decimal and
 * $4300 if it is hex, and the caller who wrote it meant one of them. The door says so
 * instead of guessing.
 */
export function canonHex(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().replace(/^\$/, "").replace(/^0[xX]/, "");
  if (t.length === 0 || !/^[0-9a-fA-F]+$/.test(t)) return undefined;
  const up = t.toUpperCase().replace(/^0+(?=.)/, "");
  return up.padStart(4, "0");
}

export function hexValue(raw: unknown): number | undefined {
  const c = canonHex(raw);
  return c === undefined ? undefined : parseInt(c, 16);
}

/** `$43A8`, for a message a human reads. */
const $ = (v: number): string => `$${v.toString(16).toUpperCase().padStart(4, "0")}`;

// ------------------------------------------------------------- the checking

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** The mistyped key a caller probably meant, in the loader's own wording. */
function didYouMean(entry: Record<string, unknown>, expected: string, aliases: string[]): string {
  const present = aliases.find((a) => a in entry);
  return present ? `field "${present}" should be "${expected}"` : `missing "${expected}"`;
}

export interface BuildResult {
  doc: AnnotationsDocument;
  problems: Problem[];
  /** Non-fatal remarks that belong in the answer — an unrecognised segment kind. */
  notes: string[];
}

/**
 * Turn the caller's sections into the document the importer accepts, collecting every
 * reason it could not instead of stopping at the first one. `problems` empty means the
 * document is safe to write; anything else and the caller gets all of it at once.
 */
export function buildAnnotationsDocument(sections: RawSections, binary: string): BuildResult {
  const problems: Problem[] = [];
  const notes: string[] = [];
  const bad = (where: string, reason: string, hint?: string): void => { problems.push({ where, reason, hint }); };

  // ---- segments
  const segments: SegmentEntry[] = [];
  const segByStart = new Map<string, { where: string; entry: SegmentEntry }>();
  (sections.segments ?? []).forEach((raw, i) => {
    const where = `segments[${i}]`;
    const e = rec(raw);
    const start = canonHex(e.start);
    const end = canonHex(e.end);
    if (start === undefined) { bad(where, `unparseable start=${JSON.stringify(e.start)}`, didYouMean(e, "start", ["from", "begin", "addr", "address"])); return; }
    if (end === undefined) { bad(where, `unparseable end=${JSON.stringify(e.end)} (start ${start})`, didYouMean(e, "end", ["to", "stop", "last"])); return; }
    if (parseInt(end, 16) < parseInt(start, 16)) { bad(where, `end $${end} is below start $${start}`, "a segment range runs low to high, and the importer drops one that does not"); return; }
    const kind = str(e.kind);
    if (kind === undefined) { bad(where, `$${start}-$${end} has no kind`, didYouMean(e, "kind", ["type", "class", "classification"])); return; }
    if (!(KNOWN_SEGMENT_KINDS as readonly string[]).includes(kind)) {
      notes.push(`${where} $${start}-$${end}: kind "${kind}" is not one the analyser produces — it is written as given and renders as bytes. Known kinds: ${KNOWN_SEGMENT_KINDS.join(", ")}.`);
    }
    const space = e.space === undefined ? undefined : str(e.space);
    if (space !== undefined && space !== "runtime" && space !== "file") { bad(where, `space="${space}"`, 'space is "runtime" (the .pseudopc address) or "file" (the stored position)'); return; }
    const entry: SegmentEntry = {
      start, end, kind,
      ...(str(e.label) ? { label: str(e.label)! } : {}),
      ...(str(e.comment) ? { comment: str(e.comment)! } : {}),
      ...(space ? { space: space as "runtime" | "file" } : {}),
    };
    const first = segByStart.get(start);
    if (first) {
      // BUG-060 defect 2 — the id the listing and the graph are both keyed on.
      bad(where, `start $${start} is already declared by ${first.where}`,
        `${first.where}: ${describeSegment(first.entry)}\n${where}: ${describeSegment(entry)}\n`
        + "a segment start is the id the listing and the knowledge graph are both keyed on, so two entries on one start "
        + "are a contradiction, not a repeat. Give each range its own start, or merge them. Ranges that merely OVERLAP at "
        + "different starts are fine and are not refused.");
      return;
    }
    segByStart.set(start, { where, entry });
    segments.push(entry);
  });

  // ---- labels and routines share one name space: an identifier gets ONE definition,
  //      and the second one is what stops KickAssembler.
  const nameAt = new Map<string, { where: string; address: string }>();
  const addrNamed = new Map<string, { where: string; name: string }>();

  const labels: LabelEntry[] = [];
  (sections.labels ?? []).forEach((raw, i) => {
    const where = `labels[${i}]`;
    const e = rec(raw);
    const address = canonHex(e.address);
    if (address === undefined) { bad(where, `unparseable address=${JSON.stringify(e.address)} (label=${e.label ?? "?"})`, didYouMean(e, "address", ["addr", "offset", "pc", "at"])); return; }
    const label = str(e.label);
    if (label === undefined) { bad(where, `$${address} has no label`, didYouMean(e, "label", ["name", "ident", "symbol", "title"])); return; }
    const already = addrNamed.get(address);
    if (already) { bad(where, `$${address} is already named "${already.name}" by ${already.where}`, "one address carries one name — drop the duplicate or move it to its own address"); return; }
    const used = nameAt.get(label);
    if (used) { bad(where, `"${label}" is already defined at $${used.address} by ${used.where}`, "two definitions of one identifier break the rebuild — this is the annotation defect that fails in the assembler, not in the listing"); return; }
    const entry: LabelEntry = { address, label, ...(str(e.comment) ? { comment: str(e.comment)! } : {}) };
    addrNamed.set(address, { where, name: label });
    nameAt.set(label, { where, address });
    labels.push(entry);
  });

  const routines: RoutineEntry[] = [];
  const routineAt = new Map<string, { where: string; name: string }>();
  (sections.routines ?? []).forEach((raw, i) => {
    const where = `routines[${i}]`;
    const e = rec(raw);
    const address = canonHex(e.address);
    if (address === undefined) { bad(where, `unparseable address=${JSON.stringify(e.address)} (name=${e.name ?? "?"})`, didYouMean(e, "address", ["addr", "offset", "pc", "at"])); return; }
    const name = str(e.name);
    if (name === undefined) { bad(where, `the routine at $${address} has no name`, didYouMean(e, "name", ["label", "title", "ident", "symbol", "routine"]) + ' — `name` is the one field a routine entry cannot do without: it is what the header prints and what renames the label'); return; }
    const already = routineAt.get(address);
    if (already) { bad(where, `$${address} is already the routine "${already.name}" (${already.where})`, "two routines at one address are two names for one thing — the importer keeps one of them and says nothing"); return; }
    const usedName = nameAt.get(name);
    if (usedName) { bad(where, `"${name}" is already defined at $${usedName.address} by ${usedName.where}`, "a routine name becomes a label identifier, and one identifier gets one definition"); return; }
    const entry: RoutineEntry = { address, name, ...(str(e.comment) ? { comment: str(e.comment)! } : {}) };
    routineAt.set(address, { where, name });
    nameAt.set(name, { where, address });
    routines.push(entry);
  });

  // ---- the optional sections
  const pointerTables: PointerTableEntry[] = [];
  (sections.pointerTables ?? []).forEach((raw, i) => {
    const where = `pointerTables[${i}]`;
    const e = rec(raw);
    const start = canonHex(e.start);
    const end = canonHex(e.end);
    if (start === undefined || end === undefined) { bad(where, `unparseable range start=${JSON.stringify(e.start)} end=${JSON.stringify(e.end)}`); return; }
    if (parseInt(end, 16) < parseInt(start, 16)) { bad(where, `end $${end} is below start $${start}`); return; }
    const stride = e.stride === undefined ? undefined : Number(e.stride);
    if (stride !== undefined && stride !== 1 && stride !== 2) { bad(where, `stride=${JSON.stringify(e.stride)}`, "stride is 1 or 2 (default 2, a .word table)"); return; }
    const endian = e.endian === undefined ? undefined : str(e.endian);
    if (endian !== undefined && endian !== "little" && endian !== "big") { bad(where, `endian="${endian}"`, 'endian is "little" (default) or "big"'); return; }
    pointerTables.push({ start, end, ...(stride !== undefined ? { stride } : {}), ...(endian ? { endian: endian as "little" | "big" } : {}), ...(str(e.comment) ? { comment: str(e.comment)! } : {}) });
  });

  const jumpTables: JumpTableEntry[] = [];
  (sections.jumpTables ?? []).forEach((raw, i) => {
    const where = `jumpTables[${i}]`;
    const e = rec(raw);
    const start = canonHex(e.start);
    const end = canonHex(e.end);
    if (start === undefined || end === undefined) { bad(where, `unparseable range start=${JSON.stringify(e.start)} end=${JSON.stringify(e.end)}`); return; }
    if (parseInt(end, 16) < parseInt(start, 16)) { bad(where, `end $${end} is below start $${start}`); return; }
    const kind = str(e.kind);
    if (kind !== "jmp" && kind !== "jsr" && kind !== "word") { bad(where, `kind=${JSON.stringify(e.kind)}`, "a jump table is jmp | jsr (3-byte rows) or word (2-byte rows)"); return; }
    jumpTables.push({ start, end, kind, ...(str(e.comment) ? { comment: str(e.comment)! } : {}) });
  });

  const immediates: ImmediateEntry[] = [];
  (sections.immediates ?? []).forEach((raw, i) => {
    const where = `immediates[${i}]`;
    const e = rec(raw);
    const address = canonHex(e.address);
    if (address === undefined) { bad(where, `unparseable address=${JSON.stringify(e.address)}`, didYouMean(e, "address", ["addr", "offset", "pc"])); return; }
    const kind = str(e.kind);
    if (kind !== "lo-of" && kind !== "hi-of") { bad(where, `kind=${JSON.stringify(e.kind)}`, 'an immediate rewrite is "lo-of" or "hi-of"'); return; }
    const label = str(e.label);
    if (label === undefined) { bad(where, `$${address} has no target label`, "the label an immediate is rewritten to must exist in labels[] or be a known segment label"); return; }
    immediates.push({ address, kind, label, ...(str(e.comment) ? { comment: str(e.comment)! } : {}) });
  });

  const doc: AnnotationsDocument = {
    version: 1,
    binary,
    segments,
    labels,
    routines,
    ...(pointerTables.length ? { pointerTables } : {}),
    ...(jumpTables.length ? { jumpTables } : {}),
    ...(immediates.length ? { immediates } : {}),
  };
  return { doc, problems, notes };
}

function describeSegment(s: SegmentEntry): string {
  return `$${s.start}-$${s.end}  ${s.kind}${s.label ? `  "${s.label}"` : ""}`;
}

/** Every name the document would store — the same three places `disasm` looks. */
export function documentNames(doc: AnnotationsDocument): string[] {
  return [
    ...doc.labels.map((l) => l.label),
    ...doc.routines.map((r) => r.name),
    ...doc.segments.map((s) => s.label).filter((v): v is string => typeof v === "string"),
  ];
}

/**
 * The project's name-length rule, applied HERE rather than at render time.
 *
 * `disasm` refuses an annotations file whose names are too long, so writing one is
 * writing a file that cannot be used. Returns the refusal text, or undefined.
 */
export function nameLengthRefusal(projectDir: string, doc: AnnotationsDocument): string | undefined {
  const max = maxLabelLength(projectDir);
  if (max === undefined) return undefined;
  const long = namesTooLong(documentNames(doc), max);
  return long.length > 0 ? tooLongMessage(long, max) : undefined;
}

// ------------------------------------------------------------- the file name

const SUFFIX = "_annotations.json";

/**
 * Where the file goes, and why it may not go anywhere else.
 *
 * The graph importer reads the stem off the FILE NAME —
 * `basename(path).replace(/_annotations\.json$/u, "")` — and keys every row it writes
 * on it; `disasm` finds the file by looking for `<stem>_annotations.json` beside the
 * bytes. A file called anything else is a file nothing reads.
 */
export function resolveAnnotationsPath(projectDir: string, opts: { outputPath?: string; prgPath?: string; binary?: string }): { path: string } | { refusal: string } {
  if (opts.outputPath) {
    const abs = resolve(projectDir, opts.outputPath);
    if (!basename(abs).endsWith(SUFFIX)) {
      return { refusal: [
        `REFUSED — output_path must end in \`${SUFFIX}\`. Nothing was written.`,
        ``,
        `Given: ${opts.outputPath}`,
        ``,
        `The graph importer reads the stem off the file NAME (…/core_4300${SUFFIX} → core_4300) and keys`,
        `every row it writes on it, and \`disasm\` finds the file by looking for <stem>${SUFFIX} beside the`,
        `bytes. A file called anything else is a file nothing reads.`,
        ...(/_annotations\.draft\.json$/.test(basename(abs))
          ? ["", "`_annotations.draft.json` is what `propose_annotations` writes for a human to review; `disasm` does not read it."]
          : []),
      ].join("\n") };
    }
    return { path: abs };
  }
  if (opts.prgPath) {
    const abs = resolve(projectDir, opts.prgPath);
    const stem = basename(abs).replace(/\.[^.]+$/u, "");
    return { path: join(dirname(abs), `${stem}${SUFFIX}`) };
  }
  return { refusal: [
    "REFUSED — no destination. Nothing was written.",
    "",
    `Pass \`prg_path\` (the bytes this annotates; the file lands beside them as <stem>${SUFFIX})`,
    `or \`output_path\` (an explicit path, ending in ${SUFFIX}).`,
  ].join("\n") };
}

/** What is already there, so a refusal to clobber says what it protected. */
export function describeExisting(path: string): string {
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as RawSections;
    const n = (v: unknown[] | undefined) => (Array.isArray(v) ? v.length : 0);
    return `${n(d.segments)} segments, ${n(d.labels)} labels, ${n(d.routines)} routines`;
  } catch {
    return "unreadable JSON";
  }
}

export function overwriteRefusal(path: string): string {
  return [
    `REFUSED — ${basename(path)} already exists. Nothing was written.`,
    ``,
    `It holds ${describeExisting(path)}.`,
    ``,
    `A hand-edited annotations file is the most expensive thing in a project to lose, so it is not`,
    `replaced by accident. Pass \`overwrite: true\` to replace it, or \`merge_annotations\` to fold the`,
    `new entries into what is there and have every contradiction named.`,
  ].join("\n");
}

/** The one refusal shape: a header, then every offender, then what was written (nothing). */
export function renderProblems(header: string, problems: Problem[]): string {
  const lines = [header, ""];
  lines.push(`${problems.length} ${problems.length === 1 ? "entry the importer would not accept" : "entries the importer would not accept"}:`);
  for (const p of problems) {
    lines.push(`  ${p.where}  ${p.reason}`);
    if (p.hint) for (const l of p.hint.split("\n")) lines.push(`      ${l}`);
  }
  lines.push("", "Nothing was written. Fix the entries and call again.");
  return lines.join("\n");
}

/** The file, serialised the one way — stable key order, two-space indent, trailing newline. */
export function serialiseDocument(doc: AnnotationsDocument): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

export function documentSummary(doc: AnnotationsDocument): string {
  const parts = [
    `${doc.segments.length} segment${doc.segments.length === 1 ? "" : "s"}`,
    `${doc.labels.length} label${doc.labels.length === 1 ? "" : "s"}`,
    `${doc.routines.length} routine${doc.routines.length === 1 ? "" : "s"}`,
  ];
  if (doc.pointerTables?.length) parts.push(`${doc.pointerTables.length} pointer tables`);
  if (doc.jumpTables?.length) parts.push(`${doc.jumpTables.length} jump tables`);
  if (doc.immediates?.length) parts.push(`${doc.immediates.length} immediates`);
  return parts.join(", ");
}

/** Read a fragment off disk in the same terms, so a bad file is named, not thrown. */
export function readSections(path: string): { sections: RawSections; binary?: string } | { refusal: string } {
  if (!existsSync(path)) return { refusal: `not found: ${path}` };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
    return { refusal: `${basename(path)} is not readable JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const o = rec(parsed);
  const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
  return {
    sections: {
      segments: arr(o.segments), labels: arr(o.labels), routines: arr(o.routines),
      pointerTables: arr(o.pointerTables), jumpTables: arr(o.jumpTables), immediates: arr(o.immediates),
    },
    binary: str(o.binary),
  };
}

export { $ as hexDollar };
