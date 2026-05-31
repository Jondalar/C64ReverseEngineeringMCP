// Spec 740.1 — wiki skeleton + activity log.
//
// Two LLM-maintained Markdown files: docs/index.md (the project wiki index,
// category-organized) and knowledge/activity-log.md (append-only, parseable
// chronological entries). The MVP only SCAFFOLDS these and appends activity
// entries; deep content synthesis (project_wiki_update) is Spec 740.2.

import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const WIKI_CATEGORIES = [
  "boot / loader",
  "media map (disk / cartridge)",
  "code regions / routines",
  "assets / graphics",
  "runtime traces / marks",
  "open questions / hypotheses",
  "patches / changes",
];

function indexSkeleton(): string {
  const lines: string[] = [];
  lines.push("# Project Wiki Index");
  lines.push("");
  lines.push("Curated synthesis over the raw project sources. Use `project_search` to");
  lines.push("find where a topic/address/track is described — do not read every doc.");
  lines.push("Each row: title — one-line summary — tags — source IDs/paths.");
  lines.push("");
  for (const cat of WIKI_CATEGORIES) {
    lines.push(`## ${cat}`);
    lines.push("");
    lines.push("_(no curated entries yet — add rows as the project is mapped)_");
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function activityLogSkeleton(): string {
  return [
    "# Activity Log",
    "",
    "Append-only project timeline. Each entry: `## [ISO_TIMESTAMP] <kind> | <title>`.",
    "Records ingests, analysis runs, trace captures, wiki updates, and decisions so a",
    "future session has the timeline without reading chat/terminal history.",
    "",
  ].join("\n") + "\n";
}

export function ensureWikiSkeleton(projectDir: string): { created: string[] } {
  const created: string[] = [];
  const indexPath = join(projectDir, "docs", "index.md");
  if (!existsSync(indexPath)) {
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, indexSkeleton());
    created.push("docs/index.md");
  }
  const logPath = join(projectDir, "knowledge", "activity-log.md");
  if (!existsSync(logPath)) {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, activityLogSkeleton());
    created.push("knowledge/activity-log.md");
  }
  return { created };
}

// Append one parseable entry. `nowIso` is injected so callers control the clock.
export function appendActivityLog(projectDir: string, kind: string, title: string, nowIso: string): void {
  ensureWikiSkeleton(projectDir);
  const logPath = join(projectDir, "knowledge", "activity-log.md");
  const safeKind = kind.replace(/[|\n]/g, " ").trim() || "note";
  const safeTitle = title.replace(/[|\n]/g, " ").trim() || "(untitled)";
  appendFileSync(logPath, `\n## [${nowIso}] ${safeKind} | ${safeTitle}\n`);
}

export function activityLogExists(projectDir: string): boolean {
  return existsSync(join(projectDir, "knowledge", "activity-log.md"));
}

export function readWikiIndex(projectDir: string): string | undefined {
  const p = join(projectDir, "docs", "index.md");
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}
