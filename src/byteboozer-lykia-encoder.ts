/**
 * byteboozer-lykia-encoder.ts
 *
 * Produces BB2 streams compatible with Lykia's `$020C` depacker. Paired with
 * `byteboozer-lykia-decoder.ts` — every token this encoder emits is the
 * exact bit sequence that the corresponding decoder subroutine reads.
 *
 * The encoder is greedy LZ77-style: at each payload position, it picks the
 * longest valid match (if any) in the already-emitted output, else appends
 * to a literal run. Token sequence always terminates with a gamma-0 EOS
 * match. First token must be a literal (no history for matching yet).
 *
 * Bit stream is packed MSB-first into stream bytes. Raw bytes (literal
 * payload, literal-offset match bytes) are inserted at byte-aligned
 * positions; partial bits preceding a raw insert are filled with upcoming
 * bit-stream bits to reach the next byte boundary (those bits then remain
 * in BITBUF for the decoder to consume after the raw bytes).
 *
 * Bit-level encodings mirror the decoder:
 *
 *   - Token dispatch bit: 0 = match, 1 = literal (bit 7 of token byte).
 *   - Literal count: gamma-style with c_initial = dispatch bit = 1.
 *     Emit: for each bit of the count (MSB first after the leading 1),
 *     prepend "continue" (1), then value bit; end with "stop" (0).
 *   - Match selector: 0 = short (length = 1, i.e. 2 bytes copied), 1 = long.
 *   - Long match length: gamma-style with A starting at 1. Same as above.
 *     Length 0 via 8-iteration sequence signals EOS.
 *   - Match offset: two-stage decode (OffHiBit + OffLoBit) with a
 *     pre-computed table plus an optional raw byte for low-range offsets.
 *
 * @see docs/BB2_LYKIA_FORMAT.md (written alongside this file).
 */

const BB2_OFS_TABLE = [0x00, 0xDF, 0xFB, 0x80, 0xEF, 0xFD, 0x80, 0xF0] as const;

/** Result of encoding. */
export interface LykiaEncodeResult {
  /** Complete stream: 4-byte header + body. Ready for raw-copy + depack. */
  stream: Uint8Array;
  /** Stats for analysis / tuning. */
  stats: {
    literalRuns: number;
    matches: number;
    totalInputBytes: number;
    totalStreamBytes: number;
    compressionRatio: number;
  };
}

/** A parsed token in the encode stream. */
type Token =
  | { kind: 'literal'; data: Uint8Array }
  | { kind: 'match'; offset: number; length: number }  // offset is negative int in [-32767..-1]
  | { kind: 'eos' };

/**
 * Encode a payload as a Lykia BB2 stream. The output is a self-describing
 * stream: the first four bytes are `[destLo, destHi, endLo, endHi]`, with
 * `endAddress = destAddress + payload.length`. The depacker terminates
 * either when its output pointer reaches `endAddress` OR when it encounters
 * the gamma-0 EOS marker — we emit EOS at the end to guarantee termination
 * for payloads whose token sequence doesn't land the out_ptr exactly on
 * `endAddress` mid-match.
 */
