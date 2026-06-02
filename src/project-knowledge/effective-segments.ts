// Spec 751 (BUG-034) — server-side effective-segments overlay.
//
// Faithful port of the pipeline's `buildEffectiveSegments`
// (`pipeline/src/lib/effective-segments.ts:72`, Spec 055 Phase A) so the MCP
// server (ESM build) can apply the SAME annotation→segment overlay the
// `disasm_prg` render pass uses — WITHOUT crossing the pipeline (CommonJS)
// build boundary. Before this, six server-side consumers read raw
// `_analysis.json` segments and a seventh (`resolve-pc`) re-implemented the
// overlay incorrectly (append-not-overlay), so annotation reclassifications
// were invisible outside the disasm (BUG-034).
//
// NON-DESTRUCTIVE: this only computes an in-memory effective view. It never
// writes back to `_analysis.json`. Annotation reclassifications stay durable
// as findings (Spec 055 `emitAnnotationFindings`); the byte-identical rebuild
// gate (`specs/720-disasm-output-quality.md:109`) is untouched.
//
// Algorithm (identical to Spec 055): sort overlays by start (later wins on
// overlap); walk the address space; per address resolve owner (annotation
// covers → annotation, else analysis segment, else gap); coalesce adjacent
// same-owner addresses. Cross-boundary annotation reshape is honoured.

import { existsSync, readFileSync } from "node:fs";

/** The minimal segment shape this overlay needs. Generic over T so each
 *  consumer keeps its own extra fields (score/xrefs/attributes/label …). */
export interface EffSegment {
  kind: string;
  start: number;
  end: number;
  length?: number;
  label?: string;
  comment?: string;
  [k: string]: unknown;
}

/** A segment reclassification from `_annotations.json` (addresses already
 *  parsed to numbers). */
export interface AnnotationSegmentOverlay {
  start: number;
  end: number;
  kind: string;
  label?: string;
  comment?: string;
}

interface OwnerHint {
  kind: string;
  source: "annotation" | "analysis";
  baseAnalysisIndex?: number;
  label?: string;
  comment?: string;
}

/** Parse a hex address that may carry a leading `$` (annotation files store
 *  hex strings, e.g. "09A9" or "$09A9"). */
export function parseHexAddr(hex: string): number {
  return parseInt(String(hex).replace(/^\$/, ""), 16);
}

/** Map raw `_annotations.json` segment entries (hex-string start/end) to
 *  numeric overlays. Tolerates already-numeric start/end. */
export function annotationSegmentsToOverlays(
  segments: ReadonlyArray<{ start: string | number; end: string | number; kind: string; label?: string; comment?: string }> | undefined,
): AnnotationSegmentOverlay[] {
  if (!segments || segments.length === 0) return [];
  const out: AnnotationSegmentOverlay[] = [];
  for (const s of segments) {
    const start = typeof s.start === "number" ? s.start : parseHexAddr(s.start);
    const end = typeof s.end === "number" ? s.end : parseHexAddr(s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out.push({ start, end, kind: s.kind, label: s.label, comment: s.comment });
  }
  return out;
}

/** Apply annotation segment overlays atop heuristic analysis segments,
 *  returning a sorted, non-overlapping effective segmentation. Faithful to
 *  Spec 055: annotation kinds win on overlap; later overlays override earlier;
 *  cross-boundary reshape honoured. Generic over T — analysis-owned runs clone
 *  the base segment (preserving score/xrefs/attributes); annotation-only runs
 *  are synthesized carrying the overlay's kind/label/comment. */
export function buildEffectiveSegments<T extends EffSegment>(
  analysisSegments: T[],
  annotationOverlays: AnnotationSegmentOverlay[] | undefined,
): T[] {
  if (!annotationOverlays || annotationOverlays.length === 0) {
    return analysisSegments;
  }

  const sortedAnnotations = [...annotationOverlays].sort((a, b) => a.start - b.start);

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

  function emit(out: T[], owner: OwnerHint, start: number, end: number): void {
    const base = owner.baseAnalysisIndex !== undefined ? analysisSegments[owner.baseAnalysisIndex] : undefined;
    if (base) {
      out.push({ ...base, kind: owner.kind, start, end, length: end - start + 1 });
    } else {
      // Annotation-only region (no underlying analysis segment). Synthesize a
      // minimal segment carrying the overlay's kind + label/comment so views
      // can surface the reclassification.
      out.push({
        kind: owner.kind,
        start,
        end,
        length: end - start + 1,
        ...(owner.label !== undefined ? { label: owner.label } : {}),
        ...(owner.comment !== undefined ? { comment: owner.comment } : {}),
      } as unknown as T);
    }
  }

  const result: T[] = [];
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
    if (runOwner) emit(result, runOwner, runStart, addr - 1);
    runStart = addr;
    runOwner = owner;
  }
  if (runOwner) emit(result, runOwner, runStart, hi);

  return result;
}

/** Read `_analysis.json` + its sibling `_annotations.json` and return the
 *  effective (overlaid) segmentation plus the overlays applied (for the
 *  "reclassified by annotation" hint, Spec 751 §3.2). `annotationsPath`
 *  defaults to the analysis path with `_analysis.json` → `_annotations.json`.
 *  Missing annotations → raw analysis segments (overlay is a no-op). Missing
 *  analysis → empty. */
export function loadEffectiveSegments(
  analysisPath: string,
  annotationsPath?: string,
): { segments: EffSegment[]; overlays: AnnotationSegmentOverlay[] } {
  let analysisSegments: EffSegment[] = [];
  if (existsSync(analysisPath)) {
    try {
      const report = JSON.parse(readFileSync(analysisPath, "utf8")) as { segments?: EffSegment[] };
      analysisSegments = Array.isArray(report?.segments) ? report.segments : [];
    } catch {
      analysisSegments = [];
    }
  }

  const annPath = annotationsPath ?? deriveAnnotationsPath(analysisPath);
  let overlays: AnnotationSegmentOverlay[] = [];
  if (annPath && existsSync(annPath)) {
    try {
      const ann = JSON.parse(readFileSync(annPath, "utf8")) as {
        segments?: Array<{ start: string | number; end: string | number; kind: string; label?: string; comment?: string }>;
      };
      overlays = annotationSegmentsToOverlays(ann?.segments);
    } catch {
      overlays = [];
    }
  }

  return { segments: buildEffectiveSegments(analysisSegments, overlays), overlays };
}

/** Sibling annotations path for an analysis path. */
export function deriveAnnotationsPath(analysisPath: string): string | undefined {
  if (analysisPath.endsWith("_analysis.json")) {
    return analysisPath.slice(0, -"_analysis.json".length) + "_annotations.json";
  }
  return undefined;
}

/** The annotation overlay (if any) whose range covers `addr` — later overlays
 *  win. Used to mark a segment as "reclassified by annotation" (Spec 751 §3.2)
 *  without mutating anything. */
export function overlayCovering(
  overlays: ReadonlyArray<AnnotationSegmentOverlay>,
  addr: number,
): AnnotationSegmentOverlay | undefined {
  let hit: AnnotationSegmentOverlay | undefined;
  for (const o of overlays) {
    if (o.start <= addr && addr <= o.end) hit = o; // later wins on overlap
  }
  return hit;
}
