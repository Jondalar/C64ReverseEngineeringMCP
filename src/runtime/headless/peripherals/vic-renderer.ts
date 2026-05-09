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

/**
 * Structural VIC interface shared by both peripherals/vic-ii.ts (legacy)
 * and vic/vic-ii-vice.ts (new). Renderer only touches the fields listed
 * here — neither core is imported directly so both satisfy this type.
 */
export interface VicLike {
  regs: Uint8Array;
  scanlineSnapshots: { rasterLine: number; d020: number; d011?: number; d016?: number; d018?: number; d021?: number; d022?: number; d023?: number }[];
  screenRamOffset(): number;
  charRomOffsetWithinBank(): number;
  bitmapBaseWithinBank(): number;
}

export const FB_WIDTH_PAL = 504;
export const FB_HEIGHT_PAL = 312;
export const FB_WIDTH_NTSC = 504;
export const FB_HEIGHT_NTSC = 263;

// Visible 320×200 area inset within border.
// Spec 281: aligned with VICE 40-col display window. Display starts
// at pixel 32 (= screen_leftborderwidth). Was 24 (legacy = bug:
// char col 0 was rendered into border zone and overwritten,
// effectively losing R/L/etc at column 0 of every text row).
export const VISIBLE_X = 32;
export const VISIBLE_Y = 51;
export const VISIBLE_W = 320;
export const VISIBLE_H = 200;

// Spec 282: palette suite. VIC_PALETTE re-exported from palettes.ts
// as the active default (= colodore per OQ1=(b)). Per-session
// override via VicFramebuffer.setPalette().
import { PALETTES, DEFAULT_PALETTE_KEY, type Palette16, type PaletteKey } from "../vic/palettes.js";
export const VIC_PALETTE: Palette16 = PALETTES[DEFAULT_PALETTE_KEY];
export type { Palette16, PaletteKey } from "../vic/palettes.js";
export { PALETTES, DEFAULT_PALETTE_KEY, getPalette, listPalettes } from "../vic/palettes.js";

export class VicFramebuffer {
  public readonly width: number;
  public readonly height: number;
  public readonly pixels: Uint8Array; // RGBA, length = width*height*4
  // Spec 282: per-instance palette (replaces previously hardcoded
  // global VIC_PALETTE). Defaults to colodore but set per-session.
  public palette: Palette16 = VIC_PALETTE;
  // Spec 288: track the configured palette key so renderer can swap
  // to even/odd variants per line for chips with split tables.
  public paletteKey: PaletteKey = "colodore";

  constructor(isPal: boolean = true) {
    this.width = isPal ? FB_WIDTH_PAL : FB_WIDTH_NTSC;
    this.height = isPal ? FB_HEIGHT_PAL : FB_HEIGHT_NTSC;
    this.pixels = new Uint8Array(this.width * this.height * 4);
  }

  setPalette(p: Palette16 | PaletteKey | null | undefined): void {
    if (!p) return;
    if (typeof p === "string") {
      this.palette = PALETTES[p] ?? VIC_PALETTE;
      this.paletteKey = p;
    } else {
      this.palette = p;
      // p is a Palette16; keep paletteKey as-is (= manual override)
    }
  }

  fill(colorIndex: number): void {
    const [r, g, b] = this.palette[colorIndex & 0x0f]!;
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
    const [r, g, b] = this.palette[colorIndex & 0x0f]!;
    this.pixels[off] = r;
    this.pixels[off + 1] = g;
    this.pixels[off + 2] = b;
    this.pixels[off + 3] = 0xff;
  }
}

