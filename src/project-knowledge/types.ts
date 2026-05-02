import { z } from "zod";

export const PROJECT_KNOWLEDGE_SCHEMA_VERSION = 1;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema)]),
);

export const EntityStatusSchema = z.enum(["proposed", "active", "confirmed", "rejected", "archived"]);
export const TaskStatusSchema = z.enum(["open", "in_progress", "blocked", "done", "wont_fix"]);
export const QuestionStatusSchema = z.enum(["open", "researching", "answered", "invalidated", "deferred"]);
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
  "artifact.phase-advanced",
  "artifact.frozen",
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

export const ArtifactVersionEntrySchema = z.object({
  contentHash: z.string(),
  capturedAt: TimestampSchema,
  snapshotPath: z.string().optional(),
  note: z.string().optional(),
});

// Spec 023 load contexts: an artifact's runtime address is not always
// its on-disk PRG header (custom fastloaders can place the same file
// at a different address). Express alternates as a list. Defined here
// so ArtifactRecordSchema below can reference it.
export const LoadContextSchema = z.object({
  kind: z.enum(["as-stored", "runtime", "after-decompression"]),
  address: z.number().int().nonnegative(),
  bank: z.number().int().nonnegative().optional(),
  evidence: z.array(EvidenceRefSchema).default([]),
  triggeredByPc: z.number().int().nonnegative().optional(),
  sourceTrack: z.number().int().nonnegative().optional(),
  sourceSector: z.number().int().nonnegative().optional(),
  capturedAt: TimestampSchema.optional(),
});

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
  // Lineage chain (Spec 025): derivedFrom names the direct parent;
  // lineageRoot is the V0 of the chain (computed automatically);
  // versionLabel defaults to "V<rank>" but the caller can set any
  // free-form label and rename later via rename_artifact_version.
  derivedFrom: IdSchema.optional(),
  lineageRoot: IdSchema.optional(),
  versionLabel: z.string().optional(),
  versionRank: z.number().int().nonnegative().optional(),
  // Same-path history. The latest entry's snapshot lives at the
  // current path; older entries point to snapshots/<artifact-id>/<hash>.bin.
  versions: z.array(ArtifactVersionEntrySchema).default([]),
  // Spec 020: per-artifact platform marker. Default is c64 when absent.
  // Drives ZP / I/O register / ROM symbol annotation in the renderer.
  platform: z.enum(["c64", "c1541", "c128", "vic20", "plus4", "other"]).optional(),
  // Spec 023: alternate load contexts beyond the on-disk PRG header.
  loadContexts: z.array(LoadContextSchema).default([]),
  // Spec 034: current phase in the seven-phase RE workflow. Default 1
  // (extraction). Advanced explicitly via agent_advance_phase. A
  // frozen artifact stays at its current phase and counts as "done"
  // there for completion percentages — used by cracker mode for
  // asset PRGs that do not need full annotation.
  phase: z.number().int().min(1).max(7).optional(),
  phaseFrozen: z.boolean().optional(),
  phaseFrozenReason: z.string().optional(),
  // Spec 041: per-artifact relevance tag for cracker / port priority.
  // relevanceRank is derived (manual > load_sequence > load_event >
  // alphabetic) and not persisted; it lives on the per-artifact
  // status response.
  relevance: z.enum(["loader", "protection", "save", "kernal", "asset", "other"]).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

