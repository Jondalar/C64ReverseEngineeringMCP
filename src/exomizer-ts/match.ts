import { Match } from "./types.js";

interface MatchNode {
  index: number;
  next: MatchNode | null;
}

interface PreCalc {
  single: MatchNode | null;
  cache: Match | null;
}

export type MatchEnumNext = (enumerator: unknown) => Match | null;

const matchKeepThis = (mp: Match): boolean => {
  if (mp.len === 1 && mp.offset > 34) {
    return false;
  }
  return true;
};

export class MatchContext {
  private readonly info: PreCalc[];
  readonly rle: number[];
  readonly rleR: number[];

  readonly buf: Uint8Array;
  readonly noreadBuf: Uint8Array | null;
  readonly len: number;
  readonly maxOffset: number;
  readonly maxLen: number;
  readonly favorSpeed: boolean;

  constructor(
    input: Uint8Array,
    noreadInput: Uint8Array | null,
    maxLen: number,
    maxOffset: number,
    favorSpeed: boolean
  ) {
    this.buf = input;
    this.noreadBuf = noreadInput;
    this.len = input.length;
    this.maxOffset = maxOffset;
    this.maxLen = maxLen;
    this.favorSpeed = favorSpeed;

    this.info = new Array(this.len + 1);
    for (let i = 0; i < this.info.length; i++) {
      this.info[i] = { single: null, cache: null };
    }
    this.rle = new Array(this.len + 1).fill(0);
    this.rleR = new Array(this.len + 1).fill(0);

    this.initRle();
    this.initSingleNodeChains();
    this.populateCache();
  }

  matchesGet(index: number): Match | null {
    return this.info[index].cache;
  }

  getCacheEnum(): MatchCacheEnum {
    return new MatchCacheEnum(this);
  }

  private isReadable(offset: number): boolean {
    return this.noreadBuf === null || this.noreadBuf[offset] === 0;
  }

  private readBuf(offset: number): number {
    if (offset < 0 || offset >= this.buf.length) {
      return -1;
    }
    if (this.noreadBuf !== null && this.noreadBuf[offset] !== 0) {
      return -1;
    }
    return this.buf[offset];
  }

  private initRle(): void {
    if (this.len <= 0) {
      return;
    }

    let val = this.readBuf(0);
    for (let i = 1; i < this.len; i++) {
      if (val !== -1 && this.buf[i] === val) {
        let mlen = this.rle[i - 1] + 1;
        if (mlen > this.maxLen) {
          mlen = this.maxLen;
        }
        this.rle[i] = mlen;
      } else {
        this.rle[i] = 0;
      }
      val = this.readBuf(i);
    }

    val = this.readBuf(0);
    for (let i = this.len - 2; i >= 0; i--) {
      if (val !== -1 && this.buf[i] === val) {
        let mlen = this.rleR[i + 1] + 1;
        if (mlen > this.maxLen) {
          mlen = this.maxLen;
        }
        this.rleR[i] = mlen;
      } else {
        this.rleR[i] = 0;
      }
      val = this.readBuf(i);
    }
  }

  private initSingleNodeChains(): void {
    const rleMap = new Uint8Array(65536);

    for (let c = 0; c < 256; c++) {
      rleMap.fill(0);

      let prevNp: MatchNode | null = null;
      let trailingNp: MatchNode | null = null;
      for (let i = 0; i < this.len; i++) {
        if (this.buf[i] !== c) {
          continue;
        }

        const rleLen = this.rle[i] & 0xffff;
        if (rleMap[rleLen] === 0 && this.rleR[i] > 16) {
          continue;
        }

        if (this.favorSpeed && this.rleR[i] !== 0 && this.rle[i] !== 0) {
          continue;
        }

        const np: MatchNode = { index: i, next: null };
        rleMap[rleLen] = 1;

        if (prevNp !== null) {
          prevNp.next = np;
          if (this.isReadable(prevNp.index)) {
            trailingNp = prevNp;
          }
        }

        if (trailingNp !== null && this.isReadable(np.index)) {
          let cursor: MatchNode | null = trailingNp;
          while (cursor !== prevNp) {
            const tmp: MatchNode | null = cursor.next;
            cursor.next = np;
            if (tmp === null) {
              break;
            }
            cursor = tmp;
          }
          trailingNp = null;
        }

        this.info[i].single = np;
        prevNp = np;
      }

      while (trailingNp !== null) {
        const tmp = trailingNp.next;
        trailingNp.next = null;
        trailingNp = tmp;
      }

      rleMap.fill(0);
      prevNp = null;
      for (let i = this.len - 1; i >= 0; i--) {
        if (this.buf[i] !== c) {
          continue;
        }

        const rleLen = this.rleR[i] & 0xffff;
        let np = this.info[i].single;
        if (np === null) {
          if (rleMap[rleLen] !== 0 && prevNp !== null && rleLen > 0) {
            np = { index: i, next: prevNp };
            this.info[i].single = np;
          }
        } else if (this.isReadable(np.index)) {
          prevNp = np;
        }

        if (this.rleR[i] > 0) {
          continue;
        }
        const rleLen2 = (this.rle[i] + 1) & 0xffff;
        rleMap[rleLen2] = 1;
      }
    }
  }

