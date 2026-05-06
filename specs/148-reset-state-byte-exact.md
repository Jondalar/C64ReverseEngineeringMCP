# Spec 148 — Reset state byte-exact 1:1 VICE

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: proposed
**Source**: VICE 3.7.1 src/core/viacore.c viacore_reset,
            src/core/ciacore.c ciacore_reset,
            src/drive/drivecpu.c drivecpu_reset,
            src/drive/drive-resources.c drive_reset_internal
**Depends on**: Spec 145 (CIA), Spec 147 (VIA)

## Why

Drive boot state determines code path. If our drive reset state
differs from VICE by even one byte (RAM init pattern, VIA register
default, ZP $00/$01 CPU port default), drive ROM init takes
different branches → cascading divergence.

## Scope

### Point 19: drive RAM reset
- VICE drivecpu_reset: clears RAM via memset to specific patterns?
  Verify by reading source.
- Real 1541 cold reset: RAM has random/uninitialized bytes. POST
  routine clears RAM ($EAA0+ in ROM).
- Currently our drive.bus.ram.fill(0). VICE: check if same.

### Point 20: VIA reset state
- viacore_reset clears registers but with specific timer latch
  defaults ($FFFF or $0000?).
- IFR/IER cleared per datasheet.
- ORA/ORB/DDRA/DDRB cleared.
- ACR/PCR cleared.
- T1 latch behavior on reset: VICE sets specific value.

### CIA reset state (Spec 145 covers but cross-reference here)
- ICR cleared.
- TOD: VICE sets specific values.
- Timer latches.

### Point 21: Boot order
Already implemented (driveHeadStartCycles option). VICE simulates
both CPUs from cycle 0 simultaneously. Real HW: drive boots faster
(~10 frames). We default 0 = match VICE simulation.

## Process

1. Read VICE \*reset functions for each chip.
2. Document expected state per register.
3. Audit our reset() functions vs VICE.
4. Add per-chip-test: dump full register state post-reset, compare.

## Acceptance

- Drive RAM post-reset byte-equivalent to VICE (compare via binmon
  read after fresh boot).
- VIA1 + VIA2 register state byte-exact.
- CIA1 + CIA2 register state byte-exact.
- Drive ZP $00/$01 (CPU port) byte-exact.
- C64 ZP $00/$01 byte-exact.

## Estimated effort

0.5-1 session. Audit work, mostly verification + small fixes.