// Container sub-entry (Spec 025 R23 fold-in). A disk file may contain
// named subentries that are not separate BAM/LUT files. Each sub-entry
// is also represented as a normal artifact via derivedFrom = parentId.
// Spec 026 project profile: structured project-specific bootstrap.
export const ProjectProfileSchema = z.object({
  goals: z.array(z.string()).default([]),
  nonGoals: z.array(z.string()).default([]),
  hardwareConstraints: z.array(z.object({
    resource: z.string(),
    constraint: z.string(),
    reason: z.string().optional(),
  })).default([]),
  loaderModel: z.string().optional(),
  destructiveOperations: z.array(z.object({
    commandPattern: z.string(),
    warning: z.string(),
  })).default([]),
  build: z.object({
    command: z.string(),
    cwd: z.string().optional(),
    outputs: z.array(z.string()).default([]),
  }).optional(),
  test: z.object({
    command: z.string(),
    cwd: z.string().optional(),
  }).optional(),
  activeWorkspace: z.string().optional(),
  dangerZones: z.array(z.object({
    pathOrAddress: z.string(),
    reason: z.string(),
  })).default([]),
  glossary: z.array(z.object({
    term: z.string(),
    definition: z.string(),
    aliases: z.array(z.string()).default([]),
  })).default([]),
  antiPatterns: z.array(z.object({
    title: z.string(),
    reason: z.string(),
    refutationEvidence: z.string().optional(),
  })).default([]),
  crackerOverrides: z.array(z.string()).default([]),
  // Spec 034 + 035: optional gates and reminders.
  phaseGateStrict: z.boolean().optional(),
  phaseReminders: z.enum(["every-tool", "phase-transition", "off"]).optional(),
  defaultRole: z.enum(["analyst", "cracker"]).optional(),
  // Spec 046: workflow template the project follows.
  workflow: z.enum(["full-re", "cracker-only", "analyst-deep", "targeted-routine", "bugfix"]).optional(),
  workflowSelectedAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
});

