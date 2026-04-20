/**
 * ByteBoozer 2 cruncher — pure-TypeScript port of the reference encoder at
 *   /Users/alex/Development/C64/Tools/ByteBoozer2/b2/cruncher.c
 *
 * The port mirrors the original algorithm byte-for-byte:
 *
 *   1. `setupHelpStructures()`  — build RLE spans + linked list of 16-bit pair
 *                                 positions for fast match lookup.
 *   2. `findMatches()`          — backward dynamic programming over the input.
 *                                 At each position, compute the cheapest path
 *                                 forward considering all matches up to length
 *                                 255 and literal-extension from the previous
 *                                 node.
 *   3. `writeOutput()`          — emit the BB2 token stream (copy bits +
 *                                 Elias-gamma length + variable-width offset
 *                                 + inverted low byte for long offsets +
 *                                 $ff terminator).
 *
 * Variants — the cruncher outputs the raw BB2 token stream. File wrappers
 * (PRG, clipped, Lykia, executable SFX) are built on top by the caller:
 *
 *   - Standard PRG (`b2 <file>`)                 : 4-byte header,
 *     [loadLo loadHi destLo destHi] + BB2 stream.
 *   - Clipped     (`b2 -b <file>`)               : 2-byte header,
 *     [destLo destHi] + BB2 stream.
 *   - Lykia        (Protovision PTV Megabyter)   : 4-byte header,
 *     [destLo destHi endLo endHi] + BB2 stream.
 *   - Executable SFX (`b2 -c <addr> <file>`)     : $0801 BASIC stub + 0xd5
 *     byte decruncher + BB2 stream. NOT implemented yet.
 *
 * Output goal: byte-exact identity with the reference `b2 -b` CLI on any
 * input. Round-trip safe: `depack(pack(x)) === x` for every byte sequence.
 */

// ---------------------------------------------------------------------------
//  Offset class encoding tables — identical constants to cruncher.c
// ---------------------------------------------------------------------------
const NUM_BITS_SHORT = [3, 6, 8, 10];
const NUM_BITS_LONG = [4, 7, 10, 13];

const LEN_SHORT = NUM_BITS_SHORT.map((n) => 1 << n);     // [8, 64, 256, 1024]
const LEN_LONG = NUM_BITS_LONG.map((n) => 1 << n);       // [16, 128, 1024, 8192]

const MAX_OFFSET = LEN_LONG[3]!;        // 8192
const MAX_OFFSET_SHORT = LEN_SHORT[3]!; // 1024

// ---------------------------------------------------------------------------

interface Node {
  cost: number;
  next: number;
  litLen: number;
  offset: number;
}

interface RleInfo {
  value: number;
  valueAfter: number;
  length: number;
}

/**
 * Result of a crunch operation. `stream` is the BB2 token stream without any
 * file wrapper: no load address, no destination pointer. The caller supplies
 * those when packaging for a specific on-disk format.
 */
export interface CrunchResult {
  /** BB2 token stream, ready to be prefixed with a header of the caller's choosing. */
  stream: Uint8Array;
  /** Number of bytes of input that were crunched. */
  inputSize: number;
  /** Margin bytes required for in-place decrunching. See `b2` docs for details. */
  margin: number;
}

export class ByteBoozerCruncher {
  private ibuf!: Uint8Array;
  private ibufSize = 0;

  private context!: Node[];
  private link!: Uint32Array;
  private rleInfo!: RleInfo[];
  private first!: Uint32Array;
  private last!: Uint32Array;

  private obuf!: Uint8Array;
  private put = 0;
  private curByte = 0;
  private curCnt = 0;
  private curIndex = 0;

