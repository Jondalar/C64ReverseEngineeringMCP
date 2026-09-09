// Detect files on disk that match c64re's known artifact extensions but
// are not registered in `knowledge/artifacts.json`. Used by:
//   - the workspace UI banner
//   - agent_onboard / agent_propose_next (failsafe surfacing)
//   - agent_record_step (warning before sealing a step)
//   - register_existing_files (the catch-up tool itself)

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { importAnalysisKnowledge } from "../project-knowledge/analysis-import.js";

const KNOWN_EXTENSIONS = new Set([
  ".prg", ".crt", ".d64", ".g64", ".bin",
  // `.tass` is the pre-2026-09-06 64tass suffix: the renderer writes `.tas`
  // now, but a project made before the rename still holds `.tass` files and they
  // must keep registering.
  ".asm", ".tas", ".tass", ".sym",
  ".json", ".md", ".html", ".png", ".jsonl",
]);

// Subdirectories to scan. Other folders (input, knowledge, views, session,
// node_modules, .git) are skipped to avoid false positives.
const SCAN_ROOTS = ["analysis", "artifacts", "build", "docs", "tools", "src", "session/graphics-previews"];

// Folders that must never be scanned.
const SKIP_DIRS = new Set(["node_modules", ".git", "knowledge", "views", "input"]);

// Spec 832 D5 — directories a TOOL owns and fills.
//
// These are still scanned, and their files are still counted: what changes is
// WHO the count is addressed to. A single `extract_g64_sectors` sweep writes
// thousands of sector `.bin` files; the reporting project carried 4 101 of them
// as "unregistered files" for ever, under the advice "register intentional
// artifacts and ignore or move scratch files" — advice nobody can act on 4 101
// times. Machine output is not human debt. The tool that wrote them registers
// the MANIFEST, and the manifest is the artifact, not each of the 4 101 files.
//
// HOW A DIRECTORY JOINS THIS SET: it must be a path a tool COMPOSES for its own
// output — grep for where the default output directory is built (the
// `join(projectDir, "analysis", …)` / `resolve(pd, "analysis", …)` shape) and
// add the prefix here beside the source line that writes it. A directory a
// human types by hand does NOT belong here: the whole point of the split is
// that nobody can act on machine output file by file, whereas a file a human
// dropped somewhere is exactly the thing the audit should keep asking about.
const TOOL_OWNED_DIRS: Array<{ prefix: string; tool: string }> = [
  // src/server-tools/disk-g64.ts — g64SectorDefaultOutputDir: analysis/g64/<image>/track-N/
  { prefix: "analysis/g64", tool: "extract_g64_sectors" },
  // src/server-tools/disk-g64.ts — extract_g64_raw_track default output
  { prefix: "analysis/g64-raw", tool: "extract_g64_raw_track" },
  // src/server-tools/media.ts — extract_disk default output: analysis/disk/<image>/
  { prefix: "analysis/disk", tool: "extract_disk" },
  // src/server-tools/media.ts — extract_crt default output
  { prefix: "analysis/extracted", tool: "extract_crt" },
  // src/server-tools/sandbox-depack.ts — sandbox_depack default output
  { prefix: "analysis/depack", tool: "sandbox_depack" },
  // src/server-tools/compression.ts — shared-encoding scan default output
  { prefix: "analysis/compression", tool: "analyze_shared_encoding" },
  // src/project-knowledge/storage.ts — paths.analysisRuns / analysisLatest / analysisIndexes
  { prefix: "analysis/runs", tool: "analysis run store" },
  { prefix: "analysis/latest", tool: "analysis run store" },
  { prefix: "analysis/indexes", tool: "analysis run store" },
  // src/server-tools/registration.ts DEFAULT_PATTERNS — runtime session + trace capture
  { prefix: "analysis/runtime", tool: "runtime session capture" },
  { prefix: "analysis/headless-runtime", tool: "headless runtime capture" },
  // Spec 832 §6 names this one. NOTE: no tool in THIS repo composes it — it is
  // the conventional output directory of a per-project Spec 784 extractor, which
  // is still machine output written by a program, not by a hand. Kept here on
  // the spec's decision, flagged so the next reader knows the difference.
  { prefix: "analysis/carved", tool: "per-project extractor (Spec 784)" },
];

// The one exception INSIDE a tool-owned directory: the manifest or report the
// tool writes to stand for the bulk. That file is the artifact the spec says
// should be registered, so it stays ordinary — and actionable — debt.
const TOOL_OWNED_MANIFEST_NAMES = new Set([
  "manifest.json",
  "manifest.spec784.json",
  "track-metadata.json",
  "summary.json",
  "session.json",
]);

export interface ToolOwnedDir {
  prefix: string;
  tool: string;
}

// Which tool owns `relPath`, if any. A manifest inside a tool-owned directory
// returns undefined: it is the artifact, not the bulk.
export function toolOwnerOf(relPath: string): ToolOwnedDir | undefined {
  const norm = relPath.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  if (TOOL_OWNED_MANIFEST_NAMES.has(base)) return undefined;
  return TOOL_OWNED_DIRS.find((d) => norm === d.prefix || norm.startsWith(`${d.prefix}/`));
}

