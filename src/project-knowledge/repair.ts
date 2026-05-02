import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync, type Dirent } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { findUnimportedAnalysisArtifacts, listCandidateFiles } from "../lib/registration-delta.js";
import { auditProject, type ProjectAuditResult } from "./audit.js";
import { importManifestKnowledge } from "./manifest-import.js";
import { ProjectKnowledgeService } from "./service.js";

export const PROJECT_REPAIR_OPERATIONS = [
  "merge-fragments",
  "register-artifacts",
  "import-analysis",
  "import-manifest",
  "build-views",
  "backfill-question-source",
] as const;

export type ProjectRepairOperation = typeof PROJECT_REPAIR_OPERATIONS[number];
export type ProjectRepairMode = "dry-run" | "safe";

export interface ProjectRepairResult {
  root: string;
  mode: ProjectRepairMode;
  operations: ProjectRepairOperation[];
  planned: string[];
  executed: string[];
  skipped: string[];
  filesChanged: string[];
  before: ProjectAuditResult;
  after?: ProjectAuditResult;
}

interface ProjectRepairOptions {
  mode?: ProjectRepairMode;
  operations?: ProjectRepairOperation[];
  limit?: number;
}

const STORE_FILES = [
  "entities.json",
  "findings.json",
  "relations.json",
  "flows.json",
  "tasks.json",
  "open-questions.json",
  "artifacts.json",
  "labels.user.json",
];

function nowIso(): string {
  return new Date().toISOString();
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isRecordStore(value: unknown): value is { schemaVersion: number; updatedAt?: string; items: Array<{ id?: string }> } {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { items?: unknown };
  return Array.isArray(maybe.items);
}

function findNestedKnowledgeStores(projectRoot: string): string[] {
  const rootKnowledge = resolve(projectRoot, "knowledge");
  const found: string[] = [];
  const skipDirs = new Set([".git", "node_modules", "dist"]);

  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.name === "knowledge") {
        if (resolve(full) !== rootKnowledge && STORE_FILES.some((file) => existsSync(join(full, file)))) {
          found.push(full);
        }
        continue;
      }
      walk(full);
    }
  }

  walk(projectRoot);
  return found.sort();
}

function inferKind(relPath: string): Parameters<ProjectKnowledgeService["saveArtifact"]>[0]["kind"] {
  const lower = relPath.toLowerCase();
  switch (extname(lower)) {
    case ".prg":
      return "prg";
    case ".crt":
      return "crt";
    case ".d64":
      return "d64";
    case ".g64":
      return "g64";
    case ".bin":
    case ".raw":
      return "raw";
    case ".asm":
    case ".tass":
      return "generated-source";
    case ".md":
      return "report";
    case ".png":
      return "preview";
    case ".json":
      return basename(lower) === "manifest.json" ? "manifest" : "other";
    case ".jsonl":
      return "trace";
    default:
      return "other";
  }
}

function inferScope(relPath: string): Parameters<ProjectKnowledgeService["saveArtifact"]>[0]["scope"] {
  if (relPath.startsWith("input/")) return "input";
  if (relPath.startsWith("views/")) return "view";
  if (relPath.startsWith("session/")) return "session";
  if (relPath.startsWith("knowledge/")) return "knowledge";
  if (relPath.startsWith("analysis/")) return "analysis";
  return "generated";
}

function inferRole(relPath: string): string | undefined {
  const lower = relPath.toLowerCase();
  if (lower.includes("/depack/") && lower.endsWith(".prg")) return "depacked-prg";
  if (lower.endsWith(".analysis.json") || lower.endsWith("_analysis.json")) return "analysis-json";
  if (basename(lower) === "manifest.json") return "manifest";
  if (lower.endsWith(".asm")) return "kickassembler-source";
  if (lower.endsWith(".tass")) return "64tass-source";
  if (lower.includes("ram") && lower.endsWith(".md")) return "ram-report";
  if (lower.includes("pointer") && lower.endsWith(".md")) return "pointer-report";
  return undefined;
}

function inferFormat(relPath: string): string | undefined {
  const ext = extname(relPath).replace(/^\./, "").toLowerCase();
  if (!ext) return undefined;
  if (ext === "md") return "markdown";
  return ext;
}

function registeredPaths(service: ProjectKnowledgeService, projectRoot: string): Set<string> {
  return new Set(service.listArtifacts().map((artifact) => {
    if (artifact.relativePath) return artifact.relativePath.replace(/\\/g, "/");
    const path = isAbsolute(artifact.path) ? artifact.path : resolve(projectRoot, artifact.path);
    return relative(projectRoot, path).replace(/\\/g, "/");
  }));
}

