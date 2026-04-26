// Server-side mirror of the UI's c64-graphics decoders. Pure functions:
// take raw bytes + options, return RGBA pixel buffers ready to feed
// into the PNG encoder.

export const PALETTES: Record<string, ReadonlyArray<readonly [number, number, number]>> = {
  // Funkatron's gist — the default in the UI.
  pepto: [
    [0x00, 0x00, 0x00], [0xFF, 0xFF, 0xFF], [0x68, 0x37, 0x2B], [0x70, 0xA4, 0xB2],
    [0x6F, 0x3D, 0x86], [0x58, 0x8D, 0x43], [0x35, 0x28, 0x79], [0xB8, 0xC7, 0x6F],
    [0x6F, 0x4F, 0x25], [0x43, 0x39, 0x00], [0x9A, 0x67, 0x59], [0x44, 0x44, 0x44],
    [0x6C, 0x6C, 0x6C], [0x9A, 0xD2, 0x84], [0x6C, 0x5E, 0xB5], [0x95, 0x95, 0x95],
  ],
  vice: [
    [0x00, 0x00, 0x00], [0xFF, 0xFF, 0xFF], [0xAF, 0x2A, 0x29], [0x62, 0xD8, 0xCC],
    [0xB0, 0x3F, 0xB6], [0x4A, 0xC6, 0x4A], [0x37, 0x39, 0xC4], [0xE4, 0xED, 0x4E],
    [0xB6, 0x59, 0x1C], [0x68, 0x38, 0x08], [0xEA, 0x74, 0x6C], [0x4D, 0x4D, 0x4D],
    [0x84, 0x84, 0x84], [0xA6, 0xFA, 0x9E], [0x70, 0x7C, 0xE6], [0xB6, 0xB6, 0xB5],
  ],
  colodore: [
    [0x00, 0x00, 0x00], [0xFF, 0xFF, 0xFF], [0x81, 0x33, 0x38], [0x75, 0xCE, 0xC8],
    [0x8E, 0x3C, 0x97], [0x56, 0xAC, 0x4D], [0x2E, 0x2C, 0x9B], [0xED, 0xF1, 0x71],
    [0x8E, 0x50, 0x29], [0x55, 0x38, 0x00], [0xC4, 0x6C, 0x71], [0x4A, 0x4A, 0x4A],
    [0x7B, 0x7B, 0x7B], [0xA9, 0xFF, 0x9F], [0x70, 0x6D, 0xEB], [0xB2, 0xB2, 0xB2],
  ],
};

export type PaletteName = keyof typeof PALETTES;

export interface DecodedImage {
  width: number;
  height: number;
  pixels: Uint8Array; // RGBA
}

export interface PaletteOptions {
  palette?: PaletteName;
  fg?: number;
  bg?: number;
  c1?: number;
  c2?: number;
}

const DEFAULT_FG = 1;
const DEFAULT_BG = 0;
const DEFAULT_C1 = 11;
const DEFAULT_C2 = 12;

function paletteEntry(palette: PaletteName | undefined, index: number): [number, number, number, number] {
  const table = PALETTES[palette ?? "pepto"]!;
  const safe = ((index % 16) + 16) % 16;
  const [r, g, b] = table[safe]!;
  return [r, g, b, 0xff];
}

function fillBackground(pixels: Uint8Array, rgba: readonly [number, number, number, number]): void {
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = rgba[0];
    pixels[i + 1] = rgba[1];
    pixels[i + 2] = rgba[2];
    pixels[i + 3] = rgba[3];
  }
}

function setPixel(pixels: Uint8Array, offset: number, rgba: readonly [number, number, number, number]): void {
  pixels[offset] = rgba[0];
  pixels[offset + 1] = rgba[1];
  pixels[offset + 2] = rgba[2];
  pixels[offset + 3] = rgba[3];
}

export interface SpriteOptions extends PaletteOptions {
  multicolor?: boolean;
  columns?: number;
  gap?: number;
}

