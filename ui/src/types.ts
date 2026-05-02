export interface ProjectMetadata {
  id: string;
  name: string;
  slug: string;
  description?: string;
  rootPath: string;
  status: string;
  preferredAssembler?: "kickass" | "64tass";
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCounts {
  artifacts: number;
  entities: number;
  findings: number;
  relations: number;
  flows: number;
  tasks: number;
  openQuestions: number;
  checkpoints: number;
}

export interface ArtifactRecord {
  id: string;
  kind: string;
  scope: string;
  title: string;
  relativePath: string;
  role?: string;
  status: string;
  confidence: number;
  updatedAt: string;
  // Spec 020 platform marker. Default c64 when absent.
  platform?: "c64" | "c1541" | "c128" | "vic20" | "plus4" | "other";
  // Spec 025 lineage fields. Surfaced in tabs for grouping later.
  derivedFrom?: string;
  lineageRoot?: string;
  versionLabel?: string;
  versionRank?: number;
}

export interface EntityRecord {
  id: string;
  kind: string;
  name: string;
  summary?: string;
  status: string;
  confidence: number;
  addressRange?: {
    start: number;
    end: number;
    bank?: number;
  };
  mediumSpans?: Array<
    | { kind: "sector"; track: number; sector: number; offsetInSector: number; length: number }
    | { kind: "slot"; bank: number; slot: "ROML" | "ROMH" | "ULTIMAX_ROMH" | "EEPROM" | "OTHER"; offsetInBank: number; length: number }
  >;
  mediumRole?: "dos" | "loader" | "eapi" | "startup" | "code" | "data" | "padding" | "unknown";
  payloadLoadAddress?: number;
  payloadFormat?: string;
  payloadPacker?: string;
  payloadSourceArtifactId?: string;
  payloadDepackedArtifactId?: string;
  payloadAsmArtifactIds?: string[];
  artifactIds: string[];
  relatedEntityIds: string[];
  tags?: string[];
  updatedAt: string;
}

export interface FindingRecord {
  id: string;
  kind: string;
  title: string;
  summary?: string;
  status: string;
  confidence: number;
  entityIds: string[];
  artifactIds: string[];
  updatedAt: string;
}

export interface RelationRecord {
  id: string;
  kind: string;
  title: string;
  sourceEntityId: string;
  targetEntityId: string;
  summary?: string;
  status: string;
  confidence: number;
  updatedAt: string;
}

export interface FlowRecord {
  id: string;
  kind: string;
  title: string;
  summary?: string;
  status: string;
  confidence: number;
  entityIds: string[];
  artifactIds: string[];
  nodes: Array<{
    id: string;
    kind: string;
    title: string;
    entityId?: string;
    artifactId?: string;
    addressRange?: { start: number; end: number; bank?: number; label?: string };
    status?: string;
    confidence?: number;
  }>;
  edges: Array<{
    id: string;
    kind: string;
    title: string;
    fromNodeId: string;
    toNodeId: string;
    summary?: string;
  }>;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  kind: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  confidence: number;
  entityIds: string[];
  updatedAt: string;
}

export interface OpenQuestionRecord {
  id: string;
  kind: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  confidence: number;
  entityIds: string[];
  artifactIds: string[];
  findingIds: string[];
  createdAt: string;
  updatedAt: string;
  answeredByFindingId?: string;
  answerSummary?: string;
}

export interface TimelineEvent {
  id: string;
  kind: string;
  title: string;
  summary?: string;
  createdAt: string;
}

export interface ProjectDashboardView {
  overview: Array<{ id: string; title: string; body: string }>;
  keyDocuments: Array<{ id: string; kind: string; title: string; status: string; confidence?: number; summary?: string; updatedAt: string }>;
  title: string;
  metrics: Array<{ id: string; title: string; value: string; emphasis: string }>;
  recentArtifacts: Array<{ id: string; kind: string; title: string; status: string; confidence?: number; summary?: string; updatedAt: string }>;
  activeFindings: Array<{ id: string; kind: string; title: string; status: string; confidence?: number; summary?: string; updatedAt: string }>;
  openTasks: Array<{ id: string; kind: string; title: string; status: string; confidence?: number; summary?: string; updatedAt: string }>;
  openQuestions: Array<{ id: string; kind: string; title: string; status: string; confidence?: number; summary?: string; updatedAt: string }>;
  recentTimeline: TimelineEvent[];
}

export interface MemoryMapView {
  cellSize: number;
  rowStride: number;
  cells: Array<{
    id: string;
    start: number;
    end: number;
    rowBase: number;
    columnOffset: number;
    category: "free" | "code" | "data" | "system" | "other";
    dominantKind: string;
    dominantTitle: string;
    occupancy: number;
    regionIds: string[];
    entityIds: string[];
    dominantEntityId?: string;
    status: string;
    confidence: number;
  }>;
  highlights: Array<{
    id: string;
    title: string;
    kind: "free-space" | "code-block" | "data-block" | "mapped-block";
    start: number;
    end: number;
    sizeBytes: number;
    entityId?: string;
    summary?: string;
  }>;
  regions: Array<{
    id: string;
    title: string;
    kind: string;
    start: number;
    end: number;
    bank?: number;
    entityId?: string;
    findingIds: string[];
    status: string;
    confidence: number;
    summary?: string;
    mediumOnly?: boolean;
  }>;
}

export interface DiskLayoutView {
  disks: Array<{
    artifactId: string;
    title: string;
    format: string;
    diskName?: string;
    diskId?: string;
    imageFileName?: string;
    imageRelativePath?: string;
    trackCount: number;
    fileCount: number;
    sectors: Array<{
      id: string;
      track: number;
      sector: number;
      angleStart: number;
      angleEnd: number;
      fileId?: string;
      fileTitle?: string;
      occupied: boolean;
      category: "free" | "free_zero" | "free_data" | "orphan_allocated" | "file" | "directory" | "bam" | "unknown";
      color?: string;
    }>;
    files: Array<{
      id: string;
      title: string;
      type: string;
      origin?: "kernal" | "custom";
      sizeSectors?: number;
      sizeBytes?: number;
      track?: number;
      sector?: number;
      loadAddress?: number;
      relativePath?: string;
      entityId?: string;
      sectorChain: Array<{
        index: number;
        track: number;
        sector: number;
        nextTrack: number;
        nextSector: number;
        bytesUsed: number;
        isLast: boolean;
      }>;
      loadType: "kernal" | "custom-loader" | "unknown";
      loaderHint?: string;
      loaderSource?: string;
      color?: string;
      packer?: string;
      format?: string;
      notes?: string[];
      md5?: string;
      first16?: string;
      last16?: string;
      kindGuess?: string;
    }>;
  }>;
}

export interface CartridgeChipView {
  bank: number;
  loadAddress: number;
  size: number;
  file?: string;
  slot?: "ROML" | "ROMH" | "ULTIMAX_ROMH" | "EEPROM" | "OTHER";
}

export interface CartridgeBankView {
  bank: number;
  file?: string;
  slots: string[];
  romlChipIndex?: number;
  romhChipIndex?: number;
}

export interface CartridgeSlotLayout {
  hardwareTypeName?: string;
  slotsPerBank: 1 | 2;
  bankSize: number;
  hasRomh: boolean;
  hasEeprom: boolean;
  isUltimax: boolean;
  canFlash?: boolean;
  bankCount: number;
  totalRomBytes: number;
  eeprom?: { kindHint?: string; sizeBytes?: number; file?: string };
}

export interface CartridgeEmptyRegion {
  bank: number;
  slot: "ROML" | "ROMH" | "ULTIMAX_ROMH";
  offsetInBank: number;
  length: number;
}

export interface CartridgeSegment {
  bank: number;
  slot: "ROML" | "ROMH" | "ULTIMAX_ROMH";
  offsetInBank: number;
  length: number;
  kind: string;
  label?: string;
  destAddress?: number;
}

export interface CartridgeStartupInfo {
  hasCbm80Signature: boolean;
  startupBank?: number;
  startupSlot?: "ROML" | "ROMH" | "ULTIMAX_ROMH";
  coldStartVector?: number;
  warmStartVector?: number;
  cbm80Tag?: string;
  notes?: string[];
}

export interface CartridgeLutRef {
  lut: string;
  index: number;
  destAddress?: number;
}

export interface CartridgeLutChunkSpan {
  bank: number;
  offsetInBank: number;
  length: number;
}

export interface CartridgeLutChunk {
  bank: number;
  slot: "ROML" | "ROMH" | "ULTIMAX_ROMH";
  offsetInBank: number;
  length: number;
  lut: string;
  index: number;
  destAddress?: number;
  refs?: CartridgeLutRef[];
  spans?: CartridgeLutChunkSpan[];
  label?: string;
  color?: string;
  fileRelativePath?: string;
  packer?: string;
  format?: string;
  notes?: string[];
}

export interface CartridgeLayoutView {
  cartridges: Array<{
    artifactId: string;
    title: string;
    cartridgeName?: string;
    hardwareType?: number;
    exrom?: number;
    game?: number;
    chips: CartridgeChipView[];
    banks: CartridgeBankView[];
    slotLayout?: CartridgeSlotLayout;
    lutChunks?: CartridgeLutChunk[];
    emptyRegions?: CartridgeEmptyRegion[];
    segments?: CartridgeSegment[];
    startup?: CartridgeStartupInfo;
  }>;
}

export interface AnnotatedListingView {
  entries: Array<{
    id: string;
    start: number;
    end: number;
    title: string;
    kind: string;
    entityId?: string;
    findingIds: string[];
    comment?: string;
    confidence: number;
    status: string;
  }>;
}

export interface FlowGraphView {
  nodes: Array<{
    id: string;
    kind: string;
    title: string;
    entityId?: string;
    summary?: string;
    status: string;
    confidence: number;
  }>;
  edges: Array<{
    id: string;
    kind: string;
    title: string;
    from: string;
    to: string;
    relationId?: string;
    summary?: string;
    status: string;
    confidence: number;
  }>;
  modes?: {
    structure: {
      id: "structure";
      title: string;
      summary?: string;
      nodes: FlowGraphView["nodes"];
      edges: FlowGraphView["edges"];
    };
    load: {
      id: "load";
      title: string;
      summary?: string;
      nodes: FlowGraphView["nodes"];
      edges: FlowGraphView["edges"];
    };
    runtime: {
      id: "runtime";
      title: string;
      summary?: string;
      nodes: FlowGraphView["nodes"];
      edges: FlowGraphView["edges"];
    };
  };
}

export interface LoadSequenceView {
  items: Array<{
    id: string;
    key: string;
    order: number;
    title: string;
    shortName: string;
    role: string;
    purposeSummary?: string;
    status: string;
    confidence: number;
    primaryEntityId?: string;
    entityIds: string[];
    artifactIds: string[];
    artifactLabels: string[];
    entryAddresses: number[];
    targetRanges: Array<{
      start: number;
      end: number;
      bank?: number;
      label?: string;
    }>;
    sourceKinds: string[];
    evidenceHints: string[];
  }>;
  edges: Array<{
    id: string;
    kind: string;
    title: string;
    fromItemId: string;
    toItemId: string;
    summary?: string;
    confidence: number;
    evidenceHints: string[];
  }>;
}

export interface WorkspaceUiSnapshot {
  generatedAt: string;
  project: ProjectMetadata;
  counts: ProjectCounts;
  recentTimeline: TimelineEvent[];
  artifacts: ArtifactRecord[];
  entities: EntityRecord[];
  findings: FindingRecord[];
  relations: RelationRecord[];
  flows: FlowRecord[];
  tasks: TaskRecord[];
  openQuestions: OpenQuestionRecord[];
  checkpoints: Array<{ id: string; title: string; summary?: string; createdAt: string }>;
  views: {
    projectDashboard: ProjectDashboardView;
    memoryMap: MemoryMapView;
    diskLayout: DiskLayoutView;
    cartridgeLayout: CartridgeLayoutView;
    annotatedListing: AnnotatedListingView;
    loadSequence: LoadSequenceView;
    flowGraph: FlowGraphView;
  };
}

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
  };
}

