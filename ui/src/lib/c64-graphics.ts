// C64 graphics decoders. Pure functions. Take raw bytes + options, return
// pixel buffers ready to feed into a canvas via ImageData.

// Funkatron's C64 palette (https://gist.github.com/funkatron/758033).
// Index → [R, G, B].
export const C64_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0x00, 0x00, 0x00], // 0 black
  [0xFF, 0xFF, 0xFF], // 1 white
  [0x68, 0x37, 0x2B], // 2 red
  [0x70, 0xA4, 0xB2], // 3 cyan / light blue
  [0x6F, 0x3D, 0x86], // 4 purple
  [0x58, 0x8D, 0x43], // 5 green
  [0x35, 0x28, 0x79], // 6 dark blue
  [0xB8, 0xC7, 0x6F], // 7 yellow
  [0x6F, 0x4F, 0x25], // 8 brown
  [0x43, 0x39, 0x00], // 9 dark brown
  [0x9A, 0x67, 0x59], // 10 light red
  [0x44, 0x44, 0x44], // 11 dark grey
  [0x6C, 0x6C, 0x6C], // 12 mid grey
  [0x9A, 0xD2, 0x84], // 13 light green
  [0x6C, 0x5E, 0xB5], // 14 light blue
  [0x95, 0x95, 0x95], // 15 light grey
];

export interface DecodedImage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray; // RGBA
}

interface PaletteParam {
  fg?: number; // foreground colour index (0..15)
  bg?: number; // background colour index (0..15)
  c1?: number; // multicolour pair colour 1
  c2?: number; // multicolour pair colour 2
}

const DEFAULT_FG = 1;  // white
const DEFAULT_BG = 0;  // black
const DEFAULT_C1 = 11; // dark grey
const DEFAULT_C2 = 12; // mid grey

function paletteRgba(index: number): [number, number, number, number] {
  const safe = ((index % 16) + 16) % 16;
  const [r, g, b] = C64_PALETTE[safe]!;
  return [r, g, b, 0xff];
}

function setPixel(buffer: Uint8ClampedArray, offset: number, rgba: readonly [number, number, number, number]): void {
  buffer[offset] = rgba[0];
  buffer[offset + 1] = rgba[1];
  buffer[offset + 2] = rgba[2];
  buffer[offset + 3] = rgba[3];
}

// Decode a flat sprite block (24x21 monochrome). Each sprite is 64 bytes:
// 21 rows of 3 bytes (one bit per pixel) plus one padding byte. The decoder
// renders all sprite blocks contained in `bytes` into a horizontal strip.
export function decodeSprites(bytes: Uint8Array, options: PaletteParam = {}): DecodedImage {
  const SPRITE_BYTES = 64;
  const SPRITE_WIDTH = 24;
  const SPRITE_HEIGHT = 21;

  const blockCount = Math.max(1, Math.floor(bytes.length / SPRITE_BYTES));
  const width = SPRITE_WIDTH * blockCount;
  const height = SPRITE_HEIGHT;
  const pixels = new Uint8ClampedArray(width * height * 4);

  const fg = paletteRgba(options.fg ?? DEFAULT_FG);
  const bg = paletteRgba(options.bg ?? DEFAULT_BG);

  for (let block = 0; block < blockCount; block += 1) {
    const blockOffset = block * SPRITE_BYTES;
    for (let row = 0; row < SPRITE_HEIGHT; row += 1) {
      for (let columnByte = 0; columnByte < 3; columnByte += 1) {
        const byte = bytes[blockOffset + row * 3 + columnByte] ?? 0;
        for (let bit = 0; bit < 8; bit += 1) {
          const x = block * SPRITE_WIDTH + columnByte * 8 + (7 - bit);
          const y = row;
          const offset = (y * width + x) * 4;
          const rgba = (byte & (1 << bit)) !== 0 ? fg : bg;
          setPixel(pixels, offset, rgba);
        }
      }
    }
  }

  return { width, height, pixels };
}

// Decode a charset block. Each glyph is 8 bytes (1 byte per row, MSB-first).
// `bytes` should be a multiple of 8. We arrange glyphs into a 32-glyph wide
// grid for compact display. Monochrome.
export function decodeCharset(bytes: Uint8Array, options: PaletteParam = {}): DecodedImage {
  const GLYPH_HEIGHT = 8;
  const GLYPH_WIDTH = 8;
  const COLUMNS = 32;

  const glyphCount = Math.max(1, Math.floor(bytes.length / GLYPH_HEIGHT));
  const rows = Math.max(1, Math.ceil(glyphCount / COLUMNS));
  const width = COLUMNS * GLYPH_WIDTH;
  const height = rows * GLYPH_HEIGHT;
  const pixels = new Uint8ClampedArray(width * height * 4);

  const fg = paletteRgba(options.fg ?? DEFAULT_FG);
  const bg = paletteRgba(options.bg ?? DEFAULT_BG);
  // Pre-fill background so partial last row is not transparent.
  for (let i = 0; i < pixels.length; i += 4) setPixel(pixels, i, bg);

  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const gridRow = Math.floor(glyph / COLUMNS);
    const gridCol = glyph % COLUMNS;
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      const byte = bytes[glyph * GLYPH_HEIGHT + row] ?? 0;
      for (let bit = 0; bit < 8; bit += 1) {
        const x = gridCol * GLYPH_WIDTH + (7 - bit);
        const y = gridRow * GLYPH_HEIGHT + row;
        const offset = (y * width + x) * 4;
        const rgba = (byte & (1 << bit)) !== 0 ? fg : bg;
        setPixel(pixels, offset, rgba);
      }
    }
  }

  return { width, height, pixels };
}