export interface VicRenderContext {
  vic: VicLike;
  bus: HeadlessMemoryBus;
  // VIC sees memory through a 16KB bank selected by CIA2 PA bits 0-1
  // (inverted: 0→bank3, 1→bank2, 2→bank1, 3→bank0). The bank base is
  // re-derived per scanline from frameLineLogs (V3.1 fix). The
  // initial value here is the FRAME-ENTRY bank; per-line overrides
  // are computed inside renderFrame.
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

// Render one full frame to the framebuffer.
//
// Spec 105 (M2.3) v1: per-char-row dispatch. Each char row (8 px tall)
// looks up the VIC scanline snapshot that was active at its top
// raster line and dispatches to the appropriate mode renderer with
// the snap's d011/d016/d018. This makes raster-IRQ split-screen
// effects (MM, FLD, mode changes per char-row band) render correctly
// without per-pixel cost. Sub-char-row mode changes (FLI, mid-cell
// d016 toggles) still fall back to the snap at row top — v2 work.
export function renderFrame(fb: VicFramebuffer, ctx: VicRenderContext): void {
  const { vic } = ctx;
  fillBorderPerScanline(fb, vic);
  // V3.1 fix: build per-line CIA2 PA bank table so each char row
  // can render against the bank active at its top-raster. Without
  // this, raster-IRQ bank-switch split-screens (motm ingame) all
  // render against the frame-entry bank.
  const initialCia2Pa = (ctx.vicBankBase >> 14) & 0x03;
  // Reverse computeVicBankBase: bank = 3 - (cia2Pa & 0x03), so
  // cia2Pa = 3 - (bankBase>>14). But initial frame bank may not be
  // recoverable that way. Use vic.frameLineLogs to extract per-line
  // bank changes; initial seed comes from ctx.vicBankBase directly.
  const cia2PaPerLine = buildLineCia2PaForRenderer(vic, initialCia2Pa);
  const initialBank = ctx.vicBankBase;
  // Track which pixels are "foreground" (=non-bg) for sprite-bg
  // collision detection. 320x200 boolean grid.
  const fgMask = new Uint8Array(VISIBLE_W * VISIBLE_H);
  // For each char row, pick snapshot active at its top raster line.
  for (let row = 0; row < 25; row++) {
    const topRaster = VISIBLE_Y + row * 8;
    // Per-row bank lookup (V3.1).
    const rowBankBase = computeVicBankBase(cia2PaPerLine[topRaster] ?? initialCia2Pa);
    ctx.vicBankBase = rowBankBase;
    const snap = snapAtLine(vic.scanlineSnapshots, topRaster);
    const ctrl1 = snap?.d011 ?? vic.regs[0x11]!;
    const ctrl2 = snap?.d016 ?? vic.regs[0x16]!;
    const memPtr = snap?.d018 ?? vic.regs[0x18]!;
    const bgColor = (snap?.d021 ?? vic.regs[0x21]!) & 0x0f;
    const mc1 = (snap?.d022 ?? vic.regs[0x22]!) & 0x0f;
    const mc2 = (snap?.d023 ?? vic.regs[0x23]!) & 0x0f;
    const denBit = (ctrl1 & 0x10) !== 0;
    const ecmBit = (ctrl1 & 0x40) !== 0;
    const bmmBit = (ctrl1 & 0x20) !== 0;
    const mcmBit = (ctrl2 & 0x10) !== 0;
    if (!denBit) {
      // DEN off for this row → paint border colour over visible band.
      const borderColor = (snap?.d020 ?? vic.regs[0x20]!) & 0x0f;
      paintVisibleRow(fb, row, borderColor);
      continue;
    }
    if (ecmBit && (bmmBit || mcmBit)) {
      paintVisibleRow(fb, row, 0);
      continue;
    }
    // Per-snap context so vicRead picks up the right base addrs.
    // Note: d018 lives in vic.regs which screenRamOffset/charRomOff/
    // bitmapBase read off. We temporarily swap in the snap's d018,
    // call the mode renderer for one row, swap back. Saves a big
    // re-plumb and keeps existing per-mode logic intact.
    const savedD018 = vic.regs[0x18]!;
    const savedD021 = vic.regs[0x21]!;
    const savedD022 = vic.regs[0x22]!;
    const savedD023 = vic.regs[0x23]!;
    vic.regs[0x18] = memPtr;
    vic.regs[0x21] = bgColor;
    vic.regs[0x22] = mc1;
    vic.regs[0x23] = mc2;
    const args = { fb, ctx, fgMask };
    if (bmmBit && mcmBit) renderMulticolorBitmapRow(args, row);
    else if (bmmBit) renderStandardBitmapRow(args, row);
    else if (ecmBit) renderExtendedBgTextRow(args, row);
    else if (mcmBit) renderMulticolorTextRow(args, row);
    else renderStandardTextRow(args, row);
    vic.regs[0x18] = savedD018;
    vic.regs[0x21] = savedD021;
    vic.regs[0x22] = savedD022;
    vic.regs[0x23] = savedD023;
  }
  // Restore frame-entry bank so sprite renderer + outside callers
  // see consistent state.
  ctx.vicBankBase = initialBank;
  renderSprites(fb, ctx, fgMask);
}

// V3.1 helper — derive per-line CIA2 PA byte from frameLineLogs.
// Mirrors logic in vic-renderer-pixel.ts buildLineCia2Pa but
// returns just the PA byte (not the bank-base) so renderer can
// apply computeVicBankBase as needed.
function buildLineCia2PaForRenderer(vic: VicLike, initialPa: number): number[] {
  const out: number[] = new Array(312).fill(initialPa & 0xff);
  let cur = initialPa & 0xff;
  // frameLineLogs is optional (Spec 262 Phase A). If absent, all
  // lines use initialPa.
  const logs = (vic as any).frameLineLogs;
  if (!Array.isArray(logs)) return out;
  // Bank-change entries are recorded with reg=0x80 (VICII_LOG_CIA2_PA).
  for (const lineEntry of logs) {
    const writes = (lineEntry as any).writes;
    if (!Array.isArray(writes)) continue;
    for (const w of writes) {
      if (w.reg === 0x80) cur = w.value & 0x03;
    }
    if (typeof lineEntry.rasterLine === "number" && lineEntry.rasterLine < out.length) {
      out[lineEntry.rasterLine] = cur;
    }
  }
  // Forward-fill: lines without explicit entry inherit from previous.
  let last = initialPa & 0xff;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== initialPa) last = out[i]!;
    else out[i] = last;
  }
  return out;
}

