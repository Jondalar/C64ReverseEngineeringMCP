// Spec 280c — RasterState: effective per-pixel chip state mutated by
// raster_changes lane actions during the per-line render walk.
//
// Mirrors the subset of vice/src/raster/raster.h `raster_t` fields that
// the per-line renderer touches between change applies. Each
// `applyAction` corresponds to a `raster_changes_apply` call in
// vice/src/raster/raster-changes.c.
//
// Initial state is built from the live VIC reg file + CIA2 PA at the
// moment of frame entry; per-line walk then mutates the state via the
// queued lane actions.

import type { RasterChangeAction, RasterChangeField } from "./raster-changes.js";
import { computeVicBankBase } from "../peripherals/vic-renderer.js";

/** Effective per-pixel rendering state. */
export interface RasterState {
  // ---- Mode / control ----
  /** Combined video mode index (0..7): bit2=ECM bit1=BMM bit0=MCM. */
  video_mode: number;
  /** $D016 low 3 bits — horizontal smooth scroll. */
  xsmooth: number;
  /** $D011 low 3 bits — vertical smooth scroll. */
  ysmooth: number;
  /** $D011 bit 4 — display enable. */
  den: boolean;
  /** $D011 bit 3 — 24/25-row select. */
  rsel: boolean;
  /** $D016 bit 3 — 38/40-col select. */
  csel: boolean;

  // ---- Memory pointers (within VIC bank) ----
  /** Screen RAM offset in VIC bank ($D018 high nibble × $400). */
  screen_base_ptr: number;
  /** Chargen offset in VIC bank ($D018 mid bits × $800). */
  chargen_base_ptr: number;
  /** Bitmap offset in VIC bank ($D018 bit 3 × $2000). */
  bitmap_base_ptr: number;
  /** VIC bank base in main 64K ($0000/$4000/$8000/$C000). */
  vic_bank_base: number;

  // ---- Colors ----
  border_color: number;          // $D020
  background_color: number;      // $D021
  background_color_1: number;    // $D022
  background_color_2: number;    // $D023
  background_color_3: number;    // $D024 (ECM only)
  sprite_mc_color_1: number;     // $D025
  sprite_mc_color_2: number;     // $D026

  // ---- Sprite state ----
  sprite_color: Uint8Array;      // 8 entries — $D027..$D02E
  sprite_x: Uint16Array;         // 8 entries — $D000/2/4/.../E + MSB
  sprite_y: Uint8Array;          // 8 entries — $D001/3/.../F
  sprite_x_msb: number;          // $D010
  sprite_enable: number;         // $D015
  sprite_priority: number;       // $D01B
  sprite_multicolor: number;     // $D01C
  sprite_x_expand: number;       // $D01D
  sprite_y_expand: number;       // $D017

  // ---- Spec 281: Border geometry + flip-flops ----
  // Updated when RSEL/CSEL flip mid-frame (mirrors VICE
  // raster.display_xstart / xstop / ystart / ystop in vicii-mem.c
  // d011_store / d016_store).
  display_ystart: number;        // 51 (RSEL=1) | 55 (RSEL=0)
  display_ystop: number;         // 250 | 246
  display_xstart_cycle: number;  // 17 (CSEL=1) | 18 (CSEL=0)
  display_xstop_cycle: number;   // 56 | 55
  display_xstart_pixel: number;  // 24 | 31
  display_xstop_pixel: number;   // 343 | 334
  // PAL row boundaries — VICE constants for vicii_per_pal_init.
  row_24_start_line: number;     // 55
  row_24_stop_line: number;      // 247
  row_25_start_line: number;     // 51
  row_25_stop_line: number;      // 251
  // Border flip-flops (raster_t.blank_enabled + horizontal FF).
  vertical_ff: boolean;          // true = top/bottom border ON
  horizontal_ff: boolean;        // true = L or R border ON

  // Spec 285: xsmooth color band — fill color for the xsmooth
  // pixels at the L-edge of gfx window. Per-mode (= bg in std/ext
  // text, mc1 in MC modes, idle-fill in idle/illegal). Updated on
  // mode change.
  xsmooth_color: number;

