import { PFLAG_4_OFFSET_TABLES, PFLAG_BITS_COPY_GT_7, TFLAG_LEN0123_SEQ_MIRRORS, TFLAG_LEN1_SEQ } from "./flags.js";
import { Match, EncodeMatchBuckets, EncodeIntBucket } from "./types.js";
import { OutputCtx } from "./output.js";
import { EncodeMatchData } from "./search.js";

interface IntervalNode {
  start: number;
  score: number;
  next: IntervalNode | null;
  prefix: number;
  bits: number;
  depth: number;
  flags: number;
}

type EncodeIntFn = (
  val: number,
  priv: IntervalNode | null,
  out: OutputCtx | null,
  eibp: EncodeIntBucket | null
) => number;

interface EncodeMatchPriv {
  flagsProto: number;
  flagsNotrait: number;

  litNum: number;
  seqNum: number;
  rleNum: number;
  litBits: number;
  seqBits: number;
  rleBits: number;

  offsetF: EncodeIntFn;
  lenF: EncodeIntFn;
  offsetFPriv: (IntervalNode | null)[];
  lenFPriv: IntervalNode | null;
}

const BIG_COST = 100000000.0;
const STATS_CAP = 1000000;

const OFFSET_ARR: Int32Array[] = Array.from({ length: 8 }, () => new Int32Array(STATS_CAP));
const OFFSET_PARR: Int32Array[] = Array.from({ length: 8 }, () => new Int32Array(STATS_CAP));
const LEN_ARR = new Int32Array(STATS_CAP);

const intervalNodeInit = (start: number, depth: number, flags: number): IntervalNode => ({
  start,
  flags,
  depth,
  bits: 0,
  prefix: flags >= 0 ? flags : depth + 1,
  score: -1,
  next: null
});

const intervalNodeClone = (inp: IntervalNode | null): IntervalNode | null => {
  if (inp === null) {
    return null;
  }
  return {
    ...inp,
    next: intervalNodeClone(inp.next)
  };
};

const intervalNodeDelete = (_inp: IntervalNode | null): void => {
  // No-op in TypeScript. GC handles chain cleanup.
};

export const optimalEncodeInt: EncodeIntFn = (arg, priv, out, eibp) => {
  let inp = priv;
  let val = BIG_COST;
  let end = 0;

  while (inp !== null) {
    end = inp.start + (1 << inp.bits);
    if (arg >= inp.start && arg < end) {
      break;
    }
    inp = inp.next;
  }

  if (inp !== null) {
    val = inp.prefix + inp.bits;
    if (eibp !== null) {
      eibp.start = inp.start;
      eibp.end = end;
    }
  } else {
    val += arg - end;
    if (eibp !== null) {
      eibp.start = 0;
      eibp.end = 0;
    }
  }

  if (out !== null) {
    if (inp === null) {
      throw new Error("optimalEncodeInt: missing interval node for output");
    }
    out.bits(inp.bits, arg - inp.start);
    if (inp.flags < 0) {
      out.gammaCode(inp.depth);
    } else {
      out.bits(inp.prefix, inp.depth);
    }
  }

  return val;
};

