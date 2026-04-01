export type SegmentKind =
  | "basic_stub"
  | "code"
  | "text"
  | "screen_code_text"
  | "petscii_text"
  | "sprite"
  | "charset"
  | "charset_source"
  | "screen_ram"
  | "screen_source"
  | "bitmap"
  | "hires_bitmap"
  | "multicolor_bitmap"
  | "bitmap_source"
  | "color_source"
  | "sid_driver"
  | "music_data"
  | "sid_related_code"
  | "pointer_table"
  | "lookup_table"
  | "state_variable"
  | "compressed_data"
  | "dead_code"
  | "padding"
  | "unknown";

export type ReferenceType =
  | "entry"
  | "call"
  | "jump"
  | "branch"
  | "fallthrough"
  | "pointer"
  | "read"
  | "write";

export type EntryPointSource = "prg_header" | "basic_sys" | "user" | "vector" | "heuristic";

export type CandidateRegionSource = "whole_image" | "unclaimed" | "code_gap" | "user";

export type PreviewKind = "text" | "sprite" | "charset" | "bitmap";
export type CodeProvenance = "confirmed_code" | "probable_code";
export type IndexedRegister = "x" | "y";
export type RamAddressDomain =
  | "zero_page"
  | "stack_page"
  | "system_workspace"
  | "main_ram"
  | "high_ram";
export type RamAccessKind = "read" | "write" | "readwrite";
export type RamHypothesisKind =
  | "flag"
  | "counter"
  | "pointer_pair"
  | "pointer_target"
  | "table"
  | "state_block"
  | "buffer"
  | "timing_value"
  | "mode_flag"
  | "unknown";
export type DisplayRole = "bitmap" | "screen" | "color" | "charset" | "unknown";

export interface AlternativeHypothesis {
  kind: SegmentKind;
  confidence: number;
  reasons: string[];
}

export interface ClassificationScore {
  confidence: number;
  reasons: string[];
  alternatives?: AlternativeHypothesis[];
}

export interface PreviewFrame {
  kind: PreviewKind;
  title: string;
  width: number;
  height: number;
  encoding: "ascii";
  lines: string[];
}

export interface CrossReference {
  sourceAddress: number;
  targetAddress: number;
  type: ReferenceType;
  mnemonic?: string;
  operandText?: string;
  confidence: number;
  note?: string;
}

export interface SymbolInfo {
  address: number;
  name: string;
  source: "generated" | "user" | "imported";
  note?: string;
}

export interface EntryPoint {
  address: number;
  source: EntryPointSource;
  reason: string;
  symbol?: string;
}

export interface MemoryMapping {
  format: "prg" | "raw";
  loadAddress: number;
  startAddress: number;
  endAddress: number;
  fileOffset: number;
  fileSize: number;
}

export interface CandidateRegion {
  start: number;
  end: number;
  source: CandidateRegionSource;
  note?: string;
}

export interface InstructionFact {
  address: number;
  opcode: number;
  size: number;
  bytes: number[];
  mnemonic: string;
  addressingMode: string;
  operandText: string;
  operandValue?: number;
  targetAddress?: number;
  fallthroughAddress?: number;
  isKnownOpcode: boolean;
  isUndocumented: boolean;
  isControlFlow: boolean;
  provenance: CodeProvenance;
}

export interface BasicBlock {
  start: number;
  end: number;
  successors: number[];
}

export interface SegmentCandidate {
  analyzerId: string;
  kind: SegmentKind;
  start: number;
  end: number;
  score: ClassificationScore;
  xrefs?: CrossReference[];
  preview?: PreviewFrame[];
  attributes?: Record<string, unknown>;
}

export interface Segment {
  kind: SegmentKind;
  start: number;
  end: number;
  length: number;
  score: ClassificationScore;
  analyzerIds: string[];
  xrefs: CrossReference[];
  preview?: PreviewFrame[];
  attributes?: Record<string, unknown>;
}

export interface CodeAnalysis {
  entryPoints: EntryPoint[];
  instructions: InstructionFact[];
  basicBlocks: BasicBlock[];
  xrefs: CrossReference[];
  codeCandidates: SegmentCandidate[];
  unclaimedRegions: CandidateRegion[];
}

export interface ProbableCodeAnalysis {
  instructions: InstructionFact[];
  xrefs: CrossReference[];
  codeCandidates: SegmentCandidate[];
  notes: string[];
}

export interface AnalyzerContext {
  binaryName: string;
  buffer: Buffer;
  mapping: MemoryMapping;
  entryPoints: EntryPoint[];
  candidateRegions: CandidateRegion[];
  discoveredCode?: CodeAnalysis;
  probableCode?: ProbableCodeAnalysis;
  symbols: SymbolInfo[];
}

export interface AnalyzerResult {
  analyzerId: string;
  candidates: SegmentCandidate[];
  notes?: string[];
}

export interface HardwareWriteObservation {
  instructionAddress: number;
  registerAddress: number;
  inferredValue?: number;
  confidence: number;
  source: CodeProvenance;
  note: string;
}

export interface HardwareEvidence {
  vicWrites: HardwareWriteObservation[];
  sidWrites: HardwareWriteObservation[];
}

export interface TableUsageFact {
  start: number;
  end: number;
  instructionAddresses: number[];
  tableBases: number[];
  indexRegister: IndexedRegister;
  operation: "read" | "write" | "mixed";
  provenance: CodeProvenance;
  confidence: number;
  reasons: string[];
}

