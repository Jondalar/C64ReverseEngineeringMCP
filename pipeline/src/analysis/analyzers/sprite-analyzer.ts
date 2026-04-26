import { extractVicEvidence } from "../c64-hardware";
import { renderSpriteAscii } from "../render";
import { AnalyzerContext, AnalyzerResult, PreviewFrame, SegmentCandidate } from "../types";
import { clampConfidence, formatAddress, segmentLength, toOffset } from "../utils";

interface SpriteBlockMetrics {
  density: number;
  rowVariance: number;
  transitionScore: number;
  paddingLooksValid: boolean;
  entropy: number;
}

function shannonEntropy(block: Uint8Array): number {
  const counts = new Array<number>(256).fill(0);
  for (const value of block) {
    counts[value] += 1;
  }

  let entropy = 0;
  for (const count of counts) {
    if (count === 0) {
      continue;
    }
    const probability = count / block.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function analyzeSpriteBlock(block: Uint8Array): SpriteBlockMetrics {
  let setBits = 0;
  const rowDensities: number[] = [];
  let transitions = 0;

  for (let row = 0; row < 21; row += 1) {
    const bytes = [block[row * 3] ?? 0, block[row * 3 + 1] ?? 0, block[row * 3 + 2] ?? 0];
    let rowBits = 0;
    let previousBit = 0;
    let rowTransitions = 0;

    for (const value of bytes) {
      for (let bit = 7; bit >= 0; bit -= 1) {
        const active = (value >> bit) & 1;
        rowBits += active;
        if (bit !== 7 || previousBit !== 0) {
          rowTransitions += active === previousBit ? 0 : 1;
        }
        previousBit = active;
      }
    }

    setBits += rowBits;
    rowDensities.push(rowBits / 24);
    transitions += rowTransitions;
  }

  const density = setBits / (21 * 24);
  const averageDensity = rowDensities.reduce((sum, value) => sum + value, 0) / rowDensities.length;
  const rowVariance =
    rowDensities.reduce((sum, value) => sum + Math.pow(value - averageDensity, 2), 0) / rowDensities.length;

  return {
    density,
    rowVariance,
    transitionScore: transitions / (21 * 24),
    paddingLooksValid: (block[63] ?? 0) === 0,
    entropy: shannonEntropy(block),
  };
}

function scoreSpriteBlock(metrics: SpriteBlockMetrics): number {
  const densityScore = metrics.density >= 0.03 && metrics.density <= 0.55 ? 0.45 : 0.1;
  const varianceScore = metrics.rowVariance >= 0.002 && metrics.rowVariance <= 0.08 ? 0.25 : 0.08;
  const transitionScore = metrics.transitionScore >= 0.08 && metrics.transitionScore <= 0.6 ? 0.2 : 0.05;
  const entropyScore = metrics.entropy >= 1.2 && metrics.entropy <= 5.8 ? 0.18 : metrics.entropy <= 6.3 ? 0.08 : -0.04;
  const notBlankBonus = metrics.density > 0.01 ? 0.1 : 0;
  const paddingBonus = metrics.paddingLooksValid ? 0.08 : -0.12;
  return clampConfidence(densityScore + varianceScore + transitionScore + entropyScore + notBlankBonus + paddingBonus);
}

export class SpriteAnalyzer {
  readonly id = "sprite";

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
      const blockCount = Math.floor(regionLength / 64);
      if (blockCount === 0) {
        continue;
      }

      let runStartBlock: number | undefined;
      const previews: PreviewFrame[] = [];
      const scores: number[] = [];
      const metricsRun: SpriteBlockMetrics[] = [];

      for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
        const offset = startOffset + blockIndex * 64;
        const block = context.buffer.subarray(offset, offset + 64);
        const metrics = analyzeSpriteBlock(block);
        const score = scoreSpriteBlock(metrics);
        const plausible = score >= 0.66;

        if (plausible && runStartBlock === undefined) {
          runStartBlock = blockIndex;
          scores.length = 0;
          previews.length = 0;
          metricsRun.length = 0;
        }

        if (plausible && runStartBlock !== undefined) {
          scores.push(score);
          metricsRun.push(metrics);
          if (previews.length < 2) {
            previews.push(renderSpriteAscii(block, `sprite ${blockIndex}`));
          }
          continue;
        }

        if (!plausible && runStartBlock !== undefined) {
          pushSpriteCandidate(vic, region.start, runStartBlock, blockIndex - 1, scores, metricsRun, previews, candidates);
          runStartBlock = undefined;
        }
      }

      if (runStartBlock !== undefined) {
        pushSpriteCandidate(vic, region.start, runStartBlock, blockCount - 1, scores, metricsRun, previews, candidates);
      }
    }

    return {
      analyzerId: this.id,
      candidates,
    };
  }
}