export const optimalEncode = (
  mp: Match,
  emd: EncodeMatchData,
  prevOffset: number,
  embp: EncodeMatchBuckets | null
): number => {
  const data = emd.priv as EncodeMatchPriv;
  const offset = data.offsetFPriv;

  let bits = 0.0;
  let eibLen: EncodeIntBucket | null = null;
  let eibOffset: EncodeIntBucket | null = null;
  if (embp !== null) {
    eibLen = embp.len;
    eibOffset = embp.offset;
  }

  if (
    mp.len > 255 &&
    (data.flagsNotrait & TFLAG_LEN0123_SEQ_MIRRORS) !== 0 &&
    (mp.len & 255) < ((data.flagsProto & PFLAG_4_OFFSET_TABLES) !== 0 ? 4 : 3)
  ) {
    bits += BIG_COST;
  }

  if (mp.offset === 0) {
    bits += 9.0 * mp.len;
    data.litNum += mp.len;
    data.litBits += bits;
  } else {
    bits += 1.0;
    if (mp.offset !== prevOffset) {
      switch (mp.len) {
        case 0:
          throw new Error("bad len");
        case 1:
          if ((data.flagsNotrait & TFLAG_LEN1_SEQ) !== 0) {
            bits += BIG_COST;
          } else {
            bits += data.offsetF(mp.offset, offset[0], emd.out as OutputCtx | null, eibOffset);
          }
          break;
        case 2:
          bits += data.offsetF(mp.offset, offset[1], emd.out as OutputCtx | null, eibOffset);
          break;
        case 3:
          if ((data.flagsProto & PFLAG_4_OFFSET_TABLES) !== 0) {
            bits += data.offsetF(mp.offset, offset[2], emd.out as OutputCtx | null, eibOffset);
            break;
          }
        // fallthrough
        default:
          bits += data.offsetF(mp.offset, offset[7], emd.out as OutputCtx | null, eibOffset);
          break;
      }
    }
    if (prevOffset > 0) {
      bits += 1.0;
      if (emd.out !== null) {
        (emd.out as OutputCtx).bits(1, mp.offset === prevOffset ? 1 : 0);
      }
    }
    bits += data.lenF(mp.len, data.lenFPriv, emd.out as OutputCtx | null, eibLen);
    if (bits > 9.0 * mp.len) {
      data.litNum += 1;
      data.litBits += bits;
    } else if (mp.offset === 1) {
      data.rleNum += 1;
      data.rleBits += bits;
    } else {
      data.seqNum += 1;
      data.seqBits += bits;
    }
  }

  if (embp !== null && eibLen !== null && eibOffset !== null) {
    if (eibLen.start + eibLen.end === 0 || eibOffset.start + eibOffset.end === 0) {
      eibLen.start = 0;
      eibLen.end = 0;
      eibOffset.start = 0;
      eibOffset.end = 0;
    }
  }

  return bits;
};

const optimize1 = (
  stats: Int32Array,
  stats2: Int32Array | null,
  maxDepth: number,
  flags: number,
  start: number,
  depth: number,
  cache: Map<number, IntervalNode | null>
): IntervalNode | null => {
  if (start < 0 || start >= stats.length || stats[start] === 0) {
    return null;
  }

  const key = start * 32 + depth;
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }

  let bestInp: IntervalNode | null = null;
  const base = intervalNodeInit(start, depth, flags);

  for (let i = 0; i < 16; i++) {
    const candidate: IntervalNode = { ...base, next: null, bits: i, score: 0 };
    const end = start + (1 << i);

    let startCount = 0;
    let endCount = 0;
    if (start < STATS_CAP) {
      startCount = stats[start];
      if (end < STATS_CAP) {
        endCount = stats[end];
      }
    }

    candidate.score = (startCount - endCount) * (candidate.prefix + candidate.bits);

    if (endCount > 0) {
      if (depth + 1 < maxDepth) {
        candidate.next = optimize1(stats, stats2, maxDepth, flags, end, depth + 1, cache);
      }
      let penalty = BIG_COST;
      if (stats2 !== null && end >= 0 && end < stats2.length) {
        penalty = stats2[end];
      }
      if (candidate.next !== null && candidate.next.score < penalty) {
        penalty = candidate.next.score;
      }
      candidate.score += penalty;
    }

    if (bestInp === null || candidate.score < bestInp.score) {
      bestInp = candidate;
    }
  }

  cache.set(key, bestInp);
  return bestInp;
};

const optimize = (
  stats: Int32Array,
  stats2: Int32Array | null,
  maxDepth: number,
  flags: number
): IntervalNode | null => {
  const cache = new Map<number, IntervalNode | null>();
  const winner = optimize1(stats, stats2, maxDepth, flags, 1, 0, cache);
  return intervalNodeClone(winner);
};

const exportHelper = (np: IntervalNode | null, depth: number): string => {
  let out = "";
  let curr = np;
  let d = depth;
  while (curr !== null) {
    out += (curr.bits & 0xf).toString(16).toUpperCase();
    curr = curr.next;
    d--;
  }
  while (d-- > 0) {
    out += "0";
  }
  return out;
};

