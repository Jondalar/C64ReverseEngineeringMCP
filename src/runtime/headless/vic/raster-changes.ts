// Spec 280a + 280b — VICE-faithful raster_changes lane infrastructure.
//
// Mirrors vice/src/raster/raster-changes.h API:
//   - 5 lanes: background, foreground, border, sprites, next_line
//   - per-action: { where (pixel-x or char-x), reg, value, field }
//   - cycle→pixel mapping per VICE VICII_RASTER_X macro
//
// Per-line driver consumes lanes in `where` order (mirrors VICE's
// handle_visible_line_with_changes pattern).

// ---------------------------------------------------------------------------
// PAL screen geometry (VICII_SCREEN_PAL_NORMAL_LEFTBORDERWIDTH = $20).
// Total pixels per scanline = 504 (= 63 cycles × 8).
// ---------------------------------------------------------------------------

export const PAL_CYCLES_PER_LINE = 63;
export const PAL_PIXELS_PER_LINE = 504;
export const PAL_LEFT_BORDER_WIDTH = 32;          // pixels 0..31
export const PAL_DISPLAY_WIDTH = 320;             // pixels 32..351 (40 col)
export const PAL_DISPLAY_END_PIXEL = PAL_LEFT_BORDER_WIDTH + PAL_DISPLAY_WIDTH; // 352
export const PAL_TEXT_COLUMNS = 40;
export const PAL_FETCH_CYCLE = 11;                // VICII_FETCH_CYCLE — start of badline DMA

// VICE VICII_RASTER_X(cycle) = (cycle - 17) * 8 + screen_leftborderwidth
// For PAL normal left border = 32, this maps cycle 17 → pixel 32.
export function cycleToPixelX(cycleInLine: number): number {
  return (cycleInLine - 17) * 8 + PAL_LEFT_BORDER_WIDTH;
}

// VICE VICII_RASTER_CHAR(cycle) = cycle - 15
// Char position 0..39 within text-mode display.
export function cycleToCharX(cycleInLine: number): number {
  return cycleInLine - 15;
}

// ---------------------------------------------------------------------------
// Lane action shape.
// ---------------------------------------------------------------------------

/**
 * Field that the change targets. Renderer dispatches on this to know
 * which renderer-state to update before drawing the next pixel
 * segment. Mirrors VICE's `int *ptr` indirection without the C
 * pointer trick.
 */
export type RasterChangeField =
  | "video_mode"          // d011 BMM/ECM + d016 MCM combined → mode index
  | "xsmooth"             // d016 low 3 bits
  | "ysmooth"             // d011 low 3 bits
  | "den"                 // d011 bit 4
  | "rsel"                // d011 bit 3 (24/25 row)
  | "csel"                // d016 bit 3 (38/40 col)
  | "screen_base_ptr"     // d018 high nibble × $400
  | "chargen_base_ptr"    // d018 mid bits × $800 (text) OR bit 3 × $2000 (bitmap)
  | "border_color"        // d020
  | "background_color"    // d021
  | "background_color_1"  // d022
  | "background_color_2"  // d023
  | "background_color_3"  // d024 (ECM only)
  | "sprite_mc_color_1"   // d025
  | "sprite_mc_color_2"   // d026
  | "sprite_color_n"      // d027-d02e (per sprite)
  | "sprite_x_n"          // d000/d002/d004/d006/d008/d00a/d00c/d00e
  | "sprite_y_n"          // d001/d003/d005/d007/d009/d00b/d00d/d00f
  | "sprite_x_msb"        // d010
  | "sprite_enable"       // d015
  | "sprite_priority"     // d01b
  | "sprite_multicolor"   // d01c
  | "sprite_x_expand"     // d01d
  | "sprite_y_expand"     // d017
  | "vic_bank";           // CIA2 PA bits 0-1 (special, lane=next_line)

export interface RasterChangeAction {
  /** Pixel x (background/border/sprites) or char x (foreground), in [0, 504] / [0, 40]. */
  where: number;
  field: RasterChangeField;
  /** Sprite index for sprite_*_n fields, otherwise undefined. */
  spriteIndex?: number;
  /** New value to apply. Color = 0..15, ptr = bank-relative offset, etc. */
  value: number;
}

// ---------------------------------------------------------------------------
// Per-line lane container.
// ---------------------------------------------------------------------------

export interface RasterChangesPerLine {
  background: RasterChangeAction[];
  foreground: RasterChangeAction[];
  border: RasterChangeAction[];
  sprites: RasterChangeAction[];
  /** Applied at start of next line (= deferred from late writes). */
  nextLine: RasterChangeAction[];
  /** Fast-path skip when no changes on this line. */
  haveOnThisLine: boolean;
}

