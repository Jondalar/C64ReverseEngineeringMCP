// Spec 280c — VICE-faithful per-line VIC renderer.
//
// Mirrors vice/src/raster/raster-line.c handle_visible_line_with_changes:
// for each visible scanline, walk the per-line raster_changes lane sets
// in `where` order, drawing pixel runs between consecutive change points,
// applying each change to the running RasterState before the next run.
//
// The lane sets are built upstream from VicIIVice.frameLineLogs by
// raster-changes-builder.ts (Spec 262 Phase A → Spec 280c bridge).
//
// Sub-spec coverage (delivered here):
//   - Per-line walk + change apply (vice raster_modes_draw_background pattern)
//   - Pixel emit for: standard text, multicolor text, extended-bg text,
//     standard bitmap, multicolor bitmap, idle line
//   - Mid-line bg color split
//   - $D018 → next_line ptr update (badline-aware via state)
//   - DEN off → border-only
//   - Single-sprite render at correct x (first cut; full multiplexer lives
//     in 280d)
//   - nextLine queue carry across frame wrap
//
// Out of scope (separate sub-sprints):
//   - 280d: full sprite multiplexer + collision detection
//   - 280e: per-cycle badline DMA fetch
//   - 280g: per-cycle bus-stealing scheduler integration

import type { HeadlessMemoryBus } from "../memory-bus.js";
import {
  PAL_PIXELS_PER_LINE,
  type RasterChangeAction,
  type RasterChangesPerLine,
} from "../vic/raster-changes.js";
import { buildPerLineLanesFromFrameLog } from "../vic/raster-changes-builder.js";
import {
  applyAction,
  initStateFromVic,
  updateVerticalFFAtLineStart,
  type RasterState,
} from "../vic/raster-state.js";
import { renderSpritesPerLine, type SpriteCollisionResult } from "../vic/sprite-render.js";
import {
  VIC_PALETTE,
  VicFramebuffer,
  VISIBLE_H,
  VISIBLE_W,
  VISIBLE_X,
  VISIBLE_Y,
} from "./vic-renderer.js";

export { VicFramebuffer } from "./vic-renderer.js";

// ---------------------------------------------------------------------------
// Carry across frames (per Spec 280 OQ2): nextLine queue accumulated at
// end of frame applies to start of line 0 next frame.
// ---------------------------------------------------------------------------

let frameCarry: RasterChangeAction[] = [];

/** Test/reset hook — clear inter-frame carry between independent calls. */
export function resetFrameCarry(): void {
  frameCarry = [];
}

// ---------------------------------------------------------------------------
// Renderer entry.
// ---------------------------------------------------------------------------

export interface RasterizedRenderContext {
  vic: {
    regs: Uint8Array;
    screen_height?: number;
    frameLineLogs?: import("../vic/vic-ii-vice.js").ScanlineRegLog[];
  };
  bus: HeadlessMemoryBus;
  /** CIA2 PA byte at frame entry (seed for VIC bank). */
  initialCia2PaByte: number;
  /** When true, drop any carryover from the previous renderFrame call. */
  resetCarry?: boolean;
}

export function renderFrameRasterized(
  fb: VicFramebuffer,
  ctx: RasterizedRenderContext,
): void {
  if (ctx.resetCarry) frameCarry = [];

  const lineCount = ctx.vic.screen_height ?? 312;
  const frame = buildPerLineLanesFromFrameLog(ctx.vic, ctx.initialCia2PaByte);
  const state = initStateFromVic(ctx.vic, ctx.initialCia2PaByte);

  // Apply any deferred actions from the previous frame's last line.
  for (const a of frameCarry) applyAction(state, a);
  frameCarry = [];

  // Pending nextLine actions accumulated by the line we just drew.
  let pendingNextLine: RasterChangeAction[] = [];

  // Accumulated sprite collision flags for the whole frame.
  // OR'd into vic regs $D01E (sp-sp) / $D01F (sp-bg) at frame end.
  let frameSpSpColl = 0;
  let frameSpBgColl = 0;

  // Per-line fg mask: one byte per visible pixel. Rebuilt each visible line.
  const fgMask = new Uint8Array(VISIBLE_W * VISIBLE_H);

  for (let line = 0; line < lineCount; line++) {
    // 1. Apply previous line's nextLine queue first (= effective at this
    //    line's first pixel).
    for (const a of pendingNextLine) applyAction(state, a);
    pendingNextLine = [];

    const lane = frame.perLine[line] ?? emptyLane();
    const coll = renderOneLine(fb, ctx.bus, state, line, lane, fgMask);
    frameSpSpColl |= coll.spriteSpCollision;
    frameSpBgColl |= coll.spriteBgCollision;

    // Harvest this line's nextLine queue for next iteration.
    for (const a of lane.nextLine) pendingNextLine.push(a);
  }

  // Carry leftover deferred actions into next frame's line 0.
  frameCarry = pendingNextLine;

  // Write back collision flags. These are sticky (latch until cleared by CPU read).
  if (frameSpSpColl !== 0 || frameSpBgColl !== 0) {
    ctx.vic.regs[0x1e] = ((ctx.vic.regs[0x1e] ?? 0) | frameSpSpColl) & 0xff;
    ctx.vic.regs[0x1f] = ((ctx.vic.regs[0x1f] ?? 0) | frameSpBgColl) & 0xff;
  }
}

