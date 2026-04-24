/**
 * byteboozer-lykia-decoder.ts
 *
 * Faithful port of the Lykia `$020C` BB2 depacker to TypeScript. Each
 * subroutine in the original 6502 assembly (see
 * lykia-bank01-loader-0200-03ff_commented.tas in the Lykia project) maps to
 * a corresponding block here, with 6502 mnemonics preserved in comments.
 *
 * The Lykia depacker is a variant of standard ByteBoozer2, with these
 * specific traits:
 *
 *   - Stream header: `[dest_lo, dest_hi, end_lo, end_hi]` (4 raw bytes).
 *   - BB2_BITBUF is seeded with DEST_HI (from the LUT entry) before the
 *     4-byte header is consumed. Header reads use GetByte with C=0 so
 *     BITBUF is NOT modified during seed — it retains DEST_HI until the
 *     first real GetByte(C=1) refill.
 *   - Sentinel bit = 1, shifted into BITBUF bit 0 on every refill. When
 *     the sentinel shifts out (BITBUF becomes 0 after an ASL), the decoder
 *     refills from the next stream byte AND returns that byte's bit 7 as
 *     the current bit (the sentinel itself is never observed).
 *   - Match offset encoding uses a 7-entry lookup table `BB2_OFS_TABLE`.
 *   - Termination: depack returns when ZP_LO == LEN_LO AND ZP_HI == LEN_HI
 *     (checked only AFTER match copies). Literal runs do not check
 *     termination — they can overshoot end_addr, after which a following
 *     match will either terminate (if ptr lands on end_addr) or keep
 *     decoding past end_addr. A gamma-0 long-match length also terminates.
 *
 * The goal of this port is byte-exact parity with the real 6502 decoder
 * on all 87 of Mike's VICE-extracted Lykia payloads.
 */

/** Result of the Lykia decompressor. */
export interface LykiaDecodeResult {
  /** Output bytes starting at `destAddress`, length = whatever the depacker wrote. */
  data: Uint8Array;
  /** Starting output address (from stream header byte 0/1). */
  destAddress: number;
  /** End address (from stream header byte 2/3). */
  endAddress: number;
  /** Address of last byte the depacker wrote + 1 (final `out_ptr`). */
  finalPtr: number;
  /** Termination mode: "len" = ptr == LEN, "eos" = gamma-0 long-match. */
  termination: 'len' | 'eos';
  /** Number of stream bytes consumed. */
  bytesRead: number;
}

/** Pre-computed match offset high-byte table. Index 0 is unused (literal ofs). */
const BB2_OFS_TABLE = [0x00, 0xDF, 0xFB, 0x80, 0xEF, 0xFD, 0x80, 0xF0] as const;

/**
 * Decompress a Lykia BB2 stream.
 *
 * @param stream     compressed bytes, starting with the 4-byte header
 * @param destHi     initial BB2_BITBUF value = DEST_HI from LUT entry
 *                   (usually equals the output page high byte)
 * @returns          decompressed bytes + metadata
 */
