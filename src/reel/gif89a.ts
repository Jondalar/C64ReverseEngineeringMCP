// Spec 812 — an animated GIF89a written straight from the machine's colour indices.
//
// The video chip already hands us what a GIF wants: 384x272, one byte per pixel,
// each a 4-bit colour index, plus the 16 RGB entries that go with it. A GIF global
// colour table is a palette of exactly that shape and GIF pixel data IS palette
// indices — so there is nothing to quantize, nothing to dither, and no colour that
// drifts between frames. That is why this file is short, and it is also why the
// palette is taken from the machine rather than kept as a second copy here.
//
// Structure produced (GIF89a, Appendix B of the 89a spec):
//
//   "GIF89a"
//   Logical Screen Descriptor      w, h, packed(GCT|res|size), bg, aspect
//   Global Colour Table            16 x RGB
//   Application Extension          NETSCAPE2.0, loop forever
//   per frame:
//     Graphic Control Extension    disposal=2 (restore to background), delay
//     Image Descriptor             full-frame, no local table, not interlaced
//     LZW data                     min-code-size, then <=255-byte sub-blocks
//   0x3B                           trailer
//
// `disposal = 2` is what makes the cut HARD: each frame replaces the canvas
// instead of compositing onto it, which is what a release reel wants and what a
// crossfade would violate.

export interface Frame {
  /** `width * height` palette indices, each < the palette length. */
  readonly indices: Uint8Array;
}

export interface Encoded {
  readonly bytes: Uint8Array;
  /** Indices into the caller's frame list that were dropped to meet a byte budget. */
  readonly dropped: readonly number[];
}

/** Table-size exponent: the smallest n with 2^n >= len, clamped to 1..8. */
function gctBitsFor(len: number): number {
  let bits = 1;
  while (1 << bits < len && bits < 8) bits += 1;
  return bits;
}

/** LSB-first variable-width bit packer (GIF's bit order). */
class BitWriter {
  private out: number[] = [];
  private acc = 0;
  private bits = 0;

  write(code: number, width: number): void {
    this.acc |= code << this.bits;
    this.bits += width;
    while (this.bits >= 8) {
      this.out.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.bits -= 8;
    }
  }

  finish(): Uint8Array {
    if (this.bits > 0) this.out.push(this.acc & 0xff);
    return Uint8Array.from(this.out);
  }
}

/**
 * GIF-flavoured LZW. Clear code = `1 << minCodeSize`, end code = clear + 1, first
 * assignable code = clear + 2, codes grow to 12 bits and then the table is reset
 * with an explicit clear (which is what keeps a decoder in step).
 *
 * THE ONE LINE THAT MATTERS is the width test below. It was written as
 * `nextCode === (1 << codeSize)` first, and a decoder written from the same
 * understanding read it back perfectly — a green test suite over a stream no real
 * library accepts. A decoder learns each dictionary entry one code LATE (it needs
 * the following code to know that entry's last byte), so it counts one behind the
 * encoder; the encoder must widen STRICTLY PAST the current width or it writes
 * its first wide code while every conforming decoder is still reading narrow ones.
 */
function lzwCompress(data: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const MAX_CODE = 4096;

  const w = new BitWriter();
  let codeSize = minCodeSize + 1;
  const dict = new Map<number, number>();
  const key = (prefix: number, k: number): number => (prefix << 8) | k;
  let nextCode = end + 1;

  w.write(clear, codeSize);
  if (data.length === 0) {
    w.write(end, codeSize);
    return w.finish();
  }

  let prefix = data[0];
  for (let i = 1; i < data.length; i++) {
    const k = data[i];
    const found = dict.get(key(prefix, k));
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    w.write(prefix, codeSize);
    if (nextCode < MAX_CODE) {
      dict.set(key(prefix, k), nextCode);
      nextCode += 1;
      if (nextCode > 1 << codeSize && codeSize < 12) codeSize += 1;
    } else {
      w.write(clear, codeSize);
      dict.clear();
      nextCode = end + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  w.write(prefix, codeSize);
  w.write(end, codeSize);
  return w.finish();
}

/** Split data into <=255-byte sub-blocks, each length-prefixed, terminated by 0. */
function writeSubBlocks(out: number[], data: Uint8Array): void {
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, Math.min(i + 255, data.length));
    out.push(chunk.length);
    for (const b of chunk) out.push(b);
  }
  out.push(0x00);
}

