// The project-wide seed pass: every `_analysis.json` on disk through 819
// (control flow), 820 (memory access), 826.0 T2 (RESOLVES_TO) and 826
// (signatures) — the thing `c64re graph seed` does, as a library.
//
// It lived inside the CLI verb, which is why it had exactly one door. The
// cut-over (822.2) folds a legacy project's JSON stores in and produced the
// human layer and the 822 segment/entry rows and NOTHING ELSE: every artifact
// that was not re-analysed after the cut had no control-flow edge at all, so
// `graph_edges` answered nothing about code that was fully disassembled and
// annotated on disk. Measured on a peer project: 24 of 25 owners, and the one
// that answered was the one artifact that session had re-run.
//
// So the pass is a module, and both the CLI verb and `ensureCutover` call it.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ownerFromAnalysisPath, seedControlFlow, type SeedControlFlowResult } from "./control-flow.js";
import { contextForOwner, type OwnerContext } from "./machine.js";
import { seedMemoryAccess, type SeedMemoryAccessResult } from "./memory-access.js";
import { resolveAddresses, type ResolveResult } from "./resolve.js";
import { seedSignatures, type SeedSignaturesResult } from "./signatures.js";
import { GraphStore } from "../store.js";

/**
 * Spec 830 D4 — `artifacts/generated/` is never walked.
 *
 * Registration mirrors every payload's analysis to
 * `artifacts/generated/payloads/<entity-id>/<stem>_analysis.json`. That is a
 * COPY, and it can be an old one. The owner comes from the file STEM, so the
 * mirror seeds every owner a second time; `"…/analysis/…"` sorts before
 * `"…/artifacts/…"`, the replacement unit is (producer, run_owner), and the
 * STALE copy therefore lands last and wins. Measured on Neuromancer: owner
 * `02_a` seeded once with routines=14 labels=25 and once with routines=8
 * labels=11, and the second one is what the graph kept — so routines had no
 * extents, `graph boundaries` invented splits, and every byte-coverage number
 * was wrong. Nothing in the output said two files had claimed one owner.
 */
const GENERATED_MIRROR = join("artifacts", "generated");

export function findAnalysisJsons(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (p.includes(GENERATED_MIRROR)) continue;
      findAnalysisJsons(p, out, depth + 1);
    }
    else if (entry.endsWith("_analysis.json")) out.push(p);
  }
  return out.sort();
}

/**
 * Spec 830 D5 — two files claiming one owner is an error, not a race.
 *
 * D4 removes the known source of duplicates; the CLASS is "some other copy of
 * a `_analysis.json` is lying around", and last-write-wins is silent. A graph
 * that is quietly wrong is worse than a seed that stops and says why.
 */
export function assertOneFilePerOwner(projectDir: string, files: string[], ownerOf: (path: string) => string): void {
  const byOwner = new Map<string, string[]>();
  for (const file of files) {
    const owner = ownerOf(file);
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), file]);
  }
  const clashes = [...byOwner.entries()].filter(([, paths]) => paths.length > 1).sort();
  if (clashes.length === 0) return;

  const rel = (p: string) => (p.startsWith(projectDir) ? p.slice(projectDir.length).replace(/^\/+/, "") : p);
  const detail = clashes
    .map(([owner, paths]) => `two analysis files claim owner "${owner}":\n${paths.map((p) => `  ${rel(p)}`).join("\n")}`)
    .join("\n");
  throw new Error(
    `${detail}\nThe last one seeded would silently win and the graph would hold it. ` +
    `Seed one owner at a time (--owner <owner>) or move the copy out of the project.`,
  );
}

export interface SeedProjectOptions {
  projectDir: string;
  /** only the analyses whose stem ends in this owner */
  owner?: string;
  /** at most this many analysis files this pass; the rest come back as `deferred` */
  maxFiles?: number;
  /** stop STARTING files once this much wall clock has gone; the one running finishes */
  budgetMs?: number;
  /** skip owners the graph already holds 819 rows for — makes an interrupted pass resumable */
  skipSeeded?: boolean;
  /** a file whose producers throw is recorded in `failed` and the pass continues (default: throw) */
  continueOnError?: boolean;
}

export interface SeedProjectOwnerResult {
  owner: string;
  path: string;
  machine: OwnerContext;
  controlFlow: SeedControlFlowResult;
  memoryAccess: SeedMemoryAccessResult;
}

export interface SeedProjectResult {
  files: number;
  seeded: SeedProjectOwnerResult[];
  /** owners already carrying 819 rows (skipSeeded) */
  skipped: string[];
  /** owners the budget did not reach — `c64re graph seed` finishes them */
  deferred: string[];
  failed: Array<{ owner: string; path: string; error: string }>;
  resolve?: ResolveResult;
  signatures?: SeedSignaturesResult;
  ms: number;
}

/** The owners the graph already has control flow for. */
function seededOwners(projectDir: string): Set<string> {
  try {
    const store = GraphStore.open(projectDir, { readOnly: true });
    try {
      const rows = store.db.prepare("SELECT DISTINCT owner FROM edges WHERE layer = 'generated' AND producer = '819' AND owner IS NOT NULL").all() as Array<{ owner: string }>;
      return new Set(rows.map((r) => r.owner));
    } finally { store.close(); }
  } catch {
    return new Set(); // no graph yet — nothing is seeded
  }
}

/**
 * Run the producers over the analyses on disk.
 *
 * Without `maxFiles`/`budgetMs` this is the `c64re graph seed` pass exactly:
 * every file, then one project-wide RESOLVES_TO and one project-wide signature
 * pass. With a budget it stops cleanly and NAMES what it did not reach, because
 * a partial graph that says so is usable and a partial graph that does not is
 * the defect this module exists for.
 */