export function decodeSprites(bytes: Uint8Array, options: SpriteOptions = {}): DecodedImage {
  const SPRITE_BYTES = 64;
  const SPRITE_WIDTH = 24;
  const SPRITE_HEIGHT = 21;
  const blockCount = Math.max(1, Math.floor(bytes.length / SPRITE_BYTES));
  const columns = Math.max(1, options.columns ?? 8);
  const gap = options.gap ?? 1;
  const rows = Math.ceil(blockCount / columns);
  const cellWidth = SPRITE_WIDTH + gap;
  const cellHeight = SPRITE_HEIGHT + gap;
  const width = columns * cellWidth - gap;
  const height = rows * cellHeight - gap;
  const pixels = new Uint8Array(width * height * 4);

  const fg = paletteEntry(options.palette, options.fg ?? DEFAULT_FG);
  const bg = paletteEntry(options.palette, options.bg ?? DEFAULT_BG);
  const c1 = paletteEntry(options.palette, options.c1 ?? DEFAULT_C1);
  const c2 = paletteEntry(options.palette, options.c2 ?? DEFAULT_C2);
  fillBackground(pixels, bg);

  for (let block = 0; block < blockCount; block += 1) {
    const gridRow = Math.floor(block / columns);
    const gridCol = block % columns;
    const blockOffset = block * SPRITE_BYTES;
    const cellX = gridCol * cellWidth;
    const cellY = gridRow * cellHeight;
    for (let row = 0; row < SPRITE_HEIGHT; row += 1) {
      if (options.multicolor) {
        for (let columnByte = 0; columnByte < 3; columnByte += 1) {
          const byte = bytes[blockOffset + row * 3 + columnByte] ?? 0;
          for (let pair = 0; pair < 4; pair += 1) {
            const shift = (3 - pair) * 2;
            const code = (byte >> shift) & 0x03;
            const colour = code === 0 ? bg : code === 1 ? c1 : code === 2 ? fg : c2;
            const xLeft = cellX + columnByte * 8 + pair * 2;
            const y = cellY + row;
            setPixel(pixels, (y * width + xLeft) * 4, colour);
            setPixel(pixels, (y * width + xLeft + 1) * 4, colour);
          }
        }
      } else {
        for (let columnByte = 0; columnByte < 3; columnByte += 1) {
          const byte = bytes[blockOffset + row * 3 + columnByte] ?? 0;
          for (let bit = 0; bit < 8; bit += 1) {
            const x = cellX + columnByte * 8 + (7 - bit);
            const y = cellY + row;
            const offset = (y * width + x) * 4;
            const rgba = (byte & (1 << bit)) !== 0 ? fg : bg;
            setPixel(pixels, offset, rgba);
          }
        }
      }
    }
  }

  return { width, height, pixels };
}

export interface CharsetOptions extends PaletteOptions {
  multicolor?: boolean;
  columns?: number;
}

export function decodeCharset(bytes: Uint8Array, options: CharsetOptions = {}): DecodedImage {
  const GLYPH = 8;
  const cols = Math.max(1, options.columns ?? 32);
  const glyphCount = Math.max(1, Math.floor(bytes.length / GLYPH));
  const rows = Math.max(1, Math.ceil(glyphCount / cols));
  const width = cols * GLYPH;
  const height = rows * GLYPH;
  const pixels = new Uint8Array(width * height * 4);

  const fg = paletteEntry(options.palette, options.fg ?? DEFAULT_FG);
  const bg = paletteEntry(options.palette, options.bg ?? DEFAULT_BG);
  const c1 = paletteEntry(options.palette, options.c1 ?? DEFAULT_C1);
  const c2 = paletteEntry(options.palette, options.c2 ?? DEFAULT_C2);
  fillBackground(pixels, bg);

  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const gridRow = Math.floor(glyph / cols);
    const gridCol = glyph % cols;
    for (let row = 0; row < GLYPH; row += 1) {
      const byte = bytes[glyph * GLYPH + row] ?? 0;
      if (options.multicolor) {
        for (let pair = 0; pair < 4; pair += 1) {
          const shift = (3 - pair) * 2;
          const code = (byte >> shift) & 0x03;
          const colour = code === 0 ? bg : code === 1 ? c1 : code === 2 ? fg : c2;
          const xLeft = gridCol * GLYPH + pair * 2;
          const y = gridRow * GLYPH + row;
          setPixel(pixels, (y * width + xLeft) * 4, colour);
          setPixel(pixels, (y * width + xLeft + 1) * 4, colour);
        }
      } else {
        for (let bit = 0; bit < 8; bit += 1) {
          const x = gridCol * GLYPH + (7 - bit);
          const y = gridRow * GLYPH + row;
          const offset = (y * width + x) * 4;
          const rgba = (byte & (1 << bit)) !== 0 ? fg : bg;
          setPixel(pixels, offset, rgba);
        }
      }
    }
  }
  return { width, height, pixels };
}

