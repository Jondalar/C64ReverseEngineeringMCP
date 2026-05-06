# Spec 150 — VIC bus stealing + IRQ timing 1:1 VICE

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: proposed
**Source**: VICE 3.7.1 src/vicii/vicii*.c (large module)
**Depends on**: Spec 146 (CPU cycle audit — VIC steals CPU cycles)

## Why

VIC-II steals CPU cycles for badlines (40 cycles for char fetch)
and sprite DMA. C64 KERNAL serial bit-bang timing accounts for
VIC stealing: KERNAL writes \$DD00 with timing tuned to NOT collide
with badline cycles.

If our VIC doesn't steal correctly, KERNAL serial bit-bang phasing
shifts. Drive sees CLK toggles at wrong cycles.

VIC raster IRQ timing also matters for some games but less for
KERNAL serial.

## Scope

### Point 16: bus stealing
- Badline detection (raster Y \& 7 == YSCROLL) on lines 0x30-0xf7.
- 40 char fetch cycles per badline.
- 1-3 sprite DMA cycles per active sprite per line.
- CPU stalls during stealing (VICE \`maincpu_steal_cycles\`).

### Point 17: VIC IRQ timing
- Raster IRQ fires at specific cycle per line ($D012 == raster && \$D011 bit 7 == raster bit 8).
- IRQ-flag set + IRQ propagation timing.
- Our impl partial.

## Process

1. Read VICE vicii.c per-cycle dispatcher.
2. Audit our vic-ii.ts dispatch.
3. Port badline + sprite DMA stealing.
4. Port IRQ timing precisely.

## Acceptance

- Cycle-accurate VIC bus stealing per VICE.
- Raster IRQ fires at exact cycle vs VICE.
- KERNAL serial bit-bang timing aligns with VICE for MM-LOAD +
  motm scenarios.

## Estimated effort

1-2 sessions. VIC is complex.

## Note

Not strictly needed for motm boot if motm doesn't depend on raster
IRQ. KERNAL serial may be tolerant of slight cycle shifts. Defer
this spec until 145+146+147+148+149 don't fix motm.
