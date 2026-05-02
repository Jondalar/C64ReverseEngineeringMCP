import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { findUnimportedAnalysisArtifacts, scanRegistrationDelta } from "../lib/registration-delta.js";
import { importManifestKnowledge } from "./manifest-import.js";
import { ProjectKnowledgeService } from "./service.js";
import { createProjectKnowledgePaths } from "./storage.js";
import type { ArtifactRecord } from "./types.js";

export type ProjectAuditSeverity = "ok" | "low" | "medium" | "high";

export interface ProjectAuditFinding {
  id: string;
  severity: Exclude<ProjectAuditSeverity, "ok">;
  title: string;
  paths: string[];
  whyItMatters: string;
  suggestedFix: string;
}

export interface ProjectAuditResult {
  root: string;
  severity: ProjectAuditSeverity;
  findings: ProjectAuditFinding[];
  suggestedActions: string[];
  safeRepairAvailable: boolean;
  counts: {
    nestedKnowledgeStores: number;
    missingArtifacts: number;
    brokenArtifactPaths: number;
    unregisteredFiles: number;
    unimportedAnalysisArtifacts: number;
    unimportedManifestArtifacts: number;
    staleViews: number;
    snapshotBytes: number;
    snapshotFileCount: number;
  };
}

interface ProjectAuditOptions {
  includeFileScan?: boolean;
  registrationSampleLimit?: number;
}

const KNOWLEDGE_FILES = [
  "knowledge/entities.json",
  "knowledge/findings.json",
  "knowledge/relations.json",
  "knowledge/flows.json",
  "knowledge/tasks.json",
  "knowledge/open-questions.json",
  "knowledge/artifacts.json",
  "knowledge/phase-plan.json",
  "knowledge/workflow-state.json",
];

const VIEW_FILES = [
  "views/project-dashboard.json",
  "views/memory-map.json",
  "views/cartridge-layout.json",
  "views/disk-layout.json",
  "views/load-sequence.json",
  "views/flow-graph.json",
  "views/annotated-listing.json",
];

const REPAIRABLE_FINDINGS = new Set([
  "nested-knowledge-stores",
  "unregistered-files",
  "unimported-analysis-artifacts",
  "unimported-manifest-artifacts",
  "stale-views",
]);

function maxSeverity(findings: ProjectAuditFinding[]): ProjectAuditSeverity {
  if (findings.some((finding) => finding.severity === "high")) return "high";
  if (findings.some((finding) => finding.severity === "medium")) return "medium";
  if (findings.some((finding) => finding.severity === "low")) return "low";
  return "ok";
}

function isInsideRoot(projectRoot: string, path: string): boolean {
  const rel = relative(projectRoot, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function relPath(projectRoot: string, path: string): string {
  const rel = relative(projectRoot, path);
  return rel || ".";
}

function addFinding(findings: ProjectAuditFinding[], finding: ProjectAuditFinding): void {
  findings.push({
    ...finding,
    paths: finding.paths.map((path) => path.replace(/\\/g, "/")),
  });
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
        const normalized = resolve(full);
        if (normalized !== rootKnowledge && looksLikeKnowledgeStore(normalized)) {
          found.push(normalized);
        }
        continue;
      }
      walk(full);
    }
  }

  walk(projectRoot);
  return found.sort();
}

function looksLikeKnowledgeStore(dir: string): boolean {
  const markerFiles = [
    "phase-plan.json",
    "workflow-state.json",
    "entities.json",
    "findings.json",
    "artifacts.json",
    "open-questions.json",
  ];
  return markerFiles.some((file) => existsSync(join(dir, file)));
}

function findStaleViews(projectRoot: string): string[] {
  let newestKnowledge = 0;
  for (const rel of KNOWLEDGE_FILES) {
    const full = join(projectRoot, rel);
    if (!existsSync(full)) continue;
    newestKnowledge = Math.max(newestKnowledge, statSync(full).mtimeMs);
  }
  if (newestKnowledge === 0) return [];

  const stale: string[] = [];
  for (const rel of VIEW_FILES) {
    const full = join(projectRoot, rel);
    if (!existsSync(full)) {
      stale.push(rel);
      continue;
    }
    if (statSync(full).mtimeMs < newestKnowledge) {
      stale.push(rel);
    }
  }
  return stale;
}

