// Spec 297i — VIC per-pixel composite: gfx + sprite + priority + collision.
//
// Pulls together:
//   - 297c-g emitPixel (gfx via display pipe, mode dispatch)
//   - 297h sprite engines (per-pixel sprite color | null transparent)
//   - 296c sprite collision latches (sprite-bg + sprite-spr ORed per pixel)
//
// Per VICE viciisc/vicii-draw-cycle.c:342-430 + draw_graphics8 priority
// resolution:
//
//   1. gfx_pixel = emitPixel(mode, pipe, ...) — bg gfx pixel color
//   2. fg_flag = is this gfx pixel "foreground" (= drawn from gbuf bit
//      with priority over sprite when priorityOverBg set)?
//   3. sprite_mask = OR of sprite indices opaque at this pixel
//   4. composite:
//      - For each sprite (low → high index = priority):
//        - sprite color = engine pixel
//        - if priorityOverBg AND fg_flag: bg fg wins → sprite hidden
//        - else: sprite wins → use sprite color
//      - First non-hidden sprite color wins
//      - If no sprite wins, gfx pixel stays
//   5. collision update (296c):
//      - if mask != 0 AND fg_flag: sprite-bg latch ORed
//      - if popcount(mask) >= 2: sprite-sprite latch ORed
//      - IRQ edge raised on 0 → non-0 transition

import type { DisplayPipeState } from "./display-pipe.js";
import type { SpriteEngine } from "./sprite-cycle.js";
import { spriteMaskAt } from "./sprite-cycle.js";
import { emitPixel } from "./cycle-pumped-renderer.js";
import {
  pixelCollisionUpdate, type SpriteCollisionState,
} from "./sprite-collision-latch.js";
import type { VicFramebuffer } from "../peripherals/vic-renderer.js";

/**
 * Compute "is this gfx pixel foreground" per VICE convention.
 *
 * For text modes: fg = bit set in gbuf (= cbuf color drawn).
 * For mc modes: fg = top 2 bits of gbuf == 11 OR == 10 (= "fg" pairs).
 * For bitmap mode: fg = bit set.
 *
 * Mirrors vicii-draw-cycle.c "fg" determination via mc_flop +
 * gbuf MSB.
 */
export function isGfxForeground(pipe: DisplayPipeState, mode: number): boolean {
  switch (mode) {
    case 0:    // std text — bit=1 → fg
    case 2:    // std bmp — bit=1 → fg
    case 4: {  // ECM text — bit=1 → fg
      return ((pipe.gbuf.reg >> 7) & 1) !== 0;
    }
    case 1: {  // mc text — fg if NOT mc OR pair top bit set
      const isMc = (pipe.cbuf.reg & 0x08) !== 0;
      if (!isMc) return ((pipe.gbuf.reg >> 7) & 1) !== 0;
      // mc: pair = top 2 bits; fg if top bit of pair set (= pair >= 2)
      return ((pipe.gbuf.reg >> 7) & 1) !== 0;
    }
    case 3: {  // mc bmp — fg if pair top bit set
      return ((pipe.gbuf.reg >> 7) & 1) !== 0;
    }
    default:   // illegal modes 5/6/7 — no foreground concept
      return false;
  }
}

/**
 * Composite one pixel: gfx + sprite + priority + collision.
 * Writes the resulting color into framebuffer.
 *
 * Caller has already shifted gbuf for this pixel (= done by emitPixel
 * via shiftGbufOnePixel after each emit). For composite, we re-derive
 * fg_flag from the SAME pipe state used by emitPixel (= MSB before
 * shift). So caller pattern:
 *
 *   compositePixel(...);   // composes the pixel using current pipe.reg
 *   shiftGbufOnePixel();   // advance pipe for next pixel
 */
export function compositePixel(
  fb: VicFramebuffer, x: number, y: number,
  pipe: DisplayPipeState, mode: number,
  d021: number, d022: number, d023: number, d024: number,
  d025: number, d026: number,
  sprites: SpriteEngine[],
  collisionLatch: SpriteCollisionState,
): { irqEdge: number } {
  // Step 1: emit gfx pixel into framebuffer
  emitPixel(fb, x, y, pipe, mode, d021, d022, d023, d024);

  // Step 2: derive fg_flag for sprite priority + collision
  const fg = isGfxForeground(pipe, mode);

  // Step 3: sprite mask + per-sprite pixel
  const { mask, pixelByIndex } = spriteMaskAt(sprites, x, d025, d026);

  // Step 4: composite — first sprite with non-hidden pixel wins
  if (mask !== 0) {
    for (let i = 0; i < 8; i++) {
      const sc = pixelByIndex[i]!;
      if (sc === null) continue;
      const eng = sprites[i]!;
      // Hidden when sprite priorityOverBg=1 AND fg_flag=1 (= bg fg wins)
      if (eng.priorityOverBg && fg) continue;
      // Sprite wins this pixel
      const [rr, gg, bb] = fb.palette[sc & 0x0f]!;
      const off = (y * fb.width + x) * 4;
      fb.pixels[off] = rr;
      fb.pixels[off + 1] = gg;
      fb.pixels[off + 2] = bb;
      fb.pixels[off + 3] = 0xff;
      break;
    }
  }

  // Step 5: collision latches + IRQ edge
  const irqEdge = pixelCollisionUpdate(collisionLatch, mask, fg ? 1 : 0);
  return { irqEdge };
}
