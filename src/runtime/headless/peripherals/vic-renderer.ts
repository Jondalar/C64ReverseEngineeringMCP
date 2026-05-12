// Spec 404 Phase D — legacy snapshot-renderer code REMOVED.
//
// This file used to host the per-char-row / per-pixel snapshot
// renderer paths (renderFrame, renderStandardTextRow, multi-color +
// bitmap mode row helpers, snapshot-based sprite renderer). All of
// those paths were superseded by the 1:1 VICE x64sc literal-port
// renderer (`src/runtime/headless/vic/literal/*.ts`) which paints
// directly into IntegratedSession.literalPortFb via the per-cycle
// vicii_cycle() / vicii_draw_cycle() pipeline.
//
// Per spec 404 + refinement Q11 ("Specs flag TS extras for DELETE"),
// the legacy snapshot paths are removed; the file now contains only:
//
//   - VicFramebuffer (= shared 504×312 RGBA buffer + palette setter;
//     still used by IntegratedSession.framebuffer for video.ts
//     export pipeline and the literal-port → RGBA blit in
//     renderFrame/renderLiteralPortToPng).
//   - computeVicBankBase (= CIA2 PA bits → VIC bank base; used by
//     smoke-mm-boot-to-title.mjs).
//   - Constants (FB_WIDTH_PAL/NTSC, FB_HEIGHT_PAL/NTSC, VISIBLE_X/Y/W/H).
//   - Palette re-exports.
//
// Doc anchor: docs/vice-c64-arch.md §5.9 ("Draw — vicii-draw-cycle.c")
// is the authoritative source; legacy renderer was not in VICE.

export const FB_WIDTH_PAL = 504;
export const FB_HEIGHT_PAL = 312;
export const FB_WIDTH_NTSC = 504;
export const FB_HEIGHT_NTSC = 263;

// Visible 320×200 area inset within border.
// Spec 281: aligned with VICE 40-col display window. Display starts
// at pixel 32 (= screen_leftborderwidth).
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

// Compute current VIC bank base from CIA2 PA bits 0-1.
// CIA2 PA bits 0-1 are output bits selecting the VIC bank (inverted):
//   00 = bank 3 ($C000-$FFFF)
//   01 = bank 2 ($8000-$BFFF)
//   10 = bank 1 ($4000-$7FFF)
//   11 = bank 0 ($0000-$3FFF) — default after reset
//
// Doc: docs/vice-c64-arch.md §4.5 "VIC-II banking via CIA2 PA bits 0-1".
// VICE: src/c64/c64cia2.c set_int_ciapa.
export function computeVicBankBase(cia2PaBits01: number): number {
  const bank = 3 - (cia2PaBits01 & 0x03);
  return bank * 0x4000;
}
