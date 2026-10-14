// Spec 903 D4 — a split low/high table the analysis found is an OBLIGATION until a
// `splitTables[]` entry in the annotations decides it.
//
// One body of code answers "what is still open", for every reader that asks: the
// answer `disasm` / `analyze` end with, the `agent_advance_phase` refusal, the
// critic check and the recommender. They cannot disagree about what is open because they
// do not each count.
//
// An obligation is a `SplitPointerTableFact` with `provenance: "confirmed_code"`, keyed by
// (lowTableBase, highTableBase). Code nobody has proved (`probable_code`) is listed, never
// an obligation: a gate that fires on it is a wall. So is a zero-page pair the code never
// uses as a pointer (`pointerUsed: false` — coordinates, width/height): the shape alone does
// not make a table.
//
// The ONLY thing that closes one is an entry with the same lo/hi in that artifact's
// annotations — a declaration (count ≥ 1) or a rejection (a non-empty `reject`). The
// renderer refuses an entry it cannot take, so an entry that closes an obligation here is
// one the listing has applied.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ArtifactRecord } from "./types.js";

export interface SplitObligation {
  lo: number;
  hi: number;
  shape: string;
  indexRegister: string;
  sampleTargets: number[];
  countHint?: number;
  adjustHint?: number;
  /** the code that reads the tables */
  codeStart: number;
  codeEnd: number;
  /** for a listed-not-obligation entry: why it does not bind */
  why?: "probable-code" | "no-pointer-use";
  /** zero-page cell of the low byte, for a zp_pointer */
  pointerBase?: number;
}

export interface SplitObligationReport {
  analysisPath: string;
  annotationsPath?: string;
  open: SplitObligation[];
  closed: Array<SplitObligation & { how: "declared" | "rejected" }>;
  /** facts from probable code: listed, never an obligation */
  probable: SplitObligation[];
}

/** Printed with every obligation list, so nobody reads "0 open" as "no tables". */
export const SPLIT_LIMIT_SENTENCE =
  "The detector sees only three shapes (zero-page pointer, patched operand, RTS dispatch) built from confirmed code; "
  + "a zero-page pair counts only when the code later uses it as a pointer ((zp),y, (zp,x), jmp (zp)); "
  + "a table whose index is computed in two steps or whose pointer is copied before use is not listed here. "
  + "\"0 open\" is not \"no tables\" — reading the code finds the rest, and splitTables[] declares them.";

