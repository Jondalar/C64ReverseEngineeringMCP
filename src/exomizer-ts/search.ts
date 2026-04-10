import { PFLAG_4_OFFSET_TABLES, PFLAG_REUSE_OFFSET, TFLAG_LEN0123_SEQ_MIRRORS, TFLAG_LIT_SEQ } from "./flags.js";
import { MatchContext } from "./match.js";
import { EncodeMatchBuckets, Match, SearchNode } from "./types.js";

export interface EncodeMatchData {
  out: unknown;
  priv: unknown;
}

export type EncodeMatchFn = (
  mp: Match,
  emd: EncodeMatchData,
  prevOffset: number,
  embp: EncodeMatchBuckets | null
) => number;

const updateSnp = (
  snp: SearchNode,
  totalScore: number,
  totalOffset: number,
  prev: SearchNode | null,
  match: Match,
  flagsProto: number
): void => {
  let latestOffset = 0;

  snp.totalScore = totalScore;
  snp.totalOffset = totalOffset >>> 0;
  snp.prev = prev;
  snp.match = { ...match, next: null };

  if ((flagsProto & PFLAG_REUSE_OFFSET) !== 0) {
    if (match.offset === 0 && prev !== null && prev.match.offset > 0) {
      latestOffset = prev.match.offset;
    }
  }
  snp.latestOffset = latestOffset;
};