function emptyLane(): RasterChangesPerLine {
  return {
    background: [], foreground: [], border: [],
    sprites: [], nextLine: [], haveOnThisLine: false,
  };
}

// ---------------------------------------------------------------------------
// Per-line render.
// ---------------------------------------------------------------------------

const EMPTY_COLL: SpriteCollisionResult = { spriteBgCollision: 0, spriteSpCollision: 0 };

function renderOneLine(
  fb: VicFramebuffer,
  bus: HeadlessMemoryBus,
  state: RasterState,
  line: number,
  lane: RasterChangesPerLine,
  fgMask: Uint8Array,
): SpriteCollisionResult {
  // VICE handle_visible_line_with_changes splits the line into:
  //   1. Background pass (full line)
  //   2. Foreground pass (graphics chars over background)
  //   3. Sprite pass
  // Border is drawn last (top/bottom border + side borders).
  //
  // In our model background+foreground are emitted together by the
  // mode-specific pixel-emit routines (drawTextLine etc) in one go for
  // each [xs..xe-1] segment. That collapses two passes into one but
  // produces the same result because a full segment uses one mode and
  // one set of colors at that point in the walk.

  // Spec 281: update vertical border flip-flop at line boundary
  // (handles display_ystart enter / display_ystop bottom-border).
  updateVerticalFFAtLineStart(state, line);
  // Initialize line: paint full line with current border color (default
  // when no display, or where outside 24/40-col display window).
  paintScanline(fb, line, state.border_color);

  // Top/bottom border = vertical FF set + no open-border trick this line.
  // We still walk lanes so colors stay consistent for any mid-line
  // border-color writes (rare but possible for vertical-band tricks).
  if (state.vertical_ff && lane.background.length === 0
      && lane.foreground.length === 0 && lane.sprites.length === 0) {
    for (const a of lane.border) applyAction(state, a);
    return EMPTY_COLL;
  }

  // Clear fg mask row for this visible line. fgMask still uses the
  // legacy 320×200 layout — sprite collision detection consults it
  // only inside the display window. For 38-col / open-border lines
  // the "outside-window" pixels never set fgMask anyway.
  const yIn = line - VISIBLE_Y;
  if (yIn >= 0 && yIn < VISIBLE_H) {
    fgMask.fill(0, yIn * VISIBLE_W, (yIn + 1) * VISIBLE_W);
  }

  // Walk merged change queue — we step through background lane in
  // `where` order; between change points emit pixels for the segment
  // using the mode-specific pixel emitter.
  const bgQueue = lane.background;
  const borderQueue = lane.border;

  // Apply border changes monotonically alongside bg: simpler model —
  // borders only affect the border bands (not the active 320×200), so
  // we can pre-apply all border changes (their effect is full-line
  // border-color repaint at apply position).
  // For correctness in mid-line border splits we walk border queue and
  // overwrite the border bands at each transition.
  let xs = 0;
  let bgIdx = 0;
  while (bgIdx < bgQueue.length) {
    const action = bgQueue[bgIdx]!;
    const xe = action.where;
    if (xs < xe) {
      emitGfxRun(fb, bus, state, line, xs, xe - 1, fgMask);
      xs = xe;
    }
    applyAction(state, action);
    bgIdx++;
  }
  if (xs < PAL_PIXELS_PER_LINE) {
    emitGfxRun(fb, bus, state, line, xs, PAL_PIXELS_PER_LINE - 1, fgMask);
  }

  // Border pass — draw border bands (left+right) using current border
  // color; respect mid-line border-color changes.
  drawBorderBands(fb, line, borderQueue, state);

  // Sprite pass — 280d full multiplexer. Walk sprite lane changes first to
  // apply mid-line position/color/enable updates, then render.
  for (const a of lane.sprites) applyAction(state, a);

  return renderSpritesPerLine(
    state, line, fb.pixels, fb.width, fgMask, bus, fb.palette,
  );
}