export function emptyLaneSet(): RasterChangesPerLine {
  return {
    background: [], foreground: [], border: [],
    sprites: [], nextLine: [],
    haveOnThisLine: false,
  };
}

/** Reset per-line lanes (used at start of each new line). */
export function clearLane(lane: RasterChangesPerLine): void {
  lane.background.length = 0;
  lane.foreground.length = 0;
  lane.border.length = 0;
  lane.sprites.length = 0;
  // nextLine NOT cleared — caller harvests + applies before clearing.
  lane.haveOnThisLine = false;
}

// ---------------------------------------------------------------------------
// Inline-style adders mirroring VICE raster_changes_*_add_int.
//
// Pattern: classify by current cycle:
//   - cycle ≤ 0 or before display → apply immediately (return "immediate")
//   - cycle within display → enqueue at where=cycleToPixelX(cycle)
//   - cycle past display → defer to next_line lane
// ---------------------------------------------------------------------------

export type AddResult = "immediate" | "queued" | "next_line";

export function addBackgroundChange(
  lane: RasterChangesPerLine,
  cycleInLine: number,
  field: RasterChangeField,
  value: number,
): AddResult {
  const where = cycleToPixelX(cycleInLine);
  if (where <= 0) return "immediate";
  if (where >= PAL_PIXELS_PER_LINE) {
    lane.nextLine.push({ where: 0, field, value });
    return "next_line";
  }
  lane.background.push({ where, field, value });
  lane.haveOnThisLine = true;
  return "queued";
}

export function addForegroundChange(
  lane: RasterChangesPerLine,
  cycleInLine: number,
  field: RasterChangeField,
  value: number,
): AddResult {
  const charX = cycleToCharX(cycleInLine);
  if (charX <= 0) return "immediate";
  if (charX >= PAL_TEXT_COLUMNS) {
    lane.nextLine.push({ where: 0, field, value });
    return "next_line";
  }
  lane.foreground.push({ where: charX, field, value });
  lane.haveOnThisLine = true;
  return "queued";
}

export function addBorderChange(
  lane: RasterChangesPerLine,
  cycleInLine: number,
  field: RasterChangeField,
  value: number,
): AddResult {
  const where = cycleToPixelX(cycleInLine);
  if (where <= 0) return "immediate";
  if (where >= PAL_PIXELS_PER_LINE) {
    lane.nextLine.push({ where: 0, field, value });
    return "next_line";
  }
  lane.border.push({ where, field, value });
  lane.haveOnThisLine = true;
  return "queued";
}

export function addSpriteChange(
  lane: RasterChangesPerLine,
  cycleInLine: number,
  field: RasterChangeField,
  value: number,
  spriteIndex?: number,
): AddResult {
  const where = cycleToPixelX(cycleInLine);
  if (where <= 0) return "immediate";
  if (where >= PAL_PIXELS_PER_LINE) {
    lane.nextLine.push({ where: 0, field, value, spriteIndex });
    return "next_line";
  }
  lane.sprites.push({ where, field, value, spriteIndex });
  lane.haveOnThisLine = true;
  return "queued";
}

export function addNextLineChange(
  lane: RasterChangesPerLine,
  field: RasterChangeField,
  value: number,
  spriteIndex?: number,
): void {
  lane.nextLine.push({ where: 0, field, value, spriteIndex });
}

// ---------------------------------------------------------------------------
// Sort lane queues by `where` ascending — required before render walk.
// VICE keeps queues sorted on insert; we sort on flush for simplicity.
// ---------------------------------------------------------------------------

export function sortLaneByWhere(actions: RasterChangeAction[]): void {
  actions.sort((a, b) => a.where - b.where);
}

// ---------------------------------------------------------------------------
// Reg → field/lane classification (Spec 280a, mirrors vicii-mem.c).
//
// Each VIC reg ($D000-$D02E) gets its lane + field from this table.
// Cycle classification (immediate vs queued vs next_line) handled at
// add-time by the lane-specific adder.
// ---------------------------------------------------------------------------

export interface RegMapping {
  lane: "background" | "foreground" | "border" | "sprites" | "next_line";
  field: RasterChangeField;
  spriteIndex?: number;
}

