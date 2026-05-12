// Forwards bit-stream writer for the BWC bit-stream format.
//
// The BWC depacker maintains a 1-byte buffer at $5A. After refill it
// holds `(stream_byte << 1) | 1`, with the MSB of `stream_byte` already
// rolled into carry (used as the first popped bit). Subsequent `asl $5A`
// shifts pop bits 6..0 of the stream byte; the 9th pop yields the
// sentinel "1" from the OR which empties the buffer and triggers refill.
//
// Effective on-wire encoding: 8 payload bits per byte, MSB-first. The
// "marker" is internal book-keeping, not on-wire overhead.

export class BitWriter {
  private bytes: number[] = [];
  private buf = 0;
  private bufBits = 0;

  writeBit(bit: number): void {
    this.buf = ((this.buf << 1) | (bit & 1)) & 0xff;
    this.bufBits += 1;
    if (this.bufBits === 8) {
      this.bytes.push(this.buf);
      this.buf = 0;
      this.bufBits = 0;
    }
  }

  // Append `count` low bits of `value`, MSB-first. count <= 24.
  writeBits(value: number, count: number): void {
    if (count < 0 || count > 24) throw new Error(`writeBits: bad count ${count}`);
    for (let i = count - 1; i >= 0; i--) this.writeBit((value >> i) & 1);
  }

  // Pad-flush any partial byte with zero bits.
  finalize(): Uint8Array {
    while (this.bufBits > 0) this.writeBit(0);
    return Uint8Array.from(this.bytes);
  }

  byteLength(): number {
    return this.bytes.length + (this.bufBits > 0 ? 1 : 0);
  }

  bitLength(): number {
    return this.bytes.length * 8 + this.bufBits;
  }
}
