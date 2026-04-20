import { z } from "zod";

export const PROJECT_KNOWLEDGE_SCHEMA_VERSION = 1;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema)]),
);

export const EntityStatusSchema = z.enum(["proposed", "active", "confirmed", "rejected", "archived"]);
export const TaskStatusSchema = z.enum(["open", "in_progress", "blocked", "done", "wont_fix"]);
export const QuestionStatusSchema = z.enum(["open", "researching", "answered", "invalidated"]);
export const TimelineEventKindSchema = z.enum([
  "project.initialized",
  "artifact.registered",
  "finding.saved",
  "entity.saved",
  "relation.saved",
  "flow.saved",
  "task.saved",
  "task.status.updated",
  "question.saved",
  "checkpoint.created",
  "view.built",
  "note",
]);

export const ConfidenceSchema = z.number().min(0).max(1);
export const IdSchema = z.string().min(1);
export const TimestampSchema = z.string().min(1);

export const AddressRangeSchema = z.object({
  start: z.number().int().min(0).max(0xffff),
  end: z.number().int().min(0).max(0xffff),
  bank: z.number().int().nonnegative().optional(),
  label: z.string().optional(),
});

export const FileLocationSchema = z.object({
  path: z.string().optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  offsetStart: z.number().int().nonnegative().optional(),
  offsetEnd: z.number().int().nonnegative().optional(),
});

export const EvidenceKindSchema = z.enum(["artifact", "finding", "entity", "relation", "flow", "task", "question", "note", "external"]);

export const EvidenceRefSchema = z.object({
  kind: EvidenceKindSchema,
  title: z.string().min(1),
  artifactId: IdSchema.optional(),
  entityId: IdSchema.optional(),
  findingId: IdSchema.optional(),
  relationId: IdSchema.optional(),
  flowId: IdSchema.optional(),
  taskId: IdSchema.optional(),
  questionId: IdSchema.optional(),
  excerpt: z.string().optional(),
  note: z.string().optional(),
  addressRange: AddressRangeSchema.optional(),
  fileLocation: FileLocationSchema.optional(),
  capturedAt: TimestampSchema,
});

export const ArtifactScopeSchema = z.enum(["input", "generated", "analysis", "knowledge", "view", "session"]);
export const ArtifactKindSchema = z.enum([
  "prg",
  "crt",
  "d64",
  "g64",
  "raw",
  "analysis-run",
  "report",
  "generated-source",
  "manifest",
  "extract",
  "preview",
  "listing",
  "trace",
  "view-model",
  "checkpoint",
  "other",
]);

