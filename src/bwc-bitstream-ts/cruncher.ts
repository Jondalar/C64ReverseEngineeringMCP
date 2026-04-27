// BWC bit-stream cruncher.
//
// Produces output that the original BWC depacker at $C992 can decompress
// back to the input. Not byte-identical to any specific reference packer
// (the original BWC packer is unknown); the goal is "depacks via $C992
// to the same bytes".
//
// Token vocabulary used by this encoder:
//
//   - Plain literal: high N1 bits != cmp_op → emit (N1 + 8-N1) bits = 8.
//   - cmp_op-update literal: high N1 bits == cmp_op → emit cmp_op token,
//     gamma(1), bit_a=1, bit_b=0, then N1 bits = new cmp_op, then
//     (8-N1) bits = low bits of the byte.
//   - LZ-far back-reference: emit cmp_op token, gamma(length-1) with
//     length-1 >= 2, gamma(dist_high+1) with dist_high+1 != 2*N3-1, then
//     N4 raw extra bits, then 8 bits dist_low.
//   - End-of-stream: emit cmp_op token, gamma(1) wait — that's
//     short-path. Actually long-path EOS: cmp_op token, gamma(v1) with
//     v1>=2 (so we go long-path), gamma(2*N3-1).
//
// Skipped (not necessary for correctness, only for ratio):
//   - Near-LZ short path (length-2 with dist_high implicitly 0).
//   - Literal-table path (would require lit_table[] usage).
//
// We hard-code N2=8, N3=128, N4=0, matching all observed BWC v1.0.6
// chunks. N1 is configurable; default 2.

import { BitWriter } from "./bit-writer.js";
import { defaultHeader, serializeHeader, type BwcHeader } from "./header.js";

export interface PackOptions {
  // Destination address (goes into the header).
  dest: number;
  // Bit-width of the main token. 1..7 supported (8 would leave no room
  // for the residual bits and is unimplemented). Default 2.
  n1?: number;
  // Maximum back-reference search distance (bytes). Default 0xFFFF.
  maxDistance?: number;
  // Optional 4-byte skip4 (ASCII "pu" + 2 opaque bytes). Default
  // [70, 75, 00, 00].
  skip4?: Uint8Array;
  // Optional 2-byte unused2 — must roundtrip if you care about bit-for-bit
  // equality with an original. Default [FF, FF] (matches BWC observed).
  unused2?: Uint8Array;
}

export interface PackResult {
  packed: Uint8Array;
  header: BwcHeader;
  // Diagnostic counts.
  stats: {
    inputBytes: number;
    plainLiterals: number;
    updateLiterals: number;
    lzMatches: number;
    lzBytesCovered: number;
    payloadBits: number;
  };
}

export class BwcPackError extends Error {}

const N2 = 8;
const N3 = 128;
const N4 = 0;
const EOS_VALUE = 2 * N3 - 1; // 255 — must be representable with N2=8

// ---------------------------------------------------------------------------
// Gamma encoding
// ---------------------------------------------------------------------------

function bitLength(v: number): number {
  if (v <= 0) throw new BwcPackError(`gamma: value must be >= 1 (got ${v})`);
  let r = 0;
  while (v > 0) { r += 1; v >>= 1; }
  return r;
}

// Emit gamma-encoded `value` (>= 1, <= 2^N2 - 1).
function emitGamma(bw: BitWriter, value: number): void {
  if (value < 1) throw new BwcPackError(`gamma value ${value} < 1`);
  const rank = bitLength(value);
  const maxRank = N2;
  if (rank > maxRank) {
    throw new BwcPackError(`gamma value ${value} exceeds N2=${N2} cap (max ${(1 << N2) - 1})`);
  }
  if (rank < maxRank) {
    // (rank-1) ones, separator 0, (rank-1) low bits MSB-first.
    for (let i = 0; i < rank - 1; i++) bw.writeBit(1);
    bw.writeBit(0);
    if (rank - 1 > 0) bw.writeBits(value & ((1 << (rank - 1)) - 1), rank - 1);
  } else {
    // Cap: (rank-1) ones, NO separator, (rank-1) low bits MSB-first.
    for (let i = 0; i < rank - 1; i++) bw.writeBit(1);
    if (rank - 1 > 0) bw.writeBits(value & ((1 << (rank - 1)) - 1), rank - 1);
  }
}

