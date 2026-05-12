import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  ArtifactStoreSchema,
  type ArtifactRecord,
  type ArtifactStore,
  ContainerEntryStoreSchema,
  type ContainerEntry,
  type ContainerEntryStore,
  LoaderEntryPointStoreSchema,
  type LoaderEntryPoint,
  type LoaderEntryPointStore,
  LoaderEventStoreSchema,
  type LoaderEvent,
  type LoaderEventStore,
  ProjectProfileSchema,
  type ProjectProfile,
  AntiPatternStoreSchema,
  type AntiPattern,
  type AntiPatternStore,
  PatchRecipeStoreSchema,
  type PatchRecipe,
  type PatchRecipeStore,
  ResourceRegionStoreSchema,
  type ResourceRegion,
  type ResourceRegionStore,
  OperationStoreSchema,
  type Operation,
  type OperationStore,
  ConstraintRuleStoreSchema,
  type ConstraintRule,
  type ConstraintRuleStore,
  RuntimeScenarioStoreSchema,
  type RuntimeScenario,
  type RuntimeScenarioStore,
  RuntimeEventSummaryStoreSchema,
  type RuntimeEventSummary,
  type RuntimeEventSummaryStore,
  RuntimeDiffStoreSchema,
  type RuntimeDiff,
  type RuntimeDiffStore,
  BuildPipelineStoreSchema,
  type BuildPipeline,
  type BuildPipelineStore,
  BuildRunStoreSchema,
  type BuildRun,
  type BuildRunStore,
  type AnnotatedListingView,
  AnnotatedListingViewSchema,
  type CartridgeLayoutView,
  CartridgeLayoutViewSchema,
  type DiskLayoutView,
  DiskLayoutViewSchema,
  type FlowGraphView,
  FlowGraphViewSchema,
  type LoadSequenceView,
  LoadSequenceViewSchema,
  FlowStoreSchema,
  type FlowRecord,
  type FlowStore,
  type JsonValue,
  type MemoryMapView,
  MemoryMapViewSchema,
  OpenQuestionStoreSchema,
  type OpenQuestionRecord,
  type OpenQuestionStore,
  PROJECT_KNOWLEDGE_SCHEMA_VERSION,
  type ProjectCheckpoint,
  ProjectCheckpointSchema,
  type ProjectDashboardView,
  ProjectDashboardViewSchema,
  type ProjectMetadata,
  ProjectMetadataSchema,
  type WorkflowPlan,
  WorkflowPlanSchema,
  type WorkflowState,
  WorkflowStateSchema,
  type RelationRecord,
  type RelationStore,
  RelationStoreSchema,
  type TimelineEvent,
  TimelineEventSchema,
  type ToolRunRecord,
  ToolRunRecordSchema,
  type UserLabelStore,
  UserLabelStoreSchema,
  EntityStoreSchema,
  type EntityRecord,
  type EntityStore,
  FindingStoreSchema,
  type FindingRecord,
  type FindingStore,
  type TaskRecord,
  type TaskStore,
  TaskStoreSchema,
} from "./types.js";

