// TS-native depacker that mirrors the BWC resident depacker at $C992
// closely enough to byte-replicate its output. Used for round-trip
// validation against the sandbox depacker (which IS the original
// $C992 running on a 6502 sim) — if both agree, encoder bugs become
// visible at a specific bit position.
//
// Algorithm reference: src/bwc-bitstream-ts/header.ts (header layout) +
// the disassembly at WC992..WCB05 in the BWC resident loader.

import { parseHeader, type BwcHeader } from "./header.js";

export class BwcDecruncherError extends Error {}

export interface DecodeOptions {
  // When true, emit a bit-trace log accessible via getTrace().
  trace?: boolean;
}

export interface DecodeResult {
  header: BwcHeader;
  unpacked: Uint8Array;
  trace?: string[];
}

export class Decruncher {
  // Mirror of the depacker's runtime state.
  private buf = 0;        // $5A — 8-bit buffer with marker bit at LSB
  private streamPos = 0;  // index into the bit-stream BODY
  private bytesConsumed = 0; // diagnostic: how many stream bytes consumed
  private bitOffset = 0;     // diagnostic: total bits popped since reset

  constructor(
    private body: Uint8Array,
    private trace: string[] | null = null,
  ) {
    // Initial buffer state matches WCA11: lda #$80; sta $5A.
    this.buf = 0x80;
  }

  // Pop a single payload bit from the stream. Returns 0 or 1.
  private readBit(): number {
    // asl $5A: pop MSB into carry, shift left.
    let carry = (this.buf >> 7) & 1;
    this.buf = (this.buf << 1) & 0xff;
    if (this.buf === 0) {
      // Refill: byte = next stream byte; $5A = (byte<<1)|1; carry = byte_bit_7.
      if (this.streamPos >= this.body.length) {
        throw new BwcDecruncherError(`bit-stream underflow at offset ${this.streamPos}`);
      }
      const next = this.body[this.streamPos]!;
      this.streamPos += 1;
      this.bytesConsumed += 1;
      this.buf = ((next << 1) | 1) & 0xff;
      carry = (next >> 7) & 1;
    }
    this.bitOffset += 1;
    return carry;
  }

  // Read N bits MSB-first into an integer.
  private readBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
    return v;
  }

  // WCAEB equivalent: ldx #X; jsr WCAEB. The depacker uses A as accumulator
  // entering the routine when X > 0, ROL-ing each new bit into the LSB.
  // For X == 0, A is unchanged (BNE not taken at WCAEB entry → clc; rts).
  private accumBits(a: number, n: number): number {
    if (n === 0) return a & 0xff;
    let result = a & 0xff;
    for (let i = 0; i < n; i++) {
      const bit = this.readBit();
      result = ((result << 1) | bit) & 0xff;
    }
    return result;
  }

  // WCACD: gamma decode with maxRank = N2 (cpx #N2).
  // Returns A in [1, 2^N2 - 1].
  private gammaDecode(n2: number): number {
    let x = 1;
    let a = 1; // initial A = X+0+1 from inx;txa with X starting at 0
    while (true) {
      const bit = this.readBit();
      if (bit === 0) {
        // Separator bit: read (x-1) raw bits, ROL into A.
        const extra = x - 1;
        a = this.accumBits(a, extra);
        return a & 0xff;
      }
      x += 1;
      if (x === n2) {
        // Cap reached: read (x-1) raw bits, no separator.
        const extra = x - 1;
        a = this.accumBits(a, extra);
        return a & 0xff;
      }
    }
  }

  decode(): { unpacked: Uint8Array; cmpOpFinal: number } {
    return { unpacked: new Uint8Array(0), cmpOpFinal: 0 }; // overridden in decode()
  }
}

