import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { importAnalysisKnowledge, stampImportedKnowledgeWithPayload } from "./analysis-import.js";
import { importManifestKnowledge } from "./manifest-import.js";
import { buildAnnotatedListingView, buildCartridgeLayoutView, buildDiskLayoutView, buildFlowGraphView, buildLoadSequenceView, buildMediumLayoutView, buildMemoryMapView, buildProjectDashboardView } from "./view-builders.js";
import { ProjectKnowledgeStorage, defaultProjectSlug } from "./storage.js";
import type {
  AnnotatedListingView,
  AntiPattern,
  ArtifactKind,
  ArtifactRecord,
  ArtifactScope,
  ConstraintRule,
  ContainerEntry,
  EntityRecord,
  LoadContext,
  LoaderEntryPoint,
  LoaderEvent,
  Operation,
  PatchRecipe,
  ProjectProfile,
  ResourceRegion,
  RuntimeScenario,
  RuntimeEvent,
  RuntimeEventSummary,
  RuntimeDiff,
  BuildPipeline,
  BuildRun,
  BuildStep,
  BuildRunStepResult,
  EvidenceRef,
  FindingKind,
  FindingRecord,
  FlowRecord,
  OpenQuestionRecord,
  ProjectCheckpoint,
  ProjectMetadata,
  PreferredAssembler,
  WorkflowPhase,
  WorkflowPlan,
  WorkflowPhaseState,
  WorkflowState,
  QuestionStatus,
  RelationKind,
  RelationRecord,
  TaskRecord,
  TaskStatus,
  TimelineEvent,
  ToolRunRecord,
  WorkspaceUiSnapshot,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function sha256OfFile(absPath: string): string | undefined {
  if (!existsSync(absPath)) return undefined;
  try {
    const data = readFileSync(absPath);
    return createHash("sha256").update(data).digest("hex");
  } catch {
    return undefined;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function createId(prefix: string, title: string): string {
  // Append both ms timestamp and a 4-char random suffix so two ids
  // generated in the same millisecond do not collide. Pre-existing
  // bug surfaced when recordRuntimeEventSummary auto-generated runIds
  // for two consecutive calls in the same tick.
  const stamp = Date.now().toString(36);
  const random = Math.floor(Math.random() * 0x10000).toString(36).padStart(4, "0");
  return `${prefix}-${slugify(title)}-${stamp}${random}`;
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter(Boolean))].sort();
}

function defaultWorkflowPhases(): WorkflowPhase[] {
  return [
    {
      id: "workspace-init",
      title: "Workspace Init",
      domain: "knowledge",
      description: "Create the project workspace, workflow contract, and baseline knowledge files so later steps write into a durable structure.",
      goals: [
        "Ensure the project folder structure exists.",
        "Create project metadata and the phase/workflow contract.",
        "Persist project-wide tooling preferences such as the preferred assembler dialect.",
        "Make the next valid phases explicit for a fresh LLM session.",
      ],
      prerequisitePhaseIds: [],
      requiredArtifactRoles: [],
      recommendedToolGroups: ["knowledge", "artifacts"],
      outputExpectations: [],
      guidance: [
        "Run project_init before any project-centric reverse-engineering step.",
        "Treat the phase-plan and workflow-state files as the contract for follow-on work.",
      ],
    },
    {
      id: "input-registration",
      title: "Input Registration",
      domain: "media",
      description: "Register source media and raw targets so all later steps refer to tracked artifacts instead of ad-hoc paths.",
      goals: [
        "Persist source inputs as artifacts.",
        "Record whether the project starts from PRG, disk, cartridge, or raw data.",
      ],
      prerequisitePhaseIds: ["workspace-init"],
      requiredArtifactRoles: [],
      recommendedToolGroups: ["artifacts", "media"],
      outputExpectations: [
        { id: "input-analysis-target", title: "Analysis target", description: "A PRG or raw binary prepared for deterministic analysis.", role: "analysis-target", optional: true },
        { id: "input-disk-image", title: "Disk image", description: "Tracked disk image artifact.", role: "disk-image", optional: true },
        { id: "input-cartridge-image", title: "Cartridge image", description: "Tracked cartridge image artifact.", role: "cartridge-image", optional: true },
      ],
      guidance: [
        "Every follow-on step should consume tracked artifacts, not only filesystem paths.",
      ],
    },
    {
      id: "deterministic-extraction",
      title: "Deterministic Extraction",
      domain: "analysis",
      description: "Run deterministic analyzers and extractors that generate reproducible manifests, disassemblies, and reports.",
      goals: [
        "Produce machine-generated manifests and analysis JSON.",
        "Generate baseline source, RAM, and pointer reports.",
        "Prefer the project-selected assembler dialect when multiple deterministic source outputs are possible.",
      ],
      prerequisitePhaseIds: ["input-registration"],
      requiredArtifactRoles: [],
      recommendedToolGroups: ["media", "analysis", "assembly"],
      outputExpectations: [
        { id: "out-analysis-json", title: "Analysis JSON", role: "analysis-json", optional: true },
        { id: "out-disk-manifest", title: "Disk manifest", role: "disk-manifest", optional: true },
        { id: "out-crt-manifest", title: "CRT manifest", role: "crt-manifest", optional: true },
        { id: "out-kickassembler-source", title: "KickAssembler source", role: "kickassembler-source", optional: true },
        { id: "out-64tass-source", title: "64tass source", role: "64tass-source", optional: true },
        { id: "out-ram-report", title: "RAM report", role: "ram-report", optional: true },
        { id: "out-pointer-report", title: "Pointer report", role: "pointer-report", optional: true },
      ],
      guidance: [
        "This phase should not require semantic interpretation.",
        "Manifests and analysis JSON become the stable contract for later enrichment.",
        "Use the project's preferred assembler to decide which source form to generate or present first when both KickAss and 64tass are available.",
      ],
    },
    {
      id: "structural-enrichment",
      title: "Structural Enrichment",
      domain: "knowledge",
      description: "Lift deterministic outputs into entities, relations, medium placement, and reusable structural flows.",
      goals: [
        "Persist entities and relations with addresses and medium spans.",
        "Model resident regions, file/chunk placement, and structural flows.",
        "Establish initial relationships between files, payloads, banks, and resident regions.",
      ],
      prerequisitePhaseIds: ["deterministic-extraction"],
      requiredArtifactRoles: ["analysis-json"],
      recommendedToolGroups: ["knowledge", "media"],
      outputExpectations: [],
      guidance: [
        "Prefer explicit medium placement metadata over UI-side inference.",
        "Use mediumSpans and mediumRole to pin knowledge back to disk/cartridge structure.",
        "Persist payload/file/bank relationships in metadata so later phases can explain how pieces fit together.",
      ],
    },
    {
      id: "semantic-enrichment",
      title: "Semantic Enrichment",
      domain: "knowledge",
      description: "Capture findings, hypotheses, confirmations, tasks, and open questions that explain meaning rather than only structure.",
      goals: [
        "Store semantic findings in structured form.",
        "Track open questions and follow-up work as first-class records.",
        "Explain what routines, handlers, tables, and payloads do and why they exist.",
      ],
      prerequisitePhaseIds: ["structural-enrichment"],
      requiredArtifactRoles: [],
      recommendedToolGroups: ["knowledge", "prompts"],
      outputExpectations: [
        { id: "semantic-annotations", title: "Semantic annotations", role: "semantic-annotations", optional: true },
      ],
      guidance: [
        "Do not hide hypotheses in markdown only; persist them as findings and open questions.",
        "This is the main explanation step: turn structure into intent, responsibility, and scenario-level understanding.",
      ],
    },
    {
      id: "semantic-feedback-refinement",
      title: "Semantic Feedback Refinement",
      domain: "knowledge",
      description: "Use the first semantic pass to improve heuristic structure, reslice ambiguous regions, and strengthen payload relationships across files, banks, and runtime stages.",
      goals: [
        "Upgrade generic detections such as lo/hi tables into meaningful semantic tables.",
        "Split, merge, or reinterpret segments when semantic evidence shows the first cut was too coarse.",
        "Trigger targeted static re-analysis/disassembly for specific ranges when clarification is needed.",
        "Persist stronger relationships between files, payloads, loader stages, banks, and resident code/data.",
      ],
      prerequisitePhaseIds: ["semantic-enrichment"],
      requiredArtifactRoles: [],
      recommendedToolGroups: ["analysis", "knowledge", "media"],
      outputExpectations: [
        { id: "refined-analysis-json", title: "Refined analysis JSON", role: "refined-analysis-json", optional: true },
        { id: "payload-link-map", title: "Payload relationship map", role: "payload-link-map", optional: true },
      ],
      guidance: [
        "Do not treat the first heuristic segmentation as final.",
        "Use semantic evidence to rename tables, refine segments, and request targeted static passes where useful.",
        "Persist payload/file relationships via metadata and relations so the UI does not need project-specific heuristics.",
      ],
    },
    {
      id: "runtime-capture",
      title: "Runtime Capture",
      domain: "runtime",
      description: "Collect raw runtime sessions, monitor traces, hotspots, and snapshots from VICE or headless runs.",
      goals: [
        "Persist runtime trace artifacts.",
        "Capture reproducible execution sessions for later aggregation.",
      ],
      prerequisitePhaseIds: ["semantic-feedback-refinement"],
      requiredArtifactRoles: [],
      recommendedToolGroups: ["vice", "headless"],
      outputExpectations: [
        { id: "runtime-summary", title: "Runtime trace summary", role: "runtime-trace-summary", optional: true },
        { id: "runtime-analysis", title: "Runtime trace analysis", role: "runtime-trace-analysis", optional: true },
        { id: "runtime-index", title: "Runtime trace index", role: "runtime-trace-index", optional: true },
      ],
      guidance: [
        "Treat raw runtime traces as source artifacts, not as direct UI inputs.",
      ],
    },
    {
      id: "runtime-aggregation",
      title: "Runtime Aggregation",
      domain: "runtime",
      description: "Summarize raw runtime sessions into compact artifacts such as phases, scenarios, memory activity, and other reusable runtime facts.",
      goals: [
        "Aggregate multi-gigabyte traces into compact structured summaries.",
        "Produce artifacts that the UI and later LLM sessions can consume cheaply.",
      ],
      prerequisitePhaseIds: ["runtime-capture"],
      requiredArtifactRoles: ["runtime-trace-summary"],
      recommendedToolGroups: ["vice", "knowledge"],
      outputExpectations: [
        { id: "runtime-summary-compact", title: "Runtime summary", role: "runtime-summary", optional: true },
        { id: "runtime-phases", title: "Runtime phases", role: "runtime-phases", optional: true },
        { id: "runtime-scenarios", title: "Runtime scenarios", role: "runtime-scenarios", optional: true },
        { id: "memory-activity", title: "Memory activity", role: "memory-activity", optional: true },
      ],
      guidance: [
        "Do not parse huge runtime traces on every UI snapshot build.",
        "Runtime views should depend on aggregated artifacts, not only on raw trace JSONL.",
      ],
    },
    {
      id: "view-build",
      title: "View Build",
      domain: "views",
      description: "Render stable JSON view-models from persisted knowledge and aggregated runtime artifacts.",
      goals: [
        "Generate reusable JSON views for the UI.",
        "Keep the frontend as a renderer over stable backend facts.",
      ],
      prerequisitePhaseIds: ["structural-enrichment"],
      requiredArtifactRoles: [],
      recommendedToolGroups: ["knowledge"],
      outputExpectations: [
        { id: "view-memory-map", title: "Memory map view", kind: "view-model", optional: true },
        { id: "view-disk-layout", title: "Disk layout view", kind: "view-model", optional: true },
        { id: "view-cartridge-layout", title: "Cartridge layout view", kind: "view-model", optional: true },
        { id: "view-flow-graph", title: "Flow graph view", kind: "view-model", optional: true },
      ],
      guidance: [
        "The UI should consume these views and infer as little as possible itself.",
      ],
    },
  ];
}

function defaultWorkflowPlan(input?: InitializeWorkflowContractInput): WorkflowPlan {
  return {
    schemaVersion: 1,
    updatedAt: nowIso(),
    version: "v1",
    title: "C64 Reverse-Engineering Project Workflow",
    summary: "Phase-based contract for deterministic extraction, knowledge enrichment, runtime aggregation, and view building.",
    canonicalDocPaths: uniqueStrings(input?.canonicalDocPaths),
    canonicalPromptIds: uniqueStrings(input?.canonicalPromptIds),
    phases: defaultWorkflowPhases(),
  };
}

function upsertRecord<T extends { id: string; updatedAt: string }>(items: T[], nextItem: T): T[] {
  const remaining = items.filter((item) => item.id !== nextItem.id);
  return [...remaining, nextItem].sort((left, right) => left.id.localeCompare(right.id));
}

export interface InitProjectInput {
  name: string;
  description?: string;
  tags?: string[];
  preferredAssembler?: PreferredAssembler;
}

export interface InitializeWorkflowContractInput {
  canonicalDocPaths?: string[];
  canonicalPromptIds?: string[];
  overwrite?: boolean;
}

export interface SaveArtifactInput {
  id?: string;
  kind: ArtifactKind;
  scope: ArtifactScope;
  title: string;
  path: string;
  description?: string;
  mimeType?: string;
  format?: string;
  role?: string;
  producedByTool?: string;
  sourceArtifactIds?: string[];
  entityIds?: string[];
  evidence?: EvidenceRef[];
  status?: ArtifactRecord["status"];
  confidence?: number;
  tags?: string[];
  // Spec 025 lineage fields. derivedFrom names the direct parent
  // artifact id; lineageRoot and versionRank are auto-computed when
  // not supplied. versionLabel defaults to "V<rank>" but the caller
  // can supply any free-form string and rename it later via
  // rename_artifact_version.
  derivedFrom?: string;
  versionLabel?: string;
  // Disable snapshotting on same-path overwrite. Default true. Set
  // false for ephemeral one-shot saves or when the caller is
  // certain the file content has not changed.
  enableSnapshot?: boolean;
  // Spec 020: per-artifact platform marker. Default c64 when absent.
  platform?: ArtifactRecord["platform"];
}

export interface SnapshotResult {
  artifactId: string;
  contentHash: string;
  snapshotPath: string;
  bytes: number;
}

export interface SaveEntityInput {
  id?: string;
  kind: EntityRecord["kind"];
  name: string;
  summary?: string;
  status?: "proposed" | "active" | "confirmed" | "rejected" | "archived";
  confidence?: number;
  evidence?: EvidenceRef[];
  artifactIds?: string[];
  relatedEntityIds?: string[];
  addressRange?: { start: number; end: number; bank?: number; label?: string };
  mediumSpans?: EntityRecord["mediumSpans"];
  mediumRole?: EntityRecord["mediumRole"];
  payloadId?: string;
  payloadLoadAddress?: number;
  payloadFormat?: EntityRecord["payloadFormat"];
  payloadPacker?: string;
  payloadSourceArtifactId?: string;
  payloadDepackedArtifactId?: string;
  payloadAsmArtifactIds?: string[];
  payloadContentHash?: string;
  tags?: string[];
}

export interface SaveFindingInput {
  id?: string;
  kind: FindingKind;
  title: string;
  summary?: string;
  status?: FindingRecord["status"];
  confidence?: number;
  evidence?: EvidenceRef[];
  entityIds?: string[];
  artifactIds?: string[];
  relationIds?: string[];
  flowIds?: string[];
  payloadId?: string;
  tags?: string[];
  // Spec 053 Bug 20.
  addressRange?: { start: number; end: number; bank?: number; label?: string };
  archivedBy?: string;
}

export interface LinkEntitiesInput {
  id?: string;
  kind: RelationKind;
  title: string;
  sourceEntityId: string;
  targetEntityId: string;
  summary?: string;
  status?: RelationRecord["status"];
  confidence?: number;
  evidence?: EvidenceRef[];
  artifactIds?: string[];
}

export interface SaveFlowInput {
  id?: string;
  kind: string;
  title: string;
  summary?: string;
  status?: FlowRecord["status"];
  confidence?: number;
  evidence?: EvidenceRef[];
  entityIds?: string[];
  artifactIds?: string[];
  nodes?: FlowRecord["nodes"];
  edges?: FlowRecord["edges"];
}

export interface SaveTaskInput {
  id?: string;
  kind: string;
  title: string;
  description?: string;
  status?: TaskRecord["status"];
  priority?: TaskRecord["priority"];
  confidence?: number;
  evidence?: EvidenceRef[];
  entityIds?: string[];
  artifactIds?: string[];
  questionIds?: string[];
  // Spec 038: NEXT-hint auto-suggested task metadata.
  producedByTool?: string;
  autoSuggested?: boolean;
  autoCloseHint?: TaskRecord["autoCloseHint"];
}

export interface SaveOpenQuestionInput {
  id?: string;
  kind: string;
  title: string;
  description?: string;
  status?: QuestionStatus;
  priority?: OpenQuestionRecord["priority"];
  confidence?: number;
  evidence?: EvidenceRef[];
  entityIds?: string[];
  artifactIds?: string[];
  findingIds?: string[];
  // Spec 036: provenance tagging.
  source?: OpenQuestionRecord["source"];
  autoResolvable?: boolean;
  autoResolveHint?: string;
  answeredByFindingId?: string;
  answerSummary?: string;
}

export interface CreateCheckpointInput {
  id?: string;
  title: string;
  summary?: string;
  evidence?: EvidenceRef[];
  artifactIds?: string[];
  entityIds?: string[];
  findingIds?: string[];
  flowIds?: string[];
  taskIds?: string[];
  questionIds?: string[];
}

export interface AppendTimelineEventInput {
  id?: string;
  kind: TimelineEvent["kind"];
  title: string;
  summary?: string;
  artifactId?: string;
  entityId?: string;
  findingId?: string;
  relationId?: string;
  flowId?: string;
  taskId?: string;
  questionId?: string;
  checkpointId?: string;
  payload?: TimelineEvent["payload"];
}

export interface RegisterToolRunInput {
  id?: string;
  toolName: string;
  title: string;
  status?: ToolRunRecord["status"];
  startedAt?: string;
  completedAt?: string;
  inputArtifactIds?: string[];
  outputArtifactIds?: string[];
  parameters?: ToolRunRecord["parameters"];
  notes?: string[];
}

export interface ProjectStatusSummary {
  project: ProjectMetadata;
  counts: {
    artifacts: number;
    entities: number;
    findings: number;
    relations: number;
    flows: number;
    tasks: number;
    openQuestions: number;
    checkpoints: number;
  };
  workflowPlan: WorkflowPlan;
  workflowState: WorkflowState;
  paths: ReturnType<ProjectKnowledgeStorage["ensureProjectStructure"]>;
  recentTimeline: TimelineEvent[];
}

export interface AnalysisImportResult {
  artifact: ArtifactRecord;
  importedEntityCount: number;
  importedFindingCount: number;
  importedRelationCount: number;
  importedFlowCount: number;
  importedOpenQuestionCount: number;
}

export interface ManifestImportResult {
  artifact: ArtifactRecord;
  importedEntityCount: number;
  importedFindingCount: number;
  importedRelationCount: number;
}

export interface BuildAllViewsResult {
  projectDashboard: { path: string; view: ReturnType<typeof buildProjectDashboardView> };
  memoryMap: { path: string; view: ReturnType<typeof buildMemoryMapView> };
  diskLayout: { path: string; view: ReturnType<typeof buildDiskLayoutView> };
  cartridgeLayout: { path: string; view: ReturnType<typeof buildCartridgeLayoutView> };
  loadSequence: { path: string; view: ReturnType<typeof buildLoadSequenceView> };
  flowGraph: { path: string; view: ReturnType<typeof buildFlowGraphView> };
  annotatedListing: { path: string; view: AnnotatedListingView };
}

export class ProjectKnowledgeService {
  readonly storage: ProjectKnowledgeStorage;

  constructor(projectRoot: string) {
    this.storage = new ProjectKnowledgeStorage(resolve(projectRoot));
    this.storage.ensureProjectStructure();
  }

  getProjectRoot(): string {
    return this.storage.paths.root;
  }

  initProject(input: InitProjectInput): ProjectMetadata {
    this.storage.ensureProjectStructure();
    const existing = this.storage.loadProject();
    const createdAt = existing?.createdAt ?? nowIso();
    const updatedAt = nowIso();
    const project: ProjectMetadata = {
      schemaVersion: 1,
      id: existing?.id ?? createId("project", input.name),
      name: input.name,
      slug: existing?.slug ?? defaultProjectSlug(input.name),
      description: input.description ?? existing?.description,
      rootPath: this.storage.paths.root,
      status: existing?.status ?? "active",
      preferredAssembler: input.preferredAssembler ?? existing?.preferredAssembler,
      tags: uniqueStrings(input.tags ?? existing?.tags),
      createdAt,
      updatedAt,
    };
    this.storage.saveProject(project);
    this.appendTimelineEvent({
      kind: "project.initialized",
      title: "Project initialized",
      summary: `${project.name} initialized at ${project.rootPath}`,
      payload: {
        projectId: project.id,
        projectName: project.name,
        ...(project.preferredAssembler ? { preferredAssembler: project.preferredAssembler } : {}),
      },
    });
    this.initializeWorkflowContract();
    return project;
  }

  initializeWorkflowContract(input?: InitializeWorkflowContractInput): { plan: WorkflowPlan; state: WorkflowState } {
    const existingPlan = this.storage.loadWorkflowPlan();
    const shouldOverwrite = input?.overwrite === true || existingPlan.phases.length === 0;
    const plan = shouldOverwrite
      ? this.storage.saveWorkflowPlan(defaultWorkflowPlan(input))
      : this.storage.saveWorkflowPlan({
          ...existingPlan,
          updatedAt: nowIso(),
          canonicalDocPaths: uniqueStrings([
            ...existingPlan.canonicalDocPaths,
            ...(input?.canonicalDocPaths ?? []),
          ]),
          canonicalPromptIds: uniqueStrings([
            ...existingPlan.canonicalPromptIds,
            ...(input?.canonicalPromptIds ?? []),
          ]),
        });
    const state = this.syncWorkflowState(plan);
    return { plan, state };
  }

  getWorkflowContract(): { plan: WorkflowPlan; state: WorkflowState } {
    const plan = this.storage.loadWorkflowPlan();
    const state = this.syncWorkflowState(plan);
    return { plan, state };
  }

  getProjectStatus(): ProjectStatusSummary {
    const project = this.requireProject();
    const workflowPlan = this.storage.loadWorkflowPlan();
    const workflowState = this.syncWorkflowState(workflowPlan);
    return {
      project,
      counts: {
        artifacts: this.storage.loadArtifacts().items.length,
        entities: this.storage.loadEntities().items.length,
        findings: this.storage.loadFindings().items.length,
        relations: this.storage.loadRelations().items.length,
        flows: this.storage.loadFlows().items.length,
        tasks: this.storage.loadTasks().items.length,
        openQuestions: this.storage.loadOpenQuestions().items.length,
        checkpoints: this.storage.listCheckpoints().length,
      },
      workflowPlan,
      workflowState,
      paths: this.storage.paths,
      recentTimeline: this.storage.readTimeline(10).sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    };
  }

  saveArtifact(input: SaveArtifactInput): ArtifactRecord {
    const store = this.storage.loadArtifacts();
    const timestamp = nowIso();
    const absPath = resolve(this.storage.paths.root, input.path);
    // Dedup: if the caller didn't supply an id, look up by absolute path so
    // two different titles for the same file do not produce two artifacts.
    // (Bug 10 in BUGREPORT.md.)
    const existing = input.id
      ? store.items.find((item) => item.id === input.id)
      : store.items.find((item) => item.path === absPath);
    const artifactId = input.id ?? existing?.id ?? createId("artifact", input.title);
    // Lineage: walk parent chain to compute lineageRoot and versionRank.
    const derivedFrom = input.derivedFrom ?? existing?.derivedFrom;
    let lineageRoot = artifactId;
    let versionRank = 0;
    if (derivedFrom) {
      const parent = store.items.find((item) => item.id === derivedFrom);
      if (parent) {
        lineageRoot = parent.lineageRoot ?? parent.id;
        versionRank = (parent.versionRank ?? 0) + 1;
      }
    } else if (existing) {
      lineageRoot = existing.lineageRoot ?? existing.id;
      versionRank = existing.versionRank ?? 0;
    }
    const versionLabel = input.versionLabel ?? existing?.versionLabel ?? `V${versionRank}`;
    // Same-path content hashing + snapshot bookkeeping. Hash the file as
    // it sits on disk now. If the hash differs from the prior contentHash
    // and the prior bytes were preserved via snapshotArtifactBeforeOverwrite,
    // we will already have an entry in versions[] for the prior hash. If
    // the prior bytes were lost (caller did not snapshot before overwriting),
    // we record the transition in versions[] without a snapshotPath so the
    // history is still visible, even if the bytes are gone.
    const newHash = sha256OfFile(absPath);
    let versions: ArtifactRecord["versions"] = existing?.versions ?? [];
    const enableSnapshot = input.enableSnapshot ?? true;
    if (existing && existing.contentHash && newHash && existing.contentHash !== newHash) {
      const priorHash = existing.contentHash;
      const alreadyRecorded = versions.some((v) => v.contentHash === priorHash);
      if (!alreadyRecorded) {
        versions = [
          ...versions,
          {
            contentHash: priorHash,
            capturedAt: timestamp,
            snapshotPath: undefined,
            note: enableSnapshot
              ? "prior bytes not snapshotted (caller did not invoke snapshotArtifactBeforeOverwrite)"
              : "snapshot disabled by caller",
          },
        ];
      }
    }
    const artifact = this.storage.buildArtifactRecord({
      id: artifactId,
      kind: input.kind,
      scope: input.scope,
      title: input.title,
      path: absPath,
      description: input.description,
      mimeType: input.mimeType,
      format: input.format,
      role: input.role,
      producedByTool: input.producedByTool,
      sourceArtifactIds: uniqueStrings(input.sourceArtifactIds ?? existing?.sourceArtifactIds),
      entityIds: uniqueStrings(input.entityIds ?? existing?.entityIds),
      evidence: input.evidence ?? existing?.evidence ?? [],
      status: input.status ?? existing?.status ?? "active",
      confidence: input.confidence ?? existing?.confidence ?? 1,
      tags: uniqueStrings(input.tags ?? existing?.tags),
      contentHash: newHash ?? existing?.contentHash,
      derivedFrom,
      lineageRoot,
      versionLabel,
      versionRank,
      versions,
      platform: input.platform ?? existing?.platform,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    this.storage.saveArtifacts({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, artifact),
    });
    this.appendTimelineEvent({
      kind: "artifact.registered",
      title: `Artifact saved: ${artifact.title}`,
      artifactId: artifact.id,
      summary: artifact.relativePath,
      payload: {
        artifactKind: artifact.kind,
        scope: artifact.scope,
      },
    });
    return artifact;
  }

  // Spec 025: call before overwriting an artifact's on-disk file so the
  // prior bytes are preserved under <root>/snapshots/<id>/<hash>.bin and
  // appended to artifact.versions[]. The next saveArtifact call will
  // see the new hash on disk and skip duplicating the version entry.
  snapshotArtifactBeforeOverwrite(artifactId: string): SnapshotResult | undefined {
    const store = this.storage.loadArtifacts();
    const artifact = store.items.find((item) => item.id === artifactId);
    if (!artifact) return undefined;
    if (!existsSync(artifact.path)) return undefined;
    const hash = sha256OfFile(artifact.path);
    if (!hash) return undefined;
    const snapshotDir = resolve(this.storage.paths.snapshotsRoot, artifactId);
    if (!existsSync(snapshotDir)) {
      mkdirSync(snapshotDir, { recursive: true });
    }
    const snapshotPath = resolve(snapshotDir, `${hash}.bin`);
    if (!existsSync(snapshotPath)) {
      writeFileSync(snapshotPath, readFileSync(artifact.path));
    }
    const alreadyRecorded = (artifact.versions ?? []).some((v) => v.contentHash === hash);
    const versions = alreadyRecorded
      ? artifact.versions
      : [
          ...(artifact.versions ?? []),
          { contentHash: hash, capturedAt: nowIso(), snapshotPath },
        ];
    const updated: ArtifactRecord = {
      ...artifact,
      versions,
      contentHash: artifact.contentHash ?? hash,
      updatedAt: nowIso(),
    };
    this.storage.saveArtifacts({
      ...store,
      updatedAt: nowIso(),
      items: store.items.map((item) => (item.id === artifactId ? updated : item)),
    });
    const bytes = statSync(snapshotPath).size;
    return { artifactId, contentHash: hash, snapshotPath, bytes };
  }

  // Spec 025: walk the lineage chain root-down for a given artifact id.
  // Returns artifacts ordered by versionRank ascending. Includes the
  // queried artifact at the end of the chain (or earlier if it has
  // descendants). If the artifact has no lineage info, returns [artifact].
  getLineage(artifactId: string): ArtifactRecord[] {
    const store = this.storage.loadArtifacts();
    const artifact = store.items.find((item) => item.id === artifactId);
    if (!artifact) return [];
    const root = artifact.lineageRoot ?? artifact.id;
    const chain = store.items.filter((item) => (item.lineageRoot ?? item.id) === root);
    return chain.sort((a, b) => (a.versionRank ?? 0) - (b.versionRank ?? 0));
  }

  // Spec 025: rename a version label without touching bytes or hash.
  renameArtifactVersion(artifactId: string, versionLabel: string): ArtifactRecord | undefined {
    const store = this.storage.loadArtifacts();
    const artifact = store.items.find((item) => item.id === artifactId);
    if (!artifact) return undefined;
    const updated: ArtifactRecord = { ...artifact, versionLabel, updatedAt: nowIso() };
    this.storage.saveArtifacts({
      ...store,
      updatedAt: nowIso(),
      items: store.items.map((item) => (item.id === artifactId ? updated : item)),
    });
    return updated;
  }

  // Spec 025 R23: container sub-entry support. A disk file may be a
  // container with named subentries that are not separate BAM/LUT files.
  saveContainerEntry(input: {
    id?: string;
    parentArtifactId: string;
    childArtifactId?: string;
    subKey: string;
    containerOffset: number;
    containerLength: number;
    loadAddress?: number;
    registrationMode?: ContainerEntry["registrationMode"];
    status?: ContainerEntry["status"];
    inheritedFrom?: string;
    evidence?: EvidenceRef[];
    tags?: string[];
  }): ContainerEntry {
    const store = this.storage.loadContainerEntries();
    const timestamp = nowIso();
    const id = input.id ?? createId("container", `${input.parentArtifactId}-${input.subKey}`);
    const existing = store.items.find((item) => item.id === id)
      ?? store.items.find((item) => item.parentArtifactId === input.parentArtifactId && item.subKey === input.subKey);
    const entry: ContainerEntry = {
      id: existing?.id ?? id,
      parentArtifactId: input.parentArtifactId,
      childArtifactId: input.childArtifactId ?? existing?.childArtifactId,
      subKey: input.subKey,
      containerOffset: input.containerOffset,
      containerLength: input.containerLength,
      loadAddress: input.loadAddress ?? existing?.loadAddress,
      registrationMode: input.registrationMode ?? existing?.registrationMode,
      status: input.status ?? existing?.status ?? "physically-present",
      inheritedFrom: input.inheritedFrom ?? existing?.inheritedFrom,
      evidence: input.evidence ?? existing?.evidence ?? [],
      tags: uniqueStrings(input.tags ?? existing?.tags),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveContainerEntries({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, entry),
    });
    return entry;
  }

  listContainerEntries(parentArtifactId?: string): ContainerEntry[] {
    const store = this.storage.loadContainerEntries();
    const items = store.items.slice().sort((a, b) => a.containerOffset - b.containerOffset);
    if (!parentArtifactId) return items;
    return items.filter((item) => item.parentArtifactId === parentArtifactId);
  }

  // Spec 022: per-artifact status checklist. Returns one row per
  // PRG / payload artifact with the six steps: analyze, disasm pass 1,
  // annotations, disasm pass 2, rebuild byte-identical, linked finding.
  // Each step carries requiredForRole so the UI / agent filters by the
  // active role (analyst vs cracker per Spec 033).
  getPerArtifactStatus(): Array<{
    artifactId: string;
    title: string;
    kind: string;
    platform?: string;
    relativePath: string;
    steps: Array<{
      name: string;
      status: "done" | "pending" | "blocked";
      reason?: string;
      requiredForRole: Array<"analyst" | "cracker">;
    }>;
    completionPctAnalyst: number;
    completionPctCracker: number;
  }> {
    const artifacts = this.listArtifacts();
    const findings = this.listFindings();
    const subjectKinds = new Set(["prg", "raw", "extract", "listing"]);
    const subjects = artifacts.filter((a) => subjectKinds.has(a.kind) || a.role === "source-prg");
    const findingsByArtifact = new Map<string, number>();
    for (const f of findings) {
      for (const aid of f.artifactIds) {
        findingsByArtifact.set(aid, (findingsByArtifact.get(aid) ?? 0) + 1);
      }
    }
    const listingsBySubject = new Map<string, ArtifactRecord>();
    for (const a of artifacts) {
      if (a.kind !== "listing") continue;
      for (const sid of a.sourceArtifactIds ?? []) listingsBySubject.set(sid, a);
    }
    const analysisRunsBySubject = new Map<string, ArtifactRecord>();
    for (const a of artifacts) {
      if (a.kind !== "analysis-run") continue;
      for (const sid of a.sourceArtifactIds ?? []) analysisRunsBySubject.set(sid, a);
    }
    return subjects.map((subject) => {
      const analysisRun = analysisRunsBySubject.get(subject.id);
      const listing = listingsBySubject.get(subject.id);
      const annotationsPath = subject.relativePath.replace(/\.[^./]+$/, "_annotations.json");
      const annotationsExist = existsSync(resolve(this.storage.paths.root, annotationsPath));
      const rebuildOk = listing
        ? this.checkListingRebuildVerified(listing)
        : false;
      const linkedFindings = findingsByArtifact.get(subject.id) ?? 0;
      const steps = [
        { name: "analyze", status: analysisRun ? "done" as const : "pending" as const, requiredForRole: ["analyst", "cracker"] as Array<"analyst" | "cracker"> },
        { name: "disasm-pass-1", status: listing ? "done" as const : "pending" as const, requiredForRole: ["analyst", "cracker"] as Array<"analyst" | "cracker"> },
        { name: "annotations", status: annotationsExist ? "done" as const : "pending" as const, requiredForRole: ["analyst"] as Array<"analyst" | "cracker"> },
        { name: "disasm-pass-2", status: annotationsExist && listing ? "done" as const : "pending" as const, requiredForRole: ["analyst"] as Array<"analyst" | "cracker"> },
        { name: "rebuild-byte-identical", status: rebuildOk ? "done" as const : "pending" as const, requiredForRole: ["analyst", "cracker"] as Array<"analyst" | "cracker"> },
        { name: "linked-finding", status: linkedFindings > 0 ? "done" as const : "pending" as const, requiredForRole: ["analyst"] as Array<"analyst" | "cracker"> },
      ];
      const analystSteps = steps.filter((s) => s.requiredForRole.includes("analyst"));
      const crackerSteps = steps.filter((s) => s.requiredForRole.includes("cracker"));
      const analystDone = analystSteps.filter((s) => s.status === "done").length;
      const crackerDone = crackerSteps.filter((s) => s.status === "done").length;
      return {
        artifactId: subject.id,
        title: subject.title,
        kind: subject.kind,
        platform: subject.platform,
        phase: subject.phase,
        phaseFrozen: subject.phaseFrozen,
        relativePath: subject.relativePath,
        steps,
        completionPctAnalyst: analystSteps.length === 0 ? 0 : Math.round((analystDone / analystSteps.length) * 100),
        completionPctCracker: crackerSteps.length === 0 ? 0 : Math.round((crackerDone / crackerSteps.length) * 100),
      };
    });
  }

  private checkListingRebuildVerified(listing: ArtifactRecord): boolean {
    try {
      const text = readFileSync(listing.path, "utf8");
      // disasm_prg writes a header line containing either
      // "// rebuild verified byte-identical" or
      // "// WARNING: rebuild diverges". We only count the verified one.
      return text.includes("rebuild verified byte-identical");
    } catch {
      return false;
    }
  }

  // Spec 023: register a runtime / after-decompression load context on
  // an artifact. Idempotent on (artifactId, kind, address).
  registerLoadContext(artifactId: string, ctx: LoadContext): ArtifactRecord | undefined {
    const store = this.storage.loadArtifacts();
    const artifact = store.items.find((item) => item.id === artifactId);
    if (!artifact) return undefined;
    const existing = (artifact.loadContexts ?? []).find((c) =>
      c.kind === ctx.kind && c.address === ctx.address && (c.bank ?? null) === (ctx.bank ?? null),
    );
    let updatedContexts: LoadContext[];
    if (existing) {
      updatedContexts = (artifact.loadContexts ?? []).map((c) => (c === existing ? { ...existing, ...ctx } : c));
    } else {
      updatedContexts = [...(artifact.loadContexts ?? []), ctx];
    }
    const updated: ArtifactRecord = { ...artifact, loadContexts: updatedContexts, updatedAt: nowIso() };
    this.storage.saveArtifacts({
      ...store,
      updatedAt: nowIso(),
      items: store.items.map((item) => (item.id === artifactId ? updated : item)),
    });
    return updated;
  }

  // Spec 028: declare a loader entry point on an artifact.
  declareLoaderEntryPoint(input: Omit<LoaderEntryPoint, "id" | "createdAt" | "updatedAt"> & { id?: string }): LoaderEntryPoint {
    const store = this.storage.loadLoaderEntryPoints();
    const timestamp = nowIso();
    const id = input.id ?? createId("loader-ep", `${input.artifactId}-${input.address.toString(16)}`);
    const existing = store.items.find((item) => item.id === id)
      ?? store.items.find((item) => item.artifactId === input.artifactId && item.address === input.address && item.kind === input.kind);
    const entry: LoaderEntryPoint = {
      ...input,
      id: existing?.id ?? id,
      tags: input.tags ?? existing?.tags ?? [],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveLoaderEntryPoints({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, entry),
    });
    return entry;
  }

  listLoaderEntryPoints(artifactId?: string): LoaderEntryPoint[] {
    const store = this.storage.loadLoaderEntryPoints();
    const items = store.items.slice().sort((a, b) => a.address - b.address);
    return artifactId ? items.filter((item) => item.artifactId === artifactId) : items;
  }

  // Spec 028: persist one observed loader call (static or trace).
  recordLoaderEvent(input: Omit<LoaderEvent, "id" | "capturedAt"> & { id?: string; capturedAt?: string }): LoaderEvent {
    const store = this.storage.loadLoaderEvents();
    const timestamp = input.capturedAt ?? nowIso();
    const id = input.id ?? createId("loader-event", `${input.source}-${input.fileKey ?? input.callerPc?.toString(16) ?? Math.random().toString(36).slice(2)}`);
    const event: LoaderEvent = {
      ...input,
      id,
      capturedAt: timestamp,
    };
    const items = store.items.some((item) => item.id === event.id)
      ? store.items.map((item) => (item.id === event.id ? event : item))
      : [...store.items, event];
    this.storage.saveLoaderEvents({
      ...store,
      updatedAt: nowIso(),
      items,
    });
    return event;
  }

  listLoaderEvents(filter?: { scenarioId?: string; loaderEntryPointId?: string }): LoaderEvent[] {
    const store = this.storage.loadLoaderEvents();
    let items = store.items.slice().sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    if (filter?.scenarioId) items = items.filter((item) => item.scenarioId === filter.scenarioId);
    if (filter?.loaderEntryPointId) items = items.filter((item) => item.loaderEntryPointId === filter.loaderEntryPointId);
    return items;
  }

  // Spec 026 project profile.
  getProjectProfile(): ProjectProfile | undefined {
    return this.storage.loadProjectProfile();
  }

  saveProjectProfile(patch: Partial<Omit<ProjectProfile, "updatedAt">>): ProjectProfile {
    const existing = this.storage.loadProjectProfile() ?? {
      goals: [], nonGoals: [], hardwareConstraints: [], destructiveOperations: [],
      dangerZones: [], glossary: [], antiPatterns: [], crackerOverrides: [],
      updatedAt: nowIso(),
    };
    const merged: ProjectProfile = {
      goals: patch.goals ?? existing.goals,
      nonGoals: patch.nonGoals ?? existing.nonGoals,
      hardwareConstraints: patch.hardwareConstraints ?? existing.hardwareConstraints,
      loaderModel: patch.loaderModel ?? existing.loaderModel,
      destructiveOperations: patch.destructiveOperations ?? existing.destructiveOperations,
      build: patch.build ?? existing.build,
      test: patch.test ?? existing.test,
      activeWorkspace: patch.activeWorkspace ?? existing.activeWorkspace,
      dangerZones: patch.dangerZones ?? existing.dangerZones,
      glossary: patch.glossary ?? existing.glossary,
      antiPatterns: patch.antiPatterns ?? existing.antiPatterns,
      crackerOverrides: patch.crackerOverrides ?? existing.crackerOverrides,
      // Spec 034 + 035 + 046: phase gates, reminders, role default,
      // workflow.
      phaseGateStrict: patch.phaseGateStrict ?? existing.phaseGateStrict,
      phaseReminders: patch.phaseReminders ?? existing.phaseReminders,
      defaultRole: patch.defaultRole ?? existing.defaultRole,
      workflow: patch.workflow ?? existing.workflow,
      workflowSelectedAt: patch.workflowSelectedAt ?? existing.workflowSelectedAt,
      updatedAt: nowIso(),
    };
    return this.storage.saveProjectProfile(merged);
  }

  // Spec 031 anti-patterns.
  saveAntiPattern(input: Omit<AntiPattern, "id" | "createdAt" | "updatedAt"> & { id?: string }): AntiPattern {
    const store = this.storage.loadAntiPatterns();
    const timestamp = nowIso();
    const id = input.id ?? createId("antipattern", input.title);
    const existing = store.items.find((item) => item.id === id);
    const entry: AntiPattern = {
      ...input,
      id,
      tags: input.tags ?? existing?.tags ?? [],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveAntiPatterns({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, entry),
    });
    return entry;
  }

  listAntiPatterns(): AntiPattern[] {
    return this.storage.loadAntiPatterns().items.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // Spec 027 patches.
  savePatchRecipe(input: Omit<PatchRecipe, "id" | "createdAt" | "updatedAt" | "status"> & { id?: string; status?: PatchRecipe["status"] }): PatchRecipe {
    const store = this.storage.loadPatches();
    const timestamp = nowIso();
    const id = input.id ?? createId("patch", input.title);
    const existing = store.items.find((item) => item.id === id);
    const recipe: PatchRecipe = {
      ...input,
      id,
      status: input.status ?? existing?.status ?? "draft",
      tags: input.tags ?? existing?.tags ?? [],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.savePatches({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, recipe),
    });
    return recipe;
  }

  listPatchRecipes(filter?: { status?: PatchRecipe["status"]; targetArtifactId?: string }): PatchRecipe[] {
    let items = this.storage.loadPatches().items.slice();
    if (filter?.status) items = items.filter((p) => p.status === filter.status);
    if (filter?.targetArtifactId) items = items.filter((p) => p.targetArtifactId === filter.targetArtifactId);
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  applyPatchRecipe(recipeId: string, opts?: { allowMismatch?: boolean }): { ok: boolean; reason?: string; appliedHash?: string } {
    const store = this.storage.loadPatches();
    const recipe = store.items.find((item) => item.id === recipeId);
    if (!recipe) return { ok: false, reason: "recipe not found" };
    const artifact = this.listArtifacts().find((a) => a.id === recipe.targetArtifactId);
    if (!artifact) return { ok: false, reason: "target artifact not found" };
    if (!existsSync(artifact.path)) return { ok: false, reason: "target file missing on disk" };
    const offset = recipe.targetFileOffset ?? 0;
    const expected = Buffer.from(recipe.expectedBytes.replace(/\s+/g, ""), "hex");
    const replacement = recipe.replacementBytes
      ? Buffer.from(recipe.replacementBytes.replace(/\s+/g, ""), "hex")
      : recipe.replacementSourcePath
        ? readFileSync(resolve(this.storage.paths.root, recipe.replacementSourcePath))
        : undefined;
    if (!replacement) return { ok: false, reason: "no replacement bytes or source" };
    const data = readFileSync(artifact.path);
    const slice = data.subarray(offset, offset + expected.length);
    if (!slice.equals(expected) && !opts?.allowMismatch) {
      return { ok: false, reason: `expected bytes mismatch at offset ${offset}; saw ${slice.toString("hex")}, expected ${expected.toString("hex")}` };
    }
    // Snapshot prior bytes via Spec 025
    this.snapshotArtifactBeforeOverwrite(artifact.id);
    const out = Buffer.from(data);
    replacement.copy(out, offset);
    writeFileSync(artifact.path, out);
    const appliedHash = sha256OfFile(artifact.path) ?? "";
    const updatedRecipe: PatchRecipe = {
      ...recipe,
      status: "applied",
      appliedAt: nowIso(),
      appliedHash,
      updatedAt: nowIso(),
    };
    this.storage.savePatches({
      ...store,
      updatedAt: nowIso(),
      items: store.items.map((item) => (item.id === recipeId ? updatedRecipe : item)),
    });
    // Re-record artifact so versions[] picks up the new hash
    this.saveArtifact({
      id: artifact.id,
      kind: artifact.kind,
      scope: artifact.scope,
      title: artifact.title,
      path: artifact.path,
      role: artifact.role,
    });
    return { ok: true, appliedHash };
  }

  // Spec 029 constraints.
  registerResourceRegion(input: Omit<ResourceRegion, "id" | "createdAt" | "updatedAt"> & { id?: string }): ResourceRegion {
    const store = this.storage.loadResources();
    const timestamp = nowIso();
    const id = input.id ?? createId("region", input.name);
    const existing = store.items.find((item) => item.id === id);
    const region: ResourceRegion = {
      ...input,
      id,
      tags: input.tags ?? existing?.tags ?? [],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveResources({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, region),
    });
    return region;
  }

  listResources(): ResourceRegion[] {
    return this.storage.loadResources().items.slice();
  }

  registerOperation(input: Omit<Operation, "id" | "createdAt" | "updatedAt"> & { id?: string }): Operation {
    const store = this.storage.loadOperations();
    const timestamp = nowIso();
    const id = input.id ?? createId("operation", input.kind);
    const existing = store.items.find((item) => item.id === id);
    const op: Operation = {
      ...input,
      id,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveOperations({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, op),
    });
    return op;
  }

  listOperations(): Operation[] {
    return this.storage.loadOperations().items.slice();
  }

  registerConstraintRule(input: Omit<ConstraintRule, "id" | "createdAt" | "updatedAt"> & { id?: string }): ConstraintRule {
    const store = this.storage.loadConstraints();
    const timestamp = nowIso();
    const id = input.id ?? createId("rule", input.title);
    const existing = store.items.find((item) => item.id === id);
    const rule: ConstraintRule = {
      ...input,
      id,
      tags: input.tags ?? existing?.tags ?? [],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveConstraints({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, rule),
    });
    return rule;
  }

  listConstraintRules(): ConstraintRule[] {
    return this.storage.loadConstraints().items.slice();
  }

  // Spec 029 v1 verifier: returns rule violations based on simple
  // built-in predicates. Built-in: any operation whose `affects[]`
  // overlaps a region with attribute `protected: true` triggers an
  // error. Custom rules render as informational text only in v1.
  verifyConstraints(): Array<{ ruleId: string; severity: "info" | "warn" | "error"; message: string; affectedIds: string[] }> {
    const violations: Array<{ ruleId: string; severity: "info" | "warn" | "error"; message: string; affectedIds: string[] }> = [];
    const regions = this.listResources();
    const operations = this.listOperations();
    const protectedRegions = regions.filter((r) => r.attributes && r.attributes["protected"] === true);
    for (const op of operations) {
      const conflicts = op.affects.filter((aid) => protectedRegions.some((r) => r.id === aid));
      if (conflicts.length > 0) {
        violations.push({
          ruleId: "builtin.protected-region",
          severity: "error",
          message: `Operation ${op.id} (${op.kind}) affects ${conflicts.length} protected region(s): ${conflicts.join(", ")}`,
          affectedIds: [op.id, ...conflicts],
        });
      }
    }
    // Each user-declared rule is rendered as an info entry so the audit
    // surface them; v1 does not evaluate the rule body.
    for (const rule of this.listConstraintRules()) {
      violations.push({
        ruleId: rule.id,
        severity: rule.severity,
        message: `Declared rule: ${rule.title} — ${rule.rule}`,
        affectedIds: [],
      });
    }
    return violations;
  }

  // Spec 031 doc render. Writes Markdown summaries for findings,
  // entities, open questions, anti-patterns, and the project profile.
  // In-band by default; bulk operations should pass deferRender to skip.
  renderDocs(scope: "all" | "findings" | "entities" | "open-questions" | "anti-patterns" | "project-profile" = "all"): { written: string[] } {
    const written: string[] = [];
    const docsDir = resolve(this.storage.paths.root, "docs");
    if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });
    const header = "<!-- generated by c64re render_docs; do not edit by hand -->\n\n";
    if (scope === "all" || scope === "findings") {
      const items = this.listFindings();
      const lines = ["# Findings", "", `${items.length} findings.`, ""];
      for (const f of items) lines.push(`- **${f.title}** (${f.kind}, ${f.status}, conf ${f.confidence}) — ${f.summary ?? "(no summary)"}`);
      const path = resolve(docsDir, "FINDINGS.md");
      writeFileSync(path, header + lines.join("\n") + "\n");
      written.push(path);
    }
    if (scope === "all" || scope === "entities") {
      const items = this.listEntities();
      const lines = ["# Entities", "", `${items.length} entities.`, ""];
      for (const e of items) lines.push(`- **${e.name}** (${e.kind}) — ${e.summary ?? "(no summary)"}`);
      const path = resolve(docsDir, "ENTITIES.md");
      writeFileSync(path, header + lines.join("\n") + "\n");
      written.push(path);
    }
    if (scope === "all" || scope === "open-questions") {
      const items = this.listOpenQuestions();
      const lines = ["# Open Questions", "", `${items.length} questions.`, ""];
      for (const q of items) lines.push(`- **${q.title}** (${q.kind}, ${q.priority}, ${q.status}) — ${q.description ?? "(no description)"}`);
      const path = resolve(docsDir, "OPEN_QUESTIONS.md");
      writeFileSync(path, header + lines.join("\n") + "\n");
      written.push(path);
    }
    if (scope === "all" || scope === "anti-patterns") {
      const items = this.listAntiPatterns();
      const lines = ["# Anti-Patterns", "", `${items.length} anti-pattern(s).`, ""];
      for (const a of items) lines.push(`- **${a.title}** (${a.severity}) — ${a.reason}`);
      const path = resolve(docsDir, "ANTI_PATTERNS.md");
      writeFileSync(path, header + lines.join("\n") + "\n");
      written.push(path);
    }
    if (scope === "all" || scope === "project-profile") {
      const profile = this.getProjectProfile();
      const lines = ["# Project Profile", ""];
      if (!profile) {
        lines.push("(profile not yet scaffolded)");
      } else {
        lines.push(`## Goals`);
        for (const g of profile.goals) lines.push(`- ${g}`);
        lines.push("");
        lines.push(`## Non-Goals`);
        for (const g of profile.nonGoals) lines.push(`- ${g}`);
        lines.push("");
        lines.push(`## Hardware Constraints`);
        for (const c of profile.hardwareConstraints) lines.push(`- **${c.resource}**: ${c.constraint}${c.reason ? ` (${c.reason})` : ""}`);
        lines.push("");
        lines.push(`## Destructive Operations`);
        for (const d of profile.destructiveOperations) lines.push(`- \`${d.commandPattern}\` — ${d.warning}`);
        lines.push("");
        if (profile.build) lines.push(`## Build\n\n\`${profile.build.command}\`${profile.build.cwd ? ` (cwd: ${profile.build.cwd})` : ""}\n`);
        if (profile.test) lines.push(`## Test\n\n\`${profile.test.command}\`${profile.test.cwd ? ` (cwd: ${profile.test.cwd})` : ""}\n`);
        if (profile.activeWorkspace) lines.push(`## Active Workspace\n\n${profile.activeWorkspace}\n`);
      }
      const path = resolve(docsDir, "..", "PROJECT_PROFILE.md");
      writeFileSync(path, header + lines.join("\n") + "\n");
      written.push(path);
    }
    return { written };
  }

  // Spec 032 build pipelines.
  saveBuildPipeline(input: Omit<BuildPipeline, "id" | "createdAt" | "updatedAt"> & { id?: string }): BuildPipeline {
    const store = this.storage.loadBuildPipelines();
    const timestamp = nowIso();
    const id = input.id ?? createId("pipeline", input.title);
    const existing = store.items.find((item) => item.id === id);
    const pipeline: BuildPipeline = {
      ...input,
      id,
      tags: input.tags ?? existing?.tags ?? [],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveBuildPipelines({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, pipeline),
    });
    return pipeline;
  }

  listBuildPipelines(): BuildPipeline[] {
    return this.storage.loadBuildPipelines().items.slice();
  }

  // Spec 032: dry-run / orchestration of a pipeline. v1 records the
  // run shell-by-shell; the actual command execution stays the
  // caller's responsibility (no shell sandbox in v1).
  startBuildRun(pipelineId: string, mode: "dry-run" | "record" = "dry-run"): BuildRun {
    const pipeline = this.listBuildPipelines().find((p) => p.id === pipelineId);
    if (!pipeline) throw new Error(`pipeline ${pipelineId} not found`);
    const run: BuildRun = {
      id: createId("build-run", pipelineId),
      pipelineId,
      startedAt: nowIso(),
      steps: pipeline.steps.map((step) => ({ stepId: step.id, status: mode === "dry-run" ? "skipped" : "pending" })),
      status: "running",
    };
    const store = this.storage.loadBuildRuns();
    this.storage.saveBuildRuns({
      ...store,
      updatedAt: nowIso(),
      items: [...store.items, run],
    });
    return run;
  }

  recordBuildStepResult(runId: string, result: BuildRunStepResult): BuildRun | undefined {
    const store = this.storage.loadBuildRuns();
    const run = store.items.find((item) => item.id === runId);
    if (!run) return undefined;
    const updatedSteps = run.steps.map((s) => (s.stepId === result.stepId ? result : s));
    const allOk = updatedSteps.every((s) => s.status === "ok");
    const anyFailed = updatedSteps.some((s) => s.status === "failed");
    const allTerminal = updatedSteps.every((s) => s.status === "ok" || s.status === "failed" || s.status === "skipped");
    const status: BuildRun["status"] = allOk ? "ok" : anyFailed && allTerminal ? "failed" : allTerminal ? "partial" : "running";
    const updated: BuildRun = { ...run, steps: updatedSteps, status, completedAt: allTerminal ? nowIso() : undefined };
    this.storage.saveBuildRuns({
      ...store,
      updatedAt: nowIso(),
      items: store.items.map((item) => (item.id === runId ? updated : item)),
    });
    return updated;
  }

  listBuildRuns(pipelineId?: string): BuildRun[] {
    const items = this.storage.loadBuildRuns().items.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return pipelineId ? items.filter((item) => item.pipelineId === pipelineId) : items;
  }

  // Spec 032: stale-output detection — compare current input
  // artifact contentHash to the most recent successful run's
  // recorded inputs.
  detectStaleOutputs(): Array<{ pipelineId: string; pipelineTitle: string; reason: string }> {
    const out: Array<{ pipelineId: string; pipelineTitle: string; reason: string }> = [];
    const pipelines = this.listBuildPipelines();
    const artifacts = this.listArtifacts();
    for (const pipeline of pipelines) {
      const runs = this.listBuildRuns(pipeline.id);
      const lastOk = runs.find((r) => r.status === "ok");
      if (!lastOk) {
        out.push({ pipelineId: pipeline.id, pipelineTitle: pipeline.title, reason: "no successful run yet" });
        continue;
      }
      for (const step of pipeline.steps) {
        const sourceHashes = step.inputArtifactIds.map((id) => artifacts.find((a) => a.id === id)?.contentHash).filter(Boolean) as string[];
        const observed = lastOk.steps.find((s) => s.stepId === step.id);
        if (observed?.actualOutputHashes && Object.keys(observed.actualOutputHashes).length > 0 && sourceHashes.length === 0) {
          out.push({ pipelineId: pipeline.id, pipelineTitle: pipeline.title, reason: `step ${step.id}: input artifacts have no contentHash for diff` });
        }
      }
    }
    return out;
  }

  // Spec 053 (Bug 20): walk hypothesis findings whose addressRange
  // is fully covered by a routine annotation. Mark them archived
  // with archivedBy pointing at the routine finding. Also walk
  // heuristic-phase1 questions in the same range and close them.
  // dryRun=true: returns counts without writing.
  archivePhase1Noise(opts: { dryRun?: boolean } = {}): { findingsArchived: number; questionsAnswered: number; routinesScanned: number; preview: Array<{ findingId: string; title: string; supersededBy: string }> } {
    const allFindings = this.listFindings();
    const routineFindings = allFindings.filter((f) =>
      (f.kind === "classification" || f.kind === "observation")
      && f.addressRange !== undefined
      && (f.tags ?? []).some((t) => t === "routine" || t === "annotation")
    );
    // Also accept any "routine"-tagged finding even without a kind match.
    const routinesWithRange = allFindings.filter((f) =>
      f.addressRange !== undefined
      && ((f.tags ?? []).includes("routine") || (f.tags ?? []).includes("annotation"))
    );
    const routines = routinesWithRange.length > 0 ? routinesWithRange : routineFindings;
    const hypothesisCandidates = allFindings.filter((f) =>
      f.kind === "hypothesis"
      && f.addressRange !== undefined
      && f.status !== "archived"
      && !f.archivedBy
    );
    const preview: Array<{ findingId: string; title: string; supersededBy: string }> = [];
    let archived = 0;
    for (const candidate of hypothesisCandidates) {
      const cr = candidate.addressRange;
      if (!cr) continue;
      const coverer = routines.find((r) => {
        const rr = r.addressRange;
        if (!rr) return false;
        return rr.start <= cr.start && rr.end >= cr.end;
      });
      if (!coverer) continue;
      preview.push({ findingId: candidate.id, title: candidate.title, supersededBy: coverer.id });
      if (!opts.dryRun) {
        this.saveFinding({
          id: candidate.id,
          kind: candidate.kind,
          title: candidate.title,
          status: "archived",
          archivedBy: coverer.id,
        });
        archived += 1;
      }
    }
    // Now sweep paired heuristic-phase1 questions
    let questionsAnswered = 0;
    if (!opts.dryRun) {
      const questions = this.listOpenQuestions();
      for (const q of questions) {
        if (q.source !== "heuristic-phase1") continue;
        if (q.status !== "open" && q.status !== "researching") continue;
        const titleAddr = q.title.match(/\$([0-9A-Fa-f]{4})/);
        if (!titleAddr) continue;
        const addr = parseInt(titleAddr[1], 16);
        const coverer = routines.find((r) => {
          const rr = r.addressRange;
          if (!rr) return false;
          return rr.start <= addr && rr.end >= addr;
        });
        if (!coverer) continue;
        this.saveOpenQuestion({
          id: q.id,
          kind: q.kind,
          title: q.title,
          status: "answered",
          answeredByFindingId: coverer.id,
          answerSummary: `Auto-archived: covered by routine annotation ${coverer.id}.`,
        });
        questionsAnswered += 1;
      }
    }
    return {
      findingsArchived: opts.dryRun ? preview.length : archived,
      questionsAnswered,
      routinesScanned: routines.length,
      preview,
    };
  }

  // Spec 053 (Bug 20): mark a sprite/charset/bitmap segment as
  // confirmed by a render evidence. Writes back into the matching
  // *_analysis.json segment AND creates a confirmation finding.
  // Auto-match attempts (artifactPath, address, length); if none
  // unique, returns undefined.
  markSegmentConfirmed(args: {
    artifactId: string;
    address: number;
    length: number;
    kind: string;
    evidenceArtifactId?: string;
  }): { findingId: string; analysisPath?: string; segmentMatched: boolean } | undefined {
    const artifact = this.listArtifacts().find((a) => a.id === args.artifactId);
    if (!artifact) return undefined;
    let analysisPath: string | undefined;
    let segmentMatched = false;
    // Find associated analysis-run artifact and try to mutate segment.
    const analysisArtifact = this.listArtifacts().find((a) =>
      a.kind === "analysis-run"
      && (a.sourceArtifactIds ?? []).includes(args.artifactId)
    );
    if (analysisArtifact && existsSync(analysisArtifact.path)) {
      try {
        const raw = JSON.parse(readFileSync(analysisArtifact.path, "utf8"));
        if (raw && typeof raw === "object" && Array.isArray((raw as { segments?: unknown[] }).segments)) {
          const segments = (raw as { segments: Array<{ start: number; end: number; kind: string; confirmed?: boolean; confirmedBy?: unknown }> }).segments;
          const match = segments.find((s) =>
            s.start === args.address
            && s.end === args.address + args.length - 1
            && s.kind === args.kind
          );
          if (match) {
            match.confirmed = true;
            match.confirmedBy = {
              kind: "render",
              artifactId: args.evidenceArtifactId,
              capturedAt: nowIso(),
            };
            writeFileSync(analysisArtifact.path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
            analysisPath = analysisArtifact.path;
            segmentMatched = true;
          }
        }
      } catch {
        // best effort; finding still recorded below
      }
    }
    const finding = this.saveFinding({
      kind: "confirmation",
      title: `Segment confirmed at $${args.address.toString(16).toUpperCase()}-$${(args.address + args.length - 1).toString(16).toUpperCase()} (${args.kind})`,
      summary: `Visual / structural confirmation${args.evidenceArtifactId ? ` via ${args.evidenceArtifactId}` : ""}.`,
      confidence: 0.95,
      status: "confirmed",
      artifactIds: [args.artifactId, ...(args.evidenceArtifactId ? [args.evidenceArtifactId] : [])],
      addressRange: { start: args.address, end: args.address + args.length - 1 },
      tags: ["segment-confirmation"],
    });
    return { findingId: finding.id, analysisPath, segmentMatched };
  }

  // Spec 052: walk open auto-resolvable questions whose entityIds
  // intersect the just-saved finding. High-confidence matches
  // auto-close; low-confidence become resolution-pending.
  // Returns count summary so callers can surface it.
  resolveQuestionsForFinding(findingId: string): { autoResolved: number; pending: number } {
    const allFindings = this.listFindings();
    const finding = allFindings.find((f) => f.id === findingId);
    if (!finding) return { autoResolved: 0, pending: 0 };
    const profile = this.getProjectProfile();
    const proposeOnly = profile?.questionAutoResolveMode === "propose-only";
    const findingEntityIds = new Set(finding.entityIds);
    const questions = this.listOpenQuestions();
    let autoResolved = 0;
    let pending = 0;
    for (const q of questions) {
      if (q.status !== "open" && q.status !== "researching" && q.status !== "resolution-pending") continue;
      if (q.autoResolvable !== true) continue;
      if (q.entityIds.length === 0) continue;
      const overlaps = q.entityIds.some((id) => findingEntityIds.has(id));
      if (!overlaps) continue;
      const highConfidence =
        !proposeOnly
        && finding.confidence >= 0.85
        && finding.entityIds.length === 1
        && q.entityIds.length === 1;
      if (highConfidence) {
        this.saveOpenQuestion({
          id: q.id,
          kind: q.kind,
          title: q.title,
          status: "answered",
          answeredByFindingId: finding.id,
          answerSummary: finding.summary,
        });
        autoResolved += 1;
      } else if (q.status !== "resolution-pending") {
        this.saveOpenQuestion({
          id: q.id,
          kind: q.kind,
          title: q.title,
          status: "resolution-pending",
          answeredByFindingId: finding.id,
          answerSummary: finding.summary ? `Proposed: ${finding.summary}` : `Proposed by finding ${finding.id}`,
        });
        pending += 1;
      }
    }
    return { autoResolved, pending };
  }

  // Spec 052: phase-reached resolution. Called from
  // advanceArtifactPhase. Closes any auto-resolvable question whose
  // structured hint is satisfied.
  resolveQuestionsForPhase(artifactId: string, reachedPhase: number): number {
    const questions = this.listOpenQuestions();
    let closed = 0;
    for (const q of questions) {
      if (q.status !== "open" && q.status !== "researching") continue;
      const hint = q.autoResolveHint;
      if (!hint || typeof hint === "string") continue;
      if (hint.kind !== "phase-reached") continue;
      if (hint.artifactId !== artifactId) continue;
      if (reachedPhase < hint.phase) continue;
      this.saveOpenQuestion({
        id: q.id,
        kind: q.kind,
        title: q.title,
        status: "answered",
        answerSummary: `Auto-resolved: artifact ${artifactId} reached phase ${reachedPhase} (>= required ${hint.phase}).`,
      });
      closed += 1;
    }
    return closed;
  }

  // Spec 052: annotation-applied resolution. Called from the
  // annotation-save endpoint (Spec 051) or as a catch-up sweep.
  resolveQuestionsForAnnotation(artifactId: string, addresses: number[]): number {
    const questions = this.listOpenQuestions();
    let closed = 0;
    for (const q of questions) {
      if (q.status !== "open" && q.status !== "researching") continue;
      const hint = q.autoResolveHint;
      if (!hint || typeof hint === "string") continue;
      if (hint.kind !== "annotation-applied") continue;
      if (hint.artifactId !== artifactId) continue;
      if (hint.address !== undefined && !addresses.includes(hint.address)) continue;
      this.saveOpenQuestion({
        id: q.id,
        kind: q.kind,
        title: q.title,
        status: "answered",
        answerSummary: `Auto-resolved: annotations applied for ${artifactId}${hint.address !== undefined ? ` covering $${hint.address.toString(16).toUpperCase()}` : ""}.`,
      });
      closed += 1;
    }
    return closed;
  }

  // Spec 052: read-only proposal — what would the resolver do?
  proposeQuestionResolutions(): Array<{ questionId: string; questionTitle: string; reason: string; via?: string; confidence?: number }> {
    const out: Array<{ questionId: string; questionTitle: string; reason: string; via?: string; confidence?: number }> = [];
    const questions = this.listOpenQuestions();
    const findings = this.listFindings();
    const artifacts = this.listArtifacts();
    for (const q of questions) {
      if (q.status !== "open" && q.status !== "researching") continue;
      if (q.autoResolvable !== true) continue;
      // Pfad A: any finding whose entityIds overlap?
      const candidate = findings.find((f) => f.entityIds.some((id) => q.entityIds.includes(id)));
      if (candidate) {
        out.push({
          questionId: q.id,
          questionTitle: q.title,
          reason: `Finding "${candidate.title}" references shared entity`,
          via: candidate.id,
          confidence: candidate.confidence,
        });
        continue;
      }
      // Pfad B: phase-reached hint already satisfied?
      const hint = q.autoResolveHint;
      if (hint && typeof hint !== "string" && hint.kind === "phase-reached") {
        const a = artifacts.find((art) => art.id === hint.artifactId);
        if (a && (a.phase ?? 1) >= hint.phase) {
          out.push({
            questionId: q.id,
            questionTitle: q.title,
            reason: `Artifact ${hint.artifactId} already at phase ${a.phase} (>= ${hint.phase})`,
            via: hint.artifactId,
          });
        }
      }
    }
    return out;
  }

  // Spec 052: resolution-pending → answered (accept) or back to
  // open with rejection note (accept=false).
  confirmQuestionResolution(questionId: string, accept: boolean): OpenQuestionRecord | undefined {
    const all = this.listOpenQuestions();
    const q = all.find((item) => item.id === questionId);
    if (!q) return undefined;
    if (q.status !== "resolution-pending") return q; // no-op
    return this.saveOpenQuestion({
      id: q.id,
      kind: q.kind,
      title: q.title,
      status: accept ? "answered" : "open",
      answerSummary: accept ? q.answerSummary : `Auto-resolution rejected by user.`,
    });
  }

  // Spec 052: catch-up sweep. Re-runs Pfad A + B + C across all
  // open auto-resolvable questions. Called from agent_onboard.
  sweepQuestionResolutions(): { autoResolved: number; pending: number; phaseClosed: number } {
    const findings = this.listFindings();
    let autoResolved = 0;
    let pending = 0;
    for (const f of findings) {
      const r = this.resolveQuestionsForFinding(f.id);
      autoResolved += r.autoResolved;
      pending += r.pending;
    }
    let phaseClosed = 0;
    for (const a of this.listArtifacts()) {
      if (a.phase !== undefined) {
        phaseClosed += this.resolveQuestionsForPhase(a.id, a.phase);
      }
    }
    return { autoResolved, pending, phaseClosed };
  }

  // Spec 032 follow-up: run a build pipeline end-to-end, executing
  // each step's command via child_process.spawnSync. Records per-step
  // exit code, stdout/stderr tails, actual output hashes, duration.
  // Returns the BuildRun. Stops at the first failed step unless
  // continueOnError is true.
  runBuildPipeline(pipelineId: string, opts: { continueOnError?: boolean } = {}): BuildRun {
    const pipeline = this.listBuildPipelines().find((p) => p.id === pipelineId);
    if (!pipeline) throw new Error(`pipeline ${pipelineId} not found`);
    const run = this.startBuildRun(pipelineId, "record");
    for (const step of pipeline.steps) {
      const startedAt = Date.now();
      const cwd = step.cwd ? resolve(this.storage.paths.root, step.cwd) : this.storage.paths.root;
      try {
        const result = spawnSync(step.command, { cwd, shell: true, encoding: "utf8" });
        const durationMs = Date.now() - startedAt;
        const stdoutTail = (result.stdout ?? "").slice(-2048);
        const stderrTail = (result.stderr ?? "").slice(-2048);
        const exitCode = result.status ?? -1;
        const actualOutputHashes: Record<string, string> = {};
        for (const outId of step.outputArtifactIds) {
          const out = this.listArtifacts().find((a) => a.id === outId);
          if (out && existsSync(out.path)) {
            const hash = sha256OfFile(out.path);
            if (hash) actualOutputHashes[outId] = hash;
          }
        }
        const status: "ok" | "failed" = exitCode === 0 ? "ok" : "failed";
        this.recordBuildStepResult(run.id, {
          stepId: step.id,
          status,
          exitCode,
          stdoutTail,
          stderrTail,
          actualOutputHashes,
          durationMs,
        });
        if (status === "failed" && !opts.continueOnError) break;
      } catch (error) {
        this.recordBuildStepResult(run.id, {
          stepId: step.id,
          status: "failed",
          stderrTail: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        });
        if (!opts.continueOnError) break;
      }
    }
    const updated = this.listBuildRuns(pipelineId).find((r) => r.id === run.id);
    return updated ?? run;
  }

  // Spec 030 runtime scenarios.
  saveRuntimeScenario(input: Omit<RuntimeScenario, "id" | "createdAt" | "updatedAt"> & { id?: string }): RuntimeScenario {
    const store = this.storage.loadRuntimeScenarios();
    const timestamp = nowIso();
    const id = input.id ?? createId("scenario", input.title);
    const existing = store.items.find((item) => item.id === id);
    const scenario: RuntimeScenario = {
      ...input,
      id,
      tags: input.tags ?? existing?.tags ?? [],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveRuntimeScenarios({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, scenario),
    });
    return scenario;
  }

  listRuntimeScenarios(): RuntimeScenario[] {
    return this.storage.loadRuntimeScenarios().items.slice();
  }

  recordRuntimeEventSummary(input: Omit<RuntimeEventSummary, "runId" | "capturedAt"> & { runId?: string; capturedAt?: string }): RuntimeEventSummary {
    const store = this.storage.loadRuntimeEvents();
    const runId = input.runId ?? createId("run", input.scenarioId);
    const summary: RuntimeEventSummary = {
      ...input,
      runId,
      capturedAt: input.capturedAt ?? nowIso(),
    };
    const items = store.items.some((item) => item.runId === runId)
      ? store.items.map((item) => (item.runId === runId ? summary : item))
      : [...store.items, summary];
    this.storage.saveRuntimeEvents({
      ...store,
      updatedAt: nowIso(),
      items,
    });
    return summary;
  }

  listRuntimeEventSummaries(scenarioId?: string): RuntimeEventSummary[] {
    const items = this.storage.loadRuntimeEvents().items.slice().sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    return scenarioId ? items.filter((item) => item.scenarioId === scenarioId) : items;
  }

  // Spec 030: diff two runs of the same scenario. baseline + candidate
  // run ids must exist; emits + persists a RuntimeDiff record.
  diffRuntimeRuns(baselineRunId: string, candidateRunId: string): RuntimeDiff | undefined {
    const events = this.storage.loadRuntimeEvents();
    const baseline = events.items.find((item) => item.runId === baselineRunId);
    const candidate = events.items.find((item) => item.runId === candidateRunId);
    if (!baseline || !candidate) return undefined;
    const keyOf = (e: RuntimeEvent): string => `${e.fileKey ?? "?"}|${e.trackSector?.track ?? ""}|${e.trackSector?.sector ?? ""}`;
    const baseMap = new Map<string, RuntimeEvent>();
    for (const e of baseline.events) baseMap.set(keyOf(e), e);
    const candMap = new Map<string, RuntimeEvent>();
    for (const e of candidate.events) candMap.set(keyOf(e), e);
    const missingLoads: RuntimeEvent[] = [];
    const extraLoads: RuntimeEvent[] = [];
    const diffDestination: RuntimeDiff["diffDestination"] = [];
    for (const [k, e] of baseMap.entries()) {
      const matchingCand = candMap.get(k);
      if (!matchingCand) {
        missingLoads.push(e);
      } else if (e.destinationStart !== undefined && matchingCand.destinationStart !== undefined && e.destinationStart !== matchingCand.destinationStart) {
        diffDestination.push({ key: k, baselineDest: e.destinationStart, candidateDest: matchingCand.destinationStart });
      }
    }
    for (const [k, e] of candMap.entries()) {
      if (!baseMap.has(k)) extraLoads.push(e);
    }
    const diffPayloadHash: RuntimeDiff["diffPayloadHash"] = [];
    for (const [k, baseHash] of Object.entries(baseline.hashes)) {
      const candHash = candidate.hashes[k];
      if (candHash !== undefined && candHash !== baseHash) {
        diffPayloadHash.push({ key: k, baselineHash: baseHash, candidateHash: candHash });
      }
    }
    const divergentPc: RuntimeDiff["divergentPc"] = [];
    const minLen = Math.min(baseline.events.length, candidate.events.length);
    for (let i = 0; i < minLen; i += 1) {
      const a = baseline.events[i];
      const b = candidate.events[i];
      if (a && b && a.pc !== b.pc) {
        divergentPc.push({ index: i, baselinePc: a.pc, candidatePc: b.pc });
        if (divergentPc.length >= 20) break;
      }
    }
    const diff: RuntimeDiff = {
      id: createId("diff", `${baselineRunId}-vs-${candidateRunId}`),
      baselineRunId,
      candidateRunId,
      scenarioId: baseline.scenarioId,
      capturedAt: nowIso(),
      missingLoads,
      extraLoads,
      diffPayloadHash,
      diffDestination,
      divergentPc,
    };
    const store = this.storage.loadRuntimeDiffs();
    const items = store.items.some((item) => item.id === diff.id)
      ? store.items.map((item) => (item.id === diff.id ? diff : item))
      : [...store.items, diff];
    this.storage.saveRuntimeDiffs({
      ...store,
      updatedAt: nowIso(),
      items,
    });
    return diff;
  }

  // Spec 037: set / clear payload-level disk hint.
  setPayloadDiskHint(payloadEntityId: string, hint?: "drive-code" | "protected" | "raw-unanalyzed" | "bad-crc" | "gap"): EntityRecord | undefined {
    const store = this.storage.loadEntities();
    const entity = store.items.find((item) => item.id === payloadEntityId);
    if (!entity) return undefined;
    const updated: EntityRecord = { ...entity, payloadDiskHint: hint, updatedAt: nowIso() };
    this.storage.saveEntities({
      ...store,
      updatedAt: nowIso(),
      items: store.items.map((item) => (item.id === payloadEntityId ? updated : item)),
    });
    return updated;
  }

  // Spec 041: set artifact relevance tag.
  setArtifactRelevance(artifactId: string, relevance?: "loader" | "protection" | "save" | "kernal" | "asset" | "other"): ArtifactRecord | undefined {
    const store = this.storage.loadArtifacts();
    const artifact = store.items.find((item) => item.id === artifactId);
    if (!artifact) return undefined;
    const updated: ArtifactRecord = { ...artifact, relevance, updatedAt: nowIso() };
    this.storage.saveArtifacts({
      ...store,
      updatedAt: nowIso(),
      items: store.items.map((item) => (item.id === artifactId ? updated : item)),
    });
    return updated;
  }

  // Spec 041: auto-classifier — proposes relevance tags from
  // heuristics. Only suggests; the caller writes the chosen tag via
  // setArtifactRelevance.
  proposeArtifactRelevance(): Array<{ artifactId: string; title: string; current?: string; proposed: ArtifactRecord["relevance"]; reason: string }> {
    const out: Array<{ artifactId: string; title: string; current?: string; proposed: ArtifactRecord["relevance"]; reason: string }> = [];
    const artifacts = this.listArtifacts();
    const loaderEntries = this.listLoaderEntryPoints();
    const antiPatterns = this.listAntiPatterns();
    for (const artifact of artifacts) {
      let proposed: ArtifactRecord["relevance"] | undefined;
      let reason = "";
      const title = artifact.title.toLowerCase();
      if (loaderEntries.some((e) => e.artifactId === artifact.id)) {
        proposed = "loader";
        reason = "has declared loader-entrypoint";
      } else if (/boot|loader|sys|fastload/.test(title)) {
        proposed = "loader";
        reason = "title matches loader pattern";
      } else if (antiPatterns.some((a) => a.appliesTo?.toolName === artifact.id || a.title.toLowerCase().includes(artifact.title.toLowerCase()))) {
        proposed = "protection";
        reason = "anti-pattern referenced";
      } else if (/protect|copy|prot/.test(title)) {
        proposed = "protection";
        reason = "title matches protection pattern";
      } else if (/save|store|hi.?score|scoreboard/.test(title)) {
        proposed = "save";
        reason = "title matches save pattern";
      } else if ((artifact.loadContexts ?? []).some((c) => c.kind === "runtime" && c.address >= 0xe000)) {
        proposed = "kernal";
        reason = "load context targets KERNAL replacement range";
      } else if (/sprite|charset|font|level|map|asset|graphic/.test(title)) {
        proposed = "asset";
        reason = "title matches asset pattern";
      }
      if (proposed) {
        out.push({ artifactId: artifact.id, title: artifact.title, current: artifact.relevance, proposed, reason });
      }
    }
    return out;
  }

  // Spec 040: per-artifact quality metrics computed from
  // *_analysis.json (segment kinds + confidence) and *_disasm.asm
  // (label naming ratio).
  computeQualityMetrics(analysisJsonPath: string, listingPath?: string): {
    bytesByKind: Record<string, number>;
    avgConfidence: number;
    largeUnknownCount: number;
    namedLabelRatio: number;
    qualityScore: number;
  } | undefined {
    if (!existsSync(analysisJsonPath)) return undefined;
    const profile = this.getProjectProfile();
    const largeUnknownThreshold = (profile as ProjectProfile & { qualityMetrics?: { largeUnknownThreshold?: number } } | undefined)?.qualityMetrics?.largeUnknownThreshold ?? 16;
    interface Seg { kind: string; start: number; end: number; score?: { confidence?: number } }
    let analysis: { segments?: Seg[] };
    try {
      analysis = JSON.parse(readFileSync(analysisJsonPath, "utf8")) as { segments?: Seg[] };
    } catch {
      return undefined;
    }
    const segments = analysis.segments ?? [];
    const bytesByKind: Record<string, number> = {};
    let confidenceSum = 0;
    let confidenceCount = 0;
    let largeUnknownCount = 0;
    for (const seg of segments) {
      const length = Math.max(0, (seg.end ?? 0) - (seg.start ?? 0) + 1);
      bytesByKind[seg.kind] = (bytesByKind[seg.kind] ?? 0) + length;
      const conf = seg.score?.confidence;
      if (typeof conf === "number") {
        confidenceSum += conf;
        confidenceCount += 1;
      }
      if (seg.kind === "unknown" && length > largeUnknownThreshold) {
        largeUnknownCount += 1;
      }
    }
    const avgConfidence = confidenceCount === 0 ? 0 : confidenceSum / confidenceCount;
    let namedLabelRatio = 1;
    if (listingPath && existsSync(listingPath)) {
      try {
        const text = readFileSync(listingPath, "utf8");
        const labelLines = text.split("\n").filter((line) => /^[A-Za-z_][A-Za-z0-9_]*:/.test(line));
        if (labelLines.length > 0) {
          const named = labelLines.filter((line) => !/^W[0-9A-F]{4}:/.test(line)).length;
          namedLabelRatio = named / labelLines.length;
        }
      } catch {
        // best effort
      }
    }
    const totalSegments = Math.max(1, segments.length);
    const qualityScore = avgConfidence * (1 - Math.min(1, (largeUnknownCount / totalSegments) * 5));
    return { bytesByKind, avgConfidence, largeUnknownCount, namedLabelRatio, qualityScore };
  }

  // Spec 034: advance an artifact to a target phase. Evidence string
  // is required when jumping more than one phase forward.
  advanceArtifactPhase(artifactId: string, toPhase: 1 | 2 | 3 | 4 | 5 | 6 | 7, evidence?: string): ArtifactRecord | undefined {
    const store = this.storage.loadArtifacts();
    const artifact = store.items.find((item) => item.id === artifactId);
    if (!artifact) return undefined;
    const current = artifact.phase ?? 1;
    if (toPhase < current) {
      throw new Error(`Cannot move artifact backward from phase ${current} to phase ${toPhase}.`);
    }
    if (toPhase - current > 1 && !evidence) {
      throw new Error(`Skipping more than one phase forward (${current} -> ${toPhase}) requires an evidence string.`);
    }
    const updated: ArtifactRecord = { ...artifact, phase: toPhase, updatedAt: nowIso() };
    this.storage.saveArtifacts({
      ...store,
      updatedAt: nowIso(),
      items: store.items.map((item) => (item.id === artifactId ? updated : item)),
    });
    this.appendTimelineEvent({
      kind: "artifact.phase-advanced",
      title: `Phase advanced: ${artifact.title} -> ${toPhase}`,
      artifactId,
      summary: evidence,
      payload: { from: current, to: toPhase },
    });
    // Spec 052: phase-reached question resolution.
    try {
      this.resolveQuestionsForPhase(artifactId, toPhase);
    } catch {
      // best effort
    }
    return updated;
  }

  // Spec 034: freeze an artifact at its current phase (cracker mode
  // for asset PRGs). Frozen artifacts skip propose_next and count as
  // "done" for completion math.
  freezeArtifactAtPhase(artifactId: string, reason: string): ArtifactRecord | undefined {
    const store = this.storage.loadArtifacts();
    const artifact = store.items.find((item) => item.id === artifactId);
    if (!artifact) return undefined;
    const updated: ArtifactRecord = {
      ...artifact,
      phaseFrozen: true,
      phaseFrozenReason: reason,
      updatedAt: nowIso(),
    };
    this.storage.saveArtifacts({
      ...store,
      updatedAt: nowIso(),
      items: store.items.map((item) => (item.id === artifactId ? updated : item)),
    });
    return updated;
  }

  // Spec 038: helper called by every NEXT-hint emitter (analyze_prg,
  // disasm_prg, etc.). Idempotent on
  // (producedByTool, artifactId, sha1(title)). Cascade-suppress: if
  // an open auto-task exists for the same producedByTool +
  // artifactId, close it before emitting the new one.
  emitNextStepTask(args: {
    producedByTool: string;
    artifactIds: string[];
    title: string;
    description?: string;
    autoCloseHint?: TaskRecord["autoCloseHint"];
    priority?: TaskRecord["priority"];
  }): TaskRecord {
    const { producedByTool, artifactIds, title } = args;
    const primaryArtifactId = artifactIds[0] ?? "";
    const titleHash = createHash("sha1").update(title).digest("hex").slice(0, 8);
    const id = `auto-task:${producedByTool}:${primaryArtifactId}:${titleHash}`.replace(/[^a-zA-Z0-9_:.-]+/g, "-").toLowerCase();
    // Cascade-suppress earlier auto-tasks from same producedByTool on
    // the same artifact whose hash differs.
    const store = this.storage.loadTasks();
    const cascadeTargets = store.items.filter((item) =>
      item.autoSuggested === true
      && item.producedByTool === producedByTool
      && item.id !== id
      && item.status !== "done"
      && item.status !== "wont_fix"
      && primaryArtifactId
      && item.artifactIds.includes(primaryArtifactId)
    );
    for (const target of cascadeTargets) {
      this.saveTask({
        id: target.id,
        kind: target.kind,
        title: target.title,
        status: "done",
      });
    }
    return this.saveTask({
      id,
      kind: "auto-suggested",
      title,
      description: args.description,
      priority: args.priority,
      artifactIds,
      producedByTool,
      autoSuggested: true,
      autoCloseHint: args.autoCloseHint,
    });
  }

  // Spec 038: walk auto-suggested tasks, evaluate autoCloseHint,
  // close those whose hint is satisfied. Returns counts.
  closeCompletedAutoTasks(): { closed: number; checked: number } {
    const store = this.storage.loadTasks();
    let checked = 0;
    let closed = 0;
    const allArtifacts = this.listArtifacts();
    for (const task of store.items) {
      if (task.autoSuggested !== true) continue;
      if (task.status === "done" || task.status === "wont_fix") continue;
      if (!task.autoCloseHint) continue;
      checked += 1;
      let satisfied = false;
      const hint = task.autoCloseHint;
      switch (hint.kind) {
        case "file-exists": {
          const fullPath = resolve(this.storage.paths.root, hint.path);
          satisfied = existsSync(fullPath);
          break;
        }
        case "artifact-registered": {
          satisfied = allArtifacts.some((a) => a.role === hint.role);
          break;
        }
        case "phase-reached": {
          const target = allArtifacts.find((a) => a.id === hint.artifactId);
          satisfied = !!target && (target.phase ?? 1) >= hint.phase;
          break;
        }
      }
      if (satisfied) {
        this.saveTask({ id: task.id, kind: task.kind, title: task.title, status: "done" });
        closed += 1;
      }
    }
    return { closed, checked };
  }

  // Spec 022 / Bug 16: re-import analysis-run artifacts whose entities
  // are not yet back-linked. Idempotent. Called automatically by
  // agent_onboard so the audit no longer warns about unimported runs.
  autoImportUnimportedAnalysisRuns(): { imported: number; entities: number; findings: number; relations: number; flows: number; questions: number } {
    const candidates = this.listArtifacts().filter((a) => a.kind === "analysis-run" && a.role !== "tool-run-record");
    const linkedArtifactIds = new Set<string>();
    for (const e of this.listEntities()) {
      for (const aid of e.artifactIds ?? []) linkedArtifactIds.add(aid);
    }
    let imported = 0;
    let entities = 0;
    let findings = 0;
    let relations = 0;
    let flows = 0;
    let questions = 0;
    for (const candidate of candidates) {
      if (linkedArtifactIds.has(candidate.id)) continue;
      try {
        const r = this.importAnalysisArtifact(candidate.id);
        imported += 1;
        entities += r.importedEntityCount;
        findings += r.importedFindingCount;
        relations += r.importedRelationCount;
        flows += r.importedFlowCount;
        questions += r.importedOpenQuestionCount;
      } catch {
        // skip failing artifacts; they will surface in the audit
      }
    }
    return { imported, entities, findings, relations, flows, questions };
  }

  listArtifacts(): ArtifactRecord[] {
    return [...this.storage.loadArtifacts().items].sort((left, right) => left.title.localeCompare(right.title));
  }

  getArtifactById(artifactId: string): ArtifactRecord | undefined {
    return this.storage.loadArtifacts().items.find((artifact) => artifact.id === artifactId);
  }

  saveEntity(input: SaveEntityInput) {
    const store = this.storage.loadEntities();
    const timestamp = nowIso();
    const existing = input.id ? store.items.find((item) => item.id === input.id) : undefined;
    const entity = {
      id: input.id ?? existing?.id ?? createId("entity", input.name),
      kind: input.kind,
      name: input.name,
      summary: input.summary,
      status: input.status ?? existing?.status ?? "active",
      confidence: input.confidence ?? existing?.confidence ?? 0.5,
      evidence: input.evidence ?? existing?.evidence ?? [],
      artifactIds: uniqueStrings(input.artifactIds ?? existing?.artifactIds),
      relatedEntityIds: uniqueStrings(input.relatedEntityIds ?? existing?.relatedEntityIds),
      addressRange: input.addressRange ?? existing?.addressRange,
      mediumSpans: input.mediumSpans ?? existing?.mediumSpans ?? [],
      mediumRole: input.mediumRole ?? existing?.mediumRole,
      payloadId: input.payloadId ?? existing?.payloadId,
      payloadLoadAddress: input.payloadLoadAddress ?? existing?.payloadLoadAddress,
      payloadFormat: input.payloadFormat ?? existing?.payloadFormat,
      payloadPacker: input.payloadPacker ?? existing?.payloadPacker,
      payloadSourceArtifactId: input.payloadSourceArtifactId ?? existing?.payloadSourceArtifactId,
      payloadDepackedArtifactId: input.payloadDepackedArtifactId ?? existing?.payloadDepackedArtifactId,
      payloadAsmArtifactIds: uniqueStrings(input.payloadAsmArtifactIds ?? existing?.payloadAsmArtifactIds),
      payloadContentHash: input.payloadContentHash ?? existing?.payloadContentHash,
      tags: uniqueStrings(input.tags ?? existing?.tags),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveEntities({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, entity),
    });
    this.appendTimelineEvent({
      kind: "entity.saved",
      title: `Entity saved: ${entity.name}`,
      entityId: entity.id,
      summary: entity.kind,
    });
    return entity;
  }

  listEntities(filters?: { kind?: string; status?: string; artifactId?: string }): EntityRecord[] {
    return this.storage.loadEntities().items
      .filter((entity) => !filters?.kind || entity.kind === filters.kind)
      .filter((entity) => !filters?.status || entity.status === filters.status)
      .filter((entity) => !filters?.artifactId || entity.artifactIds.includes(filters.artifactId))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  saveFinding(input: SaveFindingInput): FindingRecord {
    const store = this.storage.loadFindings();
    const timestamp = nowIso();
    const existing = input.id ? store.items.find((item) => item.id === input.id) : undefined;
    const finding: FindingRecord = {
      id: input.id ?? existing?.id ?? createId("finding", input.title),
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      status: input.status ?? existing?.status ?? "proposed",
      confidence: input.confidence ?? existing?.confidence ?? 0.5,
      evidence: input.evidence ?? existing?.evidence ?? [],
      entityIds: uniqueStrings(input.entityIds ?? existing?.entityIds),
      artifactIds: uniqueStrings(input.artifactIds ?? existing?.artifactIds),
      relationIds: uniqueStrings(input.relationIds ?? existing?.relationIds),
      flowIds: uniqueStrings(input.flowIds ?? existing?.flowIds),
      payloadId: input.payloadId ?? existing?.payloadId,
      addressRange: input.addressRange ?? existing?.addressRange,
      archivedBy: input.archivedBy ?? existing?.archivedBy,
      tags: uniqueStrings(input.tags ?? existing?.tags),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveFindings({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, finding),
    });
    this.appendTimelineEvent({
      kind: "finding.saved",
      title: `Finding saved: ${finding.title}`,
      findingId: finding.id,
      summary: finding.kind,
    });
    // Spec 052: in-band auto-resolution. Walk auto-resolvable
    // questions sharing entityIds with this finding.
    try {
      this.resolveQuestionsForFinding(finding.id);
    } catch {
      // best effort
    }
    return finding;
  }

  listFindings(filters?: { kind?: string; status?: string; entityId?: string }): FindingRecord[] {
    return this.storage.loadFindings().items
      .filter((finding) => !filters?.kind || finding.kind === filters.kind)
      .filter((finding) => !filters?.status || finding.status === filters.status)
      .filter((finding) => !filters?.entityId || finding.entityIds.includes(filters.entityId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  linkEntities(input: LinkEntitiesInput): RelationRecord {
    const store = this.storage.loadRelations();
    const timestamp = nowIso();
    const existing = input.id ? store.items.find((item) => item.id === input.id) : undefined;
    const relation: RelationRecord = {
      id: input.id ?? existing?.id ?? createId("relation", input.title),
      kind: input.kind,
      title: input.title,
      sourceEntityId: input.sourceEntityId,
      targetEntityId: input.targetEntityId,
      summary: input.summary,
      status: input.status ?? existing?.status ?? "active",
      confidence: input.confidence ?? existing?.confidence ?? 0.5,
      evidence: input.evidence ?? existing?.evidence ?? [],
      artifactIds: uniqueStrings(input.artifactIds ?? existing?.artifactIds),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveRelations({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, relation),
    });
    this.appendTimelineEvent({
      kind: "relation.saved",
      title: `Relation saved: ${relation.title}`,
      relationId: relation.id,
      summary: `${relation.sourceEntityId} -> ${relation.targetEntityId}`,
    });
    return relation;
  }

  listRelations(filters?: { kind?: string; entityId?: string; artifactId?: string }): RelationRecord[] {
    return this.storage.loadRelations().items
      .filter((relation) => !filters?.kind || relation.kind === filters.kind)
      .filter((relation) => !filters?.entityId || relation.sourceEntityId === filters.entityId || relation.targetEntityId === filters.entityId)
      .filter((relation) => !filters?.artifactId || relation.artifactIds.includes(filters.artifactId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  saveFlow(input: SaveFlowInput): FlowRecord {
    const store = this.storage.loadFlows();
    const timestamp = nowIso();
    const existing = input.id ? store.items.find((item) => item.id === input.id) : undefined;
    const flow: FlowRecord = {
      id: input.id ?? existing?.id ?? createId("flow", input.title),
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      status: input.status ?? existing?.status ?? "active",
      confidence: input.confidence ?? existing?.confidence ?? 0.5,
      evidence: input.evidence ?? existing?.evidence ?? [],
      entityIds: uniqueStrings(input.entityIds ?? existing?.entityIds),
      artifactIds: uniqueStrings(input.artifactIds ?? existing?.artifactIds),
      nodes: input.nodes ?? existing?.nodes ?? [],
      edges: input.edges ?? existing?.edges ?? [],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.storage.saveFlows({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, flow),
    });
    this.appendTimelineEvent({
      kind: "flow.saved",
      title: `Flow saved: ${flow.title}`,
      flowId: flow.id,
      summary: `${flow.nodes.length} nodes / ${flow.edges.length} edges`,
    });
    return flow;
  }

  listFlows(filters?: { kind?: string; entityId?: string; artifactId?: string }): FlowRecord[] {
    return this.storage.loadFlows().items
      .filter((flow) => !filters?.kind || flow.kind === filters.kind)
      .filter((flow) => !filters?.entityId || flow.entityIds.includes(filters.entityId))
      .filter((flow) => !filters?.artifactId || flow.artifactIds.includes(filters.artifactId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  saveTask(input: SaveTaskInput): TaskRecord {
    const store = this.storage.loadTasks();
    const timestamp = nowIso();
    const existing = input.id ? store.items.find((item) => item.id === input.id) : undefined;
    const task: TaskRecord = {
      id: input.id ?? existing?.id ?? createId("task", input.title),
      kind: input.kind,
      title: input.title,
      description: input.description,
      status: input.status ?? existing?.status ?? "open",
      priority: input.priority ?? existing?.priority ?? "medium",
      confidence: input.confidence ?? existing?.confidence ?? 0.5,
      evidence: input.evidence ?? existing?.evidence ?? [],
      entityIds: uniqueStrings(input.entityIds ?? existing?.entityIds),
      artifactIds: uniqueStrings(input.artifactIds ?? existing?.artifactIds),
      questionIds: uniqueStrings(input.questionIds ?? existing?.questionIds),
      producedByTool: input.producedByTool ?? existing?.producedByTool,
      autoSuggested: input.autoSuggested ?? existing?.autoSuggested,
      autoCloseHint: input.autoCloseHint ?? existing?.autoCloseHint,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      completedAt: input.status === "done" ? timestamp : existing?.completedAt,
    };
    this.storage.saveTasks({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, task),
    });
    this.appendTimelineEvent({
      kind: "task.saved",
      title: `Task saved: ${task.title}`,
      taskId: task.id,
      summary: task.status,
    });
    return task;
  }

  listTasks(filters?: { status?: string; priority?: string; entityId?: string; questionId?: string }): TaskRecord[] {
    return this.storage.loadTasks().items
      .filter((task) => !filters?.status || task.status === filters.status)
      .filter((task) => !filters?.priority || task.priority === filters.priority)
      .filter((task) => !filters?.entityId || task.entityIds.includes(filters.entityId))
      .filter((task) => !filters?.questionId || task.questionIds.includes(filters.questionId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  updateTaskStatus(taskId: string, status: TaskStatus): TaskRecord {
    const existing = this.storage.loadTasks().items.find((task) => task.id === taskId);
    if (!existing) {
      throw new Error(`Unknown task id: ${taskId}`);
    }
    const task = this.saveTask({
      ...existing,
      status,
    });
    this.appendTimelineEvent({
      kind: "task.status.updated",
      title: `Task status updated: ${task.title}`,
      taskId: task.id,
      summary: status,
    });
    return task;
  }

  saveOpenQuestion(input: SaveOpenQuestionInput): OpenQuestionRecord {
    const store = this.storage.loadOpenQuestions();
    const timestamp = nowIso();
    const existing = input.id ? store.items.find((item) => item.id === input.id) : undefined;
    const question: OpenQuestionRecord = {
      id: input.id ?? existing?.id ?? createId("question", input.title),
      kind: input.kind,
      title: input.title,
      description: input.description,
      status: input.status ?? existing?.status ?? "open",
      priority: input.priority ?? existing?.priority ?? "medium",
      confidence: input.confidence ?? existing?.confidence ?? 0.5,
      evidence: input.evidence ?? existing?.evidence ?? [],
      entityIds: uniqueStrings(input.entityIds ?? existing?.entityIds),
      artifactIds: uniqueStrings(input.artifactIds ?? existing?.artifactIds),
      findingIds: uniqueStrings(input.findingIds ?? existing?.findingIds),
      source: input.source ?? existing?.source ?? "untagged",
      autoResolvable: input.autoResolvable ?? existing?.autoResolvable,
      autoResolveHint: input.autoResolveHint ?? existing?.autoResolveHint,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      answeredByFindingId: input.answeredByFindingId ?? existing?.answeredByFindingId,
      answerSummary: input.answerSummary ?? existing?.answerSummary,
    };
    this.storage.saveOpenQuestions({
      ...store,
      updatedAt: timestamp,
      items: upsertRecord(store.items, question),
    });
    this.appendTimelineEvent({
      kind: "question.saved",
      title: `Question saved: ${question.title}`,
      questionId: question.id,
      summary: question.status,
    });
    return question;
  }

  listOpenQuestions(filters?: { status?: string; priority?: string; entityId?: string; findingId?: string }): OpenQuestionRecord[] {
    return this.storage.loadOpenQuestions().items
      .filter((question) => !filters?.status || question.status === filters.status)
      .filter((question) => !filters?.priority || question.priority === filters.priority)
      .filter((question) => !filters?.entityId || question.entityIds.includes(filters.entityId))
      .filter((question) => !filters?.findingId || question.findingIds.includes(filters.findingId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  importAnalysisArtifact(artifactId: string): AnalysisImportResult {
    const artifact = this.getArtifactById(artifactId);
    if (!artifact) {
      throw new Error(`Unknown artifact id: ${artifactId}`);
    }
    const imported = importAnalysisKnowledge(artifact);
    if (!imported) {
      throw new Error(`Artifact is not a readable analysis report: ${artifact.path}`);
    }
    // Resolve the payload that owns this analysis: a payload entity
    // whose payloadSourceArtifactId points at one of this artifact's
    // sourceArtifactIds (the PRG / chip dump that fed analyze-prg).
    // If found, stamp every imported entity / finding with that
    // payloadId so the routine-to-payload linkage is automatic.
    const sourceArtifactIds = new Set(artifact.sourceArtifactIds ?? []);
    if (sourceArtifactIds.size > 0) {
      const payload = this.listEntities({ kind: "payload" })
        .find((p) => p.payloadSourceArtifactId !== undefined && sourceArtifactIds.has(p.payloadSourceArtifactId));
      if (payload) stampImportedKnowledgeWithPayload(imported, payload.id);
    }
    this.purgeImportedKnowledgeForArtifact(artifactId, ["analysis-import"]);
    for (const entity of imported.entities) {
      this.saveEntity(entity);
    }
    for (const finding of imported.findings) {
      this.saveFinding(finding);
    }
    for (const relation of imported.relations) {
      this.linkEntities(relation);
    }
    for (const flow of imported.flows) {
      this.saveFlow(flow);
    }
    for (const question of imported.openQuestions) {
      // Spec 036: questions imported from analysis-run artifacts are
      // by definition heuristic Phase-1 output. Tag them so the UI
      // can sort them below human-review questions.
      this.saveOpenQuestion({ ...question, source: "heuristic-phase1" });
    }
    this.appendTimelineEvent({
      kind: "note",
      title: `Imported analysis report: ${imported.reportTitle}`,
      artifactId,
      summary: [
        `${imported.entities.length} entities`,
        `${imported.findings.length} findings`,
        `${imported.relations.length} relations`,
        `${imported.flows.length} flows`,
        `${imported.openQuestions.length} open questions`,
      ].join(" / "),
    });
    return {
      artifact,
      importedEntityCount: imported.entities.length,
      importedFindingCount: imported.findings.length,
      importedRelationCount: imported.relations.length,
      importedFlowCount: imported.flows.length,
      importedOpenQuestionCount: imported.openQuestions.length,
    };
  }

  importManifestArtifact(artifactId: string): ManifestImportResult {
    const artifact = this.getArtifactById(artifactId);
    if (!artifact) {
      throw new Error(`Unknown artifact id: ${artifactId}`);
    }
    const imported = importManifestKnowledge(artifact);
    if (!imported) {
      throw new Error(`Artifact is not a readable supported manifest: ${artifact.path}`);
    }
    this.purgeImportedKnowledgeForArtifact(artifactId, ["manifest-import"]);
    for (const entity of imported.entities) {
      this.saveEntity(entity);
    }
    for (const finding of imported.findings) {
      this.saveFinding(finding);
    }
    for (const relation of imported.relations) {
      this.linkEntities(relation);
    }
    this.appendTimelineEvent({
      kind: "note",
      title: `Imported manifest: ${imported.title}`,
      artifactId,
      summary: [
        `${imported.entities.length} entities`,
        `${imported.findings.length} findings`,
        `${imported.relations.length} relations`,
      ].join(" / "),
    });
    return {
      artifact,
      importedEntityCount: imported.entities.length,
      importedFindingCount: imported.findings.length,
      importedRelationCount: imported.relations.length,
    };
  }

  createCheckpoint(input: CreateCheckpointInput): ProjectCheckpoint {
    const checkpoint: ProjectCheckpoint = {
      id: input.id ?? createId("checkpoint", input.title),
      kind: "checkpoint",
      title: input.title,
      summary: input.summary,
      createdAt: nowIso(),
      evidence: input.evidence ?? [],
      artifactIds: uniqueStrings(input.artifactIds),
      entityIds: uniqueStrings(input.entityIds),
      findingIds: uniqueStrings(input.findingIds),
      flowIds: uniqueStrings(input.flowIds),
      taskIds: uniqueStrings(input.taskIds),
      questionIds: uniqueStrings(input.questionIds),
    };
    this.storage.saveCheckpoint(checkpoint);
    this.appendTimelineEvent({
      kind: "checkpoint.created",
      title: `Checkpoint created: ${checkpoint.title}`,
      checkpointId: checkpoint.id,
      summary: checkpoint.summary,
    });
    return checkpoint;
  }

  appendTimelineEvent(input: AppendTimelineEventInput): TimelineEvent {
    return this.storage.appendTimelineEvent({
      id: input.id ?? createId("timeline", input.title),
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      createdAt: nowIso(),
      artifactId: input.artifactId,
      entityId: input.entityId,
      findingId: input.findingId,
      relationId: input.relationId,
      flowId: input.flowId,
      taskId: input.taskId,
      questionId: input.questionId,
      checkpointId: input.checkpointId,
      payload: input.payload,
    });
  }

  registerToolRun(input: RegisterToolRunInput): { record: ToolRunRecord; runPath: string } {
    const record: ToolRunRecord = {
      id: input.id ?? createId("run", `${input.toolName}-${input.title}`),
      toolName: input.toolName,
      title: input.title,
      startedAt: input.startedAt ?? nowIso(),
      completedAt: input.completedAt ?? nowIso(),
      status: input.status ?? "completed",
      projectRoot: this.storage.paths.root,
      inputArtifactIds: uniqueStrings(input.inputArtifactIds),
      outputArtifactIds: uniqueStrings(input.outputArtifactIds),
      parameters: input.parameters ?? {},
      notes: [...new Set(input.notes ?? [])],
    };
    const runPath = this.storage.saveToolRun(record);
    const runArtifact = this.saveArtifact({
      kind: "analysis-run",
      scope: "analysis",
      title: record.title,
      path: runPath,
      format: "json",
      role: "tool-run-record",
      producedByTool: input.toolName,
      sourceArtifactIds: record.inputArtifactIds,
      confidence: record.status === "completed" ? 1 : 0,
      tags: [input.toolName],
    });
    this.appendTimelineEvent({
      kind: "artifact.registered",
      title: `Tool run recorded: ${record.toolName}`,
      artifactId: runArtifact.id,
      summary: runPath,
      payload: {
        toolName: record.toolName,
        runId: record.id,
      },
    });
    return { record, runPath };
  }

  buildProjectDashboardView(): { path: string; view: ReturnType<typeof buildProjectDashboardView> } {
    const bundle = this.loadBundle();
    const view = buildProjectDashboardView(bundle);
    return this.persistView("Project dashboard view built", this.storage.saveProjectDashboardView(view), view);
  }

  buildMemoryMapView(): { path: string; view: ReturnType<typeof buildMemoryMapView> } {
    const bundle = this.loadBundle();
    const view = buildMemoryMapView(bundle);
    return this.persistView("Memory map view built", this.storage.saveMemoryMapView(view), view);
  }

  buildDiskLayoutView(): { path: string; view: ReturnType<typeof buildDiskLayoutView> } {
    const bundle = this.loadBundle();
    const view = buildDiskLayoutView(bundle);
    return this.persistView("Disk layout view built", this.storage.saveDiskLayoutView(view), view);
  }

  buildCartridgeLayoutView(): { path: string; view: ReturnType<typeof buildCartridgeLayoutView> } {
    const bundle = this.loadBundle();
    const view = buildCartridgeLayoutView(bundle);
    return this.persistView("Cartridge layout view built", this.storage.saveCartridgeLayoutView(view), view);
  }

  buildLoadSequenceView(): { path: string; view: ReturnType<typeof buildLoadSequenceView> } {
    const bundle = this.loadBundle();
    const view = buildLoadSequenceView(bundle);
    return this.persistView("Load sequence view built", this.storage.saveLoadSequenceView(view), view);
  }

  buildFlowGraphView(): { path: string; view: ReturnType<typeof buildFlowGraphView> } {
    const bundle = this.loadBundle();
    const view = buildFlowGraphView(bundle);
    return this.persistView("Flow graph view built", this.storage.saveFlowGraphView(view), view);
  }

  buildAnnotatedListingView(): { path: string; view: AnnotatedListingView } {
    const bundle = this.loadBundle();
    const view = buildAnnotatedListingView(bundle);
    return this.persistView("Annotated listing view built", this.storage.saveAnnotatedListingView(view), view);
  }

  buildAllViews(): BuildAllViewsResult {
    return {
      projectDashboard: this.buildProjectDashboardView(),
      memoryMap: this.buildMemoryMapView(),
      diskLayout: this.buildDiskLayoutView(),
      cartridgeLayout: this.buildCartridgeLayoutView(),
      loadSequence: this.buildLoadSequenceView(),
      flowGraph: this.buildFlowGraphView(),
      annotatedListing: this.buildAnnotatedListingView(),
    };
  }

  buildWorkspaceUiSnapshot(): WorkspaceUiSnapshot {
    const bundle = this.loadBundle();
    const views = this.composeViews(bundle);
    const workflowPlan = this.storage.loadWorkflowPlan();
    const workflowState = this.syncWorkflowState(workflowPlan);
    return {
      generatedAt: nowIso(),
      project: bundle.project,
      counts: {
        artifacts: bundle.artifacts.length,
        entities: bundle.entities.length,
        findings: bundle.findings.length,
        relations: bundle.relations.length,
        flows: bundle.flows.length,
        tasks: bundle.tasks.length,
        openQuestions: bundle.openQuestions.length,
        checkpoints: bundle.checkpoints.length,
      },
      workflowPlan,
      workflowState,
      recentTimeline: [...bundle.timeline].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 24),
      artifacts: [...bundle.artifacts].sort((left, right) => left.title.localeCompare(right.title)),
      entities: [...bundle.entities].sort((left, right) => left.name.localeCompare(right.name)),
      findings: [...bundle.findings].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      relations: [...bundle.relations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      flows: [...bundle.flows].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      tasks: [...bundle.tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      openQuestions: [...bundle.openQuestions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      checkpoints: [...bundle.checkpoints].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      views: {
        projectDashboard: views.projectDashboard,
        memoryMap: views.memoryMap,
        diskLayout: views.diskLayout,
        cartridgeLayout: views.cartridgeLayout,
        mediumLayout: views.mediumLayout,
        annotatedListing: views.annotatedListing,
        loadSequence: views.loadSequence,
        flowGraph: views.flowGraph,
      },
    };
  }

  private requireProject(): ProjectMetadata {
    const project = this.storage.loadProject();
    if (!project) {
      throw new Error(`Project metadata missing in ${this.storage.paths.knowledgeProject}. Run initProject() first.`);
    }
    return project;
  }

  private loadBundle() {
    return {
      project: this.requireProject(),
      artifacts: this.storage.loadArtifacts().items,
      entities: this.storage.loadEntities().items,
      findings: this.storage.loadFindings().items,
      relations: this.storage.loadRelations().items,
      flows: this.storage.loadFlows().items,
      tasks: this.storage.loadTasks().items,
      openQuestions: this.storage.loadOpenQuestions().items,
      timeline: this.storage.readTimeline(50),
      checkpoints: this.storage.listCheckpoints(),
    };
  }

  private syncWorkflowState(plan: WorkflowPlan): WorkflowState {
    const bundle = this.loadBundle();
    const artifacts = bundle.artifacts;
    const artifactRoles = new Set(artifacts.map((artifact) => artifact.role).filter((role): role is string => Boolean(role)));
    const viewFiles = [
      this.storage.paths.viewProjectDashboard,
      this.storage.paths.viewMemoryMap,
      this.storage.paths.viewDiskLayout,
      this.storage.paths.viewCartridgeLayout,
      this.storage.paths.viewAnnotatedListing,
      this.storage.paths.viewLoadSequence,
      this.storage.paths.viewFlowGraph,
    ];
    const completedPhaseIds = new Set<string>();
    const phaseStates: WorkflowPhaseState[] = [];

    for (const phase of plan.phases) {
      const blockingPhaseIds = phase.prerequisitePhaseIds.filter((phaseId) => !completedPhaseIds.has(phaseId));
      const satisfiedArtifactRoles = phase.requiredArtifactRoles.filter((role) => artifactRoles.has(role));
      const missingArtifactRoles = phase.requiredArtifactRoles.filter((role) => !artifactRoles.has(role));

      let completed = false;
      let progressSignals = 0;
      let summary = phase.description;

      switch (phase.id) {
        case "workspace-init":
          completed = true;
          summary = "Project metadata and workflow contract exist.";
          break;
        case "input-registration":
          progressSignals = artifacts.filter((artifact) => artifact.scope === "input" || ["analysis-target", "disk-image", "cartridge-image"].includes(artifact.role ?? "")).length;
          completed = progressSignals > 0;
          summary = completed ? "Tracked source inputs are registered as project artifacts." : "No source media or analysis targets are registered yet.";
          break;
        case "deterministic-extraction":
          progressSignals = artifacts.filter((artifact) => ["analysis-json", "disk-manifest", "crt-manifest", "kickassembler-source", "64tass-source", "ram-report", "pointer-report"].includes(artifact.role ?? "")).length;
          completed = progressSignals > 0;
          summary = completed ? "Deterministic manifests/reports exist." : "No deterministic analysis/manifests have been recorded yet.";
          break;
        case "structural-enrichment":
          progressSignals = bundle.entities.length + bundle.relations.length + bundle.flows.length;
          completed = bundle.entities.length > 0 || bundle.relations.length > 0;
          summary = completed ? `${bundle.entities.length} entities and ${bundle.relations.length} relations are persisted.` : "No structural entities/relations persisted yet.";
          break;
        case "semantic-enrichment":
          progressSignals = bundle.findings.length + bundle.tasks.length + bundle.openQuestions.length;
          completed = bundle.findings.length > 0 || bundle.tasks.length > 0 || bundle.openQuestions.length > 0;
          summary = completed ? `${bundle.findings.length} findings, ${bundle.tasks.length} tasks, ${bundle.openQuestions.length} open questions.` : "No semantic findings or questions saved yet.";
          break;
        case "semantic-feedback-refinement":
          progressSignals = bundle.findings.length + bundle.relations.length + bundle.flows.length + artifacts.filter((artifact) =>
            ["semantic-annotations", "refined-analysis-json", "payload-link-map"].includes(artifact.role ?? ""),
          ).length;
          completed = bundle.findings.length > 0 && (bundle.relations.length > 0 || bundle.flows.length > 0);
          summary = completed
            ? "Semantic feedback has strengthened structure, relationships, or targeted refinements beyond the first heuristic cut."
            : "No semantically-driven refinement pass has been captured yet.";
          break;
        case "runtime-capture":
          progressSignals = artifacts.filter((artifact) =>
            artifact.kind === "trace" || (artifact.role ?? "").startsWith("runtime-trace-"),
          ).length;
          completed = artifactRoles.has("runtime-trace-summary") || artifacts.some((artifact) => artifact.kind === "trace");
          summary = completed ? "Raw runtime capture artifacts are available for later aggregation." : "No runtime capture artifacts recorded yet.";
          break;
        case "runtime-aggregation":
          progressSignals = artifacts.filter((artifact) => ["runtime-summary", "runtime-phases", "runtime-scenarios", "memory-activity"].includes(artifact.role ?? "")).length;
          completed = progressSignals > 0;
          summary = completed ? "Aggregated runtime artifacts are available for cheap reuse." : "Raw runtime traces have not yet been condensed into compact artifacts.";
          break;
        case "view-build":
          progressSignals = viewFiles.filter((path) => existsSync(path)).length;
          completed = progressSignals > 0;
          summary = completed ? `${progressSignals} persisted JSON view-model(s) exist under views/.` : "No persisted view-models have been built yet.";
          break;
        default:
          progressSignals = satisfiedArtifactRoles.length;
          completed = missingArtifactRoles.length === 0 && blockingPhaseIds.length === 0 && progressSignals > 0;
          break;
      }

      const status: WorkflowPhaseState["status"] = completed
        ? "completed"
        : blockingPhaseIds.length > 0 || missingArtifactRoles.length > 0
          ? "blocked"
          : progressSignals > 0
            ? "in_progress"
            : "ready";

      const phaseState: WorkflowPhaseState = {
        phaseId: phase.id,
        status,
        summary,
        satisfiedArtifactRoles: uniqueStrings(satisfiedArtifactRoles),
        missingArtifactRoles: uniqueStrings(missingArtifactRoles),
        blockingPhaseIds,
        lastUpdatedAt: nowIso(),
      };
      phaseStates.push(phaseState);
      if (completed) {
        completedPhaseIds.add(phase.id);
      }
    }

    const currentPhase = phaseStates.find((phase) => phase.status === "in_progress");
    const nextPhase = phaseStates.find((phase) => phase.status === "ready");
    const summary = currentPhase
      ? `Current phase: ${currentPhase.phaseId}.`
      : nextPhase
        ? `Next recommended phase: ${nextPhase.phaseId}.`
        : "All configured workflow phases are either completed or blocked.";

    const state: WorkflowState = {
      schemaVersion: 1,
      updatedAt: nowIso(),
      currentPhaseId: currentPhase?.phaseId,
      nextRecommendedPhaseId: nextPhase?.phaseId,
      summary,
      phases: phaseStates,
    };
    return this.storage.saveWorkflowState(state);
  }

  private composeViews(bundle: ReturnType<ProjectKnowledgeService["loadBundle"]>) {
    const diskLayout = buildDiskLayoutView(bundle);
    const cartridgeLayout = buildCartridgeLayoutView(bundle);
    return {
      projectDashboard: buildProjectDashboardView(bundle),
      memoryMap: buildMemoryMapView(bundle),
      diskLayout,
      cartridgeLayout,
      mediumLayout: buildMediumLayoutView(bundle, diskLayout, cartridgeLayout),
      loadSequence: buildLoadSequenceView(bundle),
      flowGraph: buildFlowGraphView(bundle),
      annotatedListing: buildAnnotatedListingView(bundle),
    };
  }

  private persistView<T>(title: string, path: string, view: T): { path: string; view: T } {
    this.appendTimelineEvent({
      kind: "view.built",
      title,
      summary: path,
    });
    return { path, view };
  }

  private purgeImportedKnowledgeForArtifact(artifactId: string, importTags: string[]): void {
    const timestamp = nowIso();

    const entityStore = this.storage.loadEntities();
    const nextEntities = entityStore.items.filter((entity) => !(entity.artifactIds.includes(artifactId) && entity.tags.some((tag) => importTags.includes(tag))));
    if (nextEntities.length !== entityStore.items.length) {
      this.storage.saveEntities({
        ...entityStore,
        updatedAt: timestamp,
        items: nextEntities,
      });
    }

    const findingStore = this.storage.loadFindings();
    const nextFindings = findingStore.items.filter((finding) => !(finding.artifactIds.includes(artifactId) && finding.tags.some((tag) => importTags.includes(tag))));
    if (nextFindings.length !== findingStore.items.length) {
      this.storage.saveFindings({
        ...findingStore,
        updatedAt: timestamp,
        items: nextFindings,
      });
    }

    const relationStore = this.storage.loadRelations();
    const nextRelations = relationStore.items.filter((relation) => !relation.id.startsWith(`relation-${artifactId}-`));
    if (nextRelations.length !== relationStore.items.length) {
      this.storage.saveRelations({
        ...relationStore,
        updatedAt: timestamp,
        items: nextRelations,
      });
    }

    const flowStore = this.storage.loadFlows();
    const nextFlows = flowStore.items.filter((flow) => !flow.id.startsWith(`flow-${artifactId}-`));
    if (nextFlows.length !== flowStore.items.length) {
      this.storage.saveFlows({
        ...flowStore,
        updatedAt: timestamp,
        items: nextFlows,
      });
    }

    const questionStore = this.storage.loadOpenQuestions();
    const nextQuestions = questionStore.items.filter((question) => !question.id.startsWith(`question-${artifactId}-`));
    if (nextQuestions.length !== questionStore.items.length) {
      this.storage.saveOpenQuestions({
        ...questionStore,
        updatedAt: timestamp,
        items: nextQuestions,
      });
    }
  }
}