export function lykiaDecompress(stream: Uint8Array, destHi: number): LykiaDecodeResult {
  const outMem = new Uint8Array(65536);

  // --- 6502 zero-page model -------------------------------------------------
  // $04 BB2_BITBUF — bit buffer (initially DEST_HI)
  // $05 ZP_LO      — BB2 output pointer low
  // $06 ZP_HI      — BB2 output pointer high
  // $07 LEN_LO     — end-of-stream sentinel low
  // $08 LEN_HI     — end-of-stream sentinel high
  let bitbuf = destHi & 0xFF;
  let zpLo = 0;
  let zpHi = 0;
  let lenLo = 0;
  let lenHi = 0;

  // --- Stream reader --------------------------------------------------------
  let pos = 0;
  const readByte = (): number => {
    if (pos >= stream.length) {
      throw new Error(`stream underflow at pos=${pos}`);
    }
    return stream[pos++];
  };

  // --- 6502 helpers ---------------------------------------------------------
  //
  // GetByte: JSR GetByte in 6502 reads the next stream byte into Y, and
  // conditionally refills BITBUF when called with C=1.
  //   C_in=1: STY BB2_BITBUF; ROL BB2_BITBUF with C_in=1.
  //           Result: BITBUF = ((y << 1) | 1) & 0xFF.
  //           C_out  = old bit 7 of BITBUF = y's bit 7 (since STY loaded y first).
  //   C_in=0: just read, no BITBUF update. C_out = 0.
  const getByte = (cIn: boolean): { y: number; cOut: boolean } => {
    const y = readByte();
    if (cIn) {
      const oldBit7 = (y >> 7) & 1;
      bitbuf = ((y << 1) | 1) & 0xFF;
      return { y, cOut: oldBit7 === 1 };
    } else {
      return { y, cOut: false };
    }
  };

  // getBit: ASL BB2_BITBUF; if BITBUF becomes 0 (sentinel shifted out),
  // JSR GetByte with C=1 is invoked inline. The bit returned to the caller
  // is overridden with the new byte's bit 7 in that case (the sentinel itself
  // is never actually observed).
  const getBit = (): boolean => {
    let c = (bitbuf >> 7) & 1;              // ASL BITBUF → C = old bit 7
    bitbuf = (bitbuf << 1) & 0xFF;
    if (bitbuf === 0) {
      // Sentinel shifted out → refill with C=1 entering GetByte.
      const y = readByte();
      c = (y >> 7) & 1;                     // override: return new byte's bit 7
      bitbuf = ((y << 1) | 1) & 0xFF;
    }
    return c === 1;
  };

  // --- BB2_Depack: 4-byte header seed loop ---------------------------------
  //
  // The 6502 seed loop calls JSR GetByte 4 times with C=0 (inherited from
  // the caller), storing each byte at $04+X with X starting at 0. Because
  // C=0 during the loop, BITBUF is NOT modified — it retains DEST_HI
  // throughout. The 4 bytes land at $05 (ZP_LO), $06 (ZP_HI), $07 (LEN_LO),
  // $08 (LEN_HI).
  //
  // After the seed, CPX #$04 with X=4 leaves C=1, which is the carry the
  // first real NextToken call uses.
  zpLo = readByte();
  zpHi = readByte();
  lenLo = readByte();
  lenHi = readByte();
  const destAddress = (zpHi << 8) | zpLo;
  const endAddress = (lenHi << 8) | lenLo;

  // --- Main decode loop -----------------------------------------------------
  //
  // Flag tokenC carries the carry across NextToken invocations. Starts at 1
  // because of CPX #$04 (X=4 ≥ 4 → C=1). It is updated by each GetByte and
  // used on subsequent NextToken calls.
  //
  // Flag afterMatch is true when the previous iteration ended with a match
  // copy. In that state, the next dispatch bit comes from BITBUF (NextBit)
  // rather than a fresh token byte (NextToken), unless BITBUF just ran out
  // (sentinel shifted out), in which case we fall through to NextToken.
  let tokenC = true;       // initial C=1
  let afterMatch = false;

  let termination: 'len' | 'eos' = 'len';

  // We track finalPtr separately so callers can see where the decoder
  // actually stopped writing; out_ptr == end_addr triggers loop exit even
  // when a literal run has already written past end_addr in the current
  // iteration (those writes are committed to outMem before the check).
  let outPtr = destAddress;

  // Safety: bound iterations to prevent runaway on corrupted streams.
  let safety = 0;
  const SAFETY_LIMIT = 1_000_000;

  // Dispatch carry coming out of NextToken / NextBit path.
  let dispatchC: boolean;
  let dispatchY: number;  // needed for BEQ check after BCC fails

  while (outPtr !== endAddress) {
    if (++safety > SAFETY_LIMIT) {
      throw new Error(`decoder safety limit hit at pos=${pos}, outPtr=$${outPtr.toString(16)}`);
    }

    if (afterMatch) {
      // --- BB2_NextBit path (after a match): read 1 dispatch bit from BITBUF.
      // If BITBUF was already at the sentinel (0x80) so that ASL zeros it,
      // we fall through to NextToken (new byte read). Otherwise we dispatch
      // directly with the bit that was shifted out.
      afterMatch = false;
      const cBit = (bitbuf >> 7) & 1;       // ASL BITBUF → C = old bit 7
      bitbuf = (bitbuf << 1) & 0xFF;

      if (bitbuf === 0) {
        // Sentinel exhausted after this shift. 6502 falls to NextToken with
        // C=1 (the sentinel bit was what shifted out, and C=1).
        const gb = getByte(true);
        tokenC = gb.cOut;
        dispatchY = gb.y;
        dispatchC = gb.cOut;
        // fall through to dispatch below
      } else if (cBit === 0) {
        // Short-circuit: NextBit dispatched to match path with C=0. No new
        // byte is read — match bits come from remaining BITBUF content.
        const ok = execMatch();
        if (ok.eos) { termination = 'eos'; break; }
        outPtr = ok.newPtr;
        afterMatch = true;
        continue;
      } else {
        // cBit === 1 → NextBit dispatched to literal path with C=1, no new
        // byte, and without going through BEQ (Y is stale but c=1 already
        // skipped the match-dispatch BCC; the BEQ check is effectively dead
        // because we know c=1 here).
        handleLiteral(true);
        continue;
      }
    } else {
      // --- BB2_NextToken path: fetch a new token byte with current tokenC.
      const gb = getByte(tokenC);
      tokenC = gb.cOut;
      dispatchY = gb.y;
      dispatchC = gb.cOut;
      // fall through to dispatch below
    }

    // --- BB2_Dispatch ------------------------------------------------------
    // BCC → match; BEQ → NextToken (skip); else → literal.
    if (!dispatchC) {
      // C=0 → match path (no new byte for match fields; they come from BITBUF).
      const ok = execMatch();
      if (ok.eos) { termination = 'eos'; break; }
      outPtr = ok.newPtr;
      afterMatch = true;
    } else if (dispatchY === 0) {
      // Skip/padding token. Next iteration goes through NextToken again with
      // tokenC = current C = false (cOut from GetByte(tokenC=true) returned
      // false because y's bit 7 is 0; the `|| true` isn't reached because
      // y=0 means bit 7 = 0 means C=false).
      //
      // NOTE: this branch is effectively unreachable because getByte(true)
      // cannot return both cOut=true AND y=0 simultaneously (cOut = y>>7,
      // so y=0 implies cOut=false, which would have been caught by BCC above).
      // We preserve the branch for completeness.
      continue;
    } else {
      // Literal path: C=1, y != 0.
      handleLiteral(true);
    }
  }

  const finalPtr = outPtr;
  const len = (finalPtr - destAddress) & 0xFFFF;
  const data = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    data[i] = outMem[(destAddress + i) & 0xFFFF]!;
  }

  return {
    data,
    destAddress,
    endAddress,
    finalPtr,
    termination,
    bytesRead: pos,
  };

  // ---------------------------------------------------------------------
  //  Inner helpers used in the main loop.
  //  These are function expressions (closures over the decoder state) so
  //  they can share state with the outer scope.
  // ---------------------------------------------------------------------

  /** Decode a literal count + copy literal bytes + exec implicit match.
   *  Updates outPtr and sets afterMatch=true on return. EOS from the
   *  implicit match terminates the outer loop.  */
  function handleLiteral(cInitial: boolean): void {
    const count = decodeLiteralCount(cInitial ? 1 : 0);
    // Literal copy: reads `count` raw bytes (count=0 means 256 bytes per
    // the 6502 code — LIT_LEN=0 wraps Y through $FF back to 0).
    const nBytes = count === 0 ? 256 : count;
    for (let i = 0; i < nBytes; i++) {
      outMem[(outPtr + i) & 0xFFFF] = readByte();
    }
    outPtr = (outPtr + nBytes) & 0xFFFF;

    // Literal count $ff is a continuation marker in the Lykia loader: copy
    // 255 raw bytes, then return to token dispatch without the implicit
    // match. If the literal landed exactly on end_addr, decoding is done.
    if (nBytes === 0xFF || outPtr === endAddress) {
      afterMatch = false;
      return;
    }

    // Implicit match follows non-$ff literals that did not finish exactly at
    // end_addr.
    const ok = execMatch();
    if (ok.eos) {
      termination = 'eos';
      // Caller (main loop) will see `termination === 'eos'` AFTER we set
      // it, but we need a way to break out. Since TS closures can't break
      // an outer loop directly, we rely on the caller to detect the EOS
      // via a sentinel. In this architecture we instead throw a named
      // error. For cleanliness, bounce outPtr back and let main loop's
      // condition do the rest — but main loop doesn't know about EOS yet.
      // Simplest: set outPtr = endAddress to force main loop exit. Any
      // subsequent writes are lost, but EOS means we're done anyway.
      outPtr = endAddress;
      return;
    }
    outPtr = ok.newPtr;
    afterMatch = true;
  }

  /** Decode the literal-run count via the Elias-gamma-ish encoder.
   *  c_initial is the carry brought into the first ROL (normally the
   *  dispatch bit = 1 for a literal token). */
  function decodeLiteralCount(cInitial: number): number {
    // Mirrors BB2_LitCountBit loop:
    //   A = 0
    //   C = cInitial
    //   loop:
    //     ROL A                ; A = (A<<1)|C
    //     ASL BITBUF → C1      ; read stop bit
    //     if C1=0: return A
    //     ASL BITBUF → C2      ; read value bit for next iter
    //     C = C2; loop
    let a = 0;
    let c = cInitial & 1;
    while (true) {
      a = ((a << 1) | c) & 0xFF;
      const c1 = getBit() ? 1 : 0;
      if (c1 === 0) return a;
      const c2 = getBit() ? 1 : 0;
      c = c2;
    }
  }

  /** Decode + apply a match (short or long). Returns the new out_ptr
   *  OR signals EOS. */
  function execMatch(): { eos: boolean; newPtr: number } {
    // Read the short/long selector bit.
    const sel = getBit() ? 1 : 0;
    let matchLen: number;
    let cAfterSel: boolean;
    if (sel === 1) {
      // Long match: decode length via gamma. Length 0 = EOS.
      matchLen = decodeLongMatchLen();
      if (matchLen === 0) return { eos: true, newPtr: outPtr };
      cAfterSel = true;
    } else {
      // Short match: A = #$01, length = 1 (2 bytes copied).
      matchLen = 1;
      cAfterSel = false;
    }

    const offset = decodeMatchOffset(cAfterSel);

    // Match copy: write (matchLen + 1) bytes starting at out_ptr,
    // reading from (out_ptr + offset). Offset is negative.
    const src = outPtr + offset;
    const count = matchLen + 1;
    for (let i = 0; i < count; i++) {
      outMem[(outPtr + i) & 0xFFFF] = outMem[(src + i) & 0xFFFF];
    }
    return { eos: false, newPtr: (outPtr + count) & 0xFFFF };
  }

  /** Decode long-match length via gamma. Returns length, or 0 for EOS. */
  function decodeLongMatchLen(): number {
    // Mirrors BB2_LongMatchLen: A=1; loop: read C1, ROL A, read C2; if C2=1 stop.
    let a = 1;
    while (true) {
      const c1 = getBit() ? 1 : 0;
      a = ((a << 1) | c1) & 0xFF;
      const c2 = getBit() ? 1 : 0;
      if (c2 === 1) return a;
    }
  }

  /** Decode match offset. Returns signed 16-bit offset (negative). */
  function decodeMatchOffset(cAfterSel: boolean): number {
    // LDA #$C0, ROL with C=cAfterSel → A = (0xC0 << 1 | C) & 0xFF = 0x80 | cAfterSel.
    // C after ROL is always 1 (bit 7 of 0xC0).
    let a = 0x80 | (cAfterSel ? 1 : 0);

    // BB2_OffHiBit loop: read bits, ROL A, loop while old bit 7 was 1.
    // Starting A has bit 7 = 1, so at least one iteration runs.
    while (true) {
      const c = getBit() ? 1 : 0;
      const oldBit7 = (a >> 7) & 1;
      a = ((a << 1) | c) & 0xFF;
      if (oldBit7 === 0) break;
    }

    if (a === 0) {
      // BEQ BB2_LiteralOfs (from OffHiBit exit with A=0): read a raw byte
      // (GetByte with C=0) and use $FF00 | y as offset (range -256..-1).
      const y = readByte();
      let off = (0xFF << 8) | y;
      if (off > 32767) off -= 65536;
      return off;
    }

    // Table offset path: A in 1..7, lookup table.
    a = BB2_OFS_TABLE[a];

    // BB2_OffLoBit loop: same shape as OffHiBit.
    while (true) {
      const c = getBit() ? 1 : 0;
      const oldBit7 = (a >> 7) & 1;
      a = ((a << 1) | c) & 0xFF;
      if (oldBit7 === 0) break;
    }

    if ((a & 0x80) !== 0) {
      // BMI BB2_DoMatch: A's bit 7 = 1 → normal table-encoded offset.
      // src = out_ptr + (0xFF00 | a) — negative offset.
      let off = (0xFF << 8) | a;
      if (off > 32767) off -= 65536;
      return off;
    } else {
      // Fall-through to BB2_LiteralOfs: read raw byte, combine with A.
      // After EOR #$FF and TYA, DoMatch computes
      //   src = out_ptr + ((a ^ 0xFF) << 8 | y)
      const y = readByte();
      let off = ((a ^ 0xFF) << 8) | y;
      if (off > 32767) off -= 65536;
      return off;
    }
  }
}