function snapAtLine(snaps: { rasterLine: number }[], line: number): { d011: number; d016: number; d018: number; d020: number; d021: number; d022: number; d023: number } | undefined {
  if (snaps.length === 0) return undefined;
  let pick: typeof snaps[number] | undefined;
  for (const s of snaps) {
    if (s.rasterLine <= line) pick = s; else break;
  }
  return pick as never;
}

function paintVisibleRow(fb: VicFramebuffer, row: number, color: number): void {
  for (let cy = 0; cy < 8; cy++) {
    const py = VISIBLE_Y + row * 8 + cy;
    for (let x = 0; x < VISIBLE_W; x++) fb.setPixel(VISIBLE_X + x, py, color);
  }
}

// Backwards compat alias.
export const renderTextModeFrame = renderFrame;

// Sprint 86: per-scanline border. Iterate the framebuffer top-down,
// look up the snapshot whose rasterLine covers this output Y. Output
// Y maps to PAL raster line via fb origin (line 0 of fb = raster 0).
function fillBorderPerScanline(fb: VicFramebuffer, vic: VicLike): void {
  const fallback = vic.regs[0x20]! & 0x0f;
  if (vic.scanlineSnapshots.length === 0) {
    fb.fill(fallback);
    return;
  }
  // Build per-line color map (index = raster line, value = border color).
  const lineColor = new Uint8Array(fb.height);
  let cur = fallback;
  let snapIdx = 0;
  for (let y = 0; y < fb.height; y++) {
    while (snapIdx < vic.scanlineSnapshots.length && vic.scanlineSnapshots[snapIdx]!.rasterLine <= y) {
      cur = vic.scanlineSnapshots[snapIdx]!.d020 & 0x0f;
      snapIdx++;
    }
    lineColor[y] = cur;
  }
  for (let y = 0; y < fb.height; y++) {
    const c = lineColor[y]!;
    for (let x = 0; x < fb.width; x++) fb.setPixel(x, y, c);
  }
}

