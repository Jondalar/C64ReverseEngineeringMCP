// Spec 822.2 — the cut-over switch. Opening a project whose knowledge/ still
// holds the legacy JSON stores for the migrated record types runs the
// migration once (idempotent by the ledger, logged to the timeline) and moves
// the files to knowledge/_legacy-822/ — read-only archaeology for one release
// (OQ4), never read by a writer again. Projects created after the cut never
// had the files; the fast path is five existsSync calls.
//
// Not a dual-write window: on this branch every reader and writer of the six
// record types goes to graph.sqlite unconditionally, so the only state the
// switch carries is WHETHER the legacy files have been folded in. The stamp
// (`meta.cutover_at`) records when.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { graphPath } from "./store.js";
import { seedProject, type SeedProjectResult } from "./producers/seed-project.js";
import { LEGACY_DIR, LEGACY_STORE_FILES, migrateProject, type MigrateSummary } from "./migrate/migrate.js";

export interface CutoverResult {
  /** legacy files found in knowledge/ and folded into the graph */
  migrated: string[];
  summary?: MigrateSummary;
  legacyDir?: string;
  /** the structure pass that ran after the fold (819/820/826) */
  seed?: SeedProjectResult;
  /** why no structure was built, when none was */
  seedNote?: string;
}

/** The legacy store files (of the six) still sitting live in knowledge/. */
export function pendingLegacyFiles(projectDir: string): string[] {
  const knowledge = join(projectDir, "knowledge");
  return LEGACY_STORE_FILES.filter((f) => existsSync(join(knowledge, f)));
}

/**
 * Fold any live legacy JSON stores into the graph and park them under
 * knowledge/_legacy-822/. Returns what it did; a no-op returns `migrated: []`.
 * Requires knowledge/project.json (the slug the ids derive from) — a directory
 * with legacy files but no project is left alone until project_init.
 */
export function ensureCutover(projectDir: string): CutoverResult {
  const pending = pendingLegacyFiles(projectDir);
  if (pending.length === 0) return { migrated: [] };
  const knowledge = join(projectDir, "knowledge");
  if (!existsSync(join(knowledge, "project.json"))) return { migrated: [] };
  const summary = migrateProject({ projectDir });
  const legacyDir = join(knowledge, LEGACY_DIR);
  mkdirSync(legacyDir, { recursive: true });
  const moved: string[] = [];
  for (const f of pending) {
    const from = join(knowledge, f);
    const to = join(legacyDir, f);
    if (!existsSync(from)) continue;
    if (existsSync(to)) {
      // a second cut-over of the same file name (a re-created legacy file): keep the older copy, stamp the new one
      renameSync(from, join(legacyDir, `${f}.${Date.now()}.json`));
    } else renameSync(from, to);
    moved.push(f);
  }
  const readme = join(legacyDir, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(readme, [
      "# knowledge/_legacy-822/",
      "",
      "The JSON stores Spec 822 migrated into `knowledge/graph.sqlite` (findings, entities,",
      "relations, open-questions, labels.user). Nothing reads or writes these files any more;",
      "they are kept for one release for `git diff` archaeology (Spec 822 §6, OQ4). Every",
      "legacy id is in `migration_log` in the graph (`c64re graph stats`), and",
      "`c64re graph export` writes the graph back into this record shape on demand.",
      "",
      `Cut over: ${summary.cutoverAt} (migration run ${summary.runId}, ${summary.ms.toFixed(0)} ms).`,
      "",
    ].join("\n"));
  }
  const { seed, seedNote } = seedStructure(projectDir);
  appendCutoverTimeline(projectDir, moved, summary, seed, seedNote);
  return { migrated: moved, summary, legacyDir, seed, seedNote };
}

/**
 * The structure layer, right after the fold.
 *
 * `migrateProject` produces the human layer and 822's segment / entry / payload
 * rows. It produces no control flow whatsoever, because the producers hang off
 * `importAnalysisArtifact()` and nothing here ever called them. A project cut
 * over by `agent_onboard` therefore came out with prose and no edges: measured
 * on a peer project, `graph_edges` answered for exactly one of twenty-five
 * owners — the one artifact that session happened to re-analyse after the cut.
 * A `jmp $09B8` sitting in plain text in the listing had no JUMPS_TO and the
 * target had no node at all.
 *
 * Additive, in the spirit of the 818 D10 call site in `importAnalysisArtifact`:
 * this writes only knowledge/graph.sqlite, and a failure here never undoes the
 * cut-over that already happened — the files are moved, the ledger is written,
 * and the only cost of a failed seed is that the structure is missing, which is
 * the state before this existed anyway.
 *
 * THE COST. A cut-over is the first thing a session does, so this must not turn
 * `agent_onboard` into a two-minute stall. The decision: seed on a budget —
 * `C64RE_CUTOVER_SEED_MAX_FILES` analyses (default 40) and
 * `C64RE_CUTOVER_SEED_BUDGET_MS` of wall clock (default 60 s) — and NAME what
 * the budget did not reach, in the return value and in the timeline note, with
 * the command that finishes it. A corpus project that needs more than that gets
 * a graph that is right as far as it goes and says where it stops; it does not
 * get a silent half. `C64RE_CUTOVER_SEED=0` turns the pass off entirely.
 * `skipSeeded` makes it resumable: an owner that already has 819 rows is not
 * re-seeded, so running `c64re graph seed` afterwards costs only the remainder.
 */
