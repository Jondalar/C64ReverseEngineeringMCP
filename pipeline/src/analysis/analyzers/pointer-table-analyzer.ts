import { AnalyzerContext, AnalyzerResult, CrossReference, SegmentCandidate } from "../types";
import { clampConfidence, formatAddress, segmentLength, toOffset } from "../utils";

export class PointerTableAnalyzer {
  readonly id = "pointer-table";

  analyze(context: AnalyzerContext): AnalyzerResult {
    const candidates: SegmentCandidate[] = [];
    const codeStarts = new Set(context.discoveredCode?.instructions.map((instruction) => instruction.address) ?? []);

    for (const region of context.candidateRegions) {
      const startOffset = toOffset(region.start, context.mapping);
      const endOffset = toOffset(region.end, context.mapping);
      if (startOffset === undefined || endOffset === undefined) {
        continue;
      }

      const regionLength = endOffset - startOffset + 1;
      if (regionLength < 8) {
        continue;
      }

      let cursor = startOffset;
      while (cursor + 7 <= endOffset) {
        const startCursor = cursor;
        const targets: number[] = [];
        const xrefs: CrossReference[] = [];

        while (cursor + 1 <= endOffset) {
          const target = context.buffer[cursor] | (context.buffer[cursor + 1] << 8);
          const inRange = target >= context.mapping.startAddress && target <= context.mapping.endAddress;
          if (!inRange) {
            break;
          }

          targets.push(target);
          xrefs.push({
            sourceAddress: context.mapping.startAddress + cursor,
            targetAddress: target,
            type: "pointer",
            operandText: formatAddress(target),
            confidence: 0.82,
          });
          cursor += 2;
        }

        if (targets.length >= 6) {
          const codeHitRatio = targets.filter((target) => codeStarts.has(target)).length / targets.length;
          const clustered = clusterScore(targets);
          const confidence = clampConfidence(0.4 + codeHitRatio * 0.3 + clustered * 0.22);
          if (confidence < 0.68 || codeHitRatio < 0.34) {
            cursor = Math.max(cursor + 2, startCursor + 2);
            continue;
          }
          const start = context.mapping.startAddress + startCursor;
          const end = context.mapping.startAddress + cursor - 1;

          candidates.push({
            analyzerId: this.id,
            kind: "pointer_table",
            start,
            end,
            score: {
              confidence,
              reasons: [
                `Detected ${targets.length} consecutive little-endian words inside mapped address space.`,
                `${Math.round(codeHitRatio * 100)}% of targets land on discovered code addresses.`,
                `Targets cluster with score ${clustered.toFixed(2)}, which is stronger than arbitrary numeric data.`,
              ],
              alternatives: [
                {
                  kind: "lookup_table",
                  confidence: clampConfidence(confidence - 0.16),
                  reasons: ["The region is structured, but not every target resolves to a proven code entry."],
                },
              ],
            },
            xrefs,
            attributes: {
              pointerCount: targets.length,
              targets: targets.slice(0, 16).map((target) => formatAddress(target)),
              length: segmentLength(start, end),
            },
          });
        }

        cursor = Math.max(cursor + 2, startCursor + 2);
      }
    }

    return {
      analyzerId: this.id,
      candidates,
    };
  }
}

function clusterScore(targets: number[]): number {
  if (targets.length < 2) {
    return 0;
  }

  let totalDistance = 0;
  for (let index = 1; index < targets.length; index += 1) {
    totalDistance += Math.abs(targets[index] - targets[index - 1]);
  }

  const averageDistance = totalDistance / (targets.length - 1);
  if (averageDistance <= 0x20) {
    return 1;
  }
  if (averageDistance <= 0x80) {
    return 0.8;
  }
  if (averageDistance <= 0x200) {
    return 0.55;
  }
  return 0.2;
}