/**
 * Encode `frames` as a looping GIF89a. `palette` is a flat RGB byte run (the shape
 * the machine hands back), 2..256 entries; the global colour table is padded to
 * the next power of two, as the format requires.
 */
export function encode(
  width: number,
  height: number,
  palette: Uint8Array,
  frames: readonly Frame[],
  delayCentiseconds: number,
): Uint8Array {
  if (frames.length === 0) throw new Error("gif89a: no frames");
  if (palette.length % 3 !== 0) throw new Error(`gif89a: palette is ${palette.length} bytes, not a whole number of RGB entries`);
  const entries = palette.length / 3;
  if (entries < 2 || entries > 256) throw new Error(`gif89a: palette must hold 2..256 entries, got ${entries}`);

  const px = width * height;
  frames.forEach((f, i) => {
    if (f.indices.length !== px) {
      throw new Error(`gif89a: frame ${i} is ${f.indices.length} bytes, expected ${px} (${width}x${height})`);
    }
  });

  const gctBits = gctBitsFor(entries);
  const gctEntries = 1 << gctBits;
  // The LZW minimum code size must be >= 2 even for a 2-colour image (89a spec).
  const minCodeSize = Math.max(gctBits, 2);

  const out: number[] = [];
  for (const c of "GIF89a") out.push(c.charCodeAt(0));

  // Logical Screen Descriptor
  out.push(width & 0xff, (width >> 8) & 0xff);
  out.push(height & 0xff, (height >> 8) & 0xff);
  // bit7 global colour table present; bits6-4 colour resolution (bits-1);
  // bit3 sort flag (0); bits2-0 table size exponent - 1.
  out.push(0x80 | (((gctBits - 1) & 0x07) << 4) | ((gctBits - 1) & 0x07));
  out.push(0); // background colour index
  out.push(0); // pixel aspect ratio: not specified

  // Global Colour Table, padded to the declared size
  for (let i = 0; i < gctEntries; i++) {
    out.push(palette[i * 3] ?? 0, palette[i * 3 + 1] ?? 0, palette[i * 3 + 2] ?? 0);
  }

  // Netscape looping extension (loop forever)
  out.push(0x21, 0xff, 0x0b);
  for (const c of "NETSCAPE2.0") out.push(c.charCodeAt(0));
  out.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const frame of frames) {
    // Graphic Control Extension.
    // packed: reserved(3) | disposal(3) = 2 | user input(1) = 0 | transparent(1) = 0
    out.push(0x21, 0xf9, 0x04, 2 << 2);
    out.push(delayCentiseconds & 0xff, (delayCentiseconds >> 8) & 0xff);
    out.push(0x00); // transparent colour index (unused)
    out.push(0x00); // block terminator

    // Image Descriptor: full frame, no local table, not interlaced
    out.push(0x2c);
    out.push(0, 0, 0, 0); // left, top
    out.push(width & 0xff, (width >> 8) & 0xff);
    out.push(height & 0xff, (height >> 8) & 0xff);
    out.push(0x00);

    out.push(minCodeSize);
    writeSubBlocks(out, lzwCompress(frame.indices, minCodeSize));
  }

  out.push(0x3b); // trailer
  return Uint8Array.from(out);
}

/**
 * Encode under a hard byte budget. Over budget, FRAMES ARE DROPPED — never
 * re-encoded at lower fidelity and never truncated. A truncated GIF is a corrupt
 * file, and a silently degraded one is a lie about what the machine drew.
 *
 * Frames go from the middle outwards, so the first and last — the ones that open
 * and close the reel — are the last to be lost. Returns which indices went.
 */
export function encodeWithin(
  width: number,
  height: number,
  palette: Uint8Array,
  frames: readonly Frame[],
  delayCentiseconds: number,
  maxBytes: number,
): Encoded {
  const keep = frames.map((_, i) => i);
  const dropped: number[] = [];

  for (;;) {
    const bytes = encode(width, height, palette, keep.map((i) => frames[i]), delayCentiseconds);
    if (bytes.length <= maxBytes) return { bytes, dropped };
    if (keep.length <= 1) {
      throw new Error(
        `gif89a: a single ${width}x${height} frame is ${bytes.length} bytes, over the ` +
          `${maxBytes}-byte budget — nothing left to drop`,
      );
    }
    dropped.push(keep.splice(Math.floor(keep.length / 2), 1)[0]);
  }
}