// Spec 031 negative knowledge: anti-pattern record.
export const AntiPatternSchema = z.object({
  id: IdSchema,
  title: z.string(),
  reason: z.string(),
  severity: z.enum(["info", "warn", "error"]).default("warn"),
  evidence: z.array(EvidenceRefSchema).default([]),
  appliesTo: z.object({
    phase: z.string().optional(),
    toolName: z.string().optional(),
    commandPattern: z.string().optional(),
  }).optional(),
  tags: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

// Spec 027 patch recipes.
export const PatchRecipeSchema = z.object({
  id: IdSchema,
  title: z.string(),
  reason: z.string(),
  evidence: z.array(EvidenceRefSchema).default([]),
  targetArtifactId: IdSchema,
  targetFileOffset: z.number().int().nonnegative().optional(),
  targetRuntimeAddress: z.number().int().nonnegative().optional(),
  expectedBytes: z.string(), // hex
  replacementBytes: z.string().optional(),
  replacementSourcePath: z.string().optional(),
  relocation: z.union([
    z.object({ kind: z.literal("bias"), delta: z.number().int() }),
    z.object({ kind: z.literal("absolute"), baseAddress: z.number().int().nonnegative() }),
  ]).optional(),
  sourceAssembler: z.string().optional(),
  backupArtifactId: IdSchema.optional(),
  verificationCommand: z.string().optional(),
  status: z.enum(["draft", "applied", "verified", "reverted", "failed"]).default("draft"),
  appliedAt: TimestampSchema.optional(),
  appliedHash: z.string().optional(),
  tags: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

// Spec 029 constraint checker: resource regions, operations, rules.
export const ResourceRegionSchema = z.object({
  id: IdSchema,
  kind: z.enum(["ram-range", "zp-byte", "vic-region", "cart-bank", "cart-erase-sector", "eapi-runtime", "io-register"]),
  name: z.string(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  bank: z.number().int().nonnegative().optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const OperationSchema = z.object({
  id: IdSchema,
  kind: z.enum(["overlay-copy", "flash-erase", "flash-write", "bank-switch", "decrunch-write", "runtime-patch", "kernal-call"]),
  triggeredBy: z.string(),
  affects: z.array(IdSchema).default([]),
  preconditions: z.array(z.string()).default([]),
  evidence: z.array(EvidenceRefSchema).default([]),
  notes: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const ConstraintRuleSchema = z.object({
  id: IdSchema,
  title: z.string(),
  appliesTo: z.object({
    regionKind: z.string().optional(),
    opKind: z.string().optional(),
  }).optional(),
  rule: z.string(),
  severity: z.enum(["info", "warn", "error"]).default("warn"),
  tags: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

// Spec 028 loader ABI: declared loader entry points and recorded loader
// events (static or trace-derived).
export const LoaderEntryPointSchema = z.object({
  id: IdSchema,
  artifactId: IdSchema,
  address: z.number().int().nonnegative(),
  bank: z.number().int().nonnegative().optional(),
  kind: z.enum(["jump-table", "sector-load", "container-decode", "dispatch", "init", "other"]),
  name: z.string().optional(),
  paramBlock: z.object({
    address: z.number().int().nonnegative().optional(),
    layout: z.string().optional(),
  }).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const LoaderEventSchema = z.object({
  id: IdSchema,
  scenarioId: IdSchema.optional(),
  loaderEntryPointId: IdSchema.optional(),
  source: z.enum(["static", "trace"]),
  fileKey: z.string().optional(),
  trackSector: z.object({ track: z.number().int(), sector: z.number().int() }).optional(),
  destinationStart: z.number().int().nonnegative().optional(),
  destinationEnd: z.number().int().nonnegative().optional(),
  callerPc: z.number().int().nonnegative().optional(),
  containerSubKey: z.string().optional(),
  sideIndex: z.number().int().nonnegative().optional(),
  success: z.boolean().default(true),
  notes: z.string().optional(),
  capturedAt: TimestampSchema,
});

export const ContainerEntrySchema = z.object({
  id: IdSchema,
  parentArtifactId: IdSchema,
  childArtifactId: IdSchema.optional(),
  subKey: z.string().min(1),
  containerOffset: z.number().int().nonnegative(),
  containerLength: z.number().int().nonnegative(),
  loadAddress: z.number().int().nonnegative().optional(),
  registrationMode: z.enum(["resident", "transient", "deduped"]).optional(),
  status: z.enum(["physically-present", "missing", "inherited"]).default("physically-present"),
  inheritedFrom: IdSchema.optional(),
  evidence: z.array(EvidenceRefSchema).default([]),
  tags: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const ProjectStatusSchema = z.enum(["active", "paused", "archived"]);
export const PreferredAssemblerSchema = z.enum(["kickass", "64tass"]);

export const ProjectMetadataSchema = z.object({
  schemaVersion: z.literal(PROJECT_KNOWLEDGE_SCHEMA_VERSION),
  id: IdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().optional(),
  rootPath: z.string().min(1),
  status: ProjectStatusSchema.default("active"),
  preferredAssembler: PreferredAssemblerSchema.optional(),
  tags: z.array(z.string()).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const WorkflowPhaseStatusSchema = z.enum([
  "not_started",
  "ready",
  "in_progress",
  "blocked",
  "completed",
]);

export const WorkflowArtifactExpectationSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  role: z.string().optional(),
  kind: ArtifactKindSchema.optional(),
  optional: z.boolean().default(false),
});

export const WorkflowPhaseSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  domain: z.string().min(1),
  description: z.string().min(1),
  goals: z.array(z.string()).default([]),
  prerequisitePhaseIds: z.array(IdSchema).default([]),
  requiredArtifactRoles: z.array(z.string()).default([]),
  recommendedToolGroups: z.array(z.string()).default([]),
  outputExpectations: z.array(WorkflowArtifactExpectationSchema).default([]),
  guidance: z.array(z.string()).default([]),
});

export const WorkflowPlanSchema = z.object({
  schemaVersion: z.literal(PROJECT_KNOWLEDGE_SCHEMA_VERSION),
  updatedAt: TimestampSchema,
  version: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  canonicalDocPaths: z.array(z.string()).default([]),
  canonicalPromptIds: z.array(z.string()).default([]),
  phases: z.array(WorkflowPhaseSchema).default([]),
});

export const WorkflowPhaseStateSchema = z.object({
  phaseId: IdSchema,
  status: WorkflowPhaseStatusSchema,
  summary: z.string().optional(),
  satisfiedArtifactRoles: z.array(z.string()).default([]),
  missingArtifactRoles: z.array(z.string()).default([]),
  blockingPhaseIds: z.array(IdSchema).default([]),
  lastUpdatedAt: TimestampSchema,
});

export const WorkflowStateSchema = z.object({
  schemaVersion: z.literal(PROJECT_KNOWLEDGE_SCHEMA_VERSION),
  updatedAt: TimestampSchema,
  currentPhaseId: IdSchema.optional(),
  nextRecommendedPhaseId: IdSchema.optional(),
  summary: z.string().min(1),
  phases: z.array(WorkflowPhaseStateSchema).default([]),
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
  // Payload = the working abstraction across mediums. A payload is a
  // byte-blob with identity: a disk file, a LUT-extracted cart chunk, a
  // hand-extracted custom-loader blob, or a PRG. Operations like depack,
  // disasm, repack, build are scoped to the payload, not the medium.
  // Other entity kinds (routine / data-table / etc) hang off a payload
  // via the payloadId field.
  "payload",
  "other",
]);

// Entity-side medium-placement spans. Same shape as MediumSpanSchema but
// declared up here because EntityRecord is parsed before the unified
// medium types. Lets the LLM (or future analyzer) pin a routine /
// resident region to actual sectors/banks instead of only a 16-bit
// addressRange. The disk- and cart-layout adapters surface entries with
// `mediumSpans` set as MediumResidentRegion so the medium UI shows them.
export const EntityMediumSpanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sector"),
    track: z.number().int().positive(),
    sector: z.number().int().nonnegative(),
    offsetInSector: z.number().int().nonnegative().default(0),
    length: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("slot"),
    bank: z.number().int().nonnegative(),
    slot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH", "EEPROM", "OTHER"]),
    offsetInBank: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
  }),
]);

export const PayloadFormatSchema = z.enum([
  "raw",
  "prg",
  "exomizer-raw",
  "exomizer-sfx",
  "byteboozer",
  "byteboozer-lykia",
  "rle",
  "bwc-bitstream",
  "bwc-raw",
  "pucrunch",
  "unknown",
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
  // Payload this entity belongs to. Routines, data tables, IRQ handlers
  // etc. hang off a payload via this field — surfaces "show every
  // routine inside chunk X" or "every finding for disk file Y" in O(1).
  payloadId: IdSchema.optional(),
  // Payload-only fields (ignored for other entity kinds): describe the
  // byte-blob's identity, format, and where it lands at runtime.
  payloadLoadAddress: z.number().int().min(0).max(0xffff).optional(),
  payloadFormat: PayloadFormatSchema.optional(),
  payloadPacker: z.string().optional(),
  payloadSourceArtifactId: IdSchema.optional(),
  payloadDepackedArtifactId: IdSchema.optional(),
  payloadAsmArtifactIds: z.array(IdSchema).default([]),
  payloadContentHash: z.string().optional(),
  // Spec 037: payload-level disk-hint surfaces protection /
  // drive-code / raw-unanalyzed sectors as colour overlay on the
  // disk heatmap. Set automatically by inspect / extract tools or
  // manually via set_payload_disk_hint.
  payloadDiskHint: z.enum(["drive-code", "protected", "raw-unanalyzed", "bad-crc", "gap"]).optional(),
  addressRange: AddressRangeSchema.optional(),
  // Optional physical placement on the medium (disk sectors / cart slots).
  // Drives the MediumResidentRegion overlay in the medium-layout adapter.
  mediumSpans: z.array(EntityMediumSpanSchema).default([]),
  // Optional medium-resident role hint. When unset the adapter falls back
  // to "unknown".
  mediumRole: z
    .enum(["dos", "loader", "eapi", "startup", "code", "data", "padding", "unknown"])
    .optional(),
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
  // Optional: payload this finding scopes to (routine inside chunk X,
  // data table inside disk file Y, etc.).
  payloadId: IdSchema.optional(),
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

// Spec 038: auto-close hints for NEXT-hint generated tasks.
export const TaskAutoCloseHintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file-exists"), path: z.string() }),
  z.object({ kind: z.literal("artifact-registered"), role: z.string() }),
  z.object({ kind: z.literal("phase-reached"), artifactId: IdSchema, phase: z.number().int().min(1).max(7) }),
]);

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
  // Spec 038: auto-suggested NEXT-hint tasks.
  producedByTool: z.string().optional(),
  autoSuggested: z.boolean().optional(),
  autoCloseHint: TaskAutoCloseHintSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
});

// Spec 036 source provenance for open questions. Default "untagged"
// for legacy records; new questions are expected to set source
// explicitly via the producing tool.
export const OpenQuestionSourceSchema = z.enum([
  "heuristic-phase1",
  "human-review",
  "runtime-observation",
  "static-analysis",
  "other",
  "untagged",
]);

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
  // Spec 036: provenance + auto-resolvable hint.
  source: OpenQuestionSourceSchema.default("untagged"),
  autoResolvable: z.boolean().optional(),
  autoResolveHint: z.string().optional(),
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

// Bug 17 (BUGREPORT): cart banks live at flattened offsets >= $10000
// (bank 0 = $0000-$1FFF, bank 8 = $10000-$11FFF, etc.). Widen the
// region/cell/entry start+end fields to accept up to $FFFFFF (1 MB)
// so multi-bank cart layouts pass schema validation. C64 main-CPU
// addresses are still naturally bounded to $FFFF; the wider range
// only matters for cart-internal offsets.
export const MemoryMapRegionSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  kind: z.string().min(1),
  start: z.number().int().min(0).max(0xffffff),
  end: z.number().int().min(0).max(0xffffff),
  bank: z.number().int().nonnegative().optional(),
  entityId: IdSchema.optional(),
  findingIds: z.array(IdSchema).default([]),
  status: z.string().min(1),
  confidence: ConfidenceSchema,
  summary: z.string().optional(),
  // Region lives exclusively on a medium (cart bank, disk track) and
  // has no runtime presence by default. UI hides these unless the
  // "show cart-window mapping" toggle is on.
  mediumOnly: z.boolean().default(false),
});

export const MemoryMapCellSchema = z.object({
  id: IdSchema,
  start: z.number().int().min(0).max(0xffffff),
  end: z.number().int().min(0).max(0xffffff),
  rowBase: z.number().int().min(0).max(0xffffff),
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
  origin: z.enum(["kernal", "custom"]).default("kernal"),
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
  color: z.string().optional(),
  packer: z.string().optional(),
  format: z.string().optional(),
  notes: z.array(z.string()).default([]),
  md5: z.string().optional(),
  first16: z.string().optional(),
  last16: z.string().optional(),
  kindGuess: z.string().optional(),
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
  category: z.enum(["free", "free_zero", "free_data", "orphan_allocated", "file", "directory", "bam", "unknown"]),
  color: z.string().optional(),
});

export const DiskLayoutDiskSchema = z.object({
  artifactId: IdSchema,
  title: z.string().min(1),
  format: z.string().min(1),
  diskName: z.string().optional(),
  diskId: z.string().optional(),
  // Filename on the host filesystem (e.g. "lykia_disk1.d64"). Preferred
  // for UI labels when multiple disks share the same BAM title.
  imageFileName: z.string().optional(),
  // Project-relative path to the raw disk image, when available. The UI
  // uses this to address /api/artifact/raw for sector-level hex views
  // and full-file extraction.
  imageRelativePath: z.string().optional(),
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
  slot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH", "EEPROM", "OTHER"]).optional(),
});

export const CartridgeBankViewSchema = z.object({
  bank: z.number().int().nonnegative(),
  file: z.string().optional(),
  slots: z.array(z.string()),
  romlChipIndex: z.number().int().nonnegative().optional(),
  romhChipIndex: z.number().int().nonnegative().optional(),
});

export const CartridgeLutRefSchema = z.object({
  lut: z.string().min(1),
  index: z.number().int().nonnegative(),
  destAddress: z.number().int().min(0).max(0xffff).optional(),
});

export const CartridgeLutChunkSpanSchema = z.object({
  bank: z.number().int().nonnegative(),
  offsetInBank: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
});

export const CartridgeLutChunkSchema = z.object({
  // Origin (first span) — flat fields kept for backwards compatibility.
  bank: z.number().int().nonnegative(),
  slot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH"]).default("ROML"),
  offsetInBank: z.number().int().nonnegative(),
  // Total file length, possibly spanning multiple banks. Use `spans[]`
  // for the per-bank physical placement.
  length: z.number().int().nonnegative(),
  // Primary (first) LUT reference — kept flat for backwards compatibility
  // with older snapshots + for the legend swatch.
  lut: z.string().min(1),
  index: z.number().int().nonnegative(),
  destAddress: z.number().int().min(0).max(0xffff).optional(),
  // All LUT entries pointing at this byte-range (same bank + offset +
  // length). Length 1 when only one LUT references the chunk.
  refs: z.array(CartridgeLutRefSchema).default([]),
  // Per-bank physical placement. Always at least one entry; multi-entry
  // arrays describe a file that spans bank boundaries.
  spans: z.array(CartridgeLutChunkSpanSchema).default([]),
  label: z.string().optional(),
  color: z.string().optional(),
  fileRelativePath: z.string().optional(),
  // Optional packer / format hints — populated when the manifest, an
  // analysis artifact, or an annotation tells us how the bytes are
  // encoded. Examples: packer="byteboozer2", format="prg" or "raw_lz".
  packer: z.string().optional(),
  format: z.string().optional(),
  // Free-form notes pulled from the same source. Can carry decoded
  // header info, depack target, or analyst commentary.
  notes: z.array(z.string()).default([]),
});

export const CartridgeSlotLayoutSchema = z.object({
  hardwareTypeName: z.string().optional(),
  slotsPerBank: z.number().int().min(1).max(2),
  bankSize: z.number().int().positive(),
  hasRomh: z.boolean(),
  hasEeprom: z.boolean(),
  isUltimax: z.boolean(),
  canFlash: z.boolean().default(false),
  bankCount: z.number().int().nonnegative(),
  totalRomBytes: z.number().int().nonnegative(),
  eeprom: z
    .object({
      kindHint: z.string().optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
      file: z.string().optional(),
    })
    .optional(),
});

export const CartridgeEmptyRegionSchema = z.object({
  bank: z.number().int().nonnegative(),
  slot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH"]).default("ROML"),
  offsetInBank: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
});

export const CartridgeSegmentSchema = z.object({
  bank: z.number().int().nonnegative(),
  slot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH"]).default("ROML"),
  offsetInBank: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  // Free-form classification: "startup", "cbm80-vector", "eapi", "code",
  // "data", "padding", "unknown". The view-builder fills the obvious
  // ones (CBM80 head, EF EAPI window). LLM annotations may refine.
  kind: z.string().min(1).default("unknown"),
  label: z.string().optional(),
  destAddress: z.number().int().min(0).max(0xffff).optional(),
});

export const CartridgeStartupInfoSchema = z.object({
  hasCbm80Signature: z.boolean(),
  startupBank: z.number().int().nonnegative().optional(),
  startupSlot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH"]).optional(),
  coldStartVector: z.number().int().min(0).max(0xffff).optional(),
  warmStartVector: z.number().int().min(0).max(0xffff).optional(),
  cbm80Tag: z.string().optional(),
  notes: z.array(z.string()).default([]),
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
  slotLayout: CartridgeSlotLayoutSchema.optional(),
  lutChunks: z.array(CartridgeLutChunkSchema).optional(),
  emptyRegions: z.array(CartridgeEmptyRegionSchema).optional(),
  segments: z.array(CartridgeSegmentSchema).optional(),
  startup: CartridgeStartupInfoSchema.optional(),
});

export const CartridgeLayoutViewSchema = z.object({
  id: IdSchema,
  kind: z.literal("cartridge-layout"),
  title: z.string().min(1),
  projectId: IdSchema,
  generatedAt: TimestampSchema,
  cartridges: z.array(CartridgeLayoutCartridgeSchema),
});

// ---------------------------------------------------------------------------
// MediumLayoutView — unified cart/disk abstraction.
//
// A medium has capacity X, a primary index (BAM+dir / cart-LUT), an optional
// secondary index (fastloader-LUT / breadcrumb chain), a boot entry, files,
// resident regions, and empty regions. Disk and cartridge differ only in
// the grid renderer + span shape; everything else maps 1:1.
//
// Phase-1 scope: schema + adapters. The existing DiskLayoutView /
// CartridgeLayoutView types stay untouched and remain the source of truth
// for the current UI panels — adapters convert each one into a normalised
// MediumLayout. Later phases collapse the two UI panels onto this view.
// ---------------------------------------------------------------------------

export const MediumKindSchema = z.enum(["disk", "cartridge"]);

export const MediumSpanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sector"),
    track: z.number().int().positive(),
    sector: z.number().int().nonnegative(),
    offsetInSector: z.number().int().nonnegative().default(0),
    length: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("slot"),
    bank: z.number().int().nonnegative(),
    slot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH", "EEPROM", "OTHER"]),
    offsetInBank: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
  }),
]);

export const MediumFileOriginSchema = z.enum([
  "kernal-dir",
  "custom-lut",
  "breadcrumb",
  "lut-chunk",
  "static",
  "unknown",
]);

export const MediumFileSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  color: z.string().optional(),
  origin: MediumFileOriginSchema.default("unknown"),
  spans: z.array(MediumSpanSchema).default([]),
  loadAddress: z.number().int().min(0).max(0xffff).optional(),
  length: z.number().int().nonnegative(),
  packer: z.string().optional(),
  format: z.string().optional(),
  notes: z.array(z.string()).default([]),
  // Free-form provenance / cross-ref labels surfaced by the adapter
  // (e.g. "lut:tracks", "lut:sprites"). Kept stringly typed so adapters
  // do not need to coordinate on a richer schema yet.
  sourceRefs: z.array(z.string()).default([]),
  // Pointer back to the originating record (disk file id, cart chunk
  // dedup key, …). Lets the UI round-trip from a MediumFile into the
  // existing per-medium inspectors.
  sourceId: z.string().optional(),
  fileRelativePath: z.string().optional(),
});