export interface BitmapOptions extends PaletteOptions {
  multicolor?: boolean;
  screen?: Uint8Array;
  colorRam?: Uint8Array;
}

export function decodeBitmap(bytes: Uint8Array, options: BitmapOptions = {}): DecodedImage {
  const width = 320;
  const height = 200;
  const pixels = new Uint8Array(width * height * 4);
  const fg = paletteEntry(options.palette, options.fg ?? DEFAULT_FG);
  const bg = paletteEntry(options.palette, options.bg ?? DEFAULT_BG);

  if (options.multicolor) {
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
        const colours = [
          bg,
          paletteEntry(options.palette, topIdx),
          paletteEntry(options.palette, midIdx),
          paletteEntry(options.palette, lowIdx),
        ];
        for (let row = 0; row < 8; row += 1) {
          const byte = bytes[cellByteBase + row] ?? 0;
          for (let pair = 0; pair < 4; pair += 1) {
            const shift = (3 - pair) * 2;
            const code = (byte >> shift) & 0x03;
            const colour = colours[code]!;
            const xLeft = cellX * 8 + pair * 2;
            const y = cellY * 8 + row;
            setPixel(pixels, (y * width + xLeft) * 4, colour);
            setPixel(pixels, (y * width + xLeft + 1) * 4, colour);
          }
        }
      }
    }
    return { width, height, pixels };
  }

  for (let cellY = 0; cellY < 25; cellY += 1) {
    for (let cellX = 0; cellX < 40; cellX += 1) {
      const cellIndex = cellY * 40 + cellX;
      const cellByteBase = cellIndex * 8;
      let cellFg = fg;
      let cellBg = bg;
      if (options.screen && options.screen.length > cellIndex) {
        const screenByte = options.screen[cellIndex]!;
        cellFg = paletteEntry(options.palette, (screenByte >> 4) & 0x0f);
        cellBg = paletteEntry(options.palette, screenByte & 0x0f);
      }
      for (let row = 0; row < 8; row += 1) {
        const byte = bytes[cellByteBase + row] ?? 0;
        for (let bit = 0; bit < 8; bit += 1) {
          const x = cellX * 8 + (7 - bit);
          const y = cellY * 8 + row;
          const offset = (y * width + x) * 4;
          const rgba = (byte & (1 << bit)) !== 0 ? cellFg : cellBg;
          setPixel(pixels, offset, rgba);
        }
      }
    }
  }
  return { width, height, pixels };
}

export interface CharmapOptions extends PaletteOptions {
  columns?: number;
}

export function decodeCharmap(
  bytes: Uint8Array,
  charset: Uint8Array,
  options: CharmapOptions = {},
): DecodedImage {
  const GLYPH = 8;
  const columns = Math.max(1, options.columns ?? 40);
  const cellCount = bytes.length;
  const rows = Math.max(1, Math.ceil(cellCount / columns));
  const width = columns * GLYPH;
  const height = rows * GLYPH;
  const pixels = new Uint8Array(width * height * 4);
  const fg = paletteEntry(options.palette, options.fg ?? DEFAULT_FG);
  const bg = paletteEntry(options.palette, options.bg ?? DEFAULT_BG);
  fillBackground(pixels, bg);

  for (let cell = 0; cell < cellCount; cell += 1) {
    const code = bytes[cell]! & 0xff;
    const gridRow = Math.floor(cell / columns);
    const gridCol = cell % columns;
    const glyphBase = code * GLYPH;
    for (let row = 0; row < GLYPH; row += 1) {
      const byte = charset[glyphBase + row] ?? 0;
      for (let bit = 0; bit < 8; bit += 1) {
        const x = gridCol * GLYPH + (7 - bit);
        const y = gridRow * GLYPH + row;
        const offset = (y * width + x) * 4;
        const rgba = (byte & (1 << bit)) !== 0 ? fg : bg;
        setPixel(pixels, offset, rgba);
      }
    }
  }
  return { width, height, pixels };
}