// ---------------------------------------------------------------------------
// Structural verification
// ---------------------------------------------------------------------------

export interface GifStructure {
  readonly width: number;
  readonly height: number;
  readonly paletteEntries: number;
  readonly frames: number;
  /** Per-frame delay in centiseconds, in file order. */
  readonly delays: readonly number[];
  /** Per-frame disposal method, in file order. */
  readonly disposals: readonly number[];
  readonly loopsForever: boolean;
}

/**
 * Walk a GIF89a as blocks.
 *
 * This is the honest check. Scanning a GIF for the `21 F9` graphic-control marker
 * FALSE-POSITIVES inside LZW pixel data, because that byte pair is ordinary
 * compressed output — the only way to know how many frames a GIF has is to walk
 * it. Errors at the first structural surprise rather than guessing: a reel that
 * does not parse is not a reel.
 */
export function parseStructure(bytes: Uint8Array): GifStructure {
  let p = 0;
  const need = (at: number, n: number): void => {
    if (at + n > bytes.length) throw new Error(`gif: truncated at ${at} (wanted ${n} more)`);
  };
  const ascii = (at: number, n: number): string =>
    Array.from(bytes.subarray(at, at + n), (b) => String.fromCharCode(b)).join("");

  need(p, 6);
  if (ascii(0, 6) !== "GIF89a") throw new Error("gif: not a GIF89a header");
  p += 6;

  need(p, 7);
  const width = bytes[p] | (bytes[p + 1] << 8);
  const height = bytes[p + 2] | (bytes[p + 3] << 8);
  const packed = bytes[p + 4];
  p += 7;

  let paletteEntries = 0;
  if (packed & 0x80) {
    paletteEntries = 1 << ((packed & 0x07) + 1);
    need(p, paletteEntries * 3);
    p += paletteEntries * 3;
  }

  const skipSubBlocks = (at: number): number => {
    let q = at;
    for (;;) {
      if (q >= bytes.length) throw new Error(`gif: sub-block chain runs off the end at ${q}`);
      const len = bytes[q];
      q += 1;
      if (len === 0) return q;
      if (q + len > bytes.length) throw new Error(`gif: sub-block of ${len} at ${q} runs off the end`);
      q += len;
    }
  };

  let frames = 0;
  const delays: number[] = [];
  const disposals: number[] = [];
  let loopsForever = false;
  let pending: { delay: number; disposal: number } | undefined;

  for (;;) {
    need(p, 1);
    const block = bytes[p];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      need(p + 1, 1);
      const label = bytes[p + 1];
      p += 2;
      need(p, 1);
      const len = bytes[p];
      if (label === 0xf9) {
        if (len !== 4) throw new Error(`gif: graphic control block is ${len} bytes, expected 4`);
        need(p + 1, 4);
        pending = { delay: bytes[p + 2] | (bytes[p + 3] << 8), disposal: (bytes[p + 1] >> 2) & 0x07 };
      } else if (label === 0xff) {
        need(p + 1, len);
        if (ascii(p + 1, len) === "NETSCAPE2.0") loopsForever = true;
      } else {
        need(p + 1, len);
      }
      p = skipSubBlocks(p + 1 + len);
      continue;
    }
    if (block === 0x2c) {
      need(p + 1, 9);
      const lpacked = bytes[p + 9];
      p += 10;
      if (lpacked & 0x80) {
        const local = 3 * (1 << ((lpacked & 0x07) + 1));
        need(p, local);
        p += local;
      }
      need(p, 1);
      p = skipSubBlocks(p + 1); // past the LZW minimum code size
      frames += 1;
      delays.push(pending?.delay ?? 0);
      disposals.push(pending?.disposal ?? 0);
      pending = undefined;
      continue;
    }
    throw new Error(`gif: unexpected block 0x${block.toString(16).padStart(2, "0")} at ${p}`);
  }

  return { width, height, paletteEntries, frames, delays, disposals, loopsForever };
}