function paintVisibleArea(fb: VicFramebuffer, colorIdx: number): void {
  for (let y = 0; y < VISIBLE_H; y++) {
    for (let x = 0; x < VISIBLE_W; x++) {
      fb.setPixel(VISIBLE_X + x, VISIBLE_Y + y, colorIdx);
    }
  }
}

interface RenderArgs {
  fb: VicFramebuffer;
  ctx: VicRenderContext;
  fgMask: Uint8Array;
}

function setFg(args: RenderArgs, x: number, y: number, color: number): void {
  args.fb.setPixel(x, y, color);
  const lx = x - VISIBLE_X, ly = y - VISIBLE_Y;
  if (lx >= 0 && lx < VISIBLE_W && ly >= 0 && ly < VISIBLE_H) {
    args.fgMask[ly * VISIBLE_W + lx] = 1;
  }
}

function renderStandardText(args: RenderArgs): void {
  for (let row = 0; row < 25; row++) renderStandardTextRow(args, row);
}

function renderStandardTextRow(args: RenderArgs, row: number): void {
  const { fb, ctx } = args;
  const { vic, bus } = ctx;
  const bgColor = vic.regs[0x21]! & 0x0f;
  paintVisibleRow(fb, row, bgColor);
  const screenRamOff = vic.screenRamOffset();
  const charRomOff = vic.charRomOffsetWithinBank();
  const colorRamBase = 0x0800; // index into bus.io[] (I/O bank); $D800-$DBFF
  for (let col = 0; col < 40; col++) {
    const cellIdx = row * 40 + col;
    const charCode = vicRead(ctx, screenRamOff + cellIdx);
    const fgColor = bus.io[colorRamBase + cellIdx]! & 0x0f;
    const charBaseAddr = charRomOff + charCode * 8;
    for (let cy = 0; cy < 8; cy++) {
      const byte = vicRead(ctx, charBaseAddr + cy);
      for (let cx = 0; cx < 8; cx++) {
        const bit = (byte >> (7 - cx)) & 1;
        const px = VISIBLE_X + col * 8 + cx;
        const py = VISIBLE_Y + row * 8 + cy;
        if (bit) setFg(args, px, py, fgColor);
      }
    }
  }
}

// Multicolor text mode: each char's color RAM bit 3 selects mode.
// If color RAM bit 3 == 0, char renders as standard (fg = lower 3 bits).
// If color RAM bit 3 == 1, char is multicolor: each pair of bits
// renders as a 2-pixel wide block: 00=$D021, 01=$D022, 10=$D023, 11=color RAM lower 3 bits.
function renderMulticolorText(args: RenderArgs): void {
  for (let row = 0; row < 25; row++) renderMulticolorTextRow(args, row);
}

function renderMulticolorTextRow(args: RenderArgs, row: number): void {
  const { fb, ctx } = args;
  const { vic, bus } = ctx;
  const bgColor = vic.regs[0x21]! & 0x0f;
  const mc1 = vic.regs[0x22]! & 0x0f;
  const mc2 = vic.regs[0x23]! & 0x0f;
  paintVisibleRow(fb, row, bgColor);
  const screenRamOff = vic.screenRamOffset();
  const charRomOff = vic.charRomOffsetWithinBank();
  const colorRamBase = 0x0800; // index into bus.io[] (I/O bank); $D800-$DBFF
  {
    for (let col = 0; col < 40; col++) {
      const cellIdx = row * 40 + col;
      const charCode = vicRead(ctx, screenRamOff + cellIdx);
      const cramByte = bus.io[colorRamBase + cellIdx]!;
      const isMc = (cramByte & 0x08) !== 0;
      const fgColor = cramByte & 0x07;
      const charBaseAddr = charRomOff + charCode * 8;
      for (let cy = 0; cy < 8; cy++) {
        const byte = vicRead(ctx, charBaseAddr + cy);
        if (!isMc) {
          // Standard rendering for this char.
          for (let cx = 0; cx < 8; cx++) {
            const bit = (byte >> (7 - cx)) & 1;
            if (bit) setFg(args, VISIBLE_X + col * 8 + cx, VISIBLE_Y + row * 8 + cy, fgColor);
          }
        } else {
          for (let pair = 0; pair < 4; pair++) {
            const bits = (byte >> ((3 - pair) * 2)) & 0x03;
            let color: number;
            let isFg = false;
            if (bits === 0) color = bgColor;
            else if (bits === 1) { color = mc1; }
            else if (bits === 2) { color = mc2; isFg = true; }
            else { color = fgColor; isFg = true; }
            const baseX = VISIBLE_X + col * 8 + pair * 2;
            const py = VISIBLE_Y + row * 8 + cy;
            if (isFg) { setFg(args, baseX, py, color); setFg(args, baseX + 1, py, color); }
            else { fb.setPixel(baseX, py, color); fb.setPixel(baseX + 1, py, color); }
          }
        }
      }
    }
  }
}