  // Spec 289: raster mode state machine — explicit enum of what the
  // VIC is doing this cycle. Mirrors VICE raster-modes.h enum.
  // - "border": drawing border (vertical_ff || horizontal_ff)
  // - "display": drawing graphics in display window (DEN=1, FFs off)
  // - "idle": DEN off but in display lines (= idle-fill state)
  raster_mode: "border" | "display" | "idle";
}

export type RasterMode = "border" | "display" | "idle";

export function createEmptyRasterState(): RasterState {
  return {
    video_mode: 0,
    xsmooth: 0,
    ysmooth: 0,
    den: false,
    rsel: false,
    csel: false,
    screen_base_ptr: 0,
    chargen_base_ptr: 0,
    bitmap_base_ptr: 0,
    vic_bank_base: 0,
    border_color: 0,
    background_color: 0,
    background_color_1: 0,
    background_color_2: 0,
    background_color_3: 0,
    sprite_mc_color_1: 0,
    sprite_mc_color_2: 0,
    sprite_color: new Uint8Array(8),
    sprite_x: new Uint16Array(8),
    sprite_y: new Uint8Array(8),
    sprite_x_msb: 0,
    sprite_enable: 0,
    sprite_priority: 0,
    sprite_multicolor: 0,
    sprite_x_expand: 0,
    sprite_y_expand: 0,
    // Spec 281 PAL defaults — VICE vicii.c VICII_PAL_* + viciitypes.h.
    // screen_leftborderwidth = 32. 40-col: pixels 32..351 (320 wide).
    // 38-col: pixels 39..342 (304 wide).
    display_ystart: 51,
    display_ystop: 251,
    display_xstart_cycle: 17,
    display_xstop_cycle: 56,
    display_xstart_pixel: 32,
    display_xstop_pixel: 352,
    row_24_start_line: 55,
    row_24_stop_line: 247,
    row_25_start_line: 51,
    row_25_stop_line: 251,
    vertical_ff: true,    // start enabled at frame top until display_ystart hit
    horizontal_ff: true,  // start enabled until cycle 17 of first display line
    xsmooth_color: 0,
    raster_mode: "border",
  };
}

/**
 * Spec 289: derive raster_mode from current FF + DEN state. Called
 * after FF transitions in renderer.
 */
export function deriveRasterMode(state: RasterState): RasterMode {
  if (state.vertical_ff || state.horizontal_ff) return "border";
  if (!state.den) return "idle";
  return "display";
}

/**
 * Spec 285: derive xsmooth_color from current video mode + colors.
 * Mirrors VICE vicii-mem.c which sets raster.xsmooth_color whenever
 * mode / bg / mc1 changes. Std/ext text → bg; MC modes → mc1; idle
 * + illegal modes → palette[0] (= black, also matches Spec 284).
 */
export function deriveXsmoothColor(state: RasterState): number {
  const mode = state.video_mode;
  switch (mode) {
    case 0: case 4: return state.background_color;        // std text + ext-bg text
    case 1: case 3: return state.background_color_1;      // mc text + mc bitmap
    case 2: return state.background_color;                // std bitmap
    case 5: case 6: case 7: return 0;                     // illegal modes = black
    default: return state.background_color;
  }
}

// ---------------------------------------------------------------------------
// Mode-derivation helpers (mirror vicii.c update_video_mode).
// video_mode index encoding: bit2=ECM bit1=BMM bit0=MCM (0..7).
// ---------------------------------------------------------------------------

export function deriveVideoMode(d011: number, d016: number): number {
  const ecm = (d011 & 0x40) !== 0;
  const bmm = (d011 & 0x20) !== 0;
  const mcm = (d016 & 0x10) !== 0;
  return (ecm ? 4 : 0) | (bmm ? 2 : 0) | (mcm ? 1 : 0);
}

/** Decode $D018 to screen / chargen / bitmap base offsets within bank. */
export function decodeMemPtr(d018: number): {
  screen: number; chargen: number; bitmap: number;
} {
  const screen = ((d018 >> 4) & 0x0f) * 0x0400;
  const chargen = ((d018 >> 1) & 0x07) * 0x0800;
  const bitmap = ((d018 >> 3) & 0x01) * 0x2000;
  return { screen, chargen, bitmap };
}

