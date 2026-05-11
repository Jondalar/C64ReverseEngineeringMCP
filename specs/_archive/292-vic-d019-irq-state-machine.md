# Spec 292 — VIC-II $D019 IRQ state machine (full vicii-irq.c port)

**Sprint:** 144  **Status:** RESOLVED 2026-05-09  **Depends:** 281

**Resolved:** Full edge-tracked port; test gate = synth IRQ edge
test + regression.

## Goal

Port VICE `vicii-irq.c` (165 LOC) edge-tracked IRQ flag state
machine. Currently we re-fire the alarm + maintain bit-7 summary;
VICE's edge tracking handles mid-cycle edges (level-vs-edge,
multiple edges per instruction).

## VICE source

- `vicii-irq.c` — `vicii_irq_set_line` + `vicii_irq_check_state`.

## Plan

- 292a: New `src/runtime/headless/vic/vic-irq.ts` ports the 165
  LOC state machine.
- 292b: Wire raster-line, sprite-bg-coll, sprite-sp-coll edges
  into the new state machine.
- 292c: Replace existing $D019 read/write handlers in vic-ii-vice.

## Acceptance

- [ ] Edge-triggered IRQ state per source (raster/sp-bg/sp-sp/lp)
- [ ] $D019 read returns latched + summary bit 7
- [ ] $D019 write-1-to-clear works per bit
- [ ] All previous smokes pass