function artifactFilePath(projectRoot: string, artifact: ArtifactRecord): string {
  if (isAbsolute(artifact.path)) return artifact.path;
  return resolve(projectRoot, artifact.path);
}

function findArtifactPathProblems(projectRoot: string, artifacts: ArtifactRecord[]): {
  missing: ArtifactRecord[];
  broken: Array<{ artifact: ArtifactRecord; reason: string }>;
} {
  const missing: ArtifactRecord[] = [];
  const broken: Array<{ artifact: ArtifactRecord; reason: string }> = [];

  for (const artifact of artifacts) {
    const full = artifactFilePath(projectRoot, artifact);
    const expectedRelative = relPath(projectRoot, full).replace(/\\/g, "/");

    if (!isInsideRoot(projectRoot, full)) {
      broken.push({ artifact, reason: `absolute path escapes project root: ${artifact.path}` });
    }
    if (isAbsolute(artifact.relativePath)) {
      broken.push({ artifact, reason: `relativePath is absolute: ${artifact.relativePath}` });
    } else if (artifact.relativePath.replace(/\\/g, "/") !== expectedRelative) {
      broken.push({ artifact, reason: `relativePath should be ${expectedRelative}, got ${artifact.relativePath}` });
    }
    if (!existsSync(full)) {
      missing.push(artifact);
    }
  }

  return { missing, broken };
}

function findUnimportedManifestArtifacts(service: ProjectKnowledgeService): ArtifactRecord[] {
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
    .filter((artifact) => !referenced.has(artifact.id));
}

function suggestedActionsFor(findings: ProjectAuditFinding[]): string[] {
  const actions: string[] = [];
  if (findings.some((finding) => finding.id === "nested-knowledge-stores")) {
    actions.push("Run project_repair(mode=\"dry-run\", operations=[\"merge-fragments\"]) once available, or merge child stores into the root store by id.");
  }
  if (findings.some((finding) => finding.id === "broken-artifact-paths")) {
    actions.push("Fix artifact relativePath values so they are relative to the project root.");
  }
  if (findings.some((finding) => finding.id === "missing-artifact-files")) {
    actions.push("Remove or archive missing artifact records, or restore the referenced files.");
  }
  if (findings.some((finding) => finding.id === "unregistered-files")) {
    actions.push("Run scan_registration_delta, then register_existing_files for intentional project artifacts.");
  }
  if (findings.some((finding) => finding.id === "unimported-analysis-artifacts")) {
    actions.push("Run bulk_import_analysis_reports or import_analysis_report for each listed analysis artifact.");
  }
  if (findings.some((finding) => finding.id === "unimported-manifest-artifacts")) {
    actions.push("Run import_manifest_artifact for each listed manifest artifact.");
  }
  if (findings.some((finding) => finding.id === "stale-views")) {
    actions.push("Run build_all_views.");
  }
  if (actions.length === 0) {
    actions.push("No repair action required.");
  }
  return actions;
}

