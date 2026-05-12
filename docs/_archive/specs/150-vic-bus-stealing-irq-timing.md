> **SUPERSEDED 2026-05-06 by Spec 214** (`specs/214-vic-bus-stealing-irq-timing.md`).
> Sprint 113 aborted.

# Spec 150 — VIC bus stealing + IRQ timing 1:1 VICE (B-level)

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: proposed
**Source**:
- VICE 3.7.1 src/vicii/vicii.c (~3000 LOC)
- src/vicii/vicii-cycle.c (~2000 LOC)
- src/vicii/vicii-fetch.c (~1500 LOC)
- src/vicii/vicii-irq.c
- src/vicii/vicii-mem.c
**Depends on**:
- Spec 146 (CPU cycle audit — VIC steals CPU cycles)
- Spec 149 (alarm system — raster line tick is alarm-driven)
**Refinement**: locked 2026-05-06

## Why

VIC-II steals CPU cycles for badlines (40 cycles for char fetch)
and sprite DMA (2 cycles per active sprite + 3 fixed pointer
fetch). C64 KERNAL serial bit-bang timing accounts for VIC
stealing: KERNAL writes $DD00 with timing tuned to NOT collide
with badline cycles.

If our VIC doesn't steal correctly, KERNAL serial bit-bang phasing
shifts. Drive sees CLK toggles at wrong cycles.

VIC raster IRQ timing also matters for some games but less for
KERNAL serial.

## Refinement decisions

1. **Port-Tiefe (this sprint, B-level)**:
   - Cycle-accurate bus stealing (badlines + sprite DMA + sprite
     multiplexing + bad-line-flag-window).
   - Raster IRQ + IRQ propagation timing.
   - All register R/W ($D000-$D03F + mirroring).
   - Frame state for per-scanline register snapshot (existing
     rendering pipeline consumes).
   - **Excluded** at B-level: pixel rendering, sprite-sprite
     collisions, sprite-bg collisions, lightpen, per-revision
     quirks (6569 vs 8565 vs 6567 vs 8562), interlace, hires
     bitmap-mode pixel detail, sprite-display hardware quirks.
2. **V3 backlog**: pixel-perfect VIC = full vicii*.c 1:1 port
   (~12-15k LOC), all revisions, all collisions, lightpen, true
   interlace + hires. New spec when V3 sprint starts. Notiert
   in PLAN.md V3 section.
3. **Bus-stealing mechanic**: VICE-1:1 `maincpu_steal_cycles`
   port.
   - Maincpu has explicit pause counter / steal-clk tracking.
   - Lockstep scheduler honors maincpu stealing — drive_clk
     advances normally while maincpu_clk stalled.
   - Cross-ref Spec 149: VIC raster line ticks are alarm-driven;
     bus-stealing per-cycle is a per-cycle hook checked before
     each maincpu instruction fetch.
4. **Existing vic-ii.ts handling**: parallel migration ending in
   single canonical filename.
   - Phase 1: write new B-level core in `vic-ii-vice.ts`.
     Existing `vic-ii.ts` keeps rendering pipeline.
   - Phase 2: extract rendering from old vic-ii.ts to
     `vic-ii-renderer.ts`. Old file becomes thin shim.
   - Phase 3: switch all callers to new core.
   - Phase 4: delete shim, rename `vic-ii-vice.ts` → `vic-ii.ts`.
   - Final: `vic-ii.ts` = core (B-level VICE port),
     `vic-ii-renderer.ts` = rendering pipeline.
5. **Bus-stealing detail (full)**:
   - Badline detection: raster Y & 7 == YSCROLL on lines 48-247.
     CPU stalls 40 cycles for char fetch + 3 cycles for color
     RAM fetch. Total 40-43 cycles depending on position.
   - Sprite DMA: per active sprite, 2 cycles for sprite data
     fetch. 3 fixed cycles for sprite pointer fetch. Total up to
     8 × 2 + 3 = 19 cycles per line if all 8 active.
   - Sprite multiplexing: VICE handles sprite enable/disable
     transitions correctly; each sprite has own DMA window.
   - Bad-line-flag-window: bad-line condition checked at specific
     cycles within a raster line; flag window is small.
6. **Mirror Spec 145 patterns**: hybrid naming (intern VICE
   verbatim — `vbank`, `vbank_ptr`, `screen_ptr`, `chargen_ptr`,
   `bitmap_ptr`, `regs[]`, `irq_status`, `imr` etc.), uint
   helpers, per-function unit + chip-state-diff harness extended,
   snapshot v2.

