export interface ProjectMetadata {
  id: string;
  name: string;
  slug: string;
  description?: string;
  rootPath: string;
  status: string;
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
  artifactIds: string[];
  relatedEntityIds: string[];
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
  findingIds: string[];
  updatedAt: string;
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
  }>;
}

export interface DiskLayoutView {
  disks: Array<{
    artifactId: string;
    title: string;
    format: string;
    diskName?: string;
    diskId?: string;
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
