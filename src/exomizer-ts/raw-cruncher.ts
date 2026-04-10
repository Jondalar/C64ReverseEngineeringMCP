import {
  PFLAG_4_OFFSET_TABLES,
  PFLAG_BITS_ALIGN_START,
  PFLAG_BITS_COPY_GT_7,
  PFLAG_BITS_ORDER_BE,
  PFLAG_IMPL_1LITERAL,
  PFLAG_REUSE_OFFSET,
  TFLAG_LEN0123_SEQ_MIRRORS,
  TFLAG_LEN1_SEQ,
  TFLAG_LIT_SEQ
} from "./flags.js";
import { MatchConcatEnum, MatchContext, MatchCacheEnum } from "./match.js";
import { optimalEncode, optimalEncodingExport, optimalEncodingImport, optimalFree, optimalInit, optimalOptimize, optimalOut } from "./optimal.js";
import { OutputCtx } from "./output.js";
import { EncodeMatchData, MatchSnpEnum, searchBuffer } from "./search.js";
import { SearchNode } from "./types.js";

export interface CrunchOptions {
  importedEncoding: string | null;
  maxPasses: number;
  maxLen: number;
  maxOffset: number;
  favorSpeed: boolean;
  outputHeader: boolean;
  flagsProto: number;
  flagsNoTrait: number;
  directionForward: boolean;
  writeReverse: boolean;
}

export interface CrunchInfo {
  traitsUsed: number;
  maxLen: number;
  maxOffset: number;
  neededSafetyOffset: number;
}

export interface CrunchMultiResult {
  data: Uint8Array[];
  info: CrunchInfo[];
  mergedInfo: CrunchInfo;
  encoding: string;
}

export const DEFAULT_CRUNCH_OPTIONS: CrunchOptions = {
  importedEncoding: null,
  maxPasses: 100,
  maxLen: 65535,
  maxOffset: 65535,
  favorSpeed: false,
  outputHeader: true,
  flagsProto:
    PFLAG_BITS_ORDER_BE |
    PFLAG_BITS_COPY_GT_7 |
    PFLAG_IMPL_1LITERAL |
    PFLAG_REUSE_OFFSET,
  flagsNoTrait: 0,
  directionForward: true,
  writeReverse: false
};

export const reverseBuffer = (buf: Uint8Array): void => {
  let start = 0;
  let end = buf.length - 1;
  while (start < end) {
    const tmp = buf[start];
    buf[start] = buf[end];
    buf[end] = tmp;
    start++;
    end--;
  }
};

const doCompressBackwards = (
  ctx: MatchContext,
  emd: EncodeMatchData,
  options: CrunchOptions
): SearchNode => {
  const multi = doCompressBackwardsMulti([ctx], emd, options);
  return multi[0];
};

const doCompressBackwardsMulti = (
  ctxList: MatchContext[],
  emd: EncodeMatchData,
  options: CrunchOptions
): SearchNode[] => {
  let pass = 1;
  let prevEnc = "";

  if (options.importedEncoding !== null) {
    optimalEncodingImport(emd, options.importedEncoding);
    if (options.maxPasses === 1) {
      pass++;
    }
  } else {
    if (ctxList.length === 1) {
      const mpEnum = new MatchCacheEnum(ctxList[0]);
      optimalOptimize(emd, e => (e as MatchCacheEnum).next(), mpEnum);
    } else {
      const enums = ctxList.map(ctx => new MatchCacheEnum(ctx));
      const concat = new MatchConcatEnum(e => (e as MatchCacheEnum).next(), enums);
      optimalOptimize(emd, e => (e as MatchConcatEnum).next(), concat);
    }
  }

  prevEnc = optimalEncodingExport(emd);
  let oldSize = 100000000.0;
  let lastWaltz = false;
  let bestSnArrList: SearchNode[][] = [];

  for (;;) {
    let size = 0.0;
    const greedy = (pass & 1) === 0;
    bestSnArrList = ctxList.map(ctx =>
      searchBuffer(
        ctx,
        optimalEncode,
        emd,
        options.flagsProto,
        options.flagsNoTrait,
        options.maxLen,
        greedy
      )
    );
    for (const snArr of bestSnArrList) {
      size += snArr[0].totalScore;
    }

    if (lastWaltz) {
      break;
    }

    pass++;
    if (size >= oldSize) {
      lastWaltz = true;
      continue;
    }
    oldSize = size;

    if (pass > options.maxPasses) {
      break;
    }

    optimalFree(emd);
    optimalInit(emd, options.flagsNoTrait, options.flagsProto);

    if (bestSnArrList.length === 1) {
      const snpEnum = new MatchSnpEnum(bestSnArrList[0][0]);
      optimalOptimize(emd, e => (e as MatchSnpEnum).next(), snpEnum);
    } else {
      const enums = bestSnArrList.map(snArr => new MatchSnpEnum(snArr[0]));
      const concat = new MatchConcatEnum(e => (e as MatchSnpEnum).next(), enums);
      optimalOptimize(emd, e => (e as MatchConcatEnum).next(), concat);
    }

    const enc = optimalEncodingExport(emd);
    if (enc === prevEnc) {
      break;
    }
    prevEnc = enc;
  }

  return bestSnArrList.map(snArr => snArr[0]);
};