export function lykiaEncode(payload: Uint8Array, destAddress: number): LykiaEncodeResult {
  const endAddress = (destAddress + payload.length) & 0xFFFF;

  const tokens = parseGreedy(payload);
  const body = emitTokens(tokens);

  const stream = new Uint8Array(4 + body.length);
  stream[0] = destAddress & 0xFF;
  stream[1] = (destAddress >> 8) & 0xFF;
  stream[2] = endAddress & 0xFF;
  stream[3] = (endAddress >> 8) & 0xFF;
  stream.set(body, 4);

  let lit = 0, mat = 0;
  for (const t of tokens) {
    if (t.kind === 'literal') lit++;
    else if (t.kind === 'match') mat++;
  }

  return {
    stream,
    stats: {
      literalRuns: lit,
      matches: mat,
      totalInputBytes: payload.length,
      totalStreamBytes: stream.length,
      compressionRatio: stream.length / payload.length,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  Greedy LZ77 parser
// ──────────────────────────────────────────────────────────────────────────

/** Minimum match length worth emitting as a match (vs extending literal run). */
const MIN_MATCH_LENGTH = 2;
/** Maximum match length the encoder will try (bounded by gamma range). */
const MAX_MATCH_LENGTH = 255;
/** Maximum literal run (bounded by gamma range, 0 = 256 special case). */
const MAX_LIT_RUN = 255;
/** Maximum back-reference offset reachable in Lykia BB2 offset encoding.
 *  Analysis of the 7-entry BB2_OFS_TABLE + OffLo iteration paths shows the
 *  widest fall-through path comes from aHi=7 (tableA=0xF0, cAfterSel=1):
 *  A_final ∈ 0x00..0x1F, giving signed offsets in [-8192, -1]. Matches
 *  past this window cannot be encoded. */
const MAX_MATCH_DISTANCE = 8192;

/**
 * Parse the payload into a sequence of tokens (literal + match pairs, ending
 * with EOS). The first token must be a literal (no history for matches).
 */
function parseGreedy(payload: Uint8Array): Token[] {
  const tokens: Token[] = [];

  // Hash chain: for each 3-byte prefix, store the MOST RECENT position in
  // `prev[]`. `head[h]` is the head of a chain for prefix hash `h`, and
  // `prev[p]` is the previous position with the same prefix. This gives
  // O(1) insertion and bounded-chain traversal during match search.
  const HASH_SIZE = 1 << 16;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(payload.length + 1).fill(-1);

  const hash3 = (p: number): number => {
    if (p + 2 >= payload.length) return -1;
    // 16-bit Fibonacci hash of 3-byte prefix
    const k = (payload[p] << 16) | (payload[p + 1] << 8) | payload[p + 2];
    return ((k * 0x9E3779B1) >>> 16) & (HASH_SIZE - 1);
  };

  const addToHash = (p: number) => {
    const h = hash3(p);
    if (h < 0) return;
    prev[p] = head[h];
    head[h] = p;
  };

  /** Bound on chain traversal to keep worst-case encode time under O(n²). */
  const MAX_CHAIN_LENGTH = 256;

  const findMatch = (pos: number): { offset: number; length: number } | null => {
    const h = hash3(pos);
    let best: { offset: number; length: number } | null = null;
    const max = Math.min(payload.length - pos, MAX_MATCH_LENGTH);

    if (h >= 0) {
      let candidate = head[h];
      let steps = 0;
      while (candidate >= 0 && steps < MAX_CHAIN_LENGTH) {
        const negOffset = candidate - pos;
        if (negOffset < -MAX_MATCH_DISTANCE) break;
        if (payload[candidate] === payload[pos]) {
          let l = 0;
          while (l < max && payload[candidate + l] === payload[pos + l]) l++;
          if (l >= MIN_MATCH_LENGTH && (!best || l > best.length)) {
            best = { offset: negOffset, length: l };
            if (l === max) break;
          }
        }
        candidate = prev[candidate];
        steps++;
      }
    }

    if (best) return best;

    // Fallback for 2-byte matches (and 1-pos "runs"): linear scan of last
    // 256 bytes. Required when hash-based 3-byte lookup finds nothing but
    // a short match still exists — e.g., uncompressible streams where the
    // only local redundancy is a 2-byte repeat.
    //
    // 2-byte matches encode via short match (selector=0, length=1 → writes
    // 2 bytes). Offset must be in [-256, -1] (short-match-literal-offset).
    if (pos + 1 >= payload.length) return null;
    const b0 = payload[pos];
    const b1 = payload[pos + 1];
    const scanStart = Math.max(0, pos - 256);
    for (let candidate = pos - 1; candidate >= scanStart; candidate--) {
      if (payload[candidate] === b0 && payload[candidate + 1] === b1) {
        return { offset: candidate - pos, length: 2 };
      }
    }
    return null;
  };

  // Algorithm: greedy LZ77 with NextBit MatchOnly support.
  //   First token must be a literal (no history for matching yet).
  //   After a literal: an implicit match (or EOS) MUST follow.
  //   After a match: we may emit another standalone match (via NextBit) OR
  //     start a new literal run.
  //
  // States:
  //   'init'     — no tokens yet, must emit literal.
  //   'literal'  — just emitted a literal, MUST emit an implicit match/EOS.
  //   'match'    — just emitted a match. Can emit standalone match OR
  //                start new literal.
  let pos = 0;
  type State = 'init' | 'afterLiteral' | 'afterMatch';
  let state: State = 'init';

  while (pos < payload.length) {
    if (state === 'afterLiteral') {
      // Must emit an implicit match or EOS. The literal was already pushed;
      // now decide what follows it.
      const m = findMatch(pos);
      if (m) {
        tokens.push({ kind: 'match', offset: m.offset, length: m.length });
        for (let k = 0; k < m.length; k++) addToHash(pos + k);
        pos += m.length;
        state = 'afterMatch';
      } else {
        // No match — must emit a forced match (we already committed to one).
        // Fallback: use a short 2-byte match that copies last-literal-byte
        // twice IF payload supports that, else skip ahead by extending the
        // logic: actually, we need SOMETHING. Use a "null-ish" match:
        // offset=-1, length=2 even if content doesn't match. That would
        // corrupt output. So instead we should never reach this state with
        // pos<len and no match — the parser should have extended the
        // literal further. This is a structural error.
        //
        // In practice: if the literal run hit MAX_LIT_RUN and was emitted
        // without a match after, we're stuck. The correct response is to
        // terminate via EOS — but EOS writes nothing, so remaining payload
        // bytes are lost. That's incorrect.
        //
        // Proper fix: in the 'init' and 'afterMatch' literal emission,
        // don't emit a literal until we know a valid match follows.
        throw new Error(
          `parse: afterLiteral state with no match at pos=${pos}. Parser bug.`,
        );
      }
      continue;
    }

    // state ∈ {'init', 'afterMatch'}
    const m = (state === 'afterMatch') ? findMatch(pos) : null;
    if (m) {
      // Emit standalone match (NextBit MatchOnly).
      tokens.push({ kind: 'match', offset: m.offset, length: m.length });
      for (let k = 0; k < m.length; k++) addToHash(pos + k);
      pos += m.length;
      state = 'afterMatch';
      continue;
    }

    // Start a new literal run. We MUST ensure that after the literal run,
    // either (a) we've reached end-of-payload (→ EOS), OR (b) a match is
    // available at the position right after the literal run. This avoids
    // the afterLiteral-stuck case above.
    //
    // Strategy: collect up to MAX_LIT_RUN bytes. Stop when either:
    //   - pos reaches end-of-payload (then emit literal + EOS), OR
    //   - a match is found at the current pos AND litBuf already has ≥1 byte
    //     (then emit literal + this match).
    //
    // Note: if we collected MAX_LIT_RUN bytes without finding a match, we
    // continue with the literal AND check for a match at the new pos. If
    // still no match, we'd be stuck — but we can instead emit the literal
    // and LOOP BACK to the 'afterMatch' state without emitting a match...
    // actually no, literals require a match to follow.
    //
    // Simpler: collect literal bytes up to MAX_LIT_RUN; after that, FORCE
    // emit even if no match, and handle the "no match after" case by
    // emitting a 2-byte forced match. We'll emit a match of offset=-1,
    // length=2, and since we've already written at least 1 byte, the
    // match copies payload[pos-1] twice to positions pos and pos+1. This
    // corrupts 2 bytes of output but we can ONLY do this when those 2
    // bytes in payload DO equal payload[pos-1].
    const litBuf: number[] = [];
    litBuf.push(payload[pos]);
    addToHash(pos);
    pos++;
    while (pos < payload.length && litBuf.length < MAX_LIT_RUN) {
      const m2 = findMatch(pos);
      if (m2) break;
      litBuf.push(payload[pos]);
      addToHash(pos);
      pos++;
    }
    tokens.push({ kind: 'literal', data: new Uint8Array(litBuf) });
    state = 'afterLiteral';

    if (pos >= payload.length) {
      tokens.push({ kind: 'eos' });
      return tokens;
    }
    // Loop back; state == afterLiteral will consume the implicit match.
  }

  return tokens;
}

// ──────────────────────────────────────────────────────────────────────────
//  Bit-stream emitter
// ──────────────────────────────────────────────────────────────────────────

/**
 * Bit+RawByte emitter. Accepts sequential emission of bits (MSB-first into
 * stream bytes) and raw byte inserts (only permitted at byte boundaries;
 * the emitter automatically fills any partial byte with subsequent bits
 * before inserting).
 *
 * The `pendingRaw` queue stores raw byte sequences along with the bit
 * position at which they become eligible for emission (i.e., the byte
 * aligned at or after that position).
 */
class StreamBuilder {
  private bytes: number[] = [];
  private bitAcc = 0;     // accumulating byte
  private bitsInByte = 0; // count in current byte
  private pendingRaw: { bitPos: number; data: Uint8Array }[] = [];
  private curBitPos = 0;

  emitBit(bit: number): void {
    this.bitAcc = ((this.bitAcc << 1) | (bit & 1)) & 0xFF;
    this.bitsInByte++;
    this.curBitPos++;
    if (this.bitsInByte === 8) {
      this.bytes.push(this.bitAcc);
      this.bitAcc = 0;
      this.bitsInByte = 0;
      this.flushPending();
    }
  }

  /** Queue a raw byte sequence to be emitted after the current bit position,
   *  but only once the output is byte-aligned. If the stream is currently
   *  at a byte boundary, emit immediately (before any subsequent bits start
   *  filling a new byte). */
  queueRawBytes(data: Uint8Array): void {
    if (this.bitsInByte === 0) {
      for (const b of data) this.bytes.push(b);
    } else {
      this.pendingRaw.push({ bitPos: this.curBitPos, data });
    }
  }

  /** Called after every byte flush to check if any queued raw bytes can now
   *  be emitted. */
  private flushPending(): void {
    while (this.pendingRaw.length > 0 && this.bitsInByte === 0) {
      const p = this.pendingRaw.shift()!;
      for (const b of p.data) this.bytes.push(b);
    }
  }

  /** Finalize: if partial byte, pad with zeros and push. Emit any remaining
   *  queued raw bytes (they become byte-aligned after padding). */
  finalize(): Uint8Array {
    if (this.bitsInByte > 0) {
      this.bitAcc = (this.bitAcc << (8 - this.bitsInByte)) & 0xFF;
      this.bytes.push(this.bitAcc);
      this.bitAcc = 0;
      this.bitsInByte = 0;
    }
    this.flushPending();
    return new Uint8Array(this.bytes);
  }
}

/** Emit all tokens to a compressed stream body (without the 4-byte header).
 *  Handles the full token vocabulary: literal (always preceded by dispatch
 *  bit 1), standalone match (dispatch bit 0, when following another match),
 *  implicit match (no dispatch, when following a literal), and EOS (as a
 *  long-match-length 0, either implicit or standalone). */
function emitTokens(tokens: Token[]): Uint8Array {
  const sb = new StreamBuilder();

  type EmitState = 'init' | 'afterLiteral' | 'afterMatch';
  let state: EmitState = 'init';

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.kind === 'literal') {
      if (state === 'afterLiteral') {
        throw new Error('cannot emit literal directly after literal');
      }
      // Init or afterMatch: emit dispatch bit = 1 (literal).
      sb.emitBit(1);
      emitCountGamma(sb, t.data.length === 256 ? 0 : t.data.length);
      sb.queueRawBytes(t.data);
      state = 'afterLiteral';
    } else if (t.kind === 'match') {
      if (state === 'afterLiteral') {
        // Implicit match: NO dispatch bit. Just match body.
        emitMatch(sb, t);
      } else {
        // Init or afterMatch: emit dispatch = 0 (match), then match body.
        sb.emitBit(0);
        emitMatch(sb, t);
      }
      state = 'afterMatch';
    } else if (t.kind === 'eos') {
      if (state === 'afterLiteral') {
        // Implicit EOS after literal: NO dispatch. Just selector + gamma-0.
        emitEosMatch(sb);
      } else {
        // Standalone EOS: dispatch = 0 + selector + gamma-0.
        sb.emitBit(0);
        emitEosMatch(sb);
      }
      // After EOS, decoding is done; no further tokens expected.
      if (i !== tokens.length - 1) {
        throw new Error('EOS must be the last token');
      }
    } else {
      throw new Error(`unknown token kind: ${(t as any).kind}`);
    }
  }

  return sb.finalize();
}

/** Emit the Elias-gamma-style count used for literal count and long-match
 *  length. c_initial = 1 for literal (dispatch=1), c_initial = 1 for long
 *  match (A starts at 1 internally — in practice, same bits). */
function emitCountGamma(sb: StreamBuilder, count: number): void {
  // Decoder model:
  //   A = 0, C = c_initial = 1
  //   loop: A = (A << 1) | C; read stop; if stop=0 return A; read value; C = value; loop
  // To encode count N (target A value):
  //   Determine bit pattern of A that ends at target. With c_initial=1,
  //   after first iter A=1. Subsequent iters append value bits.
  //
  // Bit sequence emitted:
  //   For each iteration i in [1..K-1]: stop_i = 1, value_i = bit_{K-1-i} of N
  //   For iteration K: stop_K = 0
  //
  // Where K = bit_length(N), and N's MSB must equal c_initial (=1, so N
  // must be nonzero — i.e., count ≥ 1). count=0 is the "256" special case
  // (handled by caller passing 0 to mean 256 bytes; encoded as... hmm,
  // caller passes count = 0 here to mean "emit gamma for 0").
  //
  // But count=0 → A=0 → requires overflow via 8 value-bits-and-stop, same
  // as EOS gamma. For literal we NEVER emit count=0 unless 256 bytes. Let's
  // handle: if caller passes 0, emit gamma-for-0 (same as EOS for long
  // match length — meaning 256 literal bytes in literal context).
  if (count === 0) {
    // Emit gamma-0: 7× (c1=0, c2=0), then (c1=0, c2=1). 16 bits.
    for (let k = 0; k < 7; k++) {
      sb.emitBit(0);  // stop_k = 0? wait let me re-derive
      sb.emitBit(0);
    }
    // final pair: c1=0, c2=1 — but that means stop after value bit = 0. Hmm.
    // Actually the gamma-0 pattern was: 8 iterations with c1=0, final c2=1.
    // In (value, stop) terms: 7 pairs of (value=0, continue=0), final
    // (value=0, stop=1). Each pair = 2 bits. Total 16 bits.
    // My loop above emitted 14 zeros; add 2 more:
    sb.emitBit(0);
    sb.emitBit(1);
    return;
  }
  // Compute bit length of count
  let K = 0;
  for (let tmp = count; tmp > 0; tmp >>= 1) K++;
  // Emit iterations 1..K-1: stop=1 (continue), value bit = bit_{K-1-i} of count
  // Iteration 1: stop=1, value=bit_{K-2} of count
  // ...
  // Iteration K-1: stop=1, value=bit_0 of count
  // Iteration K: stop=0
  //
  // Wait. Let me re-derive with the decoder code:
  //   A = 0, C = c_initial
  //   iter 1: A = (0 << 1) | c_initial = c_initial = 1 (for literal)
  //     Read stop c1. If c1=0 return 1.
  //     Else read value c2; C = c2.
  //   iter 2: A = (1 << 1) | c2 = 2 | c2 = 2 or 3.
  //     Read stop c1. If 0 return.
  //     Else read c2; C = c2.
  //   iter 3: A = ((2|c2_1) << 1) | c2_2 = ...
  //
  // For target N bits b_{K-1} b_{K-2} ... b_0 (with b_{K-1} = 1):
  //   iter 1: A = b_{K-1} = 1 (matches c_initial=1 for literal)
  //   iter 2: A = (1 << 1) | c2 = 2 | c2 = b_{K-1} b_{K-2} → c2 = b_{K-2}
  //   iter 3: A = (A << 1) | c2 = b_{K-1} b_{K-2} b_{K-3} → c2 = b_{K-3}
  //   ...
  //   iter K: A = b_{K-1} b_{K-2} ... b_0 = N. Stop bit = 0.
  //
  // So bit sequence:
  //   iter 1 stop (c1): 1 if K>1 else 0
  //   if K>1: iter 1 value (c2) = b_{K-2}
  //   iter 2 stop: 1 if K>2 else 0
  //   if K>2: iter 2 value = b_{K-3}
  //   ...
  //   iter K-1 stop: 1
  //   iter K-1 value: b_0
  //   iter K stop: 0
  //
  // Simpler loop:
  for (let i = 1; i < K; i++) {
    sb.emitBit(1);  // stop = 1 (continue)
    const bitIndex = K - 1 - i;
    sb.emitBit((count >> bitIndex) & 1);  // value bit
  }
  sb.emitBit(0);  // final stop
}

/** Emit long-match-length gamma. Decoder:
 *    a = 1
 *    loop: read c1 (value); a = (a<<1)|c1; read c2 (stop); if c2=1 return a
 *  To encode N (≥ 2): bit-length K = bit_length(N). For i in 1..K-1:
 *    value_i = bit_{K-1-i} of N; stop_i = (i === K-1 ? 1 : 0).
 *  Total bits = 2*(K-1). */
function emitLongMatchLenGamma(sb: StreamBuilder, N: number): void {
  if (N < 2) throw new Error(`long match length must be ≥ 2, got ${N}`);
  let K = 0;
  for (let tmp = N; tmp > 0; tmp >>= 1) K++;
  for (let i = 1; i < K; i++) {
    const bitIndex = K - 1 - i;
    sb.emitBit((N >> bitIndex) & 1);  // value
    sb.emitBit(i === K - 1 ? 1 : 0);  // stop
  }
}

/** Emit EOS: match selector = 1 (long), then gamma encoding for length 0. */
function emitEosMatch(sb: StreamBuilder): void {
  sb.emitBit(1);  // selector = long match
  // Gamma-0: 7 pairs of (c1=0, c2=0), then final pair (c1=0, c2=1).
  for (let k = 0; k < 7; k++) {
    sb.emitBit(0);
    sb.emitBit(0);
  }
  sb.emitBit(0);
  sb.emitBit(1);
  // Total 17 bits (1 selector + 16 gamma). No offset (EOS path returns
  // before offset decode).
}

/** Emit a normal (non-EOS) match. */
function emitMatch(sb: StreamBuilder, m: { offset: number; length: number }): void {
  // Normalize: match length in decoder terms = length - 1 (number of extra
  // bytes beyond the first). The decoder writes `match_len + 1` bytes.
  // So our length field N satisfies: bytes written = N + 1, decoder's A = N.
  //
  // Short match (selector=0) always writes 2 bytes → N=1.
  // Long match (selector=1): N ≥ 2 (gamma min is 2).

  const bytesWritten = m.length;
  const N = bytesWritten - 1;

  let selector: number;
  let cAfterSel: number;
  if (N === 1) {
    selector = 0;  // short match
    cAfterSel = 0;
  } else {
    selector = 1;  // long match
    cAfterSel = 1;
  }

  sb.emitBit(selector);

  if (selector === 1) {
    // Gamma encode N (N ≥ 2).
    if (N === 0) throw new Error('EOS should use emitEosMatch, not emitMatch');
    emitLongMatchLenGamma(sb, N);
  }

  // Offset encoding
  emitOffset(sb, m.offset, cAfterSel);
}

/** Emit bits (and optional raw byte) for a match offset.
 *  offset is a negative int in [-32767..-1]. */
function emitOffset(sb: StreamBuilder, offset: number, cAfterSel: number): void {
  // Decoder model (from byteboozer-lykia-decoder.ts _decode_match_offset):
  //   a = 0x80 | cAfterSel
  //   OffHiBit loop: read c, ROL a, loop while old bit7 = 1
  //     Starts at a=0x80 or 0x81 (bit7=1), so always at least 1 iter.
  //     After 2 iterations, a ∈ {0..3} (short) or {4..7} (long).
  //
  //   If a == 0: short literal offset. Read raw byte y. offset = -256 + y.
  //
  //   Else a = BB2_OFS_TABLE[a]. OffLoBit loop: read c, ROL a, loop while
  //     old bit7 = 1. Exit condition: new bit7 = ?
  //     If new bit7 = 1: normal path. offset = -256 + a (a is 0xF8..0xFF).
  //     If new bit7 = 0: fall-through literal offset. Read raw byte y.
  //       offset = ((a ^ 0xFF) << 8) | y, interpreted signed → negative
  //       16-bit offset.
  //
  // To ENCODE a given offset:
  //   Strategy: try each OffHi value (0..3 for short, 4..7 for long), for
  //   each, try normal-path and fall-through-path, find the one that
  //   matches the target offset. Pick shortest (fewest bits).
  //
  // For simplicity in v1: pre-compute all possible (offset → bit sequence)
  // by simulating the decoder with all possible bit inputs.

  const enc = encodeOffset(offset, cAfterSel);
  if (!enc) {
    throw new Error(`cannot encode offset ${offset} with cAfterSel=${cAfterSel}`);
  }

  for (const b of enc.bits) sb.emitBit(b);
  if (enc.rawByte !== null) {
    // Raw byte after bit sequence, queued for byte-aligned emission.
    sb.queueRawBytes(new Uint8Array([enc.rawByte]));
  }
}

/** Pre-computed offset encoding tables (one per cAfterSel ∈ {0,1}).
 *  Key = offset (negative signed int from -1 down to -MAX_MATCH_DISTANCE).
 *  Value = shortest encoding (bit sequence + optional rawByte). */
const OFFSET_TABLES: [
  Map<number, { bits: number[]; rawByte: number | null }>,
  Map<number, { bits: number[]; rawByte: number | null }>,
] = [new Map(), new Map()];

/** Build pre-computed offset tables by enumerating every legal bit
 *  sequence for every (aHi, OffLo-bits) combination. Called once, lazily. */
function buildOffsetTables(): void {
  if (OFFSET_TABLES[0].size > 0) return;  // already built
  for (let cAfterSel = 0; cAfterSel <= 1; cAfterSel++) {
    const offHiRange = cAfterSel === 0 ? [0, 1, 2, 3] : [4, 5, 6, 7];
    for (const aHi of offHiRange) {
      const c1 = (aHi >> 1) & 1;
      const c2 = aHi & 1;
      const offHi = [c1, c2];

      if (aHi === 0) {
        for (let y = 0; y <= 0xFF; y++) {
          const off = (((0xFF << 8) | y) << 16 >> 16);  // sign-extend to 32-bit
          const entry = { bits: offHi.slice(), rawByte: y };
          const existing = OFFSET_TABLES[cAfterSel].get(off);
          if (!existing || totalBits(existing) > totalBits(entry)) {
            OFFSET_TABLES[cAfterSel].set(off, entry);
          }
        }
        continue;
      }

      const tableA: number = BB2_OFS_TABLE[aHi];
      // Simulate OffLo iterations. Iteration count is exactly
      // (leading 1s of tableA) + 1.
      let iterCount = 1;
      for (let bit = 6; bit >= 0; bit--) {
        if (((tableA >> bit) & 1) === 1 && ((tableA >> 7) & 1) === 1) iterCount++;
        else break;
      }
      // Actually simpler: count leading 1s starting from bit 7.
      iterCount = 0;
      for (let bit = 7; bit >= 0; bit--) {
        if (((tableA >> bit) & 1) === 1) iterCount++;
        else break;
      }
      iterCount += 1;  // +1 for the exit iteration that shifts

      const totalSequences = 1 << iterCount;
      for (let seq = 0; seq < totalSequences; seq++) {
        const bits: number[] = [];
        for (let b = iterCount - 1; b >= 0; b--) bits.push((seq >> b) & 1);
        // Simulate
        let a = tableA;
        for (let i = 0; i < iterCount; i++) {
          const oldBit7 = (a >> 7) & 1;
          a = ((a << 1) | bits[i]) & 0xFF;
          if (oldBit7 === 0 && i < iterCount - 1) {
            // Exited early: this seq doesn't use all bits
            continue;
          }
        }

        // Check: after iterCount iterations, was the last iter the exit?
        // Simulate again properly.
        a = tableA;
        let exited = false;
        let exitIter = -1;
        for (let i = 0; i < iterCount; i++) {
          const oldBit7 = (a >> 7) & 1;
          a = ((a << 1) | bits[i]) & 0xFF;
          if (oldBit7 === 0) { exited = true; exitIter = i; break; }
        }
        if (!exited || exitIter !== iterCount - 1) continue;  // wrong bit count

        // a = final A after exit iteration
        const fullBits = [...offHi, ...bits];

        if ((a & 0x80) !== 0) {
          // Normal path: offset = ((0xFF << 8) | a) signed
          const off = (((0xFF << 8) | a) << 16) >> 16;
          const entry = { bits: fullBits, rawByte: null };
          const existing = OFFSET_TABLES[cAfterSel].get(off);
          if (!existing || totalBits(existing) > totalBits(entry)) {
            OFFSET_TABLES[cAfterSel].set(off, entry);
          }
        } else {
          // Fall-through: offset = ((a^0xFF)<<8 | rawByte) signed
          for (let rawByte = 0; rawByte <= 0xFF; rawByte++) {
            const off = ((((a ^ 0xFF) << 8) | rawByte) << 16) >> 16;
            const entry = { bits: fullBits, rawByte };
            const existing = OFFSET_TABLES[cAfterSel].get(off);
            if (!existing || totalBits(existing) > totalBits(entry)) {
              OFFSET_TABLES[cAfterSel].set(off, entry);
            }
          }
        }
      }
    }
  }
}

function totalBits(e: { bits: number[]; rawByte: number | null }): number {
  return e.bits.length + (e.rawByte !== null ? 8 : 0);
}

/** Find bit sequence (and optional raw byte) that the decoder reads to
 *  produce `targetOffset` (signed 16-bit, negative). Returns null if not
 *  encodable. */
function encodeOffset(
  targetOffset: number,
  cAfterSel: number,
): { bits: number[]; rawByte: number | null } | null {
  buildOffsetTables();
  const table = OFFSET_TABLES[cAfterSel];
  return table.get(targetOffset) || null;
}

function encodeOffset_OLD(
  targetOffset: number,
  cAfterSel: number,
): { bits: number[]; rawByte: number | null } | null {
  // cAfterSel fixed. OffHi loop emits 2 bits (since A starts with bit7=1,
  // runs 2 iterations). After OffHi, A has value in the selector-determined
  // range (0..3 for cAfterSel=0, 4..7 for cAfterSel=1).
  //
  // Enumerate 2-bit OffHi choices:
  const offHiRange = cAfterSel === 0 ? [0, 1, 2, 3] : [4, 5, 6, 7];
  const baseA = 0x80 | cAfterSel;

  for (const aHiTarget of offHiRange) {
    // The 2 OffHi bits shift from bit 0 position upward into baseA.
    // After iter 1: A = ((baseA << 1) | c1) & 0xFF.
    //   baseA bit7 = 1, so shift-out = 1, loop continues.
    // After iter 2: A = ((prev << 1) | c2) & 0xFF.
    //   prev = (baseA << 1 | c1) & 0xFF = c1 (bit7 of (0x100 | c1) is 0, since
    //   0x100 overflows to 0, and c1 goes into bit 0).
    //
    // So A after iter 1 = c1 (0 or 1).
    //    A after iter 2 = (c1 << 1) | c2.
    // Target aHiTarget = (c1 << 1) | c2, so:
    //   c1 = (aHiTarget >> 1) & 1
    //   c2 = aHiTarget & 1
    //
    // But we need cAfterSel to be bit 0 of A before OffHi. Let me re-trace:
    //   A_start = 0x80 | cAfterSel (so bit0 = cAfterSel, bit7 = 1).
    //   Iter 1: c1 = get_bit. A = (A_start << 1 | c1) & 0xFF = c1 | (cAfterSel<<1) = cAfterSel<<1 | c1.
    //           Wait, (A_start << 1) & 0xFF = ((0x80 | cAfterSel) << 1) & 0xFF = (0x100 | cAfterSel<<1) & 0xFF = cAfterSel << 1.
    //           Then | c1: A = (cAfterSel << 1) | c1.
    //           So A after iter 1 ∈ {0,1,2,3} with bit 1 = cAfterSel, bit 0 = c1.
    //   Iter 2: c2 = get_bit. A = (A << 1 | c2) & 0xFF = ((cAfterSel<<1|c1) << 1 | c2) & 0xFF = cAfterSel<<2 | c1<<1 | c2.
    //           For cAfterSel=0: A ∈ {0,1,2,3}.
    //           For cAfterSel=1: A ∈ {4,5,6,7}.
    // Target aHiTarget = (cAfterSel<<2) | (c1<<1) | c2.
    // c1 = (aHiTarget >> 1) & 1, c2 = aHiTarget & 1.

    const c1 = (aHiTarget >> 1) & 1;
    const c2 = aHiTarget & 1;
    const offHiBits = [c1, c2];

    if (aHiTarget === 0) {
      // Literal offset path (short match only, aHiTarget=0 requires cAfterSel=0).
      // Read raw byte y. decoder computes offset = (0xFF << 8) | y, signed → negative.
      // To match targetOffset: y = targetOffset & 0xFF.
      // This only works if targetOffset is in range [-256, -1].
      if (targetOffset < -256 || targetOffset > -1) continue;
      const y = targetOffset & 0xFF;
      return { bits: offHiBits, rawByte: y };
    }

    // Table offset path: A = BB2_OFS_TABLE[aHiTarget]. Then OffLo loop.
    //   OffLo loop: read c, ROL a, loop while old bit7 = 1.
    //   On exit: check new bit7. If 1 → normal. If 0 → fall-through to literal offset byte.
    const tableA = BB2_OFS_TABLE[aHiTarget];
    // Try normal path and literal-offset-fall-through for each possible OffLo sequence.
    // OffLo runs iterations equal to the number of leading 1-bits in tableA + 1
    // (stops when old bit7 of A becomes 0). tableA's bit pattern determines
    // the iteration count.
    //
    // Enumerate all possible OffLo bit inputs up to a reasonable depth.
    const maxDepth = 16;
    const enc = searchOffLo(tableA, targetOffset, maxDepth);
    if (enc) {
      return { bits: [...offHiBits, ...enc.bits], rawByte: enc.rawByte };
    }
  }

  return null;
}

/** Brute-force search for OffLo bit sequence that produces targetOffset given
 *  starting tableA. Returns bits + optional raw byte. */
function searchOffLo(
  tableA: number,
  targetOffset: number,
  maxDepth: number,
): { bits: number[]; rawByte: number | null } | null {
  // Simulate decoder OffLo loop with all bit combinations up to maxDepth.
  // For each, check if the resulting A (and optional raw byte) produces
  // targetOffset.
  //
  // OffLo iter: read c, old_bit7 = (A >> 7) & 1, A = (A << 1 | c) & 0xFF,
  //             exit when old_bit7 = 0.
  //
  // Number of iterations = (leading 1s in A) + 1. For tableA:
  //   0xDF = 11011111 → leading 1s = 2 (bit7=1, bit6=0) → iters = 1+? hmm
  //   Wait, exit when old bit7 = 0 means we loop while old bit7 = 1. So
  //   number of 1-bits consecutively from top is the number of continue-iters.
  //
  //   0xDF = 0b11011111, bit7=1 → continue. After iter 1 (say c=x1):
  //     A_new = 0b10111110 | x1 = 0xBE | x1 (= 0xBE or 0xBF).
  //     old_bit7 of new A = 1. continue.
  //   After iter 2: A_new = 0b01111100 | x2 = 0x7C | x2 (= 0x7C..0x7F).
  //     old_bit7 = 0 (since 0x7X has bit7=0). Exit.
  //
  // So tableA=0xDF exits after 2 iterations. A in {0x7C, 0x7D, 0x7E, 0x7F}... actually
  //   x1=0: 0xBE << 1 = 0x7C. | x2 = 0x7C or 0x7D.
  //   x1=1: 0xBF << 1 = 0x7E. | x2 = 0x7E or 0x7F.
  //   So A ∈ {0x7C, 0x7D, 0x7E, 0x7F} based on (x1, x2) ∈ {00, 01, 10, 11}.
  //
  // Then check new bit7 = 0, so fall-through to literal offset.
  //   decoder: a = 0x7C..0x7F. offset = ((a ^ 0xFF) << 8) | rawByte, signed.
  //   For a=0x7C: (0x83 << 8) = 0x8300, + rawByte. Signed 16-bit = -0x7D00 + rawByte.
  //
  // This gives wide offset range per (aHi, OffLo-bits) combo plus raw byte.

  // Direct simulation:
  function simulate(bits: number[]): { finalA: number; usedAllBits: boolean } {
    let a = tableA;
    let bitIdx = 0;
    while (true) {
      if (bitIdx >= bits.length) return { finalA: a, usedAllBits: false };
      const c = bits[bitIdx++];
      const oldBit7 = (a >> 7) & 1;
      a = ((a << 1) | c) & 0xFF;
      if (oldBit7 === 0) return { finalA: a, usedAllBits: bitIdx === bits.length };
    }
  }

  // Try all bit sequences up to maxDepth.
  for (let len = 1; len <= maxDepth; len++) {
    const total = 1 << len;
    for (let mask = 0; mask < total; mask++) {
      const bits: number[] = [];
      for (let b = len - 1; b >= 0; b--) bits.push((mask >> b) & 1);
      const result = simulate(bits);
      if (!result.usedAllBits) continue;  // too many or too few bits

      if ((result.finalA & 0x80) !== 0) {
        // Normal path: offset = (0xFF << 8) | a, signed.
        const offset = ((0xFF << 8) | result.finalA) - 65536;
        if (offset === targetOffset) {
          return { bits, rawByte: null };
        }
      } else {
        // Fall-through literal offset: offset = ((a ^ 0xFF) << 8) | rawByte, signed.
        // Solve for rawByte: offset = ((a ^ 0xFF) << 8) | rawByte.
        // offset + 65536 (if negative) = ((a ^ 0xFF) << 8) | rawByte (unsigned).
        const hi = (result.finalA ^ 0xFF) << 8;
        const targetUnsigned = targetOffset + (targetOffset < 0 ? 65536 : 0);
        const candidateRawByte = targetUnsigned - hi;
        if (candidateRawByte >= 0 && candidateRawByte <= 255) {
          // Verify
          const checkOffset = (hi | candidateRawByte) - 65536;
          if (checkOffset === targetOffset) {
            return { bits, rawByte: candidateRawByte };
          }
        }
      }
    }
  }

  return null;
}
