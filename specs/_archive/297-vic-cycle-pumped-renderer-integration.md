# Spec 297 — VIC cycle-pumped pixel emission integration

**Sprint:** 146  **Status:** OPEN 2026-05-09  **Depends:** 296a-1..4, 296b, 296c, 296d

## Goal

Wire 296a-d backbone into the live render path. Today VicIIVice
runs per-cycle CIA-style state but pixel emission is delegated to
`vic-renderer-rasterized.ts`, which replays per-line snapshots
after the fact. This snapshot model **structurally cannot**
reproduce intra-line state changes that motm / IM2 / Scramble
Infinity rely on (mid-line $D016 xsmooth, $D018 split, ECM
mode flips between ship/menu/HUD bands, sprite priority changes
per cycle).

Spec 297 does what VICE does: every VIC cycle emits 8 pixels
directly into the framebuffer, sourced from the display pipe
state, with raster_changes lanes applied at exact cycle.phase.

This is the spec that actually fixes the visible bugs from 296
(SI-1..5, motm gameplay, IM2 splits).

## VICE source mapping

  - `vicii-cycle.c` — main per-cycle pump; calls draw_cycle() unconditionally
  - `vicii-draw-cycle.c` — pixel-emit per mode (standard/mc text, bmp, ext bg, illegal)
  - `vicii-sprites.c` — sprite multiplexer cycle-by-cycle
  - `vicii-draw-cycle.c:342-430` — collision pixel-time latch (= 296c spec)
  - `vicii-draw.c` — per-mode bg + fg pass primitives (= 295 spec)

## Architecture shift

Current:

```
runFor(cycles) → schedule.tick()
                 → cpu instr + vic.tickCycle() (counts cycles, snapshots regs)
                 → at frame end: renderToPng() → renderFrameRasterized()
                                                  walks per-line lanes
                                                  emits 504 px per line
```

After 297:

```
runFor(cycles) → schedule.tick()
                 → cpu instr + vic.tickCycle()
                                  → look up cycle entry (296a-2)
                                  → fetch Phi1 (296a-1) + Phi2 (badline matrix)
                                  → emit 8 pixels via display pipe (296a-3)
                                    INTO framebuffer directly
                                  → sprite cycle ticks emit pixels too
                                  → collision latches updated per pixel (296c)
                 → renderToPng() = just PNG-encode the framebuffer
```

raster_changes lanes still useful as the bridge from CPU register
writes to per-cycle pipe sampling (= no architectural duplication).

## Sub-spec backlog

### 297a — VicIIVice.tickCycle: pixel emission hook

Add `framebuffer` injection point + `emitCyclePixels()` callback in
VicIIVice. Wire into the existing `tickCycle()` path. Mode-specific
pixel emit lives in 297b-g. 297a just routes 8 pixels per visible
cycle into the framebuffer via display pipe state.

Acceptance: VicIIVice exposes `attachCyclePixelEmit(cb)` API; the
existing per-line snapshot path stays in place as fallback;
synthetic test confirms `cb` fires 63 times per line × screen_height.

### 297b — Mode 0 (standard text) cycle emit

Pixel decoder for mode 0: gbuf MSB → fg/bg per cbuf. Use the
emit path from 296a-4 raster-line renderer, but emit per-cycle
into the live framebuffer.

Acceptance: KERNAL boot READY screen renders byte-identical to
`vice-rasterized` reference at end-of-frame.

### 297c — Mode 1 (multicolor text) cycle emit

Multicolor text decoder: cbuf bit 3 selects mc-vs-hires per cell.
MC pixels = 2-bit pairs from gbuf, lookup into d021/d022/d023/cbuf
per pair value. mc_flop tracks pair boundary.

Acceptance: synthetic mc-text test renders correct 2x1 pixel-pair
layout; existing mc smoke regression byte-identical.

### 297d — Mode 2 (standard bitmap) cycle emit

Bitmap fetch from `bitmap_base + (vc * 8) + rc`. fg/bg per cbuf
upper/lower nibble. Pipe latency unchanged.

Acceptance: synthetic bitmap test (= vertical color bars) renders
matching VICE.

### 297e — Mode 3 (multicolor bitmap) cycle emit

MC bitmap: 2-bit pairs from gbuf, color from cbuf upper/lower
nibble + d021. mc_flop per pair.

Acceptance: synthetic mc-bitmap test renders 4-color bar pattern.

### 297f — Mode 4 (extended bg text) cycle emit  [motm-critical]

ECM = $D011 bit 6. Char code bits 6-7 select bg color (d021/d022/
d023/d024). Character bitmap masked to bits 0-5 (= 64 chars).
Φ1 fetch addr ANDed with $39FF (= already in 296a-1 fetchIdleGfx).

