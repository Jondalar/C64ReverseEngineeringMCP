import { extractVicEvidence } from "../c64-hardware";
import { renderCharsetAscii } from "../render";
import { AnalyzerContext, AnalyzerResult, SegmentCandidate } from "../types";
import { clampConfidence, formatAddress, segmentLength, toOffset } from "../utils";

interface GlyphMetrics {
  density: number;
  hasStructure: boolean;
  emptyEdgeRows: boolean;
}

function analyzeGlyph(bytes: Uint8Array): GlyphMetrics {
  let setBits = 0;
  for (const byte of bytes) {
    let value = byte;
    while (value !== 0) {
      setBits += value & 1;
      value >>= 1;
    }
  }

  const density = setBits / 64;
  const emptyEdgeRows = bytes[0] === 0 || bytes[7] === 0;
  const nonEmptyRows = bytes.filter((byte) => byte !== 0).length;
  return {
    density,
    hasStructure: nonEmptyRows >= 2 && nonEmptyRows <= 7 && density >= 0.03 && density <= 0.45,
    emptyEdgeRows,
  };
}

export class CharsetAnalyzer {
  readonly id = "charset";

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
      if (regionLength < 128 || regionLength % 8 !== 0) {
        continue;
      }

      const glyphCount = Math.floor(regionLength / 8);
      const bytes = context.buffer.subarray(startOffset, endOffset + 1);
      let plausibleGlyphs = 0;
      let edgeRowGlyphs = 0;
      let totalDensity = 0;

      for (let glyphIndex = 0; glyphIndex < glyphCount; glyphIndex += 1) {
        const glyph = bytes.subarray(glyphIndex * 8, glyphIndex * 8 + 8);
        const metrics = analyzeGlyph(glyph);
        if (metrics.hasStructure) {
          plausibleGlyphs += 1;
        }
        if (metrics.emptyEdgeRows) {
          edgeRowGlyphs += 1;
        }
        totalDensity += metrics.density;
      }

      const plausibleRatio = plausibleGlyphs / glyphCount;
      if (plausibleRatio < 0.42) {
        continue;
      }

      const averageDensity = totalDensity / glyphCount;
      const canonicalSizeBonus = glyphCount === 128 || glyphCount === 256 ? 0.12 : 0;
      const vicBonus = vic.charsetAddresses.includes(region.start) ? 0.16 : 0;
      const confidence = clampConfidence(0.36 + plausibleRatio * 0.4 + canonicalSizeBonus + (edgeRowGlyphs / glyphCount) * 0.08 + vicBonus);
      const preview = renderCharsetAscii(bytes, glyphCount, "charset preview");

      candidates.push({
        analyzerId: this.id,
        kind: "charset",
        start: region.start,
        end: region.end,
        score: {
          confidence,
          reasons: [
            `Region length is ${glyphCount} x 8 bytes, which matches glyph storage.`,
            `${Math.round(plausibleRatio * 100)}% of glyphs have plausible 8x8 structure.`,
            `${Math.round((edgeRowGlyphs / glyphCount) * 100)}% of glyphs have empty top or bottom rows, common in character sets.`,
            `Average glyph density is ${averageDensity.toFixed(2)}, which is close to readable character data.`,
            vic.charsetAddresses.includes(region.start)
              ? `Start matches VIC charset address inferred from $D018/$DD00: ${formatAddress(region.start)}.`
              : "No direct VIC charset-address match was found.",
          ],
          alternatives: [
            {
              kind: "lookup_table",
              confidence: clampConfidence(confidence - 0.22),
              reasons: ["Regular 8-byte cadence may also occur in packed tables, but glyph structure is stronger."],
            },
          ],
        },
        preview: [preview],
        attributes: {
          glyphCount,
          plausibleRatio,
          range: `${formatAddress(region.start)}-${formatAddress(region.end)}`,
          length: segmentLength(region.start, region.end),
        },
      });
    }

    return {
      analyzerId: this.id,
      candidates,
    };
  }
}
