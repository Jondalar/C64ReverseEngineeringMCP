// Two doors, not four — the rule that decides how a file's bytes are read, and the
// rule that decides which analysis a render uses. Both are stated once, here, because
// `disasm` and `analyze` must answer them identically or they are two doors again.
//
// §1 THE LOAD ADDRESS DECIDES, NEVER THE FILE NAME.
//
//   load_address given    → the bytes are raw and start there.
//   load_address omitted  → the file must carry a header; its first two bytes are it.
//   a header AND a load_address that disagree → refused, naming both.
//
// The extension is a hint in a message and never the decider. This repo learned that
// where media are identified by content: in a real corpus a payload carved out of a
// disk carries no extension at all (`pack1 (nameint1`), a `.bin` is a PRG and a `.prg`
// is a raw block. A run over four G64 sides built FAKE 2-byte load headers for 1541
// drive code and routed them through the PRG door because that was the only way to get
// segment annotations onto them — the exact workaround the raw door exists to end,
// reappearing one door over.
//
// §2 THE ANALYSIS A RENDER USES.
//
//   named and present → used, unchanged, never swapped (the rule BUG-055 settled).
//   named and absent, or not named → the PROJECT STORE is asked which analysis is
//     registered for these bytes, and the answer names what it found and why.
//   nothing in the store → the file beside the bytes.
//
// That last ordering is the fix for a live defect: `extract_disk` writes its analysis
// into a hashed payload directory while the render insisted on the path beside the
// PRG, so a correct call was refused and a session re-ran the analyser for every
// extracted file.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ADDRESS_RULE, parseAddress, parseCount } from "../shared/address-rule.js";
import type { ProjectKnowledgeService } from "../project-knowledge/service.js";