// ---------------------------------------------------------------------------
// Pixel emitters — one segment per call.
// ---------------------------------------------------------------------------

function emitGfxRun(
  fb: VicFramebuffer,
  bus: HeadlessMemoryBus,
  state: RasterState,
  line: number,
  xStart: number,
  xEnd: number,
  fgMask: Uint8Array,
): void {
  // Spec 281: gfx clip area derived from current RSEL/CSEL state
  // (display_xstart_pixel..display_xstop_pixel-1). VICE convention:
  // display_xstop = first pixel of right border. Outside this range,
  // the border layer takes over.
  const gfxX0 = state.display_xstart_pixel;
  const gfxX1 = state.display_xstop_pixel - 1;
  const fillX0 = Math.max(xStart, 0);
  const fillX1 = Math.min(xEnd, PAL_PIXELS_PER_LINE - 1);
  // V3.1 fix: when DEN=0 (= VIC display blanked), entire visible area
  // shows BORDER color (= $D020), not background. VICE behavior +
  // matches loader screens (e.g. motm during disk load).
  if (!state.den) {
    fillSpan(fb, line, fillX0, fillX1, state.border_color);
    return;
  }
  // Spec 281: top/bottom border (vertical FF set) — fill border color
  // unless open-border trick is active. OQ1: when both FFs OFF in
  // open-border zone, draw bg-color (handled by the FF-off path below).
  if (state.vertical_ff) {
    fillSpan(fb, line, fillX0, fillX1, state.border_color);
    return;
  }
  // DEN on, vertical FF off: solid bg fill across segment, mode-renderer
  // overdraws active gfx region.
  fillSpan(fb, line, fillX0, fillX1, state.background_color);
  const a0 = Math.max(fillX0, gfxX0);
  const a1 = Math.min(fillX1, gfxX1);
  if (a1 < a0) return;

  switch (state.video_mode) {
    case 0: drawStdTextSeg(fb, bus, state, line, a0, a1, fgMask); break;
    case 1: drawMcTextSeg(fb, bus, state, line, a0, a1, fgMask); break;
    case 2: drawStdBitmapSeg(fb, bus, state, line, a0, a1, fgMask); break;
    case 3: drawMcBitmapSeg(fb, bus, state, line, a0, a1, fgMask); break;
    case 4: drawExtTextSeg(fb, bus, state, line, a0, a1, fgMask); break;
    // Spec 284: illegal modes 5/6/7 — visible pixels = palette[0]
    // (= absolute black, NOT $D021), fgMask still populated from
    // chargen/bitmap so sprite-bg collision works (1:1 VICE).
    case 5: drawIllegalTextSeg(fb, bus, state, line, a0, a1, fgMask); break;
    case 6: drawIllegalBitmapMode1Seg(fb, bus, state, line, a0, a1, fgMask); break;
    case 7: drawIllegalBitmapMode2Seg(fb, bus, state, line, a0, a1, fgMask); break;
  }
}

function fillSpan(
  fb: VicFramebuffer, y: number, x0: number, x1: number, color: number,
): void {
  if (y < 0 || y >= fb.height) return;
  const cx0 = Math.max(0, x0);
  const cx1 = Math.min(fb.width - 1, x1);
  for (let x = cx0; x <= cx1; x++) fb.setPixel(x, y, color);
}

function paintScanline(fb: VicFramebuffer, y: number, color: number): void {
  fillSpan(fb, y, 0, fb.width - 1, color);
}

// VIC bank read: char ROM shadow at $1000-$1FFF in banks 0/2.
function vicRead(bus: HeadlessMemoryBus, bankBase: number, addr: number): number {
  const masked = addr & 0x3fff;
  const charBank = (bankBase === 0x0000) || (bankBase === 0x8000);
  if (charBank && masked >= 0x1000 && masked < 0x2000) {
    return bus.charRom[masked - 0x1000]!;
  }
  return bus.ram[(bankBase + masked) & 0xffff]!;
}