export function auditProject(projectRoot: string, options: ProjectAuditOptions = {}): ProjectAuditResult {
  const root = resolve(projectRoot);
  const service = new ProjectKnowledgeService(root);
  const findings: ProjectAuditFinding[] = [];
  const artifacts = service.listArtifacts();

  const nestedStores = findNestedKnowledgeStores(root);
  if (nestedStores.length > 0) {
    addFinding(findings, {
      id: "nested-knowledge-stores",
      severity: "high",
      title: "Nested knowledge stores found",
      paths: nestedStores.map((path) => relPath(root, path)),
      whyItMatters: "Knowledge written below media/ or analysis/ is invisible to the root workspace UI.",
      suggestedFix: "Merge nested stores into the root knowledge store and remove the child stores after verification.",
    });
  }

  const pathProblems = findArtifactPathProblems(root, artifacts);
  if (pathProblems.broken.length > 0) {
    addFinding(findings, {
      id: "broken-artifact-paths",
      severity: "high",
      title: "Artifact paths are not project-root relative",
      paths: pathProblems.broken.slice(0, 20).map(({ artifact, reason }) => `${artifact.id}: ${artifact.relativePath} (${reason})`),
      whyItMatters: "The UI resolves artifacts through project-relative paths. CWD-relative paths break links after nested tool calls.",
      suggestedFix: "Rewrite artifact relativePath values from the resolved project root.",
    });
  }
  if (pathProblems.missing.length > 0) {
    addFinding(findings, {
      id: "missing-artifact-files",
      severity: "medium",
      title: "Registered artifact files are missing",
      paths: pathProblems.missing.slice(0, 20).map((artifact) => `${artifact.id}: ${artifact.relativePath}`),
      whyItMatters: "Knowledge points at files the inspector and docs views cannot open.",
      suggestedFix: "Restore the files or archive/remove the stale artifact records.",
    });
  }

  const includeFileScan = options.includeFileScan ?? true;
  let unregisteredCount = 0;
  if (includeFileScan) {
    const delta = scanRegistrationDelta(root, options.registrationSampleLimit ?? 25);
    unregisteredCount = delta.unregisteredCount;
    if (delta.unregisteredCount > 0) {
      addFinding(findings, {
        id: "unregistered-files",
        severity: "medium",
        title: "Project files are not registered as artifacts",
        paths: delta.unregistered,
        whyItMatters: "Agents can create useful files that later sessions and the UI cannot discover through artifacts.json.",
        suggestedFix: "Register intentional artifacts and ignore or move scratch files.",
      });
    }
  }

  const unimportedAnalysis = findUnimportedAnalysisArtifacts(service);
  if (unimportedAnalysis.length > 0) {
    addFinding(findings, {
      id: "unimported-analysis-artifacts",
      severity: "medium",
      title: "Analysis artifacts were registered but not imported",
      paths: unimportedAnalysis.slice(0, 20).map((artifact) => `${artifact.id}: ${artifact.relativePath}`),
      whyItMatters: "Analysis JSON contains entities, findings, relations, and open questions that the UI cannot show until imported.",
      suggestedFix: "Import the analysis artifacts before continuing semantic work.",
    });
  }

  const unimportedManifests = findUnimportedManifestArtifacts(service);
  if (unimportedManifests.length > 0) {
    addFinding(findings, {
      id: "unimported-manifest-artifacts",
      severity: "medium",
      title: "Manifest artifacts were registered but not imported",
      paths: unimportedManifests.slice(0, 20).map((artifact) => `${artifact.id}: ${artifact.relativePath}`),
      whyItMatters: "Disk/cart manifests carry file and medium placement facts that the UI should not rediscover ad hoc.",
      suggestedFix: "Run import_manifest_artifact for each manifest artifact.",
    });
  }

  const staleViews = findStaleViews(root);
  if (staleViews.length > 0) {
    addFinding(findings, {
      id: "stale-views",
      severity: "medium",
      title: "View models are stale or missing",
      paths: staleViews,
      whyItMatters: "The workspace UI reads views/*.json, so stale views can hide current knowledge.",
      suggestedFix: "Run build_all_views after imports or knowledge edits.",
    });
  }

  const snapshotUsage = computeSnapshotUsage(root);
  if (snapshotUsage.fileCount > 0) {
    addFinding(findings, {
      id: "snapshot-disk-usage",
      severity: "low",
      title: `Spec 025 snapshots: ${snapshotUsage.fileCount} files, ${formatBytes(snapshotUsage.bytes)}`,
      paths: snapshotUsage.topArtifacts.map((entry) => `${entry.artifactId}: ${entry.fileCount} files, ${formatBytes(entry.bytes)}`),
      whyItMatters: "Snapshots preserve prior bytes for rollback. Trace files dwarf this; surface only as informational.",
      suggestedFix: "Prune <root>/snapshots/<artifact-id>/<old-hash>.bin if disk pressure becomes a concern.",
    });
  }

  return {
    root,
    severity: maxSeverity(findings),
    findings,
    suggestedActions: suggestedActionsFor(findings),
    safeRepairAvailable: findings.some((finding) => REPAIRABLE_FINDINGS.has(finding.id)),
    counts: {
      nestedKnowledgeStores: nestedStores.length,
      missingArtifacts: pathProblems.missing.length,
      brokenArtifactPaths: pathProblems.broken.length,
      unregisteredFiles: unregisteredCount,
      unimportedAnalysisArtifacts: unimportedAnalysis.length,
      unimportedManifestArtifacts: unimportedManifests.length,
      staleViews: staleViews.length,
      snapshotBytes: snapshotUsage.bytes,
      snapshotFileCount: snapshotUsage.fileCount,
    },
  };
}

