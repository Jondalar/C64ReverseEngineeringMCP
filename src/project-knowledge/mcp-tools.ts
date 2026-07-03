import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveProjectDir } from "../project-root.js";
import { auditProject, renderProjectAudit } from "./audit.js";
import { PROJECT_REPAIR_OPERATIONS, repairProject, renderProjectRepair } from "./repair.js";
import { safeHandler } from "../server-tools/safe-handler.js";
import { ensureWikiSkeleton } from "./project-wiki.js";
import { ensureUiLauncher } from "./ui-launcher.js";
import { ensureDefaultSteering } from "../server-tools/steering-defaults.js";
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
    "Initialize a reverse-engineering project workspace with persistent knowledge, view, analysis, and session folders. Use ONCE on a fresh directory before any knowledge write — knowledge tools reject an uninitialized project. Not for resuming an existing project (use agent_onboard) or choosing a workflow template (use start_re_workflow). Inputs: project name, optional description/tags/assembler. Returns: created project + knowledge/phase-plan paths.",
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
      // BUG-015 — sort any loose media in the project root into the canonical
      // typed input/ folders (.d64/.g64→disk, .crt→crt, .prg→prg, docs→docs)
      // and register each at its canonical path. Idempotent.
      const mediaSort = service.sortLooseInputMedia();
      // Spec 740.1 — scaffold the project wiki skeleton (docs/index.md +
      // knowledge/activity-log.md) so the search/wiki layer has a home.
      const wikiScaffold = ensureWikiSkeleton(projectRoot);
      // Spec 752 — provision the extract-first grounding doctrine into the
      // project steering file (injected at the top of agent_onboard). Default
      // only; never clobbers a hand-written steering.md.
      const steeringSeed = ensureDefaultSteering(projectRoot);
      // Convenience: a `ui.sh` launcher in the project root to start/restart the
      // workspace (HTTP UI :4310 + runtime daemon :4312) pointed at this project.
      // Idempotent + never clobbers a hand-edited ui.sh.
      const uiLauncher = ensureUiLauncher(projectRoot, options.repoDir);
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
        `Wiki scaffolded: ${wikiScaffold.created.length ? wikiScaffold.created.join(", ") : "already present"}`,
        `Steering (extract-first doctrine): ${steeringSeed}`,
        `UI launcher: ${uiLauncher.created ? `created ${uiLauncher.path} (./ui.sh start|restart|stop|status)` : "already present (not overwritten)"}`,
        `Input media sorted: ${mediaSort.sorted.length} file(s)`,
        ...mediaSort.sorted.map((s) => `  ${s.from} → ${s.to} (${s.kind})`),
        ...(mediaSort.skipped.length > 0
          ? [`Skipped: ${mediaSort.skipped.length}`, ...mediaSort.skipped.map((s) => `  ${s.file}: ${s.reason}`)]
          : []),
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
    "Summarize the current project — knowledge counts + key filesystem paths. Use for a quick 'where is this project at'. Not for the orient-and-next-action flow (use agent_onboard) or the stored profile (use get_project_profile). Inputs: none. Returns: counts + paths.",
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
      platform: z.enum(["c64", "c1541", "c128", "vic20", "plus4", "other"]).optional().describe("Spec 020 platform marker. Default c64 when absent."),
    },
    safeHandler("save_artifact", async ({ project_dir, id, kind, scope, title, path, description, mime_type, format, role, produced_by_tool, source_artifact_ids, entity_ids, confidence, status, tags, evidence, derived_from, version_label, enable_snapshot, platform }) => {
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
        platform,
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
    "Return the V0..Vn version chain for an artifact (oldest→newest). Use to see an artifact's revision history. Not for listing all artifacts (use list_artifacts). Inputs: artifact id. Returns: ordered lineage chain.",
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

  // Spec 038: walk auto-suggested tasks, close those whose
  // autoCloseHint is satisfied. Also runs in agent_onboard.
  server.tool(
    "close_completed_tasks",
    "Spec 038: walk auto-suggested NEXT-hint tasks and close those whose autoCloseHint (file-exists / artifact-registered / phase-reached) is satisfied. Idempotent. Also runs automatically in agent_onboard.",
    { project_dir: z.string().optional() },
    safeHandler("close_completed_tasks", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.closeCompletedAutoTasks();
      return textContent(`Auto-task sweep: ${result.closed} closed of ${result.checked} eligible.`);
    },
));

  // Spec 032 R24: build pipelines.
  server.tool(
    "save_build_pipeline",
    "Spec 032 / R24: define an ordered build pipeline (assemble -> patch -> pack -> CRT etc.) with step input/output artifact ids and expected hashes. Idempotent on id; pass id to update.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      steps: z.array(z.object({
        id: z.string(),
        title: z.string(),
        command: z.string(),
        cwd: z.string().optional(),
        inputArtifactIds: z.array(z.string()).optional(),
        outputArtifactIds: z.array(z.string()).optional(),
        expectedOutputHashes: z.record(z.string(), z.string()).optional(),
        sideEffects: z.array(z.string()).optional(),
      })),
      tags: z.array(z.string()).optional(),
    },
    safeHandler("save_build_pipeline", async ({ project_dir, id, title, description, steps, tags }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const pipeline = service.saveBuildPipeline({
        id,
        title,
        description,
        steps: steps.map((s) => ({
          id: s.id,
          title: s.title,
          command: s.command,
          cwd: s.cwd,
          inputArtifactIds: s.inputArtifactIds ?? [],
          outputArtifactIds: s.outputArtifactIds ?? [],
          expectedOutputHashes: s.expectedOutputHashes,
          sideEffects: s.sideEffects ?? [],
          evidence: [],
        })),
        tags: tags ?? [],
      });
      return textContent(`Pipeline saved.\nID: ${pipeline.id}\nSteps: ${pipeline.steps.length}`);
    },
));

  server.tool(
    "list_build_pipelines",
    "Spec 032: list registered build pipelines.",
    { project_dir: z.string().optional() },
    safeHandler("list_build_pipelines", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const items = service.listBuildPipelines();
      if (items.length === 0) return textContent("No build pipelines defined.");
      return textContent(items.map((p) => `${p.id} | ${p.title} | steps=${p.steps.length}`).join("\n"));
    },
));

  server.tool(
    "start_build_run",
    "Spec 032: start a build run for a pipeline. mode='dry-run' (default) records all steps as skipped; mode='record' marks them pending so record_build_step_result can update them as the caller executes the commands externally.",
    {
      project_dir: z.string().optional(),
      pipeline_id: z.string(),
      mode: z.enum(["dry-run", "record"]).optional(),
    },
    safeHandler("start_build_run", async ({ project_dir, pipeline_id, mode }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      try {
        const run = service.startBuildRun(pipeline_id, mode ?? "dry-run");
        return textContent(`Build run started.\nRun: ${run.id}\nPipeline: ${run.pipelineId}\nSteps: ${run.steps.length}`);
      } catch (error) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "start_build_run",
          error instanceof Error ? error.message : String(error),
          `list_build_pipelines() to discover valid pipeline ids.`,
        );
      }
    },
));

  server.tool(
    "run_build_pipeline",
    "Spec 032 follow-up: orchestrate a build pipeline end-to-end. Runs each step's shell command via spawnSync, captures exit code + stdout/stderr tails + per-output sha256, records the BuildRun. Stops at first failed step unless continue_on_error=true. WARNING: executes shell commands; only run on trusted pipelines.",
    {
      project_dir: z.string().optional(),
      pipeline_id: z.string(),
      continue_on_error: z.boolean().optional(),
    },
    safeHandler("run_build_pipeline", async ({ project_dir, pipeline_id, continue_on_error }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      try {
        const run = service.runBuildPipeline(pipeline_id, { continueOnError: continue_on_error });
        const lines = [
          `Build run: ${run.id}`,
          `Status: ${run.status}`,
          `Steps:`,
          ...run.steps.map((s) => `  ${s.stepId} → ${s.status}${s.exitCode !== undefined ? ` (exit ${s.exitCode})` : ""}${s.durationMs ? ` ${s.durationMs}ms` : ""}`),
        ];
        return textContent(lines.join("\n"));
      } catch (error) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "run_build_pipeline",
          error instanceof Error ? error.message : String(error),
          `list_build_pipelines() to discover valid ids.`,
        );
      }
    },
));

  server.tool(
    "record_build_step_result",
    "Spec 032: record the outcome of a single build step (status + exit code + actual output hashes).",
    {
      project_dir: z.string().optional(),
      run_id: z.string(),
      step_id: z.string(),
      status: z.enum(["pending", "running", "ok", "failed", "skipped"]),
      exit_code: z.number().int().optional(),
      stdout_tail: z.string().optional(),
      stderr_tail: z.string().optional(),
      actual_output_hashes: z.record(z.string(), z.string()).optional(),
      duration_ms: z.number().int().nonnegative().optional(),
    },
    safeHandler("record_build_step_result", async ({ project_dir, run_id, step_id, status, exit_code, stdout_tail, stderr_tail, actual_output_hashes, duration_ms }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const run = service.recordBuildStepResult(run_id, {
        stepId: step_id,
        status,
        exitCode: exit_code,
        stdoutTail: stdout_tail,
        stderrTail: stderr_tail,
        actualOutputHashes: actual_output_hashes,
        durationMs: duration_ms,
      });
      if (!run) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "record_build_step_result",
          `Build run '${run_id}' not found.`,
          `list_build_pipelines + manual list_build_runs to discover valid run ids.`,
        );
      }
      return textContent(`Step ${step_id} -> ${status}.\nRun status: ${run.status}.`);
    },
));

  // Spec 030 R20: runtime scenarios + diff.
  server.tool(
    "define_runtime_scenario",
    "Spec 030 / R20: define a named scenario (target artifact, breakpoints, stop condition, expected milestone). Used by run_runtime_scenario + diff_scenario_runs to compare original vs port builds.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      target_kind: z.enum(["disk", "crt", "prg"]),
      target_artifact_id: z.string(),
      start_media: z.array(z.string()).optional(),
      breakpoints: z.array(z.object({ pc: z.number().int().nonnegative(), label: z.string().optional(), bank: z.number().int().nonnegative().optional() })).optional(),
      stop_kind: z.enum(["frame-count", "pc-hit", "timeout-seconds"]),
      stop_value: z.union([z.number().int(), z.string()]),
      expected_milestone: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    safeHandler("define_runtime_scenario", async ({ project_dir, id, title, description, target_kind, target_artifact_id, start_media, breakpoints, stop_kind, stop_value, expected_milestone, tags }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const scenario = service.saveRuntimeScenario({
        id,
        title,
        description,
        target: { kind: target_kind, artifactId: target_artifact_id },
        startMedia: start_media ?? [],
        breakpoints: breakpoints ?? [],
        stopCondition: { kind: stop_kind, value: stop_value },
        expectedMilestone: expected_milestone,
        tags: tags ?? [],
      });
      return textContent(`Scenario saved.\nID: ${scenario.id}\nTitle: ${scenario.title}\nTarget: ${scenario.target.kind}/${scenario.target.artifactId}`);
    },
));

  server.tool(
    "list_runtime_scenarios",
    "Spec 030: list defined scenarios.",
    { project_dir: z.string().optional() },
    safeHandler("list_runtime_scenarios", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const items = service.listRuntimeScenarios();
      if (items.length === 0) return textContent("No scenarios defined.");
      return textContent(items.map((s) => `${s.id} | ${s.title} | target=${s.target.artifactId}`).join("\n"));
    },
));

  server.tool(
    "record_runtime_event_summary",
    "Spec 030: persist a runtime-event summary for a scenario run. Pass scenarios id + observed events; usually emitted by trace tooling. Returns the assigned runId.",
    {
      project_dir: z.string().optional(),
      run_id: z.string().optional(),
      scenario_id: z.string(),
      build_label: z.string().optional(),
      target_kind: z.string(),
      target_artifact_id: z.string(),
      events: z.array(z.object({
        capturedAt: z.string(),
        pc: z.number().int().nonnegative(),
        bank: z.number().int().nonnegative().optional(),
        caller: z.number().int().nonnegative().optional(),
        fileKey: z.string().optional(),
        trackSector: z.object({ track: z.number().int(), sector: z.number().int() }).optional(),
        destinationStart: z.number().int().nonnegative().optional(),
        destinationEnd: z.number().int().nonnegative().optional(),
        sideIndex: z.number().int().nonnegative().optional(),
        containerSubKey: z.string().optional(),
        success: z.boolean().optional(),
        notes: z.string().optional(),
      })),
      hashes: z.record(z.string(), z.string()).optional(),
      reached_milestone: z.boolean().optional(),
    },
    safeHandler("record_runtime_event_summary", async ({ project_dir, run_id, scenario_id, build_label, target_kind, target_artifact_id, events, hashes, reached_milestone }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const summary = service.recordRuntimeEventSummary({
        runId: run_id,
        scenarioId: scenario_id,
        buildLabel: build_label,
        target: { kind: target_kind, artifactId: target_artifact_id },
        events: events.map((e) => ({ ...e, success: e.success ?? true })),
        hashes: hashes ?? {},
        reachedMilestone: reached_milestone ?? false,
      });
      return textContent(`Run summary saved.\nRun: ${summary.runId}\nScenario: ${summary.scenarioId}\nEvents: ${summary.events.length}`);
    },
));

  server.tool(
    "diff_scenario_runs",
    "Spec 030: diff two recorded scenario runs (baseline vs candidate). Emits + persists a RuntimeDiff with missingLoads, extraLoads, diffDestination, diffPayloadHash, divergentPc.",
    {
      project_dir: z.string().optional(),
      baseline_run_id: z.string(),
      candidate_run_id: z.string(),
    },
    safeHandler("diff_scenario_runs", async ({ project_dir, baseline_run_id, candidate_run_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const diff = service.diffRuntimeRuns(baseline_run_id, candidate_run_id);
      if (!diff) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "diff_scenario_runs",
          `One or both run ids not found.`,
          `list_runtime_scenarios + list_runtime_event_summaries to discover valid runs.`,
        );
      }
      return textContent([
        `Diff written.`,
        `ID: ${diff.id}`,
        `Missing loads: ${diff.missingLoads.length}`,
        `Extra loads: ${diff.extraLoads.length}`,
        `Diff destinations: ${diff.diffDestination.length}`,
        `Diff payload hashes: ${diff.diffPayloadHash.length}`,
        `Divergent PCs (first 20): ${diff.divergentPc.length}`,
      ].join("\n"));
    },
));

  // Bug 28: one-shot backfill for projects whose findings predate the
  // producer fix that populates top-level addressRange.
  server.tool(
    "backfill_finding_address_ranges",
    "Bug 28: walk findings.json and copy evidence[0].addressRange to top-level addressRange when missing. One-shot migration for projects whose hypothesis findings only have evidence-level ranges. Returns count updated. Idempotent.",
    { project_dir: z.string().optional() },
    safeHandler("backfill_finding_address_ranges", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const updated = service.backfillFindingAddressRanges();
      return textContent(`Backfilled top-level addressRange on ${updated} findings.`);
    },
));

  // Bug 29: one-shot backfill for open-questions that predate the
  // producer fix populating addressRange (inherited from parent finding).
  server.tool(
    "backfill_question_address_ranges",
    "Bug 29: walk open-questions.json and copy the linked finding's addressRange (or evidence[0].addressRange as fallback) to the question's top-level addressRange when missing. One-shot migration. Returns count updated. Idempotent.",
    { project_dir: z.string().optional() },
    safeHandler("backfill_question_address_ranges", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const updated = service.backfillQuestionAddressRanges();
      return textContent(`Backfilled addressRange on ${updated} open questions.`);
    },
));

  // Bug 26 / Spec 058 follow-up: backfill `internal` flag on legacy
  // artifacts + entities. Re-runs the path/role/kind heuristic.
  server.tool(
    "backfill_internal_flags",
    "Bug 26 / Spec 058 follow-up: walk artifacts + entities and set `internal: true` on records where the heuristic (path / role / kind) classifies them as infrastructure but the flag was never persisted (legacy data predating the schema field). Idempotent. Entity classification uses the primary linked artifact's flag after the artifact pass. dry_run=true previews without writing.",
    {
      project_dir: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    safeHandler("backfill_internal_flags", async ({ project_dir, dry_run }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.backfillInternalFlags({ dryRun: dry_run ?? false });
      const lines = [
        `backfill_internal_flags${dry_run ? " (dry run)" : ""}`,
        `Artifacts updated: ${result.artifactsUpdated}`,
        `Artifacts already flagged: ${result.artifactsAlreadyFlagged}`,
        `Entities updated: ${result.entitiesUpdated}`,
        `Entities already flagged: ${result.entitiesAlreadyFlagged}`,
      ];
      if (result.sample.length > 0) {
        lines.push(``, `Sample:`);
        for (const s of result.sample) {
          lines.push(`  [${s.kind}] ${s.id} (${s.title})`);
        }
      }
      return textContent(lines.join("\n"));
    },
));

  // Bug 33 Fix A: backfill payloadContentHash on payload-bearing
  // entities whose source artifact is directly-linked (NOT a manifest).
  server.tool(
    "backfill_payload_content_hashes",
    "Bug 33 Fix A: walk payload-bearing entities (kind=payload OR payloadLoadAddress set), and for each whose payloadContentHash is null AND payloadSourceArtifactId points at a directly-linked file (NOT a manifest/aggregator), read the file bytes and compute sha256, writing back into entity.payloadContentHash. For manifest-sourced entities use backfill_manifest_payload_hashes instead. Skips already-hashed entities. dry_run=true previews without writing. Idempotent.",
    {
      project_dir: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    safeHandler("backfill_payload_content_hashes", async ({ project_dir, dry_run }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.backfillPayloadContentHashes({ dryRun: dry_run ?? false });
      const lines = [
        `backfill_payload_content_hashes${dry_run ? " (dry run)" : ""}`,
        `Updated: ${result.updated}`,
        `Skipped (already hashed): ${result.skippedAlreadyHashed}`,
        `Skipped (no source artifact): ${result.skippedNoSource}`,
        `Skipped (manifest source — use backfill_manifest_payload_hashes): ${result.skippedAggregatorSource}`,
        `Skipped (file missing on disk): ${result.skippedFileMissing}`,
      ];
      if (result.sample.length > 0) {
        lines.push(``, `Sample:`);
        for (const s of result.sample) {
          lines.push(`  ${s.entityId} (${s.name}) -> ${s.hash.slice(0, 16)}...`);
        }
      }
      return textContent(lines.join("\n"));
    },
));

  // Bug 33 Fix A (manifest path): backfill payloadContentHash on
  // manifest-sourced entities by re-parsing manifest artifacts.
  server.tool(
    "backfill_manifest_payload_hashes",
    "Bug 33 Fix A (manifest path): walk every artifact of kind=manifest, re-parse it, resolve each entry's file path to bytes, compute sha256, and write back into the matching manifest-imported entity's payloadContentHash. Matches entities by the stableId pattern that manifest-import uses. Skips already-hashed entities. dry_run=true previews. Idempotent.",
    {
      project_dir: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    safeHandler("backfill_manifest_payload_hashes", async ({ project_dir, dry_run }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.backfillManifestPayloadHashes({ dryRun: dry_run ?? false });
      const lines = [
        `backfill_manifest_payload_hashes${dry_run ? " (dry run)" : ""}`,
        `Manifests scanned: ${result.manifestsScanned}`,
        `Updated: ${result.updated}`,
        `Skipped (already hashed): ${result.skippedAlreadyHashed}`,
        `Skipped (manifest entry has no matching entity): ${result.skippedNoMatch}`,
        `Skipped (file missing on disk): ${result.skippedFileMissing}`,
      ];
      if (result.sample.length > 0) {
        lines.push(``, `Sample:`);
        for (const s of result.sample) {
          lines.push(`  ${s.entityId} (${s.name}) -> ${s.hash.slice(0, 16)}...`);
        }
      }
      return textContent(lines.join("\n"));
    },
));

  // Spec 060 / Bug 30: one-shot migration to collapse legacy duplicate
  // artifact registrations (same path, different ids) into one canonical
  // record per path with reference remap across all knowledge stores.
  server.tool(
    "dedupe_artifact_registry",
    "Spec 060 / Bug 30: collapse legacy duplicate artifact registrations (same absolute path, different ids) into one survivor per path. Survivor = oldest createdAt; merges union sourceArtifactIds / entityIds / tags / evidence / loadContexts / versions; references across entities / findings / relations / flows / tasks / open-questions remapped from deprecated ids to survivor ids. dry_run=true previews counts + first 10 sample groups without writing. Idempotent.",
    {
      project_dir: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    safeHandler("dedupe_artifact_registry", async ({ project_dir, dry_run }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.dedupeArtifactRegistry({ dryRun: dry_run ?? false });
      const lines = [
        `dedupe_artifact_registry${dry_run ? " (dry run)" : ""}`,
        `Duplicate path-groups: ${result.duplicateGroupCount}`,
        `Rows ${dry_run ? "would merge" : "merged"}: ${result.mergedRowCount}`,
        `Survivors after dedupe: ${result.survivorCount}`,
        `Reference remap counts:`,
        ...Object.entries(result.referenceRemapCounts).map(([k, v]) => `  ${k}: ${v}`),
      ];
      if (result.sample.length > 0) {
        lines.push(``, `Sample (first ${result.sample.length}):`);
        for (const s of result.sample) {
          lines.push(`  ${s.path}`);
          lines.push(`    survivor=${s.survivorId}`);
          lines.push(`    merged=${s.mergedIds.join(", ")}`);
        }
      }
      return textContent(lines.join("\n"));
    },
));

  // Spec 060 / Bug 31: one-shot migration to collapse legacy duplicate
  // payload entities (same payloadContentHash, or same source+load) into
  // one survivor, fold prefixed-name siblings into aliases[], and mark
  // manifest-source entities internal=true.
  server.tool(
    "dedupe_payload_entities",
    "Spec 060 / Bug 31: collapse legacy duplicate payload-bearing entities into one survivor per (payloadContentHash) or (payloadSourceArtifactId + payloadLoadAddress). Survivor preference: kind==payload first, then earliest createdAt. Other names fold into survivor.aliases[]. Manifest-source entities (linked artifact internal=true) are marked internal rather than removed. References across entities, findings, relations, flows, tasks, open-questions, artifacts remap from deprecated entity ids to survivor ids. dry_run=true previews counts + first 10 sample groups without writing. Idempotent.",
    {
      project_dir: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    safeHandler("dedupe_payload_entities", async ({ project_dir, dry_run }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.dedupePayloadEntities({ dryRun: dry_run ?? false });
      const lines = [
        `dedupe_payload_entities${dry_run ? " (dry run)" : ""}`,
        `Duplicate groups: ${result.duplicateGroupCount}`,
        `Rows ${dry_run ? "would merge" : "merged"}: ${result.mergedRowCount}`,
        `Survivors after dedupe: ${result.survivorCount}`,
        `Manifest-source entities marked internal: ${result.manifestEntitiesMarkedInternal}`,
        `Reference remap counts:`,
        ...Object.entries(result.referenceRemapCounts).map(([k, v]) => `  ${k}: ${v}`),
      ];
      if (result.sample.length > 0) {
        lines.push(``, `Sample (first ${result.sample.length}):`);
        for (const s of result.sample) {
          lines.push(`  ${s.key}`);
          lines.push(`    survivor=${s.survivorId} (${s.survivorName})`);
          lines.push(`    merged=${s.mergedNames.join(", ")}`);
        }
      }
      return textContent(lines.join("\n"));
    },
));

  // Spec 053 (Bug 20): phase-1 noise archive + segment confirmation.
  server.tool(
    "archive_phase1_noise",
    "Spec 053 (Bug 20): walk hypothesis-kind findings with addressRange, archive any that fall fully inside a routine annotation finding's addressRange. Also closes paired heuristic-phase1 questions whose title address matches. dry_run=true previews without writing. Spec 056 R27: pass `artifact_id` to scope routines + hypothesis candidates + questions to those linked to a single artifact (per-file feedback signal).",
    {
      project_dir: z.string().optional(),
      dry_run: z.boolean().optional(),
      artifact_id: z.string().optional().describe("Spec 056 R27: scope the sweep to this artifact only."),
    },
    safeHandler("archive_phase1_noise", async ({ project_dir, dry_run, artifact_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.archivePhase1Noise({ dryRun: dry_run ?? false, artifactId: artifact_id });
      const scopeLine = result.scope === "artifact" ? ` [scope=artifact:${result.scopeArtifactId}]` : "";
      const lines = [
        `archive_phase1_noise${dry_run ? " (dry run)" : ""}${scopeLine}`,
        `Routines scanned: ${result.routinesScanned}`,
        `Findings ${dry_run ? "would archive" : "archived"}: ${result.findingsArchived}`,
        `Questions answered: ${result.questionsAnswered}`,
      ];
      if (dry_run && result.preview.length > 0) {
        lines.push("");
        lines.push("Preview (first 10):");
        for (const p of result.preview.slice(0, 10)) {
          lines.push(`  ${p.findingId} | ${p.title} → superseded by ${p.supersededBy}`);
        }
      }
      return textContent(lines.join("\n"));
    },
));

  server.tool(
    "mark_segment_confirmed",
    "Spec 053 (Bug 20): mark a sprite/charset/bitmap segment in *_analysis.json as confirmed by a render evidence. Also creates a confirmation finding with status confirmed.",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string().describe("Source PRG/raw artifact id whose analysis JSON contains the segment."),
      address: z.number().int().nonnegative(),
      length: z.number().int().positive(),
      kind: z.string().describe("Segment kind to match (sprite, charset, bitmap, etc.)."),
      evidence_artifact_id: z.string().optional().describe("Optional evidence artifact id (typically the rendered PNG)."),
    },
    safeHandler("mark_segment_confirmed", async ({ project_dir, artifact_id, address, length, kind, evidence_artifact_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.markSegmentConfirmed({ artifactId: artifact_id, address, length, kind, evidenceArtifactId: evidence_artifact_id });
      if (!result) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "mark_segment_confirmed",
          `Artifact ${artifact_id} not found.`,
          `list_artifacts() to discover valid ids.`,
        );
      }
      const lines = [
        `Segment confirmation finding: ${result.findingId}`,
        result.segmentMatched ? `Analysis JSON updated: ${result.analysisPath}` : `No matching segment found in analysis JSON; finding still recorded.`,
      ];
      return textContent(lines.join("\n"));
    },
));

  // Spec 053 / Bug 21: companion to mark_segment_confirmed.
  server.tool(
    "mark_segment_rejected",
    "Spec 053 (Bug 20/21): mark a sprite/charset/bitmap segment in *_analysis.json as a false-positive analyzer classification. Writes rejected:true + rejectedReason into the segment AND creates a refutation finding.",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string(),
      address: z.number().int().nonnegative(),
      length: z.number().int().positive(),
      kind: z.string(),
      reason: z.string(),
    },
    safeHandler("mark_segment_rejected", async ({ project_dir, artifact_id, address, length, kind, reason }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.markSegmentRejected({ artifactId: artifact_id, address, length, kind, reason });
      if (!result) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "mark_segment_rejected",
          `Artifact ${artifact_id} not found.`,
          `list_artifacts() to discover valid ids.`,
        );
      }
      const lines = [
        `Segment refutation finding: ${result.findingId}`,
        result.segmentMatched ? `Analysis JSON updated: ${result.analysisPath}` : `No matching segment found in analysis JSON; finding still recorded.`,
      ];
      return textContent(lines.join("\n"));
    },
));

  // Spec 052: question auto-resolution.
  server.tool(
    "propose_question_resolutions",
    "Spec 052: read-only proposal — list what the resolver would do for open auto-resolvable questions (Pfad A finding-overlap, Pfad B phase-reached). Useful before flipping projectProfile.questionAutoResolveMode.",
    { project_dir: z.string().optional() },
    safeHandler("propose_question_resolutions", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const proposals = service.proposeQuestionResolutions();
      if (proposals.length === 0) return textContent("No proposals — no auto-resolvable questions match.");
      return textContent([
        `Question resolution proposals (${proposals.length}):`,
        ...proposals.map((p) => `  ${p.questionId} | ${p.questionTitle} → ${p.reason}${p.confidence !== undefined ? ` (conf ${p.confidence.toFixed(2)})` : ""}`),
      ].join("\n"));
    },
));

  server.tool(
    "auto_resolve_questions",
    "Spec 052: run the catch-up sweep across all auto-resolvable questions (Pfad A + B). Pfad C runs from the annotation-save endpoint. Returns counts. Spec 056 R27: pass `artifact_id` to scope the sweep to questions/findings linked to that artifact only — useful as a per-file feedback signal after annotation work.",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string().optional().describe("Spec 056 R27: scope the sweep to this artifact (only questions/findings linked to it are considered)."),
    },
    safeHandler("auto_resolve_questions", async ({ project_dir, artifact_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.sweepQuestionResolutions({ artifactId: artifact_id });
      const scopeLine = result.scope === "artifact" ? ` [scope=artifact:${result.scopeArtifactId}]` : "";
      return textContent(`Sweep done: ${result.autoResolved} answered, ${result.pending} resolution-pending, ${result.phaseClosed} closed via phase-reached.${scopeLine}`);
    },
));

  server.tool(
    "confirm_question_resolution",
    "Spec 052: confirm or reject a resolution-pending question. accept=true marks it answered with the proposed summary; accept=false flips it back to open with a rejection note.",
    {
      project_dir: z.string().optional(),
      question_id: z.string(),
      accept: z.boolean(),
    },
    safeHandler("confirm_question_resolution", async ({ project_dir, question_id, accept }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const updated = service.confirmQuestionResolution(question_id, accept);
      if (!updated) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "confirm_question_resolution",
          `Question ${question_id} not found.`,
          `list_open_questions() to discover ids.`,
        );
      }
      return textContent(`Question ${updated.id} → status ${updated.status}.`);
    },
));

  // Spec 037: payload disk hint.
  server.tool(
    "set_payload_disk_hint",
    "Use to tag a payload entity with a disk-structure hint (drive-code, protected, raw-unanalyzed, bad-crc, or gap) so the disk heatmap UI can colour-code it correctly. Not for sector-level extraction (use extract_disk or extract_disk_custom_lut) or for general findings (use save_finding). Inputs: project dir (optional), payload_entity_id from list_payloads, and the hint value; pass no hint to clear. Updates the payload entity record; the disk layout view reflects the hint after build_all_views.",
    {
      project_dir: z.string().optional(),
      payload_entity_id: z.string(),
      hint: z.enum(["drive-code", "protected", "raw-unanalyzed", "bad-crc", "gap"]).optional(),
    },
    safeHandler("set_payload_disk_hint", async ({ project_dir, payload_entity_id, hint }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const updated = service.setPayloadDiskHint(payload_entity_id, hint);
      if (!updated) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "set_payload_disk_hint",
          `Payload entity '${payload_entity_id}' not found.`,
          `list_payloads() to discover valid ids.`,
        );
      }
      return textContent(`Hint ${hint ?? "(cleared)"} set on ${updated.id}.`);
    },
));

  // Spec 041: relevance ranking.
  server.tool(
    "set_artifact_relevance",
    "Spec 041: tag an artifact with a relevance value (loader | protection | save | kernal | asset | other). Drives sorting in the dashboard + cracker-mode propose_next ranking.",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string(),
      relevance: z.enum(["loader", "protection", "save", "kernal", "asset", "other"]).optional(),
    },
    safeHandler("set_artifact_relevance", async ({ project_dir, artifact_id, relevance }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const updated = service.setArtifactRelevance(artifact_id, relevance);
      if (!updated) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "set_artifact_relevance",
          `Artifact '${artifact_id}' not found.`,
          `list_artifacts() to discover valid ids.`,
        );
      }
      return textContent(`Relevance ${relevance ?? "(cleared)"} set on ${updated.id}.`);
    },
));

  server.tool(
    "auto_tag_relevance",
    "Spec 041: heuristic-classify all artifacts and propose relevance tags (loader / protection / save / kernal / asset). Suggestions only — call set_artifact_relevance to apply. dry_run=true (default) returns proposals without writing.",
    {
      project_dir: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    safeHandler("auto_tag_relevance", async ({ project_dir, dry_run }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const proposals = service.proposeArtifactRelevance();
      const dry = dry_run ?? true;
      if (dry || proposals.length === 0) {
        if (proposals.length === 0) return textContent("No proposals — every artifact already tagged or no heuristic match.");
        return textContent([
          `Auto-relevance proposals (dry-run, ${proposals.length}):`,
          ...proposals.map((p) => `  ${p.title}: ${p.proposed} (${p.reason})${p.current ? ` [current: ${p.current}]` : ""}`),
          ``,
          `Re-run with dry_run=false to apply.`,
        ].join("\n"));
      }
      let applied = 0;
      for (const p of proposals) {
        if (p.proposed) {
          service.setArtifactRelevance(p.artifactId, p.proposed);
          applied += 1;
        }
      }
      return textContent(`Applied relevance tags to ${applied} artifact(s).`);
    },
));

  // Spec 034 / 035: phase orchestration tools.
  server.tool(
    "agent_advance_phase",
    "Spec 034: advance an artifact to a target phase (1..7) in the seven-phase RE workflow. Skipping more than one phase forward requires an evidence string. Cannot move backward.",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string(),
      to_phase: z.number().int().min(1).max(7),
      evidence: z.string().optional(),
    },
    safeHandler("agent_advance_phase", async ({ project_dir, artifact_id, to_phase, evidence }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const updated = service.advanceArtifactPhase(artifact_id, to_phase as 1|2|3|4|5|6|7, evidence);
      if (!updated) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "agent_advance_phase",
          `Artifact id '${artifact_id}' not found in the project.`,
          `list_artifacts() to discover valid ids, then re-run agent_advance_phase.`,
        );
      }
      return textContent(`Phase advanced.\nArtifact: ${updated.id}\nNew phase: ${updated.phase}`);
    },
));

  server.tool(
    "agent_freeze_artifact",
    "Spec 034: freeze an artifact at its current phase (cracker mode for asset PRGs / level data that has no relevance to the crack). Frozen artifacts skip propose_next and count as 'done' for completion math.",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string(),
      reason: z.string(),
    },
    safeHandler("agent_freeze_artifact", async ({ project_dir, artifact_id, reason }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const updated = service.freezeArtifactAtPhase(artifact_id, reason);
      if (!updated) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "agent_freeze_artifact",
          `Artifact id '${artifact_id}' not found.`,
          `list_artifacts() to discover valid ids.`,
        );
      }
      return textContent(`Frozen at phase ${updated.phase ?? 1}: ${reason}`);
    },
));

  // Spec 026 project profile.
  server.tool(
    "save_project_profile",
    "Spec 026: persist a structured project profile (goals, non-goals, hardware constraints, destructive operations, build/test commands, danger zones, glossary, anti-patterns). Onboarding consumes this before suggesting next actions. Patch semantics — undefined fields keep their existing value.",
    {
      project_dir: z.string().optional(),
      goals: z.array(z.string()).optional(),
      non_goals: z.array(z.string()).optional(),
      hardware_constraints: z.array(z.object({ resource: z.string(), constraint: z.string(), reason: z.string().optional() })).optional(),
      loader_model: z.string().optional(),
      destructive_operations: z.array(z.object({ commandPattern: z.string(), warning: z.string() })).optional(),
      build: z.object({ command: z.string(), cwd: z.string().optional(), outputs: z.array(z.string()).optional() }).optional(),
      test: z.object({ command: z.string(), cwd: z.string().optional() }).optional(),
      active_workspace: z.string().optional(),
      danger_zones: z.array(z.object({ pathOrAddress: z.string(), reason: z.string() })).optional(),
      glossary: z.array(z.object({ term: z.string(), definition: z.string(), aliases: z.array(z.string()).optional() })).optional(),
      anti_patterns: z.array(z.object({ title: z.string(), reason: z.string(), refutationEvidence: z.string().optional() })).optional(),
      cracker_overrides: z.array(z.string()).optional(),
    },
    safeHandler("save_project_profile", async ({ project_dir, goals, non_goals, hardware_constraints, loader_model, destructive_operations, build, test, active_workspace, danger_zones, glossary, anti_patterns, cracker_overrides }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const profile = service.saveProjectProfile({
        goals,
        nonGoals: non_goals,
        hardwareConstraints: hardware_constraints,
        loaderModel: loader_model,
        destructiveOperations: destructive_operations,
        build: build ? { command: build.command, cwd: build.cwd, outputs: build.outputs ?? [] } : undefined,
        test,
        activeWorkspace: active_workspace,
        dangerZones: danger_zones,
        glossary: glossary?.map((g) => ({ term: g.term, definition: g.definition, aliases: g.aliases ?? [] })),
        antiPatterns: anti_patterns,
        crackerOverrides: cracker_overrides,
      });
      return textContent(`Project profile saved.\nGoals: ${profile.goals.length}, non-goals: ${profile.nonGoals.length}, destructive ops: ${profile.destructiveOperations.length}, danger zones: ${profile.dangerZones.length}.`);
    },
));

  server.tool(
    "get_project_profile",
    "Read the current project profile (platform, title, metadata). Use to see top-level project settings. Not for live counts/paths (use project_status). Inputs: none. Returns: profile record.",
    { project_dir: z.string().optional() },
    safeHandler("get_project_profile", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const profile = service.getProjectProfile();
      if (!profile) return textContent("No project profile saved yet. Use save_project_profile to scaffold.");
      return textContent(JSON.stringify(profile, null, 2));
    },
));

  // Spec 031 anti-patterns + doc render.
  server.tool(
    "save_anti_pattern",
    "Spec 031: record a 'do not try this again' anti-pattern. Severity drives whether onboarding surfaces it as a warning. Optional commandPattern lets agent_propose_next filter actions matching the pattern.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      title: z.string(),
      reason: z.string(),
      severity: z.enum(["info", "warn", "error"]).optional(),
      command_pattern: z.string().optional(),
      tool_name: z.string().optional(),
      phase: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    safeHandler("save_anti_pattern", async ({ project_dir, id, title, reason, severity, command_pattern, tool_name, phase, tags }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const entry = service.saveAntiPattern({
        id,
        title,
        reason,
        severity: severity ?? "warn",
        appliesTo: (command_pattern || tool_name || phase) ? { commandPattern: command_pattern, toolName: tool_name, phase } : undefined,
        tags: tags ?? [],
        evidence: [],
      });
      return textContent(`Anti-pattern saved.\nID: ${entry.id}\nSeverity: ${entry.severity}\nTitle: ${entry.title}`);
    },
));

  server.tool(
    "list_anti_patterns",
    "Spec 031: list registered anti-patterns sorted by recency.",
    { project_dir: z.string().optional() },
    safeHandler("list_anti_patterns", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const items = service.listAntiPatterns();
      if (items.length === 0) return textContent("No anti-patterns registered.");
      return textContent(items.map((a) => `[${a.severity}] ${a.title} — ${a.reason}`).join("\n"));
    },
));

  server.tool(
    "render_docs",
    "Render human-readable markdown summaries (findings, entities, open questions, anti-patterns, profile) under docs/. Use to produce readable project docs. Not for the UI JSON view-models (use build_all_views). Inputs: optional defer flag (set true during bulk ops, render once at the end). Returns: written doc paths.",
    {
      project_dir: z.string().optional(),
      scope: z.enum(["all", "findings", "entities", "open-questions", "anti-patterns", "project-profile"]).optional(),
    },
    safeHandler("render_docs", async ({ project_dir, scope }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.renderDocs(scope ?? "all");
      return textContent(`Rendered ${result.written.length} doc(s):\n${result.written.join("\n")}`);
    },
));

  // Spec 027 patch recipes.
  server.tool(
    "save_patch_recipe",
    "Spec 027: persist a binary patch recipe with byte-level assertions. Status starts at draft.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      title: z.string(),
      reason: z.string(),
      target_artifact_id: z.string(),
      target_file_offset: z.number().int().nonnegative().optional(),
      target_runtime_address: z.number().int().nonnegative().optional(),
      expected_bytes: z.string().describe("Hex (e.g. 'ad 21 d0')."),
      replacement_bytes: z.string().optional().describe("Hex bytes; alternatively use replacement_source_path."),
      replacement_source_path: z.string().optional().describe("Path (project-relative) of a file holding the replacement bytes."),
      verification_command: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    safeHandler("save_patch_recipe", async ({ project_dir, id, title, reason, target_artifact_id, target_file_offset, target_runtime_address, expected_bytes, replacement_bytes, replacement_source_path, verification_command, tags }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const recipe = service.savePatchRecipe({
        id,
        title,
        reason,
        targetArtifactId: target_artifact_id,
        targetFileOffset: target_file_offset,
        targetRuntimeAddress: target_runtime_address,
        expectedBytes: expected_bytes,
        replacementBytes: replacement_bytes,
        replacementSourcePath: replacement_source_path,
        verificationCommand: verification_command,
        evidence: [],
        tags: tags ?? [],
      });
      return textContent(`Patch recipe saved.\nID: ${recipe.id}\nStatus: ${recipe.status}\nTarget: ${recipe.targetArtifactId}@${recipe.targetFileOffset ?? 0}`);
    },
));

  server.tool(
    "apply_patch_recipe",
    "Spec 027: apply a patch recipe. Refuses if expected bytes do not match the target unless allow_mismatch is set. Snapshots prior bytes via Spec 025 versioning.",
    {
      project_dir: z.string().optional(),
      recipe_id: z.string(),
      allow_mismatch: z.boolean().optional(),
    },
    safeHandler("apply_patch_recipe", async ({ project_dir, recipe_id, allow_mismatch }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const result = service.applyPatchRecipe(recipe_id, { allowMismatch: allow_mismatch });
      if (!result.ok) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "apply_patch_recipe",
          `Patch refused: ${result.reason}`,
          result.reason?.includes("recipe not found")
            ? `list_patch_recipes() to discover valid recipe ids.`
            : `apply_patch_recipe(recipe_id="${recipe_id}", allow_mismatch=true) to override the byte assertion (only if you are sure).`,
        );
      }
      return textContent(`Patch applied.\nNew hash: ${result.appliedHash}`);
    },
));

  server.tool(
    "list_patch_recipes",
    "Spec 027: list patch recipes (optionally filtered by status or target artifact).",
    {
      project_dir: z.string().optional(),
      status: z.enum(["draft", "applied", "verified", "reverted", "failed"]).optional(),
      target_artifact_id: z.string().optional(),
    },
    safeHandler("list_patch_recipes", async ({ project_dir, status, target_artifact_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const items = service.listPatchRecipes({ status, targetArtifactId: target_artifact_id });
      if (items.length === 0) return textContent("No patch recipes.");
      return textContent(items.map((r) => `[${r.status}] ${r.title} → ${r.targetArtifactId}@${r.targetFileOffset ?? 0}`).join("\n"));
    },
));

  // Spec 029 constraints.
  server.tool(
    "register_resource_region",
    "Spec 029: declare a memory / cart / IO resource region for the constraint checker.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      kind: z.enum(["ram-range", "zp-byte", "vic-region", "cart-bank", "cart-erase-sector", "eapi-runtime", "io-register"]),
      name: z.string(),
      start: z.number().int().nonnegative().optional(),
      end: z.number().int().nonnegative().optional(),
      bank: z.number().int().nonnegative().optional(),
      attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    safeHandler("register_resource_region", async ({ project_dir, id, kind, name, start, end, bank, attributes, notes, tags }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const region = service.registerResourceRegion({ id, kind, name, start, end, bank, attributes, notes, tags: tags ?? [] });
      return textContent(`Region registered.\nID: ${region.id}\nName: ${region.name}\nKind: ${region.kind}`);
    },
));

  server.tool(
    "register_operation",
    "Spec 029: declare an operation that affects one or more resource regions (overlay-copy, flash-erase, bank-switch, etc.).",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      kind: z.enum(["overlay-copy", "flash-erase", "flash-write", "bank-switch", "decrunch-write", "runtime-patch", "kernal-call"]),
      triggered_by: z.string(),
      affects: z.array(z.string()).default([]),
      preconditions: z.array(z.string()).optional(),
      notes: z.string().optional(),
    },
    safeHandler("register_operation", async ({ project_dir, id, kind, triggered_by, affects, preconditions, notes }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const op = service.registerOperation({ id, kind, triggeredBy: triggered_by, affects, preconditions: preconditions ?? [], evidence: [], notes });
      return textContent(`Operation registered.\nID: ${op.id}\nKind: ${op.kind}\nAffects: ${op.affects.length} region(s)`);
    },
));

  server.tool(
    "register_constraint",
    "Spec 029: declare a constraint rule. v1 stores rule text only; downstream evaluation is via built-in predicates.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      title: z.string(),
      rule: z.string(),
      severity: z.enum(["info", "warn", "error"]).optional(),
      applies_to_region_kind: z.string().optional(),
      applies_to_op_kind: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    safeHandler("register_constraint", async ({ project_dir, id, title, rule, severity, applies_to_region_kind, applies_to_op_kind, tags }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const r = service.registerConstraintRule({
        id,
        title,
        rule,
        severity: severity ?? "warn",
        appliesTo: (applies_to_region_kind || applies_to_op_kind) ? { regionKind: applies_to_region_kind, opKind: applies_to_op_kind } : undefined,
        tags: tags ?? [],
      });
      return textContent(`Constraint rule registered.\nID: ${r.id}\nSeverity: ${r.severity}`);
    },
));

  server.tool(
    "verify_constraints",
    "Spec 029: run the built-in constraint checker. v1 detects operations whose affects[] overlap a region tagged protected:true. User-registered rules are surfaced as informational text.",
    { project_dir: z.string().optional() },
    safeHandler("verify_constraints", async ({ project_dir }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const violations = service.verifyConstraints();
      if (violations.length === 0) return textContent("No violations.");
      return textContent(violations.map((v) => `[${v.severity}] ${v.ruleId}: ${v.message}`).join("\n"));
    },
));

  server.tool(
    "register_load_context",
    "Spec 023: register a runtime / after-decompression load context on an artifact. Use when a custom fastloader places the file at a runtime address that differs from the on-disk PRG header. Idempotent on (artifact_id, kind, address, bank).",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string(),
      kind: z.enum(["as-stored", "runtime", "after-decompression"]),
      address: z.number().int().nonnegative(),
      bank: z.number().int().nonnegative().optional(),
      triggered_by_pc: z.number().int().nonnegative().optional(),
      source_track: z.number().int().nonnegative().optional(),
      source_sector: z.number().int().nonnegative().optional(),
    },
    safeHandler("register_load_context", async ({ project_dir, artifact_id, kind, address, bank, triggered_by_pc, source_track, source_sector }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const updated = service.registerLoadContext(artifact_id, {
        kind,
        address,
        bank,
        triggeredByPc: triggered_by_pc,
        sourceTrack: source_track,
        sourceSector: source_sector,
        evidence: [],
        capturedAt: new Date().toISOString(),
      });
      if (!updated) {
        const { nextStepError } = await import("../server-tools/error-helpers.js");
        return nextStepError(
          "register_load_context",
          `Artifact id '${artifact_id}' not found.`,
          `list_artifacts() to discover valid ids.`,
        );
      }
      return textContent(`Load context registered. ${updated.loadContexts?.length ?? 0} context(s) total on ${artifact_id}.`);
    },
));

  server.tool(
    "declare_loader_entrypoint",
    "Spec 028: declare a loader entry point on an artifact (jump-table, sector-load, container-decode, dispatch, init, other). Idempotent on (artifact_id, address, kind).",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      artifact_id: z.string(),
      address: z.number().int().nonnegative(),
      bank: z.number().int().nonnegative().optional(),
      kind: z.enum(["jump-table", "sector-load", "container-decode", "dispatch", "init", "other"]),
      name: z.string().optional(),
      param_block_address: z.number().int().nonnegative().optional(),
      param_block_layout: z.string().optional(),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    safeHandler("declare_loader_entrypoint", async ({ project_dir, id, artifact_id, address, bank, kind, name, param_block_address, param_block_layout, notes, tags }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const entry = service.declareLoaderEntryPoint({
        id,
        artifactId: artifact_id,
        address,
        bank,
        kind,
        name,
        paramBlock: (param_block_address !== undefined || param_block_layout !== undefined) ? {
          address: param_block_address,
          layout: param_block_layout,
        } : undefined,
        notes,
        tags: tags ?? [],
      });
      return textContent(`Loader entry point declared.\nID: ${entry.id}\nArtifact: ${entry.artifactId}\nAddress: $${entry.address.toString(16).toUpperCase()}\nKind: ${entry.kind}${entry.name ? `\nName: ${entry.name}` : ""}`);
    },
));

  server.tool(
    "list_loader_entrypoints",
    "Spec 028: list declared loader entry points (optionally filtered to one artifact).",
    {
      project_dir: z.string().optional(),
      artifact_id: z.string().optional(),
    },
    safeHandler("list_loader_entrypoints", async ({ project_dir, artifact_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const items = service.listLoaderEntryPoints(artifact_id);
      if (items.length === 0) return textContent(`No loader entry points${artifact_id ? ` for artifact ${artifact_id}` : ""}.`);
      const lines = [`Loader entry points: ${items.length}`];
      for (const e of items) {
        lines.push(`  $${e.address.toString(16).toUpperCase()}  ${e.kind}  ${e.name ?? "(unnamed)"}  artifact=${e.artifactId}`);
      }
      return textContent(lines.join("\n"));
    },
));

  server.tool(
    "record_loader_event",
    "Spec 028: persist one observed loader call. Source 'static' for code-pattern inferences, 'trace' for VICE-observed events. Used by Spec 030 scenario diff.",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      source: z.enum(["static", "trace"]),
      scenario_id: z.string().optional(),
      loader_entry_point_id: z.string().optional(),
      file_key: z.string().optional(),
      track: z.number().int().nonnegative().optional(),
      sector: z.number().int().nonnegative().optional(),
      destination_start: z.number().int().nonnegative().optional(),
      destination_end: z.number().int().nonnegative().optional(),
      caller_pc: z.number().int().nonnegative().optional(),
      container_sub_key: z.string().optional(),
      side_index: z.number().int().nonnegative().optional(),
      success: z.boolean().optional(),
      notes: z.string().optional(),
    },
    safeHandler("record_loader_event", async ({ project_dir, id, source, scenario_id, loader_entry_point_id, file_key, track, sector, destination_start, destination_end, caller_pc, container_sub_key, side_index, success, notes }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const event = service.recordLoaderEvent({
        id,
        source,
        scenarioId: scenario_id,
        loaderEntryPointId: loader_entry_point_id,
        fileKey: file_key,
        trackSector: (track !== undefined && sector !== undefined) ? { track, sector } : undefined,
        destinationStart: destination_start,
        destinationEnd: destination_end,
        callerPc: caller_pc,
        containerSubKey: container_sub_key,
        sideIndex: side_index,
        success: success ?? true,
        notes,
      });
      return textContent(`Loader event recorded.\nID: ${event.id}\nSource: ${event.source}${event.fileKey ? `\nFile key: ${event.fileKey}` : ""}${event.destinationStart !== undefined ? `\nDestination: $${event.destinationStart.toString(16).toUpperCase()}` : ""}`);
    },
));

  server.tool(
    "list_loader_events",
    "Spec 028: list recorded loader events. Filter by scenario_id or loader_entry_point_id.",
    {
      project_dir: z.string().optional(),
      scenario_id: z.string().optional(),
      loader_entry_point_id: z.string().optional(),
    },
    safeHandler("list_loader_events", async ({ project_dir, scenario_id, loader_entry_point_id }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const items = service.listLoaderEvents({ scenarioId: scenario_id, loaderEntryPointId: loader_entry_point_id });
      if (items.length === 0) return textContent(`No loader events match the filter.`);
      const lines = [`Loader events: ${items.length}`];
      for (const e of items.slice(0, 50)) {
        lines.push(`  ${e.capturedAt} [${e.source}]${e.fileKey ? ` key=${e.fileKey}` : ""}${e.trackSector ? ` ts=${e.trackSector.track}/${e.trackSector.sector}` : ""}${e.destinationStart !== undefined ? ` dest=$${e.destinationStart.toString(16).toUpperCase()}` : ""}`);
      }
      if (items.length > 50) lines.push(`  ... ${items.length - 50} more`);
      return textContent(lines.join("\n"));
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
    "Persist a semantic finding — a claim, hypothesis, confirmation, or refutation — with your confidence. Use to record what something IS or DOES. Not for a concrete named entity (use save_entity) or an unresolved question (use save_open_question). Inputs: summary, evidence, tags, optional address_range. Returns: finding id. (address_range + tags=['routine'] makes it eligible for auto-archive matching.)",
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
      // Bug 25: explicit top-level address range (24-bit, pass-through to
      // AddressRangeSchema). Required for routine-coverage findings —
      // archivePhase1Noise filters on top-level addressRange + tags.
      // No fallback from evidence[].addressRange: caller must opt in.
      address_range: z.object({
        start: z.number().int().min(0).max(0xffffff),
        end: z.number().int().min(0).max(0xffffff),
      }).optional(),
    },
    safeHandler("save_finding", async ({ project_dir, id, kind, title, summary, confidence, status, entity_ids, artifact_ids, relation_ids, flow_ids, tags, evidence, address_range }) => {
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
        addressRange: address_range,
        evidence: evidence?.map((item) => ({
          ...item,
          capturedAt: item.capturedAt ?? new Date().toISOString(),
        })),
      });
      const lines = [
        `Finding saved.`,
        `ID: ${finding.id}`,
        `Kind: ${finding.kind}`,
        `Title: ${finding.title}`,
        `Status: ${finding.status}`,
        `Confidence: ${finding.confidence}`,
      ];
      // Spec 752 L1 — surface the ungrounded marker as a visible warning at the
      // point of action (the steering "teeth").
      if ((finding.tags ?? []).includes("ungrounded")) {
        lines.push(
          ``,
          `⚠ UNGROUNDED (L1): this file/payload finding cites no backing extract artifact.`,
          `   Extract the source payload (extract_disk / extract_crt auto-runs disasm+analyse),`,
          `   then re-save with artifact_ids=[<_analysis.json / _disasm.asm id>] or evidence citing`,
          `   the extract. A trace runId+cycle or a heuristic is NOT grounding.`,
        );
      }
      // Spec 057 R26: closed-loop sweep when this finding is a routine
      // claim with an address range. Scope to the first artifact link
      // when present; else project-wide.
      const hasRoutineTag = (finding.tags ?? []).some((t) => t === "routine" || t === "annotation");
      if (hasRoutineTag && finding.addressRange) {
        const { runAndFormatClosedLoopSweep } = await import("../server-tools/closed-loop-sweep.js");
        const scopeArtifactId = finding.artifactIds[0];
        lines.push(runAndFormatClosedLoopSweep(service, { artifactId: scopeArtifactId }));
      }
      return textContent(lines.join("\n"));
    },
));

  server.tool(
    "list_findings",
    "List saved findings (claims, hypotheses, confirmations, refutations), with optional filters. Use to review what's been concluded. Not for entities (use list_entities) or unresolved questions (use list_open_questions). Inputs: optional filters. Returns: finding records.",
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
    "List saved entities (routines, memory regions, banks, disk files, state vars), with optional filters. Use to see what structural things are known. Not for findings (use list_findings) or files/artifacts (use list_artifacts). Inputs: optional filters. Returns: entity records.",
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
    "List saved open questions / ambiguities, with optional filters. Use to see what's still unresolved. Not for confirmed findings (use list_findings). By default hides heuristic analyze_prg validation prompts (set include_heuristic=true to see them). Inputs: optional filters. Returns: question records + a count of hidden heuristic questions.",
    {
      project_dir: z.string().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      entity_id: z.string().optional(),
      finding_id: z.string().optional(),
      include_heuristic: z.boolean().optional().describe("Include auto-generated heuristic validation prompts (default false — they are hidden behind a count)."),
      limit: z.number().int().positive().max(200).optional(),
    },
    safeHandler("list_open_questions", async ({ project_dir, status, priority, entity_id, finding_id, include_heuristic, limit }) => {
      const service = new ProjectKnowledgeService(resolveWorkspaceRoot(options, project_dir));
      const questions = service.listOpenQuestions({
        status, priority, entityId: entity_id, findingId: finding_id,
        excludeHeuristic: !include_heuristic,
      }).slice(0, limit ?? 50);
      // Spec 748.2 — when hiding heuristic noise, report how many were hidden so
      // the surface is honest about what it dropped.
      let hiddenNote = "";
      if (!include_heuristic) {
        const hidden = service.listOpenQuestions({ status }).length
          - service.listOpenQuestions({ status, excludeHeuristic: true }).length;
        if (hidden > 0) hiddenNote = `\n\n(${hidden} heuristic validation question(s) hidden — pass include_heuristic=true to see them, or triage via auto_resolve_questions.)`;
      }
      if (questions.length === 0) {
        return textContent(`No open questions matched the filters.${hiddenNote}`);
      }
      return textContent(questions.map((question) =>
        `${question.id} | ${question.status} | ${question.priority} | c=${question.confidence.toFixed(2)} | ${question.title}`,
      ).join("\n") + hiddenNote);
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
    "List saved flow / sequence models (load chains, control flows), with optional filters. Use to review documented sequences. Not for entities (use list_entities). Inputs: optional filters. Returns: flow records.",
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
    "Persist an open question / ambiguity to resolve later. Use when you spot something unexplained. Not for a settled conclusion (use save_finding). Inputs: question text, optional source provenance (default human-review). Returns: question id.",
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
      source: z.enum(["heuristic-phase1", "human-review", "runtime-observation", "static-analysis", "other", "untagged"]).optional().describe("Spec 036 provenance. Default human-review when called manually."),
      auto_resolvable: z.boolean().optional().describe("Spec 036: if true, the next disasm pass / phase advance should answer this."),
      auto_resolve_hint: z.string().optional().describe("Free-form note describing when this question becomes resolvable."),
      answered_by_finding_id: z.string().optional(),
      answer_summary: z.string().optional(),
      evidence: z.array(evidenceSchema).optional(),
      // Spec 748.2 (BUG-032): top-level address range so the reconcile teeth
      // (agent_propose_next) can match a question to an overlapping finding.
      address_range: z.object({
        start: z.number().int().min(0).max(0xffffff),
        end: z.number().int().min(0).max(0xffffff),
      }).optional(),
    },
    safeHandler("save_open_question", async ({ project_dir, id, kind, title, description, status, priority, confidence, entity_ids, artifact_ids, finding_ids, source, auto_resolvable, auto_resolve_hint, answered_by_finding_id, answer_summary, evidence, address_range }) => {
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
        source: source ?? "human-review",
        autoResolvable: auto_resolvable,
        autoResolveHint: auto_resolve_hint,
        answeredByFindingId: answered_by_finding_id,
        answerSummary: answer_summary,
        addressRange: address_range,
        evidence: evidence?.map((item) => ({
          ...item,
          capturedAt: item.capturedAt ?? new Date().toISOString(),
        })),
      });
      return textContent(`Open question saved.\nID: ${question.id}\nTitle: ${question.title}\nStatus: ${question.status}\nSource: ${question.source}`);
    },
));

  server.tool(
    "save_entity",
    "Persist a structured entity — a named routine, memory region, bank, disk file, or state variable. Use to record a concrete thing you've identified. Not for a claim/hypothesis (use save_finding), an unresolved question (use save_open_question), or a loadable byte-blob/payload (use register_payload — kind=payload here makes a thin record with no load address / format / source .prg, so it will NOT show on the disk view or memory map). Inputs: kind, name, address/scope, fields. Returns: entity id.",
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
    "Create a typed relation between two saved entities (e.g. calls, contains, derives-from). Use to connect known entities into a graph. Not for linking a payload to its ASM (use link_payload_to_asm) or creating the entity (use save_entity). Inputs: from id, to id, relation type. Returns: relation record.",
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
    "Rebuild + persist the JSON dashboard view-model (project status overview) for the UI. Use to refresh just the dashboard. Not for all views (use build_all_views) or markdown (use render_docs). Inputs: none. Returns: dashboard view path.",
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
    "Rebuild + persist the JSON memory-map view-model (address-space layout) for the UI. Use to refresh just the memory map. Not for all views (use build_all_views). Inputs: none. Returns: memory-map view path.",
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
    "Rebuild + persist the JSON annotated-listing view-model (disasm + annotations) for the UI. Use to refresh just the listing view. Not for all views (use build_all_views) or markdown (use render_docs). Inputs: none. Returns: listing view path.",
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
    "Rebuild + persist ALL project JSON view-models in one pass (dashboard, memory map, listing, …) for the UI. Use after knowledge changes to refresh every view at once. Not for human-readable markdown (use render_docs) or a single view (use the specific build_* tool). Inputs: none. Returns: rebuilt view list.",
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
        `Medium layout: ${result.mediumLayout.path}`,
        `Load sequence: ${result.loadSequence.path}`,
        `Flow graph: ${result.flowGraph.path}`,
        `Annotated listing: ${result.annotatedListing.path}`,
      ].join("\n"));
    },
));
}
