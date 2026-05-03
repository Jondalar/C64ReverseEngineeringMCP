// Spec 055 Phase A — effective-segments overlay.
//
// Replaces the contained-only buildAnnotatedSegments with an overlay
// that allows cross-boundary annotation reshape:
//
//   analysis: [$0800-$08FF code, $0900-$09FF unknown]
//   annotation: [$0800-$091F code "init"]
//
//   effective: [$0800-$091F code "init", $0920-$09FF unknown]
//
// Algorithm:
// 1. Sort annotations by start ascending. Later annotations win on overlap.
// 2. Walk the address space [min(analysis.starts) .. max(analysis.ends, annotation.ends)].
// 3. At each address, resolve owner: annotation if any annotation covers,
//    else analysis segment if any covers, else gap.
// 4. Coalesce adjacent same-owner addresses into merged segments.
//
// Output: sorted, non-overlapping segments. Annotation kinds win on overlap.
// Cross-boundary annotation extends past analysis are honoured.

import type { SegmentKind } from "../analysis/types";
import type { Segment } from "../analysis/types";

export interface AnnotationSegmentOverlay {
  start: number;
  end: number;
  kind: SegmentKind;
  label?: string;
  comment?: string;
}

interface OwnerHint {
  kind: SegmentKind;
  source: "annotation" | "analysis";
  baseAnalysisIndex?: number; // index into analysisSegments for cloning metadata
  label?: string;
  comment?: string;
}

function makeBaseSegment(
  base: Segment | undefined,
  start: number,
  end: number,
  kind: SegmentKind,
): Segment {
  if (base) {
    return {
      kind,
      start,
      end,
      length: end - start + 1,
      score: base.score,
      analyzerIds: [...base.analyzerIds],
      xrefs: [...base.xrefs],
      preview: undefined,
      attributes: base.attributes ? { ...base.attributes } : undefined,
    };
  }
  // Annotation-only region with no underlying analysis segment.
  // Synthesize a minimal segment carrying the annotation kind.
  return {
    kind,
    start,
    end,
    length: end - start + 1,
    score: { confidence: 1, reasons: ["annotation"] },
    analyzerIds: ["annotation"],
    xrefs: [],
  };
}

export function buildEffectiveSegments(
  analysisSegments: Segment[],
  annotationOverlays: AnnotationSegmentOverlay[] | undefined,
): Segment[] {
  if (!annotationOverlays || annotationOverlays.length === 0) {
    return analysisSegments;
  }

  // Sort annotations by start. Later entries win on overlap (rule 4).
  const sortedAnnotations = [...annotationOverlays].sort((a, b) => a.start - b.start);

  // Determine address-space bounds.
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const s of analysisSegments) {
    if (s.start < lo) lo = s.start;
    if (s.end > hi) hi = s.end;
  }
  for (const a of sortedAnnotations) {
    if (a.start < lo) lo = a.start;
    if (a.end > hi) hi = a.end;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) {
    return analysisSegments;
  }

  // Resolve owner per address. Annotation wins; among annotations the
  // last in sorted order containing the address wins (later overrides
  // earlier on overlap). Analysis fallback: which analysis segment
  // contains the address.
  function ownerAt(addr: number): OwnerHint | undefined {
    let annotationOwner: AnnotationSegmentOverlay | undefined;
    for (const a of sortedAnnotations) {
      if (a.start > addr) break;
      if (addr <= a.end) annotationOwner = a; // later wins
    }
    if (annotationOwner) {
      return {
        kind: annotationOwner.kind,
        source: "annotation",
        label: annotationOwner.label,
        comment: annotationOwner.comment,
      };
    }
    for (let i = 0; i < analysisSegments.length; i += 1) {
      const s = analysisSegments[i]!;
      if (s.start <= addr && addr <= s.end) {
        return { kind: s.kind, source: "analysis", baseAnalysisIndex: i };
      }
    }
    return undefined;
  }

  const result: Segment[] = [];
  let runStart = lo;
  let runOwner: OwnerHint | undefined = ownerAt(lo);

  for (let addr = lo + 1; addr <= hi; addr += 1) {
    const owner = ownerAt(addr);
    const sameRun =
      owner !== undefined
      && runOwner !== undefined
      && owner.kind === runOwner.kind
      && owner.source === runOwner.source
      && (owner.label ?? "") === (runOwner.label ?? "")
      && owner.baseAnalysisIndex === runOwner.baseAnalysisIndex;
    if (sameRun) continue;
    if (runOwner) {
      const baseAnalysis = runOwner.baseAnalysisIndex !== undefined
        ? analysisSegments[runOwner.baseAnalysisIndex]
        : undefined;
      result.push(makeBaseSegment(baseAnalysis, runStart, addr - 1, runOwner.kind));
    }
    runStart = addr;
    runOwner = owner;
  }
  if (runOwner) {
    const baseAnalysis = runOwner.baseAnalysisIndex !== undefined
      ? analysisSegments[runOwner.baseAnalysisIndex]
      : undefined;
    result.push(makeBaseSegment(baseAnalysis, runStart, hi, runOwner.kind));
  }

  return result;
}