const importHelper = (
  encoding: string,
  startAt: number,
  flags: number
): { head: IntervalNode | null; nextPos: number } => {
  let pos = startAt;
  let start = 1;
  let depth = 0;
  let head: IntervalNode | null = null;
  let tail: IntervalNode | null = null;

  while (pos < encoding.length) {
    const c = encoding[pos++];
    if (c === ",") {
      break;
    }
    const bits = parseInt(c, 16);
    if (Number.isNaN(bits)) {
      continue;
    }
    const np = intervalNodeInit(start, depth, flags);
    np.bits = bits;

    depth++;
    start += 1 << bits;

    if (head === null) {
      head = np;
    } else {
      tail!.next = np;
    }
    tail = np;
  }

  return { head, nextPos: pos };
};

export const optimalInit = (emd: EncodeMatchData, flagsNotrait: number, flagsProto: number): void => {
  const data: EncodeMatchPriv = {
    flagsProto,
    flagsNotrait,

    litNum: 0,
    seqNum: 0,
    rleNum: 0,
    litBits: 0,
    seqBits: 0,
    rleBits: 0,

    offsetF: optimalEncodeInt,
    lenF: optimalEncodeInt,
    offsetFPriv: [null, null, null, null, null, null, null, null],
    lenFPriv: null
  };
  emd.out = null;
  emd.priv = data;
};

export const optimalFree = (emd: EncodeMatchData): void => {
  const data = emd.priv as EncodeMatchPriv;
  if (!data) {
    return;
  }
  for (let i = 0; i < 8; i++) {
    intervalNodeDelete(data.offsetFPriv[i]);
    data.offsetFPriv[i] = null;
  }
  intervalNodeDelete(data.lenFPriv);
  data.lenFPriv = null;
};

export const optimalEncodingExport = (emd: EncodeMatchData): string => {
  const data = emd.priv as EncodeMatchPriv;
  const offsets = data.offsetFPriv;

  let out = "";
  out += exportHelper(data.lenFPriv, 16);
  out += ",";
  out += exportHelper(offsets[0], 4);
  out += ",";
  out += exportHelper(offsets[1], 16);
  if ((data.flagsProto & PFLAG_4_OFFSET_TABLES) !== 0) {
    out += ",";
    out += exportHelper(offsets[2], 16);
  }
  out += ",";
  out += exportHelper(offsets[7], 16);
  return out;
};

export const optimalEncodingImport = (emd: EncodeMatchData, encoding: string): void => {
  const old = emd.priv as EncodeMatchPriv;
  const flagsNotrait = old.flagsNotrait;
  const flagsProto = old.flagsProto;

  optimalFree(emd);
  optimalInit(emd, flagsNotrait, flagsProto);

  const data = emd.priv as EncodeMatchPriv;
  const offsets = data.offsetFPriv;

  let pos = 0;

  const lens = importHelper(encoding, pos, -1);
  data.lenFPriv = lens.head;
  pos = lens.nextPos;

  const o1 = importHelper(encoding, pos, 2);
  offsets[0] = o1.head;
  pos = o1.nextPos;

  const o2 = importHelper(encoding, pos, 4);
  offsets[1] = o2.head;
  pos = o2.nextPos;

  if ((data.flagsProto & PFLAG_4_OFFSET_TABLES) !== 0) {
    const o3 = importHelper(encoding, pos, 4);
    offsets[2] = o3.head;
    pos = o3.nextPos;
  }

  const o7 = importHelper(encoding, pos, 4);
  offsets[7] = o7.head;
};

