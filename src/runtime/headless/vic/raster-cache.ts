// Spec 290 — VIC-II raster line cache (line memoization).
//
// Mirrors VICE raster-cache.c per-line cache: store rendered output
// by line index, invalidate on register / screen RAM changes, reuse
// on cache hit. ~10× perf gain on static screens (loader screens,
// menus). Per OQ290.2=(b) cache stores 16-color palette indices
// (1 byte/pixel = 504 B/line × 312 lines = ~158 KB total) instead
// of full RGBA (~630 KB) — palette LUT applied on cache replay.

export interface RasterCacheEntry {
  /** Cache key — derived from mode/colors/pointers/sprites. */
  key: number;
  /** True if line content has changed since last cache write. */
  dirty: boolean;
  /** Pre-RGBA palette indices, length = framebuffer width. */
  pixels: Uint8Array;
  /** True if entry holds valid cached data. */
  valid: boolean;
}

export class RasterCache {
  private entries: RasterCacheEntry[];
  private hitCount = 0;
  private missCount = 0;
  private invalidateCount = 0;
  private enabled = false;

  constructor(lineCount: number, lineWidth: number) {
    this.entries = new Array(lineCount);
    for (let i = 0; i < lineCount; i++) {
      this.entries[i] = {
        key: 0, dirty: true, valid: false,
        pixels: new Uint8Array(lineWidth),
      };
    }
  }

  enable(on: boolean): void { this.enabled = on; }
  isEnabled(): boolean { return this.enabled; }

  /** Lookup cache entry for `line`. Returns null on miss / disabled. */
  lookup(line: number, key: number): RasterCacheEntry | null {
    if (!this.enabled) { this.missCount++; return null; }
    const e = this.entries[line];
    if (!e || !e.valid || e.dirty || e.key !== key) {
      this.missCount++;
      return null;
    }
    this.hitCount++;
    return e;
  }

  /** Store rendered pixels for `line`. */
  store(line: number, key: number, pixels: Uint8Array): void {
    if (!this.enabled) return;
    const e = this.entries[line];
    if (!e) return;
    e.key = key;
    e.dirty = false;
    e.valid = true;
    if (pixels.length === e.pixels.length) {
      e.pixels.set(pixels);
    }
  }

  /** Mark a line dirty (= invalidate). Called on register/RAM write. */
  invalidate(line: number): void {
    const e = this.entries[line];
    if (e && !e.dirty) {
      e.dirty = true;
      this.invalidateCount++;
    }
  }

  /** Mark all lines dirty (= full frame invalidation). */
  invalidateAll(): void {
    for (const e of this.entries) {
      if (!e.dirty) { e.dirty = true; this.invalidateCount++; }
    }
  }

  stats(): { hits: number; misses: number; invalidations: number } {
    return { hits: this.hitCount, misses: this.missCount, invalidations: this.invalidateCount };
  }

  resetStats(): void { this.hitCount = this.missCount = this.invalidateCount = 0; }
}

/**
 * Compute cache key from RasterState fields that affect line output.
 * Per OQ290.1=(a): per-line cache scope. Key = packed bits of:
 *   video_mode (3) + xsmooth (3) + ysmooth (3) + screen_base (4)
 *   + chargen_base (3) + bitmap_base (1) + bg_color (4)
 *   + border_color (4) + sprite_enable (8) + raster_mode (2)
 */
export function computeLineKey(state: {
  video_mode: number;
  xsmooth: number;
  ysmooth: number;
  screen_base_ptr: number;
  chargen_base_ptr: number;
  bitmap_base_ptr: number;
  background_color: number;
  border_color: number;
  sprite_enable: number;
  raster_mode: string;
}): number {
  const modeBits = { border: 0, display: 1, idle: 2 }[state.raster_mode] ?? 0;
  // Use BigInt-style bit-packing in 32-bit space (~33 bits packed,
  // overflow lower bits OK for cache fingerprint).
  return (
    (state.video_mode & 7)
    | ((state.xsmooth & 7) << 3)
    | ((state.ysmooth & 7) << 6)
    | (((state.screen_base_ptr >> 10) & 0xf) << 9)
    | (((state.chargen_base_ptr >> 11) & 7) << 13)
    | (((state.bitmap_base_ptr >> 13) & 1) << 16)
    | ((state.background_color & 0xf) << 17)
    | ((state.border_color & 0xf) << 21)
    | ((state.sprite_enable & 0xff) << 25)
    | (modeBits << 30)
  ) >>> 0;
}
