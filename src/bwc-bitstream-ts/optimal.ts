// Optimal parser for the BWC bit-stream format.
//
// Backwards DP: cost[i][op] = minimum bits to encode input[i..end] when
// the runtime cmp_op equals `op` at position i. Token choices at i:
//   - plain literal     (only when input[i].high != op)
//   - update literal    (only when input[i].high == op)
//   - near-LZ length 2  (when an in-range match exists)
//   - LZ-far length ≥ 3 (greedy longest match)
//   - lit_table run     (consecutive same byte that lives in lit_table)
//   - end-of-stream     (terminal)
//
// Cmp_op state is needed because the update path mutates cmp_op for all
// future tokens. With N1=2 there are 4 possible op values; the table
// has 4·N cells, manageable for chunk sizes ≤ 16 KB.

import type { LiteralTableLookup } from "./optimal-types.js";

export type ChoiceTag =
  | { type: "lit" }                                       // plain literal
  | { type: "upd"; newOp: number }                        // update literal
  | { type: "near"; distLow: number; distance: number }    // near-LZ (length=2)
  | { type: "lzfar"; length: number; distLow: number; distHigh: number; distance: number }
  | { type: "litrun"; length: number; idx: number }       // lit_table run
  | { type: "eos" };

export interface OptimalParams {
  n1: number;
  n2: number;
  n3: number;
  n4: number;
  maxDistance: number;
  destBase: number;
  litLookup: LiteralTableLookup;
}

const INF = Number.POSITIVE_INFINITY;

function bitLength(v: number): number {
  let r = 0;
  while (v > 0) { r += 1; v >>= 1; }
  return r;
}

// Bit cost of gamma-encoded value v with cap N2.
function gammaBits(v: number, n2: number): number {
  if (v < 1) return INF;
  const rank = bitLength(v);
  if (rank > n2) return INF;
  if (rank < n2) return (rank - 1) + 1 + (rank - 1); // ones + sep + raw
  return (rank - 1) + (rank - 1);                     // capped: no sep
}

// Compute distance fields for an LZ back-reference. Returns null if the
// distance produces a v2 that collides with the EOS marker (2*N3-1) or
// falls outside the gamma range.
function lzFarDist(destBase: number, pos: number, src: number, n2: number, n3: number, n4: number) {
  const destLo = (destBase + pos) & 0xff;
  const destHi = ((destBase + pos) >> 8) & 0xff;
  const srcLo = (destBase + src) & 0xff;
  const srcHi = ((destBase + src) >> 8) & 0xff;
  const distLow = (srcLo - destLo) & 0xff;
  const c = srcLo < destLo ? 1 : 0;
  // dist_high in stream = ((v2-1) << N4) | extra. With N4=0, dist_high = v2-1.
  const distHigh = (destHi - srcHi - (1 - c)) & 0xff;
  if (n4 !== 0) return null; // we only support N4=0 in v1
  const v2 = distHigh + 1;
  const eos = 2 * n3 - 1;
  if (v2 < 1 || v2 > (1 << n2) - 1 || v2 === eos) return null;
  return { distLow, distHigh, v2 };
}

// Find the best LZ-far match at `pos`. Returns null if no match of
// length >= 3 fits in the encodable distance window.
function bestLzFar(input: Uint8Array, pos: number, p: OptimalParams, maxLen: number): { length: number; distance: number; distLow: number; distHigh: number; bits: number } | null {
  const remaining = input.length - pos;
  const lookAhead = Math.min(maxLen, remaining);
  if (lookAhead < 3 || pos < 1) return null;
  const minStart = Math.max(0, pos - p.maxDistance);
  let best: { length: number; distance: number; distLow: number; distHigh: number; bits: number } | null = null;
  for (let src = pos - 1; src >= minStart; src--) {
    let len = 0;
    while (len < lookAhead && input[src + len] === input[pos + len]) len += 1;
    if (len < 3) continue;
    const d = lzFarDist(p.destBase, pos, src, p.n2, p.n3, p.n4);
    if (!d) continue;
    const bits = p.n1 + gammaBits(len - 1, p.n2) + gammaBits(d.v2, p.n2) + p.n4 + 8;
    if (!best || bits < best.bits || (bits === best.bits && len > best.length)) {
      best = { length: len, distance: pos - src, distLow: d.distLow, distHigh: d.distHigh, bits };
    }
    if (len >= maxLen) break;
  }
  return best;
}

// Find the best near-LZ (length-2) match at pos, distance in [1, 256].
function bestNear(input: Uint8Array, pos: number): { distance: number; distLow: number } | null {
  if (pos + 2 > input.length || pos < 1) return null;
  const a = input[pos]!;
  const b = input[pos + 1]!;
  const minStart = Math.max(0, pos - 256);
  for (let src = pos - 1; src >= minStart; src--) {
    if (input[src] === a && input[src + 1] === b) {
      const d = pos - src;
      return { distance: d, distLow: (-d) & 0xff };
    }
  }
  return null;
}

// Compute the same-byte run length starting at pos.
function runLength(input: Uint8Array, pos: number): number {
  if (pos >= input.length) return 0;
  let r = 1;
  const b = input[pos]!;
  while (pos + r < input.length && input[pos + r] === b) r += 1;
  return r;
}

const MAX_LZ_LEN = 128; // gamma cap for length-1 with N2=8

export interface OptimalResult {
  // Reconstructed token list (in encoding order).
  tokens: Array<{ pos: number; opAtEntry: number; choice: ChoiceTag }>;
  totalBits: number;
}