export const MediumResidentRoleSchema = z.enum([
  "dos",
  "loader",
  "eapi",
  "startup",
  "code",
  "data",
  "padding",
  "unknown",
]);

export const MediumResidentRegionSchema = z.object({
  id: IdSchema,
  role: MediumResidentRoleSchema.default("unknown"),
  label: z.string().optional(),
  spans: z.array(MediumSpanSchema).default([]),
  destAddress: z.number().int().min(0).max(0xffff).optional(),
});

export const MediumEmptyReasonSchema = z.enum([
  "free-bam",
  "flash-empty-ff",
  "unknown",
]);

export const MediumEmptyRegionSchema = z.object({
  id: IdSchema,
  reason: MediumEmptyReasonSchema.default("unknown"),
  spans: z.array(MediumSpanSchema).default([]),
});

export const MediumBootEntrySchema = z.object({
  pc: z.number().int().min(0).max(0xffff).optional(),
  // Cart: bank/slot of the cold-start vector. Disk: track/sector of the
  // boot block (typically 1/0) or the first dir entry.
  span: MediumSpanSchema.optional(),
  evidence: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});

export const MediumGridSectorRowSchema = z.object({
  track: z.number().int().positive(),
  sectorCount: z.number().int().positive(),
});

export const MediumGridBankRowSchema = z.object({
  bank: z.number().int().nonnegative(),
  romlChipIndex: z.number().int().nonnegative().optional(),
  romhChipIndex: z.number().int().nonnegative().optional(),
});