Acceptance: motm gameplay screen renders ship + menu bg color
bands matching VICE at single capture point. Resolves SI-? for
motm text overlay.

### 297g — Modes 5-7 (illegal) cycle emit

Illegal mode pixels = palette[0] (= absolute black) per Spec 284.
Already covered for snapshot renderer; replicate in cycle path.

Acceptance: smoke-illegal-modes regression green via cycle path.

### 297h — Sprite cycle-by-cycle pixel emit

Sprite DMA cycles (1-10, 58-63) fetch sprite data into per-sprite
3-byte buffer. Sprite x position + expand bits drive per-pixel
sprite emission interleaved with gfx pixels. Priority per cycle
($D01B). Multicolor per cycle ($D01C).

Acceptance: synthetic 8-sprite stripe test renders correct x
positions + colors + multicolor pixel pairs.

### 297i — Sprite-bg + sprite-spr collision pixel-time wire

Plug 296c `pixelCollisionUpdate()` into the per-pixel emit loop.
spriteMask = OR of opaque sprite pixels at this position.
fgGfxPixel = current gfx pixel is foreground (= drawn from gbuf
with priority).

Acceptance: motm hand sprite collides with ship bg correctly;
$D01F poll-loop in motm code path sees changes.

### 297j — Border/CSEL/RSEL cycle-exact

vertical/horizontal border state machine (= raster_modes_t from
Spec 289) consulted per cycle. Border pixels = $D020. Visible
window narrows on CSEL/RSEL transition mid-frame.

Acceptance: motm vertical bar artifact + Spec 281 border smokes
green via cycle path.

### 297k — Mid-cycle register write apply via raster_changes lane

CPU writes to $D000-$D02E or CIA2 PA already feed per-cycle log
(reg-log in VicIIVice). Hook the cycle-pumped renderer to consume
these at the exact cycle.phase to update display pipe inputs
(xscroll_pipe sampling, screen_base_ptr, etc.).

Bridge raster_changes lanes (Spec 280a/b) → display pipe samplers
(Spec 296a-3). No double bookkeeping.

Acceptance: synthetic per-cycle $D016 write at cycle 25 → cycle 26
emit shifts, matching VICE pixel-perfect.

### 297l — Replace vice-rasterized as default renderer

Once 297a-k functionally complete, flip session.vicRenderer default
to `cycle-pumped`. Drop snapshot-based path or keep as `legacy`
mode for diagnostics.

Acceptance: all 280-296 smokes green via cycle-pumped; motm + IM2
+ Scramble Infinity corpus PNGs match VICE within pixel-diff
threshold.

### 297m — Frame orchestration

raster_y advance + frame wrap + nextLine carry. Hook into existing
scheduler so cycle pump runs the same total cycles per frame
(= 63 × 312 PAL).

Acceptance: 1 PAL frame = 19656 c64-equivalent cycles; raster_y
wraps 0..311; raster IRQ fires at correct line.

## Out of scope (= future specs)

- NTSC support: ship PAL parity first.
- VICII variants (R56A, 6567R8): Spec 282 palettes already cover;
  cycle table for 64 cycles → separate sub-spec.
- VSP bug emulation: vicii-cycle.c:312-372. Niche, deferred.

## Workflow per sub-spec

1. Synthetic unit test FIRST (small, focused, deterministic).
2. Implement against x64sc source parity (no guessing).
3. Run regression smokes (must stay green throughout).
4. When 297l lands, capture corpus pair (vice + headless) per
   game in 296 register; mark register row resolved if diff
   closes.

## Acceptance (full spec)

- [ ] All 13 sub-specs landed
- [ ] All 280-296 smokes still green
- [ ] motm: ship + menu text + hand sprite render correctly
- [ ] IM2: gameplay screen matches VICE within threshold
- [ ] Scramble Infinity: title logo no rainbow scatter; gameplay
      collisions active
- [ ] vice-rasterized renderer either retired or kept as legacy
      mode behind opt-in flag

## Risk register

- **Performance:** cycle-pumped emit = 63 × 504 / 8 = 3969 pixel
  writes per scanline. PAL = 312 lines × 19705 ≈ 6.1M cycles per
  PAL frame. Headless TS may not hit 50fps. Mitigation: batch
  emit per cycle (= 8-byte writes), avoid per-pixel function
  calls. Profile before declaring done.
- **Sprite multiplexer complexity:** the trickiest piece. Allow
  297h to slip into 297h-1..3 if needed.
- **Backwards compat:** existing snapshot tests may fail when
  cycle path emits subtly different pixels. Treat as VICE-parity
  decision: if cycle path matches x64sc and snapshot path doesn't,
  cycle path wins; update snapshot test expectations.