export interface ProjectKnowledgePaths {
  root: string;
  input: string;
  artifacts: string;
  analysis: string;
  knowledge: string;
  views: string;
  session: string;
  inputPrg: string;
  inputCrt: string;
  inputDisk: string;
  inputRaw: string;
  artifactsExtracted: string;
  artifactsGeneratedSrc: string;
  artifactsPreviews: string;
  artifactsReports: string;
  analysisRuns: string;
  analysisLatest: string;
  analysisIndexes: string;
  sessionCheckpoints: string;
  knowledgeProject: string;
  knowledgeArtifacts: string;
  knowledgeEntities: string;
  knowledgeFindings: string;
  knowledgeRelations: string;
  knowledgeFlows: string;
  knowledgeTasks: string;
  knowledgeOpenQuestions: string;
  knowledgeContainers: string;
  knowledgeLoaderEntryPoints: string;
  knowledgeLoaderEvents: string;
  knowledgeProjectProfile: string;
  knowledgeAntiPatterns: string;
  knowledgePatches: string;
  knowledgeResources: string;
  knowledgeOperations: string;
  knowledgeConstraints: string;
  knowledgeRuntimeScenarios: string;
  knowledgeRuntimeEvents: string;
  knowledgeRuntimeDiffs: string;
  knowledgeBuildPipelines: string;
  knowledgeBuildRuns: string;
  knowledgeLabelsUser: string;
  snapshotsRoot: string;
  knowledgeNotes: string;
  knowledgePhasePlan: string;
  knowledgeWorkflowState: string;
  viewProjectDashboard: string;
  viewMemoryMap: string;
  viewDiskLayout: string;
  viewCartridgeLayout: string;
  viewAnnotatedListing: string;
  viewLoadSequence: string;
  viewFlowGraph: string;
  sessionTimeline: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyStore<T>(): { schemaVersion: 1; updatedAt: string; items: T[] } {
  return {
    schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    updatedAt: nowIso(),
    items: [],
  };
}

function emptyWorkflowPlan(): WorkflowPlan {
  return {
    schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    updatedAt: nowIso(),
    version: "v1",
    title: "Reverse-Engineering Workflow Contract",
    summary: "Project phases, prerequisites, expected artifacts, and recommended tool domains.",
    canonicalDocPaths: [],
    canonicalPromptIds: [],
    phases: [],
  };
}

function emptyWorkflowState(): WorkflowState {
  return {
    schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    updatedAt: nowIso(),
    summary: "Workflow contract not initialized.",
    phases: [],
  };
}

function writeJsonAtomically(path: string, value: JsonValue): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function readJsonOrDefault<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function fileSizeIfExists(path: string): number | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return statSync(path).size;
}

export class ProjectKnowledgeStorage {
  readonly paths: ProjectKnowledgePaths;

  constructor(projectRoot: string) {
    this.paths = createProjectKnowledgePaths(projectRoot);
  }

  ensureProjectStructure(): ProjectKnowledgePaths {
    const dirs = [
      this.paths.root,
      this.paths.input,
      this.paths.artifacts,
      this.paths.analysis,
      this.paths.knowledge,
      this.paths.views,
      this.paths.session,
      this.paths.inputPrg,
      this.paths.inputCrt,
      this.paths.inputDisk,
      this.paths.inputRaw,
      this.paths.artifactsExtracted,
      this.paths.artifactsGeneratedSrc,
      this.paths.artifactsPreviews,
      this.paths.artifactsReports,
      this.paths.analysisRuns,
      this.paths.analysisLatest,
      this.paths.analysisIndexes,
      this.paths.sessionCheckpoints,
    ];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }

    this.ensureJsonFile(this.paths.knowledgeArtifacts, emptyStore<ArtifactRecord>());
    this.ensureJsonFile(this.paths.knowledgeEntities, emptyStore<EntityRecord>());
    this.ensureJsonFile(this.paths.knowledgeFindings, emptyStore<FindingRecord>());
    this.ensureJsonFile(this.paths.knowledgeRelations, emptyStore<RelationRecord>());
    this.ensureJsonFile(this.paths.knowledgeFlows, emptyStore<FlowRecord>());
    this.ensureJsonFile(this.paths.knowledgeTasks, emptyStore<TaskRecord>());
    this.ensureJsonFile(this.paths.knowledgeOpenQuestions, emptyStore<OpenQuestionRecord>());
    this.ensureJsonFile(this.paths.knowledgeContainers, emptyStore<ContainerEntry>());
    this.ensureJsonFile(this.paths.knowledgeLoaderEntryPoints, emptyStore<LoaderEntryPoint>());
    this.ensureJsonFile(this.paths.knowledgeLoaderEvents, emptyStore<LoaderEvent>());
    this.ensureJsonFile(this.paths.knowledgeAntiPatterns, emptyStore<AntiPattern>());
    this.ensureJsonFile(this.paths.knowledgePatches, emptyStore<PatchRecipe>());
    this.ensureJsonFile(this.paths.knowledgeResources, emptyStore<ResourceRegion>());
    this.ensureJsonFile(this.paths.knowledgeOperations, emptyStore<Operation>());
    this.ensureJsonFile(this.paths.knowledgeConstraints, emptyStore<ConstraintRule>());
    this.ensureJsonFile(this.paths.knowledgeRuntimeScenarios, emptyStore<RuntimeScenario>());
    this.ensureJsonFile(this.paths.knowledgeRuntimeEvents, emptyStore<RuntimeEventSummary>());
    this.ensureJsonFile(this.paths.knowledgeRuntimeDiffs, emptyStore<RuntimeDiff>());
    this.ensureJsonFile(this.paths.knowledgeBuildPipelines, emptyStore<BuildPipeline>());
    this.ensureJsonFile(this.paths.knowledgeBuildRuns, emptyStore<BuildRun>());
    this.ensureJsonFile(this.paths.knowledgeLabelsUser, emptyStore<UserLabelStore["items"][number]>());
    this.ensureJsonFile(this.paths.knowledgePhasePlan, emptyWorkflowPlan() as unknown as JsonValue);
    this.ensureJsonFile(this.paths.knowledgeWorkflowState, emptyWorkflowState() as unknown as JsonValue);
    this.ensureTextFile(this.paths.knowledgeNotes, "# Notes\n");
    this.ensureTextFile(this.paths.sessionTimeline, "");

