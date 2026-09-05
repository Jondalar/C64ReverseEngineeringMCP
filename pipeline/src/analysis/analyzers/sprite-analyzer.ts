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
  /** Spec 816: mean bit agreement between row n and row n+1 (0..1). */
  rowCoherence: number;
  /** Spec 816: distinct byte values in the block (uniform fill ⇒ tiny). */
  distinctBytes: number;
  /** Spec 816: set-bit overlap between row n and row n+1 (0..1). */
  shapeOverlap: number;
}

// Spec 816 §3. The gate that decides whether a 64-byte block can be a sprite
// AT ALL. Before 816 the score was a sum of banded terms with generous floors:
// a block that failed every single criterion still scored 0.49 against a 0.66
// threshold, so the decision rode on 0.17 of range and 6502 code passed on the
// strength of the floors alone.
//
// `rowCoherence` is the criterion the old scorer never had. A sprite is a
// contiguous FIGURE — row n and row n+1 are nearly the same shape — while code
// has no vertical relationship at all. Measured over 2 999 blocks of real
// PRGs: the eight reference sprites score 0.86-0.92, 6502 code averages 0.64.
// The upper bound rejects the other end, a uniform fill (all rows identical
// ⇒ 1.0), which is padding or a cleared buffer, not a shape.
const SPRITE_GATE = {
  coherenceMin: 0.8,
  // Raw bit agreement is inflated by SPARSITY: two nearly-empty rows agree on
  // 22 of 24 bits while sharing no shape at all, which is how a table of bit
  // masks scored 1.00 as a sprite. `shapeOverlap` divides by the union of the
  // set bits instead, so agreement has to be about the FIGURE. The reference
  // sprites sit at 0.60-0.86; the mask table that got through sits at 0.31.
  shapeOverlapMin: 0.55,
  coherenceMax: 0.985,
  distinctBytesMin: 8,
  densityMin: 0.02,
  densityMax: 0.95,
} as const;

function passesSpriteGate(metrics: SpriteBlockMetrics): boolean {
  return (
    metrics.rowCoherence >= SPRITE_GATE.coherenceMin &&
    metrics.rowCoherence <= SPRITE_GATE.coherenceMax &&
    metrics.shapeOverlap >= SPRITE_GATE.shapeOverlapMin &&
    metrics.distinctBytes >= SPRITE_GATE.distinctBytesMin &&
    metrics.density >= SPRITE_GATE.densityMin &&
    metrics.density <= SPRITE_GATE.densityMax
  );
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

  // Spec 816: vertical coherence. Bit agreement between row n and row n+1,
  // averaged over the 20 row pairs. A figure keeps its shape from one row to
  // the next; 6502 code does not.
  let agreement = 0;
  let overlapSum = 0;
  let overlapPairs = 0;
  for (let row = 0; row < 20; row += 1) {
    let matches = 0;
    let intersection = 0;
    let union = 0;
    for (let byteIndex = 0; byteIndex < 3; byteIndex += 1) {
      const upper = block[row * 3 + byteIndex] ?? 0;
      const lower = block[(row + 1) * 3 + byteIndex] ?? 0;
      matches += 8 - popCount(upper ^ lower);
      intersection += popCount(upper & lower);
      union += popCount(upper | lower);
    }
    agreement += matches / 24;
    if (union > 0) {
      overlapSum += intersection / union;
      overlapPairs += 1;
    }
  }

  return {
    density,
    rowVariance,
    transitionScore: transitions / (21 * 24),
    paddingLooksValid: (block[63] ?? 0) === 0,
    entropy: shannonEntropy(block),
    rowCoherence: agreement / 20,
    distinctBytes: new Set(block).size,
    shapeOverlap: overlapPairs > 0 ? overlapSum / overlapPairs : 0,
  };
}

function popCount(value: number): number {
  let bits = 0;
  let rest = value;
  while (rest !== 0) {
    rest &= rest - 1;
    bits += 1;
  }
  return bits;
}

function scoreSpriteBlock(metrics: SpriteBlockMetrics): number {
  // Spec 816: the gate decides, the bands only grade. No floors — a block that
  // passes the gate and nothing else lands at 0.08, far under the 0.66
  // threshold, so the threshold means something again.
  if (!passesSpriteGate(metrics)) {
    return 0;
  }
  const coherenceScore = metrics.rowCoherence >= 0.84 ? 0.35 : 0.25;
  // Widened from [0.03, 0.55]: real sprites are often SOLID (the reference
  // ball sits at 0.79), and the old ceiling punished exactly those.
  const densityScore = metrics.density >= 0.03 && metrics.density <= 0.9 ? 0.2 : 0;
  const varianceScore = metrics.rowVariance >= 0.002 && metrics.rowVariance <= 0.15 ? 0.15 : 0;
  const transitionScore = metrics.transitionScore >= 0.02 && metrics.transitionScore <= 0.6 ? 0.1 : 0;
  const entropyScore = metrics.entropy >= 1.2 && metrics.entropy <= 5.8 ? 0.15 : 0;
  const paddingBonus = metrics.paddingLooksValid ? 0.08 : -0.12;
  return clampConfidence(
    coherenceScore + densityScore + varianceScore + transitionScore + entropyScore + paddingBonus,
  );
}