function isAddressInsideCharsetBank(address: number, charsetAddresses: number[]): boolean {
  // A C64 charset bank is 2 KB ($0800) — 256 glyphs × 8 bytes. When VIC
  // $D018 selects a charset base, sprite candidates that fall anywhere
  // in that 2 KB window are almost certainly mis-classified glyph data.
  for (const base of charsetAddresses) {
    if (address >= base && address < base + 0x0800) {
      return true;
    }
  }
  return false;
}

function pushSpriteCandidate(
  vic: { spriteRegisterTouches: number; charsetAddresses: number[] },
  regionStart: number,
  startBlock: number,
  endBlock: number,
  scores: number[],
  metricsRun: SpriteBlockMetrics[],
  previews: PreviewFrame[],
  candidates: SegmentCandidate[],
): void {
  const spriteRegisterTouches = vic.spriteRegisterTouches;
  const start = regionStart + startBlock * 64;
  const end = regionStart + (endBlock + 1) * 64 - 1;
  const blockCount = endBlock - startBlock + 1;
  const averageScore = scores.reduce((sum, value) => sum + value, 0) / Math.max(1, scores.length);
  const paddingRatio =
    metricsRun.filter((metrics) => metrics.paddingLooksValid).length / Math.max(1, metricsRun.length);
  const averageDensity =
    metricsRun.reduce((sum, metrics) => sum + metrics.density, 0) / Math.max(1, metricsRun.length);
  const averageEntropy =
    metricsRun.reduce((sum, metrics) => sum + metrics.entropy, 0) / Math.max(1, metricsRun.length);
  const hardwareBonus = spriteRegisterTouches >= 4 ? 0.08 : 0;
  const runBonus = blockCount >= 2 && blockCount <= 8 ? 0.08 : 0.02;
  const paddingBonus = paddingRatio >= 0.75 ? 0.08 : paddingRatio >= 0.5 ? 0.02 : -0.14;
  const densityBonus = averageDensity >= 0.04 && averageDensity <= 0.42 ? 0.04 : -0.08;
  const entropyBonus = averageEntropy >= 1.4 && averageEntropy <= 5.6 ? 0.05 : averageEntropy <= 6.2 ? 0 : -0.16;
  const longRunPenalty = blockCount > 24 ? -0.28 : blockCount > 16 ? -0.18 : blockCount > 8 ? -0.08 : 0;
  const longRunPaddingPenalty = blockCount > 8 && paddingRatio < 0.9 ? -0.12 : 0;
  // VIC $D018 evidence: when the candidate falls inside a confirmed
  // charset bank, the bytes are far more likely to be glyph data than
  // sprite data. The charset analyzer should win the overlap, so we
  // apply a structural penalty here (charset's kindPriority is lower
  // than sprite's, so a tie on confidence would otherwise still go to
  // sprite).
  const charsetCollisionPenalty = isAddressInsideCharsetBank(start, vic.charsetAddresses) ? -0.25 : 0;
  const confidence = clampConfidence(
    averageScore - 0.06 + runBonus + paddingBonus + densityBonus + entropyBonus + hardwareBonus + longRunPenalty + longRunPaddingPenalty + charsetCollisionPenalty,
  );

  const minimumConfidence = blockCount > 16 ? 0.88 : blockCount > 8 ? 0.82 : 0.68;

  if (confidence < minimumConfidence) {
    return;
  }

  candidates.push({
    analyzerId: "sprite",
    kind: "sprite",
    start,
    end,
    score: {
      confidence,
      reasons: [
        `Length is ${blockCount} x 64 bytes, matching C64 sprite storage.`,
        `Rendered blocks show non-empty 24x21 pixel silhouettes in ${formatAddress(start)}-${formatAddress(end)}.`,
        "Row density and transition metrics are closer to sprite shapes than random noise.",
        `${Math.round(paddingRatio * 100)}% of candidate blocks have a zero padding byte at offset $3F.`,
        `Average block entropy is ${averageEntropy.toFixed(2)} bits/byte.`,
        spriteRegisterTouches >= 4 ? "Discovered code also touches VIC sprite registers, strengthening sprite classification." : "No direct sprite-register evidence was found yet.",
      ],
      alternatives: [
        {
          kind: "bitmap",
          confidence: clampConfidence(confidence - 0.18),
          reasons: ["Visual structure is graphic-like, but the 64-byte block cadence favors sprites."],
        },
      ],
    },
    preview: [...previews],
    attributes: {
      spriteCount: blockCount,
      length: segmentLength(start, end),
    },
  });
}
