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
import { optimalParse, type ChoiceTag } from "./optimal.js";

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
  // Literal-table size. 0 disables lit_table-run encoding entirely.
  // 1..31 reserves Y bytes in the header for the most-frequent bytes
  // in the input; runs of those bytes are emitted via the bit_b=1
  // table-run path which costs ~7-14 bits per run vs N*8 bits as
  // plain literals. Index 32 in the depacker reads $0120 (out of the
  // table window), so we cap encoder use at 31. Default 16.
  literalTableSize?: number;
  // Use optimal parsing (DP with cmp_op state) instead of greedy.
  // Optimal trades a small CPU cost for ~3-7% smaller output. Default true.
  optimal?: boolean;
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
    lzNearMatches: number;
    lzBytesCovered: number;
    litRunMatches: number;
    litRunBytesCovered: number;
    litTableSize: number;
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

// Build a literal table of up to maxY bytes, picked by descending
// frequency. Returns the table and a 256-entry lookup that maps a byte
// value to its 1-based table index (or 0 if the byte is not in the
// table). Y is capped at 31 — index 32 in the depacker reads beyond the
// loaded table window and triggers the "extra bits" branch we don't
// emit.
function buildLitTable(input: Uint8Array, maxY: number): { table: Uint8Array; lookup: Int16Array } {
  const cap = Math.min(31, Math.max(0, maxY | 0));
  const lookup = new Int16Array(256); // 0 = not in table; 1..cap = idx
  if (cap === 0) return { table: new Uint8Array(0), lookup };
  // Score each byte by total run-bytes-covered (length>=2 same-byte runs).
  // Falls back to plain frequency when a byte never appears in a run.
  const runCover = new Int32Array(256);
  const freq = new Int32Array(256);
  let i = 0;
  while (i < input.length) {
    const b = input[i]!;
    freq[b]! += 1;
    let j = i + 1;
    while (j < input.length && input[j] === b) j += 1;
    const runLen = j - i;
    if (runLen >= 2) runCover[b]! += runLen;
    i = j;
  }
  const candidates: Array<{ b: number; score: number }> = [];
  for (let b = 0; b < 256; b++) {
    const score = runCover[b]! * 8 + freq[b]!; // weight runs heavily
    if (score > 0) candidates.push({ b, score });
  }
  candidates.sort((a, c) => c.score - a.score);
  const picked = candidates.slice(0, cap).map((c) => c.b);
  const table = Uint8Array.from(picked);
  for (let k = 0; k < table.length; k++) lookup[table[k]!]! = k + 1;
  return { table, lookup };
}

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

