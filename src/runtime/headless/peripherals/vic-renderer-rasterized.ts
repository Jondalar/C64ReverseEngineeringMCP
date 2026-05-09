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
  type RasterState,
} from "../vic/raster-state.js";
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

  for (let line = 0; line < lineCount; line++) {
    // 1. Apply previous line's nextLine queue first (= effective at this
    //    line's first pixel).
    for (const a of pendingNextLine) applyAction(state, a);
    pendingNextLine = [];

    const lane = frame.perLine[line] ?? emptyLane();
    renderOneLine(fb, ctx.bus, state, line, lane);

    // Harvest this line's nextLine queue for next iteration.
    for (const a of lane.nextLine) pendingNextLine.push(a);
  }

  // Carry leftover deferred actions into next frame's line 0.
  frameCarry = pendingNextLine;
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

function renderOneLine(
  fb: VicFramebuffer,
  bus: HeadlessMemoryBus,
  state: RasterState,
  line: number,
  lane: RasterChangesPerLine,
): void {
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

  const yIsVisible = line >= VISIBLE_Y && line < VISIBLE_Y + VISIBLE_H;
  // Initialize line: paint full line with current border color (default
  // when no display, or where outside 24/40-col display window).
  paintScanline(fb, line, state.border_color);

  if (!yIsVisible) {
    // Outside vertical display — apply lane changes (so colors stay
    // consistent for mid-line border tricks future) but skip pixel emit.
    for (const a of lane.border) applyAction(state, a);
    for (const a of lane.background) applyAction(state, a);
    for (const a of lane.sprites) applyAction(state, a);
    return;
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
      emitGfxRun(fb, bus, state, line, xs, xe - 1);
      xs = xe;
    }
    applyAction(state, action);
    bgIdx++;
  }
  if (xs < PAL_PIXELS_PER_LINE) {
    emitGfxRun(fb, bus, state, line, xs, PAL_PIXELS_PER_LINE - 1);
  }

  // Border pass — draw border bands (left+right) using current border
  // color; respect mid-line border-color changes.
  drawBorderBands(fb, line, borderQueue, state);

  // Sprite pass — single-sprite-per-line cut. Walks sprites lane to apply
  // mid-line position/color/enable changes; full multiplexer in 280d.
  drawSpritesForLine(fb, bus, state, line, lane.sprites);
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
): void {
  // Clip to the active 320×200 area for graphics; outside that the
  // border layer takes over.
  const gfxX0 = VISIBLE_X;
  const gfxX1 = VISIBLE_X + VISIBLE_W - 1;
  const fillX0 = Math.max(xStart, 0);
  const fillX1 = Math.min(xEnd, PAL_PIXELS_PER_LINE - 1);
  // Solid background fill across the segment regardless of mode (will
  // be overdrawn for active region below).
  fillSpan(fb, line, fillX0, fillX1, state.background_color);

  if (!state.den) return;
  const a0 = Math.max(fillX0, gfxX0);
  const a1 = Math.min(fillX1, gfxX1);
  if (a1 < a0) return;

  switch (state.video_mode) {
    case 0: drawStdTextSeg(fb, bus, state, line, a0, a1); break;
    case 1: drawMcTextSeg(fb, bus, state, line, a0, a1); break;
    case 2: drawStdBitmapSeg(fb, bus, state, line, a0, a1); break;
    case 3: drawMcBitmapSeg(fb, bus, state, line, a0, a1); break;
    case 4: drawExtTextSeg(fb, bus, state, line, a0, a1); break;
    default: drawIdleSeg(fb, line, a0, a1, state.background_color); break;
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
  line: number, x0: number, x1: number,
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
    if (bit) fb.setPixel(x, line, fg);
    else fb.setPixel(x, line, state.background_color);
  }
}

// ---------- Multicolor text (mode 1) ----------
function drawMcTextSeg(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number,
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
    } else {
      // 2-pixel pairs.
      const pair = (xIn & 7) >> 1;
      const bits = (byte >> ((3 - pair) * 2)) & 0x03;
      const c =
        bits === 0 ? state.background_color :
        bits === 1 ? state.background_color_1 :
        bits === 2 ? state.background_color_2 :
        fg;
      fb.setPixel(x, line, c);
    }
  }
}

// ---------- Standard bitmap (mode 2) ----------
function drawStdBitmapSeg(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number,
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
  }
}

// ---------- Multicolor bitmap (mode 3) ----------
function drawMcBitmapSeg(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number,
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
  }
}

// ---------- Extended-bg text (mode 4) ----------
function drawExtTextSeg(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, x0: number, x1: number,
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
  }
}

