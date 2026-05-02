import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveProjectDir } from "../project-root.js";
import { auditProject, renderProjectAudit } from "./audit.js";
import { PROJECT_REPAIR_OPERATIONS, repairProject, renderProjectRepair } from "./repair.js";
import { safeHandler } from "../server-tools/safe-handler.js";
import { ProjectKnowledgeService } from "./service.js";

interface RegisterProjectKnowledgeToolsOptions {
  repoDir: string;
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function formatWorkflowPhaseLine(phase: { phaseId: string; status: string; summary?: string; missingArtifactRoles: string[]; blockingPhaseIds: string[] }): string {
  const details: string[] = [];
  if (phase.missingArtifactRoles.length > 0) {
    details.push(`missing roles: ${phase.missingArtifactRoles.join(", ")}`);
  }
  if (phase.blockingPhaseIds.length > 0) {
    details.push(`blocked by: ${phase.blockingPhaseIds.join(", ")}`);
  }
  if (phase.summary) {
    details.push(phase.summary);
  }
  return `- [${phase.status}] ${phase.phaseId}${details.length > 0 ? ` — ${details.join(" | ")}` : ""}`;
}

function resolveWorkspaceRoot(options: RegisterProjectKnowledgeToolsOptions, hintPath?: string, allowCreate = false): string {
  const envProjectDir = process.env.C64RE_PROJECT_DIR?.trim();
  const root = allowCreate
    ? hintPath?.trim()
      ? resolve(process.cwd(), hintPath)
      : envProjectDir
        ? resolve(envProjectDir)
        : resolve(process.cwd())
    : resolveProjectDir({
      cwd: process.cwd(),
      repoDir: options.repoDir,
      hintPath: hintPath?.trim() || undefined,
      requireWritable: false,
    });

  if (root === "/") {
    throw new Error("Refusing to use '/' as a project root.");
  }
  if (resolve(root) === resolve(options.repoDir)) {
    throw new Error("Refusing to use the MCP repository root as a knowledge project root. Point the tool at a target project workspace.");
  }
  if (!allowCreate && !existsSync(root)) {
    throw new Error(`Project root does not exist: ${root}`);
  }
  return root;
}

const evidenceSchema = z.object({
  kind: z.enum(["artifact", "finding", "entity", "relation", "flow", "task", "question", "note", "external"]),
  title: z.string(),
  artifactId: z.string().optional(),
  entityId: z.string().optional(),
  findingId: z.string().optional(),
  relationId: z.string().optional(),
  flowId: z.string().optional(),
  taskId: z.string().optional(),
  questionId: z.string().optional(),
  excerpt: z.string().optional(),
  note: z.string().optional(),
  addressRange: z.object({
    start: z.number().int().min(0).max(0xffff),
    end: z.number().int().min(0).max(0xffff),
    bank: z.number().int().nonnegative().optional(),
    label: z.string().optional(),
  }).optional(),
  fileLocation: z.object({
    path: z.string().optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    offsetStart: z.number().int().nonnegative().optional(),
    offsetEnd: z.number().int().nonnegative().optional(),
  }).optional(),
  capturedAt: z.string().optional(),
});

export function registerProjectKnowledgeTools(server: McpServer, options: RegisterProjectKnowledgeToolsOptions): void {
  server.tool(
    "project_init",
    "Initialize a reverse-engineering project workspace with persistent knowledge, view, analysis, and session folders.",
    {
      project_dir: z.string().optional().describe("Project root directory. Defaults to C64RE_PROJECT_DIR or process.cwd()."),
      name: z.string().describe("Human-readable project name"),
      description: z.string().optional().describe("Optional project description"),
      tags: z.array(z.string()).optional().describe("Optional project tags"),
      preferred_assembler: z.enum(["kickass", "64tass"]).optional().describe("Preferred assembler dialect for generated source and later workflow defaults."),
    },
    safeHandler("project_init", async ({ project_dir, name, description, tags, preferred_assembler }) => {
      const projectRoot = resolveWorkspaceRoot(options, project_dir, true);
      const service = new ProjectKnowledgeService(projectRoot);
      const project = service.initProject({ name, description, tags, preferredAssembler: preferred_assembler });
      const workflow = service.initializeWorkflowContract({
        canonicalDocPaths: [
          resolve(options.repoDir, "docs", "workflow.md"),
          resolve(options.repoDir, "docs", "c64-reverse-engineering-skill.md"),
          resolve(options.repoDir, "docs", "agent-doctrine.md"),
        ],
        canonicalPromptIds: [
          "c64re_agent_doctrine",
          "project_workspace_workflow",
          "c64re_get_skill",
          "full_re_workflow",
          "disk_re_workflow",
          "debug_workflow",
        ],
      });
      const status = service.getProjectStatus();
      return textContent([
        `Project initialized.`,
        `Name: ${project.name}`,
        `Root: ${project.rootPath}`,
        `Preferred assembler: ${project.preferredAssembler ?? "(not set)"}`,
        `Workflow summary: ${workflow.state.summary}`,
        `Current phase: ${workflow.state.currentPhaseId ?? "(none)"}`,
        `Next recommended phase: ${workflow.state.nextRecommendedPhaseId ?? "(none)"}`,
        `Knowledge: ${status.paths.knowledge}`,
        `Phase plan: ${status.paths.knowledgePhasePlan}`,
        `Workflow state: ${status.paths.knowledgeWorkflowState}`,
        `Views: ${status.paths.views}`,
        `Analysis runs: ${status.paths.analysisRuns}`,
        `Session timeline: ${status.paths.sessionTimeline}`,
        `Canonical docs: ${workflow.plan.canonicalDocPaths.join(", ") || "(none)"}`,
        `Canonical prompts: ${workflow.plan.canonicalPromptIds.join(", ") || "(none)"}`,
        ``,
        `Phase status:`,
        ...workflow.state.phases.map((phase) => formatWorkflowPhaseLine(phase)),
      ].join("\n"));
    },
));

  server.tool(
    "project_audit",
    "Read-only audit for project integrity: nested knowledge stores, missing/broken artifacts, unregistered files, unimported analysis/manifests, and stale UI views.",
    {
      project_dir: z.string().optional().describe("Project root directory. Defaults to C64RE_PROJECT_DIR or process.cwd()."),
      include_file_scan: z.boolean().optional().describe("Scan project artifact folders for files missing from artifacts.json. Defaults to true."),
    },
    safeHandler("project_audit", async ({ project_dir, include_file_scan }) => {
      const projectRoot = resolveWorkspaceRoot(options, project_dir);
      const audit = auditProject(projectRoot, { includeFileScan: include_file_scan ?? true });
      return textContent(renderProjectAudit(audit));
    }),
  );

  server.tool(
    "project_repair",
    "Repair project knowledge integrity using audited safe operations. Defaults to dry-run. Safe mode can merge new records from nested stores, register obvious files, import analysis/manifests, and rebuild views; it does not delete files or invent semantic knowledge.",
    {
      project_dir: z.string().optional().describe("Project root directory. Defaults to C64RE_PROJECT_DIR or process.cwd()."),
      mode: z.enum(["dry-run", "safe"]).optional().describe("dry-run previews planned work. safe performs non-destructive repairs. Default dry-run."),
      operations: z.array(z.enum(PROJECT_REPAIR_OPERATIONS)).optional().describe("Subset of repair operations to run. Defaults to all safe operations."),
      limit: z.number().int().positive().max(2000).optional().describe("Maximum records/files per operation. Default 500."),
    },
    safeHandler("project_repair", async ({ project_dir, mode, operations, limit }) => {
      const projectRoot = resolveWorkspaceRoot(options, project_dir);
      const result = repairProject(projectRoot, {
        mode: mode ?? "dry-run",
        operations,
        limit,
      });
      return textContent(renderProjectRepair(result));
    }),
  );

  server.tool(
    "project_status",
    "Summarize the current project knowledge layer, counts, and key filesystem paths.",
    {
      project_dir: z.string().optional().describe("Project root directory. Defaults to C64RE_PROJECT_DIR or process.cwd()."),
    },
    safeHandler("project_status", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const status = service.getProjectStatus();
      return textContent([
        `Project: ${status.project.name}`,
        `Root: ${status.project.rootPath}`,
        `Status: ${status.project.status}`,
        `Preferred assembler: ${status.project.preferredAssembler ?? "(not set)"}`,
        `Workflow: ${status.workflowState.summary}`,
        `Current phase: ${status.workflowState.currentPhaseId ?? "(none)"}`,
        `Next recommended phase: ${status.workflowState.nextRecommendedPhaseId ?? "(none)"}`,
        `Artifacts: ${status.counts.artifacts}`,
        `Entities: ${status.counts.entities}`,
        `Findings: ${status.counts.findings}`,
        `Relations: ${status.counts.relations}`,
        `Flows: ${status.counts.flows}`,
        `Tasks: ${status.counts.tasks}`,
        `Open questions: ${status.counts.openQuestions}`,
        `Checkpoints: ${status.counts.checkpoints}`,
        `Timeline events: ${status.recentTimeline.length} recent`,
        `Phase plan: ${status.paths.knowledgePhasePlan}`,
        `Workflow state: ${status.paths.knowledgeWorkflowState}`,
        `Canonical docs: ${status.workflowPlan.canonicalDocPaths.join(", ") || "(none)"}`,
        `Canonical prompts: ${status.workflowPlan.canonicalPromptIds.join(", ") || "(none)"}`,
        ``,
        `Phase status:`,
        ...status.workflowState.phases.map((phase) => formatWorkflowPhaseLine(phase)),
      ].join("\n"));
    },
));