const hex16 = (value: number) => `$${(value & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
const both = (value: number) => `${value} ($${value.toString(16).toUpperCase()})`;

/** How a file's bytes were read, and everything downstream needs to know about it. */
export interface ByteReading {
  kind: "raw" | "headed";
  /** Where the first byte of the rendered/analysed window runs. */
  loadAddress: number;
  /** Last address those bytes occupy. */
  lastAddress: number;
  /** Byte offset into the file where they start — 2 for a headed file. */
  byteOffset: number;
  /** How many of them. */
  byteLength: number;
  /** The header word, when the file was read as headed. */
  headerWord?: number;
  /** The one line an answer opens with: which rule was taken, and where the address came from. */
  line: string;
}

export interface ReadingRequest {
  sourceAbs: string;
  loadAddress?: string | number;
  /** The caller asserting outright that these bytes do (true) or do not (false) carry a 2-byte header. */
  headed?: boolean;
  offset?: string | number;
  length?: string | number;
  /** The store's own word on what this file is — `kind` off its artifact row, when it has one. */
  registeredKind?: string;
}

export type ReadingResult = { ok: true; reading: ByteReading } | { ok: false; refusal: string };

/**
 * §1, applied. Every refusal names both readings and how to pick one, because the
 * caller who lands here is usually a headless one that cannot look at the file.
 */
export function resolveByteReading(request: ReadingRequest): ReadingResult {
  const { sourceAbs } = request;
  const name = basename(sourceAbs);
  if (!existsSync(sourceAbs)) return { ok: false, refusal: `${sourceAbs} does not exist.` };
  const fileSize = statSync(sourceAbs).size;
  if (fileSize === 0) return { ok: false, refusal: `${name} is empty — there are no bytes to read.` };

  const given = request.loadAddress !== undefined && request.loadAddress !== null && request.loadAddress !== "";
  let loadAddress: number | undefined;
  let byteOffset: number | undefined;
  let byteLength: number | undefined;
  try {
    if (given) loadAddress = parseAddress(request.loadAddress, "load_address");
    if (request.offset !== undefined) byteOffset = parseCount(request.offset, "offset");
    if (request.length !== undefined) byteLength = parseCount(request.length, "length");
  } catch (e) {
    return { ok: false, refusal: e instanceof Error ? e.message : String(e) };
  }

  // A window's first byte is not a load header — naming one is a raw reading by
  // definition, so a window without an address has nothing to run at.
  if (!given && (byteOffset !== undefined || byteLength !== undefined)) {
    return { ok: false, refusal:
      `offset/length narrow a window of ${name}, and a window's first byte is not a 2-byte load header — `
      + `so a window is raw bytes by definition. Pass load_address to say where the window's first byte runs, `
      + `or drop offset/length to read ${name} as a headed file from its own first two bytes.` };
  }

  const headerWord = fileSize >= 2 ? (readFileSync(sourceAbs).readUInt16LE(0)) : undefined;

  // The caller says the bytes carry a header. So does the store, when it recorded this
  // file as a PRG and the caller named no window — then the two bytes at the front are
  // a header by record, not by guess.
  const declaredHeaded = request.headed === true
    || (request.headed === undefined && request.registeredKind === "prg" && byteOffset === undefined);

  if (given && declaredHeaded && headerWord !== undefined && headerWord !== loadAddress) {
    const why = request.headed === true
      ? "you passed headed: true"
      : `the project store has ${name} registered as a PRG`;
    return { ok: false, refusal:
      `${name} carries a load header saying ${hex16(headerWord)} and load_address says ${hex16(loadAddress!)} — `
      + `they disagree, and a guess is never silently preferred to what you said (${why}).\n`
      + `Pick the reading: leave load_address out to read the header (the body then runs at ${hex16(headerWord)}), `
      + `or pass headed: false to read every byte from offset 0 as raw at ${hex16(loadAddress!)}. `
      + `To render the body at a different address, pass offset: 2 with load_address.` };
  }

  if (given && !declaredHeaded) {
    const offset = byteOffset ?? 0;
    const length = byteLength ?? fileSize - offset;
    if (offset >= fileSize) {
      return { ok: false, refusal:
        `offset ${both(offset)} is past the end of ${name}, which holds ${both(fileSize)} bytes. `
        + `${ADDRESS_RULE}, and offset follows the same rule — "100" is 256, not 100.` };
    }
    if (length <= 0 || offset + length > fileSize) {
      return { ok: false, refusal:
        `offset ${both(offset)} + length ${both(length)} runs past the end of ${name}, which holds ${both(fileSize)} bytes. `
        + `${ADDRESS_RULE}, and offset/length follow the same rule — "100" is 256, not 100.` };
    }
    const last = (loadAddress! + length - 1) & 0xffff;
    return { ok: true, reading: {
      kind: "raw",
      loadAddress: loadAddress!,
      lastAddress: last,
      byteOffset: offset,
      byteLength: length,
      ...(headerWord !== undefined ? { headerWord } : {}),
      line:
        `Reading: load_address ${hex16(loadAddress!)} given — ${name} is read as raw bytes starting there`
        + `${offset !== 0 || length !== fileSize ? ` (bytes ${offset}..${offset + length - 1})` : ""}`
        + `, running ${hex16(loadAddress!)}-${hex16(last)}. Its name decides nothing; if these bytes do carry a `
        + `2-byte load header, leave load_address out.`,
    } };
  }

  // Headed: either nothing was given, or a load_address that agrees with the header.
  if (fileSize < 3) {
    return { ok: false, refusal:
      `${name} is ${fileSize} byte${fileSize === 1 ? "" : "s"} — too short to be read as headed (2 header bytes + a body). `
      + `If these are raw bytes, pass load_address and they are read from offset 0.` };
  }
  const load = headerWord!;
  const bodyLength = fileSize - 2;
  const last = (load + bodyLength - 1) & 0xffff;
  const confirmed = given && loadAddress === load;
  return { ok: true, reading: {
    kind: "headed",
    loadAddress: load,
    lastAddress: last,
    byteOffset: 2,
    byteLength: bodyLength,
    headerWord: load,
    line: confirmed
      ? `Reading: ${name} read as headed — its first two bytes are ${hex16(load)}, which is the load_address you passed, `
        + `so the body runs ${hex16(load)}-${hex16(last)}.`
      : `Reading: no load_address given and ${name} read as headed — the first two bytes are ${hex16(load)}, `
        + `so the body runs ${hex16(load)}-${hex16(last)}; if that is wrong, pass load_address.`,
  } };
}

// ── §2 the analysis a render uses ───────────────────────────────────────────

export interface AnalysisChoice {
  /** The analysis to render with, when there is one. */
  path?: string;
  /** Why this one — printed in the answer, always. */
  why: string;
  /** A refusal, when the caller named something that cannot be honoured. */
  refusal?: string;
}