  /**
   * Crunch a raw byte buffer. The caller owns the wrapping logic — this
   * function returns only the BB2 stream itself (tokens, no header).
   */
  crunch(input: Uint8Array): CrunchResult {
    this.ibuf = input;
    this.ibufSize = input.length;

    if (this.ibufSize === 0) {
      // Empty input: emit just a terminator.
      this.obuf = new Uint8Array(32);
      this.put = 0;
      this.curByte = 0;
      this.curCnt = 8;
      this.curIndex = this.put;
      this.put++;
      this.wBit(1);
      this.wLength(0xff);
      this.wFlush();
      return {
        stream: this.obuf.slice(0, this.put),
        inputSize: 0,
        margin: 0,
      };
    }

    // Allocate helper structures.
    this.context = new Array<Node>(this.ibufSize);
    for (let i = 0; i < this.ibufSize; i++) {
      this.context[i] = { cost: 0, next: 0, litLen: 0, offset: 0 };
    }

    this.link = new Uint32Array(this.ibufSize);
    this.rleInfo = new Array<RleInfo>(this.ibufSize);
    for (let i = 0; i < this.ibufSize; i++) {
      this.rleInfo[i] = { value: 0, valueAfter: 0, length: 0 };
    }
    this.first = new Uint32Array(65536);
    this.last = new Uint32Array(65536);

    this.setupHelpStructures();
    this.findMatches();

    // Output buffer — worst case is input size plus a bit of header room.
    this.obuf = new Uint8Array(this.ibufSize + 1024);
    const margin = this.writeOutput();

    return {
      stream: this.obuf.slice(0, this.put),
      inputSize: this.ibufSize,
      margin,
    };
  }

  // --------------------------------------------------------- bit writer ---

  private wBit(bit: number): void {
    if (this.curCnt === 0) {
      this.obuf[this.curIndex] = this.curByte;
      this.curIndex = this.put;
      this.curCnt = 8;
      this.curByte = 0;
      this.put++;
    }
    this.curByte = ((this.curByte << 1) | (bit & 1)) & 0xff;
    this.curCnt--;
  }

  private wFlush(): void {
    while (this.curCnt !== 0) {
      this.curByte = (this.curByte << 1) & 0xff;
      this.curCnt--;
    }
    this.obuf[this.curIndex] = this.curByte;
  }

  private wByte(b: number): void {
    this.obuf[this.put++] = b & 0xff;
  }

  private wBytes(fromIndex: number, len: number): void {
    for (let i = 0; i < len; i++) {
      this.wByte(this.ibuf[fromIndex + i]!);
    }
  }

  private wLength(len: number): void {
    let bit = 0x80;
    while ((len & bit) === 0) {
      bit >>= 1;
    }

    while (bit > 1) {
      this.wBit(1);
      bit >>= 1;
      this.wBit((len & bit) === 0 ? 0 : 1);
    }

    if (len < 0x80) {
      this.wBit(0);
    }
  }

  private wOffset(offset: number, matchLen: number): void {
    let i = 0;
    let n = 0;
    if (matchLen === 1) {
      for (let k = 0; k < 4; k++) {
        const lower = k === 0 ? 0 : LEN_SHORT[k - 1]!;
        const upper = LEN_SHORT[k]!;
        if (offset >= lower && offset < upper) {
          i = k;
          n = NUM_BITS_SHORT[k]!;
          break;
        }
      }
    } else {
      for (let k = 0; k < 4; k++) {
        const lower = k === 0 ? 0 : LEN_LONG[k - 1]!;
        const upper = LEN_LONG[k]!;
        if (offset >= lower && offset < upper) {
          i = k;
          n = NUM_BITS_LONG[k]!;
          break;
        }
      }
    }

    this.wBit((i & 2) === 0 ? 0 : 1);
    this.wBit((i & 1) === 0 ? 0 : 1);

    if (n >= 8) {
      // Offset occupies 2 bytes: write the high bits, then the low byte inverted.
      let b = 1 << n;
      while (b > 0x100) {
        b >>= 1;
        this.wBit((b & offset) === 0 ? 0 : 1);
      }
      this.wByte((offset & 0xff) ^ 0xff);
      // (the encoder discards the low byte from `offset` here; we have already
      // written it out as an inverted full byte.)
    } else {
      // Offset fits in one byte: emit n inverted bits.
      let b = 1 << n;
      while (b > 1) {
        b >>= 1;
        this.wBit((b & offset) === 0 ? 1 : 0);
      }
    }
  }

  // --------------------------------------------------------- cost model ---

  private costOfLength(len: number): number {
    if (len === 1) return 1;
    if (len >= 2 && len <= 3) return 3;
    if (len >= 4 && len <= 7) return 5;
    if (len >= 8 && len <= 15) return 7;
    if (len >= 16 && len <= 31) return 9;
    if (len >= 32 && len <= 63) return 11;
    if (len >= 64 && len <= 127) return 13;
    if (len >= 128 && len <= 255) return 14;
    throw new Error(`costOfLength got wrong value: ${len}`);
  }