// ---------- Idle (DEN off, invalid mode) ----------
function drawIdleSeg(
  fb: VicFramebuffer, line: number, x0: number, x1: number, bg: number,
): void {
  fillSpan(fb, line, x0, x1, bg);
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
  // Pre-apply border-color queue in `where` order, drawing the border
  // band segment for each new color.
  let xs = 0;
  for (const a of borderQueue) {
    const xe = a.where;
    if (xs < xe) {
      paintBorderRange(fb, line, xs, xe - 1, state.border_color);
    }
    applyAction(state, a);
    xs = xe;
  }
  paintBorderRange(fb, line, xs, PAL_PIXELS_PER_LINE - 1, state.border_color);
}

function paintBorderRange(
  fb: VicFramebuffer, line: number, x0: number, x1: number, color: number,
): void {
  // Border = pixels outside [VISIBLE_X..VISIBLE_X+VISIBLE_W-1].
  const lx0 = Math.max(0, x0);
  const lx1 = Math.min(VISIBLE_X - 1, x1);
  if (lx1 >= lx0) fillSpan(fb, line, lx0, lx1, color);
  const rx0 = Math.max(VISIBLE_X + VISIBLE_W, x0);
  const rx1 = Math.min(fb.width - 1, x1);
  if (rx1 >= rx0) fillSpan(fb, line, rx0, rx1, color);
}

// ---------------------------------------------------------------------------
// Sprite render — single-sprite per line cut. Walks sprite-lane changes
// to update positions/colors mid-line; full multiplexer is 280d.
// ---------------------------------------------------------------------------

function drawSpritesForLine(
  fb: VicFramebuffer, bus: HeadlessMemoryBus, state: RasterState,
  line: number, spriteQueue: RasterChangeAction[],
): void {
  // First: apply mid-line sprite changes in order. We don't split the
  // line into segments here (sprites in V1 280c are drawn as a single
  // full-line pass with the *post-walk* state). 280d will refine.
  for (const a of spriteQueue) applyAction(state, a);

  if (state.sprite_enable === 0) return;

  // Sprite y on screen-relative coords; visible region origin offset 50
  // (vice convention; we use 50 to match peripherals/vic-renderer.ts).
  const lineForSprite = line - 50;
  if (lineForSprite < 0 || lineForSprite >= VISIBLE_H + 50) return;

  const screenOff = state.screen_base_ptr;
  for (let sp = 0; sp < 8; sp++) {
    if ((state.sprite_enable & (1 << sp)) === 0) continue;
    const sy = state.sprite_y[sp]!;
    const expandY = (state.sprite_y_expand & (1 << sp)) !== 0;
    const expandX = (state.sprite_x_expand & (1 << sp)) !== 0;
    const isMc = (state.sprite_multicolor & (1 << sp)) !== 0;
    const color = state.sprite_color[sp]!;
    const heightPx = expandY ? 42 : 21;
    const dy = lineForSprite - (sy - 50);
    if (dy < 0 || dy >= heightPx) continue;
    const srcRow = expandY ? (dy >> 1) : dy;
    const ptrByte = vicRead(bus, state.vic_bank_base, screenOff + 0x3f8 + sp);
    const dataBase = ptrByte * 64;
    const sx = state.sprite_x[sp]!;
    for (let byteIdx = 0; byteIdx < 3; byteIdx++) {
      const byte = vicRead(bus, state.vic_bank_base, dataBase + srcRow * 3 + byteIdx);
      if (!isMc) {
        for (let bit = 0; bit < 8; bit++) {
          if (((byte >> (7 - bit)) & 1) === 0) continue;
          const baseInScreen = sx + byteIdx * 8 + bit - 24;
          const w = expandX ? 2 : 1;
          for (let r = 0; r < w; r++) {
            const px = VISIBLE_X + baseInScreen * (expandX ? 1 : 1) + r;
            fb.setPixel(px, line, color);
          }
        }
      } else {
        for (let pair = 0; pair < 4; pair++) {
          const bits = (byte >> ((3 - pair) * 2)) & 0x03;
          if (bits === 0) continue;
          const c = bits === 1 ? state.sprite_mc_color_1
                  : bits === 2 ? color
                  : state.sprite_mc_color_2;
          const baseInScreen = sx + byteIdx * 8 + pair * 2 - 24;
          const w = expandX ? 4 : 2;
          for (let r = 0; r < w; r++) {
            const px = VISIBLE_X + baseInScreen + r;
            fb.setPixel(px, line, c);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Re-export palette constant for callers + tests.
// ---------------------------------------------------------------------------
export { VIC_PALETTE };
