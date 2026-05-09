// Spec 295 — VIC-II 2-pass renderer (background + foreground split).
//
// Mirrors VICE vicii-draw.c structure: each mode has draw_*_background
// + draw_*_foreground functions. The background pass writes bg color
// to all pixels in the segment; the foreground pass overdraws fg
// pixels per glyph/bitmap. Existing single-pass mode emitters in
// vic-renderer-rasterized.ts already do this implicitly (fillSpan +
// mode dispatch overdraws) — this module exposes the EXPLICIT 2-pass
// API for trace introspection + Spec 290 raster-cache integration.
//
// Output guarantee: a bg pass + matching fg pass produces BYTE-
// IDENTICAL pixels to the corresponding single-pass mode emitter.
// Verified by smoke (scripts/smoke-2pass-renderer.mjs).

import type { VicFramebuffer } from "../peripherals/vic-renderer.js";
import type { HeadlessMemoryBus } from "../memory-bus.js";
import type { RasterState } from "./raster-state.js";

const VISIBLE_X = 32;
const VISIBLE_Y = 51;
const VISIBLE_W = 320;
const VISIBLE_H = 200;

function vicRead(bus: HeadlessMemoryBus, bankBase: number, addr: number): number {
  const masked = addr & 0x3fff;
  const charBank = (bankBase === 0x0000) || (bankBase === 0x8000);
  if (charBank && masked >= 0x1000 && masked < 0x2000) {
    return bus.charRom[masked - 0x1000]!;
  }
  return bus.ram[(bankBase + masked) & 0xffff]!;
}

// ---------- Generic background pass: solid fill across segment ----------
export function drawBackgroundSeg(
  fb: VicFramebuffer, line: number, x0: number, x1: number, color: number,
): void {
  if (line < 0 || line >= fb.height) return;
  const cx0 = Math.max(0, x0);
  const cx1 = Math.min(fb.width - 1, x1);
  for (let x = cx0; x <= cx1; x++) fb.setPixel(x, line, color);
}

// ---------- Mode 0: standard text foreground pass ----------
export function drawStdTextForeground(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number, fgMask: Uint8Array,
): void {
  const yIn = line - VISIBLE_Y;
  if (yIn < 0 || yIn >= VISIBLE_H) return;
  const charRow = (yIn >> 3) | 0;
  const charY = yIn & 7;
  const colorRamBase = 0x0800;
  for (let x = x0; x <= x1; x++) {
    const xIn = x - VISIBLE_X;
    if (xIn < 0 || xIn >= VISIBLE_W) continue;
    const col = (xIn >> 3) | 0;
    const cellIdx = charRow * 40 + col;
    const charCode = vicRead(bus, state.vic_bank_base, state.screen_base_ptr + cellIdx);
    const fg = bus.io[colorRamBase + cellIdx]! & 0x0f;
    const charByte = vicRead(bus, state.vic_bank_base,
      state.chargen_base_ptr + charCode * 8 + charY);
    const bit = (charByte >> (7 - (xIn & 7))) & 1;
    if (bit) {
      fb.setPixel(x, line, fg);
      fgMask[yIn * VISIBLE_W + xIn] = 1;
    }
    // bit==0: leave bg as-is (= drawn by background pass)
  }
}

// ---------- Mode 1: multicolor text foreground pass ----------
export function drawMcTextForeground(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number, fgMask: Uint8Array,
): void {
  const yIn = line - VISIBLE_Y;
  if (yIn < 0 || yIn >= VISIBLE_H) return;
  const charRow = (yIn >> 3) | 0;
  const charY = yIn & 7;
  const colorRamBase = 0x0800;
  for (let x = x0; x <= x1; x++) {
    const xIn = x - VISIBLE_X;
    if (xIn < 0 || xIn >= VISIBLE_W) continue;
    const col = (xIn >> 3) | 0;
    const cellIdx = charRow * 40 + col;
    const charCode = vicRead(bus, state.vic_bank_base, state.screen_base_ptr + cellIdx);
    const colorRam = bus.io[colorRamBase + cellIdx]! & 0x0f;
    const charByte = vicRead(bus, state.vic_bank_base,
      state.chargen_base_ptr + charCode * 8 + charY);
    if ((colorRam & 0x8) === 0) {
      // hi-res mode for this cell: bit=fg lo nibble of CRAM
      const bit = (charByte >> (7 - (xIn & 7))) & 1;
      if (bit) {
        fb.setPixel(x, line, colorRam & 0x07);
        fgMask[yIn * VISIBLE_W + xIn] = 1;
      }
    } else {
      // multicolor: 2-bit pairs
      const pairBit = 6 - ((xIn & 7) & 0x06);
      const pair = (charByte >> pairBit) & 0x03;
      if (pair !== 0) {
        let c: number;
        if (pair === 1) c = state.background_color_1;
        else if (pair === 2) c = state.background_color_2;
        else c = colorRam & 0x07;
        fb.setPixel(x, line, c);
        if (pair === 3) fgMask[yIn * VISIBLE_W + xIn] = 1;
      }
    }
  }
}