  private costOfOffset(offset: number, matchLen: number): number {
    if (matchLen === 1) {
      for (let k = 0; k < 4; k++) {
        const lower = k === 0 ? 0 : LEN_SHORT[k - 1]!;
        const upper = LEN_SHORT[k]!;
        if (offset >= lower && offset < upper) return NUM_BITS_SHORT[k]!;
      }
    } else {
      for (let k = 0; k < 4; k++) {
        const lower = k === 0 ? 0 : LEN_LONG[k - 1]!;
        const upper = LEN_LONG[k]!;
        if (offset >= lower && offset < upper) return NUM_BITS_LONG[k]!;
      }
    }
    throw new Error(`costOfOffset got wrong offset: ${offset}`);
  }

  private costOfMatch(len: number, offset: number): number {
    let cost = 1; // copy bit
    cost += this.costOfLength(len - 1);
    cost += 2; // num-offset-bits selector
    cost += this.costOfOffset(offset - 1, len - 1);
    return cost;
  }

  private costOfLiteral(oldCost: number, litLen: number): number {
    let newCost = oldCost + 8;
    switch (litLen) {
      case 1:
      case 128:
        newCost++;
        break;
      case 2:
      case 4:
      case 8:
      case 16:
      case 32:
      case 64:
        newCost += 2;
        break;
      default:
        break;
    }
    return newCost;
  }

  // ------------------------------------------------- help structures setup ---

  private setupHelpStructures(): void {
    // RLE-info: for each run-of-repeated-bytes anchor, remember the length.
    let pos = this.ibufSize - 1;
    while (pos > 0) {
      const cur = this.ibuf[pos]!;
      if (cur === this.ibuf[pos - 1]) {
        let len = 2;
        while (pos >= len && cur === this.ibuf[pos - len]!) {
          len++;
        }
        this.rleInfo[pos]!.length = len;
        this.rleInfo[pos]!.value = cur;
        this.rleInfo[pos]!.valueAfter = pos >= len ? this.ibuf[pos - len]! : cur;
        pos -= len;
      } else {
        pos--;
      }
    }

    // Linked list: for each 16-bit (lo, hi) pair seen in the input, chain
    // together the positions where the pair occurs. We iterate backwards so
    // that `first[key]` holds the earliest occurrence and `last[key]` the
    // most recent.
    this.first.fill(0);
    this.last.fill(0);

    pos = this.ibufSize - 1;
    let cur = this.ibuf[pos]!;
    while (pos > 0) {
      cur = ((cur << 8) | this.ibuf[pos - 1]!) & 0xffff;

      if (this.first[cur] === 0) {
        this.first[cur] = pos;
        this.last[cur] = pos;
      } else {
        this.link[this.last[cur]!] = pos;
        this.last[cur] = pos;
      }

      if (this.rleInfo[pos]!.length === 0) {
        pos--;
      } else {
        pos -= this.rleInfo[pos]!.length - 1;
      }
    }
  }

  // --------------------------------------------------------- match search ---