// ---------------------------------------------------------------------------
// applyAction — single-step mutation from a queue entry.
// Mirrors vice/src/raster/raster-changes.c raster_changes_apply().
// ---------------------------------------------------------------------------

export function applyAction(state: RasterState, action: RasterChangeAction): void {
  const v = action.value & 0xff;
  // Spec 285: re-derive xsmooth_color after any change that affects it
  // (mode / bg / mc1).
  const updateXsmoothColor = (
    action.field === "video_mode"
    || action.field === "background_color"
    || action.field === "background_color_1"
  );
  switch (action.field) {
    case "video_mode": {
      // Action carries either D011 or D016 raw byte (set by builder).
      // Builder packages two flavors:
      //   value=raw d011 → field still "video_mode" but spriteIndex=undefined,
      //   value=raw d016 → field "video_mode" with synthetic high bit.
      // We use a simple convention: action stores the full reg byte and
      // a one-bit hint via spriteIndex (0 for d011, 1 for d016).
      const isD016 = action.spriteIndex === 1;
      if (isD016) {
        state.xsmooth = v & 0x07;
        state.csel = (v & 0x08) !== 0;
        // Reconstruct video_mode: keep ECM/BMM bits, reapply MCM from v
        const ecm = (state.video_mode & 4) !== 0;
        const bmm = (state.video_mode & 2) !== 0;
        const mcm = (v & 0x10) !== 0;
        state.video_mode = (ecm ? 4 : 0) | (bmm ? 2 : 0) | (mcm ? 1 : 0);
      } else {
        state.ysmooth = v & 0x07;
        state.rsel = (v & 0x08) !== 0;
        state.den = (v & 0x10) !== 0;
        const ecm = (v & 0x40) !== 0;
        const bmm = (v & 0x20) !== 0;
        const mcm = (state.video_mode & 1) !== 0;
        state.video_mode = (ecm ? 4 : 0) | (bmm ? 2 : 0) | (mcm ? 1 : 0);
      }
      break;
    }
    case "screen_base_ptr": {
      // Action value carries raw $D018 byte; decode all three pointers.
      const d018 = v;
      const dec = decodeMemPtr(d018);
      state.screen_base_ptr = dec.screen;
      state.chargen_base_ptr = dec.chargen;
      state.bitmap_base_ptr = dec.bitmap;
      return;
    }
    case "xsmooth": state.xsmooth = v & 0x07; return;
    case "ysmooth": state.ysmooth = v & 0x07; return;
    case "den":     state.den = !!v; return;
    case "rsel":    state.rsel = !!v; return;
    case "csel":    state.csel = !!v; return;
    case "border_color":         state.border_color = v & 0x0f; return;
    case "background_color":     state.background_color = v & 0x0f; break;
    case "background_color_1":   state.background_color_1 = v & 0x0f; break;
    case "background_color_2":   state.background_color_2 = v & 0x0f; return;
    case "background_color_3":   state.background_color_3 = v & 0x0f; return;
    case "sprite_mc_color_1":    state.sprite_mc_color_1 = v & 0x0f; return;
    case "sprite_mc_color_2":    state.sprite_mc_color_2 = v & 0x0f; return;
    case "sprite_color_n":
      if (action.spriteIndex !== undefined)
        state.sprite_color[action.spriteIndex] = v & 0x0f;
      return;
    case "sprite_x_n":
      if (action.spriteIndex !== undefined) {
        const msb = (state.sprite_x_msb >> action.spriteIndex) & 1;
        state.sprite_x[action.spriteIndex] = v | (msb ? 0x100 : 0);
      }
      return;
    case "sprite_y_n":
      if (action.spriteIndex !== undefined)
        state.sprite_y[action.spriteIndex] = v;
      return;
    case "sprite_x_msb":
      state.sprite_x_msb = v;
      // Recompute sprite_x with new MSB bits.
      for (let i = 0; i < 8; i++) {
        const lo = state.sprite_x[i] & 0xff;
        state.sprite_x[i] = lo | (((v >> i) & 1) ? 0x100 : 0);
      }
      return;
    case "sprite_enable":     state.sprite_enable = v; return;
    case "sprite_priority":   state.sprite_priority = v; return;
    case "sprite_multicolor": state.sprite_multicolor = v; return;
    case "sprite_x_expand":   state.sprite_x_expand = v; return;
    case "sprite_y_expand":   state.sprite_y_expand = v; return;
    case "vic_bank":
      state.vic_bank_base = computeVicBankBase(v & 0x03);
      return;
  }
  if (updateXsmoothColor) state.xsmooth_color = deriveXsmoothColor(state);
}

