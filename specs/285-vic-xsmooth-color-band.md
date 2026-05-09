# Spec 285 — VIC-II xsmooth-color border band

**Sprint:** 144  **Status:** PROPOSED 2026-05-09  **Depends:** 281

## Goal

Render xsmooth-scroll left-edge band with `xsmooth_color` (= effective
gfx fill color in 38-col mode pixel offset window), not border color.
1:1 VICE `raster_line_fill_xsmooth_region` (raster-line.c:218).

## VICE source

- `raster/raster-line.c:218 raster_line_fill_xsmooth_region` —
  memset of xsmooth-pixel band with `xsmooth_color`.
- `vicii/vicii-mem.c` — sets `xsmooth_color = bg_color` on standard
  text mode, MCM color in MC modes, idle-fill in idle.

## Plan

- 285a: Add `xsmooth_color` to RasterState. Default = bg_color.
  Updated on $D016 / mode change to mode-correct value.
- 285b: Renderer `paintLRBorderBands`: when state.xsmooth > 0,
  draw `xsmooth_color` for `state.xsmooth` pixels at the
  display_xstart_pixel boundary (= L band shrinks by xsmooth, gfx
  pushes left into where border was).

## OQs

- **OQ1:** xsmooth_color = bg in mode 0/4? (a) bg, (b) mc1, (c) match
  per-mode VICE.  → Default (c) per-mode like VICE.
- **OQ2:** Apply also right edge or only left? VICE applies left.
  → Default left only.
- **OQ3:** Test gate: (a) synthetic + (c) regression. Default both.

## Acceptance

- [ ] xsmooth=N writes N pixels of xsmooth_color at L-edge of gfx window
- [ ] Per-mode xsmooth_color (bg / mc1 / idle)
- [ ] 281 + 282 + 283 + 284 smokes still pass
- [ ] motm/MM/LNR/IM2 4/4 regression intact
