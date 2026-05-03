// VIC II framebuffer + renderer (Phase 65b: text mode).
//
// Per-frame snapshot rendering: walk the 40×25 character grid, fetch
// each char from screen RAM + bitmap from char ROM, paint into the
// 504×312 RGBA framebuffer at the standard inset (24, 51).
//
// Phase 65b scope:
// - Standard text mode (BMM=0, MCM=0, ECM=0)
// - Border + background color from $D020 / $D021
// - Per-char foreground color from color RAM ($D800-$DBFF)
// - 8x8 char bitmap from char ROM at $D000 (banked)
//
// Phase 65d adds: bitmap modes, multicolor, extended-bg-color.
// Phase 65c adds: cycle-exact raster counter + raster IRQ.

import type { HeadlessMemoryBus } from "../memory-bus.js";
import type { VicII } from "./vic-ii.js";

export const FB_WIDTH_PAL = 504;
export const FB_HEIGHT_PAL = 312;
export const FB_WIDTH_NTSC = 504;
export const FB_HEIGHT_NTSC = 263;

// Visible 320×200 area inset within border.
export const VISIBLE_X = 24;
export const VISIBLE_Y = 51;
export const VISIBLE_W = 320;
export const VISIBLE_H = 200;

// Standard Pepto VIC palette — 16 RGB triples.
// Source: https://www.pepto.de/projects/colorvic/ (CC-BY).
export const VIC_PALETTE: ReadonlyArray<[number, number, number]> = [
  [0x00, 0x00, 0x00], // 0  black
  [0xff, 0xff, 0xff], // 1  white
  [0x68, 0x37, 0x2b], // 2  red
  [0x70, 0xa4, 0xb2], // 3  cyan
  [0x6f, 0x3d, 0x86], // 4  purple
  [0x58, 0x8d, 0x43], // 5  green
  [0x35, 0x28, 0x79], // 6  blue
  [0xb8, 0xc7, 0x6f], // 7  yellow
  [0x6f, 0x4f, 0x25], // 8  orange
  [0x43, 0x39, 0x00], // 9  brown
  [0x9a, 0x67, 0x59], // 10 light red
  [0x44, 0x44, 0x44], // 11 dark grey
  [0x6c, 0x6c, 0x6c], // 12 grey
  [0x9a, 0xd2, 0x84], // 13 light green
  [0x6c, 0x5e, 0xb5], // 14 light blue
  [0x95, 0x95, 0x95], // 15 light grey
];

export class VicFramebuffer {
  public readonly width: number;
  public readonly height: number;
  public readonly pixels: Uint8Array; // RGBA, length = width*height*4

  constructor(isPal: boolean = true) {
    this.width = isPal ? FB_WIDTH_PAL : FB_WIDTH_NTSC;
    this.height = isPal ? FB_HEIGHT_PAL : FB_HEIGHT_NTSC;
    this.pixels = new Uint8Array(this.width * this.height * 4);
  }

  fill(colorIndex: number): void {
    const [r, g, b] = VIC_PALETTE[colorIndex & 0x0f]!;
    for (let i = 0; i < this.pixels.length; i += 4) {
      this.pixels[i] = r;
      this.pixels[i + 1] = g;
      this.pixels[i + 2] = b;
      this.pixels[i + 3] = 0xff;
    }
  }

  setPixel(x: number, y: number, colorIndex: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const off = (y * this.width + x) * 4;
    const [r, g, b] = VIC_PALETTE[colorIndex & 0x0f]!;
    this.pixels[off] = r;
    this.pixels[off + 1] = g;
    this.pixels[off + 2] = b;
    this.pixels[off + 3] = 0xff;
  }
}

export interface VicRenderContext {
  vic: VicII;
  bus: HeadlessMemoryBus;
  // VIC sees memory through a 16KB bank selected by CIA2 PA bits 0-1
  // (inverted: 0→bank3, 1→bank2, 2→bank1, 3→bank0). The bank base is
  // computed by the renderer per frame.
  vicBankBase: number;
}

// Read a byte from VIC's perspective. The VIC has special wiring:
// in banks 0 and 2, addresses $1000-$1FFF are mapped to char ROM
// instead of RAM. Outside those, normal RAM read.
function vicRead(ctx: VicRenderContext, vicAddr: number): number {
  const masked = vicAddr & 0x3fff;
  const bankBase = ctx.vicBankBase;
  const banksWithCharRom = (bankBase === 0x0000) || (bankBase === 0x8000);
  if (banksWithCharRom && masked >= 0x1000 && masked < 0x2000) {
    return ctx.bus.charRom[masked - 0x1000]!;
  }
  return ctx.bus.ram[(bankBase + masked) & 0xffff]!;
}

// Render one full frame to the framebuffer. Phase 65b: text mode only.
export function renderTextModeFrame(fb: VicFramebuffer, ctx: VicRenderContext): void {
  const { vic, bus } = ctx;
  const borderColor = vic.regs[0x20]! & 0x0f;
  const bgColor = vic.regs[0x21]! & 0x0f;
  // Fill entire framebuffer with border color, then overlay visible
  // area with bg + chars.
  fb.fill(borderColor);
  // Visible area background.
  for (let y = 0; y < VISIBLE_H; y++) {
    for (let x = 0; x < VISIBLE_W; x++) {
      fb.setPixel(VISIBLE_X + x, VISIBLE_Y + y, bgColor);
    }
  }
  // Screen RAM offset within VIC bank.
  const screenRamOff = vic.screenRamOffset();
  // Char ROM (or bitmap) base within VIC bank.
  const charRomOff = vic.charRomOffsetWithinBank();
  // Color RAM is always at $D800-$DBFF in CPU view.
  const colorRamBase = 0xd800;
  // Render 40×25 char grid.
  for (let row = 0; row < 25; row++) {
    for (let col = 0; col < 40; col++) {
      const cellIdx = row * 40 + col;
      const charCode = vicRead(ctx, screenRamOff + cellIdx);
      const fgColor = bus.ram[colorRamBase + cellIdx]! & 0x0f;
      // Each char is 8 bytes (one per row) in char ROM.
      const charBaseAddr = charRomOff + charCode * 8;
      for (let cy = 0; cy < 8; cy++) {
        const byte = vicRead(ctx, charBaseAddr + cy);
        for (let cx = 0; cx < 8; cx++) {
          const bit = (byte >> (7 - cx)) & 1;
          const px = VISIBLE_X + col * 8 + cx;
          const py = VISIBLE_Y + row * 8 + cy;
          if (bit) fb.setPixel(px, py, fgColor);
        }
      }
    }
  }
}

// Compute current VIC bank base from CIA2 PA bits 0-1.
// CIA2 PA bits 0-1 are output bits selecting the VIC bank (inverted):
//   00 = bank 3 ($C000-$FFFF)
//   01 = bank 2 ($8000-$BFFF)
//   10 = bank 1 ($4000-$7FFF)
//   11 = bank 0 ($0000-$3FFF) — default after reset
export function computeVicBankBase(cia2PaBits01: number): number {
  const bank = 3 - (cia2PaBits01 & 0x03);
  return bank * 0x4000;
}