export class SpriteAnalyzer {
  readonly id = "sprite";

  analyze(context: AnalyzerContext): AnalyzerResult {
    const vic = extractVicEvidence(context);
    const candidates: SegmentCandidate[] = [];

    // Spec 816.2 — the pointer anchor. `charset-analyzer` seeds its probe list
    // from the $D018-confirmed charset bases IN ADDITION TO the candidate
    // regions, because the region-only scan cannot surface what the region
    // boundaries hide. Sprites get the same treatment one level deeper: the
    // sprite pointers at screenBase+$3F8 name the blocks outright, so each
    // recovered address is probed as its own 64-byte region even when code
    // discovery claimed the ground around it.
    const pointerConfirmed = new Set(vic.spriteDataAddresses);
    const probeRegions: Array<{ start: number; end: number; vicConfirmed: boolean }> = [];
    for (const region of context.candidateRegions) {
      probeRegions.push({ start: region.start, end: region.end, vicConfirmed: false });
    }
    for (const address of vic.spriteDataAddresses) {
      probeRegions.push({ start: address, end: address + 63, vicConfirmed: true });
    }

    for (const region of probeRegions) {
      const startOffset = toOffset(region.start, context.mapping);
      const endOffset = toOffset(region.end, context.mapping);
      if (startOffset === undefined || endOffset === undefined) {
        continue;
      }

      // Spec 816 / issue #8. A VIC sprite block is `sprite pointer × 64` inside
      // a bank base that is itself a multiple of $4000, so sprite data always
      // begins at an absolute address ≡ 0 mod $40. Candidate regions are the
      // gaps code discovery left behind and start wherever the code stopped,
      // so scanning from `region.start` puts the WHOLE 64-byte grid off-phase.
      //
      // This was not a false-positive problem, it was blindness: Bug 27 already
      // rejects any candidate whose start is not $40-aligned, so in an
      // off-phase region every run found was thrown away without a word. The
      // reference fixture — eight textbook sprites at $2400, region opening at
      // $200A — produced zero candidates before this line existed.
      const misalignment = region.start % 0x40;
      const alignSkip = misalignment === 0 ? 0 : 0x40 - misalignment;
      const alignedRegionStart = region.start + alignSkip;
      const alignedStartOffset = startOffset + alignSkip;

      const regionLength = endOffset - alignedStartOffset + 1;
      const blockCount = Math.floor(regionLength / 64);
      if (blockCount === 0) {
        continue;
      }

      let runStartBlock: number | undefined;
      const previews: PreviewFrame[] = [];
      const scores: number[] = [];
      const metricsRun: SpriteBlockMetrics[] = [];

      for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
        const offset = alignedStartOffset + blockIndex * 64;
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
          pushSpriteCandidate(vic, alignedRegionStart, runStartBlock, blockIndex - 1, scores, metricsRun, previews, candidates, pointerConfirmed);
          runStartBlock = undefined;
        }
      }

      if (runStartBlock !== undefined) {
        pushSpriteCandidate(vic, alignedRegionStart, runStartBlock, blockCount - 1, scores, metricsRun, previews, candidates, pointerConfirmed);
      }
    }

    // Spec 019 Bug 11: cap confidence on candidates that look like 6502
    // jump tables (e.g. 1541 T1/S0 buffer starting with JMP $0340 followed
    // by 16-bit ROM addresses). The classifier's per-block heuristic is
    // sprite-shaped because the address bytes have plausible bit patterns,
    // but the structure is wrong.
    for (const candidate of candidates) {
      if (looksLikeJumpTableOrAddressList(candidate.start, context)) {
        const capped = Math.min(candidate.score.confidence, 0.3);
        if (capped < candidate.score.confidence) {
          candidate.score.confidence = capped;
          candidate.score.reasons.push(
            "Demoted: first bytes decode as JMP/JSR or look like aligned 16-bit address pairs (jump table, not sprite).",
          );
        }
      }
    }

    return {
      analyzerId: this.id,
      candidates,
    };
  }
}

