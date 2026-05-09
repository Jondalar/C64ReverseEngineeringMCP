# Spec 291 — VIC-II sprite quirks (Y-crunch + self-collision + DMA byte timing)

**Sprint:** 144  **Status:** PROPOSED 2026-05-09  **Depends:** 280d

## Goal

Three undocumented sprite behaviors:
1. **Y-expansion crunch bug**: Y-expand toggle mid-frame at
   specific raster cycles produces "crunched" sprite (= row
   counter desync, sprite shrinks).
2. **Self-collision**: a sprite that overlaps itself in same
   cycle (rare hardware quirk) sets sprite-sprite collision bit.
3. **DMA byte timing**: track each of the 3 s-access bytes per
   sprite per row separately so introspection sees individual
   bus reads.

## VICE source

- `vicii-sprites.c` — `handle_sprite_y_expansion_check` (~line
  1270) — crunch bug.
- `vicii-sprites.c:896` — self-collision detection.
- `vicii-fetch.c:371` — handle_fetch_sprite per-byte timing.

## Plan

- 291a: Y-expansion crunch: track `expand_y_flop` per sprite, flip
  on each line for expanded sprite. Toggle mid-frame at cycle 15
  (= MOB Y-expansion check window) skips a row → visual crunch.
- 291b: Self-collision: in renderSpritesPerLine, when a sprite's
  bit overlaps itself within the same render pass (= rare; happens
  when sprite-x_msb writes mid-frame moves it over its prior
  position), OR into spriteSpCollision.
- 291c: Per-byte sprite DMA: extend bus-trace to emit 3 events per
  active sprite per row instead of single-event "block".

## OQs

- **OQ1:** Y-crunch precision. (a) Cycle-15 check window only, (b)
  full per-cycle Y-expansion latch (= more accurate, more code).
  Default (b) full per-VICE.
- **OQ2:** Self-collision: rare or never observed in real games?
  (a) Implement (b) skip. Default (a) full parity.
- **OQ3:** Per-byte DMA: needed for any current consumer? (a)
  Implement now (b) defer until consumer. Default (a) — tracing
  fidelity for V3 timeline view.
- **OQ4:** Test gate: (a) synthetic Y-crunch reproduction PRG (b)
  regression. Default both.

## Acceptance

- [ ] Y-expansion crunch reproducible on synthetic test
- [ ] Self-collision OR'd into $D01E correctly
- [ ] Bus-trace shows 3 s-access events per sprite per row
- [ ] All previous smokes still pass