export const optimalOptimize = (
  emd: EncodeMatchData,
  enumNext: (enumData: unknown) => Match | null,
  enumData: unknown
): void => {
  const data = emd.priv as EncodeMatchPriv;
  const offset = data.offsetFPriv;

  for (let j = 0; j < 8; j++) {
    OFFSET_ARR[j].fill(0);
    OFFSET_PARR[j].fill(0);
  }
  LEN_ARR.fill(0);

  let mp: Match | null;
  while ((mp = enumNext(enumData)) !== null) {
    if (mp.offset > 0) {
      LEN_ARR[mp.len] += 1;
    }
  }

  for (let i = 65534; i >= 0; --i) {
    LEN_ARR[i] += LEN_ARR[i + 1];
  }

  data.lenFPriv = optimize(LEN_ARR, null, 16, -1);

  while ((mp = enumNext(enumData)) !== null) {
    if (mp.offset > 0) {
      let threshold = mp.len * 9;
      threshold -= 1 + Math.trunc(optimalEncodeInt(mp.len, data.lenFPriv, null, null));
      switch (mp.len) {
        case 0:
          throw new Error("bad len");
        case 1:
          OFFSET_PARR[0][mp.offset] += threshold;
          OFFSET_ARR[0][mp.offset] += 1;
          break;
        case 2:
          OFFSET_PARR[1][mp.offset] += threshold;
          OFFSET_ARR[1][mp.offset] += 1;
          break;
        case 3:
          if ((data.flagsProto & PFLAG_4_OFFSET_TABLES) !== 0) {
            OFFSET_PARR[2][mp.offset] += threshold;
            OFFSET_ARR[2][mp.offset] += 1;
            break;
          }
        // fallthrough
        default:
          OFFSET_PARR[7][mp.offset] += threshold;
          OFFSET_ARR[7][mp.offset] += 1;
          break;
      }
    }
  }

  for (let i = STATS_CAP - 2; i >= 0; --i) {
    for (let j = 0; j < 8; ++j) {
      OFFSET_ARR[j][i] += OFFSET_ARR[j][i + 1];
      OFFSET_PARR[j][i] += OFFSET_PARR[j][i + 1];
    }
  }

  offset[0] = optimize(OFFSET_ARR[0], OFFSET_PARR[0], 1 << 2, 2);
  offset[1] = optimize(OFFSET_ARR[1], OFFSET_PARR[1], 1 << 4, 4);
  offset[2] = optimize(OFFSET_ARR[2], OFFSET_PARR[2], 1 << 4, 4);
  offset[3] = optimize(OFFSET_ARR[3], OFFSET_PARR[3], 1 << 4, 4);
  offset[4] = optimize(OFFSET_ARR[4], OFFSET_PARR[4], 1 << 4, 4);
  offset[5] = optimize(OFFSET_ARR[5], OFFSET_PARR[5], 1 << 4, 4);
  offset[6] = optimize(OFFSET_ARR[6], OFFSET_PARR[6], 1 << 4, 4);
  offset[7] = optimize(OFFSET_ARR[7], OFFSET_PARR[7], 1 << 4, 4);
};

const intervalOut = (out: OutputCtx, inp1: IntervalNode | null, size: number, flagsProto: number): void => {
  const buffer = new Uint8Array(256);
  let count = 0;
  let inp = inp1;
  while (inp !== null) {
    count++;
    buffer[buffer.length - count] = inp.bits & 0xff;
    inp = inp.next;
  }

  while (size > 0) {
    const b = buffer[buffer.length - size];
    if ((flagsProto & PFLAG_BITS_COPY_GT_7) !== 0) {
      out.bits(1, b >> 3);
      out.bits(3, b & 7);
    } else {
      out.bits(4, b);
    }
    size--;
  }
};

export const optimalOut = (out: OutputCtx, emd: EncodeMatchData): void => {
  const data = emd.priv as EncodeMatchPriv;
  const offset = data.offsetFPriv;
  const len = data.lenFPriv;

  intervalOut(out, offset[0], 4, data.flagsProto);
  intervalOut(out, offset[1], 16, data.flagsProto);
  if ((data.flagsProto & PFLAG_4_OFFSET_TABLES) !== 0) {
    intervalOut(out, offset[2], 16, data.flagsProto);
  }
  intervalOut(out, offset[7], 16, data.flagsProto);
  intervalOut(out, len, 16, data.flagsProto);
};
