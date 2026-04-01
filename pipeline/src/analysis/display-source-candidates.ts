import { VicEvidence } from "./c64-hardware";
import {
  AnalyzerContext,
  AnalyzerResult,
  CodeSemantics,
  Segment,
  SegmentCandidate,
  SegmentKind,
} from "./types";
import { clampConfidence, formatAddress, segmentLength } from "./utils";

interface TargetRange {
  kind: SegmentKind;
  role: "bitmap" | "screen" | "color" | "charset";
  start: number;
  end: number;
}

interface SourcePair {
  sourceSetupAddress: number;
  destinationSetupAddress: number;
  end: number;
  sourceAddress: number;
  destinationAddress: number;
  sourcePointerBase: number;
  destinationPointerBase: number;
  helperRoutine?: number;
  target: TargetRange;
}

function buildTargetRanges(vic: VicEvidence): TargetRange[] {
  const ranges: TargetRange[] = [];

  for (const start of vic.bitmapAddresses) {
    ranges.push({
      kind: "bitmap_source",
      role: "bitmap",
      start,
      end: start + 0x1f3f,
    });
  }

  for (const start of vic.screenAddresses) {
    ranges.push({
      kind: "screen_source",
      role: "screen",
      start,
      end: start + 0x03e7,
    });
  }

  for (const start of vic.charsetAddresses) {
    ranges.push({
      kind: "charset_source",
      role: "charset",
      start,
      end: start + 0x07ff,
    });
  }

  ranges.push({
    kind: "color_source",
    role: "color",
    start: 0xd800,
    end: 0xdbe7,
  });

  return ranges.sort((left, right) => left.start - right.start);
}

function rangeForTarget(address: number, targets: TargetRange[]): TargetRange | undefined {
  return targets.find((target) => address >= target.start && address <= target.end);
}

function containsTarget(address: number, targets: TargetRange[]): boolean {
  return rangeForTarget(address, targets) !== undefined;
}

function roleFallbackSpan(kind: SegmentKind): number {
  switch (kind) {
    case "bitmap_source":
      return 0x07ff;
    case "charset_source":
      return 0x03ff;
    case "screen_source":
      return 0x01ff;
    case "color_source":
      return 0x00ff;
    default:
      return 0x00ff;
  }
}

function containingSegment(address: number, segments: Segment[]): Segment | undefined {
  return segments.find((segment) => segment.start <= address && segment.end >= address);
}

function dedupePairs(pairs: SourcePair[]): SourcePair[] {
  return Array.from(
    new Map(
      pairs.map((pair) => [
        `${pair.sourceAddress}:${pair.destinationAddress}:${pair.target.kind}`,
        pair,
      ]),
    ).values(),
  );
}

function deriveSourcePairs(
  semantics: CodeSemantics,
  targets: TargetRange[],
): SourcePair[] {
  if (semantics.displayTransfers.length > 0) {
    const pairs: SourcePair[] = [];
    for (const transfer of semantics.displayTransfers) {
      const target = rangeForTarget(transfer.destinationAddress, targets);
      if (!target) {
        continue;
      }
      pairs.push({
        sourceSetupAddress: transfer.start,
        destinationSetupAddress: transfer.destinationSetupAddress,
        end: transfer.end,
        sourceAddress: transfer.sourceAddress,
        destinationAddress: transfer.destinationAddress,
        sourcePointerBase: transfer.sourcePointerBase,
        destinationPointerBase: transfer.destinationPointerBase,
        helperRoutine: transfer.helperRoutine,
        target,
      });
    }
    return dedupePairs(pairs).sort((left, right) => left.sourceAddress - right.sourceAddress);
  }

  const confirmedPointers = semantics.indirectPointers.filter((fact) => fact.provenance === "confirmed_code" && fact.constantTarget !== undefined);
  const pairs: SourcePair[] = [];

  for (const destination of confirmedPointers) {
    const target = rangeForTarget(destination.constantTarget!, targets);
    if (!target) {
      continue;
    }

    const sources = confirmedPointers
      .filter((candidate) => {
        if (candidate === destination || candidate.constantTarget === undefined) {
          return false;
        }
        if (containsTarget(candidate.constantTarget, targets)) {
          return false;
        }
        return Math.abs(candidate.start - destination.start) <= 0x30;
      })
      .sort((left, right) => {
        const leftDelta = Math.abs(left.start - destination.start);
        const rightDelta = Math.abs(right.start - destination.start);
        if (leftDelta !== rightDelta) {
          return leftDelta - rightDelta;
        }
        return left.start - right.start;
      });

    const source = sources[0];
    if (!source) {
      continue;
    }

    pairs.push({
      sourceSetupAddress: source.start,
      destinationSetupAddress: destination.start,
      end: destination.end,
      sourceAddress: source.constantTarget!,
      destinationAddress: destination.constantTarget!,
      sourcePointerBase: source.zeroPageBase,
      destinationPointerBase: destination.zeroPageBase,
      target,
    });
  }

  return dedupePairs(pairs).sort((left, right) => left.sourceAddress - right.sourceAddress);
}