const doOutputBackwards = (
  ctx: MatchContext | null,
  snpStart: SearchNode | null,
  emd: EncodeMatchData,
  options: CrunchOptions
): { output: Uint8Array; info: CrunchInfo } => {
  const initialLen = 0;
  const initialSnp = snpStart;
  let alignment = 0;
  let measureAlignment = (options.flagsProto & PFLAG_BITS_ALIGN_START) !== 0;
  let len0123skip = 3;
  if ((options.flagsProto & PFLAG_4_OFFSET_TABLES) !== 0) {
    len0123skip = 4;
  }

  let traitsUsed = 0;
  let maxLen = 0;
  let maxOffset = 0;
  let neededSafetyOffset = 0;
  let outData: number[] = [];

  const oldOut = emd.out;
  for (;;) {
    outData.length = initialLen;
    let snp = initialSnp;
    const out = new OutputCtx(options.flagsProto, Uint8Array.from(outData));
    emd.out = out;

    out.bits(alignment, 0);

    const pos = out.getPos();
    let posDiff = pos;
    let maxDiff = 0;

    if (snp !== null) {
      out.gammaCode(16);
      out.bits(1, 0);
      const diff = out.getPos() - posDiff;
      if (diff > maxDiff) {
        maxDiff = diff;
      }
    }

    while (snp !== null) {
      const mp = snp.match;
      if (mp.len > 0) {
        if (mp.offset === 0) {
          const splitLitSeq =
            snp.prev !== null &&
            snp.prev.match.len === 0 &&
            (options.flagsProto & PFLAG_IMPL_1LITERAL) !== 0;

          let i = 0;
          if (mp.len > 1) {
            let len = mp.len;
            if (splitLitSeq) {
              len--;
            }
            for (; i < len; ++i) {
              if (ctx === null) {
                throw new Error("missing match context for literal output");
              }
              out.byte(ctx.buf[snp.index + i]);
            }
            out.bits(16, len);
            out.gammaCode(17);
            out.bits(1, 0);
            traitsUsed |= TFLAG_LIT_SEQ;
            if (len > maxLen) {
              maxLen = len;
            }
          }
          if (i < mp.len) {
            if (ctx === null) {
              throw new Error("missing match context for literal output");
            }
            out.byte(ctx.buf[snp.index + i]);
            if (!splitLitSeq) {
              out.bits(1, 1);
            }
          }
        } else {
          const latestOffset = snp.prev !== null ? snp.prev.latestOffset : 0;
          optimalEncode(mp, emd, latestOffset, null);
          out.bits(1, 0);

          if (mp.len === 1) {
            traitsUsed |= TFLAG_LEN1_SEQ;
          } else {
            const lo = mp.len & 255;
            const hi = mp.len & ~255;
            if (hi > 0 && lo < len0123skip) {
              traitsUsed |= TFLAG_LEN0123_SEQ_MIRRORS;
            }
          }

          if (mp.offset > maxOffset) {
            maxOffset = mp.offset;
          }
          if (mp.len > maxLen) {
            maxLen = mp.len;
          }
        }

        posDiff += mp.len;
        const diff = out.getPos() - posDiff;
        if (diff > maxDiff) {
          maxDiff = diff;
        }
      }

      snp = snp.prev;
    }

    if (options.outputHeader) {
      optimalOut(out, emd);
    }

    if (!measureAlignment) {
      out.bitsFlush((options.flagsProto & PFLAG_BITS_ALIGN_START) === 0);
      outData = Array.from(out.toUint8Array());
      neededSafetyOffset = maxDiff;
      break;
    }

    alignment = out.bitsAlignment();
    measureAlignment = false;
  }
  emd.out = oldOut;

  return {
    output: Uint8Array.from(outData),
    info: {
      traitsUsed,
      maxLen,
      maxOffset,
      neededSafetyOffset
    }
  };
};