export interface CopyRoutineFact {
  start: number;
  end: number;
  loopBranchAddress: number;
  destinationBases: number[];
  sourceBases: number[];
  indexRegister: IndexedRegister;
  mode: "copy" | "fill";
  fillValue?: number;
  provenance: CodeProvenance;
  confidence: number;
  reasons: string[];
}

export interface IndirectPointerConstructionFact {
  start: number;
  end: number;
  zeroPageBase: number;
  provenance: CodeProvenance;
  confidence: number;
  constantTarget?: number;
  lowByteSource?: number;
  highByteSource?: number;
  reasons: string[];
}

export interface SplitPointerTableFact {
  start: number;
  end: number;
  lowTableBase: number;
  highTableBase: number;
  pointerBase: number;
  indexRegister: IndexedRegister;
  provenance: CodeProvenance;
  confidence: number;
  sampleTargets: number[];
  reasons: string[];
}

export interface RamAccessFact {
  address: number;
  domain: RamAddressDomain;
  access: RamAccessKind;
  directReads: number[];
  directWrites: number[];
  indexedReads: number[];
  indexedWrites: number[];
  indirectReads: number[];
  indirectWrites: number[];
  readModifyWrites: number[];
  immediateWriteValues: number[];
  provenances: CodeProvenance[];
  confidence: number;
  reasons: string[];
}

export interface RamHypothesis {
  start: number;
  end: number;
  kind: RamHypothesisKind;
  confidence: number;
  labelHint: string;
  relatedAddresses: number[];
  reasons: string[];
}

export interface DisplayStateFact {
  start: number;
  end: number;
  bankBase?: number;
  screenAddress?: number;
  charsetAddress?: number;
  bitmapAddress?: number;
  bitmapModeEnabled?: boolean;
  multicolorEnabled?: boolean;
  confidence: number;
  reasons: string[];
}

export interface DisplayTransferFact {
  start: number;
  end: number;
  destinationSetupAddress: number;
  sourceAddress: number;
  destinationAddress: number;
  sourcePointerBase: number;
  destinationPointerBase: number;
  helperRoutine?: number;
  helperCallAddress?: number;
  role: DisplayRole;
  confidence: number;
  reasons: string[];
}

export interface HardwareTargetedCopyFact {
  start: number;
  end: number;
  loopBranchAddress: number;
  sourceBases: number[];
  destinationBases: number[];
  indexRegister: IndexedRegister;
  mode: "copy" | "fill";
  fillValue?: number;
  destinationRole: "color_ram" | "screen_ram" | "sid" | "sprite_pointer" | "vic" | "other_hardware";
  sourceClassification: SegmentKind;
  provenance: CodeProvenance;
  confidence: number;
  reasons: string[];
}

export interface SidDataSourceFact {
  driverStart: number;
  driverEnd: number;
  dataSourceAddress: number;
  dataSourceEnd?: number;
  linkType: "indexed_read" | "indirect_read" | "pointer_setup" | "copy_loop";
  provenance: CodeProvenance;
  confidence: number;
  reasons: string[];
}

export interface CodeSemantics {
  tableUsages: TableUsageFact[];
  copyRoutines: CopyRoutineFact[];
  hardwareTargetedCopies: HardwareTargetedCopyFact[];
  sidDataSources: SidDataSourceFact[];
  indirectPointers: IndirectPointerConstructionFact[];
  splitPointerTables: SplitPointerTableFact[];
  displayStates: DisplayStateFact[];
  displayTransfers: DisplayTransferFact[];
  ramAccesses: RamAccessFact[];
  ramHypotheses: RamHypothesis[];
}

export type EvidenceNodeKind =
  | "routine"
  | "vic_configuration"
  | "memory_region"
  | "pointer_setup"
  | "copy_routine"
  | "split_pointer_table";

export type EvidenceEdgeKind =
  | "configures"
  | "points_to"
  | "reads_from"
  | "writes_to"
  | "supports"
  | "suggests";

export interface EvidenceNode {
  id: string;
  kind: EvidenceNodeKind;
  label: string;
  start?: number;
  end?: number;
  confidence: number;
  reasons: string[];
  attributes?: Record<string, unknown>;
}

export interface EvidenceEdge {
  from: string;
  to: string;
  kind: EvidenceEdgeKind;
  confidence: number;
  reasons: string[];
  attributes?: Record<string, unknown>;
}

export interface EvidenceGraph {
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
}

export interface AnalysisStats {
  totalBytes: number;
  claimedBytes: number;
  unclaimedBytes: number;
  codeBytes: number;
}

export interface AnalysisReport {
  binaryName: string;
  mapping: MemoryMapping;
  entryPoints: EntryPoint[];
  symbols: SymbolInfo[];
  hardwareEvidence?: HardwareEvidence;
  codeSemantics?: CodeSemantics;
  evidenceGraph?: EvidenceGraph;
  analyzerResults: AnalyzerResult[];
  segments: Segment[];
  codeAnalysis?: CodeAnalysis;
  probableCodeAnalysis?: ProbableCodeAnalysis;
  stats: AnalysisStats;
}

export interface AnalysisOptions {
  userEntryPoints?: number[];
}

export interface SegmentAnalyzer {
  readonly id: string;
  analyze(context: AnalyzerContext): AnalyzerResult;
}