## Scope

### Point 16: bus stealing
- Badline detection (raster Y & 7 == YSCROLL) on lines 48-247.
- 40 char-fetch cycles + 3 color-RAM-fetch cycles per badline.
- 1-3 sprite DMA cycles per active sprite per line + 3 fixed
  pointer-fetch.
- CPU stalls during stealing (VICE `maincpu_steal_cycles`).

### Point 17: VIC IRQ timing
- Raster IRQ fires at specific cycle per line ($D012 == raster
  && $D011 bit 7 == raster bit 8).
- IRQ-flag set + IRQ propagation timing.
- Sprite-bg collision IRQ ($D019 bit 1) — flag-only at B-level
  (no actual collision detection until V3).
- Sprite-sprite collision IRQ ($D019 bit 2) — flag-only at
  B-level.
- Lightpen IRQ ($D019 bit 3) — flag stub.

### Out of scope (V3 spec)
- Pixel rendering — current `vic-ii-renderer.ts` retains
  per-scanline rendering using register snapshots from new core.
- Sprite-sprite + sprite-bg ACTUAL collision detection
  (geometry/alpha).
- Lightpen actual position.
- Per-revision pixel quirks.
- Interlace + hires bitmap pixel-detail.

## Deliverables

1. `src/runtime/headless/util/uint.ts` — shared.
2. `src/runtime/headless/vic/vic-ii-vice.ts` — new B-level core
   (becomes `vic-ii.ts` after final rename).
3. `src/runtime/headless/vic/vic-ii-renderer.ts` — extracted
   rendering pipeline (no chip-state ownership).
4. `tests/unit/vic/*.test.ts` — per-VICE-function unit tests.
5. `scripts/chip-state-diff.mjs` — extended to cover VIC
   register diff vs VICE.
6. Snapshot v2 schema bump (shared with 145/147).

## Acceptance

- Cycle-accurate VIC bus stealing per VICE: badline + sprite DMA
  cycle-counts match VICE for all relevant scenarios.
- Raster IRQ fires at exact cycle vs VICE.
- KERNAL serial bit-bang timing aligns with VICE for MM-LOAD +
  motm scenarios.
- Per-VICE-function unit tests pass.
- Runtime register-diff at MM-LOAD + motm scenarios shows zero
  VIC register divergence vs VICE through first 1M cycles.
- Existing rendering pipeline still produces frames (retained
  feature).
- maincpu_steal_cycles pattern works under lockstep scheduler.
- New smoke `smoke:vic-fidelity` PASS.

## Process

1. Read VICE vicii.c + vicii-cycle.c + vicii-fetch.c +
   vicii-irq.c top-to-bottom.
2. Identify state shape: vbank, screen_ptr, chargen_ptr,
   bitmap_ptr, sprite_data, irq_status, imr, raster_y_compare,
   raster_y, badline conditions, sprite_dma_state.
3. Write new B-level core in `vic-ii-vice.ts`:
   - Register R/W table with mirroring.
   - Cycle dispatcher: per-line state machine.
   - Bad-line detection + 40+3 char/color stealing.
   - Sprite DMA detection + 2 cycles per active + 3 pointer.
   - Raster IRQ comparator.
   - IRQ propagation.
4. Wire into Spec 149 alarm context: raster-line-start alarm.
5. Wire bus-stealing as per-cycle hook in lockstep scheduler.
6. Per-VICE-function unit tests.
7. Extend chip-state-diff harness for VIC.
8. Extract rendering from old vic-ii.ts to vic-ii-renderer.ts;
   migrate to consume new core's register snapshots.
9. Switch callers; delete old shim; rename file.
10. Run motm + MM-LOAD smoke + new smoke:vic-fidelity.

## Estimated effort

2-3 sessions. VICE vicii*.c is large but B-level scope means we
skip pixel rendering, collisions, lightpen, revisions (~half the
LOC). Big risk: bus-stealing edge cases (sprite enable mid-line,
bad-line transitions) — may take a session to debug.

## Cross-reference

- Spec 146: CPU cycle audit — needed for accurate cycle counting
  during stealing.
- Spec 149: Alarm system — raster line tick alarm-driven.
- Spec 148: Reset state — VIC reset state byte-exact (VIC unit
  reset test added there).
- V3 backlog (PLAN.md): pixel-perfect VIC = follow-up spec when
  V3 sprint starts.