  private findMatches(): void {
    interface Match {
      length: number;
      offset: number;
    }

    const matches: Match[] = new Array<Match>(256);
    for (let i = 0; i < 256; i++) matches[i] = { length: 0, offset: 0 };

    const lastNode: Node = { cost: 0, next: 0, litLen: 0, offset: 0 };

    let pos = this.ibufSize - 1;
    let cur = this.ibuf[pos]!;

    while (pos >= 0) {
      for (let i = 0; i < 256; i++) {
        matches[i]!.length = 0;
        matches[i]!.offset = 0;
      }

      cur = (cur << 8) & 0xffff;
      if (pos > 0) cur |= this.ibuf[pos - 1]!;

      let scn = this.first[cur]!;
      scn = this.link[scn]!;

      let longestMatch = 0;

      if (this.rleInfo[pos]!.length === 0) {
        // Not at the start of an RLE run — regular match search.
        while (((pos - scn) <= MAX_OFFSET) && (scn > 0) && (longestMatch < 255)) {
          let len = 2;
          while ((len < 255) && (scn >= len) && (this.ibuf[scn - len] === this.ibuf[pos - len])) {
            len++;
          }

          const offset = pos - scn;

          if (len > longestMatch) {
            longestMatch = len;
            let keepLen = len;
            while (keepLen >= 2 && matches[keepLen]!.length === 0) {
              if (keepLen > 2 || (keepLen === 2 && offset <= MAX_OFFSET_SHORT)) {
                matches[keepLen]!.length = keepLen;
                matches[keepLen]!.offset = offset;
              }
              keepLen--;
            }
          }

          scn = this.link[scn]!;
        }

        this.first[cur] = this.link[this.first[cur]!]!; // advance head
      } else {
        // At the anchor of an RLE run — start with the self-RLE match.
        const rleLen = this.rleInfo[pos]!.length;
        const rleValAfter = this.rleInfo[pos]!.valueAfter;

        let len = rleLen - 1;
        if (len > 1) {
          if (len > 255) len = 255;
          longestMatch = len;
          while (len >= 2) {
            matches[len]!.length = len;
            matches[len]!.offset = 1;
            len--;
          }
        }

        while (((pos - scn) <= MAX_OFFSET) && (scn > 0) && (longestMatch < 255)) {
          if ((this.rleInfo[scn]!.length > longestMatch) && (rleLen > longestMatch)) {
            const offset = pos - scn;
            let mlen = this.rleInfo[scn]!.length;
            if (mlen > rleLen) mlen = rleLen;
            if (mlen > 2 || (mlen === 2 && offset <= MAX_OFFSET_SHORT)) {
              matches[mlen]!.length = mlen;
              matches[mlen]!.offset = offset;
              longestMatch = mlen;
            }
          }

          if ((this.rleInfo[scn]!.length >= rleLen) && (this.rleInfo[scn]!.valueAfter === rleValAfter)) {
            let mlen = rleLen;
            const offset = pos - scn + (this.rleInfo[scn]!.length - rleLen);

            if (offset <= MAX_OFFSET) {
              while ((mlen < 255) && (pos >= offset + mlen) &&
                     (this.ibuf[pos - (offset + mlen)] === this.ibuf[pos - mlen])) {
                mlen++;
              }
              if (mlen > longestMatch) {
                longestMatch = mlen;
                let keepLen = mlen;
                while (keepLen >= 2 && matches[keepLen]!.length === 0) {
                  if (keepLen > 2 || (keepLen === 2 && offset <= MAX_OFFSET_SHORT)) {
                    matches[keepLen]!.length = keepLen;
                    matches[keepLen]!.offset = offset;
                  }
                  keepLen--;
                }
              }
            }
          }

          scn = this.link[scn]!;
        }

        if (this.rleInfo[pos]!.length > 2) {
          // Expand RLE to next position.
          this.rleInfo[pos - 1]!.length = this.rleInfo[pos]!.length - 1;
          this.rleInfo[pos - 1]!.value = this.rleInfo[pos]!.value;
          this.rleInfo[pos - 1]!.valueAfter = this.rleInfo[pos]!.valueAfter;
        } else {
          this.first[cur] = this.link[this.first[cur]!]!;
        }
      }

      // Visit nodes reachable from this position via any collected match.
      for (let i = 255; i > 0; i--) {
        const mLen = matches[i]!.length;
        const mOff = matches[i]!.offset;
        if (mLen !== 0) {
          const targetIdx = pos - mLen + 1;
          const target = this.context[targetIdx]!;
          let currentCost = lastNode.cost;
          currentCost += this.costOfMatch(mLen, mOff);

          if (target.cost === 0 || target.cost > currentCost) {
            target.cost = currentCost;
            target.next = pos + 1;
            target.litLen = 0;
            target.offset = mOff;
          }
        }
      }

      // Cost of extending literal run.
      const litLen = lastNode.litLen + 1;
      const litCost = this.costOfLiteral(lastNode.cost, litLen);
      const here = this.context[pos]!;
      if (here.cost === 0 || here.cost >= litCost) {
        here.cost = litCost;
        here.next = pos + 1;
        here.litLen = litLen;
      }

      lastNode.cost = here.cost;
      lastNode.next = here.next;
      lastNode.litLen = here.litLen;
      lastNode.offset = here.offset;

      pos--;
    }
  }

  // --------------------------------------------------------- bitstream emit ---