export function optimalParse(input: Uint8Array, initialOp: number, p: OptimalParams): OptimalResult {
  const N = input.length;
  const opCount = 1 << p.n1;

  // cost[i][op] minimum bits to encode input[i..end] given op at i.
  // Stored as Float64Array per layer — flat 2D arr.
  const cost = new Float64Array((N + 1) * opCount).fill(INF);
  const choice: Array<Array<ChoiceTag | null>> = [];
  for (let i = 0; i <= N; i++) {
    choice.push(new Array(opCount).fill(null));
  }
  const idx2 = (i: number, op: number) => i * opCount + op;

  // Base case: at i = N, emit EOS regardless of op.
  // EOS cost: cmp_op (N1) + gamma(2) + gamma(2*N3-1).
  const eosBits = p.n1 + gammaBits(2, p.n2) + gammaBits(2 * p.n3 - 1, p.n2);
  for (let op = 0; op < opCount; op++) {
    cost[idx2(N, op)] = eosBits;
    choice[N]![op] = { type: "eos" };
  }

  // Lit_table cost per length L for an idx>0 byte.
  // bits = N1 + gamma(1) + bit_a + bit_b + gamma(L-1) + gamma(idx)
  //      = N1 + 1 + 1 + 1 + gamma(L-1) + gamma(idx)
  function litRunBits(L: number, idx: number): number {
    return p.n1 + 1 + 1 + 1 + gammaBits(L - 1, p.n2) + gammaBits(idx, p.n2);
  }

  for (let i = N - 1; i >= 0; i--) {
    const byte = input[i]!;
    const high = byte >> (8 - p.n1);

    // Pre-compute a single LZ-far match candidate (greedy longest).
    const lz = bestLzFar(input, i, p, Math.min(MAX_LZ_LEN, N - i));
    const near = bestNear(input, i);
    const run = runLength(input, i);
    const litIdx = p.litLookup[byte]!;
    const maxLitRun = Math.min(run, p.n3); // length-1 < N3 keeps short path

    for (let op = 0; op < opCount; op++) {
      let best = INF;
      let pick: ChoiceTag | null = null;

      // (a) Plain literal — only if no cmp_op collision.
      if (high !== op) {
        const c = 8 + cost[idx2(i + 1, op)]!;
        if (c < best) { best = c; pick = { type: "lit" }; }
      } else {
        // (b) Update literal — only when collision; pick best newOp.
        for (let nop = 0; nop < opCount; nop++) {
          const c = (1 + 1 + 1 + 2 * p.n1 + (8 - p.n1)) + cost[idx2(i + 1, nop)]!;
          // = 1 (gamma(1)) + 1 (bit_a) + 1 (bit_b) + N1 (cmp_op token at start) + N1 (newOp) + (8-N1) (low bits)
          // = 3 + N1 + 8 = 11 + N1 = 13 with N1=2
          if (c < best) { best = c; pick = { type: "upd", newOp: nop }; }
        }
      }

      // (c) Near-LZ length=2 — does not change cmp_op.
      if (near && i + 2 <= N) {
        const c = (p.n1 + 1 + 1 + 8) + cost[idx2(i + 2, op)]!;
        // = N1 (token) + 1 (gamma(1)) + 1 (bit_a=0) + 8 (dist_low) = N1 + 10
        if (c < best) {
          best = c;
          pick = { type: "near", distLow: near.distLow, distance: near.distance };
        }
      }

      // (d) LZ-far — does not change cmp_op.
      if (lz && i + lz.length <= N) {
        const c = lz.bits + cost[idx2(i + lz.length, op)]!;
        if (c < best) {
          best = c;
          pick = { type: "lzfar", length: lz.length, distLow: lz.distLow, distHigh: lz.distHigh, distance: lz.distance };
        }
      }

      // (e) Lit_table run — does not change cmp_op. Only valid when
      // byte is in the table and run-length >= 2.
      if (litIdx > 0 && maxLitRun >= 2) {
        // Try a few useful lengths: full run, and shorter prefixes that
        // might leave room for a better tail. We sample length endpoints
        // at every gamma-bracket boundary (rank changes) to keep work
        // bounded — for runs up to 128 this is at most ~7 choices.
        const lengths = new Set<number>();
        // Always consider the full run (greedy max).
        lengths.add(maxLitRun);
        // Sample at powers of two within [2, maxLitRun].
        for (let pow = 2; pow <= maxLitRun; pow <<= 1) lengths.add(pow);
        // And at min length 2.
        lengths.add(2);
        for (const L of lengths) {
          if (L < 2 || L > maxLitRun) continue;
          const c = litRunBits(L, litIdx) + cost[idx2(i + L, op)]!;
          if (c < best) {
            best = c;
            pick = { type: "litrun", length: L, idx: litIdx };
          }
        }
      }

      cost[idx2(i, op)] = best;
      choice[i]![op] = pick;
    }
  }

  // Reconstruct token sequence.
  const tokens: Array<{ pos: number; opAtEntry: number; choice: ChoiceTag }> = [];
  let i = 0;
  let op = initialOp;
  while (i < N) {
    const c = choice[i]![op];
    if (!c) throw new Error(`optimalParse: no choice at i=${i} op=${op}`);
    tokens.push({ pos: i, opAtEntry: op, choice: c });
    switch (c.type) {
      case "lit":
        i += 1;
        break;
      case "upd":
        i += 1;
        op = c.newOp;
        break;
      case "near":
        i += 2;
        break;
      case "lzfar":
        i += c.length;
        break;
      case "litrun":
        i += c.length;
        break;
      case "eos":
        break;
    }
  }
  // Final EOS token.
  tokens.push({ pos: N, opAtEntry: op, choice: choice[N]![op]! });

  return { tokens, totalBits: cost[idx2(0, initialOp)]! };
}