  private populateCache(): void {
    for (let i = this.len - 1; i >= 0; i--) {
      this.info[i].cache = this.matchesCalc(i);
    }
  }

  private matchNew(listHead: Match | null, len: number, offset: number): Match {
    if (len === 0) {
      throw new Error("tried to allocate len0 match");
    }
    if (len > this.maxLen) {
      len = this.maxLen;
    }
    return { len, offset, next: listHead };
  }

  private matchesCalc(index: number): Match | null {
    let matches: Match | null = null;
    let mp: Match;

    mp = this.matchNew(matches, 1, 0);
    matches = mp;

    let np = this.info[index].single;
    if (np !== null) {
      np = np.next;
    }

    for (; np !== null; np = np.next) {
      if (np.index > index + this.maxOffset) {
        break;
      }

      const mpLen = mp.offset > 0 ? mp.len : 0;
      const offset = np.index - index;

      let len = mpLen;
      let pos = index + 1 - len;
      while (len > 1 && this.buf[pos] === this.readBuf(pos + offset)) {
        const offset1 = this.rleR[pos];
        const offset2 = this.rleR[pos + offset];
        const skip = offset1 < offset2 ? offset1 : offset2;
        len -= 1 + skip;
        pos += 1 + skip;
      }
      if (len > 1) {
        continue;
      }

      if (offset < 17) {
        mp = this.matchNew(matches, 1, offset);
        matches = mp;
      }

      len = mpLen;
      pos = index - len;
      while (
        len <= this.maxLen &&
        pos >= 0 &&
        this.buf[pos] === this.readBuf(pos + offset)
      ) {
        len++;
        pos--;
      }
      if (len > mpLen || (!this.favorSpeed && len === mpLen)) {
        mp = this.matchNew(matches, index - pos, offset);
        matches = mp;
      }
      if (len > this.maxLen) {
        break;
      }
      if (pos < 0) {
        break;
      }
    }

    return matches;
  }

  matchCachePeek(pos: number): { lit: Match | null; seq: Match | null } {
    let litp: Match | null = null;
    let seqp: Match | null = null;

    if (pos >= 0) {
      let val = this.matchesGet(pos);
      litp = val;
      while (litp !== null && litp.offset !== 0) {
        litp = litp.next;
      }

      if (this.rleR[pos] > 0 && pos + 1 < this.rle.length && this.rle[pos + 1] > 0) {
        val = { offset: 1, len: this.rle[pos + 1], next: val };
      }

      while (val !== null) {
        if (val.offset !== 0) {
          if (matchKeepThis(val)) {
            if (
              seqp === null ||
              val.len > seqp.len ||
              (val.len === seqp.len && val.offset < seqp.offset)
            ) {
              seqp = val;
            }
          }

          if (litp !== null && (litp.offset === 0 || litp.offset > val.offset)) {
            const diff = pos + val.offset < this.rle.length ? this.rle[pos + val.offset] : 0;
            const tmp2: Match = {
              len: 1,
              offset: val.offset > diff ? val.offset - diff : 1,
              next: val.next
            };
            if (matchKeepThis(tmp2)) {
              litp = tmp2;
            }
          }
        }
        val = val.next;
      }
    }

    return { lit: litp, seq: seqp };
  }
}

export class MatchCacheEnum {
  private readonly ctx: MatchContext;
  private pos: number;

  constructor(ctx: MatchContext) {
    this.ctx = ctx;
    this.pos = ctx.len - 1;
  }

  next(): Match | null {
    const { lit, seq } = this.ctx.matchCachePeek(this.pos);

    let val: Match | null = lit;
    if (lit === null) {
      this.pos = this.ctx.len - 1;
      return null;
    }

    if (seq !== null) {
      const next = this.ctx.matchCachePeek(this.pos - 1).seq;
      const bonus = (this.pos & 1) !== 0 && next !== null && next.len < 3 ? 1 : 0;
      if (next === null || seq.len >= next.len + bonus) {
        val = seq;
      }
    }

    if (val !== null) {
      this.pos -= val.len;
    }
    return val;
  }
}

export class MatchConcatEnum {
  private readonly enums: unknown[];
  private readonly nextFn: MatchEnumNext;
  private enumIndex = 0;
  private enumCurrent: unknown | null = null;

  constructor(nextFn: MatchEnumNext, enumerators: unknown[]) {
    this.nextFn = nextFn;
    this.enums = enumerators;
    this.enumCurrent = this.enums.length > 0 ? this.enums[0] : null;
    this.enumIndex = this.enumCurrent === null ? 0 : 1;
  }

  next(): Match | null {
    let mp: Match | null = null;

    for (;;) {
      if (this.enumCurrent === null) {
        if (this.enumIndex >= this.enums.length) {
          return null;
        }
        this.enumCurrent = this.enums[this.enumIndex++];
        continue;
      } else {
        mp = this.nextFn(this.enumCurrent);
        if (mp === null) {
          this.enumCurrent = null;
          continue;
        }
      }
      return mp;
    }
  }
}