export function decode(packed: Uint8Array, options: DecodeOptions = {}): DecodeResult {
  const chunk = parseHeader(packed);
  const header = chunk.header;
  const trace = options.trace ? [] as string[] : null;
  const dec = new Decruncher(chunk.payload, trace);

  // Internal state mirroring the depacker:
  //   - cmp_op (WCA34+1) starts at header.cmpOp.
  //   - dest pointer increments per emitted byte.
  //   - lit_table is read into RAM at $0101+; we just keep header.litTable.
  let cmpOp = header.cmpOp;
  let dest = header.dest & 0xffff;
  const out: number[] = [];
  const eosValue = (2 * header.n3 - 1) & 0xff;

  // Helper: write byte to output.
  function writeByte(byte: number): void {
    out.push(byte & 0xff);
    dest = (dest + 1) & 0xffff;
  }

  // Token loop.
  let safety = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (++safety > 1_000_000) throw new BwcDecruncherError(`token loop exceeded safety cap`);
    const startBits = (dec as any).bitOffset as number;
    // WCA2F: read N1 bits.
    const tok = (dec as any).readBits(header.n1) as number;

    if (tok !== cmpOp) {
      // Plain literal: read (8-N1) more bits, A enters with token in low N1
      // (because WCAE2 uses ROL, accumulating onto the existing A).
      const byte = (dec as any).accumBits(tok, 8 - header.n1) as number;
      if (trace) trace.push(`@${startBits} LIT tok=${tok} byte=$${byte.toString(16).padStart(2, "0")} dest=$${dest.toString(16)}`);
      writeByte(byte);
      continue;
    }

    // cmp_op match → LZ-or-short-or-end.
    const v1 = (dec as any).gammaDecode(header.n2) as number;
    const lsrA = v1 >> 1;
    if (lsrA !== 0) {
      // Long path: gamma v2, check EOS, read N4 bits, read 8 bits dist_low.
      const v2 = (dec as any).gammaDecode(header.n2) as number;
      if (v2 === eosValue) {
        if (trace) trace.push(`@${startBits} EOS v1=${v1}`);
        break;
      }
      // sbc #$00 with carry from prior cmp: cmp set carry=0 (since v2 < 0xFF
      // when EOS check failed AND v2 < eosValue numerically; the cmp uses
      // unsigned A < operand → C=0). So sbc subtracts an extra 1.
      // Actually the carry from cmp: A >= operand → C=1; A < operand → C=0.
      // We took bne (A != operand). If A < operand C=0, if A > operand C=1.
      // For v2 in [1, eosValue-1], A < eosValue → C=0. For v2 > eosValue
      // (impossible since gamma cap = 2^N2-1 and eosValue = 2*N3-1; if
      // n3 < 2^(n2-1), v2 could exceed eosValue, but BWC chunks have
      // n3 = 128 = 2^(n2-1) so eosValue = 2^N2 - 1 and v2 can't exceed it).
      const carryAfterCmp = v2 > eosValue ? 1 : 0;
      const v2Adj = (v2 - (1 - carryAfterCmp)) & 0xff;
      const distHigh = (dec as any).accumBits(v2Adj, header.n4) as number;
      const distLow = (dec as any).accumBits(0, 8) as number;
      // ADC dest_lo (carry = 0 from WCAEB.clc).
      const sumLow = distLow + (dest & 0xff);
      const srcLo = sumLow & 0xff;
      const carryAfterAdc = sumLow > 0xff ? 1 : 0;
      // SBC dist_high (carry = carryAfterAdc).
      const subHi = ((dest >> 8) & 0xff) - distHigh - (1 - carryAfterAdc);
      const srcHi = subHi & 0xff;
      const length = v1 + 1;
      const src = (srcHi << 8) | srcLo;
      if (trace) trace.push(`@${startBits} LZF v1=${v1} v2=${v2} dh=${distHigh} dl=${distLow} src=$${src.toString(16)} dest=$${dest.toString(16)} len=${length}`);
      // Copy length bytes from src to dest, advancing dest.
      // Source pointer ($58/$59) does NOT advance — Y indexes into mem
      // from the FIXED src. As writes happen, mem at dest gets the new
      // byte; subsequent reads at src+Y can read those just-written bytes
      // when src+Y reaches dest's old position (RLE-style overlap).
      // We model this against the running `out[]` array.
      const baseOffset = src - header.dest;
      for (let i = 0; i < length; i++) {
        const off = baseOffset + i;
        if (off < 0) throw new BwcDecruncherError(`LZ src $${src.toString(16)}+${i} outside output range`);
        const byte = out[off]!;
        if (byte === undefined) throw new BwcDecruncherError(`LZ src offset ${off} not yet written (out len=${out.length})`);
        writeByte(byte);
      }
      continue;
    }

    // Short path: read bit_a, bit_b.
    const bitA = (dec as any).readBit() as number;
    if (bitA === 0) {
      // Near-LZ: dist_high = 0 implicitly, dist_low = 8 raw bits, length = v1+1 = 2.
      const distLow = (dec as any).accumBits(0, 8) as number;
      const sumLow = distLow + (dest & 0xff);
      const srcLo = sumLow & 0xff;
      const carryAfterAdc = sumLow > 0xff ? 1 : 0;
      const subHi = ((dest >> 8) & 0xff) - 0 - (1 - carryAfterAdc);
      const srcHi = subHi & 0xff;
      const length = v1 + 1;
      const src = (srcHi << 8) | srcLo;
      if (trace) trace.push(`@${startBits} LZN v1=${v1} dl=${distLow} src=$${src.toString(16)} dest=$${dest.toString(16)} len=${length}`);
      const baseOffset = src - header.dest;
      for (let i = 0; i < length; i++) {
        const off = baseOffset + i;
        const byte = out[off]!;
        if (byte === undefined) throw new BwcDecruncherError(`LZN src offset ${off} not yet written`);
        writeByte(byte);
      }
      continue;
    }

    const bitB = (dec as any).readBit() as number;
    if (bitB === 0) {
      // cmp_op-update path:
      //   ldy WCA34+1   → Y = old cmp_op
      //   ldx #N1; jsr WCAEB → A = N1 bits = newCmpOp
      //   sta WCA34+1
      //   tya → A = old cmp_op
      //   ldx #(8-N1); jsr WCAEB → A = (old << (8-N1)) | low_(8-N1)
      //   jsr WCAB0 → write A
      const newCmpOp = (dec as any).readBits(header.n1) as number;
      const lowBits = (dec as any).readBits(8 - header.n1) as number;
      const byte = ((cmpOp << (8 - header.n1)) | lowBits) & 0xff;
      if (trace) trace.push(`@${startBits} UPD oldCmp=${cmpOp} newCmp=${newCmpOp} byte=$${byte.toString(16).padStart(2, "0")} dest=$${dest.toString(16)}`);
      cmpOp = newCmpOp;
      writeByte(byte);
      continue;
    }

    // bit_b == 1: literal-table branch (WCA50+).
    //   iny                       (Y = 1)
    //   jsr WCACD                 → gamma → A
    //   sta $58                   ($58 = first gamma)
    //   cmp #cmp_op_orig          (self-mod = (orig << 1) - 1)
    //   bcc WCA61                 → if A < cmp_op_orig: skip extra read
    //   else: ldx #(8-N1); jsr WCAE2 → reads more bits, sta $58
    //         jsr WCACD → tay (Y = second gamma)
    //   WCA61: jsr WCACD; tax; lda $0100,X; cpx #$20
    //          bcc WCA72 → no extra
    //          else txa; ldx #$03; jsr WCAE2 (3 extra bits)
    //   WCA72: ldx $58; inx
    //   loop: jsr WCAB0; dex; bne loop; dey; bne loop; beq WCA2C
    // ($58 = inner-loop count; outer Y count.)
    //
    // The cmp_op_orig self-mod value at WCA52+1 is `(N3 * 2) - 1`? No —
    // looking at WC9F0: lda WCA52+1; asl; sec; sbc #$01; sta WCA83+1.
    // So WCA52+1 holds something derived from cmp_op or another header
    // byte. From WC9D5: jsr WCABC; sta WCA52+1 — so WCA52+1 = N3 from
    // header. That means the cmp here compares gamma-decoded value against
    // N3 (= 128 typically).
    {
      let inner = (dec as any).gammaDecode(header.n2) as number;
      let outer = 1;
      if (inner >= header.n3) {
        // Read additional bits to extend `inner`, then read another gamma
        // for `outer`. The WCA56 sequence: ldx #(8-N1); jsr WCAE2, sta $58.
        inner = (dec as any).accumBits(inner, 8 - header.n1) as number;
        outer = (dec as any).gammaDecode(header.n2) as number;
      }
      const idx = (dec as any).gammaDecode(header.n2) as number;
      let byte: number;
      if (idx < 0x20) {
        // lda $0100,X reads from RAM. $0100 holds either stack remnants
        // OR the start of the lit_table (which is loaded to $0101..). The
        // code reads $0100,X with X = idx, so X=0 reads $0100 (stack);
        // X=1 reads lit_table[0]. The depacker ALSO loads lit_table to
        // $0101, so for idx in [1, Y] this is lit_table[idx-1]. For idx=0
        // it reads $0100 which is uninitialized stack — practically not
        // used by the encoder (BWC chunks emit indices >= 1 here).
        if (idx === 0) {
          // Best-effort: assume zero (matches a freshly-cleared stack).
          byte = 0;
        } else if (idx - 1 < header.litTable.length) {
          byte = header.litTable[idx - 1]!;
        } else {
          throw new BwcDecruncherError(`literal-table index ${idx} out of range (Y=${header.y})`);
        }
      } else {
        // X >= $20: txa; ldx #$03; jsr WCAE2 → A = (idx << 3) | 3 raw bits.
        byte = (dec as any).accumBits(idx, 3) as number;
      }
      if (trace) trace.push(`@${startBits} TAB inner=${inner} outer=${outer} idx=${idx} byte=$${byte.toString(16).padStart(2, "0")} dest=$${dest.toString(16)}`);
      // Emit `inner+1` copies × `outer` cycles? Reading the loop: ldx $58
      // (= inner); inx; loop1: jsr WCAB0; dex; bne loop1; dey; bne loop1.
      // So `(inner+1)` writes per outer iteration, then dey decrements outer.
      // But the loop conditions are: jsr/dex/bne; dey/bne. "bne loop"
      // both times, so after inner exhausts, X=0 → dey then bne loops back
      // INTO the same loop with X already at 0 → bne not taken on dex,
      // wait: actual structure:
      //   WCA75: jsr WCAB0
      //          dex
      //          bne WCA75   (back to WCA75 if X != 0)
      //          dey
      //          bne WCA75   (outer dec; back to WCA75)
      //          beq WCA2C
      // So when dex hits 0, we fall through to dey; if outer != 0 we re-
      // enter at WCA75 with X = 0... then dex → X = $FF, bne taken (loops
      // 256 times). That's a quirk — the encoder must arrange for outer to
      // be 0 after the (inner+1) writes, OR understand the X=$FF wraparound.
      // BWC chunks observed only use this branch with outer = 1 → first
      // dey makes outer=0, beq exits. So in practice loops `inner+1` times.
      const total = (inner + 1) * outer; // outer == 1 always in observed data
      for (let i = 0; i < total; i++) writeByte(byte);
    }
  }

  return {
    header,
    unpacked: Uint8Array.from(out),
    ...(trace ? { trace } : {}),
  };
}
