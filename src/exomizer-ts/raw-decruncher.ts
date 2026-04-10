import {
  PFLAG_4_OFFSET_TABLES,
  PFLAG_BITS_COPY_GT_7,
  PFLAG_BITS_ORDER_BE,
  PFLAG_IMPL_1LITERAL,
  PFLAG_REUSE_OFFSET
} from "./flags.js";

export interface ExomizerRawDepackOptions {
  backwards?: boolean;
  reverseOutput?: boolean;
  maxOffset?: number;
  flagsProto?: number;
}

export interface ExomizerRawDepackResult {
  data: Uint8Array;
  byteCount: number;
}

interface DecTable {
  tableBit: number[];
  tableOff: number[];
  tableBi: number[];
  tableLo: number[];
  tableHi: number[];
}

const DEFAULT_RAW_FLAGS_PROTO =
  PFLAG_BITS_ORDER_BE |
  PFLAG_BITS_COPY_GT_7 |
  PFLAG_IMPL_1LITERAL |
  PFLAG_REUSE_OFFSET;

function reverseCopy(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data);
  let left = 0;
  let right = out.length - 1;
  while (left < right) {
    const temp = out[left]!;
    out[left] = out[right]!;
    out[right] = temp;
    left++;
    right--;
  }
  return out;
}

class DecCtx {
  public inPos = 0;
  public bitsRead = 0;
  public bitBuf = 0;
  public readonly table: DecTable = {
    tableBit: new Array(8).fill(0),
    tableOff: new Array(8).fill(0),
    tableBi: new Array(100).fill(0),
    tableLo: new Array(100).fill(0),
    tableHi: new Array(100).fill(0)
  };

  constructor(
    public readonly input: Uint8Array,
    public readonly flagsProto: number
  ) {}

  private bitBufRotate(carry: number): number {
    let carryOut: number;
    if ((this.flagsProto & PFLAG_BITS_ORDER_BE) !== 0) {
      carryOut = (this.bitBuf & 0x80) !== 0 ? 1 : 0;
      this.bitBuf = (this.bitBuf << 1) & 0xff;
      if (carry !== 0) {
        this.bitBuf |= 0x01;
      }
    } else {
      carryOut = this.bitBuf & 0x01;
      this.bitBuf >>= 1;
      if (carry !== 0) {
        this.bitBuf |= 0x80;
      }
    }
    return carryOut;
  }

  getByte(): number {
    const value = this.input[this.inPos++];
    if (value === undefined) {
      throw new Error("Exomizer stream ended unexpectedly.");
    }
    this.bitsRead += 8;
    return value;
  }

  getBits(count: number): number {
    let byteCopy = 0;
    let value = 0;

    if ((this.flagsProto & PFLAG_BITS_COPY_GT_7) !== 0) {
      while (count > 7) {
        byteCopy = count >> 3;
        count &= 7;
      }
    }

    while (count-- > 0) {
      let carry = this.bitBufRotate(0);
      if (this.bitBuf === 0) {
        this.bitBuf = this.getByte();
        this.bitsRead -= 8;
        carry = this.bitBufRotate(1);
      }
      value = (value << 1) | carry;
      this.bitsRead++;
    }

    while (byteCopy-- > 0) {
      value = (value << 8) | this.getByte();
    }

    return value;
  }

  getGammaCode(): number {
    let gammaCode = 0;
    while (this.getBits(1) === 0) {
      gammaCode++;
    }
    return gammaCode;
  }

  getCookedCodePhase2(index: number): number {
    const base = this.table.tableLo[index]! | (this.table.tableHi[index]! << 8);
    return base + this.getBits(this.table.tableBi[index]!);
  }

  tableInit(): void {
    let end: number;
    this.table.tableBit[0] = 2;
    this.table.tableBit[1] = 4;
    this.table.tableBit[2] = 4;
    if ((this.flagsProto & PFLAG_4_OFFSET_TABLES) !== 0) {
      end = 68;
      this.table.tableBit[3] = 4;
      this.table.tableOff[0] = 64;
      this.table.tableOff[1] = 48;
      this.table.tableOff[2] = 32;
      this.table.tableOff[3] = 16;
    } else {
      end = 52;
      this.table.tableOff[0] = 48;
      this.table.tableOff[1] = 32;
      this.table.tableOff[2] = 16;
    }

    let a = 0;
    let b = 0;
    for (let i = 0; i < end; i++) {
      if ((i & 0x0f) !== 0) {
        a += 1 << b;
      } else {
        a = 1;
      }

      this.table.tableLo[i] = a & 0xff;
      this.table.tableHi[i] = a >> 8;

      if ((this.flagsProto & PFLAG_BITS_COPY_GT_7) !== 0) {
        b = this.getBits(3);
        b |= this.getBits(1) << 3;
      } else {
        b = this.getBits(4);
      }
      this.table.tableBi[i] = b;
    }
  }
}

export class ExomizerRawDepacker {
  unpack(input: Uint8Array, options: ExomizerRawDepackOptions = {}): ExomizerRawDepackResult {
    if (options.backwards) {
      throw new Error("Exomizer raw backwards depack (-b) is not implemented yet in TypeScript.");
    }

    const flagsProto = options.flagsProto ?? DEFAULT_RAW_FLAGS_PROTO;
    const workingInput = options.reverseOutput ? reverseCopy(input) : input;
    const ctx = new DecCtx(workingInput, flagsProto);
    ctx.bitBuf = ctx.getByte();
    ctx.tableInit();

    const output: number[] = [];
    let value = 0;
    let index = 0;
    let length = 0;
    let literal = 1;
    let offset = 0;
    let source = 0;
    let reuseOffsetState = 1;
    const threshold = (flagsProto & PFLAG_4_OFFSET_TABLES) !== 0 ? 4 : 3;
    let implicitFirstLiteral = (flagsProto & PFLAG_IMPL_1LITERAL) !== 0;
    if (!implicitFirstLiteral) {
      literal = 0;
    }

    for (;;) {
      if (implicitFirstLiteral) {
        implicitFirstLiteral = false;
        length = 1;
        literal = 1;
      } else {
        reuseOffsetState <<= 1;
        reuseOffsetState |= literal;
        literal = 0;

        if (ctx.getBits(1) !== 0) {
          length = 1;
          literal = 1;
        } else {
          value = ctx.getGammaCode();
          if (value === 16) {
            break;
          }
          if (value === 17) {
            length = ctx.getBits(16);
            literal = 1;
          } else {
            length = ctx.getCookedCodePhase2(value);

            let reuseOffset = 0;
            if ((flagsProto & PFLAG_REUSE_OFFSET) !== 0 && (reuseOffsetState & 3) === 1) {
              reuseOffset = ctx.getBits(1);
            }
            if (reuseOffset === 0) {
              index = (length > threshold ? threshold : length) - 1;
              value = ctx.table.tableOff[index]! + ctx.getBits(ctx.table.tableBit[index]!);
              offset = ctx.getCookedCodePhase2(value);
            }
            source = output.length - offset;
          }
        }
      }

      do {
        if (literal !== 0) {
          value = ctx.getByte();
        } else {
          if (source < 0 || source >= output.length) {
            throw new Error(`Exomizer raw depack hit invalid back-reference source ${source}.`);
          }
          value = output[source++]!;
        }
        output.push(value);
      } while (--length > 0);
    }

    const data = Uint8Array.from(output);
    return { data, byteCount: data.length };
  }
}