  private writeOutput(): number {
    this.put = 0;
    this.curByte = 0;
    this.curCnt = 8;
    this.curIndex = this.put;
    this.put++;

    let maxDiff = 0;
    let needCopyBit = true;
    let i = 0;

    while (i < this.ibufSize) {
      const link = this.context[i]!.next;
      const litLen = this.context[i]!.litLen;
      const offset = this.context[i]!.offset;

      if (litLen === 0) {
        // Match.
        const len = link - i;
        if (needCopyBit) this.wBit(1);
        this.wLength(len - 1);
        this.wOffset(offset - 1, len - 1);
        i = link;
        needCopyBit = true;
      } else {
        // Literal run — may need to split into 255-byte chunks.
        needCopyBit = false;
        let remaining = litLen;
        while (remaining > 0) {
          const chunk = remaining < 255 ? remaining : 255;
          this.wBit(0);
          this.wLength(chunk);
          this.wBytes(i, chunk);
          if (remaining === 255) {
            needCopyBit = true;
          }
          remaining -= chunk;
          i += chunk;
        }
      }

      if (i - this.put > maxDiff) {
        maxDiff = i - this.put;
      }
    }

    if (needCopyBit) this.wBit(1);
    this.wLength(0xff);
    this.wFlush();

    return maxDiff - (i - this.put);
  }
}

// ---------------------------------------------------------------------------
//  File wrappers — build header bytes around the raw BB2 stream
// ---------------------------------------------------------------------------

export interface PackResultRaw {
  stream: Uint8Array;
  destAddress: number;
  inputSize: number;
  margin: number;
}

/**
 * High-level helper: crunch an input buffer and wrap it in the selected file
 * format. `inputLoadAddress` is the PRG-style load address of the source file
 * (first 2 bytes of a .prg). Pass `0` if the input is raw (no PRG header) and
 * you want the destination address elsewhere.
 */
export function packStandardPrg(
  inputPayload: Uint8Array,
  inputLoadAddress: number,
  relocateTo?: number,
): { output: Uint8Array; result: PackResultRaw } {
  const cruncher = new ByteBoozerCruncher();
  const { stream, inputSize, margin } = cruncher.crunch(inputPayload);

  const destAddress = inputLoadAddress;
  // Mirror the C code's start-address logic for non-executable, non-relocated output:
  //   startAddress = sourceLoadAddress + (ibufSize - packLen - 2 + margin)
  // For a relocated build: startAddress = relocateTo - packLen - 2
  let startAddress = inputLoadAddress + (inputSize - stream.length - 2 + margin);
  if (relocateTo !== undefined) {
    startAddress = relocateTo - stream.length - 2;
  }

  const output = new Uint8Array(4 + stream.length);
  output[0] = startAddress & 0xff;
  output[1] = (startAddress >> 8) & 0xff;
  output[2] = destAddress & 0xff;
  output[3] = (destAddress >> 8) & 0xff;
  output.set(stream, 4);
  return {
    output,
    result: { stream, destAddress, inputSize, margin },
  };
}

/**
 * Clipped output (`b2 -b`): drops the PRG load address, keeps the 2-byte
 * destination header and the BB2 stream.
 */
export function packClipped(
  inputPayload: Uint8Array,
  destAddress: number,
): { output: Uint8Array; result: PackResultRaw } {
  const cruncher = new ByteBoozerCruncher();
  const { stream, inputSize, margin } = cruncher.crunch(inputPayload);

  const output = new Uint8Array(2 + stream.length);
  output[0] = destAddress & 0xff;
  output[1] = (destAddress >> 8) & 0xff;
  output.set(stream, 2);
  return {
    output,
    result: { stream, destAddress, inputSize, margin },
  };
}

/**
 * Lykia BB2 format: 4-byte header `[destLo destHi endLo endHi]` + BB2 stream.
 * The Lykia `$020C` decoder reads these four bytes as seed bytes for its
 * output pointer and end-of-stream sentinel, then decodes tokens until the
 * output pointer reaches the sentinel — no in-stream terminator is
 * consulted. Callers are expected to supply the input's *end* address,
 * which equals destAddress + inputSize.
 */
export function packLykia(
  inputPayload: Uint8Array,
  destAddress: number,
): { output: Uint8Array; result: PackResultRaw } {
  const cruncher = new ByteBoozerCruncher();
  const { stream, inputSize, margin } = cruncher.crunch(inputPayload);
  const endAddress = destAddress + inputSize;

  const output = new Uint8Array(4 + stream.length);
  output[0] = destAddress & 0xff;
  output[1] = (destAddress >> 8) & 0xff;
  output[2] = endAddress & 0xff;
  output[3] = (endAddress >> 8) & 0xff;
  output.set(stream, 4);
  return {
    output,
    result: { stream, destAddress, inputSize, margin },
  };
}