// Find a length-2 LZ match with distance in [1, 256] (encodable as
// near-LZ). Returns the smallest such distance — closer matches keep
// the search window tight and let later matches stay short. Returns
// null when no eligible 2-byte match exists.
function findNearMatch(input: Uint8Array, pos: number): Match | null {
  if (pos < 1 || pos + 2 > input.length) return null;
  const a = input[pos]!;
  const b = input[pos + 1]!;
  const minStart = Math.max(0, pos - 256);
  for (let src = pos - 1; src >= minStart; src--) {
    if (input[src] === a && input[src + 1] === b) {
      return { length: 2, distance: pos - src };
    }
  }
  return null;
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

// Literal-table run: emits `length` copies of a byte that lives at index
// `idx` (1..Y) of the literal table, via the bit_b=1 short-path branch.
// The depacker decode path:
//   cmp_op token → gamma(1) → bit_a=1 → bit_b=1 → iny → gamma(length-1)
//   → cmp #N3 (skip extension if length-1 < N3) → gamma(idx) → tax →
//   lda $0100,X → cpx #$20 (skip extra-bits if idx < 32) → write A
//   `length` times.
// We use the simple subtree only: length-1 < N3 (always true for our
// gamma cap of 2^N2-1 = 255 at N2=8, since N3=128 caps the high path),
// no idx>=32 extra bits (we constrain idx to [1, Y] with Y <= 31).
function emitLitTableRun(
  bw: BitWriter,
  cmpOp: number,
  length: number,
  idx: number,
  n1: number,
): void {
  if (length < 2) throw new BwcPackError(`lit_table run length must be >= 2 (got ${length})`);
  if (length - 1 >= N3) throw new BwcPackError(`lit_table run length-1 ${length - 1} >= N3 ${N3} — extension path not implemented`);
  if (idx < 1 || idx >= 0x20) throw new BwcPackError(`lit_table idx must be in 1..31 (got ${idx})`);
  bw.writeBits(cmpOp, n1);              // cmp_op token
  emitGamma(bw, 1);                     // v1 = 1 → short path
  bw.writeBit(1);                       // bit_a = 1 → not near-LZ
  bw.writeBit(1);                       // bit_b = 1 → lit_table path
  emitGamma(bw, length - 1);            // inner = length - 1 (>= 1)
  emitGamma(bw, idx);                   // table index (1-based)
}

// Near-LZ: length implicitly 2, dist_high implicitly 0, only 8 raw bits
// for dist_low. Encoded distance must satisfy lzpos in [1, 256].
function emitLzNear(bw: BitWriter, cmpOp: number, distLow: number, n1: number): void {
  bw.writeBits(cmpOp, n1);              // cmp_op token
  emitGamma(bw, 1);                     // v1 = 1 → short path
  bw.writeBit(0);                       // bit_a = 0 → near-LZ
  bw.writeBits(distLow, 8);
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

  // Build literal table (default Y=16; 0 disables).
  const yLimit = opts.literalTableSize ?? 16;
  const { table: litTable, lookup: litLookup } = buildLitTable(input, yLimit);

  const useOptimal = opts.optimal ?? true;

  let plainLiterals = 0;
  let updateLiterals = 0;
  let lzMatches = 0;
  let lzBytesCovered = 0;
  let litRunMatches = 0;
  let litRunBytesCovered = 0;
  let lzNearMatches = 0;

  if (useOptimal) {
    // DP-based optimal parsing.
    const result = optimalParse(input, cmpOp, {
      n1, n2: N2, n3: N3, n4: N4,
      maxDistance,
      destBase: dest,
      litLookup,
    });
    for (const tok of result.tokens) {
      const c: ChoiceTag = tok.choice;
      if (c.type === "lit") {
        emitPlainLiteral(bw, input[tok.pos]!, tok.opAtEntry, n1);
        plainLiterals += 1;
      } else if (c.type === "upd") {
        emitUpdateLiteral(bw, input[tok.pos]!, tok.opAtEntry, c.newOp, n1);
        updateLiterals += 1;
        cmpOp = c.newOp;
      } else if (c.type === "near") {
        emitLzNear(bw, tok.opAtEntry, c.distLow, n1);
        lzNearMatches += 1;
        lzBytesCovered += 2;
      } else if (c.type === "lzfar") {
        emitLzFar(bw, tok.opAtEntry, c.length, c.distHigh, c.distLow, n1);
        lzMatches += 1;
        lzBytesCovered += c.length;
      } else if (c.type === "litrun") {
        emitLitTableRun(bw, tok.opAtEntry, c.length, c.idx, n1);
        litRunMatches += 1;
        litRunBytesCovered += c.length;
      } else if (c.type === "eos") {
        emitEndOfStream(bw, tok.opAtEntry, n1);
      }
    }
    // Skip the greedy loop below.
    const payloadBits = bw.bitLength();
    const payload = bw.finalize();
    const header = defaultHeader({ dest, cmpOp: initialCmpOp, n1, y: litTable.length, litTable });
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
        lzNearMatches,
        lzBytesCovered,
        litRunMatches,
        litRunBytesCovered,
        litTableSize: litTable.length,
        payloadBits,
      },
    };
  }

  let i = 0;
  while (i < input.length) {
    // Detect a same-byte run starting at i.
    let runLen = 1;
    while (i + runLen < input.length && input[i + runLen] === input[i]) runLen += 1;
    // Cap length so that (length-1) < N3 (= 128); this keeps the
    // depacker on the bcc WCA61 short path and avoids the extension
    // branch we don't emit.
    const maxRunLen = Math.min(runLen, N3);
    const tableIdx = litLookup[input[i]!]!;
    if (tableIdx > 0 && maxRunLen >= 2) {
      // Emit lit_table run. Cost: N1 + 1 + 1 + 1 + gamma(L-1) +
      // gamma(idx). For idx=1 and L=2 that's N1+5 = 7 bits → much
      // cheaper than 16 bits as 2 plain literals.
      emitLitTableRun(bw, cmpOp, maxRunLen, tableIdx, n1);
      litRunMatches += 1;
      litRunBytesCovered += maxRunLen;
      i += maxRunLen;
      continue;
    }

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

    // Try near-LZ for length-2 with distance in [1, 256]. Cost: N1+10
    // bits = 12 bits with N1=2, vs 16 bits for two plain literals.
    // Always wins when a length-2 match exists in range.
    const near = findNearMatch(input, i);
    if (near) {
      const distLow = (-near.distance) & 0xff;
      emitLzNear(bw, cmpOp, distLow, n1);
      lzNearMatches += 1;
      lzBytesCovered += 2;
      i += 2;
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
    y: litTable.length,
    litTable,
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
      lzNearMatches,
      lzBytesCovered,
      litRunMatches,
      litRunBytesCovered,
      litTableSize: litTable.length,
      payloadBits,
    },
  };
}
