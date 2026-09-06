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
import { LEGACY_DIR, LEGACY_STORE_FILES, migrateProject, type MigrateSummary } from "./migrate/migrate.js";

export interface CutoverResult {
  /** legacy files found in knowledge/ and folded into the graph */
  migrated: string[];
  summary?: MigrateSummary;
  legacyDir?: string;
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
  appendCutoverTimeline(projectDir, moved, summary);
  return { migrated: moved, summary, legacyDir };
}

function appendCutoverTimeline(projectDir: string, moved: string[], summary: MigrateSummary): void {
  // knowledge/timeline.jsonl is append-only JSON lines (ProjectKnowledgeStorage.appendTimelineEvent);
  // written directly here so the cut-over does not depend on the service that triggers it.
  const path = join(projectDir, "session", "timeline.jsonl");
  if (!existsSync(join(projectDir, "session"))) return;
  const totals = Object.values(summary.stores).reduce((acc, s) => ({ created: acc.created + s.created, merged: acc.merged + s.merged, folded: acc.folded + s.folded, already: acc.already + s.already }), { created: 0, merged: 0, folded: 0, already: 0 });
  const event = {
    id: `timeline-822-cutover-${Date.now().toString(36)}`,
    kind: "note",
    title: "Spec 822 cut-over: legacy knowledge JSON folded into graph.sqlite",
    summary: `${moved.join(", ") || "(no files)"} → knowledge/${LEGACY_DIR}/; ${totals.created} created, ${totals.merged} merged, ${totals.folded} folded, ${totals.already} already in the ledger (run ${summary.runId}, ${summary.ms.toFixed(0)} ms)`,
    payload: { moved, runId: summary.runId, cutoverAt: summary.cutoverAt, stores: summary.stores, graph: summary.graph },
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