/**
 * Which analysis the project store has registered FOR THESE BYTES.
 *
 * Not a stem guess and not a directory walk: the store links every analysis JSON to
 * the artifact it was produced from (`sourceArtifactIds`, written by the registration
 * path every door goes through). So an analysis that `extract_disk` left in a hashed
 * payload directory is found by asking who it is about, which is the only question a
 * path beside the bytes was ever standing in for.
 */
export function analysisRegisteredFor(
  service: ProjectKnowledgeService,
  sourceAbs: string,
): { path: string; producedBy?: string } | undefined {
  try {
    const artifacts = service.listArtifacts();
    const source = artifacts.find((a) => a.path === sourceAbs);
    if (!source) return undefined;
    const candidates = artifacts.filter((a) =>
      (a.role === "analysis-json" || a.role === "prg-analysis" || a.kind === "analysis-run")
      && a.role !== "tool-run-record"
      && (a.format === undefined || a.format === "json")
      && (a.sourceArtifactIds ?? []).includes(source.id)
      && existsSync(a.path));
    if (candidates.length === 0) return undefined;
    // The newest wins: a second analysis of the same bytes is a refinement of the
    // first (a seeded re-run, a window), never a competitor.
    const best = [...candidates].sort((l, r) => String(r.updatedAt ?? "").localeCompare(String(l.updatedAt ?? "")))[0]!;
    return { path: best.path, ...(best.producedByTool ? { producedBy: best.producedByTool } : {}) };
  } catch {
    return undefined;
  }
}

