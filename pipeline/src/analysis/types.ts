export type SegmentKind =
  | "basic_stub"
  // Spec 829 D6 — the tokenized BASIC V2 program itself, proven by walking its
  // line-record chain (D2). `basic_stub` KEEPS its meaning and the two never
  // collide: `basic_stub` marks the MACHINE CODE a BASIC SYS jumps into (see
  // makeCodeCandidate in code-discovery.ts — it keys off an entry point whose
  // source is `basic_sys`), so a `basic_stub` segment really is 6502 and every
  // "is this code?" site rightly says yes to it. A `basic` segment is the
  // token bytes, which are not 6502 at all — rendering them as instructions is
  // issue #11 — so those same sites must say no.
  | "basic"
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

// Spec 838 D3b — `graph` is an address the project graph already knows is code:
// a human `routine` node, a CALLS/JUMPS_TO edge from ANOTHER owner, or a Spec
// 826 RESOLVES_TO target. It is an entry point like any other, kept as its own
// source so the listing can name where the seed came from.
export type EntryPointSource = "prg_header" | "basic_sys" | "user" | "vector" | "heuristic" | "graph";

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
  /** Spec 838 D3b — the graph row this seed came from (`source === "graph"` only). */
  seedOrigin?: CodeSeedOrigin;
}

/** Spec 838 D3b — where a `graph` entry point came from. */
export type CodeSeedOrigin =
  /** a human-layer `routine` node this owner has at the address */
  | "human_routine"
  /** a CALLS edge from a DIFFERENT owner onto an ownerless `addr` node in this image */
  | "cross_owner_call"
  /** a JUMPS_TO edge from a DIFFERENT owner (jump table, rts-dispatch — Spec 826 D5) */
  | "cross_owner_jump"
  /** a Spec 826.0 RESOLVES_TO alias that points at a routine/label of THIS owner */
  | "resolved_alias";

/**
 * Spec 838 D3a — an entry point the scan did NOT seed, and why. The reported
 * symptom was that these vanish: an address inside an already-claimed extent is
 * dropped by the descent loop without a word, so the caller cannot tell a
 * redundant entry from one that was refused.
 */
export interface EntryPointRejection {
  address: number;
  source: EntryPointSource | "graph";
  reason:
    /** outside [startAddress, endAddress] of this image */
    | "out_of_range"
    /** already an instruction START reached from another seed — nothing was lost */
    | "already_code"
    /** lands strictly INSIDE an instruction another seed already decoded */
    | "inside_instruction"
    /** inside the tokenized BASIC program (Spec 829 D4.1) */
    | "inside_basic"
    /** the byte at the address is not a decodable opcode */
    | "undecodable"
    /** a graph seed the graph itself assigns to a different owner (Spec 826 RESOLVES_TO) */
    | "owned_by_other";
  detail: string;
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
  /** Spec 838 D3a — every entry point the descent refused, with the reason. */
  rejectedEntryPoints?: EntryPointRejection[];
  /**
   * Spec 838 D3a — bytes no decode owns because two seeds disagreed about the
   * instruction alignment: `address` is where a walk stopped, `blockedBy` the
   * instruction that already held the bytes, `blockerSeed` the seed it came from.
   */
  strandedByDecodeConflict?: Array<{ address: number; blockedBy: number; blockerSeed: number }>;
  /** Spec 838 D3c — instruction start → the seed address its walk descended from. */
  seedRoots?: Array<{ address: number; root: number }>;
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
  /**
   * Spec 816.2 — sprite data addresses recovered from the sprite pointers at
   * screenBase+$3F8. Reported because it is EVIDENCE: a reader should be able
   * to see which sprite classifications were anchored and which were guessed.
   */
  spriteDataAddresses: number[];
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

export interface PackerHint {
  format: string;
  confidence: number;
  offset: number;
  length: number;
  unpackedSize?: number;
  reason: string;
  notes?: string[];
}

// Spec 741 §3.2: a statically-detected relocation proposal — bytes stored at
// [fileStart..fileEnd] are copied to runtimeAddr by a copy loop and executed
// there. Surfaced via propose_annotations; accepted set feeds disasm_prg's
// relocations[] (same {fileStart,fileEnd,runtimeAddr} shape).
export interface RelocationProposal {
  fileStart: number;
  fileEnd: number;
  runtimeAddr: number;
  length: number;
  indexRegister: IndexedRegister;
  confidence: number;
  followedByJump: boolean;
  lengthCertain: boolean;
  source: "static-copy-loop";
  reasons: string[];
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
  packerHints?: PackerHint[];
  relocationProposals?: RelocationProposal[];
  /** Spec 838 D3a — entry points (user OR graph) the scan refused, and why. */
  rejectedEntryPoints?: EntryPointRejection[];
  /** Spec 838 D3a — bytes stranded because two seeds decoded the same range differently. */
  strandedByDecodeConflict?: Array<{ address: number; blockedBy: number; blockerSeed: number }>;
  /** Spec 838 D3b — what the graph contributed, and where it could not be read. */
  codeSeedReport?: CodeSeedReport;
}

/** Spec 838 D3b — the graph-seed pass, always stated: what it read, or why it did not. */
export interface CodeSeedReport {
  status: "ok" | "absent" | "disabled";
  owner: string;
  path?: string;
  /** why nothing was read (`absent`/`disabled`); undefined on `ok`. */
  reason?: string;
  seeds: Array<{ address: number; origin: CodeSeedOrigin; detail: string }>;
}

export interface AnalysisOptions {
  userEntryPoints?: number[];
  // Spec 047: when true, code-island demote uses 0.45 threshold
  // (more aggressive). Default false → conservative 0.3.
  demoteAggressive?: boolean;
  /** Spec 838 D3b — project directory holding knowledge/graph.sqlite; defaults to C64RE_PROJECT_DIR. */
  projectDir?: string;
  /** Spec 838 D3b — set to skip the graph-seed pass entirely (measurement / A-B). */
  noGraphSeeds?: boolean;
}

export interface SegmentAnalyzer {
  readonly id: string;
  analyze(context: AnalyzerContext): AnalyzerResult;
}