function resolveSourceEnd(
  pair: SourcePair,
  pairs: SourcePair[],
  segments: Segment[],
  mappingEnd: number,
): number {
  const start = pair.sourceAddress;
  const container = containingSegment(start, segments);
  const containerEnd = container?.end ?? mappingEnd;
  const nextStart = pairs
    .map((candidate) => candidate.sourceAddress)
    .filter((candidate) => candidate > start)
    .sort((left, right) => left - right)[0];

  if (nextStart !== undefined && nextStart - start <= 0x1000) {
    return Math.min(containerEnd, nextStart - 1);
  }

  return Math.min(containerEnd, start + roleFallbackSpan(pair.target.kind));
}

export function deriveDisplaySourceCandidates(
  context: AnalyzerContext,
  semantics: CodeSemantics,
  vic: VicEvidence,
  segments: Segment[],
): AnalyzerResult {
  const targets = buildTargetRanges(vic);
  const pairs = deriveSourcePairs(semantics, targets);
  const candidates: SegmentCandidate[] = [];

  for (const pair of pairs) {
    const start = pair.sourceAddress;
    const end = resolveSourceEnd(pair, pairs, segments, context.mapping.endAddress);
    if (end < start || start < context.mapping.startAddress || end > context.mapping.endAddress) {
      continue;
    }

    const confidence = clampConfidence(
      0.74 +
        (pair.target.kind === "bitmap_source" ? 0.08 : 0.04) +
        (pair.destinationPointerBase === ((pair.sourcePointerBase + 2) & 0xff) ? 0.04 : 0) +
        (pair.destinationSetupAddress - pair.sourceSetupAddress <= 0x10 ? 0.05 : 0),
    );

    const container = containingSegment(start, segments);
    candidates.push({
      analyzerId: "display-sources",
      kind: pair.target.kind,
      start,
      end,
      score: {
        confidence,
        reasons: [
          `Pointer setup at ${formatAddress(pair.sourceSetupAddress)} loads source ${formatAddress(start)} immediately next to destination setup ${formatAddress(pair.destinationSetupAddress)}.`,
          `Destination pointer resolves inside active ${pair.target.role} target ${formatAddress(pair.target.start)}-${formatAddress(pair.target.end)}.`,
          container
            ? `Initial pass currently classifies the source start inside ${container.kind}, so this provenance candidate intentionally overrides weak pattern-only classifications there.`
            : "Source start falls inside the mapped payload and is treated as a display-asset source candidate.",
          `Region is conservatively bounded to ${formatAddress(start)}-${formatAddress(end)} until stronger size evidence is available.`,
        ],
      },
      attributes: {
        role: pair.target.role,
        sourcePointerAddress: pair.sourceSetupAddress,
        destinationPointerAddress: pair.destinationSetupAddress,
        destinationTargetStart: pair.target.start,
        destinationTargetEnd: pair.target.end,
        zeroPageSourceBase: pair.sourcePointerBase,
        zeroPageDestinationBase: pair.destinationPointerBase,
        helperRoutine: pair.helperRoutine,
        initialContainerKind: container?.kind,
        initialContainerEnd: container?.end,
        pairedBy: pair.helperRoutine !== undefined ? "display transfer fact" : "adjacent constant pointer setup",
        length: segmentLength(start, end),
      },
    });
  }

  return {
    analyzerId: "display-sources",
    candidates,
    notes:
      candidates.length > 0
        ? [
            "Derived display-asset source regions from constant source/destination pointer setup pairs plus active VIC targets.",
          ]
        : ["No constant source/destination pointer pairs into active VIC targets were found."],
  };
}
