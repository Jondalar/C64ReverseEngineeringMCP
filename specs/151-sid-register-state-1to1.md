# Spec 151 — SID register state 1:1 VICE (no audio)

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: proposed
**Source**: VICE 3.7.1 src/sid/*.c
**Depends on**: none

## Why

V1 explicitly excludes audio output but games still WRITE to SID
registers. Some games READ back oscillator state ($D41B osc3) or
ENV state ($D41C env3) for synchronization, randomization, or
copy-protection.

If our SID register read doesn't match VICE, games may fail.

## Scope

### Point 18: SID register state

- All 29 register R/W match VICE.
- $D41B osc3 / $D41C env3 readback: VICE simulates oscillator
  + envelope advancement per cycle. Returns deterministic value
  based on SID state + clock.
- ADSR envelope state machine 1:1 (attack/decay/sustain/release
  curves).
- Filter state placeholder (no audio output but write/read state
  preserved).
- POT pin readback for paddles (already done via Sprint 108).

## Process

1. Read VICE sid/*.c register R/W paths.
2. Audit our sid.ts register handlers.
3. Port osc3/env3 advancement state machine.
4. Verify per VICE oscillator-snap test.

## Acceptance

- All SID register reads return same value as VICE for same input
  sequence.
- $D41B/$D41C readback matches VICE.
- ADSR transitions match VICE.
- smoke:sid-fidelity passes 100%.

## Estimated effort

0.5-1 session. Audit + targeted port.

## Note

Lower priority than 145/146/147 for game booting. Most games don't
depend on SID readback. Specific games (e.g. some demos using osc3
for randomization) may need this.