export const MediumGridSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sector-grid"),
    tracks: z.array(MediumGridSectorRowSchema),
    sectors: z.array(DiskLayoutSectorCellSchema),
  }),
  z.object({
    kind: z.literal("bank-grid"),
    banks: z.array(MediumGridBankRowSchema),
    slotLayout: CartridgeSlotLayoutSchema,
    chips: z.array(CartridgeChipViewSchema),
  }),
]);

export const MediumLayoutSchema = z.object({
  id: IdSchema,
  mediumKind: MediumKindSchema,
  mediumLabel: z.string().min(1),
  artifactId: IdSchema,
  capacityBytes: z.number().int().nonnegative(),
  blockSize: z.number().int().positive(),
  imageRelativePath: z.string().optional(),
  imageFileName: z.string().optional(),
  grid: MediumGridSchema,
  files: z.array(MediumFileSchema).default([]),
  resident: z.array(MediumResidentRegionSchema).default([]),
  empty: z.array(MediumEmptyRegionSchema).default([]),
  boot: MediumBootEntrySchema.optional(),
});

export const MediumLayoutViewSchema = z.object({
  id: IdSchema,
  kind: z.literal("medium-layout"),
  title: z.string().min(1),
  projectId: IdSchema,
  generatedAt: TimestampSchema,
  mediums: z.array(MediumLayoutSchema),
});