export const ArtifactRecordSchema = z.object({
  id: IdSchema,
  kind: ArtifactKindSchema,
  scope: ArtifactScopeSchema,
  title: z.string().min(1),
  path: z.string().min(1),
  relativePath: z.string().min(1),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  format: z.string().optional(),
  role: z.string().optional(),
  producedByTool: z.string().optional(),
  sourceArtifactIds: z.array(IdSchema).default([]),
  entityIds: z.array(IdSchema).default([]),
  evidence: z.array(EvidenceRefSchema).default([]),
  status: EntityStatusSchema.default("active"),
  confidence: ConfidenceSchema.default(1),
  fileSize: z.number().int().nonnegative().optional(),
  contentHash: z.string().optional(),
  addressRange: AddressRangeSchema.optional(),
  tags: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const ProjectStatusSchema = z.enum(["active", "paused", "archived"]);

export const ProjectMetadataSchema = z.object({
  schemaVersion: z.literal(PROJECT_KNOWLEDGE_SCHEMA_VERSION),
  id: IdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().optional(),
  rootPath: z.string().min(1),
  status: ProjectStatusSchema.default("active"),
  tags: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const EntityKindSchema = z.enum([
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
  "other",
]);

export const EntityRecordSchema = z.object({
  id: IdSchema,
  kind: EntityKindSchema,
  name: z.string().min(1),
  summary: z.string().optional(),
  status: EntityStatusSchema.default("active"),
  confidence: ConfidenceSchema.default(0.5),
  evidence: z.array(EvidenceRefSchema).default([]),
  artifactIds: z.array(IdSchema).default([]),
  relatedEntityIds: z.array(IdSchema).default([]),
  addressRange: AddressRangeSchema.optional(),
  tags: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const FindingKindSchema = z.enum([
  "observation",
  "classification",
  "hypothesis",
  "confirmation",
  "refutation",
  "memory-map",
  "disk-layout",
  "cartridge-layout",
  "flow",
  "other",
]);

export const FindingRecordSchema = z.object({
  id: IdSchema,
  kind: FindingKindSchema,
  title: z.string().min(1),
  summary: z.string().optional(),
  status: EntityStatusSchema.default("proposed"),
  confidence: ConfidenceSchema.default(0.5),
  evidence: z.array(EvidenceRefSchema).default([]),
  entityIds: z.array(IdSchema).default([]),
  artifactIds: z.array(IdSchema).default([]),
  relationIds: z.array(IdSchema).default([]),
  flowIds: z.array(IdSchema).default([]),
  tags: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const RelationKindSchema = z.enum([
  "calls",
  "reads",
  "writes",
  "loads",
  "stores",
  "contains",
  "maps-to",
  "depends-on",
  "derived-from",
  "precedes",
  "follows",
  "references",
  "documents",
  "other",
]);

export const RelationRecordSchema = z.object({
  id: IdSchema,
  kind: RelationKindSchema,
  title: z.string().min(1),
  sourceEntityId: IdSchema,
  targetEntityId: IdSchema,
  summary: z.string().optional(),
  status: EntityStatusSchema.default("active"),
  confidence: ConfidenceSchema.default(0.5),
  evidence: z.array(EvidenceRefSchema).default([]),
  artifactIds: z.array(IdSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const FlowNodeSchema = z.object({
  id: IdSchema,
  kind: z.string().min(1),
  title: z.string().min(1),
  entityId: IdSchema.optional(),
  artifactId: IdSchema.optional(),
  addressRange: AddressRangeSchema.optional(),
  status: EntityStatusSchema.default("active"),
  confidence: ConfidenceSchema.default(0.5),
});

export const FlowEdgeSchema = z.object({
  id: IdSchema,
  kind: z.string().min(1),
  title: z.string().min(1),
  fromNodeId: IdSchema,
  toNodeId: IdSchema,
  relationId: IdSchema.optional(),
  summary: z.string().optional(),
  status: EntityStatusSchema.default("active"),
  confidence: ConfidenceSchema.default(0.5),
  evidence: z.array(EvidenceRefSchema).default([]),
});

export const FlowRecordSchema = z.object({
  id: IdSchema,
  kind: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  status: EntityStatusSchema.default("active"),
  confidence: ConfidenceSchema.default(0.5),
  evidence: z.array(EvidenceRefSchema).default([]),
  entityIds: z.array(IdSchema).default([]),
  artifactIds: z.array(IdSchema).default([]),
  nodes: z.array(FlowNodeSchema).default([]),
  edges: z.array(FlowEdgeSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const TaskPrioritySchema = z.enum(["low", "medium", "high", "critical"]);

export const TaskRecordSchema = z.object({
  id: IdSchema,
  kind: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  status: TaskStatusSchema.default("open"),
  priority: TaskPrioritySchema.default("medium"),
  confidence: ConfidenceSchema.default(0.5),
  evidence: z.array(EvidenceRefSchema).default([]),
  entityIds: z.array(IdSchema).default([]),
  artifactIds: z.array(IdSchema).default([]),
  questionIds: z.array(IdSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
});

export const OpenQuestionRecordSchema = z.object({
  id: IdSchema,
  kind: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  status: QuestionStatusSchema.default("open"),
  priority: TaskPrioritySchema.default("medium"),
  confidence: ConfidenceSchema.default(0.5),
  evidence: z.array(EvidenceRefSchema).default([]),
  entityIds: z.array(IdSchema).default([]),
  artifactIds: z.array(IdSchema).default([]),
  findingIds: z.array(IdSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  answeredByFindingId: IdSchema.optional(),
  answerSummary: z.string().optional(),
});

export const UserLabelOverrideSchema = z.object({
  id: IdSchema,
  kind: z.literal("label-override"),
  label: z.string().min(1),
  targetKind: z.enum(["entity", "artifact", "view-item"]),
  targetId: IdSchema.optional(),
  addressRange: AddressRangeSchema.optional(),
  note: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const TimelineEventSchema = z.object({
  id: IdSchema,
  kind: TimelineEventKindSchema,
  title: z.string().min(1),
  summary: z.string().optional(),
  createdAt: TimestampSchema,
  artifactId: IdSchema.optional(),
  entityId: IdSchema.optional(),
  findingId: IdSchema.optional(),
  relationId: IdSchema.optional(),
  flowId: IdSchema.optional(),
  taskId: IdSchema.optional(),
  questionId: IdSchema.optional(),
  checkpointId: IdSchema.optional(),
  payload: z.record(JsonValueSchema).optional(),
});

export const ProjectCheckpointSchema = z.object({
  id: IdSchema,
  kind: z.literal("checkpoint"),
  title: z.string().min(1),
  summary: z.string().optional(),
  createdAt: TimestampSchema,
  evidence: z.array(EvidenceRefSchema).default([]),
  artifactIds: z.array(IdSchema).default([]),
  entityIds: z.array(IdSchema).default([]),
  findingIds: z.array(IdSchema).default([]),
  flowIds: z.array(IdSchema).default([]),
  taskIds: z.array(IdSchema).default([]),
  questionIds: z.array(IdSchema).default([]),
});

export const ToolRunRecordSchema = z.object({
  id: IdSchema,
  toolName: z.string().min(1),
  title: z.string().min(1),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  status: z.enum(["completed", "failed"]),
  projectRoot: z.string().min(1),
  inputArtifactIds: z.array(IdSchema).default([]),
  outputArtifactIds: z.array(IdSchema).default([]),
  parameters: z.record(JsonValueSchema).default({}),
  notes: z.array(z.string()).default([]),
});

export const ProjectCountsSchema = z.object({
  artifacts: z.number().int().nonnegative(),
  entities: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  relations: z.number().int().nonnegative(),
  flows: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  openQuestions: z.number().int().nonnegative(),
  checkpoints: z.number().int().nonnegative(),
});

export const DashboardMetricSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  value: z.string().min(1),
  emphasis: z.enum(["neutral", "info", "warn", "critical"]).default("neutral"),
});

export const DashboardRecordRefSchema = z.object({
  id: IdSchema,
  kind: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  confidence: ConfidenceSchema.optional(),
  summary: z.string().optional(),
  updatedAt: TimestampSchema,
});

export const DashboardOverviewItemSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  body: z.string().min(1),
});

export const ProjectDashboardViewSchema = z.object({
  id: IdSchema,
  kind: z.literal("project-dashboard"),
  title: z.string().min(1),
  projectId: IdSchema,
  generatedAt: TimestampSchema,
  project: ProjectMetadataSchema,
  counts: ProjectCountsSchema,
  metrics: z.array(DashboardMetricSchema),
  overview: z.array(DashboardOverviewItemSchema),
  keyDocuments: z.array(DashboardRecordRefSchema),
  recentArtifacts: z.array(DashboardRecordRefSchema),
  activeFindings: z.array(DashboardRecordRefSchema),
  openTasks: z.array(DashboardRecordRefSchema),
  openQuestions: z.array(DashboardRecordRefSchema),
  recentTimeline: z.array(TimelineEventSchema),
});

export const MemoryMapRegionSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  kind: z.string().min(1),
  start: z.number().int().min(0).max(0xffff),
  end: z.number().int().min(0).max(0xffff),
  bank: z.number().int().nonnegative().optional(),
  entityId: IdSchema.optional(),
  findingIds: z.array(IdSchema).default([]),
  status: z.string().min(1),
  confidence: ConfidenceSchema,
  summary: z.string().optional(),
});

export const MemoryMapCellSchema = z.object({
  id: IdSchema,
  start: z.number().int().min(0).max(0xffff),
  end: z.number().int().min(0).max(0xffff),
  rowBase: z.number().int().min(0).max(0xffff),
  columnOffset: z.number().int().min(0).max(0x0f00),
  category: z.enum(["free", "code", "data", "system", "other"]),
  dominantKind: z.string().min(1),
  dominantTitle: z.string().min(1),
  occupancy: z.number().min(0).max(1),
  regionIds: z.array(IdSchema).default([]),
  entityIds: z.array(IdSchema).default([]),
  dominantEntityId: IdSchema.optional(),
  status: z.string().min(1),
  confidence: ConfidenceSchema,
});

export const MemoryMapHighlightSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  kind: z.enum(["free-space", "code-block", "data-block", "mapped-block"]),
  start: z.number().int().min(0).max(0xffff),
  end: z.number().int().min(0).max(0xffff),
  sizeBytes: z.number().int().nonnegative(),
  entityId: IdSchema.optional(),
  summary: z.string().optional(),
});

export const MemoryMapViewSchema = z.object({
  id: IdSchema,
  kind: z.literal("memory-map"),
  title: z.string().min(1),
  projectId: IdSchema,
  generatedAt: TimestampSchema,
  cellSize: z.number().int().positive(),
  rowStride: z.number().int().positive(),
  cells: z.array(MemoryMapCellSchema),
  highlights: z.array(MemoryMapHighlightSchema),
  regions: z.array(MemoryMapRegionSchema),
});

export const DiskLayoutFileSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  type: z.string().min(1),
  sizeSectors: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  track: z.number().int().nonnegative().optional(),
  sector: z.number().int().nonnegative().optional(),
  loadAddress: z.number().int().min(0).max(0xffff).optional(),
  relativePath: z.string().optional(),
  entityId: IdSchema.optional(),
  sectorChain: z.array(z.object({
    index: z.number().int().nonnegative(),
    track: z.number().int().positive(),
    sector: z.number().int().nonnegative(),
    nextTrack: z.number().int().nonnegative(),
    nextSector: z.number().int().nonnegative(),
    bytesUsed: z.number().int().nonnegative(),
    isLast: z.boolean(),
  })).default([]),
  loadType: z.enum(["kernal", "custom-loader", "unknown"]).default("unknown"),
  loaderHint: z.string().optional(),
  loaderSource: z.string().optional(),
});

export const DiskLayoutSectorCellSchema = z.object({
  id: IdSchema,
  track: z.number().int().positive(),
  sector: z.number().int().nonnegative(),
  angleStart: z.number(),
  angleEnd: z.number(),
  fileId: IdSchema.optional(),
  fileTitle: z.string().optional(),
  occupied: z.boolean(),
  category: z.enum(["free", "file", "directory", "bam", "unknown"]),
});

export const DiskLayoutDiskSchema = z.object({
  artifactId: IdSchema,
  title: z.string().min(1),
  format: z.string().min(1),
  diskName: z.string().optional(),
  diskId: z.string().optional(),
  trackCount: z.number().int().positive(),
  fileCount: z.number().int().nonnegative(),
  sectors: z.array(DiskLayoutSectorCellSchema),
  files: z.array(DiskLayoutFileSchema),
});

export const DiskLayoutViewSchema = z.object({
  id: IdSchema,
  kind: z.literal("disk-layout"),
  title: z.string().min(1),
  projectId: IdSchema,
  generatedAt: TimestampSchema,
  disks: z.array(DiskLayoutDiskSchema),
});

export const CartridgeChipViewSchema = z.object({
  bank: z.number().int().nonnegative(),
  loadAddress: z.number().int().min(0).max(0xffff),
  size: z.number().int().nonnegative(),
  file: z.string().optional(),
});

export const CartridgeBankViewSchema = z.object({
  bank: z.number().int().nonnegative(),
  file: z.string().optional(),
  slots: z.array(z.string()),
});

export const CartridgeLayoutCartridgeSchema = z.object({
  artifactId: IdSchema,
  title: z.string().min(1),
  cartridgeName: z.string().optional(),
  hardwareType: z.number().int().nonnegative().optional(),
  exrom: z.number().int().nonnegative().optional(),
  game: z.number().int().nonnegative().optional(),
  chips: z.array(CartridgeChipViewSchema),
  banks: z.array(CartridgeBankViewSchema),
});

export const CartridgeLayoutViewSchema = z.object({
  id: IdSchema,
  kind: z.literal("cartridge-layout"),
  title: z.string().min(1),
  projectId: IdSchema,
  generatedAt: TimestampSchema,
  cartridges: z.array(CartridgeLayoutCartridgeSchema),
});

export const AnnotatedListingEntrySchema = z.object({
  id: IdSchema,
  start: z.number().int().min(0).max(0xffff),
  end: z.number().int().min(0).max(0xffff),
  title: z.string().min(1),
  kind: z.string().min(1),
  entityId: IdSchema.optional(),
  findingIds: z.array(IdSchema).default([]),
  comment: z.string().optional(),
  confidence: ConfidenceSchema,
  status: z.string().min(1),
});

export const AnnotatedListingViewSchema = z.object({
  id: IdSchema,
  kind: z.literal("annotated-listing"),
  title: z.string().min(1),
  projectId: IdSchema,
  generatedAt: TimestampSchema,
  entries: z.array(AnnotatedListingEntrySchema),
});

export const FlowGraphNodeSchema = z.object({
  id: IdSchema,
  kind: z.string().min(1),
  title: z.string().min(1),
  entityId: IdSchema.optional(),
  summary: z.string().optional(),
  status: z.string().min(1),
  confidence: ConfidenceSchema,
});

export const FlowGraphEdgeSchema = z.object({
  id: IdSchema,
  kind: z.string().min(1),
  title: z.string().min(1),
  from: IdSchema,
  to: IdSchema,
  relationId: IdSchema.optional(),
  summary: z.string().optional(),
  status: z.string().min(1),
  confidence: ConfidenceSchema,
});

export const FlowGraphModeSchema = z.object({
  id: z.enum(["structure", "load", "runtime"]),
  title: z.string().min(1),
  summary: z.string().optional(),
  nodes: z.array(FlowGraphNodeSchema),
  edges: z.array(FlowGraphEdgeSchema),
});

export const FlowGraphViewSchema = z.object({
  id: IdSchema,
  kind: z.literal("flow-graph"),
  title: z.string().min(1),
  projectId: IdSchema,
  generatedAt: TimestampSchema,
  nodes: z.array(FlowGraphNodeSchema),
  edges: z.array(FlowGraphEdgeSchema),
  modes: z.object({
    structure: FlowGraphModeSchema,
    load: FlowGraphModeSchema,
    runtime: FlowGraphModeSchema,
  }).optional(),
});

export const LoadSequenceItemSchema = z.object({
  id: IdSchema,
  key: z.string().min(1),
  order: z.number().int().nonnegative(),
  title: z.string().min(1),
  shortName: z.string().min(1),
  role: z.string().min(1),
  purposeSummary: z.string().optional(),
  status: z.string().min(1),
  confidence: ConfidenceSchema,
  primaryEntityId: IdSchema.optional(),
  entityIds: z.array(IdSchema).default([]),
  artifactIds: z.array(IdSchema).default([]),
  artifactLabels: z.array(z.string()).default([]),
  entryAddresses: z.array(z.number().int().min(0).max(0xffff)).default([]),
  targetRanges: z.array(AddressRangeSchema).default([]),
  sourceKinds: z.array(z.string()).default([]),
  evidenceHints: z.array(z.string()).default([]),
});

export const LoadSequenceEdgeSchema = z.object({
  id: IdSchema,
  kind: z.string().min(1),
  title: z.string().min(1),
  fromItemId: IdSchema,
  toItemId: IdSchema,
  summary: z.string().optional(),
  confidence: ConfidenceSchema,
  evidenceHints: z.array(z.string()).default([]),
});

export const LoadSequenceViewSchema = z.object({
  id: IdSchema,
  kind: z.literal("load-sequence"),
  title: z.string().min(1),
  projectId: IdSchema,
  generatedAt: TimestampSchema,
  items: z.array(LoadSequenceItemSchema),
  edges: z.array(LoadSequenceEdgeSchema),
});

export const WorkspaceUiSnapshotSchema = z.object({
  generatedAt: TimestampSchema,
  project: ProjectMetadataSchema,
  counts: ProjectCountsSchema,
  recentTimeline: z.array(TimelineEventSchema),
  artifacts: z.array(ArtifactRecordSchema),
  entities: z.array(EntityRecordSchema),
  findings: z.array(FindingRecordSchema),
  relations: z.array(RelationRecordSchema),
  flows: z.array(FlowRecordSchema),
  tasks: z.array(TaskRecordSchema),
  openQuestions: z.array(OpenQuestionRecordSchema),
  checkpoints: z.array(ProjectCheckpointSchema),
  views: z.object({
    projectDashboard: ProjectDashboardViewSchema,
    memoryMap: MemoryMapViewSchema,
    diskLayout: DiskLayoutViewSchema,
    cartridgeLayout: CartridgeLayoutViewSchema,
    annotatedListing: AnnotatedListingViewSchema,
    loadSequence: LoadSequenceViewSchema,
    flowGraph: FlowGraphViewSchema,
  }),
});

export const RecordListMetaSchema = z.object({
  schemaVersion: z.literal(PROJECT_KNOWLEDGE_SCHEMA_VERSION),
  updatedAt: TimestampSchema,
});

export function createRecordListSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return RecordListMetaSchema.extend({
    items: z.array(itemSchema).default([]),
  });
}

export const ArtifactStoreSchema = createRecordListSchema(ArtifactRecordSchema);
export const EntityStoreSchema = createRecordListSchema(EntityRecordSchema);
export const FindingStoreSchema = createRecordListSchema(FindingRecordSchema);
export const RelationStoreSchema = createRecordListSchema(RelationRecordSchema);
export const FlowStoreSchema = createRecordListSchema(FlowRecordSchema);
export const TaskStoreSchema = createRecordListSchema(TaskRecordSchema);
export const OpenQuestionStoreSchema = createRecordListSchema(OpenQuestionRecordSchema);
export const UserLabelStoreSchema = RecordListMetaSchema.extend({
  items: z.array(UserLabelOverrideSchema).default([]),
});

export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactScope = z.infer<typeof ArtifactScopeSchema>;
export type EntityRecord = z.infer<typeof EntityRecordSchema>;
export type FindingRecord = z.infer<typeof FindingRecordSchema>;
export type FindingKind = z.infer<typeof FindingKindSchema>;
export type RelationRecord = z.infer<typeof RelationRecordSchema>;
export type RelationKind = z.infer<typeof RelationKindSchema>;
export type FlowRecord = z.infer<typeof FlowRecordSchema>;
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type OpenQuestionRecord = z.infer<typeof OpenQuestionRecordSchema>;
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;
export type UserLabelOverride = z.infer<typeof UserLabelOverrideSchema>;
export type ProjectCheckpoint = z.infer<typeof ProjectCheckpointSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type ToolRunRecord = z.infer<typeof ToolRunRecordSchema>;
export type ProjectDashboardView = z.infer<typeof ProjectDashboardViewSchema>;
export type MemoryMapView = z.infer<typeof MemoryMapViewSchema>;
export type DiskLayoutView = z.infer<typeof DiskLayoutViewSchema>;
export type CartridgeLayoutView = z.infer<typeof CartridgeLayoutViewSchema>;
export type AnnotatedListingView = z.infer<typeof AnnotatedListingViewSchema>;
export type FlowGraphView = z.infer<typeof FlowGraphViewSchema>;
export type FlowGraphMode = z.infer<typeof FlowGraphModeSchema>;
export type LoadSequenceView = z.infer<typeof LoadSequenceViewSchema>;
export type WorkspaceUiSnapshot = z.infer<typeof WorkspaceUiSnapshotSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type ArtifactStore = z.infer<typeof ArtifactStoreSchema>;
export type EntityStore = z.infer<typeof EntityStoreSchema>;
export type FindingStore = z.infer<typeof FindingStoreSchema>;
export type RelationStore = z.infer<typeof RelationStoreSchema>;
export type FlowStore = z.infer<typeof FlowStoreSchema>;
export type TaskStore = z.infer<typeof TaskStoreSchema>;
export type OpenQuestionStore = z.infer<typeof OpenQuestionStoreSchema>;
export type UserLabelStore = z.infer<typeof UserLabelStoreSchema>;
