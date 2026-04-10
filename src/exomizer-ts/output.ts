import { PFLAG_BITS_COPY_GT_7, PFLAG_BITS_ORDER_BE } from "./flags.js";

/*
 * Bitstream writer ported from src/output.c (Exomizer 3.1.2).
 * Keep behavior byte-exact against original C implementation.
 */
export class OutputCtx {
  private bitbuf = 0;
  private bitcount = 0;
  private pos = 0;
  private readonly flagsProto: number;
  private readonly out: number[];

  constructor(flagsProto: number, initialBytes?: Uint8Array) {
    this.flagsProto = flagsProto;
    this.out = initialBytes ? Array.from(initialBytes) : [];
    this.pos = this.out.length;
  }

  getPos(): number {
    return this.pos >>> 0;
  }

  byte(value: number): void {
    const b = value & 0xff;
    if (this.pos < this.out.length) {
      this.out[this.pos] = b;
    } else {
      while (this.pos > this.out.length) {
        this.out.push(0);
      }
      this.out.push(b);
    }
    this.pos++;
  }

  word(value: number): void {
    this.byte(value & 0xff);
    this.byte((value >>> 8) & 0xff);
  }

  bitsFlush(addMarkerBit: boolean): void {
    if (addMarkerBit) {
      if ((this.flagsProto & PFLAG_BITS_ORDER_BE) !== 0) {
        this.bitbuf |= 0x80 >>> this.bitcount;
      } else {
        this.bitbuf |= 0x01 << this.bitcount;
      }
      this.bitcount++;
    }

    if (this.bitcount > 0) {
      this.byte(this.bitbuf);
      this.bitbuf = 0;
      this.bitcount = 0;
    }
  }

  bitsAlignment(): number {
    return (8 - this.bitcount) & 7;
  }

  bits(count: number, val: number): void {
    this.bitsInt(count, val);
  }

  gammaCode(code: number): void {
    this.bitsInt(1, 1);
    while (code-- > 0) {
      this.bitsInt(1, 0);
    }
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.out);
  }

  private bitsInt(count: number, val: number): void {
    if ((this.flagsProto & PFLAG_BITS_COPY_GT_7) !== 0) {
      while (count > 7) {
        this.byte(val & 0xff);
        count -= 8;
        val >>= 8;
      }
    }

    while (count-- > 0) {
      this.bitbufBit(val & 1);
      val >>= 1;
    }
  }

  private bitbufBit(bit: number): void {
    if ((this.flagsProto & PFLAG_BITS_ORDER_BE) !== 0) {
      this.bitbuf >>= 1;
      if (bit !== 0) {
        this.bitbuf |= 0x80;
      }
      this.bitcount++;
      if (this.bitcount === 8) {
        this.bitsFlush(false);
      }
      return;
    }

    this.bitbuf <<= 1;
    if (bit !== 0) {
      this.bitbuf |= 0x01;
    }
    this.bitcount++;
    if (this.bitcount === 8) {
      this.bitsFlush(false);
    }
  }
}