const hex4 = (n: number): string => `$${(n & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

interface RawFact {
  start?: number; end?: number; lowTableBase?: number; highTableBase?: number; indexRegister?: string;
  shape?: string; provenance?: string; sampleTargets?: number[]; countHint?: number; adjustHint?: number;
  pointerUsed?: boolean; pointerBase?: number;
}

const factCache = new Map<string, { stamp: string; facts: RawFact[] }>();

function readFacts(analysisPath: string): RawFact[] {
  let stamp: string;
  try {
    const st = statSync(analysisPath);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return [];
  }
  const cached = factCache.get(analysisPath);
  if (cached && cached.stamp === stamp) return cached.facts;
  let facts: RawFact[] = [];
  try {
    const text = readFileSync(analysisPath, "utf8");
    // most analyses carry no split table; skip parsing a multi-megabyte file for nothing
    if (/"splitPointerTables"\s*:\s*\[\s*\{/u.test(text)) {
      const parsed = JSON.parse(text) as { codeSemantics?: { splitPointerTables?: RawFact[] } };
      facts = parsed.codeSemantics?.splitPointerTables ?? [];
    }
  } catch { /* an unreadable analysis has no obligations; the tool that reads it says so */ }
  factCache.set(analysisPath, { stamp, facts });
  return facts;
}

interface AnnotationDecision { lo: number; hi: number; how: "declared" | "rejected" }

function readDecisions(annotationsPath: string | undefined): AnnotationDecision[] {
  if (!annotationsPath || !existsSync(annotationsPath)) return [];
  try {
    const doc = JSON.parse(readFileSync(annotationsPath, "utf8")) as { splitTables?: unknown };
    if (!Array.isArray(doc.splitTables)) return [];
    const out: AnnotationDecision[] = [];
    for (const raw of doc.splitTables as Array<Record<string, unknown>>) {
      const lo = parseHexLoose(raw?.lo);
      const hi = parseHexLoose(raw?.hi);
      if (lo === undefined || hi === undefined) continue;
      if (raw.reject !== undefined) {
        if (typeof raw.reject === "string" && raw.reject.trim() !== "") out.push({ lo, hi, how: "rejected" });
        continue;
      }
      if (typeof raw.count === "number" && Number.isInteger(raw.count) && raw.count >= 1) out.push({ lo, hi, how: "declared" });
    }
    return out;
  } catch {
    return [];
  }
}

function parseHexLoose(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/^\$/u, "").replace(/^0x/iu, "");
  return /^[0-9a-fA-F]{1,4}$/u.test(t) ? parseInt(t, 16) : undefined;
}

/** The obligations of one analysis, against the annotations that may decide them. */
export function splitObligationsFromFiles(analysisPath: string, annotationsPath?: string): SplitObligationReport {
  const decisions = readDecisions(annotationsPath);
  const report: SplitObligationReport = {
    analysisPath, ...(annotationsPath ? { annotationsPath } : {}), open: [], closed: [], probable: [],
  };
  const seen = new Set<string>();
  const confirmedFirst = [...readFacts(analysisPath)].sort((a, b) =>
    Number(b.provenance === "confirmed_code") - Number(a.provenance === "confirmed_code") || (a.start ?? 0) - (b.start ?? 0));
  for (const f of confirmedFirst) {
    if (typeof f.lowTableBase !== "number" || typeof f.highTableBase !== "number") continue;
    const key = `${f.lowTableBase}:${f.highTableBase}`;
    if (seen.has(key)) continue; // an analysis written before the detector deduplicated lists a pair twice
    seen.add(key);
    const o: SplitObligation = {
      lo: f.lowTableBase, hi: f.highTableBase,
      shape: f.shape ?? "zp_pointer",
      indexRegister: f.indexRegister ?? "x",
      sampleTargets: f.sampleTargets ?? [],
      ...(typeof f.countHint === "number" ? { countHint: f.countHint } : {}),
      ...(typeof f.adjustHint === "number" ? { adjustHint: f.adjustHint } : {}),
      codeStart: f.start ?? 0, codeEnd: f.end ?? 0,
      ...(typeof f.pointerBase === "number" ? { pointerBase: f.pointerBase } : {}),
    };
    if (f.provenance !== "confirmed_code") { report.probable.push({ ...o, why: "probable-code" }); continue; }
    // two bytes loaded from two tables and only read as bytes are not an address table; an analysis
    // written before the check carries no `pointerUsed` and keeps the old reading
    if (o.shape === "zp_pointer" && f.pointerUsed === false) { report.probable.push({ ...o, why: "no-pointer-use" }); continue; }
    const decision = decisions.find((d) => d.lo === o.lo && d.hi === o.hi);
    if (decision) report.closed.push({ ...o, how: decision.how });
    else report.open.push(o);
  }
  report.open.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  return report;
}

/** One obligation as a line a reader can act on. */
export function describeObligation(o: SplitObligation): string {
  const shape = o.shape === "rts_dispatch" ? "RTS dispatch" : o.shape === "self_mod_operand" ? "patched operand" : "zero-page pointer";
  const hints = [
    o.countHint !== undefined ? `count hint ${o.countHint}` : "no count hint",
    ...(o.adjustHint !== undefined ? [`adjust ${o.adjustHint}`] : []),
  ].join(", ");
  const samples = o.sampleTargets.length > 0 ? `; first targets ${o.sampleTargets.slice(0, 4).map(hex4).join(" ")}` : "";
  return `${hex4(o.lo)} / ${hex4(o.hi)}  ${shape}, index ${o.indexRegister.toUpperCase()}, read at ${hex4(o.codeStart)}-${hex4(o.codeEnd)} (${hints}${samples})`;
}

/** The two ways to close one, written for the entry that is being asked about. */
export function closingExample(o: SplitObligation): string {
  const count = o.countHint ?? "<entries>";
  const adjust = o.adjustHint ? `, "adjust": ${o.adjustHint}` : "";
  const pair = `"lo": "${hex4(o.lo).slice(1)}", "hi": "${hex4(o.hi).slice(1)}"`;
  return `declare: splitTables: [{ ${pair}, "count": ${count}${adjust} }]  or  reject: splitTables: [{ ${pair}, "reject": "<why this is not a pointer table>" }]`;
}

/** The block `analyze` / `disasm` end with. Empty when the analysis holds nothing to say. */
export function formatObligationBlock(report: SplitObligationReport): string {
  if (report.open.length === 0 && report.closed.length === 0 && report.probable.length === 0) return "";
  const lines: string[] = [];
  if (report.open.length > 0) {
    lines.push(
      `Split tables: ${report.open.length} OPEN — found in confirmed code and not yet decided. `
      + `agent_advance_phase refuses to take this artifact past phase 5 until each is declared or rejected.`,
    );
    for (const o of report.open) lines.push(`  ${describeObligation(o)}`);
    lines.push(
      "  Close each with a splitTables[] entry in the annotations (write_annotations / merge_annotations), e.g.:",
      `    ${closingExample(report.open[0]!)}`,
      "  `count` is how many entries the index reaches (read the code that bounds it); `adjust` is 1 for an RTS dispatch; `base` names the label the entries are offsets from.",
    );
  } else {
    lines.push(`Split tables: 0 open (${report.closed.length} decided).`);
  }
  if (report.closed.length > 0 && report.open.length > 0) {
    lines.push(`  decided: ${report.closed.map((c) => `${hex4(c.lo)}/${hex4(c.hi)} ${c.how}`).join(", ")}`);
  }
  if (report.probable.length > 0) {
    const fromProbable = report.probable.filter((p) => p.why !== "no-pointer-use");
    const noPointer = report.probable.filter((p) => p.why === "no-pointer-use");
    if (fromProbable.length > 0) lines.push(`  from probable code, listed and NOT an obligation: ${fromProbable.map((p) => `${hex4(p.lo)}/${hex4(p.hi)}`).join(", ")}`);
    if (noPointer.length > 0) {
      lines.push(
        `  probable, listed and NOT an obligation — the zero-page pair is never used as a pointer ((zp),y, (zp,x), jmp (zp)): `
        + `${noPointer.map((p) => `${hex4(p.lo)}/${hex4(p.hi)}${p.pointerBase !== undefined ? ` -> $${p.pointerBase.toString(16).toUpperCase().padStart(2, "0")}/$${((p.pointerBase + 1) & 0xff).toString(16).toUpperCase().padStart(2, "0")}` : ""}`).join(", ")}`,
        "  (coordinates, width/height?) Declare or reject one with a splitTables[] entry if you read it differently.",
      );
    }
  }
  lines.push(`  ${SPLIT_LIMIT_SENTENCE}`);
  return lines.join("\n");
}

// ------------------------------------------------------------- the project

export interface ArtifactObligations {
  artifact: ArtifactRecord;
  report: SplitObligationReport;
}

const stemOf = (p: string): string => basename(p).replace(/\.[^./]+$/u, "");

/** Where the annotations for a source may sit — the order the renderer looks in. */
function annotationCandidates(sourcePath: string, analysisPath: string, listingPaths: string[]): string[] {
  const beside = (p: string): string[] => [
    join(dirname(p), `${stemOf(p)}_annotations.json`),
    join(dirname(p), "annotations.json"),
  ];
  return [
    ...beside(sourcePath),
    ...listingPaths.flatMap(beside),
    ...beside(analysisPath),
    // propose_annotations leaves its draft under the PRG's name in the output folder
    ...listingPaths.map((l) => join(dirname(l), `${stemOf(sourcePath)}_annotations.json`)),
  ];
}

/**
 * Every artifact the project holds an analysis for, with its obligations. Only artifacts that
 * have something to say are returned (an obligation open, decided or probable).
 */
export function projectSplitObligations(artifacts: ArtifactRecord[]): ArtifactObligations[] {
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const analysisByArtifact = new Map<string, ArtifactRecord>();
  for (const a of artifacts) {
    const isAnalysis = a.role === "analysis-json" || a.role === "prg-analysis";
    if (!isAnalysis || (a.format !== undefined && a.format !== "json") || !a.path || !existsSync(a.path)) continue;
    for (const sid of a.sourceArtifactIds ?? []) {
      const source = byId.get(sid);
      if (!source) continue;
      const have = analysisByArtifact.get(sid);
      // the newest analysis of the same bytes is a refinement of the older, not a competitor
      if (!have || String(a.updatedAt ?? "").localeCompare(String(have.updatedAt ?? "")) > 0) analysisByArtifact.set(sid, a);
    }
  }
  const out: ArtifactObligations[] = [];
  for (const [sid, analysis] of analysisByArtifact) {
    const source = byId.get(sid)!;
    if (!source.path) continue;
    const listings = artifacts
      .filter((l) => l.path && (l.sourceArtifactIds ?? []).includes(sid) && /\.(asm|tas|tass)$/iu.test(l.path))
      .map((l) => l.path!);
    const annotations = annotationCandidates(source.path, analysis.path!, listings).find((c) => existsSync(c));
    const report = splitObligationsFromFiles(analysis.path!, annotations);
    if (report.open.length + report.closed.length + report.probable.length > 0) out.push({ artifact: source, report });
  }
  return out;
}

/**
 * The open obligations that bind a given artifact id. The id may name the source bytes or
 * anything derived from them (their listing, their analysis): the work is the same bytes.
 */
export function openObligationsFor(artifacts: ArtifactRecord[], artifactId: string): ArtifactObligations[] {
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const target = byId.get(artifactId);
  const ids = new Set<string>([artifactId, ...(target?.sourceArtifactIds ?? [])]);
  return projectSplitObligations(artifacts).filter((o) => ids.has(o.artifact.id) && o.report.open.length > 0);
}

/** The refusal text, listing every open obligation of the artifact. */
export function formatPhaseRefusal(artifactTitle: string, toPhase: number, found: ArtifactObligations[]): string {
  const lines = [
    `REFUSED — ${artifactTitle} cannot move past phase 5 (asked for phase ${toPhase}) while a found split table is undecided.`,
    "",
  ];
  for (const f of found) {
    for (const o of f.report.open) lines.push(`  ${describeObligation(o)}`);
    lines.push(`  (from ${basename(f.report.analysisPath)})`);
  }
  lines.push(
    "",
    "Phase 5 is \"annotations written, rebuild byte-identical\"; a table the analysis found in confirmed code and nobody declared or rejected is exactly what that phase leaves unfinished.",
    "Close each with a splitTables[] entry — declare it ({ lo, hi, count, adjust?, base? }) or reject it ({ lo, hi, reject: \"why this is not a pointer table\" }) — via write_annotations / merge_annotations, then run disasm so the listing and the graph take it.",
    found[0]?.report.open[0] ? `e.g. ${closingExample(found[0].report.open[0])}` : "",
    "",
    SPLIT_LIMIT_SENTENCE,
  );
  return lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n");
}