// Decode a full hires bitmap (320x200, 8000 bytes, no colour).
// Bitmap layout: 25 rows of 40 cells, each cell is 8x8 stored as 8 bytes
// (1 bit per pixel, MSB-leftmost). When `screen` is provided we use the
// per-cell colour pair (high nibble = fg, low nibble = bg) from the
// 1000-byte screen RAM. Otherwise monochrome.
export function decodeHiresBitmap(
  bytes: Uint8Array,
  options: PaletteParam & { screen?: Uint8Array } = {},
): DecodedImage {
  const width = 320;
  const height = 200;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const fallbackFg = options.fg ?? DEFAULT_FG;
  const fallbackBg = options.bg ?? DEFAULT_BG;

  for (let cellY = 0; cellY < 25; cellY += 1) {
    for (let cellX = 0; cellX < 40; cellX += 1) {
      const cellIndex = cellY * 40 + cellX;
      const cellByteBase = cellIndex * 8;
      let fgIdx = fallbackFg;
      let bgIdx = fallbackBg;
      if (options.screen && options.screen.length > cellIndex) {
        const screenByte = options.screen[cellIndex]!;
        fgIdx = (screenByte >> 4) & 0x0f;
        bgIdx = screenByte & 0x0f;
      }
      const fg = paletteRgba(fgIdx);
      const bg = paletteRgba(bgIdx);
      for (let row = 0; row < 8; row += 1) {
        const byte = bytes[cellByteBase + row] ?? 0;
        for (let bit = 0; bit < 8; bit += 1) {
          const x = cellX * 8 + (7 - bit);
          const y = cellY * 8 + row;
          const offset = (y * width + x) * 4;
          const rgba = (byte & (1 << bit)) !== 0 ? fg : bg;
          setPixel(pixels, offset, rgba);
        }
      }
    }
  }

  return { width, height, pixels };
}

// Decode multicolour bitmap. Bitmap is 320x200 logical but each pixel is
// 2 bits wide ⇒ effective resolution 160x200. Colour pairs:
//   00 -> background ($D021)
//   01 -> screen high nibble
//   10 -> screen low nibble
//   11 -> color RAM ($D800)
// All four channels optional; when missing we fall back to default greys
// so the structure is at least visible.
export function decodeMulticolorBitmap(
  bytes: Uint8Array,
  options: PaletteParam & { screen?: Uint8Array; colorRam?: Uint8Array } = {},
): DecodedImage {
  const width = 320; // doubled-up so the canvas keeps the 320x200 frame
  const height = 200;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const bg = paletteRgba(options.bg ?? DEFAULT_BG);

  for (let cellY = 0; cellY < 25; cellY += 1) {
    for (let cellX = 0; cellX < 40; cellX += 1) {
      const cellIndex = cellY * 40 + cellX;
      const cellByteBase = cellIndex * 8;
      let topIdx = options.fg ?? DEFAULT_C1;
      let midIdx = options.c1 ?? DEFAULT_C2;
      let lowIdx = options.c2 ?? DEFAULT_FG;
      if (options.screen && options.screen.length > cellIndex) {
        const screenByte = options.screen[cellIndex]!;
        topIdx = (screenByte >> 4) & 0x0f;
        midIdx = screenByte & 0x0f;
      }
      if (options.colorRam && options.colorRam.length > cellIndex) {
        lowIdx = options.colorRam[cellIndex]! & 0x0f;
      }
      const colours: Array<readonly [number, number, number, number]> = [
        bg,
        paletteRgba(topIdx),
        paletteRgba(midIdx),
        paletteRgba(lowIdx),
      ];
      for (let row = 0; row < 8; row += 1) {
        const byte = bytes[cellByteBase + row] ?? 0;
        for (let pair = 0; pair < 4; pair += 1) {
          const shift = (3 - pair) * 2;
          const code = (byte >> shift) & 0x03;
          const rgba = colours[code]!;
          const xLeft = cellX * 8 + pair * 2;
          const y = cellY * 8 + row;
          const offsetLeft = (y * width + xLeft) * 4;
          const offsetRight = offsetLeft + 4;
          setPixel(pixels, offsetLeft, rgba);
          setPixel(pixels, offsetRight, rgba);
        }
      }
    }
  }

  return { width, height, pixels };
}