export function seedProject(options: SeedProjectOptions): SeedProjectResult {
  const t0 = process.hrtime.bigint();
  const { projectDir } = options;
  const all = options.owner
    ? findAnalysisJsons(projectDir).filter((p) => p.toLowerCase().endsWith(`${options.owner}_analysis.json`))
    : findAnalysisJsons(projectDir);
  if (all.length === 0) throw new Error(`no _analysis.json under ${projectDir}${options.owner ? ` for owner ${options.owner}` : ""}`);
  // Spec 830 D5 — before anything is written, not after half of it is
  assertOneFilePerOwner(projectDir, all, ownerFromAnalysisPath);

  const already = options.skipSeeded ? seededOwners(projectDir) : new Set<string>();
  const seeded: SeedProjectOwnerResult[] = [];
  const skipped: string[] = [];
  const deferred: string[] = [];
  const failed: SeedProjectResult["failed"] = [];
  const maxFiles = options.maxFiles ?? Infinity;
  const budgetMs = options.budgetMs ?? Infinity;
  const elapsed = () => Number(process.hrtime.bigint() - t0) / 1e6;

  for (const analysisPath of all) {
    const owner = ownerFromAnalysisPath(analysisPath);
    if (already.has(owner)) { skipped.push(owner); continue; }
    if (seeded.length >= maxFiles || elapsed() >= budgetMs) { deferred.push(owner); continue; }
    try {
      // 826.0 T7 — the owner's machine: declared, or the C64 with a hint when the path smells of the drive
      const machine = contextForOwner(projectDir, owner, undefined, analysisPath);
      const controlFlow = seedControlFlow({ projectDir, analysisPath, owner, ctx: machine.ctx });
      const memoryAccess = seedMemoryAccess({ projectDir, analysisPath, owner, ctx: machine.ctx });
      seeded.push({ owner, path: analysisPath, machine, controlFlow, memoryAccess });
    } catch (error) {
      if (!options.continueOnError) throw error;
      failed.push({ owner, path: analysisPath, error: error instanceof Error ? error.message : String(error) });
    }
  }

  let resolved: ResolveResult | undefined;
  let signatures: SeedSignaturesResult | undefined;
  if (seeded.length > 0) {
    // 826.0 T2 — one project-wide pass after every owner is in
    resolved = resolveAddresses(projectDir);
    // 826 — signatures, after the aliases exist (a cross-owner callee's summary
    // needs RESOLVES_TO). The project-wide form re-reads EVERY analysis file, so
    // a budgeted pass signs only what it actually seeded; otherwise the budget
    // would be spent on exactly the files it decided to skip.
    try {
      signatures = deferred.length === 0 && failed.length === 0 && !options.owner
        ? seedSignatures({ projectDir })
        : signOneByOne(projectDir, seeded);
    } catch (error) {
      if (!options.continueOnError) throw error;
      failed.push({ owner: "(signatures)", path: projectDir, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { files: all.length, seeded, skipped, deferred, failed, resolve: resolved, signatures, ms: elapsed() };
}

function signOneByOne(projectDir: string, seeded: SeedProjectOwnerResult[]): SeedSignaturesResult {
  const merged: SeedSignaturesResult = { owners: [], routines: 0, signed: 0, partial: 0, unknownStack: 0, passes: 0, dispatches: 0, sccRounds: 0, ms: 0 };
  for (const s of seeded) {
    const r = seedSignatures({ projectDir, analysisPath: s.path });
    merged.owners.push(...r.owners);
    merged.routines += r.routines; merged.signed += r.signed; merged.partial += r.partial;
    merged.unknownStack += r.unknownStack; merged.passes += r.passes; merged.dispatches += r.dispatches;
    merged.sccRounds = Math.max(merged.sccRounds, r.sccRounds); merged.ms += r.ms;
  }
  return merged;
}

/** One line per owner, the shape `c64re graph seed` has always printed. */
export function formatSeedProject(r: SeedProjectResult): string {
  const lines = r.seeded.map((s) =>
    `${s.owner.padEnd(40)} ${s.machine.machine} (${s.machine.source}) | 819: routines=${s.controlFlow.routines} labels=${s.controlFlow.labels} edges=${JSON.stringify(s.controlFlow.edges)} ${s.controlFlow.ms.toFixed(0)}ms | 820: edges=${JSON.stringify(s.memoryAccess.edges)} indirect-resolved=${s.memoryAccess.indirectResolved} ${s.memoryAccess.ms.toFixed(0)}ms`);
  if (r.resolve) lines.push(`826.0 resolve: addr nodes=${r.resolve.addrNodes} RESOLVES_TO=${r.resolve.resolved} ambiguous=${r.resolve.ambiguous} ${r.resolve.ms.toFixed(0)}ms`);
  if (r.signatures) lines.push(`826 signatures: routines=${r.signatures.routines} signed=${r.signatures.signed} partial=${r.signatures.partial} unknown-stack=${r.signatures.unknownStack} passes=${r.signatures.passes} dispatches=${r.signatures.dispatches} ${r.signatures.ms.toFixed(0)}ms`);
  if (r.skipped.length) lines.push(`skipped (already seeded): ${r.skipped.join(", ")}`);
  if (r.deferred.length) lines.push(`NOT SEEDED — budget: ${r.deferred.join(", ")}\nfinish them with: c64re graph seed --project <dir>`);
  for (const f of r.failed) lines.push(`FAILED ${f.owner}: ${f.error}`);
  for (const s of r.seeded) if (s.machine.hint) lines.push(`HINT ${s.machine.hint}`);
  return lines.join("\n");
}
