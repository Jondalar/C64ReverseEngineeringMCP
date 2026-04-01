import { hex16 } from "../lib/format";
import { AnalysisStats, CandidateRegion, MemoryMapping, Segment, SegmentCandidate, SegmentKind } from "./types";

export function clampConfidence(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function segmentLength(start: number, end: number): number {
  return end - start + 1;
}

export function toOffset(address: number, mapping: MemoryMapping): number | undefined {
  if (address < mapping.startAddress || address > mapping.endAddress) {
    return undefined;
  }
  return mapping.fileOffset + (address - mapping.startAddress);
}

export function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA <= endB && startB <= endA;
}

export function intersection(startA: number, endA: number, startB: number, endB: number): [number, number] | undefined {
  if (!overlaps(startA, endA, startB, endB)) {
    return undefined;
  }
  return [Math.max(startA, startB), Math.min(endA, endB)];
}

export function formatAddress(address: number): string {
  return `$${hex16(address).toUpperCase()}`;
}

export function makeUnknownSegment(start: number, end: number): Segment {
  return {
    kind: "unknown",
    start,
    end,
    length: segmentLength(start, end),
    score: {
      confidence: 0.15,
      reasons: ["No analyzer claimed this range strongly enough."],
    },
    analyzerIds: ["resolver"],
    xrefs: [],
  };
}

export function sortCandidates(candidates: SegmentCandidate[]): SegmentCandidate[] {
  return [...candidates].sort((left, right) => {
    if (right.score.confidence !== left.score.confidence) {
      return right.score.confidence - left.score.confidence;
    }
    if (segmentLength(right.start, right.end) !== segmentLength(left.start, left.end)) {
      return segmentLength(right.start, right.end) - segmentLength(left.start, left.end);
    }
    return left.start - right.start;
  });
}

export function createCoverageMap(mapping: MemoryMapping, segments: SegmentCandidate[]): boolean[] {
  const coverage = new Array<boolean>(mapping.fileSize).fill(false);
  for (const segment of segments) {
    const startOffset = toOffset(segment.start, mapping);
    const endOffset = toOffset(segment.end, mapping);
    if (startOffset === undefined || endOffset === undefined) {
      continue;
    }
    for (let index = startOffset; index <= endOffset; index += 1) {
      coverage[index] = true;
    }
  }
  return coverage;
}

export function findUnclaimedRegions(mapping: MemoryMapping, coverage: boolean[]): CandidateRegion[] {
  const regions: CandidateRegion[] = [];
  let runStart: number | undefined;

  for (let index = 0; index < coverage.length; index += 1) {
    if (!coverage[index] && runStart === undefined) {
      runStart = index;
    } else if (coverage[index] && runStart !== undefined) {
      regions.push({
        start: mapping.startAddress + runStart,
        end: mapping.startAddress + index - 1,
        source: "unclaimed",
      });
      runStart = undefined;
    }
  }

  if (runStart !== undefined) {
    regions.push({
      start: mapping.startAddress + runStart,
      end: mapping.endAddress,
      source: "unclaimed",
    });
  }

  return regions;
}

export function mergeSegments(segments: Segment[]): Segment[] {
  if (segments.length === 0) {
    return [];
  }

  const sorted = [...segments].sort((left, right) => left.start - right.start);
  const merged: Segment[] = [sorted[0]];

  for (const segment of sorted.slice(1)) {
    const previous = merged[merged.length - 1];
    if (previous.kind === segment.kind && previous.end + 1 === segment.start) {
      previous.end = segment.end;
      previous.length = segmentLength(previous.start, previous.end);
      previous.score.confidence = clampConfidence(Math.max(previous.score.confidence, segment.score.confidence));
      previous.score.reasons = Array.from(new Set([...previous.score.reasons, ...segment.score.reasons]));
      previous.score.alternatives = Array.from(
        new Map(
          [...(previous.score.alternatives ?? []), ...(segment.score.alternatives ?? [])].map((alternative) => [
            `${alternative.kind}:${alternative.confidence.toFixed(3)}:${alternative.reasons.join("|")}`,
            alternative,
          ]),
        ).values(),
      );
      previous.analyzerIds = Array.from(new Set([...previous.analyzerIds, ...segment.analyzerIds])).sort();
      previous.xrefs = [...previous.xrefs, ...segment.xrefs];
      previous.preview = previous.preview ?? segment.preview;
      previous.attributes = {
        ...(previous.attributes ?? {}),
        ...(segment.attributes ?? {}),
      };
      continue;
    }

    merged.push(segment);
  }

  return merged;
}

export function calculateStats(mapping: MemoryMapping, segments: Segment[]): AnalysisStats {
  let claimedBytes = 0;
  let codeBytes = 0;

  for (const segment of segments) {
    if (segment.kind !== "unknown") {
      claimedBytes += segment.length;
    }
    if (segment.kind === "code" || segment.kind === "basic_stub") {
      codeBytes += segment.length;
    }
  }

  return {
    totalBytes: mapping.fileSize,
    claimedBytes,
    unclaimedBytes: Math.max(0, mapping.fileSize - claimedBytes),
    codeBytes,
  };
}

export function kindPriority(kind: SegmentKind): number {
  switch (kind) {
    case "basic_stub":
      return 120;
    case "code":
      return 110;
    case "sid_driver":
      return 100;
    case "sid_related_code":
      return 95;
    case "pointer_table":
      return 90;
    case "bitmap_source":
      return 89;
    case "screen_source":
      return 88;
    case "color_source":
      return 87;
    case "charset_source":
      return 86;
    case "text":
    case "petscii_text":
    case "screen_code_text":
      return 80;
    case "sprite":
      return 70;
    case "charset":
      return 65;
    case "screen_ram":
      return 60;
    case "bitmap":
      return 61;
    case "hires_bitmap":
    case "multicolor_bitmap":
      return 62;
    case "lookup_table":
    case "music_data":
      return 50;
    case "state_variable":
      return 45;
    case "compressed_data":
      return 40;
    case "dead_code":
      return 35;
    case "padding":
      return 5;
    case "unknown":
      return 0;
    default:
      return 0;
  }
}