export const searchBuffer = (
  ctx: MatchContext,
  f: EncodeMatchFn,
  emd: EncodeMatchData,
  flagsProto: number,
  flagsNoTrait: number,
  maxSequenceLength: number,
  greedy: boolean
): SearchNode[] => {
  const useLiteralSequences = (flagsNoTrait & TFLAG_LIT_SEQ) === 0;
  let skipLen0123Mirrors = flagsNoTrait & TFLAG_LEN0123_SEQ_MIRRORS;
  let len = ctx.len + 1;

  if (skipLen0123Mirrors !== 0) {
    if ((flagsProto & PFLAG_4_OFFSET_TABLES) !== 0) {
      skipLen0123Mirrors = 4;
    } else {
      skipLen0123Mirrors = 3;
    }
  }

  const snArr: SearchNode[] = new Array(len);
  for (let i = 0; i < len; i++) {
    snArr[i] = {
      index: 0,
      match: { offset: 0, len: 0, next: null },
      totalOffset: 0,
      totalScore: 0,
      prev: null,
      latestOffset: 0
    };
  }

  len--;
  let snp = snArr[len];
  snp.index = len;
  snp.match.offset = 0;
  snp.match.len = 0;
  snp.totalOffset = 0;
  snp.totalScore = 0;
  snp.prev = null;
  snp.latestOffset = 0;

  let bestCopySnp: SearchNode = snp;
  let bestCopyLen = 0;
  let bestRleSnp: SearchNode | null = null;

  for (;;) {
    let prevScore: number;
    let latestOffsetSum: number;

    if (useLiteralSequences) {
      snp = snArr[len];
      if (
        (snp.match.offset !== 0 || snp.match.len !== 1) &&
        (bestCopySnp.totalScore + bestCopyLen * 8.0 - snp.totalScore > 0.0 ||
          bestCopyLen > maxSequenceLength)
      ) {
        bestCopySnp = snp;
        bestCopyLen = 0;
      } else {
        const copyScore = bestCopyLen * 8.0 + (1.0 + 17.0 + 17.0);
        const totalCopyScore = bestCopySnp.totalScore + copyScore;

        if (
          snp.totalScore > totalCopyScore &&
          bestCopyLen <= maxSequenceLength &&
          !(skipLen0123Mirrors !== 0 && bestCopyLen > 255 && (bestCopyLen & 255) < 2)
        ) {
          const localM: Match = { len: bestCopyLen, offset: 0, next: null };
          updateSnp(
            snp,
            totalCopyScore,
            bestCopySnp.totalOffset,
            bestCopySnp,
            localM,
            flagsProto
          );
        }
      }
    }

    snp = snArr[len];
    if (
      bestRleSnp === null ||
      snp.index + maxSequenceLength < bestRleSnp.index ||
      snp.index + ctx.rleR[snp.index] < bestRleSnp.index
    ) {
      if (ctx.rle[snp.index] > 0) {
        bestRleSnp = snp;
      } else {
        bestRleSnp = null;
      }
    } else if (
      ctx.rle[snp.index] > 0 &&
      snp.index + ctx.rleR[snp.index] >= bestRleSnp.index
    ) {
      const bestRleM: Match = { len: ctx.rle[bestRleSnp.index], offset: 1, next: null };
      const bestRleScore = f(bestRleM, emd, bestRleSnp.latestOffset, null);
      const totalBestRleScore = bestRleSnp.totalScore + bestRleScore;

      const snpRleM: Match = { len: ctx.rle[snp.index], offset: 1, next: null };
      const snpRleScore = f(snpRleM, emd, snp.latestOffset, null);
      const totalSnpRleScore = snp.totalScore + snpRleScore;

      if (totalSnpRleScore <= totalBestRleScore) {
        bestRleSnp = snp;
      }
    }

    if (bestRleSnp !== null && bestRleSnp !== snp) {
      const localM: Match = { len: bestRleSnp.index - snp.index, offset: 1, next: null };
      const rleScore = f(localM, emd, bestRleSnp.latestOffset, null);
      const totalRleScore = bestRleSnp.totalScore + rleScore;
      if (snp.totalScore > totalRleScore) {
        updateSnp(
          snp,
          totalRleScore,
          bestRleSnp.totalOffset + 1,
          bestRleSnp,
          localM,
          flagsProto
        );
      }
    }

    if (len === 0) {
      break;
    }

    let mp = ctx.matchesGet(len - 1);

    prevScore = snArr[len].totalScore;
    latestOffsetSum = snArr[len].totalOffset;
    while (mp !== null) {
      const next = mp.next;
      const endLen = 1;
      const tmp: Match = { ...mp, next: null };
      let bucketLenStart = 0;
      const prevSnp = snArr[len];
      let score = 0.0;

      for (tmp.len = mp.len; tmp.len >= endLen; --tmp.len) {
        const matchBuckets: EncodeMatchBuckets = {
          len: { start: 0, end: 0 },
          offset: { start: 0, end: 0 }
        };

        if (
          bucketLenStart === 0 ||
          tmp.len < 4 ||
          tmp.len < bucketLenStart ||
          (skipLen0123Mirrors !== 0 &&
            tmp.len > 255 &&
            (tmp.len & 255) < skipLen0123Mirrors)
        ) {
          score = f(tmp, emd, prevSnp.latestOffset, matchBuckets);
          bucketLenStart = matchBuckets.len.start;
        }

        const totalScore = prevScore + score;
        const totalOffset = latestOffsetSum + tmp.offset;
        snp = snArr[len - tmp.len];

        if (
          totalScore < 100000000.0 &&
          (snp.match.len === 0 ||
            totalScore < snp.totalScore ||
            (totalScore === snp.totalScore &&
              totalOffset < snp.totalOffset &&
              (greedy ||
                (snp.match.len === 1 && snp.match.offset > 8) ||
                tmp.offset > 48 ||
                tmp.len > 15)))
        ) {
          snp.index = len - tmp.len;
          updateSnp(snp, totalScore, totalOffset, prevSnp, tmp, flagsProto);
        }
      }

      mp = next;
    }

    len--;
    bestCopyLen++;
  }

  return snArr;
};

export class MatchSnpEnum {
  private readonly start: SearchNode | null;
  private curr: SearchNode | null;

  constructor(start: SearchNode | null) {
    this.start = start;
    this.curr = start;
  }

  next(): Match | null {
    if (this.curr === null) {
      this.curr = this.start;
      return null;
    }

    const val = this.curr.match;
    if (val.len === 0) {
      this.curr = this.start;
      return null;
    }
    this.curr = this.curr.prev;
    return val;
  }
}
