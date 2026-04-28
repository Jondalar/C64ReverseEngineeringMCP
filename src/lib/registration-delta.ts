// Detect files on disk that match c64re's known artifact extensions but
// are not registered in `knowledge/artifacts.json`. Used by:
//   - the workspace UI banner
//   - agent_onboard / agent_propose_next (failsafe surfacing)
//   - agent_record_step (warning before sealing a step)
//   - register_existing_files (the catch-up tool itself)

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const KNOWN_EXTENSIONS = new Set([
  ".prg", ".crt", ".d64", ".g64", ".bin",
  ".asm", ".tass", ".sym",
  ".json", ".md", ".html", ".png", ".jsonl",
]);

// Subdirectories to scan. Other folders (input, knowledge, views, session,
// node_modules, .git) are skipped to avoid false positives.
const SCAN_ROOTS = ["analysis", "artifacts", "build", "docs", "tools", "src", "session/graphics-previews"];

// Folders that must never be scanned.
const SKIP_DIRS = new Set(["node_modules", ".git", "knowledge", "views", "input"]);

export interface RegistrationDelta {
  // Total candidate files seen (across SCAN_ROOTS, matching KNOWN_EXTENSIONS).
  totalCandidates: number;
  // Files already registered in artifacts.json (matched by relativePath).
  alreadyRegistered: number;
  // Files matching known extensions but not registered. Capped at `cap`
  // for response size; full count is in `unregisteredCount`.
  unregistered: string[];
  unregisteredCount: number;
  // Most-frequent file extensions among the unregistered set.
  unregisteredByExt: Record<string, number>;
}

interface ArtifactsJson {
  items?: Array<{ relativePath?: string; path?: string }>;
}

function loadRegisteredPaths(projectRoot: string): Set<string> {
  const path = resolve(projectRoot, "knowledge", "artifacts.json");
  if (!existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as ArtifactsJson;
    const set = new Set<string>();
    for (const item of data.items ?? []) {
      if (item.relativePath) set.add(item.relativePath);
      else if (item.path) set.add(relative(projectRoot, item.path));
    }
    return set;
  } catch {
    return new Set();
  }
}

function walk(dir: string, projectRoot: string, registered: Set<string>, out: string[], byExt: Record<string, number>): { total: number; alreadyRegistered: number } {
  let total = 0;
  let already = 0;
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { total: 0, alreadyRegistered: 0 };
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walk(full, projectRoot, registered, out, byExt);
      total += sub.total;
      already += sub.alreadyRegistered;
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = entry.name.slice(dot).toLowerCase();
    if (!KNOWN_EXTENSIONS.has(ext)) continue;
    total += 1;
    const rel = relative(projectRoot, full);
    if (registered.has(rel)) {
      already += 1;
      continue;
    }
    out.push(rel);
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }
  return { total, alreadyRegistered: already };
}

export function scanRegistrationDelta(projectRoot: string, cap = 50): RegistrationDelta {
  const registered = loadRegisteredPaths(projectRoot);
  let totalCandidates = 0;
  let alreadyRegistered = 0;
  const unregistered: string[] = [];
  const byExt: Record<string, number> = {};
  for (const sub of SCAN_ROOTS) {
    const root = resolve(projectRoot, sub);
    if (!existsSync(root)) continue;
    const r = walk(root, projectRoot, registered, unregistered, byExt);
    totalCandidates += r.total;
    alreadyRegistered += r.alreadyRegistered;
  }
  const unregisteredCount = unregistered.length;
  return {
    totalCandidates,
    alreadyRegistered,
    unregistered: unregistered.slice(0, cap),
    unregisteredCount,
    unregisteredByExt: byExt,
  };
}

// Cheap variant: only return the count, not the file list.
export function countUnregisteredFiles(projectRoot: string): number {
  const registered = loadRegisteredPaths(projectRoot);
  let count = 0;
  const dummy: string[] = [];
  const dummyExt: Record<string, number> = {};
  for (const sub of SCAN_ROOTS) {
    const root = resolve(projectRoot, sub);
    if (!existsSync(root)) continue;
    walk(root, projectRoot, registered, dummy, dummyExt);
  }
  count = dummy.length;
  return count;
}

// Glob-style check: does `relPath` match `glob`? Supports * and **.
export function matchesGlob(relPath: string, glob: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  // Translate glob to regex.
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^$()|{}[]\\".includes(c!)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re).test(norm);
}

// Walk the project (same scan roots) returning every file matching the
// extension allowlist, regardless of registration status. Used by
// register_existing_files to enumerate candidates before glob-filtering.
export function listCandidateFiles(projectRoot: string): string[] {
  const out: string[] = [];
  const registered = new Set<string>();
  const byExt: Record<string, number> = {};
  for (const sub of SCAN_ROOTS) {
    const root = resolve(projectRoot, sub);
    if (!existsSync(root)) continue;
    walk(root, projectRoot, registered, out, byExt);
  }
  return out;
}

// Find analysis-run artifacts that have not yet been imported as entities.
// "Imported" = at least one entity in the project references the artifact
// id via its `artifactIds` field. Used by bulk_import_analysis_reports
// and surfaced as a separate banner / propose-next signal.
export interface UnimportedAnalysisArtifact {
  id: string;
  relativePath: string;
  title: string;
  createdAt: string;
}

export function findUnimportedAnalysisArtifacts(
  service: import("../project-knowledge/service.js").ProjectKnowledgeService,
): UnimportedAnalysisArtifact[] {
  const artifacts = service.listArtifacts().filter((a) => a.kind === "analysis-run");
  if (artifacts.length === 0) return [];
  const referenced = new Set<string>();
  for (const entity of service.listEntities()) {
    for (const id of entity.artifactIds) referenced.add(id);
  }
  const out: UnimportedAnalysisArtifact[] = [];
  for (const a of artifacts) {
    if (!referenced.has(a.id)) {
      out.push({ id: a.id, relativePath: a.relativePath, title: a.title, createdAt: a.createdAt });
    }
  }
  return out;
}

export function countUnimportedAnalysisArtifacts(
  service: import("../project-knowledge/service.js").ProjectKnowledgeService,
): number {
  return findUnimportedAnalysisArtifacts(service).length;
}

export function statSafe(path: string): { size: number; isFile: boolean } | null {
  try {
    const s = statSync(path);
    return { size: s.size, isFile: s.isFile() };
  } catch {
    return null;
  }
}