function seedStructure(projectDir: string): { seed?: SeedProjectResult; seedNote?: string } {
  if (process.env.C64RE_CUTOVER_SEED === "0") return { seedNote: "C64RE_CUTOVER_SEED=0 — no structure seeded; run `c64re graph seed`" };
  const num = (key: string, fallback: number) => {
    const raw = process.env[key];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  try {
    const seed = seedProject({
      projectDir,
      skipSeeded: true,
      continueOnError: true,
      maxFiles: num("C64RE_CUTOVER_SEED_MAX_FILES", 40),
      budgetMs: num("C64RE_CUTOVER_SEED_BUDGET_MS", 60_000),
    });
    return { seed };
  } catch (error) {
    // "no _analysis.json under …" is the ordinary case for a project that has
    // knowledge but no disassembly yet, and it is not a failure of the cut-over.
    return { seedNote: `no structure seeded: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** One line for the timeline and for whoever reads the CutoverResult. */
export function describeCutoverSeed(seed?: SeedProjectResult, note?: string): string {
  if (!seed) return note ?? "no structure seeded";
  const edges = seed.seeded.reduce((a, s) => a + Object.values(s.controlFlow.edges).reduce((x, y) => x + y, 0), 0);
  const parts = [`${seed.seeded.length}/${seed.files} analyses seeded (${edges} control-flow edges, ${seed.ms.toFixed(0)} ms)`];
  if (seed.skipped.length) parts.push(`${seed.skipped.length} already seeded`);
  if (seed.failed.length) parts.push(`${seed.failed.length} failed: ${seed.failed.map((f) => `${f.owner} (${f.error})`).join("; ")}`);
  if (seed.deferred.length) parts.push(`${seed.deferred.length} NOT seeded — budget reached: ${seed.deferred.join(", ")}. Finish with \`c64re graph seed\``);
  return parts.join("; ");
}

function appendCutoverTimeline(projectDir: string, moved: string[], summary: MigrateSummary, seed?: SeedProjectResult, seedNote?: string): void {
  // knowledge/timeline.jsonl is append-only JSON lines (ProjectKnowledgeStorage.appendTimelineEvent);
  // written directly here so the cut-over does not depend on the service that triggers it.
  const path = join(projectDir, "session", "timeline.jsonl");
  if (!existsSync(join(projectDir, "session"))) return;
  const totals = Object.values(summary.stores).reduce((acc, s) => ({ created: acc.created + s.created, merged: acc.merged + s.merged, folded: acc.folded + s.folded, already: acc.already + s.already }), { created: 0, merged: 0, folded: 0, already: 0 });
  const event = {
    id: `timeline-822-cutover-${Date.now().toString(36)}`,
    kind: "note",
    title: "Spec 822 cut-over: legacy knowledge JSON folded into graph.sqlite",
    summary: `${moved.join(", ") || "(no files)"} → knowledge/${LEGACY_DIR}/; ${totals.created} created, ${totals.merged} merged, ${totals.folded} folded, ${totals.already} already in the ledger (run ${summary.runId}, ${summary.ms.toFixed(0)} ms). Structure: ${describeCutoverSeed(seed, seedNote)}`,
    payload: {
      moved, runId: summary.runId, cutoverAt: summary.cutoverAt, stores: summary.stores, graph: summary.graph,
      seed: seed
        ? { files: seed.files, seeded: seed.seeded.map((s) => s.owner), skipped: seed.skipped, deferred: seed.deferred, failed: seed.failed, ms: seed.ms }
        : { note: seedNote },
    },
    createdAt: new Date().toISOString(),
  };
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    writeFileSync(path, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${JSON.stringify(event)}\n`);
  } catch { /* the cut-over itself succeeded; the note is best effort */ }
}

export function isCutOver(projectDir: string): boolean {
  return existsSync(graphPath(projectDir)) && pendingLegacyFiles(projectDir).length === 0;
}