function computeSnapshotUsage(root: string): { bytes: number; fileCount: number; topArtifacts: Array<{ artifactId: string; bytes: number; fileCount: number }> } {
  const snapshotsRoot = join(root, "snapshots");
  if (!existsSync(snapshotsRoot)) return { bytes: 0, fileCount: 0, topArtifacts: [] };
  let bytes = 0;
  let fileCount = 0;
  const perArtifact: Record<string, { bytes: number; fileCount: number }> = {};
  let dirEntries: Dirent[];
  try {
    dirEntries = readdirSync(snapshotsRoot, { withFileTypes: true });
  } catch {
    return { bytes: 0, fileCount: 0, topArtifacts: [] };
  }
  for (const sub of dirEntries) {
    if (!sub.isDirectory()) continue;
    const artifactId = sub.name;
    const subPath = join(snapshotsRoot, artifactId);
    let snaps: Dirent[];
    try {
      snaps = readdirSync(subPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const snap of snaps) {
      if (!snap.isFile()) continue;
      try {
        const size = statSync(join(subPath, snap.name)).size;
        bytes += size;
        fileCount += 1;
        const e = perArtifact[artifactId] ?? { bytes: 0, fileCount: 0 };
        e.bytes += size;
        e.fileCount += 1;
        perArtifact[artifactId] = e;
      } catch {
        continue;
      }
    }
  }
  const topArtifacts = Object.entries(perArtifact)
    .map(([artifactId, v]) => ({ artifactId, bytes: v.bytes, fileCount: v.fileCount }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);
  return { bytes, fileCount, topArtifacts };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

interface AuditFingerprint {
  knowledge: Array<{ path: string; mtimeMs: number; size: number }>;
  views: { newestMtimeMs: number };
  scan: {
    analysisNewest: number;
    artifactsNewest: number;
    mediaNewest: number;
  };
}

function newestMtimeIn(dir: string): number {
  let newest = 0;
  function walk(target: string, depth: number): void {
    if (depth > 4) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(target, entry.name);
      try {
        const stat = statSync(full);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
        if (entry.isDirectory()) walk(full, depth + 1);
      } catch {
        // ignore unreadable entries
      }
    }
  }
  walk(dir, 0);
  return newest;
}

function computeAuditFingerprint(projectRoot: string): AuditFingerprint {
  const knowledge: AuditFingerprint["knowledge"] = [];
  for (const rel of KNOWLEDGE_FILES) {
    const full = join(projectRoot, rel);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    knowledge.push({ path: rel, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  let viewsNewest = 0;
  for (const rel of VIEW_FILES) {
    const full = join(projectRoot, rel);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    if (stat.mtimeMs > viewsNewest) viewsNewest = stat.mtimeMs;
  }
  return {
    knowledge,
    views: { newestMtimeMs: viewsNewest },
    scan: {
      analysisNewest: newestMtimeIn(join(projectRoot, "analysis")),
      artifactsNewest: newestMtimeIn(join(projectRoot, "artifacts")),
      mediaNewest: newestMtimeIn(join(projectRoot, "media")),
    },
  };
}

interface AuditCacheEnvelope {
  schemaVersion: 1;
  fingerprint: AuditFingerprint;
  computedAt: string;
  result: ProjectAuditResult;
}

function auditCachePath(projectRoot: string): string {
  return join(projectRoot, "knowledge", ".cache", "project-audit.json");
}

function readAuditCache(projectRoot: string): AuditCacheEnvelope | undefined {
  const path = auditCachePath(projectRoot);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AuditCacheEnvelope;
    if (parsed.schemaVersion !== 1) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeAuditCache(projectRoot: string, envelope: AuditCacheEnvelope): void {
  const path = auditCachePath(projectRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  } catch {
    // best-effort
  }
}

function fingerprintsEqual(left: AuditFingerprint, right: AuditFingerprint): boolean {
  if (left.knowledge.length !== right.knowledge.length) return false;
  if (left.views.newestMtimeMs !== right.views.newestMtimeMs) return false;
  if (left.scan.analysisNewest !== right.scan.analysisNewest) return false;
  if (left.scan.artifactsNewest !== right.scan.artifactsNewest) return false;
  if (left.scan.mediaNewest !== right.scan.mediaNewest) return false;
  for (let index = 0; index < left.knowledge.length; index += 1) {
    const a = left.knowledge[index]!;
    const b = right.knowledge[index]!;
    if (a.path !== b.path || a.mtimeMs !== b.mtimeMs || a.size !== b.size) return false;
  }
  return true;
}

export interface AuditCachedResult {
  audit: ProjectAuditResult;
  cacheStatus: "fresh" | "cached";
  cachedAt?: string;
}

export function auditProjectCached(projectRoot: string, options: ProjectAuditOptions = {}): AuditCachedResult {
  const root = resolve(projectRoot);
  const fingerprint = computeAuditFingerprint(root);
  const cached = readAuditCache(root);
  if (cached && fingerprintsEqual(cached.fingerprint, fingerprint)) {
    return { audit: cached.result, cacheStatus: "cached", cachedAt: cached.computedAt };
  }
  const audit = auditProject(root, options);
  const computedAt = new Date().toISOString();
  writeAuditCache(root, { schemaVersion: 1, fingerprint, computedAt, result: audit });
  return { audit, cacheStatus: "fresh", cachedAt: computedAt };
}

export function renderProjectAudit(audit: ProjectAuditResult): string {
  const lines: string[] = [];
  const paths = createProjectKnowledgePaths(audit.root);
  lines.push(`# Project Audit`);
  lines.push(``);
  lines.push(`Project root: ${audit.root}`);
  lines.push(`Knowledge: ${dirname(paths.knowledgeArtifacts)}`);
  lines.push(`Severity: ${audit.severity}`);
  lines.push(`Safe repair available: ${audit.safeRepairAvailable ? "yes" : "no"}`);
  lines.push(``);
  lines.push(`## Counts`);
  lines.push(`nestedKnowledgeStores=${audit.counts.nestedKnowledgeStores} missingArtifacts=${audit.counts.missingArtifacts} brokenArtifactPaths=${audit.counts.brokenArtifactPaths} unregisteredFiles=${audit.counts.unregisteredFiles} unimportedAnalysisArtifacts=${audit.counts.unimportedAnalysisArtifacts} unimportedManifestArtifacts=${audit.counts.unimportedManifestArtifacts} staleViews=${audit.counts.staleViews}`);
  lines.push(``);
  lines.push(`## Findings`);
  if (audit.findings.length === 0) {
    lines.push(`No audit findings.`);
  } else {
    for (const finding of audit.findings) {
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.id})`);
      lines.push(`  Why: ${finding.whyItMatters}`);
      lines.push(`  Fix: ${finding.suggestedFix}`);
      if (finding.paths.length > 0) {
        lines.push(`  Paths:`);
        for (const path of finding.paths.slice(0, 12)) {
          lines.push(`  - ${path}`);
        }
        if (finding.paths.length > 12) {
          lines.push(`  - ... ${finding.paths.length - 12} more`);
        }
      }
    }
  }
  lines.push(``);
  lines.push(`## Suggested Actions`);
  for (const action of audit.suggestedActions) {
    lines.push(`- ${action}`);
  }
  lines.push(``);
  lines.push(`## JSON`);
  lines.push("```json");
  lines.push(JSON.stringify(audit, null, 2));
  lines.push("```");
  return lines.join("\n");
}