// Extended-bg-color text: char code bits 0-5 = char index, bits 6-7
// select bg color from $D021-$D024.
function renderExtendedBgText(args: RenderArgs): void {
  for (let row = 0; row < 25; row++) renderExtendedBgTextRow(args, row);
}

function renderExtendedBgTextRow(args: RenderArgs, row: number): void {
  const { fb, ctx } = args;
  const { vic, bus } = ctx;
  const bgColors = [
    vic.regs[0x21]! & 0x0f,
    vic.regs[0x22]! & 0x0f,
    vic.regs[0x23]! & 0x0f,
    vic.regs[0x24]! & 0x0f,
  ];
  paintVisibleRow(fb, row, bgColors[0]!);
  const screenRamOff = vic.screenRamOffset();
  const charRomOff = vic.charRomOffsetWithinBank();
  const colorRamBase = 0x0800; // index into bus.io[] (I/O bank); $D800-$DBFF
  for (let col = 0; col < 40; col++) {
    const cellIdx = row * 40 + col;
    const screenByte = vicRead(ctx, screenRamOff + cellIdx);
    const charCode = screenByte & 0x3f;
    const bgIdx = (screenByte >> 6) & 0x03;
    const cellBg = bgColors[bgIdx]!;
    const fgColor = bus.io[colorRamBase + cellIdx]! & 0x0f;
    const charBaseAddr = charRomOff + charCode * 8;
    for (let cy = 0; cy < 8; cy++) {
      const byte = vicRead(ctx, charBaseAddr + cy);
      for (let cx = 0; cx < 8; cx++) {
        const bit = (byte >> (7 - cx)) & 1;
        const px = VISIBLE_X + col * 8 + cx;
        const py = VISIBLE_Y + row * 8 + cy;
        if (bit) setFg(args, px, py, fgColor);
        else fb.setPixel(px, py, cellBg);
      }
    }
  }
}

// Standard bitmap: 8000-byte bitmap from VIC bitmap base. Foreground
// + background colors come from the screen RAM byte (high nibble = fg,
// low nibble = bg) for each 8x8 cell. 320x200 visible area.
function renderStandardBitmap(args: RenderArgs): void {
  for (let row = 0; row < 25; row++) renderStandardBitmapRow(args, row);
}

function renderStandardBitmapRow(args: RenderArgs, row: number): void {
  const { fb, ctx } = args;
  const { vic } = ctx;
  paintVisibleRow(fb, row, 0);
  const screenRamOff = vic.screenRamOffset();
  const bitmapOff = vic.bitmapBaseWithinBank();
  for (let col = 0; col < 40; col++) {
    const cellIdx = row * 40 + col;
    const screenByte = vicRead(ctx, screenRamOff + cellIdx);
    const fgColor = (screenByte >> 4) & 0x0f;
    const bgColor = screenByte & 0x0f;
    const cellBitmapBase = bitmapOff + (row * 40 + col) * 8;
    for (let cy = 0; cy < 8; cy++) {
      const byte = vicRead(ctx, cellBitmapBase + cy);
      for (let cx = 0; cx < 8; cx++) {
        const bit = (byte >> (7 - cx)) & 1;
        const px = VISIBLE_X + col * 8 + cx;
        const py = VISIBLE_Y + row * 8 + cy;
        if (bit) setFg(args, px, py, fgColor);
        else fb.setPixel(px, py, bgColor);
      }
    }
  }
}

