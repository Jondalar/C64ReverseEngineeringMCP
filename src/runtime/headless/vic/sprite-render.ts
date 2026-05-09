// Spec 280d — per-line sprite render with multiplexing.
//
// Mirrors vicii-sprites.c draw_hires_sprite_normal + draw_mc_sprite
// mechanics stripped to the essentials:
//
//   - Sprite data pointer: screen RAM + $3F8 + sp → ptr*64 = data base.
//   - Hi-res: 3 bytes × 21 rows = 24 effective pixel columns.
//   - Multicolor: 2-bit pairs → 4 pixel-wide blocks per byte (2 per bit-pair).
//   - X-expand: each column doubled (hires → 48px wide, mc → each block ×2).
//   - Y-expand: srcRow = Math.floor(dy/2); sprite is 42 visible rows.
//   - Priority ($D01B): bit set → sprite behind chars (fg pixels win).
//   - Sprite-bg collision ($D01F): sprite pixel overlaps fg pixel → set bit.
//   - Sprite-sprite collision ($D01E): two sprite pixels overlap → set both bits.
//
// Sprite screen-coordinate system:
//   Hardware sprite_y==50 corresponds to visible top row (VISIBLE_Y=51 ≈ 50
//   in VICE sprite coords). X: sprite_x==24 → first visible column.
//   Both are hardware register values (9-bit x, 8-bit y).
//
// Multiplexing: caller passes RasterState which already has mid-frame IRQ
// changes applied (via the sprites lane walk in 280c). So this function
// simply checks, for each enabled sprite, whether it overlaps the current
// raster line. When a game sets new sprite Y positions at a mid-frame IRQ,
// the sprite lane carries those writes and the renderer sees them correctly
// before this function is called.
//
// References:
//   vice/src/vicii/vicii-sprites.c   draw_hires_sprite_normal,
//                                     draw_hires_sprite_expanded,
//                                     draw_mc_sprite_normal,
//                                     draw_all_sprites
//   vice/src/raster/raster-sprite.c  generic sprite line counter logic

import type { HeadlessMemoryBus } from "../memory-bus.js";
import type { RasterState } from "./raster-state.js";
import {
  VISIBLE_H,
  VISIBLE_W,
  VISIBLE_X,
  VISIBLE_Y,
} from "../peripherals/vic-renderer.js";

// ---------------------------------------------------------------------------
// Sprite coordinate constants (mirror vicii-sprites.c / vic-renderer.ts).
//
//   VICE convention: sprite_y=50 → first raster line of visible area.
//   Our VISIBLE_Y=51, but the hardware sprite system uses 50 as its "top".
//   To compute which line a sprite row maps to: line = sy - 50 + rasterRow.
//   Conversely: dy = (line - sy + 50).
//
//   sprite_x=24 → first visible pixel column (VISIBLE_X=24). So
//   xIn (0-based within visible area) = sprite_x - 24.
// ---------------------------------------------------------------------------

const SPRITE_Y_OFFSET = 50;  // sprite_y value for first visible raster line
const SPRITE_X_OFFSET = 24;  // sprite_x value for first visible column (VISIBLE_X)

// ---------------------------------------------------------------------------
// Return type — per-line collision accumulation.
// ---------------------------------------------------------------------------

export interface SpriteCollisionResult {
  /** Bits set = sprite had a pixel overlapping background fg → $D01F. */
  spriteBgCollision: number;
  /** Bits set = sprite had a pixel overlapping another sprite → $D01E. */
  spriteSpCollision: number;
}

// ---------------------------------------------------------------------------
// VIC bank memory read (mirrors vicRead in vic-renderer-rasterized.ts).
// Char ROM shadow at $1000-$1FFF in VIC banks 0 and 2.
// ---------------------------------------------------------------------------

function vicRead(bus: HeadlessMemoryBus, bankBase: number, addr: number): number {
  const masked = addr & 0x3fff;
  const charBank = (bankBase === 0x0000) || (bankBase === 0x8000);
  if (charBank && masked >= 0x1000 && masked < 0x2000) {
    return bus.charRom[masked - 0x1000]!;
  }
  return bus.ram[(bankBase + masked) & 0xffff]!;
}

// ---------------------------------------------------------------------------
// renderSpritesPerLine — the 280d entry point.
//
// Called after the graphics pass for each visible line. Reads sprite
// registers from `rasterState` (already updated from the sprites lane
// walk for this line). Draws each enabled sprite that overlaps `line`.
// Returns collision flags to be OR'd into $D01E / $D01F.
//
// Parameters:
//   rasterState  — effective chip state at this point in the line walk.
//   line         — absolute raster line (0..311 PAL).
//   fb           — framebuffer (write pixels via fb array directly for speed).
//   fbWidth      — framebuffer pitch (pixels per row).
//   fgMask       — VISIBLE_W × VISIBLE_H byte array; non-zero = fg pixel.
//                  Indexed as fgMask[yIn * VISIBLE_W + xIn].
//   pixels       — RGBA framebuffer pixel array (fb.pixels).
// ---------------------------------------------------------------------------