/** The stem-matched file beside the bytes — the last resort, and the one that used to be first. */
export function analysisBesideBytes(sourceAbs: string): string | undefined {
  const stem = basename(sourceAbs).replace(/\.[^./]+$/, "");
  for (const candidate of [
    join(dirname(sourceAbs), `${stem}_analysis.json`),
    join(dirname(sourceAbs), "analysis.json"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Does this analysis describe the span it is about to be rendered over? */
export function analysisSpan(analysisAbs: string): { start: number; end: number } | undefined {
  try {
    const mapping = (JSON.parse(readFileSync(analysisAbs, "utf8")) as {
      mapping?: { startAddress?: number; endAddress?: number };
    }).mapping;
    if (typeof mapping?.startAddress !== "number" || typeof mapping?.endAddress !== "number") return undefined;
    return { start: mapping.startAddress, end: mapping.endAddress };
  } catch {
    return undefined;
  }
}

/**
 * The refusal text when an analysis does not describe the window it is about to be
 * rendered over — undefined when it does, or when the file says nothing about its own
 * span, which is not something to refuse over.
 */
export function analysisWindowMismatch(
  analysisAbs: string,
  windowStart: number,
  windowEnd: number,
): string | undefined {
  let span: { start: number; end: number } | undefined;
  try {
    span = analysisSpan(analysisAbs);
  } catch {
    return `analysis_json ${analysisAbs} could not be read as JSON.`;
  }
  if (!existsSync(analysisAbs)) return `analysis_json ${analysisAbs} does not exist.`;
  if (!span) return undefined;
  if (span.start === windowStart && span.end === windowEnd) return undefined;
  return `analysis_json ${basename(analysisAbs)} describes ${hex16(span.start)}-${hex16(span.end)}; this window runs at `
    + `${hex16(windowStart)}-${hex16(windowEnd)}. An analysis of the whole file rendered over a window of it `
    + `produces a listing of the file's segments at the window's addresses and a rebuild that cannot match. `
    + `Run analyze over these bytes (its load_address is this window's), pass no_analysis to render linearly, `
    + `or disassemble the whole file instead.`;
}

export interface AnalysisRequest {
  service: ProjectKnowledgeService;
  sourceAbs: string;
  /** The path the caller named, already resolved — or undefined. */
  namedAbs?: string;
  noAnalysis?: boolean;
  reading: ByteReading;
}

/**
 * §2, applied. The answer always says which file was used and why, because the two
 * branches that are NOT "you named it" are exactly the ones a caller cannot see.
 */
export function resolveAnalysis(request: AnalysisRequest): AnalysisChoice {
  const { service, sourceAbs, namedAbs, reading } = request;
  if (request.noAnalysis) {
    if (namedAbs) {
      return { why: "", refusal: "analysis_json and no_analysis were both given. Name one: the analysis to use, or none at all." };
    }
    return { why: "none — no_analysis was passed, so nothing was read and the listing is linear." };
  }

  /** The one span check, shared by the named, the registered and the beside-it file. */
  const mismatchOf = (path: string): string | undefined =>
    analysisWindowMismatch(path, reading.loadAddress, reading.lastAddress);
  /** …and its short form, for a file that was merely FOUND and is simply stepped over. */
  const describes = (path: string): string | undefined => {
    const span = analysisSpan(path);
    if (!span) return undefined;
    if (span.start === reading.loadAddress && span.end === reading.lastAddress) return undefined;
    return `${basename(path)} describes ${hex16(span.start)}-${hex16(span.end)}, not ${hex16(reading.loadAddress)}-${hex16(reading.lastAddress)}`;
  };

  if (namedAbs && existsSync(namedAbs)) {
    // Named and present is final — it is used unchanged and never swapped. The span is
    // still held against the window on a raw reading, where a whole-file analysis over
    // a 640-byte window produced 4082 data lines and a rebuild that could not match.
    if (reading.kind === "raw") {
      const mismatch = mismatchOf(namedAbs);
      if (mismatch) return { why: "", refusal: mismatch };
    }
    return { path: namedAbs, why: `${basename(namedAbs)} — you named it, and a named analysis is used unchanged.` };
  }

  const namedButAbsent = namedAbs !== undefined;
  const registered = analysisRegisteredFor(service, sourceAbs);
  if (registered) {
    const mismatch = describes(registered.path);
    if (!mismatch) {
      const head = namedButAbsent
        ? `${basename(registered.path)} — analysis_json ${namedAbs} does not exist, so the project store was asked which analysis is registered for these bytes`
        : `${basename(registered.path)} — the project store has it registered for these bytes`;
      return { path: registered.path, why: `${head}${registered.producedBy ? ` (written by ${registered.producedBy})` : ""}; not a path guessed beside the file.` };
    }
    // Registered, but about a different span. Said out loud and stepped over rather
    // than applied: this is the shape that rendered a 63 KB image's segments over a
    // window of it.
    const beside = analysisBesideBytes(sourceAbs);
    if (!beside || describes(beside)) {
      return { why:
        `none — the store has ${basename(registered.path)} registered for these bytes, but ${mismatch}, so it was not used. `
        + `Run analyze over this window to get one that fits; the listing below is linear.` };
    }
  }

  const beside = analysisBesideBytes(sourceAbs);
  if (beside) {
    const mismatch = describes(beside);
    if (mismatch) {
      return { why:
        `none — nothing is registered for these bytes and ${mismatch}, so the file beside them was not used. `
        + `Run analyze over this window; the listing below is linear.` };
    }
    const head = namedButAbsent
      ? `${basename(beside)} — analysis_json ${namedAbs} does not exist and nothing is registered for these bytes, so the file beside them was used`
      : `${basename(beside)} — nothing is registered for these bytes, so the file beside them was used`;
    return { path: beside, why: `${head}.` };
  }

  if (namedButAbsent) {
    return { why: "", refusal:
      `analysis_json ${namedAbs} does not exist, nothing is registered for these bytes in the project store, and `
      + `no analysis sits beside them. A named analysis is never swapped for a guess — produce one with analyze `
      + `over these bytes, fix the path, or leave analysis_json out.` };
  }
  return { why: "none — no analysis was named, none is registered for these bytes, and none sits beside them; every byte is read as code." };
}

// ── §3 the old names ────────────────────────────────────────────────────────

/**
 * One line, once per SESSION, in the alias's own answer. Not a deprecation banner:
 * it names the door to use, says why the two became one, and then gets out of the way.
 *
 * Once, not once per answer (Spec 877 D4). A session needs to be told where a retired
 * name went the first time it reaches for it; repeated on every listing the sentence
 * becomes furniture, and furniture is not read. The answer says as much — "the last
 * answer that will say so" — so nobody waits for a reminder that is not coming.
 *
 * "Once" is bounded by the SESSION, not by the process, and the ledger is therefore a
 * file, for the reason 849 D5 states about its own: the server outlives a session and
 * serves several projects at once. Held in a `Set` it was once per process, so a
 * globally configured server that had already answered one `analyze_prg` handed the
 * NEXT session nothing — and the next session is exactly the one that has not been
 * told. `agent_onboard` marks a session's start (the call every session makes first,
 * and the one it makes again after a compaction) and re-arms every name through
 * `resetAliasNotices`, the same way it re-arms the project rules.
 *
 * The wording is load-bearing, and the failure it exists to prevent is measured: four
 * days after 866 shipped, a run reached for `analyze_prg`/`disasm_prg`, found that
 * those names want a PRG header, and duly wrote `struct.pack('<H', addr) + data` in
 * front of every block it extracted — the fake load headers Spec 865 exists to
 * abolish. The old note helped that along: it said "analyze took a PRG and nothing
 * else", naming the SUCCESSOR where it meant the alias. So each note now names the
 * OLD door as the one that wanted a header, and says outright not to invent one.
 */
export const ALIAS_SUCCESSOR: Readonly<Record<string, string>> = {
  disasm_prg: "disasm",
  disasm_raw: "disasm",
  analyze_prg: "analyze",
};

/** Never invent a header to get bytes through a door — the door takes the address. */
const NO_FAKE_HEADER =
  "And never invent a 2-byte load header to get headerless bytes through a door: pass load_address instead. "
  + "A fabricated header is two bytes that are not in the original, and everything downstream believes them.";

const ALIAS_LEDGER = "alias-notices.json";

/** Only for a call with no project behind it — there is no file to keep a ledger in. */
const announcedWithoutAProject = new Set<string>();

function aliasLedgerPath(projectDir: string): string {
  return join(projectDir, "knowledge", ALIAS_LEDGER);
}

/** A project keeps a ledger only once it has a `knowledge/` directory to keep it in. */
function aliasLedgerUsable(projectDir: string | undefined): projectDir is string {
  return !!projectDir && existsSync(join(projectDir, "knowledge"));
}

function readAnnounced(projectDir: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(aliasLedgerPath(projectDir), "utf8")) as { announced?: unknown };
    if (Array.isArray(raw?.announced)) return new Set(raw.announced.map((n) => String(n)));
  } catch { /* absent: nothing has been said yet */ }
  return new Set();
}

function writeAnnounced(projectDir: string, names: Set<string>): void {
  // A ledger that cannot be written only costs a repeated line; it may never cost the
  // listing the caller asked for.
  try {
    writeFileSync(aliasLedgerPath(projectDir), JSON.stringify({ announced: [...names] }, null, 2) + "\n");
  } catch { /* said again next time */ }
}

/**
 * Re-arm every retired name. Called by `agent_onboard`: a session that is onboarding is
 * either new or has just lost its context, and in both cases it has been told nothing.
 */
export function resetAliasNotices(projectDir: string): void {
  announcedWithoutAProject.clear();
  if (!aliasLedgerUsable(projectDir)) return;
  writeAnnounced(projectDir, new Set());
}

/** The text an alias would print, whether or not it has printed it already. */
function aliasNoticeText(invokedAs: string): string {
  const successor = ALIAS_SUCCESSOR[invokedAs];
  if (!successor) return "";
  const head = `Note: ${invokedAs} is now \`${successor}\`, and this name keeps working for one release — `
    + `this is the last answer that will say so.`;
  if (successor === "disasm") {
    return `${head} disasm_prg and disasm_raw ran the same decoder, renderer, annotations and rebuild proof and `
      + `differed only in whether two bytes at the front are a load address — so that is the only question left: `
      + `pass load_address and the bytes are raw and start there, leave it out and the file's first two bytes are `
      + `read as one. ${NO_FAKE_HEADER}`;
  }
  return `${head} analyze_prg took a PRG and nothing else, so headerless bytes — a depacked chunk, a relocated `
    + `overlay, a block of drive code — could not be classified at all; \`analyze\` decides by the same `
    + `load-address rule, so the nine analysers run on either. ${NO_FAKE_HEADER}`;
}

/** The notice, the FIRST time this SESSION answers under that name; "" after. */
export function aliasNotice(invokedAs: string, projectDir?: string): string {
  if (!ALIAS_SUCCESSOR[invokedAs]) return "";
  if (aliasLedgerUsable(projectDir)) {
    const announced = readAnnounced(projectDir);
    if (announced.has(invokedAs)) return "";
    announced.add(invokedAs);
    writeAnnounced(projectDir, announced);
    return aliasNoticeText(invokedAs);
  }
  if (announcedWithoutAProject.has(invokedAs)) return "";
  announcedWithoutAProject.add(invokedAs);
  return aliasNoticeText(invokedAs);
}