// Multicolor bitmap: 160×200 visible (each pixel painted 2px wide).
// 4 colors per 8x8 cell:
//   00 = $D021 bg
//   01 = screen RAM byte high nibble
//   10 = screen RAM byte low nibble
//   11 = color RAM lower nibble
function renderMulticolorBitmap(args: RenderArgs): void {
  for (let row = 0; row < 25; row++) renderMulticolorBitmapRow(args, row);
}

function renderMulticolorBitmapRow(args: RenderArgs, row: number): void {
  const { fb, ctx } = args;
  const { vic, bus } = ctx;
  const bgColor = vic.regs[0x21]! & 0x0f;
  paintVisibleRow(fb, row, bgColor);
  const screenRamOff = vic.screenRamOffset();
  const bitmapOff = vic.bitmapBaseWithinBank();
  const colorRamBase = 0x0800; // index into bus.io[] (I/O bank); $D800-$DBFF
  for (let col = 0; col < 40; col++) {
    const cellIdx = row * 40 + col;
    const screenByte = vicRead(ctx, screenRamOff + cellIdx);
    const colorByte = bus.io[colorRamBase + cellIdx]!;
    const c01 = (screenByte >> 4) & 0x0f;
    const c10 = screenByte & 0x0f;
    const c11 = colorByte & 0x0f;
    const cellBitmapBase = bitmapOff + (row * 40 + col) * 8;
    for (let cy = 0; cy < 8; cy++) {
      const byte = vicRead(ctx, cellBitmapBase + cy);
      for (let pair = 0; pair < 4; pair++) {
        const bits = (byte >> ((3 - pair) * 2)) & 0x03;
        let color: number;
        let isFg = false;
        if (bits === 0) color = bgColor;
        else if (bits === 1) { color = c01; }
        else if (bits === 2) { color = c10; isFg = true; }
        else { color = c11; isFg = true; }
        const baseX = VISIBLE_X + col * 8 + pair * 2;
        const py = VISIBLE_Y + row * 8 + cy;
        if (isFg) { setFg(args, baseX, py, color); setFg(args, baseX + 1, py, color); }
        else { fb.setPixel(baseX, py, color); fb.setPixel(baseX + 1, py, color); }
      }
    }
  }
}

