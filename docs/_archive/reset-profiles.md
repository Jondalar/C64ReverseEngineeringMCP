# Reset Profiles (Spec 100 / M1.3)

The `IntegratedSession.resetCold(profile)` method takes a named profile.
Each profile pins every cold-reset knob so two reset+run pairs with
the same input sequence produce **byte-identical state at every cycle**.

## Profiles

### `pal-default`

PAL video timing + standard real-C64 power-on RAM pattern.

| Knob               | Value                                                                |
|--------------------|----------------------------------------------------------------------|
| Video timing       | PAL 312 raster lines, ~50 Hz                                         |
| C64 clock          | PAL 985.248 kHz                                                      |
| Drive clock        | 1 MHz (drive-cycles-per-c64-cycle ≈ 1.01477)                         |
| RAM init pattern   | 64-byte alternating `$00` / `$FF` blocks                             |
| VIC raster phase   | 0 (deviation from real HW which starts random — intentional)         |
| Drive head start   | track 18 (BAM/directory)                                             |
| Keyboard buffer    | empty                                                                |
| IEC lines          | all released (high)                                                  |
| Joystick port 2    | neutral (no direction, fire released)                                |
| ROM set            | KERNAL `901227-03`, BASIC `901226-01`, charrom `901225-01`, drive ROM 1541 |

### `ntsc-default`

Same as `pal-default` except NTSC video timing + ~60 Hz refresh + NTSC
C64 clock.

### `custom`

Escape hatch. Currently aliases `pal-default`. When future callers
need to override individual knobs, this becomes the override-driven
preset (analogous to SessionMode `custom`).

## Determinism guarantee

`scripts/smoke-reset-determinism.mjs` (`npm run smoke:reset`) cold-
resets the session 5 times with `pal-default`, runs each to ~100k C64
cycles, and asserts the MD5 of full RAM (C64 + drive) plus CPU
register state is identical. As of 2026-05-04 the smoke is green.

## Intentional deviations from real hardware

- VIC raster phase pinned to 0 instead of random.
- RAM pattern fixed instead of weakly-coupled DRAM cell randomness.
- Drive motor off (real hardware spins up immediately on power-on).

These are deliberate so regression diffs against the same input
sequence stay byte-identical. Comparing against VICE traces (Spec
095) requires VICE to be configured to match these knobs (the
existing trace-eof-vice harness does so when started after VICE is
already at READY).

## Profile manifest version

This document defines the "v1" profile set. Bumping the manifest
requires:
- a new SessionMode-style version field on `ResetProfileSpec`,
- regenerating any committed regression hashes,
- a corresponding bump on Spec 100's status line.