  server.tool(
    "save_artifact",
    "Persist an input, generated, analysis, or view artifact in the project knowledge layer. Lineage: pass `derived_from` to chain this artifact under a parent (V0 → V1 → ... → Vn); `version_label` defaults to `V<rank>` and can be renamed later via rename_artifact_version. For project-level markdown documents (CLAUDE.md, docs/*.md, BUGREPORT.md, TODO.md, plans, status notes) call this with kind=\"other\", scope=\"knowledge\", format=\"md\", and a meaningful title so the workspace UI Docs tab surfaces them.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      kind: z.enum(["prg", "crt", "d64", "g64", "raw", "analysis-run", "report", "generated-source", "manifest", "extract", "preview", "listing", "trace", "view-model", "checkpoint", "other"]),
      scope: z.enum(["input", "generated", "analysis", "knowledge", "view", "session"]),
      title: z.string(),
      path: z.string(),
      description: z.string().optional(),
      mime_type: z.string().optional(),
      format: z.string().optional(),
      role: z.string().optional(),
      produced_by_tool: z.string().optional(),
      source_artifact_ids: z.array(z.string()).optional(),
      entity_ids: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
      status: z.enum(["proposed", "active", "confirmed", "rejected", "archived"]).optional(),
      tags: z.array(z.string()).optional(),
      evidence: z.array(evidenceSchema).optional(),
      derived_from: z.string().optional().describe("Artifact id of the direct parent in the lineage chain (V0 if absent)."),
      version_label: z.string().optional().describe("Free-form version label. Defaults to V<rank>."),
      enable_snapshot: z.boolean().optional().describe("If true (default), record same-path content changes in versions[]. Set false for ephemeral saves."),
    },
    safeHandler("save_artifact", async ({ project_dir, id, kind, scope, title, path, description, mime_type, format, role, produced_by_tool, source_artifact_ids, entity_ids, confidence, status, tags, evidence, derived_from, version_label, enable_snapshot }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const artifact = service.saveArtifact({
        id,
        kind,
        scope,
        title,
        path,
        description,
        mimeType: mime_type,
        format,
        role,
        producedByTool: produced_by_tool,
        sourceArtifactIds: source_artifact_ids,
        entityIds: entity_ids,
        confidence,
        status,
        tags,
        evidence: evidence?.map((item) => ({
          ...item,
          capturedAt: item.capturedAt ?? new Date().toISOString(),
        })),
        derivedFrom: derived_from,
        versionLabel: version_label,
        enableSnapshot: enable_snapshot,
      });
      const lineageBits = artifact.lineageRoot && artifact.lineageRoot !== artifact.id
        ? `\nLineage: root=${artifact.lineageRoot}, ${artifact.versionLabel ?? `V${artifact.versionRank ?? 0}`} (rank ${artifact.versionRank ?? 0})`
        : `\nLineage: root (${artifact.versionLabel ?? "V0"})`;
      const versionsBits = artifact.versions && artifact.versions.length > 0
        ? `\nVersions: ${artifact.versions.length} prior content hash(es) recorded.`
        : "";
      return textContent(`Artifact saved.\nID: ${artifact.id}\nKind: ${artifact.kind}\nPath: ${artifact.relativePath}${lineageBits}${versionsBits}`);
    },
));

  server.tool(
    "snapshot_artifact_before_overwrite",
    "Spec 025: snapshot the on-disk bytes of an artifact to <root>/snapshots/<id>/<hash>.bin BEFORE overwriting the file. Appends a versions[] entry to the artifact so the prior bytes stay recoverable without git. Call this once per overwrite; saveArtifact afterwards will see the new hash and skip duplicating the version entry. Returns the snapshot path and byte size.",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string(),
    },
    safeHandler("snapshot_artifact_before_overwrite", async ({ project_dir, artifact_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.snapshotArtifactBeforeOverwrite(artifact_id);
      if (!result) {
        return textContent(`No snapshot taken. Either the artifact id was unknown or the on-disk file was missing.`);
      }
      return textContent([
        `Snapshot recorded.`,
        `Artifact: ${result.artifactId}`,
        `Content hash: ${result.contentHash}`,
        `Snapshot path: ${result.snapshotPath}`,
        `Bytes: ${result.bytes}`,
      ].join("\n"));
    },
));

  server.tool(
    "rename_artifact_version",
    "Spec 025: change an artifact's free-form versionLabel without touching bytes or hash.",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string(),
      version_label: z.string().min(1),
    },
    safeHandler("rename_artifact_version", async ({ project_dir, artifact_id, version_label }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const updated = service.renameArtifactVersion(artifact_id, version_label);
      if (!updated) return textContent(`Artifact ${artifact_id} not found.`);
      return textContent(`Renamed to ${updated.versionLabel} (rank ${updated.versionRank ?? 0}).`);
    },
));

  server.tool(
    "get_artifact_lineage",
    "Spec 025: return the V0..Vn lineage chain for the artifact's lineageRoot, ordered by versionRank ascending.",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string(),
    },
    safeHandler("get_artifact_lineage", async ({ project_dir, artifact_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const chain = service.getLineage(artifact_id);
      if (chain.length === 0) return textContent(`Artifact ${artifact_id} not found.`);
      const lines = [`Lineage (${chain.length} entries, root=${chain[0]!.lineageRoot ?? chain[0]!.id}):`];
      for (const item of chain) {
        const label = item.versionLabel ?? `V${item.versionRank ?? 0}`;
        const versions = item.versions && item.versions.length > 0 ? ` (${item.versions.length} same-path version(s))` : "";
        lines.push(`  [rank ${item.versionRank ?? 0}] ${label} ${item.id} ${item.relativePath}${versions}`);
      }
      return textContent(lines.join("\n"));
    },
));

  server.tool(
    "register_container_entry",
    "Spec 025 R23: declare a named sub-entry inside a container artifact (a disk file that itself contains other named payloads — Accolade /0, /1, etc.). Idempotent on (parent_artifact_id, sub_key).",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      parent_artifact_id: z.string(),
      child_artifact_id: z.string().optional().describe("Optional artifact id for the sub-entry as a first-class artifact. Use derived_from on save_artifact to chain it into the lineage."),
      sub_key: z.string().describe("Identifier for the sub-entry (e.g. file key, frame name)."),
      container_offset: z.number().int().nonnegative(),
      container_length: z.number().int().nonnegative(),
      load_address: z.number().int().nonnegative().optional(),
      registration_mode: z.enum(["resident", "transient", "deduped"]).optional(),
      status: z.enum(["physically-present", "missing", "inherited"]).optional(),
      inherited_from: z.string().optional(),
      tags: z.array(z.string()).optional(),
      evidence: z.array(evidenceSchema).optional(),
    },
    safeHandler("register_container_entry", async ({ project_dir, id, parent_artifact_id, child_artifact_id, sub_key, container_offset, container_length, load_address, registration_mode, status, inherited_from, tags, evidence }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const entry = service.saveContainerEntry({
        id,
        parentArtifactId: parent_artifact_id,
        childArtifactId: child_artifact_id,
        subKey: sub_key,
        containerOffset: container_offset,
        containerLength: container_length,
        loadAddress: load_address,
        registrationMode: registration_mode,
        status,
        inheritedFrom: inherited_from,
        tags,
        evidence: evidence?.map((item) => ({ ...item, capturedAt: item.capturedAt ?? new Date().toISOString() })),
      });
      return textContent([
        `Container entry saved.`,
        `ID: ${entry.id}`,
        `Parent: ${entry.parentArtifactId}`,
        `Sub-key: ${entry.subKey}`,
        `Range: offset ${entry.containerOffset}, length ${entry.containerLength}`,
        `Status: ${entry.status}`,
        entry.childArtifactId ? `Child artifact: ${entry.childArtifactId}` : `(no child artifact id linked)`,
      ].join("\n"));
    },
));

  server.tool(
    "list_container_entries",
    "Spec 025 R23: list container sub-entries for a given parent artifact (or all containers if parent_artifact_id is omitted). Sorted by container offset ascending.",
    {
      project_dir: z.string().optional(),
      parent_artifact_id: z.string().optional(),
    },
    safeHandler("list_container_entries", async ({ project_dir, parent_artifact_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const entries = service.listContainerEntries(parent_artifact_id);
      if (entries.length === 0) return textContent(`No container entries${parent_artifact_id ? ` for parent ${parent_artifact_id}` : ""}.`);
      const lines = [`Container entries: ${entries.length}`];
      for (const entry of entries) {
        const status = entry.status === "physically-present" ? "✓" : entry.status === "missing" ? "MISSING" : "inherited";
        lines.push(`  ${entry.parentArtifactId} :: ${entry.subKey}  off=${entry.containerOffset} len=${entry.containerLength}  [${status}]${entry.childArtifactId ? ` → ${entry.childArtifactId}` : ""}`);
      }
      return textContent(lines.join("\n"));
    },
));

  server.tool(
    "list_project_artifacts",
    "List persisted artifacts from the project knowledge layer.",
    {
      project_dir: z.string().optional(),
      scope: z.string().optional(),
      role: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    safeHandler("list_project_artifacts", async ({ project_dir, scope, role, limit }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const artifacts = service.listArtifacts()
        .filter((artifact) => !scope || artifact.scope === scope)
        .filter((artifact) => !role || artifact.role === role)
        .slice(0, limit ?? 50);
      if (artifacts.length === 0) {
        return textContent("No artifacts matched the filters.");
      }
      return textContent(artifacts.map((artifact) =>
        `${artifact.id} | ${artifact.scope}/${artifact.kind} | ${artifact.title} | ${artifact.relativePath}`,
      ).join("\n"));
    },
));

  server.tool(
    "save_finding",
    "Persist a structured semantic finding, hypothesis, confirmation, or refutation in the project knowledge layer.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      kind: z.enum(["observation", "classification", "hypothesis", "confirmation", "refutation", "memory-map", "disk-layout", "cartridge-layout", "flow", "other"]),
      title: z.string(),
      summary: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      status: z.enum(["proposed", "active", "confirmed", "rejected", "archived"]).optional(),
      entity_ids: z.array(z.string()).optional(),
      artifact_ids: z.array(z.string()).optional(),
      relation_ids: z.array(z.string()).optional(),
      flow_ids: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      evidence: z.array(evidenceSchema).optional(),
    },
    safeHandler("save_finding", async ({ project_dir, id, kind, title, summary, confidence, status, entity_ids, artifact_ids, relation_ids, flow_ids, tags, evidence }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const finding = service.saveFinding({
        id,
        kind,
        title,
        summary,
        confidence,
        status,
        entityIds: entity_ids,
        artifactIds: artifact_ids,
        relationIds: relation_ids,
        flowIds: flow_ids,
        tags,
        evidence: evidence?.map((item) => ({
          ...item,
          capturedAt: item.capturedAt ?? new Date().toISOString(),
        })),
      });
      return textContent(`Finding saved.\nID: ${finding.id}\nKind: ${finding.kind}\nTitle: ${finding.title}\nStatus: ${finding.status}\nConfidence: ${finding.confidence}`);
    },
));

  server.tool(
    "list_findings",
    "List persisted findings from the project knowledge layer with optional filters.",
    {
      project_dir: z.string().optional(),
      kind: z.string().optional(),
      status: z.string().optional(),
      entity_id: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    safeHandler("list_findings", async ({ project_dir, kind, status, entity_id, limit }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const findings = service.listFindings({ kind, status, entityId: entity_id }).slice(0, limit ?? 20);
      if (findings.length === 0) {
        return textContent("No findings matched the filters.");
      }
      return textContent(findings.map((finding) =>
        `${finding.id} | ${finding.kind} | ${finding.status} | c=${finding.confidence.toFixed(2)} | ${finding.title}`,
      ).join("\n"));
    },
));

  server.tool(
    "list_entities",
    "List persisted entities from the project knowledge layer with optional filters.",
    {
      project_dir: z.string().optional(),
      kind: z.string().optional(),
      status: z.string().optional(),
      artifact_id: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    safeHandler("list_entities", async ({ project_dir, kind, status, artifact_id, limit }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const entities = service.listEntities({ kind, status, artifactId: artifact_id }).slice(0, limit ?? 50);
      if (entities.length === 0) {
        return textContent("No entities matched the filters.");
      }
      return textContent(entities.map((entity) =>
        `${entity.id} | ${entity.kind} | ${entity.status} | c=${entity.confidence.toFixed(2)} | ${entity.name}`,
      ).join("\n"));
    },
));

  server.tool(
    "list_relations",
    "List persisted relations from the project knowledge layer with optional filters.",
    {
      project_dir: z.string().optional(),
      kind: z.string().optional(),
      entity_id: z.string().optional(),
      artifact_id: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    safeHandler("list_relations", async ({ project_dir, kind, entity_id, artifact_id, limit }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const relations = service.listRelations({ kind, entityId: entity_id, artifactId: artifact_id }).slice(0, limit ?? 50);
      if (relations.length === 0) {
        return textContent("No relations matched the filters.");
      }
      return textContent(relations.map((relation) =>
        `${relation.id} | ${relation.kind} | ${relation.status} | c=${relation.confidence.toFixed(2)} | ${relation.sourceEntityId} -> ${relation.targetEntityId}`,
      ).join("\n"));
    },
));

  server.tool(
    "list_open_questions",
    "List persisted open questions from the project knowledge layer with optional filters.",
    {
      project_dir: z.string().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      entity_id: z.string().optional(),
      finding_id: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    safeHandler("list_open_questions", async ({ project_dir, status, priority, entity_id, finding_id, limit }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const questions = service.listOpenQuestions({ status, priority, entityId: entity_id, findingId: finding_id }).slice(0, limit ?? 50);
      if (questions.length === 0) {
        return textContent("No open questions matched the filters.");
      }
      return textContent(questions.map((question) =>
        `${question.id} | ${question.status} | ${question.priority} | c=${question.confidence.toFixed(2)} | ${question.title}`,
      ).join("\n"));
    },
));

  server.tool(
    "list_tasks",
    "List persisted project tasks from the project knowledge layer with optional filters.",
    {
      project_dir: z.string().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      entity_id: z.string().optional(),
      question_id: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    safeHandler("list_tasks", async ({ project_dir, status, priority, entity_id, question_id, limit }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const tasks = service.listTasks({ status, priority, entityId: entity_id, questionId: question_id }).slice(0, limit ?? 50);
      if (tasks.length === 0) {
        return textContent("No tasks matched the filters.");
      }
      return textContent(tasks.map((task) =>
        `${task.id} | ${task.status} | ${task.priority} | c=${task.confidence.toFixed(2)} | ${task.title}`,
      ).join("\n"));
    },
));

  server.tool(
    "list_flows",
    "List persisted flow or sequence models from the project knowledge layer with optional filters.",
    {
      project_dir: z.string().optional(),
      kind: z.string().optional(),
      entity_id: z.string().optional(),
      artifact_id: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    safeHandler("list_flows", async ({ project_dir, kind, entity_id, artifact_id, limit }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const flows = service.listFlows({ kind, entityId: entity_id, artifactId: artifact_id }).slice(0, limit ?? 50);
      if (flows.length === 0) {
        return textContent("No flows matched the filters.");
      }
      return textContent(flows.map((flow) =>
        `${flow.id} | ${flow.kind} | ${flow.status} | c=${flow.confidence.toFixed(2)} | ${flow.title} | ${flow.nodes.length} nodes / ${flow.edges.length} edges`,
      ).join("\n"));
    },
));

  server.tool(
    "save_open_question",
    "Persist a structured open question or ambiguity in the project knowledge layer.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      kind: z.string(),
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(["open", "researching", "answered", "invalidated", "deferred"]).optional(),
      priority: z.enum(["low", "medium", "high", "critical"]).optional(),
      confidence: z.number().min(0).max(1).optional(),
      entity_ids: z.array(z.string()).optional(),
      artifact_ids: z.array(z.string()).optional(),
      finding_ids: z.array(z.string()).optional(),
      answered_by_finding_id: z.string().optional(),
      answer_summary: z.string().optional(),
      evidence: z.array(evidenceSchema).optional(),
    },
    safeHandler("save_open_question", async ({ project_dir, id, kind, title, description, status, priority, confidence, entity_ids, artifact_ids, finding_ids, answered_by_finding_id, answer_summary, evidence }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const question = service.saveOpenQuestion({
        id,
        kind,
        title,
        description,
        status,
        priority,
        confidence,
        entityIds: entity_ids,
        artifactIds: artifact_ids,
        findingIds: finding_ids,
        answeredByFindingId: answered_by_finding_id,
        answerSummary: answer_summary,
        evidence: evidence?.map((item) => ({
          ...item,
          capturedAt: item.capturedAt ?? new Date().toISOString(),
        })),
      });
      return textContent(`Open question saved.\nID: ${question.id}\nTitle: ${question.title}\nStatus: ${question.status}`);
    },
));

  server.tool(
    "save_entity",
    "Persist a structured entity such as a routine, memory region, bank, disk file, or state variable.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      kind: z.enum([
        "routine",
        "memory-region",
        "memory-address",
        "code-segment",
        "data-table",
        "lookup-table",
        "pointer-table",
        "state-variable",
        "disk-file",
        "disk-track",
        "cartridge-bank",
        "chip",
        "loader-stage",
        "irq-handler",
        "asset",
        "symbol",
        "io-register",
        "entry-point",
        "payload",
        "other",
      ]),
      name: z.string(),
      summary: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      status: z.enum(["proposed", "active", "confirmed", "rejected", "archived"]).optional(),
      artifact_ids: z.array(z.string()).optional(),
      related_entity_ids: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      address_start: z.number().int().min(0).max(0xffff).optional(),
      address_end: z.number().int().min(0).max(0xffff).optional(),
      bank: z.number().int().nonnegative().optional(),
      medium_spans: z.array(z.union([
        z.object({
          kind: z.literal("sector"),
          track: z.number().int().positive(),
          sector: z.number().int().nonnegative(),
          offsetInSector: z.number().int().nonnegative().optional(),
          length: z.number().int().nonnegative(),
        }),
        z.object({
          kind: z.literal("slot"),
          bank: z.number().int().nonnegative(),
          slot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH", "EEPROM", "OTHER"]),
          offsetInBank: z.number().int().nonnegative(),
          length: z.number().int().nonnegative(),
        }),
      ])).optional().describe("Optional physical placement on the medium. Sector spans pin a routine to disk T/S; slot spans pin to a cart bank/slot. Surfaced in the medium-layout view as a resident-region overlay."),
      medium_role: z.enum(["dos", "loader", "eapi", "startup", "code", "data", "padding", "unknown"]).optional().describe("Optional role hint for the medium-resident overlay. Default 'unknown'."),
      evidence: z.array(evidenceSchema).optional(),
    },
    safeHandler("save_entity", async ({ project_dir, id, kind, name, summary, confidence, status, artifact_ids, related_entity_ids, tags, address_start, address_end, bank, medium_spans, medium_role, evidence }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const entity = service.saveEntity({
        id,
        kind,
        name,
        summary,
        confidence,
        status,
        artifactIds: artifact_ids,
        relatedEntityIds: related_entity_ids,
        tags,
        addressRange: address_start !== undefined && address_end !== undefined
          ? { start: address_start, end: address_end, bank }
          : undefined,
        mediumSpans: medium_spans?.map((span) => span.kind === "sector"
          ? { kind: "sector", track: span.track, sector: span.sector, offsetInSector: span.offsetInSector ?? 0, length: span.length }
          : { kind: "slot", bank: span.bank, slot: span.slot, offsetInBank: span.offsetInBank, length: span.length }),
        mediumRole: medium_role,
        evidence: evidence?.map((item) => ({
          ...item,
          capturedAt: item.capturedAt ?? new Date().toISOString(),
        })),
      });
      return textContent(`Entity saved.\nID: ${entity.id}\nKind: ${entity.kind}\nName: ${entity.name}`);
    },
));

  server.tool(
    "import_analysis_report",
    "Import a saved analysis JSON artifact into structured entities and findings.",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string().describe("Artifact id of a previously registered analysis JSON"),
    },
    safeHandler("import_analysis_report", async ({ project_dir, artifact_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.importAnalysisArtifact(artifact_id);
      return textContent([
        `Analysis imported.`,
        `Artifact: ${result.artifact.title}`,
        `Entities: ${result.importedEntityCount}`,
        `Findings: ${result.importedFindingCount}`,
        `Relations: ${result.importedRelationCount}`,
        `Flows: ${result.importedFlowCount}`,
        `Open questions: ${result.importedOpenQuestionCount}`,
      ].join("\n"));
    },
));

  server.tool(
    "import_manifest_artifact",
    "Import a saved manifest artifact into structured entities, findings, and relations.",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string().describe("Artifact id of a previously registered manifest JSON"),
    },
    safeHandler("import_manifest_artifact", async ({ project_dir, artifact_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.importManifestArtifact(artifact_id);
      return textContent([
        `Manifest imported.`,
        `Artifact: ${result.artifact.title}`,
        `Entities: ${result.importedEntityCount}`,
        `Findings: ${result.importedFindingCount}`,
        `Relations: ${result.importedRelationCount}`,
      ].join("\n"));
    },
));

  server.tool(
    "link_entities",
    "Create a structured relation between two saved entities.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      kind: z.enum(["calls", "reads", "writes", "loads", "stores", "contains", "maps-to", "depends-on", "derived-from", "precedes", "follows", "references", "documents", "other"]),
      title: z.string(),
      source_entity_id: z.string(),
      target_entity_id: z.string(),
      summary: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      status: z.enum(["proposed", "active", "confirmed", "rejected", "archived"]).optional(),
      artifact_ids: z.array(z.string()).optional(),
      evidence: z.array(evidenceSchema).optional(),
    },
    safeHandler("link_entities", async ({ project_dir, id, kind, title, source_entity_id, target_entity_id, summary, confidence, status, artifact_ids, evidence }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const relation = service.linkEntities({
        id,
        kind,
        title,
        sourceEntityId: source_entity_id,
        targetEntityId: target_entity_id,
        summary,
        confidence,
        status,
        artifactIds: artifact_ids,
        evidence: evidence?.map((item) => ({
          ...item,
          capturedAt: item.capturedAt ?? new Date().toISOString(),
        })),
      });
      return textContent(`Relation saved.\nID: ${relation.id}\nKind: ${relation.kind}\nSource: ${relation.sourceEntityId}\nTarget: ${relation.targetEntityId}`);
    },
));

  server.tool(
    "save_flow",
    "Persist a flow or sequence model with explicit nodes and edges.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      kind: z.string(),
      title: z.string(),
      summary: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      status: z.enum(["proposed", "active", "confirmed", "rejected", "archived"]).optional(),
      entity_ids: z.array(z.string()).optional(),
      artifact_ids: z.array(z.string()).optional(),
      evidence: z.array(evidenceSchema).optional(),
      nodes: z.array(z.object({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        entityId: z.string().optional(),
        artifactId: z.string().optional(),
        addressRange: z.object({
          start: z.number().int().min(0).max(0xffff),
          end: z.number().int().min(0).max(0xffff),
          bank: z.number().int().nonnegative().optional(),
          label: z.string().optional(),
        }).optional(),
        status: z.enum(["proposed", "active", "confirmed", "rejected", "archived"]).optional(),
        confidence: z.number().min(0).max(1).optional(),
      })).optional(),
      edges: z.array(z.object({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        fromNodeId: z.string(),
        toNodeId: z.string(),
        relationId: z.string().optional(),
        summary: z.string().optional(),
        status: z.enum(["proposed", "active", "confirmed", "rejected", "archived"]).optional(),
        confidence: z.number().min(0).max(1).optional(),
        evidence: z.array(evidenceSchema).optional(),
      })).optional(),
    },
    safeHandler("save_flow", async ({ project_dir, id, kind, title, summary, confidence, status, entity_ids, artifact_ids, evidence, nodes, edges }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const flow = service.saveFlow({
        id,
        kind,
        title,
        summary,
        confidence,
        status,
        entityIds: entity_ids,
        artifactIds: artifact_ids,
        evidence: evidence?.map((item) => ({
          ...item,
          capturedAt: item.capturedAt ?? new Date().toISOString(),
        })),
        nodes: nodes?.map((node) => ({
          ...node,
          status: node.status ?? "active",
          confidence: node.confidence ?? 0.5,
        })),
        edges: edges?.map((edge) => ({
          ...edge,
          status: edge.status ?? "active",
          confidence: edge.confidence ?? 0.5,
          evidence: edge.evidence?.map((item) => ({
            ...item,
            capturedAt: item.capturedAt ?? new Date().toISOString(),
          })) ?? [],
        })),
      });
      return textContent(`Flow saved.\nID: ${flow.id}\nTitle: ${flow.title}\nNodes: ${flow.nodes.length}\nEdges: ${flow.edges.length}`);
    },
));

  server.tool(
    "save_task",
    "Persist a project task, next action, or investigation item in structured form.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      kind: z.string(),
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(["open", "in_progress", "blocked", "done", "wont_fix"]).optional(),
      priority: z.enum(["low", "medium", "high", "critical"]).optional(),
      confidence: z.number().min(0).max(1).optional(),
      entity_ids: z.array(z.string()).optional(),
      artifact_ids: z.array(z.string()).optional(),
      question_ids: z.array(z.string()).optional(),
      evidence: z.array(evidenceSchema).optional(),
    },
    safeHandler("save_task", async ({ project_dir, id, kind, title, description, status, priority, confidence, entity_ids, artifact_ids, question_ids, evidence }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const task = service.saveTask({
        id,
        kind,
        title,
        description,
        status,
        priority,
        confidence,
        entityIds: entity_ids,
        artifactIds: artifact_ids,
        questionIds: question_ids,
        evidence: evidence?.map((item) => ({
          ...item,
          capturedAt: item.capturedAt ?? new Date().toISOString(),
        })),
      });
      return textContent(`Task saved.\nID: ${task.id}\nTitle: ${task.title}\nStatus: ${task.status}\nPriority: ${task.priority}`);
    },
));

  server.tool(
    "update_task_status",
    "Update the status of an existing task in the knowledge layer.",
    {
      project_dir: z.string().optional(),
      task_id: z.string(),
      status: z.enum(["open", "in_progress", "blocked", "done", "wont_fix"]),
    },
    safeHandler("update_task_status", async ({ project_dir, task_id, status }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const task = service.updateTaskStatus(task_id, status);
      return textContent(`Task updated.\nID: ${task.id}\nTitle: ${task.title}\nStatus: ${task.status}`);
    },
));

  server.tool(
    "project_checkpoint",
    "Create a durable checkpoint that snapshots the current investigation state and linked records.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      title: z.string(),
      summary: z.string().optional(),
      artifact_ids: z.array(z.string()).optional(),
      entity_ids: z.array(z.string()).optional(),
      finding_ids: z.array(z.string()).optional(),
      flow_ids: z.array(z.string()).optional(),
      task_ids: z.array(z.string()).optional(),
      question_ids: z.array(z.string()).optional(),
      evidence: z.array(evidenceSchema).optional(),
    },
    safeHandler("project_checkpoint", async ({ project_dir, id, title, summary, artifact_ids, entity_ids, finding_ids, flow_ids, task_ids, question_ids, evidence }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const checkpoint = service.createCheckpoint({
        id,
        title,
        summary,
        artifactIds: artifact_ids,
        entityIds: entity_ids,
        findingIds: finding_ids,
        flowIds: flow_ids,
        taskIds: task_ids,
        questionIds: question_ids,
        evidence: evidence?.map((item) => ({
          ...item,
          capturedAt: item.capturedAt ?? new Date().toISOString(),
        })),
      });
      return textContent(`Checkpoint created.\nID: ${checkpoint.id}\nTitle: ${checkpoint.title}`);
    },
));

  server.tool(
    "build_project_dashboard",
    "Build and persist the JSON dashboard view-model for the current project.",
    {
      project_dir: z.string().optional(),
    },
    safeHandler("build_project_dashboard", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const { path, view } = service.buildProjectDashboardView();
      return textContent(`Project dashboard view built.\nPath: ${path}\nMetrics: ${view.metrics.length}`);
    },
));

  server.tool(
    "build_memory_map",
    "Build and persist the JSON memory-map view-model for the current project.",
    {
      project_dir: z.string().optional(),
    },
    safeHandler("build_memory_map", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const { path, view } = service.buildMemoryMapView();
      return textContent(`Memory map view built.\nPath: ${path}\nRegions: ${view.regions.length}`);
    },
));

  server.tool(
    "build_cartridge_layout_view",
    "Build and persist the JSON cartridge-layout view-model for the current project.",
    {
      project_dir: z.string().optional(),
    },
    safeHandler("build_cartridge_layout_view", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const { path, view } = service.buildCartridgeLayoutView();
      return textContent(`Cartridge layout view built.\nPath: ${path}\nCartridges: ${view.cartridges.length}`);
    },
));

  server.tool(
    "build_disk_layout_view",
    "Build and persist the JSON disk-layout view-model for the current project.",
    {
      project_dir: z.string().optional(),
    },
    safeHandler("build_disk_layout_view", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const { path, view } = service.buildDiskLayoutView();
      return textContent(`Disk layout view built.\nPath: ${path}\nDisks: ${view.disks.length}`);
    },
));

  server.tool(
    "build_load_sequence_view",
    "Build and persist the JSON load-sequence view-model for the current project.",
    {
      project_dir: z.string().optional(),
    },
    safeHandler("build_load_sequence_view", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const { path, view } = service.buildLoadSequenceView();
      return textContent(`Load sequence view built.\nPath: ${path}\nItems: ${view.items.length}\nEdges: ${view.edges.length}`);
    },
));

  server.tool(
    "build_flow_graph_view",
    "Build and persist the JSON flow-graph view-model for the current project.",
    {
      project_dir: z.string().optional(),
    },
    safeHandler("build_flow_graph_view", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const { path, view } = service.buildFlowGraphView();
      return textContent(`Flow graph view built.\nPath: ${path}\nNodes: ${view.nodes.length}\nEdges: ${view.edges.length}`);
    },
));

  server.tool(
    "build_annotated_listing_view",
    "Build and persist the JSON annotated-listing view-model for the current project.",
    {
      project_dir: z.string().optional(),
    },
    safeHandler("build_annotated_listing_view", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const { path, view } = service.buildAnnotatedListingView();
      return textContent(`Annotated listing view built.\nPath: ${path}\nEntries: ${view.entries.length}`);
    },
));

  server.tool(
    "build_all_views",
    "Build and persist all current project JSON view-models in one deterministic pass.",
    {
      project_dir: z.string().optional(),
    },
    safeHandler("build_all_views", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.buildAllViews();
      return textContent([
        `All views built.`,
        `Dashboard: ${result.projectDashboard.path}`,
        `Memory map: ${result.memoryMap.path}`,
        `Disk layout: ${result.diskLayout.path}`,
        `Cartridge layout: ${result.cartridgeLayout.path}`,
        `Load sequence: ${result.loadSequence.path}`,
        `Flow graph: ${result.flowGraph.path}`,
        `Annotated listing: ${result.annotatedListing.path}`,
      ].join("\n"));
    },
));
}
