import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { importAnalysisKnowledge } from "./analysis-import.js";
import { importManifestKnowledge } from "./manifest-import.js";
import { buildAnnotatedListingView, buildCartridgeLayoutView, buildDiskLayoutView, buildFlowGraphView, buildLoadSequenceView, buildMediumLayoutView, buildMemoryMapView, buildProjectDashboardView } from "./view-builders.js";
import { ProjectKnowledgeStorage, defaultProjectSlug } from "./storage.js";
import type {
  AnnotatedListingView,
  ArtifactKind,
  ArtifactRecord,
  ArtifactScope,
  EntityRecord,
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function createId(prefix: string, title: string): string {
  return `${prefix}-${slugify(title)}-${Date.now().toString(36)}`;
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
  tags?: string[];
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
    const existing = input.id ? store.items.find((item) => item.id === input.id) : undefined;
    const artifact = this.storage.buildArtifactRecord({
      id: input.id ?? existing?.id ?? createId("artifact", input.title),
      kind: input.kind,
      scope: input.scope,
      title: input.title,
      path: resolve(this.storage.paths.root, input.path),
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
      this.saveOpenQuestion(question);
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
