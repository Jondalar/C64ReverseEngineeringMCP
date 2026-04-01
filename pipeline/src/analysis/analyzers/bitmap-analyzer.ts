import { extractVicEvidence } from "../c64-hardware";
import { renderBitmapSampleAscii } from "../render";
import { AnalyzerContext, AnalyzerResult, SegmentCandidate, SegmentKind } from "../types";
import { clampConfidence, formatAddress, segmentLength, toOffset } from "../utils";

function bitDensity(bytes: Uint8Array): number {
  let setBits = 0;
  for (const byte of bytes) {
    let value = byte;
    while (value !== 0) {
      setBits += value & 1;
      value >>= 1;
    }
  }
  return setBits / (bytes.length * 8);
}

export class BitmapAnalyzer {
  readonly id = "bitmap";

  analyze(context: AnalyzerContext): AnalyzerResult {
    const vic = extractVicEvidence(context);
    const candidates: SegmentCandidate[] = [];
    const confirmedBitmapAddresses = new Set(vic.bitmapAddresses);
    const allowHeuristicScan = vic.bitmapModeEnabled && confirmedBitmapAddresses.size > 0;
    const candidateOffsets = new Set<number>();
    const exactD016Writes = vic.observedWrites.filter(
      (write) => write.registerAddress === 0xd016 && write.inferredValue !== undefined && write.confidence >= 0.72,
    );
    const modeKind: SegmentKind =
      exactD016Writes.some((write) => ((write.inferredValue ?? 0) & 0x10) !== 0)
        ? "multicolor_bitmap"
        : exactD016Writes.length > 0
          ? "hires_bitmap"
          : "bitmap";

    for (const address of confirmedBitmapAddresses) {
      const offset = toOffset(address, context.mapping);
      if (offset !== undefined && offset + 7999 < context.buffer.length) {
        candidateOffsets.add(offset);
      }
    }

    if (candidateOffsets.size === 0 && allowHeuristicScan) {
      for (const region of context.candidateRegions) {
        const startOffset = toOffset(region.start, context.mapping);
        const endOffset = toOffset(region.end, context.mapping);
        if (startOffset === undefined || endOffset === undefined) {
          continue;
        }
        const regionLength = endOffset - startOffset + 1;
        if (regionLength < 8000) {
          continue;
        }
        for (let offset = startOffset; offset + 7999 <= endOffset; offset += 0x2000) {
          candidateOffsets.add(offset);
        }
      }
    }

    const matchingBitmapOffsets = Array.from(candidateOffsets).sort((left, right) => left - right);

    for (const offset of matchingBitmapOffsets) {
      const block = context.buffer.subarray(offset, offset + 8000);
      const density = bitDensity(block);
      const startAddress = context.mapping.startAddress + offset;
      const endAddress = startAddress + 7999;
      const uniqueMappedVicBase = matchingBitmapOffsets.length === 1 && confirmedBitmapAddresses.has(startAddress);
      const directVicMatch = confirmedBitmapAddresses.has(startAddress) && (vic.bankSelectionConfirmed || uniqueMappedVicBase);
      const screenInSameBank = vic.screenAddresses.find(
        (screenAddress) => (screenAddress & 0xc000) === (startAddress & 0xc000),
      );
      const densityScore = density >= 0.08 && density <= 0.55 ? 0.24 : 0.04;
      const vicBonus = directVicMatch ? 0.34 : 0;
      const modeBonus = vic.bitmapModeEnabled ? 0.18 : 0;
      const screenBonus = screenInSameBank !== undefined ? 0.12 : 0;
      const multicolorBonus = vic.multicolorEnabled ? 0.04 : 0;
      const modeHint = modeKind;
      const confidence = clampConfidence(0.16 + densityScore + vicBonus + modeBonus + screenBonus + multicolorBonus);
      if (confidence < (directVicMatch ? 0.72 : 0.82)) {
        continue;
      }

      candidates.push({
        analyzerId: this.id,
        kind: modeKind,
        start: startAddress,
        end: endAddress,
        score: {
          confidence,
          reasons: [
            "Detected 8000-byte block, matching C64 bitmap payload size.",
            `Bit density ${density.toFixed(2)} is plausible for image data, not empty padding.`,
            directVicMatch
              ? `Start matches VIC bitmap base inferred from $D011/$D018/$DD00: ${formatAddress(startAddress)}.`
              : confirmedBitmapAddresses.has(startAddress)
                ? "Bitmap-mode evidence and $D018 alignment fit this start, but VIC bank select is not pinned down uniquely."
                : "Bitmap-mode evidence exists, but this block is only a heuristic alignment candidate.",
            screenInSameBank !== undefined
              ? `A VIC screen block is also inferred in the same 16 KiB bank at ${formatAddress(screenInSameBank)}.`
              : "No matching VIC screen block was inferred in the same bank.",
            vic.bitmapModeEnabled ? "Code writes suggest bitmap mode is enabled via $D011." : "Bitmap mode is not confirmed, so confidence is reduced.",
            modeKind === "multicolor_bitmap"
              ? "VIC control evidence suggests multicolor bitmap presentation rather than hires."
              : modeKind === "hires_bitmap"
                ? "An exact $D016 write was seen without the multicolor bit set, so hires bitmap is the stronger subtype."
                : "No exact $D016 mode write was recovered, so this stays a generic bitmap hypothesis.",
          ],
        },
        preview: [renderBitmapSampleAscii(block.subarray(0, 24), "bitmap sample")],
        attributes: {
          length: segmentLength(startAddress, endAddress),
          inferredVicBitmaps: vic.bitmapAddresses.map(formatAddress),
          inferredVicScreens: vic.screenAddresses.map(formatAddress),
          multicolor: vic.multicolorEnabled,
          modeHint,
          vicBacked: directVicMatch,
        },
      });
    }

    return {
      analyzerId: this.id,
      candidates,
    };
  }
}
