import { AnalyzerResult, ClassificationScore, Segment, SegmentCandidate } from "./types";
import { clampConfidence, intersection, kindPriority, makeUnknownSegment, mergeSegments, segmentLength } from "./utils";

function candidateStrength(candidate: SegmentCandidate): number {
  return candidate.score.confidence * 100 + kindPriority(candidate.kind);
}

function mergeReasons(primary: SegmentCandidate, competing: SegmentCandidate[]): ClassificationScore {
  const alternatives = competing.slice(0, 3).map((candidate) => ({
    kind: candidate.kind,
    confidence: candidate.score.confidence,
    reasons: candidate.score.reasons,
  }));

  return {
    confidence: clampConfidence(primary.score.confidence),
    reasons: primary.score.reasons,
    alternatives: alternatives.length > 0 ? alternatives : primary.score.alternatives,
  };
}

export function resolveSegments(startAddress: number, endAddress: number, analyzerResults: AnalyzerResult[]): Segment[] {
  const candidates = analyzerResults.flatMap((result) => result.candidates);
  const boundaries = new Set<number>([startAddress, endAddress + 1]);

  for (const candidate of candidates) {
    boundaries.add(candidate.start);
    boundaries.add(candidate.end + 1);
  }

  const sortedBoundaries = Array.from(boundaries)
    .filter((boundary) => boundary >= startAddress && boundary <= endAddress + 1)
    .sort((left, right) => left - right);

  const segments: Segment[] = [];

  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const sliceStart = sortedBoundaries[index];
    const sliceEnd = sortedBoundaries[index + 1] - 1;
    if (sliceStart > sliceEnd) {
      continue;
    }

    const covering = candidates.filter((candidate) => candidate.start <= sliceStart && candidate.end >= sliceEnd);
    if (covering.length === 0) {
      segments.push(makeUnknownSegment(sliceStart, sliceEnd));
      continue;
    }

    const sorted = [...covering].sort((left, right) => candidateStrength(right) - candidateStrength(left));
    const primary = sorted[0];
    const competing = sorted.slice(1);

    segments.push({
      kind: primary.kind,
      start: sliceStart,
      end: sliceEnd,
      length: segmentLength(sliceStart, sliceEnd),
      score: mergeReasons(primary, competing),
      analyzerIds: Array.from(new Set(covering.map((candidate) => candidate.analyzerId))).sort(),
      xrefs: covering.flatMap((candidate) =>
        (candidate.xrefs ?? []).filter((xref) => {
          const target = intersection(sliceStart, sliceEnd, xref.targetAddress, xref.targetAddress);
          return target !== undefined;
        }),
      ),
      preview: primary.preview,
      attributes: primary.attributes,
    });
  }

  return mergeSegments(segments);
}