export interface AuditCachedResponse {
  audit: ProjectAuditResult;
  cacheStatus: "fresh" | "cached";
  cachedAt?: string;
}

export type ProjectRepairOperation =
  | "merge-fragments"
  | "register-artifacts"
  | "import-analysis"
  | "import-manifest"
  | "build-views";

export interface ProjectRepairResponse {
  root: string;
  mode: "dry-run" | "safe";
  operations: ProjectRepairOperation[];
  planned: string[];
  executed: string[];
  skipped: string[];
  filesChanged: string[];
  before: ProjectAuditResult;
  after?: ProjectAuditResult;
}

export interface PrgReverseWorkflowPhase {
  phase: string;
  status: "done" | "skipped" | "blocked";
  output?: string;
  artifact?: string;
  reason?: string;
  log?: string;
}

export interface PrgReverseWorkflowResponse {
  projectRoot: string;
  prgPath: string;
  mode: "quick" | "full";
  startedAt: string;
  status: "done" | "incomplete" | "blocked";
  phases: PrgReverseWorkflowPhase[];
  importedCounts: {
    entities: number;
    findings: number;
    relations: number;
    flows: number;
    openQuestions: number;
  };
  artifactsWritten: string[];
  viewsBuilt: string[];
  nextRequiredAction: string;
  analysisPath: string;
  asmPath: string;
  tassPath: string;
  ramReportPath?: string;
  pointerReportPath?: string;
}

