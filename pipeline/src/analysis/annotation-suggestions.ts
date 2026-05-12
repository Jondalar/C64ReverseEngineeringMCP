// Spec 249 — Annotation suggestion engine.
//
// Takes static analysis output + runtime trace events + optional
// fingerprint match results and emits typed annotation suggestions
// with 2-tier confidence routing (OQ1):
//
//   >= 0.9  → auto-write (returned in `autoWrite` bucket)
//   0.5-0.9 → open question (returned in `openQuestions` bucket)
//   < 0.5   → log-only (returned in `logOnly` bucket)
//
// No I/O.  The caller writes the auto bucket to
// <artifact>_annotations.json and the OQ bucket to the project store.

import type { AnnotationsFile, LabelAnnotation, RoutineAnnotation, SegmentAnnotation } from "../lib/annotations.js";
import type { DiscoveredTable } from "./runtime-tables.js";
import { tableKindToSegmentKind } from "./runtime-tables.js";

// ---- Public types -------------------------------------------------------

export interface FingerprintMatch {
  /** Start address of matched routine */
  address: number;
  /** Human-readable library / routine name */
  libraryName: string;
  /** Confidence of the fingerprint match (0..1) */
  confidence: number;
  /** Short description of what the routine does */
  description?: string;
}

/** A single annotation suggestion with provenance. */
export interface AnnotationSuggestion {
  kind: "label" | "segment" | "routine";
  confidence: number;
  trigger: SuggestionTrigger;
  annotation: LabelAnnotation | SegmentAnnotation | RoutineAnnotation;
}

export type SuggestionTrigger =
  | "fingerprint_match"
  | "indirect_jmp_target"
  | "pointer_table_scan"
  | "read_only_region"
  | "runtime_table_discovery"
  | "monotonic_indexed_access";

export interface SuggestionResult {
  /** High-confidence: auto-write to draft annotations file */
  autoWrite: AnnotationSuggestion[];
  /** Mid-confidence: emit as OpenQuestion for review */
  openQuestions: AnnotationSuggestion[];
  /** Low-confidence: logged only, not surfaced */
  logOnly: AnnotationSuggestion[];
}

// ---- Threshold configuration --------------------------------------------

const THRESHOLDS: Record<SuggestionTrigger, { auto: number; oq: number }> = {
  fingerprint_match:       { auto: 0.95, oq: 0.60 },
  indirect_jmp_target:     { auto: 0.90, oq: 0.50 },
  pointer_table_scan:      { auto: 0.85, oq: 0.50 },
  read_only_region:        { auto: 0.90, oq: 0.50 },
  runtime_table_discovery: { auto: 0.80, oq: 0.50 },
  monotonic_indexed_access:{ auto: 0.85, oq: 0.50 },
};

// ---- Helpers ------------------------------------------------------------

function toHex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

function autoLabel(kind: "table" | "routine" | "label", addr: number): string {
  return `_auto_${kind}_${toHex4(addr)}`;
}

function route(
  suggestion: AnnotationSuggestion,
  result: SuggestionResult,
  groundTruthLabels: Set<number>,
): void {
  // Ground-truth guard: skip if a human label already exists at this address
  const addr = addrOfSuggestion(suggestion);
  if (addr !== undefined && groundTruthLabels.has(addr)) return;

  const { auto, oq } = THRESHOLDS[suggestion.trigger];
  if (suggestion.confidence >= auto) {
    result.autoWrite.push(suggestion);
  } else if (suggestion.confidence >= oq) {
    result.openQuestions.push(suggestion);
  } else {
    result.logOnly.push(suggestion);
  }
}

function addrOfSuggestion(s: AnnotationSuggestion): number | undefined {
  if (s.kind === "label") return parseInt((s.annotation as LabelAnnotation).address, 16);
  if (s.kind === "routine") return parseInt((s.annotation as RoutineAnnotation).address, 16);
  if (s.kind === "segment") return parseInt((s.annotation as SegmentAnnotation).start, 16);
  return undefined;
}

// ---- Trigger handlers ---------------------------------------------------

function fromFingerprintMatches(
  matches: FingerprintMatch[],
  groundTruth: Set<number>,
  result: SuggestionResult,
): void {
  for (const m of matches) {
    const ann: RoutineAnnotation = {
      address: toHex4(m.address),
      name: autoLabel("routine", m.address),
      comment: m.description
        ? `[auto] Fingerprint match: ${m.libraryName}. ${m.description}`
        : `[auto] Fingerprint match: ${m.libraryName}`,
    };
    route({ kind: "routine", confidence: m.confidence, trigger: "fingerprint_match", annotation: ann }, result, groundTruth);
  }
}