function manifestImportCandidates(service: ProjectKnowledgeService): Array<{ id: string; relativePath: string }> {
  const referenced = new Set<string>();
  for (const entity of service.listEntities()) {
    for (const id of entity.artifactIds) referenced.add(id);
  }
  for (const finding of service.listFindings()) {
    for (const id of finding.artifactIds) referenced.add(id);
  }
  return service.listArtifacts()
    .filter((artifact) => artifact.kind === "manifest" || artifact.role?.endsWith("-manifest") || artifact.role === "manifest")
    .filter((artifact) => {
      const imported = importManifestKnowledge(artifact);
      return imported !== undefined && imported.entities.length + imported.findings.length + imported.relations.length > 0;
    })
    .filter((artifact) => !referenced.has(artifact.id))
    .map((artifact) => ({ id: artifact.id, relativePath: artifact.relativePath }));
}

function operationList(options?: ProjectRepairOperation[]): ProjectRepairOperation[] {
  return options?.length
    ? options
    : ["merge-fragments", "register-artifacts", "import-analysis", "import-manifest", "backfill-question-source", "build-views"];
}

export function repairProject(projectRoot: string, options: ProjectRepairOptions = {}): ProjectRepairResult {
  const root = resolve(projectRoot);
  const mode = options.mode ?? "dry-run";
  const operations = operationList(options.operations);
  const service = new ProjectKnowledgeService(root);
  const before = auditProject(root, { registrationSampleLimit: options.limit ?? 50 });
  const planned: string[] = [];
  const executed: string[] = [];
  const skipped: string[] = [];
  const filesChanged = new Set<string>();
  const limit = options.limit ?? 500;

  if (operations.includes("merge-fragments")) {
    const stores = findNestedKnowledgeStores(root);
    for (const storeDir of stores) {
      for (const file of STORE_FILES) {
        const childPath = join(storeDir, file);
        const rootPath = join(root, "knowledge", file);
        if (!existsSync(childPath) || !existsSync(rootPath)) continue;
        const child = readJson(childPath);
        const target = readJson(rootPath);
        if (!isRecordStore(child) || !isRecordStore(target)) {
          skipped.push(`merge-fragments ${relative(root, childPath)}: unsupported store shape`);
          continue;
        }
        const existing = new Set(target.items.map((item) => item.id).filter((id): id is string => Boolean(id)));
        const additions = child.items.filter((item) => item.id && !existing.has(item.id));
        const conflicts = child.items.filter((item) => item.id && existing.has(item.id));
        planned.push(`merge-fragments ${relative(root, childPath)} -> knowledge/${file}: add ${additions.length}, keep ${conflicts.length} existing`);
        for (const conflict of conflicts) {
          skipped.push(`merge-fragments ${relative(root, childPath)} -> knowledge/${file}: id collision on ${conflict.id}, kept root record`);
        }
        if (mode === "safe" && additions.length > 0) {
          writeJsonAtomic(rootPath, {
            ...target,
            updatedAt: nowIso(),
            items: [...target.items, ...additions],
          });
          filesChanged.add(rootPath);
          executed.push(`merged ${additions.length} record(s) from ${relative(root, childPath)} into knowledge/${file}`);
        }
      }
    }
    if (stores.length === 0) skipped.push("merge-fragments: no nested knowledge stores found");
  }

  if (operations.includes("register-artifacts")) {
    const registered = registeredPaths(service, root);
    const unregistered = listCandidateFiles(root).filter((rel) => !registered.has(rel.replace(/\\/g, "/"))).slice(0, limit);
    for (const rel of unregistered) {
      planned.push(`register-artifacts ${rel}`);
      if (mode === "safe") {
        const artifact = service.saveArtifact({
          kind: inferKind(rel),
          scope: inferScope(rel),
          title: basename(rel),
          path: resolve(root, rel),
          role: inferRole(rel),
          format: inferFormat(rel),
          producedByTool: "project_repair",
          tags: ["project-repair"],
        });
        filesChanged.add(join(root, "knowledge", "artifacts.json"));
        executed.push(`registered ${artifact.relativePath} (${artifact.kind})`);
      }
    }
    if (unregistered.length === 0) skipped.push("register-artifacts: no unregistered candidate files found");
  }

  if (operations.includes("import-analysis")) {
    const analysis = findUnimportedAnalysisArtifacts(service).slice(0, limit);
    for (const artifact of analysis) {
      planned.push(`import-analysis ${artifact.id} (${artifact.relativePath})`);
      if (mode === "safe") {
        try {
          const imported = service.importAnalysisArtifact(artifact.id);
          filesChanged.add(join(root, "knowledge", "entities.json"));
          filesChanged.add(join(root, "knowledge", "findings.json"));
          filesChanged.add(join(root, "knowledge", "relations.json"));
          filesChanged.add(join(root, "knowledge", "flows.json"));
          filesChanged.add(join(root, "knowledge", "open-questions.json"));
          executed.push(`imported ${artifact.id}: ${imported.importedEntityCount} entities, ${imported.importedFindingCount} findings`);
        } catch (error) {
          skipped.push(`import-analysis ${artifact.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (analysis.length === 0) skipped.push("import-analysis: no unimported analysis artifacts found");
  }

  if (operations.includes("import-manifest")) {
    const manifests = manifestImportCandidates(service).slice(0, limit);
    for (const artifact of manifests) {
      planned.push(`import-manifest ${artifact.id} (${artifact.relativePath})`);
      if (mode === "safe") {
        try {
          const imported = service.importManifestArtifact(artifact.id);
          filesChanged.add(join(root, "knowledge", "entities.json"));
          filesChanged.add(join(root, "knowledge", "findings.json"));
          filesChanged.add(join(root, "knowledge", "relations.json"));
          executed.push(`imported ${artifact.id}: ${imported.importedEntityCount} entities, ${imported.importedFindingCount} findings`);
        } catch (error) {
          skipped.push(`import-manifest ${artifact.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (manifests.length === 0) skipped.push("import-manifest: no unimported manifest artifacts found");
  }

  if (operations.includes("backfill-question-source")) {
    // Spec 036: tag legacy questions whose source is missing or
    // "untagged" using a heuristic mapping from producedByTool /
    // title regex.
    const allQuestions = service.listOpenQuestions();
    const untagged = allQuestions.filter((q) => !q.source || q.source === "untagged");
    planned.push(`backfill-question-source: ${untagged.length} untagged question(s)`);
    if (mode === "safe" && untagged.length > 0) {
      const counts: Record<string, number> = {};
      for (const q of untagged) {
        const title = q.title.toLowerCase();
        const description = (q.description ?? "").toLowerCase();
        let source: "heuristic-phase1" | "human-review" | "runtime-observation" | "static-analysis" | "other";
        if (/classification uncertain|unknown range|heuristic/.test(title)) source = "heuristic-phase1";
        else if (/trace|observed|runtime/.test(title) || /trace/.test(description)) source = "runtime-observation";
        else if (/draft|auto-suggest|propose_annotations|static.*analysis/.test(title)) source = "static-analysis";
        else source = "other";
        counts[source] = (counts[source] ?? 0) + 1;
        service.saveOpenQuestion({ id: q.id, kind: q.kind, title: q.title, source });
      }
      executed.push(`backfilled ${untagged.length} question(s): ${Object.entries(counts).map(([s, n]) => `${s}=${n}`).join(", ")}`);
    } else if (untagged.length === 0) {
      skipped.push("backfill-question-source: nothing untagged");
    }
  }

  if (operations.includes("build-views")) {
    planned.push("build-views all workspace views");
    if (mode === "safe") {
      const built = service.buildAllViews();
      for (const path of [
        built.projectDashboard.path,
        built.memoryMap.path,
        built.diskLayout.path,
        built.cartridgeLayout.path,
        built.loadSequence.path,
        built.flowGraph.path,
        built.annotatedListing.path,
      ]) {
        filesChanged.add(path);
      }
      executed.push("built all workspace views");
    }
  }

  return {
    root,
    mode,
    operations,
    planned,
    executed,
    skipped,
    filesChanged: [...filesChanged].sort(),
    before,
    after: mode === "safe" ? auditProject(root, { registrationSampleLimit: options.limit ?? 50 }) : undefined,
  };
}

export function renderProjectRepair(result: ProjectRepairResult): string {
  const lines: string[] = [];
  lines.push(`# Project Repair`);
  lines.push(``);
  lines.push(`Project root: ${result.root}`);
  lines.push(`Mode: ${result.mode}`);
  lines.push(`Operations: ${result.operations.join(", ")}`);
  lines.push(`Before severity: ${result.before.severity}`);
  if (result.after) lines.push(`After severity: ${result.after.severity}`);
  lines.push(``);
  lines.push(`## Planned`);
  lines.push(...(result.planned.length === 0 ? ["No operations planned."] : result.planned.slice(0, 100).map((item) => `- ${item}`)));
  if (result.planned.length > 100) lines.push(`- ... ${result.planned.length - 100} more`);
  lines.push(``);
  lines.push(`## Executed`);
  lines.push(...(result.executed.length === 0 ? ["No writes executed."] : result.executed.slice(0, 100).map((item) => `- ${item}`)));
  if (result.executed.length > 100) lines.push(`- ... ${result.executed.length - 100} more`);
  lines.push(``);
  lines.push(`## Skipped`);
  lines.push(...(result.skipped.length === 0 ? ["Nothing skipped."] : result.skipped.slice(0, 100).map((item) => `- ${item}`)));
  if (result.skipped.length > 100) lines.push(`- ... ${result.skipped.length - 100} more`);
  lines.push(``);
  lines.push(`## Files Changed`);
  lines.push(...(result.filesChanged.length === 0 ? ["None."] : result.filesChanged.map((path) => `- ${path}`)));
  lines.push(``);
  lines.push(`## JSON`);
  lines.push("```json");
  lines.push(JSON.stringify(result, null, 2));
  lines.push("```");
  return lines.join("\n");
}