export function renderSpritesPerLine(
  rasterState: RasterState,
  line: number,
  pixels: Uint8Array | Uint8ClampedArray,
  fbWidth: number,
  fgMask: Uint8Array,
  bus: HeadlessMemoryBus,
  palette: ReadonlyArray<readonly [number, number, number]>,
): SpriteCollisionResult {
  const result: SpriteCollisionResult = { spriteBgCollision: 0, spriteSpCollision: 0 };

  if (rasterState.sprite_enable === 0) return result;

  // yIn = scanline index relative to visible area top (for fgMask indexing).
  const yIn = line - VISIBLE_Y;
  if (yIn < 0 || yIn >= VISIBLE_H) return result;

  // Per-pixel sprite occupancy mask for sprite-sprite collision.
  // spritePxMask[xIn] = bitmask of which sprites have drawn here this line.
  const spritePxMask = new Uint8Array(VISIBLE_W);

  const screenOff = rasterState.screen_base_ptr;

  for (let sp = 0; sp < 8; sp++) {
    if ((rasterState.sprite_enable & (1 << sp)) === 0) continue;
    const sbit = 1 << sp;

    const sy = rasterState.sprite_y[sp]!;
    const expandY = (rasterState.sprite_y_expand & sbit) !== 0;
    const heightPx = expandY ? 42 : 21;

    // dy = how many rows into this sprite we are at `line`.
    // sprite_y register = raster line where sprite row 0 appears.
    // (VICE: sprite_y=50 → first visible line; we just use line - sy directly.)
    const dy = line - sy;
    if (dy < 0 || dy >= heightPx) continue;

    // srcRow = which of the 21 sprite data rows we sample from.
    const srcRow = expandY ? Math.floor(dy / 2) : dy;

    const expandX = (rasterState.sprite_x_expand & sbit) !== 0;
    const isMc = (rasterState.sprite_multicolor & sbit) !== 0;
    const isPriorityBehind = (rasterState.sprite_priority & sbit) !== 0;
    const color = rasterState.sprite_color[sp]!;
    const mc1 = rasterState.sprite_mc_color_1;
    const mc2 = rasterState.sprite_mc_color_2;

    // Fetch sprite data pointer from screen RAM + $3F8 offset.
    const ptrByte = vicRead(bus, rasterState.vic_bank_base, screenOff + 0x3f8 + sp);
    const dataBase = ptrByte * 64;

    // Sprite x in screen-visible coordinates.
    const sx = rasterState.sprite_x[sp]! - SPRITE_X_OFFSET;

    for (let byteIdx = 0; byteIdx < 3; byteIdx++) {
      const byte = vicRead(bus, rasterState.vic_bank_base, dataBase + srcRow * 3 + byteIdx);
      if (byte === 0) continue;

      if (!isMc) {
        // Hi-res: 1 bit per pixel, 8 pixels per byte.
        for (let bit = 0; bit < 8; bit++) {
          if (((byte >> (7 - bit)) & 1) === 0) continue;

          const colBase = byteIdx * 8 + bit;
          const pixWidth = expandX ? 2 : 1;

          for (let pw = 0; pw < pixWidth; pw++) {
            const xIn = sx + colBase * pixWidth + pw;
            if (xIn < 0 || xIn >= VISIBLE_W) continue;

            const maskOff = yIn * VISIBLE_W + xIn;

            // Sprite-bg collision check.
            if (fgMask[maskOff]) {
              result.spriteBgCollision |= sbit;
            }
            // Sprite-sprite collision check.
            const prevSprites = spritePxMask[xIn]!;
            if (prevSprites !== 0) {
              result.spriteSpCollision |= sbit | prevSprites;
            }
            spritePxMask[xIn] = prevSprites | sbit;

            // Draw pixel (unless behind fg chars).
            if (isPriorityBehind && fgMask[maskOff]) continue;

            const absX = VISIBLE_X + xIn;
            const absY = line;
            const fbOff = (absY * fbWidth + absX) * 4;
            const [r, g, b] = palette[color]!;
            pixels[fbOff] = r;
            pixels[fbOff + 1] = g;
            pixels[fbOff + 2] = b;
            pixels[fbOff + 3] = 0xff;
          }
        }
      } else {
        // Multicolor: 2-bit pairs — 4 pairs per byte.
        // Each pair = 2 pixels wide normally, 4 pixels wide when X-expanded.
        for (let pair = 0; pair < 4; pair++) {
          const bits = (byte >> ((3 - pair) * 2)) & 0x03;
          if (bits === 0) continue; // transparent

          let pxColor: number;
          if (bits === 1) pxColor = mc1;
          else if (bits === 2) pxColor = color;
          else pxColor = mc2;

          const pairPxW = expandX ? 4 : 2;
          const colBase = byteIdx * 8 + pair * 2;

          for (let pw = 0; pw < pairPxW; pw++) {
            const xIn = sx + colBase + pw;
            if (xIn < 0 || xIn >= VISIBLE_W) continue;

            const maskOff = yIn * VISIBLE_W + xIn;

            if (fgMask[maskOff]) {
              result.spriteBgCollision |= sbit;
            }
            const prevSprites = spritePxMask[xIn]!;
            if (prevSprites !== 0) {
              result.spriteSpCollision |= sbit | prevSprites;
            }
            spritePxMask[xIn] = prevSprites | sbit;

            if (isPriorityBehind && fgMask[maskOff]) continue;

            const absX = VISIBLE_X + xIn;
            const absY = line;
            const fbOff = (absY * fbWidth + absX) * 4;
            const [r, g, b] = palette[pxColor]!;
            pixels[fbOff] = r;
            pixels[fbOff + 1] = g;
            pixels[fbOff + 2] = b;
            pixels[fbOff + 3] = 0xff;
          }
        }
      }
    }
  }

  return result;
}