export class RawCruncher {
  constructor(
    private readonly readFileSync?: (path: string) => Uint8Array
  ) {}

  private decodeEncodingFromBinary(
    dataIn: Uint8Array,
    flagsProto: number,
    needsReversing: boolean
  ): string {
    const data = new Uint8Array(dataIn);
    if (needsReversing) {
      reverseBuffer(data);
    }

    let inpos = 0;
    let bitsRead = 0;
    let bitbuf = 0;

    const getByte = (): number => {
      if (inpos >= data.length) {
        throw new Error("unexpected end of imported encoding data");
      }
      const c = data[inpos++];
      bitsRead += 8;
      return c;
    };

    const bitbufRotate = (carry: number): number => {
      let carryOut: number;
      if ((flagsProto & PFLAG_BITS_ORDER_BE) !== 0) {
        carryOut = (bitbuf & 0x80) !== 0 ? 1 : 0;
        bitbuf = (bitbuf << 1) & 0xff;
        if (carry !== 0) {
          bitbuf |= 0x01;
        }
      } else {
        carryOut = bitbuf & 0x01;
        bitbuf >>= 1;
        if (carry !== 0) {
          bitbuf |= 0x80;
        }
      }
      return carryOut;
    };

    const getBits = (countIn: number): number => {
      let count = countIn;
      let byteCopy = 0;
      let val = 0;
      if ((flagsProto & PFLAG_BITS_COPY_GT_7) !== 0) {
        while (count > 7) {
          byteCopy = count >> 3;
          count &= 7;
        }
      }
      while (count-- > 0) {
        let carry = bitbufRotate(0);
        if (bitbuf === 0) {
          bitbuf = getByte();
          bitsRead -= 8;
          carry = bitbufRotate(1);
        }
        val <<= 1;
        val |= carry;
        bitsRead++;
      }
      while (byteCopy-- > 0) {
        val <<= 8;
        val |= getByte();
      }
      return val;
    };

    if ((flagsProto & PFLAG_BITS_ALIGN_START) !== 0) {
      bitbuf = 0;
    } else {
      bitbuf = getByte();
    }

    const tableBit = new Array(4).fill(0);
    const tableOff = new Array(4).fill(0);
    const tableBi = new Array(68).fill(0);

    tableBit[0] = 2;
    tableBit[1] = 4;
    tableBit[2] = 4;

    let end = 52;
    let offsetTables = 3;
    if ((flagsProto & PFLAG_4_OFFSET_TABLES) !== 0) {
      end = 68;
      offsetTables = 4;
      tableBit[3] = 4;
      tableOff[0] = 64;
      tableOff[1] = 48;
      tableOff[2] = 32;
      tableOff[3] = 16;
    } else {
      tableOff[0] = 48;
      tableOff[1] = 32;
      tableOff[2] = 16;
    }

    let a = 0;
    let b = 0;
    for (let i = 0; i < end; ++i) {
      if ((i & 0x0f) !== 0) {
        a += 1 << b;
      } else {
        a = 1;
      }
      if ((flagsProto & PFLAG_BITS_COPY_GT_7) !== 0) {
        b = getBits(3);
        b |= getBits(1) << 3;
      } else {
        b = getBits(4);
      }
      tableBi[i] = b;
    }

    let out = "";
    for (let i = 0; i < 16; ++i) {
      out += (tableBi[i] & 0xf).toString(16).toUpperCase();
    }
    for (let j = 0; j < offsetTables; ++j) {
      out += ",";
      const start = tableOff[j];
      const stop = start + (1 << tableBit[j]);
      for (let i = start; i < stop; ++i) {
        out += (tableBi[i] & 0xf).toString(16).toUpperCase();
      }
    }
    return out;
  }