export const AnnotatedListingEntrySchema = z.object({
  id: IdSchema,
  start: z.number().int().min(0).max(0xffffff),
  end: z.number().int().min(0).max(0xffffff),
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
  workflowPlan: WorkflowPlanSchema.optional(),
  workflowState: WorkflowStateSchema.optional(),
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
    mediumLayout: MediumLayoutViewSchema.optional(),
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
export const ContainerEntryStoreSchema = createRecordListSchema(ContainerEntrySchema);
export const LoaderEntryPointStoreSchema = createRecordListSchema(LoaderEntryPointSchema);
export const LoaderEventStoreSchema = createRecordListSchema(LoaderEventSchema);
export const AntiPatternStoreSchema = createRecordListSchema(AntiPatternSchema);
export const PatchRecipeStoreSchema = createRecordListSchema(PatchRecipeSchema);
export const ResourceRegionStoreSchema = createRecordListSchema(ResourceRegionSchema);
export const OperationStoreSchema = createRecordListSchema(OperationSchema);
export const ConstraintRuleStoreSchema = createRecordListSchema(ConstraintRuleSchema);
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
export type PreferredAssembler = z.infer<typeof PreferredAssemblerSchema>;
export type WorkflowPhaseStatus = z.infer<typeof WorkflowPhaseStatusSchema>;
export type WorkflowArtifactExpectation = z.infer<typeof WorkflowArtifactExpectationSchema>;
export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>;
export type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;
export type WorkflowPhaseState = z.infer<typeof WorkflowPhaseStateSchema>;
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export type ArtifactVersionEntry = z.infer<typeof ArtifactVersionEntrySchema>;
export type ContainerEntry = z.infer<typeof ContainerEntrySchema>;
export type ContainerEntryStore = z.infer<typeof ContainerEntryStoreSchema>;
export type LoadContext = z.infer<typeof LoadContextSchema>;
export type LoaderEntryPoint = z.infer<typeof LoaderEntryPointSchema>;
export type LoaderEntryPointStore = z.infer<typeof LoaderEntryPointStoreSchema>;
export type LoaderEvent = z.infer<typeof LoaderEventSchema>;
export type LoaderEventStore = z.infer<typeof LoaderEventStoreSchema>;
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
export type AntiPattern = z.infer<typeof AntiPatternSchema>;
export type AntiPatternStore = z.infer<typeof AntiPatternStoreSchema>;
export type PatchRecipe = z.infer<typeof PatchRecipeSchema>;
export type PatchRecipeStore = z.infer<typeof PatchRecipeStoreSchema>;
export type ResourceRegion = z.infer<typeof ResourceRegionSchema>;
export type ResourceRegionStore = z.infer<typeof ResourceRegionStoreSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type OperationStore = z.infer<typeof OperationStoreSchema>;
export type ConstraintRule = z.infer<typeof ConstraintRuleSchema>;
export type ConstraintRuleStore = z.infer<typeof ConstraintRuleStoreSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactScope = z.infer<typeof ArtifactScopeSchema>;
export type EntityRecord = z.infer<typeof EntityRecordSchema>;
export type PayloadFormat = z.infer<typeof PayloadFormatSchema>;
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
export type MediumKind = z.infer<typeof MediumKindSchema>;
export type MediumSpan = z.infer<typeof MediumSpanSchema>;
export type MediumFileOrigin = z.infer<typeof MediumFileOriginSchema>;
export type MediumFile = z.infer<typeof MediumFileSchema>;
export type MediumResidentRole = z.infer<typeof MediumResidentRoleSchema>;
export type MediumResidentRegion = z.infer<typeof MediumResidentRegionSchema>;
export type MediumEmptyReason = z.infer<typeof MediumEmptyReasonSchema>;
export type MediumEmptyRegion = z.infer<typeof MediumEmptyRegionSchema>;
export type MediumBootEntry = z.infer<typeof MediumBootEntrySchema>;
export type MediumGrid = z.infer<typeof MediumGridSchema>;
export type MediumLayout = z.infer<typeof MediumLayoutSchema>;
export type MediumLayoutView = z.infer<typeof MediumLayoutViewSchema>;
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