// ---------------------------------------------------------------------------
// cmp_op selection
// ---------------------------------------------------------------------------

function pickCmpOp(input: Uint8Array, n1: number, fromIndex = 0): number {
  const buckets = new Array<number>(1 << n1).fill(0);
  for (let i = fromIndex; i < input.length; i++) {
    buckets[input[i]! >> (8 - n1)]! += 1;
  }
  let best = 0;
  let bestCount = buckets[0]!;
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i]! < bestCount) { best = i; bestCount = buckets[i]!; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// LZ matcher — naive O(n^2) per position. Fine for the chunk sizes we see
// (BWC max chunk = ~16 KB).
// ---------------------------------------------------------------------------

interface Match { length: number; distance: number; }

const MAX_MATCH = 128; // length-1 must fit gamma with N2=8 → max length-1 = 127

function findBestMatch(
  input: Uint8Array,
  pos: number,
  destBase: number,
  maxDistance: number,
): Match | null {
  if (pos < 1) return null;
  const remaining = input.length - pos;
  const lookAhead = Math.min(MAX_MATCH, remaining);
  if (lookAhead < 3) return null;

  let best: Match | null = null;
  const minStart = Math.max(0, pos - maxDistance);
  for (let src = pos - 1; src >= minStart; src--) {
    let len = 0;
    while (len < lookAhead && input[src + len] === input[pos + len]) len += 1;
    if (len < 3) continue;
    if (best && len <= best.length) continue;
    const distance = pos - src;
    // Verify the dist_high is encodable (gamma + EOS exclusion).
    const destLo = (destBase + pos) & 0xff;
    const destHi = ((destBase + pos) >> 8) & 0xff;
    const srcLo = (destBase + src) & 0xff;
    const srcHi = ((destBase + src) >> 8) & 0xff;
    const distLow = (srcLo - destLo) & 0xff;
    const c = srcLo < destLo ? 1 : 0;
    const distHigh = (destHi - srcHi - (1 - c)) & 0xff;
    const v2 = distHigh + 1;
    if (v2 < 1 || v2 > (1 << N2) - 1 || v2 === EOS_VALUE) continue;
    best = { length: len, distance };
    if (len >= MAX_MATCH) break; // can't beat this
  }
  return best;
}

// Recompute dist fields for a chosen match.
function distanceFields(destBase: number, pos: number, src: number) {
  const destLo = (destBase + pos) & 0xff;
  const destHi = ((destBase + pos) >> 8) & 0xff;
  const srcLo = (destBase + src) & 0xff;
  const srcHi = ((destBase + src) >> 8) & 0xff;
  const distLow = (srcLo - destLo) & 0xff;
  const c = srcLo < destLo ? 1 : 0;
  const distHigh = (destHi - srcHi - (1 - c)) & 0xff;
  return { distLow, distHigh };
}

// ---------------------------------------------------------------------------
// Token emit helpers
// ---------------------------------------------------------------------------

function emitPlainLiteral(bw: BitWriter, byte: number, cmpOp: number, n1: number): void {
  const high = byte >> (8 - n1);
  if (high === cmpOp) {
    throw new BwcPackError(`emitPlainLiteral called with collision byte ${byte.toString(16)} for cmp_op=${cmpOp}`);
  }
  bw.writeBits(high, n1);
  bw.writeBits(byte & ((1 << (8 - n1)) - 1), 8 - n1);
}

function emitUpdateLiteral(
  bw: BitWriter,
  byte: number,
  oldCmpOp: number,
  newCmpOp: number,
  n1: number,
): void {
  if ((byte >> (8 - n1)) !== oldCmpOp) {
    throw new BwcPackError(`emitUpdateLiteral byte ${byte.toString(16)} doesn't have high bits == cmp_op`);
  }
  bw.writeBits(oldCmpOp, n1);          // cmp_op token
  emitGamma(bw, 1);                     // v1 = 1 → short path
  bw.writeBit(1);                       // bit_a = 1 → not near-LZ
  bw.writeBit(0);                       // bit_b = 0 → cmp_op-update path
  bw.writeBits(newCmpOp, n1);          // new cmp_op
  bw.writeBits(byte & ((1 << (8 - n1)) - 1), 8 - n1);
}

function emitLzFar(
  bw: BitWriter,
  cmpOp: number,
  length: number,
  distHigh: number,
  distLow: number,
  n1: number,
): void {
  if (length < 3) throw new BwcPackError(`LZ-far requires length >= 3, got ${length}`);
  if (length - 1 > (1 << N2) - 1) throw new BwcPackError(`length-1 ${length - 1} exceeds gamma cap`);
  const v2 = distHigh + 1;
  if (v2 < 1 || v2 > (1 << N2) - 1 || v2 === EOS_VALUE) {
    throw new BwcPackError(`distHigh+1=${v2} not representable (must be 1..${(1 << N2) - 1} \\ ${EOS_VALUE})`);
  }
  bw.writeBits(cmpOp, n1);
  emitGamma(bw, length - 1);            // v1 (>=2 for long path)
  emitGamma(bw, v2);                    // dist_high+1
  // N4=0 → no extra bits.
  bw.writeBits(distLow, 8);
}

function emitEndOfStream(bw: BitWriter, cmpOp: number, n1: number): void {
  bw.writeBits(cmpOp, n1);
  // Need v1 >= 2 to go long-path. Encode v1=2 (smallest long).
  emitGamma(bw, 2);
  emitGamma(bw, EOS_VALUE);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function pack(input: Uint8Array, opts: PackOptions): PackResult {
  const n1 = opts.n1 ?? 2;
  if (n1 < 1 || n1 > 7) throw new BwcPackError(`n1 must be in 1..7 (got ${n1})`);
  const maxDistance = opts.maxDistance ?? 0xffff;

  let cmpOp = pickCmpOp(input, n1);
  const initialCmpOp = cmpOp;
  const dest = opts.dest & 0xffff;
  const bw = new BitWriter();

  let plainLiterals = 0;
  let updateLiterals = 0;
  let lzMatches = 0;
  let lzBytesCovered = 0;

  let i = 0;
  while (i < input.length) {
    const match = findBestMatch(input, i, dest, maxDistance);
    if (match && match.length >= 3) {
      const src = i - match.distance;
      const { distLow, distHigh } = distanceFields(dest, i, src);
      emitLzFar(bw, cmpOp, match.length, distHigh, distLow, n1);
      lzMatches += 1;
      lzBytesCovered += match.length;
      i += match.length;
      continue;
    }

    // Literal path.
    const byte = input[i]!;
    const high = byte >> (8 - n1);
    if (high !== cmpOp) {
      emitPlainLiteral(bw, byte, cmpOp, n1);
      plainLiterals += 1;
    } else {
      // Pick a new cmp_op that's rare in the remainder.
      const newCmpOp = pickCmpOp(input, n1, i + 1);
      emitUpdateLiteral(bw, byte, cmpOp, newCmpOp, n1);
      cmpOp = newCmpOp;
      updateLiterals += 1;
    }
    i += 1;
  }

  emitEndOfStream(bw, cmpOp, n1);

  const payloadBits = bw.bitLength();
  const payload = bw.finalize();

  const header = defaultHeader({
    dest,
    cmpOp: initialCmpOp,
    n1,
    y: 0,
    litTable: new Uint8Array(0),
  });
  if (opts.skip4) {
    if (opts.skip4.length !== 4) throw new BwcPackError(`skip4 must be 4 bytes`);
    header.skip4 = opts.skip4.slice();
  }
  if (opts.unused2) {
    if (opts.unused2.length !== 2) throw new BwcPackError(`unused2 must be 2 bytes`);
    header.unused2 = opts.unused2.slice();
  }

  const headerBytes = serializeHeader(header);
  const out = new Uint8Array(headerBytes.length + payload.length);
  out.set(headerBytes, 0);
  out.set(payload, headerBytes.length);
  return {
    packed: out,
    header,
    stats: {
      inputBytes: input.length,
      plainLiterals,
      updateLiterals,
      lzMatches,
      lzBytesCovered,
      payloadBits,
    },
  };
}