  private resolveImportedEncoding(
    imported: string | null | undefined,
    flagsProto: number,
    needsReversing: boolean
  ): string | null {
    if (imported == null) {
      return null;
    }
    if (!imported.startsWith("@")) {
      return imported;
    }
    if (this.readFileSync === undefined) {
      throw new Error("importedEncoding @file requires a readFileSync callback");
    }

    const path = imported.slice(1);
    const raw = this.readFileSync(path);
    let asText = "";
    for (let i = 0; i < raw.length; i++) {
      asText += String.fromCharCode(raw[i]);
    }
    asText = asText.trim();
    if (/^[0-9a-fA-F,]+$/.test(asText)) {
      return asText.toUpperCase();
    }
    return this.decodeEncodingFromBinary(raw, flagsProto, needsReversing);
  }

  crunch(input: Uint8Array, opts: Partial<CrunchOptions> = {}): { data: Uint8Array; info: CrunchInfo } {
    const multi = this.crunchMulti([input], opts);
    return { data: multi.data[0], info: multi.info[0] };
  }

  exportEncodingBinary(
    encoding: string,
    opts: Partial<CrunchOptions> = {}
  ): Uint8Array {
    const options: CrunchOptions = { ...DEFAULT_CRUNCH_OPTIONS, ...opts };
    const emd: EncodeMatchData = { out: null, priv: null };
    optimalInit(emd, options.flagsNoTrait, options.flagsProto);
    optimalEncodingImport(emd, encoding);

    const out = doOutputBackwards(null, null, emd, {
      ...options,
      outputHeader: true
    });
    optimalFree(emd);

    // do_output_backwards produces backward order, read_encoding_to_buf reverses it.
    const data = new Uint8Array(out.output);
    reverseBuffer(data);
    return data;
  }

  crunchMulti(inputs: Uint8Array[], opts: Partial<CrunchOptions> = {}): CrunchMultiResult {
    const options: CrunchOptions = { ...DEFAULT_CRUNCH_OPTIONS, ...opts };
    const needsReversing = (!options.directionForward ? 1 : 0) ^ (options.writeReverse ? 1 : 0);
    options.importedEncoding = this.resolveImportedEncoding(
      options.importedEncoding,
      options.flagsProto,
      needsReversing !== 0
    );

    const inbufs = inputs.map(input => new Uint8Array(input));
    if (options.directionForward) {
      for (const inbuf of inbufs) {
        reverseBuffer(inbuf);
      }
    }

    const ctxList = inbufs.map(
      inbuf =>
        new MatchContext(
          inbuf,
          null,
          options.maxLen,
          options.maxOffset,
          options.favorSpeed
        )
    );

    const emd: EncodeMatchData = { out: null, priv: null };
    optimalInit(emd, options.flagsNoTrait, options.flagsProto);

    const snpList = doCompressBackwardsMulti(ctxList, emd, options);
    const encoding = optimalEncodingExport(emd);
    const outList = ctxList.map((ctx, i) =>
      doOutputBackwards(ctx, snpList[i], emd, options)
    );
    optimalFree(emd);

    const outDataList = outList.map(out => out.output);
    if (options.directionForward) {
      for (const outData of outDataList) {
        reverseBuffer(outData);
      }
      for (const inbuf of inbufs) {
        reverseBuffer(inbuf);
      }
    }
    if (options.writeReverse) {
      for (const outData of outDataList) {
        reverseBuffer(outData);
      }
    }

    const info = outList.map(out => out.info);
    const mergedInfo: CrunchInfo = {
      traitsUsed: 0,
      maxLen: 0,
      maxOffset: 0,
      neededSafetyOffset: 0
    };
    for (const ci of info) {
      mergedInfo.traitsUsed |= ci.traitsUsed;
      if (ci.maxLen > mergedInfo.maxLen) {
        mergedInfo.maxLen = ci.maxLen;
      }
      if (ci.maxOffset > mergedInfo.maxOffset) {
        mergedInfo.maxOffset = ci.maxOffset;
      }
      if (ci.neededSafetyOffset > mergedInfo.neededSafetyOffset) {
        mergedInfo.neededSafetyOffset = ci.neededSafetyOffset;
      }
    }

    return { data: outDataList, info, mergedInfo, encoding };
  }
}