// ---------- Standard text (mode 0) ----------
function drawStdTextSeg(
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
    const screenOff = state.screen_base_ptr + cellIdx;
    const charCode = vicRead(bus, state.vic_bank_base, screenOff);
    const fg = bus.io[colorRamBase + cellIdx]! & 0x0f;
    const charByte = vicRead(bus, state.vic_bank_base,
      state.chargen_base_ptr + charCode * 8 + charY);
    const bit = (charByte >> (7 - (xIn & 7))) & 1;
    if (bit) {
      fb.setPixel(x, line, fg);
      fgMask[yIn * VISIBLE_W + xIn] = 1;
    } else {
      fb.setPixel(x, line, state.background_color);
    }
  }
}

// ---------- Multicolor text (mode 1) ----------
function drawMcTextSeg(
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
    const charCode = vicRead(bus, state.vic_bank_base,
      state.screen_base_ptr + cellIdx);
    const cram = bus.io[colorRamBase + cellIdx]!;
    const isMc = (cram & 0x08) !== 0;
    const fg = cram & 0x07;
    const byte = vicRead(bus, state.vic_bank_base,
      state.chargen_base_ptr + charCode * 8 + charY);
    if (!isMc) {
      const bit = (byte >> (7 - (xIn & 7))) & 1;
      fb.setPixel(x, line, bit ? (cram & 0x0f) : state.background_color);
      if (bit) fgMask[yIn * VISIBLE_W + xIn] = 1;
    } else {
      // 2-pixel pairs. Bits 10/11 are fg for collision purposes (VICE convention).
      const pair = (xIn & 7) >> 1;
      const bits = (byte >> ((3 - pair) * 2)) & 0x03;
      const c =
        bits === 0 ? state.background_color :
        bits === 1 ? state.background_color_1 :
        bits === 2 ? state.background_color_2 :
        fg;
      fb.setPixel(x, line, c);
      // bits 10 and 11 (bits>=2) are foreground for collision detection.
      if (bits >= 2) fgMask[yIn * VISIBLE_W + xIn] = 1;
    }
  }
}

// ---------- Standard bitmap (mode 2) ----------
function drawStdBitmapSeg(
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
    const screenByte = vicRead(bus, state.vic_bank_base,
      state.screen_base_ptr + cellIdx);
    const fg = (screenByte >> 4) & 0x0f;
    const bg = screenByte & 0x0f;
    const bmpAddr = state.bitmap_base_ptr + cellIdx * 8 + charY;
    const byte = vicRead(bus, state.vic_bank_base, bmpAddr);
    const bit = (byte >> (7 - (xIn & 7))) & 1;
    fb.setPixel(x, line, bit ? fg : bg);
    if (bit) fgMask[yIn * VISIBLE_W + xIn] = 1;
  }
}

// ---------- Multicolor bitmap (mode 3) ----------
function drawMcBitmapSeg(
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
    const screenByte = vicRead(bus, state.vic_bank_base,
      state.screen_base_ptr + cellIdx);
    const cram = bus.io[colorRamBase + cellIdx]!;
    const c01 = (screenByte >> 4) & 0x0f;
    const c10 = screenByte & 0x0f;
    const c11 = cram & 0x0f;
    const byte = vicRead(bus, state.vic_bank_base,
      state.bitmap_base_ptr + cellIdx * 8 + charY);
    const pair = (xIn & 7) >> 1;
    const bits = (byte >> ((3 - pair) * 2)) & 0x03;
    const c =
      bits === 0 ? state.background_color :
      bits === 1 ? c01 :
      bits === 2 ? c10 :
      c11;
    fb.setPixel(x, line, c);
    // bits 10 and 11 are fg for collision purposes.
    if (bits >= 2) fgMask[yIn * VISIBLE_W + xIn] = 1;
  }
}

// ---------- Extended-bg text (mode 4) ----------
function drawExtTextSeg(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number, fgMask: Uint8Array,
): void {
  const yIn = line - VISIBLE_Y;
  if (yIn < 0 || yIn >= VISIBLE_H) return;
  const charRow = (yIn >> 3) | 0;
  const charY = yIn & 7;
  const colorRamBase = 0x0800;
  const bgs = [
    state.background_color, state.background_color_1,
    state.background_color_2, state.background_color_3,
  ];
  for (let x = x0; x <= x1; x++) {
    const xIn = x - VISIBLE_X;
    if (xIn < 0 || xIn >= VISIBLE_W) continue;
    const col = (xIn >> 3) | 0;
    const cellIdx = charRow * 40 + col;
    const screenByte = vicRead(bus, state.vic_bank_base,
      state.screen_base_ptr + cellIdx);
    const charCode = screenByte & 0x3f;
    const bgIdx = (screenByte >> 6) & 0x03;
    const fg = bus.io[colorRamBase + cellIdx]! & 0x0f;
    const byte = vicRead(bus, state.vic_bank_base,
      state.chargen_base_ptr + charCode * 8 + charY);
    const bit = (byte >> (7 - (xIn & 7))) & 1;
    fb.setPixel(x, line, bit ? fg : bgs[bgIdx]!);
    if (bit) fgMask[yIn * VISIBLE_W + xIn] = 1;
  }
}

