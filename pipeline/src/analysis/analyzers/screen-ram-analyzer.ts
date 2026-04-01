import { extractVicEvidence } from "../c64-hardware";
import { AnalyzerContext, AnalyzerResult, SegmentCandidate } from "../types";
import { clampConfidence, formatAddress, segmentLength, toOffset } from "../utils";

function isScreenLikeByte(byte: number): boolean {
  return byte <= 0x3f || (byte >= 0x60 && byte <= 0x7f) || byte === 0xa0;
}

export class ScreenRamAnalyzer {
  readonly id = "screen-ram";

  analyze(context: AnalyzerContext): AnalyzerResult {
    const vic = extractVicEvidence(context);
    const candidates: SegmentCandidate[] = [];

    for (const region of context.candidateRegions) {
      const startOffset = toOffset(region.start, context.mapping);
      const endOffset = toOffset(region.end, context.mapping);
      if (startOffset === undefined || endOffset === undefined) {
        continue;
      }

      const regionLength = endOffset - startOffset + 1;
      if (regionLength < 1000) {
        continue;
      }

      const candidateOffsets = new Set<number>();
      for (const address of vic.screenAddresses) {
        const offset = address - context.mapping.startAddress;
        if (offset >= startOffset && offset + 999 <= endOffset) {
          candidateOffsets.add(offset);
        }
      }

      if (candidateOffsets.size === 0) {
        for (let offset = startOffset; offset + 999 <= endOffset; offset += 0x400) {
          candidateOffsets.add(offset);
        }
      }

      for (const offset of Array.from(candidateOffsets).sort((left, right) => left - right)) {
        const block = context.buffer.subarray(offset, offset + 1000);
        const printableRatio = Array.from(block).filter(isScreenLikeByte).length / block.length;
        const startAddress = context.mapping.startAddress + offset;
        const endAddress = startAddress + 999;
        const vicBonus = vic.screenAddresses.includes(startAddress) ? 0.18 : 0;
        const confidence = clampConfidence(0.3 + printableRatio * 0.42 + vicBonus);
        if (confidence < 0.78) {
          continue;
        }

        candidates.push({
          analyzerId: this.id,
          kind: "screen_ram",
          start: startAddress,
          end: endAddress,
          score: {
            confidence,
            reasons: [
              "Detected 1000-byte block, matching C64 screen matrix size.",
              `${Math.round(printableRatio * 100)}% of bytes fit screen-code-like ranges.`,
              vic.screenAddresses.includes(startAddress)
                ? `Start matches VIC screen address inferred from $D018/$DD00: ${formatAddress(startAddress)}.`
                : "No direct VIC screen-address match was found.",
            ],
          },
          attributes: {
            length: segmentLength(startAddress, endAddress),
            inferredVicScreens: vic.screenAddresses.map(formatAddress),
          },
        });
      }
    }

    return {
      analyzerId: this.id,
      candidates,
    };
  }
}