// Sprint 74 (Phase 65e): render up to 8 hardware sprites overlay.
// 24×21 px each, optional X/Y expand (×2), priority (over/under chars
// via $D01B), multicolor (per-sprite via $D01C). Sprite-bg + sprite-
// sprite collision flags set in $D01E/$D01F.
function renderSprites(fb: VicFramebuffer, ctx: VicRenderContext, fgMask: Uint8Array): void {
  const { vic } = ctx;
  const enableMask = vic.regs[0x15]!;
  if (enableMask === 0) return;
  const xMsb = vic.regs[0x10]!;
  const xExpand = vic.regs[0x1d]!;
  const yExpand = vic.regs[0x17]!;
  const priority = vic.regs[0x1b]!;
  const mcMask = vic.regs[0x1c]!;
  const mc1 = vic.regs[0x25]! & 0x0f;
  const mc2 = vic.regs[0x26]! & 0x0f;
  // Sprite data pointer table: last 8 bytes of screen RAM.
  const screenRamOff = vic.screenRamOffset();
  // Per-sprite occupancy mask for sprite-sprite collision.
  const spriteMask = new Uint8Array(VISIBLE_W * VISIBLE_H * 8);
  let collSpSp = 0;
  let collSpBg = 0;
  for (let sp = 0; sp < 8; sp++) {
    if ((enableMask & (1 << sp)) === 0) continue;
    const xLo = vic.regs[sp * 2]!;
    const yPos = vic.regs[sp * 2 + 1]!;
    const x = xLo | (((xMsb >> sp) & 1) ? 0x100 : 0);
    const y = yPos;
    const expandX = (xExpand & (1 << sp)) !== 0;
    const expandY = (yExpand & (1 << sp)) !== 0;
    const isMc = (mcMask & (1 << sp)) !== 0;
    const isPriorityBehind = (priority & (1 << sp)) !== 0; // sprite BEHIND chars
    const color = vic.regs[0x27 + sp]! & 0x0f;
    // Sprite data pointer: byte at screen RAM offset + 1016 + sp.
    const ptrByte = vicRead(ctx, screenRamOff + 0x3f8 + sp);
    const dataBase = ptrByte * 64;
    // 21 lines × 3 bytes = 63 bytes per sprite.
    for (let row = 0; row < 21; row++) {
      const srcRow = expandY ? Math.floor(row / 1) : row; // expand Y handled by drawing twice
      const linesToDraw = expandY ? 2 : 1;
      for (let lineRep = 0; lineRep < linesToDraw; lineRep++) {
        for (let byteIdx = 0; byteIdx < 3; byteIdx++) {
          const byte = vicRead(ctx, dataBase + srcRow * 3 + byteIdx);
          if (!isMc) {
            for (let bit = 0; bit < 8; bit++) {
              if ((byte >> (7 - bit)) & 1) {
                const widthRep = expandX ? 2 : 1;
                for (let wr = 0; wr < widthRep; wr++) {
                  const px = x + (byteIdx * 8 + bit) * widthRep + wr - 24;
                  // VIC sprite coords are screen-relative; (24,50)
                  // is top-left of visible area in sprite coords.
                  const py = y + row * (expandY ? 2 : 1) + lineRep - 50;
                  drawSpritePixel(fb, fgMask, spriteMask, px, py, color, sp, isPriorityBehind, () => { collSpSp |= (1 << sp); }, () => { collSpBg |= (1 << sp); });
                }
              }
            }
          } else {
            // Multicolor: 4 pairs of 2-bit blocks per byte; each block
            // = 4 pixels wide (2 if not expanded).
            for (let pair = 0; pair < 4; pair++) {
              const bits = (byte >> ((3 - pair) * 2)) & 0x03;
              if (bits === 0) continue;
              let pxColor: number;
              if (bits === 1) pxColor = mc1;
              else if (bits === 2) pxColor = color;
              else pxColor = mc2;
              const blockW = expandX ? 4 : 2;
              for (let wr = 0; wr < blockW; wr++) {
                const px = x + (byteIdx * 8 + pair * 2) * (expandX ? 1 : 1) + wr - 24;
                const py = y + row * (expandY ? 2 : 1) + lineRep - 50;
                drawSpritePixel(fb, fgMask, spriteMask, px, py, pxColor, sp, isPriorityBehind, () => { collSpSp |= (1 << sp); }, () => { collSpBg |= (1 << sp); });
              }
            }
          }
        }
      }
    }
  }
  // Update collision registers.
  vic.regs[0x1e] = (vic.regs[0x1e]! | collSpSp) & 0xff;
  vic.regs[0x1f] = (vic.regs[0x1f]! | collSpBg) & 0xff;
}

function drawSpritePixel(
  fb: VicFramebuffer, fgMask: Uint8Array, spriteMask: Uint8Array,
  px: number, py: number, color: number, spriteIdx: number, behindChars: boolean,
  onSpSpColl: () => void, onSpBgColl: () => void,
): void {
  if (px < 0 || px >= VISIBLE_W || py < 0 || py >= VISIBLE_H) return;
  // sprite-bg collision: any sprite pixel coincident with a fg pixel.
  if (fgMask[py * VISIBLE_W + px]) onSpBgColl();
  // sprite-sprite collision: any prior sprite pixel at same coord.
  const maskOff = (py * VISIBLE_W + px) * 8;
  let any = false;
  for (let s = 0; s < 8; s++) {
    if (s !== spriteIdx && spriteMask[maskOff + s]) { any = true; break; }
  }
  if (any) onSpSpColl();
  spriteMask[maskOff + spriteIdx] = 1;
  // If behind chars and this pixel is fg, sprite gets hidden behind.
  if (behindChars && fgMask[py * VISIBLE_W + px]) return;
  fb.setPixel(VISIBLE_X + px, VISIBLE_Y + py, color);
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