// Spec 019 Bug 11. Returns true when the first ~32 bytes at `start` look
// like (a) a 6502 JMP/JSR opcode whose target lies inside the same range,
// or (b) a sequence of 16-bit address pairs whose high bytes consistently
// land in the typical ROM/IO ranges ($A0-$FF), or alternate $00-$7F lo
// with $80-$FF hi suggesting a pointer table.
function looksLikeJumpTableOrAddressList(
  start: number,
  context: AnalyzerContext,
): boolean {
  const offset = toOffset(start, context.mapping);
  if (offset === undefined) return false;
  const buf = context.buffer;
  if (offset + 32 > buf.length) return false;

  // (a) JMP $XXXX (4C lo hi) or JSR $XXXX (20 lo hi) where target lies inside
  // the candidate's first 256 bytes.
  const op = buf[offset];
  if (op === 0x4c || op === 0x20) {
    const target = (buf[offset + 2] << 8) | buf[offset + 1];
    if (target >= start && target <= start + 0xff) {
      return true;
    }
  }

  // (b) Aligned 16-bit address pairs. Sample bytes 0..31 in pairs; count
  // pairs whose high byte is in the C64 ROM/IO range ($A0-$FF) or whose
  // distribution alternates lo/hi consistently. Threshold: 6 of 8 pairs
  // land in the heuristic.
  let romIshPairs = 0;
  let totalPairs = 0;
  for (let p = 0; p < 16; p += 2) {
    const lo = buf[offset + p];
    const hi = buf[offset + p + 1];
    if (lo === undefined || hi === undefined) break;
    totalPairs += 1;
    if (hi >= 0xa0 && hi <= 0xff) romIshPairs += 1;
  }
  if (totalPairs >= 8 && romIshPairs >= 6) return true;
  return false;
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
  pointerConfirmed: ReadonlySet<number>,
): void {
  const spriteRegisterTouches = vic.spriteRegisterTouches;
  const start = regionStart + startBlock * 64;
  const end = regionStart + (endBlock + 1) * 64 - 1;
  // Bug 27: VIC sprite blocks must be 64-byte aligned in the current
  // VIC bank (sprite pointer × 64 = address). Reject candidates whose
  // start address is not a multiple of 64 — they are hardware-impossible
  // sprite locations regardless of bit-pattern plausibility.
  if ((start & 0x3f) !== 0) {
    return;
  }
  const blockCount = endBlock - startBlock + 1;
  const averageScore = scores.reduce((sum, value) => sum + value, 0) / Math.max(1, scores.length);
  const paddingRatio =
    metricsRun.filter((metrics) => metrics.paddingLooksValid).length / Math.max(1, metricsRun.length);
  // Spec 816 §4. Byte $3F of a sprite block is never fetched by VIC — 21 rows
  // × 3 bytes = 63 — so sprite data conventionally carries 0 there. A run in
  // which fewer than half the blocks do is a data table that happens to have
  // vertical structure, not a sprite set. Measured: this removes 43 of the 62
  // false candidates the aligned scan surfaces, and keeps both reference
  // fixtures (100 % padding) untouched.
  const namedByPointer = pointerConfirmed.has(start);
  // A VIC sprite pointer NAMES this block. Hand-packed sprite data that reuses
  // byte $3F is real and would otherwise be dropped by the padding gate, so
  // direct evidence overrides the convention — but only for the block the
  // pointer actually names.
  if (paddingRatio < 0.5 && !namedByPointer) {
    return;
  }
  const averageDensity =
    metricsRun.reduce((sum, metrics) => sum + metrics.density, 0) / Math.max(1, metricsRun.length);
  const averageEntropy =
    metricsRun.reduce((sum, metrics) => sum + metrics.entropy, 0) / Math.max(1, metricsRun.length);
  const averageOverlap =
    metricsRun.reduce((sum, metrics) => sum + metrics.shapeOverlap, 0) / Math.max(1, metricsRun.length);
  const hardwareBonus = spriteRegisterTouches >= 4 ? 0.08 : 0;
  // Spec 816.2: a sprite pointer is direct evidence, not a shape guess.
  const pointerBonus = namedByPointer ? 0.2 : 0;
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
    averageScore - 0.06 + runBonus + paddingBonus + densityBonus + entropyBonus + hardwareBonus + pointerBonus + longRunPenalty + longRunPaddingPenalty + charsetCollisionPenalty,
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
        `Vertical shape overlap between adjacent rows averages ${(averageOverlap * 100).toFixed(0)}% (a figure keeps its shape from row to row; 6502 code does not).`,
        `${Math.round(paddingRatio * 100)}% of candidate blocks have a zero padding byte at offset $3F.`,
        `Average block entropy is ${averageEntropy.toFixed(2)} bits/byte.`,
        spriteRegisterTouches >= 4 ? "Discovered code also touches VIC sprite registers, strengthening sprite classification." : "No direct sprite-register evidence was found yet.",
        namedByPointer
          ? `A VIC sprite pointer at screenBase+$3F8 names ${formatAddress(start)} directly — this is evidence, not a shape guess.`
          : "No sprite pointer in the image names this address.",
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