// ---------------------------------------------------------------------------
// Build initial RasterState from a live VIC reg file + CIA2 PA byte.
// Used at frame entry before walking line 0.
// ---------------------------------------------------------------------------

export interface VicLikeForState {
  regs: Uint8Array;
}

export function initStateFromVic(
  vic: VicLikeForState,
  initialCia2PaByte: number,
): RasterState {
  const r = vic.regs;
  const d011 = r[0x11] ?? 0;
  const d016 = r[0x16] ?? 0;
  const d018 = r[0x18] ?? 0;
  const dec = decodeMemPtr(d018);
  const state = createEmptyRasterState();

  state.video_mode = deriveVideoMode(d011, d016);
  state.xsmooth = d016 & 0x07;
  state.ysmooth = d011 & 0x07;
  state.den = (d011 & 0x10) !== 0;
  state.rsel = (d011 & 0x08) !== 0;
  state.csel = (d016 & 0x08) !== 0;
  // Spec 281: derive geometry from initial RSEL/CSEL.
  state.display_ystart = state.rsel ? state.row_25_start_line : state.row_24_start_line;
  state.display_ystop  = state.rsel ? state.row_25_stop_line  : state.row_24_stop_line;
  state.display_xstart_cycle = state.csel ? 17 : 18;
  state.display_xstop_cycle  = state.csel ? 56 : 55;
  state.display_xstart_pixel = state.csel ? 32 : 39;
  state.display_xstop_pixel  = state.csel ? 352 : 343;

  state.screen_base_ptr = dec.screen;
  state.chargen_base_ptr = dec.chargen;
  state.bitmap_base_ptr = dec.bitmap;
  state.vic_bank_base = computeVicBankBase(initialCia2PaByte & 0x03);

  state.border_color = (r[0x20] ?? 0) & 0x0f;
  state.background_color = (r[0x21] ?? 0) & 0x0f;
  state.background_color_1 = (r[0x22] ?? 0) & 0x0f;
  state.background_color_2 = (r[0x23] ?? 0) & 0x0f;
  state.background_color_3 = (r[0x24] ?? 0) & 0x0f;
  state.sprite_mc_color_1 = (r[0x25] ?? 0) & 0x0f;
  state.sprite_mc_color_2 = (r[0x26] ?? 0) & 0x0f;

  // Spec 285: derive xsmooth_color after colors + mode are set.
  state.xsmooth_color = deriveXsmoothColor(state);

  state.sprite_x_msb = r[0x10] ?? 0;
  state.sprite_enable = r[0x15] ?? 0;
  state.sprite_priority = r[0x1b] ?? 0;
  state.sprite_multicolor = r[0x1c] ?? 0;
  state.sprite_x_expand = r[0x1d] ?? 0;
  state.sprite_y_expand = r[0x17] ?? 0;
  for (let i = 0; i < 8; i++) {
    state.sprite_x[i] = (r[i * 2] ?? 0) | (((state.sprite_x_msb >> i) & 1) ? 0x100 : 0);
    state.sprite_y[i] = r[i * 2 + 1] ?? 0;
    state.sprite_color[i] = (r[0x27 + i] ?? 0) & 0x0f;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Spec 281: Border flip-flop transitions.
// Mirrors VICE vicii-mem.c check_lower_upper_border (vertical FF) +
// horizontal FF set/clear conditions (vicii-fetch.c per-cycle).
// ---------------------------------------------------------------------------

/**
 * Apply RSEL flip mid-frame. Updates display_ystart/ystop AND the
 * vertical_ff per VICE check_lower_upper_border semantics.
 */
export function updateRselMidFrame(
  state: RasterState,
  newRsel: boolean,
  line: number,
  cycleInLine: number,
): void {
  if (state.rsel === newRsel) return;
  if (newRsel) {
    // 24 → 25 row mode switch
    state.display_ystart = state.row_25_start_line;
    state.display_ystop  = state.row_25_stop_line;
    if (line === state.row_24_stop_line && cycleInLine > 0) {
      state.vertical_ff = true;
    } else {
      if (!state.vertical_ff && line === state.row_24_start_line && cycleInLine > 0) {
        state.vertical_ff = false;
      }
      if (line === state.display_ystart && cycleInLine > 0 && !state.vertical_ff) {
        state.vertical_ff = false;
      }
    }
  } else {
    // 25 → 24 row mode switch
    state.display_ystart = state.row_24_start_line;
    state.display_ystop  = state.row_24_stop_line;
    if (!state.vertical_ff && line === state.row_25_start_line && cycleInLine > 0) {
      state.vertical_ff = false;  // open-top trick
    } else {
      if (line === state.row_25_stop_line && cycleInLine > 0) {
        state.vertical_ff = true;
      }
    }
  }
  state.rsel = newRsel;
}

/**
 * Apply CSEL flip mid-line. Updates display_xstart/xstop. The actual
 * horizontal FF transition happens at the new boundary in the
 * per-cycle line walk via checkHorizontalFFAtCycle.
 */
export function updateCselMidLine(
  state: RasterState,
  newCsel: boolean,
): void {
  if (state.csel === newCsel) return;
  state.csel = newCsel;
  state.display_xstart_cycle = newCsel ? 17 : 18;
  state.display_xstop_cycle  = newCsel ? 56 : 55;
  state.display_xstart_pixel = newCsel ? 32 : 39;
  state.display_xstop_pixel  = newCsel ? 352 : 343;
}

/**
 * Run at the start of each line BEFORE per-cycle changes. Mirrors
 * VICE vicii.c per-line vertical FF transitions. VICE convention:
 * `display_ystop` is the FIRST line of the bottom border (= one past
 * the last display line). Display range = ystart..ystop-1 inclusive.
 *
 *   - Line == display_ystop: SET FF (entering bottom border)
 *   - Line == display_ystart && DEN: CLEAR FF (entering display)
 *   - Line == display_ystart && !DEN: SET FF (DEN-off)
 */
export function updateVerticalFFAtLineStart(
  state: RasterState,
  line: number,
): void {
  if (line === state.display_ystop) {
    state.vertical_ff = true;
  }
  if (line === state.display_ystart) {
    if (state.den) state.vertical_ff = false;
    else state.vertical_ff = true;
  }
  // Spec 289: re-derive raster_mode after FF transition.
  state.raster_mode = deriveRasterMode(state);
}

/**
 * Per-cycle horizontal FF transition. Mirrors VICE vicii-fetch.c:
 *   - cycle == display_xstop_cycle: SET (entering R border)
 *   - cycle == display_xstart_cycle && !vertical_ff: CLEAR (entering display)
 */
export function updateHorizontalFFAtCycle(
  state: RasterState,
  cycleInLine: number,
): void {
  if (cycleInLine === state.display_xstop_cycle) {
    state.horizontal_ff = true;
  }
  if (cycleInLine === state.display_xstart_cycle && !state.vertical_ff) {
    state.horizontal_ff = false;
  }
}

// ---------------------------------------------------------------------------
/**
 * Field type guard — keeps the action match exhaustive for downstream
 * exhaustive-switch checks.
 */
export function isKnownField(field: string): field is RasterChangeField {
  return [
    "video_mode", "xsmooth", "ysmooth", "den", "rsel", "csel",
    "screen_base_ptr",
    "border_color", "background_color", "background_color_1",
    "background_color_2", "background_color_3",
    "sprite_mc_color_1", "sprite_mc_color_2",
    "sprite_color_n", "sprite_x_n", "sprite_y_n", "sprite_x_msb",
    "sprite_enable", "sprite_priority", "sprite_multicolor",
    "sprite_x_expand", "sprite_y_expand", "vic_bank",
  ].includes(field);
}