// ---------- Idle (DEN off, invalid mode) ----------
function drawIdleSeg(
  fb: VicFramebuffer, line: number, x0: number, x1: number, bg: number,
): void {
  fillSpan(fb, line, x0, x1, bg);
}

// ---------- Spec 284: illegal modes 5/6/7 ----------
// All three: visible pixels = palette[0] (= absolute black, NOT
// $D021), fgMask still populated from chargen/bitmap so sprite-bg
// collision works against the implied "shape". 1:1 VICE.

import { mcMask } from "../vic/mc-mask-table.js";

// Mode 5: ECM+MCM. Mask = chargen[(vbuf[col] & 0x3f)*8 + ycounter],
// optionally mc-masked when color RAM bit 3 set.
function drawIllegalTextSeg(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number, fgMask: Uint8Array,
): void {
  const yIn = line - VISIBLE_Y;
  if (yIn < 0 || yIn >= VISIBLE_H) return;
  // Bulk fill: all visible pixels in segment = palette[0] (= black).
  fillSpan(fb, line, x0, x1, 0);
  const charRow = (yIn >> 3) | 0;
  const charY = yIn & 7;
  const colorRamBase = 0x0800;
  // Iterate char cells covering the segment, populate mask only.
  let col = Math.max(0, ((x0 - VISIBLE_X) >> 3));
  const lastCol = Math.min(39, ((x1 - VISIBLE_X) >> 3));
  for (; col <= lastCol; col++) {
    const cellIdx = charRow * 40 + col;
    const charCode = vicRead(bus, state.vic_bank_base,
      state.screen_base_ptr + cellIdx) & 0x3f;
    const fgColor = bus.io[colorRamBase + cellIdx]! & 0x0f;
    const charByte = vicRead(bus, state.vic_bank_base,
      state.chargen_base_ptr + charCode * 8 + charY);
    const maskByte = (fgColor & 0x8) ? mcMask(charByte) : charByte;
    // Spread 8-bit mask byte into fgMask cells for this char column.
    const baseX = col * 8;
    for (let bit = 0; bit < 8; bit++) {
      const xIn = baseX + bit;
      if (xIn >= VISIBLE_W) break;
      if ((maskByte >> (7 - bit)) & 1) fgMask[yIn * VISIBLE_W + xIn] = 1;
    }
  }
}

// Mode 6: ECM+BMM. Mask = bitmap byte at (memptr+col)<<3 + ycounter,
// with j & 0x1000 hi/lo switch (VICE _draw_illegal_bitmap_mode1).
function drawIllegalBitmapMode1Seg(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number, fgMask: Uint8Array,
): void {
  const yIn = line - VISIBLE_Y;
  if (yIn < 0 || yIn >= VISIBLE_H) return;
  fillSpan(fb, line, x0, x1, 0);
  const charY = yIn & 7;
  // memptr = (charRow * 40) effective; bitmap offset model.
  const memptr = ((yIn >> 3) | 0) * 40;
  let col = Math.max(0, ((x0 - VISIBLE_X) >> 3));
  const lastCol = Math.min(39, ((x1 - VISIBLE_X) >> 3));
  for (; col <= lastCol; col++) {
    const j = ((memptr + col) << 3) + charY;
    // VICE: j & 0x1000 splits low/high bitmap pointers. We collapse
    // both into a single read against state.bitmap_base_ptr +
    // (j & 0x1fff). The mask byte from VIC bank read.
    const addr = state.bitmap_base_ptr + (j & 0x1fff);
    const bmval = vicRead(bus, state.vic_bank_base, addr);
    const baseX = col * 8;
    for (let bit = 0; bit < 8; bit++) {
      const xIn = baseX + bit;
      if (xIn >= VISIBLE_W) break;
      if ((bmval >> (7 - bit)) & 1) fgMask[yIn * VISIBLE_W + xIn] = 1;
    }
  }
}

