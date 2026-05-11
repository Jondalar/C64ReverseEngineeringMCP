# G64 GCR Shifter Fidelity Notes (Spec 113 / M3.5)

## Summary

Sprint 96 shipped the bit-level free-running GCR shifter, byte-ready /
SO pin wiring, density zones, and head stepping. Spec 113 (M3.5)
adds the remaining edge cases: motor gating, DENSITY override,
half-track behavior, write-protect line, and cross-zone sync detection.

`npm run smoke:g64-fidelity` — 20/20 pass.
`npm run regress` — 5/5 still green after wiring change.

## Sub-stories

### M3.5a — Motor gating

VIA2 PB2 = MOTOR. Bit 1 = motor on. `TrackBuffer.tickShifter` returns
immediately when motor is off, so the bit counter never advances and
byte-ready never fires. Drive ROM toggles MOTOR around inactivity
timeout and during seek; default is ON so existing LOAD paths keep
working until drive ROM intentionally switches it off.

The wiring in `via2-gcr.ts` only honors PB2 when DDR has it as output
(per real-hardware latch semantics). At reset the DDR is input → no
spurious motor stop during the boot window.

### M3.5b — DENSITY override

VIA2 PB5/PB6 = DENSITY low/high. Together they encode zone 0..3
directly:

| zone | tracks   | bit cell | cyc/byte |
|------|----------|----------|----------|
| 0    | 31-35    | 4.00 µs  | 32       |
| 1    | 25-30    | 3.50 µs  | 28       |
| 2    | 18-24    | 3.25 µs  | 26       |
| 3    | 1-17     | 3.00 µs  | 24       |

Override is only applied when both DENSITY pins are configured as
outputs (DDR=11). This matches drive ROM behavior — at reset the DDR
is input → track-derived zone stays in effect during boot. Once drive
ROM programs DDR + writes DENSITY bits, the override beats head
position.

`TrackBuffer.cyclesPerByteForZone(z)` exposed publicly for tests.

### M3.5c — Half-track read

`TrackBuffer.setHalfTrackMode(true)` switches the shifter to a
deterministic alternating-bit garbage stream. Bit values toggle on
each call to `advanceOneBit`, so:

- SYNC is never detected (no 10-in-a-row 1-bits).
- Latched bytes form $55-style patterns that don't decode as valid GCR.
- Drive ROM falls back to retry until the head reaches an integer track.

The wiring in `via2-gcr.ts` recomputes `halfTrackMode` from
`coupling.headPosition.currentHalfTrack & 1` on every PB write, so
any STEP-bit change that lands the head on a half-track index
propagates to the shifter immediately.

### M3.5d — Write-protect line

VIA2 PB4 = WPS. `coupling.writeProtected: true` pulls the bit low
(line LOW = write-protected). Default is `false` (line HIGH = not
write-protected). Pinned in tests on both sides.

### M3.5e — Cross-zone sync

Synthetic G64 fixtures placed at tracks 17, 18, 24, 25, 30, 31
(both sides of every speed-zone boundary). SYNC is detected within
8 000 cycles on each. Confirms the shifter handles zone-boundary
timing changes without losing bit alignment.

## Open follow-ups

- Drive-ROM-controlled MOTOR + DENSITY through a full LOAD: assert
  the bits actually toggle as expected in `npm run regress`. Current
  fixtures are unit-level only.
- Half-track garbage byte distribution: real hardware shows
  off-track flux; we pick deterministic $55-style. Documented as
  v1 deviation; v2 could feed pseudorandom flux for copy-protection
  fixtures.
- Variable G64 track length (7140-7900 bytes per zone): G64Parser
  already handles this; no spec work required.

## Files

- `src/runtime/headless/drive/head-position.ts` — TrackBuffer +
  HeadPosition. Added: `setMotorOn`, `setDensityOverride`,
  `setHalfTrackMode`, public `cyclesPerByteForZone`.
- `src/runtime/headless/drive/via2-gcr.ts` — `makeGcrVia2Pb`
  now propagates motor / density / half-track on PB writes.
- `src/runtime/headless/drive/g64-fidelity-tests.ts` — 5 suites,
  20 checks.
- `scripts/smoke-g64-fidelity.mjs` + `npm run smoke:g64-fidelity`.