    // Spec 025: snapshots dir kept untracked by default. Auto-create the
    // snapshots/.gitignore so the directory exists with a .gitignore that
    // ignores its contents but keeps the directory itself committed when
    // present.
    mkdirSync(this.paths.snapshotsRoot, { recursive: true });
    this.ensureTextFile(join(this.paths.snapshotsRoot, ".gitignore"), "*\n!.gitignore\n");

    return this.paths;
  }

  loadProject(): ProjectMetadata | undefined {
    if (!existsSync(this.paths.knowledgeProject)) {
      return undefined;
    }
    return ProjectMetadataSchema.parse(readJsonOrDefault(this.paths.knowledgeProject, {}));
  }

  saveProject(project: ProjectMetadata): ProjectMetadata {
    const parsed = ProjectMetadataSchema.parse(project);
    writeJsonAtomically(this.paths.knowledgeProject, parsed as unknown as JsonValue);
    return parsed;
  }

  loadArtifacts(): ArtifactStore {
    return ArtifactStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeArtifacts, emptyStore<ArtifactRecord>()));
  }

  saveArtifacts(store: ArtifactStore): ArtifactStore {
    const parsed = ArtifactStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeArtifacts, parsed as unknown as JsonValue);
    return parsed;
  }

  loadContainerEntries(): ContainerEntryStore {
    return ContainerEntryStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeContainers, emptyStore<ContainerEntry>()));
  }

  saveContainerEntries(store: ContainerEntryStore): ContainerEntryStore {
    const parsed = ContainerEntryStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeContainers, parsed as unknown as JsonValue);
    return parsed;
  }

  loadLoaderEntryPoints(): LoaderEntryPointStore {
    return LoaderEntryPointStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeLoaderEntryPoints, emptyStore<LoaderEntryPoint>()));
  }

  saveLoaderEntryPoints(store: LoaderEntryPointStore): LoaderEntryPointStore {
    const parsed = LoaderEntryPointStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeLoaderEntryPoints, parsed as unknown as JsonValue);
    return parsed;
  }

  loadLoaderEvents(): LoaderEventStore {
    return LoaderEventStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeLoaderEvents, emptyStore<LoaderEvent>()));
  }

  saveLoaderEvents(store: LoaderEventStore): LoaderEventStore {
    const parsed = LoaderEventStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeLoaderEvents, parsed as unknown as JsonValue);
    return parsed;
  }

  loadProjectProfile(): ProjectProfile | undefined {
    if (!existsSync(this.paths.knowledgeProjectProfile)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(this.paths.knowledgeProjectProfile, "utf8"));
      return ProjectProfileSchema.parse(raw);
    } catch {
      return undefined;
    }
  }

  saveProjectProfile(profile: ProjectProfile): ProjectProfile {
    const parsed = ProjectProfileSchema.parse(profile);
    writeJsonAtomically(this.paths.knowledgeProjectProfile, parsed as unknown as JsonValue);
    return parsed;
  }

  loadAntiPatterns(): AntiPatternStore {
    return AntiPatternStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeAntiPatterns, emptyStore<AntiPattern>()));
  }

  saveAntiPatterns(store: AntiPatternStore): AntiPatternStore {
    const parsed = AntiPatternStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeAntiPatterns, parsed as unknown as JsonValue);
    return parsed;
  }

  loadPatches(): PatchRecipeStore {
    return PatchRecipeStoreSchema.parse(readJsonOrDefault(this.paths.knowledgePatches, emptyStore<PatchRecipe>()));
  }

  savePatches(store: PatchRecipeStore): PatchRecipeStore {
    const parsed = PatchRecipeStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgePatches, parsed as unknown as JsonValue);
    return parsed;
  }

  loadResources(): ResourceRegionStore {
    return ResourceRegionStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeResources, emptyStore<ResourceRegion>()));
  }

  saveResources(store: ResourceRegionStore): ResourceRegionStore {
    const parsed = ResourceRegionStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeResources, parsed as unknown as JsonValue);
    return parsed;
  }

  loadOperations(): OperationStore {
    return OperationStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeOperations, emptyStore<Operation>()));
  }

  saveOperations(store: OperationStore): OperationStore {
    const parsed = OperationStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeOperations, parsed as unknown as JsonValue);
    return parsed;
  }

  loadConstraints(): ConstraintRuleStore {
    return ConstraintRuleStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeConstraints, emptyStore<ConstraintRule>()));
  }

  saveConstraints(store: ConstraintRuleStore): ConstraintRuleStore {
    const parsed = ConstraintRuleStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeConstraints, parsed as unknown as JsonValue);
    return parsed;
  }

  loadRuntimeScenarios(): RuntimeScenarioStore {
    return RuntimeScenarioStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeRuntimeScenarios, emptyStore<RuntimeScenario>()));
  }

  saveRuntimeScenarios(store: RuntimeScenarioStore): RuntimeScenarioStore {
    const parsed = RuntimeScenarioStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeRuntimeScenarios, parsed as unknown as JsonValue);
    return parsed;
  }

  loadRuntimeEvents(): RuntimeEventSummaryStore {
    return RuntimeEventSummaryStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeRuntimeEvents, emptyStore<RuntimeEventSummary>()));
  }

  saveRuntimeEvents(store: RuntimeEventSummaryStore): RuntimeEventSummaryStore {
    const parsed = RuntimeEventSummaryStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeRuntimeEvents, parsed as unknown as JsonValue);
    return parsed;
  }

  loadRuntimeDiffs(): RuntimeDiffStore {
    return RuntimeDiffStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeRuntimeDiffs, emptyStore<RuntimeDiff>()));
  }

  saveRuntimeDiffs(store: RuntimeDiffStore): RuntimeDiffStore {
    const parsed = RuntimeDiffStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeRuntimeDiffs, parsed as unknown as JsonValue);
    return parsed;
  }

  loadBuildPipelines(): BuildPipelineStore {
    return BuildPipelineStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeBuildPipelines, emptyStore<BuildPipeline>()));
  }

  saveBuildPipelines(store: BuildPipelineStore): BuildPipelineStore {
    const parsed = BuildPipelineStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeBuildPipelines, parsed as unknown as JsonValue);
    return parsed;
  }

  loadBuildRuns(): BuildRunStore {
    return BuildRunStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeBuildRuns, emptyStore<BuildRun>()));
  }

  saveBuildRuns(store: BuildRunStore): BuildRunStore {
    const parsed = BuildRunStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeBuildRuns, parsed as unknown as JsonValue);
    return parsed;
  }

  loadEntities(): EntityStore {
    return EntityStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeEntities, emptyStore<EntityRecord>()));
  }

  saveEntities(store: EntityStore): EntityStore {
    const parsed = EntityStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeEntities, parsed as unknown as JsonValue);
    return parsed;
  }

  loadFindings(): FindingStore {
    return FindingStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeFindings, emptyStore<FindingRecord>()));
  }

  saveFindings(store: FindingStore): FindingStore {
    const parsed = FindingStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeFindings, parsed as unknown as JsonValue);
    return parsed;
  }

  loadRelations(): RelationStore {
    return RelationStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeRelations, emptyStore<RelationRecord>()));
  }

  saveRelations(store: RelationStore): RelationStore {
    const parsed = RelationStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeRelations, parsed as unknown as JsonValue);
    return parsed;
  }

  loadFlows(): FlowStore {
    return FlowStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeFlows, emptyStore<FlowRecord>()));
  }

  saveFlows(store: FlowStore): FlowStore {
    const parsed = FlowStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeFlows, parsed as unknown as JsonValue);
    return parsed;
  }

  loadTasks(): TaskStore {
    return TaskStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeTasks, emptyStore<TaskRecord>()));
  }

  saveTasks(store: TaskStore): TaskStore {
    const parsed = TaskStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeTasks, parsed as unknown as JsonValue);
    return parsed;
  }

  loadOpenQuestions(): OpenQuestionStore {
    return OpenQuestionStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeOpenQuestions, emptyStore<OpenQuestionRecord>()));
  }

  saveOpenQuestions(store: OpenQuestionStore): OpenQuestionStore {
    const parsed = OpenQuestionStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeOpenQuestions, parsed as unknown as JsonValue);
    return parsed;
  }

  loadUserLabels(): UserLabelStore {
    return UserLabelStoreSchema.parse(readJsonOrDefault(this.paths.knowledgeLabelsUser, emptyStore<UserLabelStore["items"][number]>()));
  }

  saveUserLabels(store: UserLabelStore): UserLabelStore {
    const parsed = UserLabelStoreSchema.parse(store);
    writeJsonAtomically(this.paths.knowledgeLabelsUser, parsed as unknown as JsonValue);
    return parsed;
  }

  loadWorkflowPlan(): WorkflowPlan {
    return WorkflowPlanSchema.parse(readJsonOrDefault(this.paths.knowledgePhasePlan, emptyWorkflowPlan()));
  }

  saveWorkflowPlan(plan: WorkflowPlan): WorkflowPlan {
    const parsed = WorkflowPlanSchema.parse(plan);
    writeJsonAtomically(this.paths.knowledgePhasePlan, parsed as unknown as JsonValue);
    return parsed;
  }

  loadWorkflowState(): WorkflowState {
    return WorkflowStateSchema.parse(readJsonOrDefault(this.paths.knowledgeWorkflowState, emptyWorkflowState()));
  }

  saveWorkflowState(state: WorkflowState): WorkflowState {
    const parsed = WorkflowStateSchema.parse(state);
    writeJsonAtomically(this.paths.knowledgeWorkflowState, parsed as unknown as JsonValue);
    return parsed;
  }

  saveCheckpoint(checkpoint: ProjectCheckpoint): ProjectCheckpoint {
    const parsed = ProjectCheckpointSchema.parse(checkpoint);
    writeJsonAtomically(join(this.paths.sessionCheckpoints, `${parsed.id}.json`), parsed as unknown as JsonValue);
    return parsed;
  }

  listCheckpoints(): ProjectCheckpoint[] {
    if (!existsSync(this.paths.sessionCheckpoints)) {
      return [];
    }
    return readdirSync(this.paths.sessionCheckpoints)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => ProjectCheckpointSchema.parse(readJsonOrDefault(join(this.paths.sessionCheckpoints, entry), {})));
  }

  appendTimelineEvent(event: TimelineEvent): TimelineEvent {
    const parsed = TimelineEventSchema.parse(event);
    appendFileSync(this.paths.sessionTimeline, `${JSON.stringify(parsed)}\n`, "utf8");
    return parsed;
  }

  readTimeline(limit?: number): TimelineEvent[] {
    if (!existsSync(this.paths.sessionTimeline)) {
      return [];
    }
    const lines = readFileSync(this.paths.sessionTimeline, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const selected = limit === undefined ? lines : lines.slice(-limit);
    return selected.map((line) => TimelineEventSchema.parse(JSON.parse(line)));
  }

  saveToolRun(record: ToolRunRecord): string {
    const parsed = ToolRunRecordSchema.parse(record);
    const runPath = join(this.paths.analysisRuns, `${parsed.id}.json`);
    writeJsonAtomically(runPath, parsed as unknown as JsonValue);
    writeJsonAtomically(join(this.paths.analysisLatest, `${parsed.toolName}.json`), parsed as unknown as JsonValue);
    return runPath;
  }

  saveProjectDashboardView(view: ProjectDashboardView): string {
    const parsed = ProjectDashboardViewSchema.parse(view);
    writeJsonAtomically(this.paths.viewProjectDashboard, parsed as unknown as JsonValue);
    return this.paths.viewProjectDashboard;
  }

  saveMemoryMapView(view: MemoryMapView): string {
    const parsed = MemoryMapViewSchema.parse(view);
    writeJsonAtomically(this.paths.viewMemoryMap, parsed as unknown as JsonValue);
    return this.paths.viewMemoryMap;
  }

  saveDiskLayoutView(view: DiskLayoutView): string {
    const parsed = DiskLayoutViewSchema.parse(view);
    writeJsonAtomically(this.paths.viewDiskLayout, parsed as unknown as JsonValue);
    return this.paths.viewDiskLayout;
  }

  saveCartridgeLayoutView(view: CartridgeLayoutView): string {
    const parsed = CartridgeLayoutViewSchema.parse(view);
    writeJsonAtomically(this.paths.viewCartridgeLayout, parsed as unknown as JsonValue);
    return this.paths.viewCartridgeLayout;
  }

  saveFlowGraphView(view: FlowGraphView): string {
    const parsed = FlowGraphViewSchema.parse(view);
    writeJsonAtomically(this.paths.viewFlowGraph, parsed as unknown as JsonValue);
    return this.paths.viewFlowGraph;
  }

  saveLoadSequenceView(view: LoadSequenceView): string {
    const parsed = LoadSequenceViewSchema.parse(view);
    writeJsonAtomically(this.paths.viewLoadSequence, parsed as unknown as JsonValue);
    return this.paths.viewLoadSequence;
  }

  saveAnnotatedListingView(view: AnnotatedListingView): string {
    const parsed = AnnotatedListingViewSchema.parse(view);
    writeJsonAtomically(this.paths.viewAnnotatedListing, parsed as unknown as JsonValue);
    return this.paths.viewAnnotatedListing;
  }

  resolveRelativePath(path: string): string {
    return relative(this.paths.root, resolve(this.paths.root, path)).replace(/\\/g, "/");
  }

  buildArtifactRecord(params: Omit<ArtifactRecord, "relativePath" | "createdAt" | "updatedAt" | "fileSize" | "versions" | "loadContexts"> & { createdAt?: string; updatedAt?: string; versions?: ArtifactRecord["versions"]; loadContexts?: ArtifactRecord["loadContexts"] }): ArtifactRecord {
    const relativePath = this.resolveRelativePath(params.path);
    const createdAt = params.createdAt ?? nowIso();
    const updatedAt = params.updatedAt ?? createdAt;
    return {
      ...params,
      versions: params.versions ?? [],
      loadContexts: params.loadContexts ?? [],
      relativePath,
      createdAt,
      updatedAt,
      fileSize: fileSizeIfExists(params.path),
    };
  }

  readJsonFile(path: string): JsonValue {
    return JSON.parse(readFileSync(path, "utf8")) as JsonValue;
  }

  private ensureJsonFile(path: string, defaultValue: JsonValue): void {
    if (!existsSync(path)) {
      writeJsonAtomically(path, defaultValue);
    }
  }

  private ensureTextFile(path: string, initialValue: string): void {
    if (!existsSync(path)) {
      writeFileSync(path, initialValue, "utf8");
    }
  }
}