// Mode 7: ECM+BMM+MCM. Same as mode 6 but mask byte goes through
// mcMask (= 2-bit pixel pairs).
function drawIllegalBitmapMode2Seg(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number, fgMask: Uint8Array,
): void {
  const yIn = line - VISIBLE_Y;
  if (yIn < 0 || yIn >= VISIBLE_H) return;
  fillSpan(fb, line, x0, x1, 0);
  const charY = yIn & 7;
  const memptr = ((yIn >> 3) | 0) * 40;
  let col = Math.max(0, ((x0 - VISIBLE_X) >> 3));
  const lastCol = Math.min(39, ((x1 - VISIBLE_X) >> 3));
  for (; col <= lastCol; col++) {
    const j = ((memptr + col) << 3) + charY;
    const addr = state.bitmap_base_ptr + (j & 0x1fff);
    const bmval = vicRead(bus, state.vic_bank_base, addr);
    const maskByte = mcMask(bmval);
    const baseX = col * 8;
    for (let bit = 0; bit < 8; bit++) {
      const xIn = baseX + bit;
      if (xIn >= VISIBLE_W) break;
      if ((maskByte >> (7 - bit)) & 1) fgMask[yIn * VISIBLE_W + xIn] = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Border bands. PAL standard 40-col window: pixels 32..351 visible
// graphics, 0..31 + 352..503 are border (left/right). Vertical border
// handled by yIsVisible check above (full-line border for top/bottom).
// ---------------------------------------------------------------------------

function drawBorderBands(
  fb: VicFramebuffer, line: number,
  borderQueue: RasterChangeAction[], state: RasterState,
): void {
  // Spec 281: VICE 2-span draw_borders model. Top/bottom border (vertical
  // FF set) = full-line border. L/R border = bands outside
  // [display_xstart_pixel..display_xstop_pixel-1]. Mid-line border-color
  // changes via borderQueue (often 0..2 entries).
  if (state.vertical_ff) {
    // Top/bottom border zone: full-line band, walk queue for mid-line splits.
    let xs = 0;
    for (const a of borderQueue) {
      const xe = a.where;
      if (xs < xe) fillSpan(fb, line, xs, xe - 1, state.border_color);
      applyAction(state, a);
      xs = xe;
    }
    fillSpan(fb, line, xs, PAL_PIXELS_PER_LINE - 1, state.border_color);
    return;
  }
  // Display zone: only L/R border bands, gated by horizontal FF.
  let xs = 0;
  for (const a of borderQueue) {
    const xe = a.where;
    if (xs < xe) paintLRBorderBands(fb, line, xs, xe - 1, state);
    applyAction(state, a);
    xs = xe;
  }
  paintLRBorderBands(fb, line, xs, PAL_PIXELS_PER_LINE - 1, state);
}

function paintLRBorderBands(
  fb: VicFramebuffer, line: number, x0: number, x1: number, state: RasterState,
): void {
  // L band = pixels [0..display_xstart_pixel-1]
  // R band = pixels [display_xstop_pixel..end]
  // Spec 285: xsmooth_color band — when xsmooth > 0, the rightmost N
  // pixels of the L border use xsmooth_color (= per-mode bg/mc1 fill)
  // instead of border color. VICE applies left-edge only (per OQ2).
  const color = state.border_color;
  const lx0 = Math.max(0, x0);
  const lx1 = Math.min(state.display_xstart_pixel - 1, x1);
  if (lx1 >= lx0) {
    const xs = state.xsmooth & 0x07;
    if (xs > 0 && state.den && !state.vertical_ff) {
      // Border up to display_xstart_pixel - xs, then xsmooth_color band
      const borderEnd = Math.min(lx1, state.display_xstart_pixel - 1 - xs);
      if (borderEnd >= lx0) fillSpan(fb, line, lx0, borderEnd, color);
      const xsStart = Math.max(lx0, state.display_xstart_pixel - xs);
      if (lx1 >= xsStart) fillSpan(fb, line, xsStart, lx1, state.xsmooth_color);
    } else {
      fillSpan(fb, line, lx0, lx1, color);
    }
  }
  const rx0 = Math.max(state.display_xstop_pixel, x0);
  const rx1 = Math.min(fb.width - 1, x1);
  if (rx1 >= rx0) fillSpan(fb, line, rx0, rx1, color);
}

// ---------------------------------------------------------------------------
// Re-export palette constant for callers + tests.
// ---------------------------------------------------------------------------
export { VIC_PALETTE };