export interface RegistrationDelta {
  // Total candidate files seen (across SCAN_ROOTS, matching KNOWN_EXTENSIONS).
  totalCandidates: number;
  // Files already registered in artifacts.json (matched by relativePath).
  alreadyRegistered: number;
  // Files matching known extensions but not registered, EXCLUDING tool output
  // (Spec 832 D5). Capped at `cap` for response size; full count is in
  // `unregisteredCount`. This is the set a human can act on.
  unregistered: string[];
  unregisteredCount: number;
  // Most-frequent file extensions among the unregistered set.
  unregisteredByExt: Record<string, number>;
  // Spec 832 D5 — unregistered files inside a directory a tool owns and fills.
  // Reported, never counted as debt. Sample capped like `unregistered`.
  toolOutput: string[];
  toolOutputCount: number;
  // Count per owning directory prefix, e.g. { "analysis/g64": 4101 }.
  toolOutputByDir: Record<string, number>;
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

// Accumulator for one walk. Spec 832 D5 split the single `out` list in two:
// `human` is what a person left lying around, `tool` is what a tool wrote into
// a directory it owns. Both are collected on every walk; callers decide which
// they care about.
interface WalkSink {
  projectRoot: string;
  registered: Set<string>;
  human: string[];
  humanByExt: Record<string, number>;
  tool: string[];
  toolByDir: Record<string, number>;
}

function newSink(projectRoot: string, registered: Set<string>): WalkSink {
  return { projectRoot, registered, human: [], humanByExt: {}, tool: [], toolByDir: {} };
}

function walk(dir: string, sink: WalkSink): { total: number; alreadyRegistered: number } {
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
      const sub = walk(full, sink);
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
    const rel = relative(sink.projectRoot, full);
    if (sink.registered.has(rel)) {
      already += 1;
      continue;
    }
    const owner = toolOwnerOf(rel);
    if (owner) {
      sink.tool.push(rel);
      sink.toolByDir[owner.prefix] = (sink.toolByDir[owner.prefix] ?? 0) + 1;
      continue;
    }
    sink.human.push(rel);
    sink.humanByExt[ext] = (sink.humanByExt[ext] ?? 0) + 1;
  }
  return { total, alreadyRegistered: already };
}

function walkAllRoots(projectRoot: string, registered: Set<string>): { sink: WalkSink; totalCandidates: number; alreadyRegistered: number } {
  const sink = newSink(projectRoot, registered);
  let totalCandidates = 0;
  let alreadyRegistered = 0;
  for (const sub of SCAN_ROOTS) {
    const root = resolve(projectRoot, sub);
    if (!existsSync(root)) continue;
    const r = walk(root, sink);
    totalCandidates += r.total;
    alreadyRegistered += r.alreadyRegistered;
  }
  return { sink, totalCandidates, alreadyRegistered };
}

export function scanRegistrationDelta(projectRoot: string, cap = 50): RegistrationDelta {
  const registered = loadRegisteredPaths(projectRoot);
  const { sink, totalCandidates, alreadyRegistered } = walkAllRoots(projectRoot, registered);
  return {
    totalCandidates,
    alreadyRegistered,
    unregistered: sink.human.slice(0, cap),
    unregisteredCount: sink.human.length,
    unregisteredByExt: sink.humanByExt,
    toolOutput: sink.tool.slice(0, cap),
    toolOutputCount: sink.tool.length,
    toolOutputByDir: sink.toolByDir,
  };
}

// Describe the resolved walk roots so register_existing_files can report
// what it actually scanned. Used by the zero-match diagnostic path.
export interface WalkRootInfo {
  subdir: string;
  absPath: string;
  exists: boolean;
  topLevelEntries: string[];
}

export function describeWalkRoots(projectRoot: string): WalkRootInfo[] {
  const out: WalkRootInfo[] = [];
  for (const sub of SCAN_ROOTS) {
    const absPath = resolve(projectRoot, sub);
    const exists = existsSync(absPath);
    let entries: string[] = [];
    if (exists) {
      try {
        entries = readdirSync(absPath, { withFileTypes: true })
          .filter((e) => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
          .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`)
          .sort();
      } catch {
        entries = [];
      }
    }
    out.push({ subdir: sub, absPath, exists, topLevelEntries: entries.slice(0, 20) });
  }
  return out;
}

// Cheap variant: only return the count, not the file list. Spec 832 D5 — this
// counts human-left files only; tool output is not debt. Use
// scanRegistrationDelta().toolOutputCount for the machine side.
export function countUnregisteredFiles(projectRoot: string): number {
  const registered = loadRegisteredPaths(projectRoot);
  return walkAllRoots(projectRoot, registered).sink.human.length;
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
// Spec 832 D5: register_existing_files must still SEE tool output — a glob the
// operator types explicitly is exactly how a tool-owned directory gets
// registered on purpose. Both halves are returned here; only the audit's debt
// reporting splits them.
export function listCandidateFiles(projectRoot: string): string[] {
  const { sink } = walkAllRoots(projectRoot, new Set<string>());
  return [...sink.human, ...sink.tool];
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
  const artifacts = service.listArtifacts().filter((a) =>
    (a.kind === "analysis-run" && a.role !== "tool-run-record")
    || a.role === "analysis-json"
    || a.role === "analysis-report"
    || (a.scope === "analysis" && a.format === "json" && /analysis/i.test(a.title)),
  ).filter((a) => {
    const imported = importAnalysisKnowledge(a);
    if (!imported) return false;
    return imported.entities.length
      + imported.findings.length
      + imported.relations.length
      + imported.flows.length
      + imported.openQuestions.length > 0;
  });
  if (artifacts.length === 0) return [];
  const referenced = new Set<string>();
  for (const entity of service.listEntities()) {
    for (const id of entity.artifactIds) referenced.add(id);
  }
  for (const finding of service.listFindings()) {
    for (const id of finding.artifactIds) referenced.add(id);
  }
  for (const relation of service.listRelations()) {
    for (const id of relation.artifactIds) referenced.add(id);
  }
  for (const flow of service.listFlows()) {
    for (const id of flow.artifactIds) referenced.add(id);
  }
  for (const question of service.listOpenQuestions()) {
    for (const id of question.artifactIds) referenced.add(id);
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