export function createProjectKnowledgePaths(projectRoot: string): ProjectKnowledgePaths {
  const root = resolve(projectRoot);
  return {
    root,
    input: join(root, "input"),
    artifacts: join(root, "artifacts"),
    analysis: join(root, "analysis"),
    knowledge: join(root, "knowledge"),
    views: join(root, "views"),
    session: join(root, "session"),
    inputPrg: join(root, "input", "prg"),
    inputCrt: join(root, "input", "crt"),
    inputDisk: join(root, "input", "disk"),
    inputRaw: join(root, "input", "raw"),
    artifactsExtracted: join(root, "artifacts", "extracted"),
    artifactsGeneratedSrc: join(root, "artifacts", "generated-src"),
    artifactsPreviews: join(root, "artifacts", "previews"),
    artifactsReports: join(root, "artifacts", "reports"),
    analysisRuns: join(root, "analysis", "runs"),
    analysisLatest: join(root, "analysis", "latest"),
    analysisIndexes: join(root, "analysis", "indexes"),
    sessionCheckpoints: join(root, "session", "checkpoints"),
    knowledgeProject: join(root, "knowledge", "project.json"),
    knowledgeArtifacts: join(root, "knowledge", "artifacts.json"),
    knowledgeEntities: join(root, "knowledge", "entities.json"),
    knowledgeFindings: join(root, "knowledge", "findings.json"),
    knowledgeRelations: join(root, "knowledge", "relations.json"),
    knowledgeFlows: join(root, "knowledge", "flows.json"),
    knowledgeTasks: join(root, "knowledge", "tasks.json"),
    knowledgeOpenQuestions: join(root, "knowledge", "open-questions.json"),
    knowledgeContainers: join(root, "knowledge", "containers.json"),
    knowledgeLoaderEntryPoints: join(root, "knowledge", "loader-entry-points.json"),
    knowledgeLoaderEvents: join(root, "knowledge", "loader-events.json"),
    knowledgeProjectProfile: join(root, "knowledge", "project-profile.json"),
    knowledgeAntiPatterns: join(root, "knowledge", "anti-patterns.json"),
    knowledgePatches: join(root, "knowledge", "patches.json"),
    knowledgeResources: join(root, "knowledge", "resources.json"),
    knowledgeOperations: join(root, "knowledge", "operations.json"),
    knowledgeConstraints: join(root, "knowledge", "constraints.json"),
    knowledgeRuntimeScenarios: join(root, "knowledge", "runtime-scenarios.json"),
    knowledgeRuntimeEvents: join(root, "knowledge", "runtime-events.json"),
    knowledgeRuntimeDiffs: join(root, "knowledge", "runtime-diffs.json"),
    knowledgeBuildPipelines: join(root, "knowledge", "build-pipelines.json"),
    knowledgeBuildRuns: join(root, "knowledge", "build-runs.json"),
    knowledgeLabelsUser: join(root, "knowledge", "labels.user.json"),
    snapshotsRoot: join(root, "snapshots"),
    knowledgeNotes: join(root, "knowledge", "notes.md"),
    knowledgePhasePlan: join(root, "knowledge", "phase-plan.json"),
    knowledgeWorkflowState: join(root, "knowledge", "workflow-state.json"),
    viewProjectDashboard: join(root, "views", "project-dashboard.json"),
    viewMemoryMap: join(root, "views", "memory-map.json"),
    viewDiskLayout: join(root, "views", "disk-layout.json"),
    viewCartridgeLayout: join(root, "views", "cartridge-layout.json"),
    viewAnnotatedListing: join(root, "views", "annotated-listing.json"),
    viewLoadSequence: join(root, "views", "load-sequence.json"),
    viewFlowGraph: join(root, "views", "flow-graph.json"),
    sessionTimeline: join(root, "session", "timeline.jsonl"),
  };
}

export function defaultProjectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || basename(name).toLowerCase() || "project";
}