// ---------- Mode 2: standard bitmap foreground pass ----------
export function drawStdBitmapForeground(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number, fgMask: Uint8Array,
): void {
  const yIn = line - VISIBLE_Y;
  if (yIn < 0 || yIn >= VISIBLE_H) return;
  const charRow = (yIn >> 3) | 0;
  const charY = yIn & 7;
  for (let x = x0; x <= x1; x++) {
    const xIn = x - VISIBLE_X;
    if (xIn < 0 || xIn >= VISIBLE_W) continue;
    const col = (xIn >> 3) | 0;
    const cellIdx = charRow * 40 + col;
    const screen = vicRead(bus, state.vic_bank_base, state.screen_base_ptr + cellIdx);
    const bmByte = vicRead(bus, state.vic_bank_base,
      state.bitmap_base_ptr + cellIdx * 8 + charY);
    const bit = (bmByte >> (7 - (xIn & 7))) & 1;
    if (bit) {
      fb.setPixel(x, line, (screen >> 4) & 0x0f);
      fgMask[yIn * VISIBLE_W + xIn] = 1;
    } else {
      fb.setPixel(x, line, screen & 0x0f);
    }
  }
}

// ---------- Mode 3: multicolor bitmap foreground pass ----------
export function drawMcBitmapForeground(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number, fgMask: Uint8Array,
): void {
  const yIn = line - VISIBLE_Y;
  if (yIn < 0 || yIn >= VISIBLE_H) return;
  const charRow = (yIn >> 3) | 0;
  const charY = yIn & 7;
  const colorRamBase = 0x0800;
  for (let x = x0; x <= x1; x++) {
    const xIn = x - VISIBLE_X;
    if (xIn < 0 || xIn >= VISIBLE_W) continue;
    const col = (xIn >> 3) | 0;
    const cellIdx = charRow * 40 + col;
    const screen = vicRead(bus, state.vic_bank_base, state.screen_base_ptr + cellIdx);
    const colorRam = bus.io[colorRamBase + cellIdx]! & 0x0f;
    const bmByte = vicRead(bus, state.vic_bank_base,
      state.bitmap_base_ptr + cellIdx * 8 + charY);
    const pairBit = 6 - ((xIn & 7) & 0x06);
    const pair = (bmByte >> pairBit) & 0x03;
    let c: number;
    if (pair === 0) c = state.background_color;
    else if (pair === 1) c = (screen >> 4) & 0x0f;
    else if (pair === 2) c = screen & 0x0f;
    else c = colorRam;
    fb.setPixel(x, line, c);
    if (pair === 3) fgMask[yIn * VISIBLE_W + xIn] = 1;
  }
}

// ---------- Mode 4: extended-bg text foreground pass ----------
export function drawExtTextForeground(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number, fgMask: Uint8Array,
): void {
  const yIn = line - VISIBLE_Y;
  if (yIn < 0 || yIn >= VISIBLE_H) return;
  const charRow = (yIn >> 3) | 0;
  const charY = yIn & 7;
  const colorRamBase = 0x0800;
  for (let x = x0; x <= x1; x++) {
    const xIn = x - VISIBLE_X;
    if (xIn < 0 || xIn >= VISIBLE_W) continue;
    const col = (xIn >> 3) | 0;
    const cellIdx = charRow * 40 + col;
    const screen = vicRead(bus, state.vic_bank_base, state.screen_base_ptr + cellIdx);
    const fg = bus.io[colorRamBase + cellIdx]! & 0x0f;
    // High 2 bits select bg color from $D021/$D022/$D023/$D024.
    const bgIdx = (screen >> 6) & 3;
    let bg: number;
    if (bgIdx === 0) bg = state.background_color;
    else if (bgIdx === 1) bg = state.background_color_1;
    else if (bgIdx === 2) bg = state.background_color_2;
    else bg = state.background_color_3;
    const charCode = screen & 0x3f;
    const charByte = vicRead(bus, state.vic_bank_base,
      state.chargen_base_ptr + charCode * 8 + charY);
    const bit = (charByte >> (7 - (xIn & 7))) & 1;
    if (bit) {
      fb.setPixel(x, line, fg);
      fgMask[yIn * VISIBLE_W + xIn] = 1;
    } else {
      fb.setPixel(x, line, bg);
    }
  }
}