export const REG_MAPPING: Record<number, RegMapping | undefined> = {
  // Sprite x positions (lsb)
  0x00: { lane: "sprites", field: "sprite_x_n", spriteIndex: 0 },
  0x02: { lane: "sprites", field: "sprite_x_n", spriteIndex: 1 },
  0x04: { lane: "sprites", field: "sprite_x_n", spriteIndex: 2 },
  0x06: { lane: "sprites", field: "sprite_x_n", spriteIndex: 3 },
  0x08: { lane: "sprites", field: "sprite_x_n", spriteIndex: 4 },
  0x0a: { lane: "sprites", field: "sprite_x_n", spriteIndex: 5 },
  0x0c: { lane: "sprites", field: "sprite_x_n", spriteIndex: 6 },
  0x0e: { lane: "sprites", field: "sprite_x_n", spriteIndex: 7 },
  // Sprite y positions
  0x01: { lane: "sprites", field: "sprite_y_n", spriteIndex: 0 },
  0x03: { lane: "sprites", field: "sprite_y_n", spriteIndex: 1 },
  0x05: { lane: "sprites", field: "sprite_y_n", spriteIndex: 2 },
  0x07: { lane: "sprites", field: "sprite_y_n", spriteIndex: 3 },
  0x09: { lane: "sprites", field: "sprite_y_n", spriteIndex: 4 },
  0x0b: { lane: "sprites", field: "sprite_y_n", spriteIndex: 5 },
  0x0d: { lane: "sprites", field: "sprite_y_n", spriteIndex: 6 },
  0x0f: { lane: "sprites", field: "sprite_y_n", spriteIndex: 7 },
  // d010 sprite x MSB
  0x10: { lane: "sprites", field: "sprite_x_msb" },
  // d011 control reg 1 — DEN/RSEL/ECM/BMM/ysmooth + raster compare bit 8
  // mostly NEXT-LINE because mode change affects fetch in next line
  0x11: { lane: "next_line", field: "video_mode" },
  // d012 raster — IRQ comparator only, no render effect
  // d013/d014 lightpen — no render
  // d015 sprite enable
  0x15: { lane: "sprites", field: "sprite_enable" },
  // d016 control reg 2 — MCM/CSEL/xsmooth (CSEL & xsmooth NEXT-LINE per VICE)
  0x16: { lane: "next_line", field: "video_mode" },
  // d017 sprite y expand
  0x17: { lane: "sprites", field: "sprite_y_expand" },
  // d018 memory pointers — NEXT-LINE (= bad-line fetch reads d018 next)
  0x18: { lane: "next_line", field: "screen_base_ptr" },
  // d019/d01a IRQ status/mask — no render
  // d01b sprite priority
  0x1b: { lane: "sprites", field: "sprite_priority" },
  // d01c sprite multicolor
  0x1c: { lane: "sprites", field: "sprite_multicolor" },
  // d01d sprite x expand
  0x1d: { lane: "sprites", field: "sprite_x_expand" },
  // d01e/d01f collision regs — read-only for render purposes
  // d020 border color
  0x20: { lane: "border", field: "border_color" },
  // d021 background color
  0x21: { lane: "background", field: "background_color" },
  // d022/d023/d024 background colors 1/2/3 (mc text + ext bg)
  0x22: { lane: "background", field: "background_color_1" },
  0x23: { lane: "background", field: "background_color_2" },
  0x24: { lane: "background", field: "background_color_3" },
  // d025/d026 sprite multicolor common colors
  0x25: { lane: "sprites", field: "sprite_mc_color_1" },
  0x26: { lane: "sprites", field: "sprite_mc_color_2" },
  // d027-d02e sprite individual colors
  0x27: { lane: "sprites", field: "sprite_color_n", spriteIndex: 0 },
  0x28: { lane: "sprites", field: "sprite_color_n", spriteIndex: 1 },
  0x29: { lane: "sprites", field: "sprite_color_n", spriteIndex: 2 },
  0x2a: { lane: "sprites", field: "sprite_color_n", spriteIndex: 3 },
  0x2b: { lane: "sprites", field: "sprite_color_n", spriteIndex: 4 },
  0x2c: { lane: "sprites", field: "sprite_color_n", spriteIndex: 5 },
  0x2d: { lane: "sprites", field: "sprite_color_n", spriteIndex: 6 },
  0x2e: { lane: "sprites", field: "sprite_color_n", spriteIndex: 7 },
};

/**
 * Special non-VIC change: CIA2 PA bank switch. Lane = next_line per
 * VICE behavior (= bank takes effect at next bad-line fetch).
 */
export const CIA2_PA_BANK_FIELD: RasterChangeField = "vic_bank";

// ---------------------------------------------------------------------------
// Frame container.
// ---------------------------------------------------------------------------

export interface FrameRasterChanges {
  /** Per-line (0..311 PAL) lane sets. */
  perLine: RasterChangesPerLine[];
  /** Carries to next frame's line 0 (= VICE nextLine queue at frame wrap). */
  carryToNextFrame: RasterChangeAction[];
}

export function newFrameRasterChanges(lineCount: number = 312): FrameRasterChanges {
  return {
    perLine: Array.from({ length: lineCount }, () => emptyLaneSet()),
    carryToNextFrame: [],
  };
}