function fromRuntimeTables(
  tables: DiscoveredTable[],
  groundTruth: Set<number>,
  result: SuggestionResult,
): void {
  for (const tbl of tables) {
    const [start, end] = tbl.range;

    // Label suggestion for the table start
    const labelAnn: LabelAnnotation = {
      address: toHex4(start),
      label: autoLabel("table", start),
      comment: `[auto] ${tbl.candidateKind} discovered at $${toHex4(start)}-$${toHex4(end)}, ${tbl.entries} entries, stride=${tbl.stride}`,
    };

    // Segment suggestion
    const segAnn: SegmentAnnotation = {
      start: toHex4(start),
      end: toHex4(end),
      kind: tableKindToSegmentKind(tbl.candidateKind),
      label: autoLabel("table", start),
      comment: `[auto] Runtime-discovered ${tbl.candidateKind}`,
    };

    // Confidence based on access count and Y-span evidence
    const accessScore = Math.min(1, tbl.evidence.accessCount / 50);
    const baseConfidence = tbl.candidateKind === "jump_table" ? 0.82 :
                           tbl.candidateKind === "pointer_table" ? 0.78 :
                           tbl.candidateKind === "sprite_pointers" ? 0.75 : 0.65;
    const confidence = Math.min(0.97, baseConfidence + accessScore * 0.15);

    route({ kind: "label", confidence, trigger: "runtime_table_discovery", annotation: labelAnn }, result, groundTruth);
    route({ kind: "segment", confidence, trigger: "runtime_table_discovery", annotation: segAnn }, result, groundTruth);
  }
}

// Lightweight read-only region detector: checks if an address range
// shows only reads (no writes) in the trace events.
export interface MemAccessSummary {
  addr: number;
  hasRead: boolean;
  hasWrite: boolean;
}

function fromReadOnlyRegions(
  accessSummaries: MemAccessSummary[],
  groundTruth: Set<number>,
  result: SuggestionResult,
): void {
  // Group contiguous read-only addresses into candidate regions
  const readOnly = accessSummaries.filter((a) => a.hasRead && !a.hasWrite).map((a) => a.addr).sort((a, b) => a - b);
  if (readOnly.length < 4) return;

  let clusterStart = readOnly[0];
  let prev = readOnly[0];

  const flush = (start: number, end: number) => {
    if (end - start < 3) return;
    const ann: SegmentAnnotation = {
      start: toHex4(start),
      end: toHex4(end),
      kind: "unknown",
      comment: `[auto] Read-only region $${toHex4(start)}-$${toHex4(end)} (no writes observed in trace)`,
    };
    route({ kind: "segment", confidence: 0.70, trigger: "read_only_region", annotation: ann }, result, groundTruth);
  };

  for (let i = 1; i < readOnly.length; i++) {
    if (readOnly[i] - prev > 4) {
      flush(clusterStart, prev);
      clusterStart = readOnly[i];
    }
    prev = readOnly[i];
  }
  flush(clusterStart, prev);
}

// ---- Main entry point ---------------------------------------------------

export interface SuggestionInput {
  artifactId: string;
  /** Labels already present in the ground-truth .asm file */
  groundTruthLabels?: Set<number>;
  /** Fingerprint matches from Spec 247 */
  fingerprintMatches?: FingerprintMatch[];
  /** Runtime-discovered tables from runtime-tables.ts */
  discoveredTables?: DiscoveredTable[];
  /** Per-address access summaries for read-only detection */
  accessSummaries?: MemAccessSummary[];
  /** Existing annotation file (to avoid re-suggesting known annotations) */
  existingAnnotations?: AnnotationsFile;
}

/**
 * Generate annotation suggestions from all available evidence sources.
 * Returns a bucketed result: autoWrite / openQuestions / logOnly.
 */
export function generateAnnotationSuggestions(input: SuggestionInput): SuggestionResult {
  const result: SuggestionResult = { autoWrite: [], openQuestions: [], logOnly: [] };

  // Build ground-truth address set (from .asm parse + existing annotations)
  const groundTruth = new Set<number>(input.groundTruthLabels ?? []);
  if (input.existingAnnotations) {
    for (const lbl of input.existingAnnotations.labels) {
      groundTruth.add(parseInt(lbl.address, 16));
    }
    for (const rt of input.existingAnnotations.routines) {
      groundTruth.add(parseInt(rt.address, 16));
    }
  }

  // Fingerprint matches → RoutineAnnotation suggestions
  if (input.fingerprintMatches?.length) {
    fromFingerprintMatches(input.fingerprintMatches, groundTruth, result);
  }

  // Runtime-discovered tables → Label + Segment suggestions
  if (input.discoveredTables?.length) {
    fromRuntimeTables(input.discoveredTables, groundTruth, result);
  }

  // Read-only regions → Segment suggestions
  if (input.accessSummaries?.length) {
    fromReadOnlyRegions(input.accessSummaries, groundTruth, result);
  }

  return result;
}

/**
 * Merge autoWrite suggestions into an existing (possibly empty) AnnotationsFile.
 * Returns a new file object; does not mutate the input.
 */
export function mergeAutoWriteSuggestions(
  base: AnnotationsFile,
  suggestions: AnnotationSuggestion[],
): AnnotationsFile {
  const labels = [...base.labels];
  const routines = [...base.routines];
  const segments = [...base.segments];

  for (const s of suggestions) {
    if (s.kind === "label") {
      const ann = s.annotation as LabelAnnotation;
      if (!labels.some((l) => l.address === ann.address)) labels.push(ann);
    } else if (s.kind === "routine") {
      const ann = s.annotation as RoutineAnnotation;
      if (!routines.some((r) => r.address === ann.address)) routines.push(ann);
    } else if (s.kind === "segment") {
      const ann = s.annotation as SegmentAnnotation;
      if (!segments.some((s2) => s2.start === ann.start && s2.end === ann.end)) segments.push(ann);
    }
  }

  return { ...base, labels, routines, segments };
}
