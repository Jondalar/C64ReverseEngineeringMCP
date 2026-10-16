// The candidate as project memory — one file per candidate under <project>/knowledge/candidates.
//
// A candidate is the record of a feature file's runs: the scenario it came from, the anchor it started
// at, the variants tried from there (each with the bytes it puts in the machine and what the last run
// of it did), the history of every run of that file and the choice. Records written before the feature
// file existed hold an input script and a cycle budget instead and no feature; they stay readable and
// can still be chosen, derived and verified. By the Leitregel the record is meaning and memory — it
// lives here, in the project, beside the graph that links it to its anchor and to the feature.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeSegment } from "../lib/id-path.js";

export type PatchSpace = "ram" | "roml" | "romh";

/** One place a variant writes: the bytes as assembled, and the source they came from. */
export interface VariantTarget {
  space: PatchSpace;
  /** cartridge bank; absent for ram */
  bank?: number;
  /** CPU-space address (for roml/romh the window address) */
  addr: number;
  /** the source text the bytes were assembled from; empty when the bytes were given directly */
  source: string;
  /** where the source was read from, relative to the project, when it came from a file */
  sourcePath?: string;
  bytes: number[];
}

/** What one run of a variant did, against the run without any patch. */
export interface Verdict {
  /** the runtime's end-state id of the variant's run (valid only while the daemon lives) */
  endStateId?: string;
  state: "done" | "failed";
  message?: string;
  cycles?: number;
  registers?: Record<string, number>;
  ramDigest?: string;
  /** component_diff against the baseline, equivalence preset */
  identical?: boolean;
  differing?: string[];
  /** one line per differing component: what moved */
  changes?: string[];
  inputsPlayed?: number;
  inputsSkipped?: number;
  ranAt: string;
}

/** How one run of a scenario came out: the `Then` lines decide, nothing else does. */
export type RunVerdict = "PASS" | "FAIL" | "ERROR" | "UNCHECKED";

export interface RunCheck {
  line?: number;
  text: string;
  pass: boolean;
  actual: string;
}

/** A stretch of memory that differs from the run without a fix at the end of the run. */
export interface SideEffect {
  space: "ram" | "io";
  from: number;
  to: number;
}

export interface RunResult {
  verdict: RunVerdict;
  /** Why, for FAIL on a wait and for ERROR. */
  reason?: string;
  checks: RunCheck[];
  /** Absent for the run without a fix, and when there was nothing to compare against. */
  sideEffects?: SideEffect[];
  cycles?: number;
  pc?: number;
  ranAt: string;
}

export interface Variant {
  name: string;
  targets: VariantTarget[];
  /** An old record's verdict: a whole-machine difference against the baseline. */
  verdict?: Verdict;
  /** The last run of the feature file this variant came from. */
  result?: RunResult;
}

/** The scenario a candidate is the record of. */
export interface FeatureRef {
  /** Relative to the project when it lies inside it, else as given. "(inline)" for text passed to the tool. */
  path: string;
  scenario: string;
  line: number;
  /** The scenario's file text, kept only when it was passed inline. */
  text?: string;
}

export interface HistoryEntry {
  ranAt: string;
  baseline: RunResult;
  variants: Array<{ name: string } & RunResult>;
}

export interface DeltaRecord {
  outDir: string;
  files: string[];
  artifactIds: string[];
  derivedAt: string;
}

export interface BuildCheck {
  ok: boolean;
  checkedAt: string;
  image: string;
  format: string;
  buildRan: boolean;
  /** red only: the first address that differs or is missing */
  firstDiff?: { addr: number; space: string; bank?: number; built?: number; expected: number; reason: string };
  targets: Array<{ space: string; bank?: number; addr: number; length: number; ok: boolean }>;
}

export interface Candidate {
  id: string;
  title?: string;
  /** the anchor's name as the caller gave it (a mark name, or a checkpoint id) */
  anchor: string;
  /** the ring checkpoint behind it when it was created; valid for the daemon's life */
  anchorId?: string;
  anchorCycle?: number;
  anchorFrame?: number;
  /** An old record's input script, cycles relative to the anchor: [{atCycle, kind, payload}]. Absent in a feature run's. */
  inputs?: unknown[];
  /** An old record's cycle budget. Absent in a feature run's. */
  cycleBudget?: number;
  /** Set on the record of a feature file's runs. */
  feature?: FeatureRef;
  variants: Variant[];
  /** An old record's baseline run. */
  baseline?: Verdict;
  /** The run without a fix, from the last run of the feature file. */
  baselineResult?: RunResult;
  /** One entry per run of the same file and scenario, oldest first. */
  history?: HistoryEntry[];
  chosen?: string;
  delta?: DeltaRecord;
  build?: BuildCheck;
  createdAt: string;
  updatedAt: string;
}

export function candidatesDir(projectDir: string): string {
  return join(projectDir, "knowledge", "candidates");
}

export function candidateFile(projectDir: string, id: string): string {
  return join(candidatesDir(projectDir), `${safeSegment(id)}.json`);
}

/** Where assembled scratch for a candidate goes (sources written from inline text, built PRGs). */
export function candidateScratchDir(projectDir: string, id: string): string {
  return join(candidatesDir(projectDir), `${safeSegment(id)}.build`);
}

export function loadCandidate(projectDir: string, id: string): Candidate | undefined {
  const f = candidateFile(projectDir, id);
  if (!existsSync(f)) return undefined;
  return JSON.parse(readFileSync(f, "utf8")) as Candidate;
}

export function listCandidates(projectDir: string): Candidate[] {
  const dir = candidatesDir(projectDir);
  if (!existsSync(dir)) return [];
  const out: Candidate[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    try { out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as Candidate); } catch { /* a file that is not ours */ }
  }
  return out;
}

export function saveCandidate(projectDir: string, cand: Candidate): Candidate {
  const dir = candidatesDir(projectDir);
  mkdirSync(dir, { recursive: true });
  cand.updatedAt = new Date().toISOString();
  const f = candidateFile(projectDir, cand.id);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cand, null, 2)}\n`);
  renameSync(tmp, f);
  return cand;
}

export function deleteCandidate(projectDir: string, id: string): boolean {
  const f = candidateFile(projectDir, id);
  const had = existsSync(f);
  rmSync(f, { force: true });
  rmSync(candidateScratchDir(projectDir, id), { recursive: true, force: true });
  return had;
}

/** `cand-1`, `cand-2` … — the next number nobody has used in this project. */
export function nextCandidateId(projectDir: string): string {
  let n = 0;
  for (const c of listCandidates(projectDir)) {
    const m = /^cand-(\d+)$/u.exec(c.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `cand-${n + 1}`;
}
