# Drive Fidelity Backlog (Spec 116 / M3.8)

Per spec exit criterion: each acceptance bullet is **either covered by
a test fixture or recorded here as an explicit gap with rationale**.

`npm run smoke:fidelity-backlog` — 6/6 pass.
`npm run regress` — 5/5 still green after track-zero stop bound change.

## Status table

| Item                            | Status     | Where                                             |
|---------------------------------|------------|---------------------------------------------------|
| M3.8a Motor spin-up / down delay | **Gap**    | Documented below; not yet cycle-aware             |
| M3.8b Track-zero stop            | **Covered**| `runTrackZeroStopTest` (3 checks)                 |
| M3.8c VIA shift register modes   | **Gap**    | Documented below; system-clock partially exists   |
| M3.8d VIA timer edge cases       | **Gap**    | Documented below; T1 + T2 underflow done in v6522 |
| M3.8e Write splice               | **Gap**    | Documented below; gated on Spec 114 v2            |
| M3.8f Disk-change WP semantics   | **Covered**| `runDiskChangeWpTest` (3 checks)                  |

## Covered items

### M3.8b — Track-zero stop

`HeadPosition.stepOutward` bounds at half-track index 2 (= track 1).
Real 1541 head physically halts there; drive ROM bumps the head
against the stop during seek-to-track-1 calibration. Without the
bound, repeated stepOutward seeks could drive `trackHalf` to 0 or
below, breaking `cyclesPerByteForTrack` and the latched-track logic.

Test (`runTrackZeroStopTest`):
- start at track 1 (halfTrack 2)
- 100× stepOutward → still at halfTrack 2
- 1× stepInward → halfTrack 3 (track 1.5)

### M3.8f — Disk-change WP semantics

`Via2GcrCoupling.writeProtected` is read lazily on each VIA2 PB
input read, so flipping the property mid-session propagates to the
next drive-ROM read. API-level disk-swap callers can mutate the
field on the live coupling; drive ROM's WP-poll picks up the change
within one PB read.

Test (`runDiskChangeWpTest`):
- initial unprotected: PB_WPS bit set (line high)
- swap to WP=true: PB_WPS bit clear (line low)
- swap back: PB_WPS bit set again

## Gaps (documented, not implemented)

### M3.8a — Motor spin-up / down delay

**Gap rationale.** Real 1541 drive ROM waits ~0.5 s after motor-on
before reading from the disk to let the spindle reach speed.
Currently `TrackBuffer.setMotorOn(true)` resumes shifter advance on
the very next `tickShifter` call. The result is that drive ROM that
relies on natural motor-spin-up timing gets bytes too early.

**Impact.** Standard LOAD paths still work because drive ROM uses a
software delay loop after motor-on, not a hardware-feedback wait. So
LOAD timing is correct in practice. Edge case: software that polls
for "first valid byte after motor on" within tight cycle bounds may
see implausibly fast disks.

**Fix path (when needed).** Add a configurable spin-up cycle counter
in `TrackBuffer` that gates `advanceOneBit` for ~500 ms of drive
cycles after motor-on edge.

### M3.8c — VIA shift register modes

**Gap rationale.** `Via6522` has skeleton SR support but the four
operating modes (SR disabled / under T2 / under PHI2 / under
external CB1 clock) are not all implemented. None of the standard
1541 LOAD/SAVE path uses the SR, so leaving the rare modes
unimplemented does not affect commercial-software acceptance.

**Impact.** Software that explicitly programs the VIA SR (rare —
typically demo effects or unusual loaders) will not see correct
shift-out / shift-in behavior.

**Fix path (when needed).** Implement `ACR` bits 2-4 mode select
plus per-cycle SR shift in the cycle-stepped VIA path.

### M3.8d — VIA timer edge cases

**Gap rationale.** T1 + T2 underflow + IFR-set are correct (used
heavily by drive ROM IRQ scheduling and confirmed via Spec 110
M3.2b ATN-edge IRQ tests). Edge cases not asserted:

- PB7 toggle output on T1 underflow (`ACR` bit 7).
- One-shot vs continuous T1 (`ACR` bit 6) — continuous is the
  common path; one-shot may differ in IFR-clear timing.
- TA → TB cascade (T1 generates pulses on PB6 to clock T2).

**Impact.** Drive ROM uses the simple continuous-mode IRQ path; the
above edge cases are software-visible only for unusual peripherals.

**Fix path.** Per-cycle ACR-bit-7 PB7 toggle in `tickTimer1`;
discrete one-shot end-state logic; T2 PB6-pulse counting mode.

### M3.8e — Write splice

**Gap rationale.** Real 1541 write logic transitions on/off the head
write enable mid-track; the splice point produces a brief invalid
GCR run. Headless does not model this. Gated on Spec 114 v2 (write
loop via real drive ROM); without that, no software path actually
exercises mid-track write transitions.

**Impact.** None for v1 (write path is byte-cursor only, no splice).

**Fix path.** Once Spec 114 v2 routes writes through the bit-level
shifter, mark the splice byte-offset on every write-enable transition
and emit a deterministic invalid-GCR pattern at that offset.

## Out of scope (per spec)

- Bad-sector emulation
- Copy-protection write-detection
- Custom-format-disk write splice
- Real-time bit-flux modeling

## Files

- `src/runtime/headless/drive/head-position.ts` — track-zero stop in
  `stepOutward`.
- `src/runtime/headless/drive/via2-gcr.ts` — WP via lazy
  `coupling.writeProtected` read.
- `src/runtime/headless/drive/drive-fidelity-backlog-tests.ts` —
  fixture suite.
- `scripts/smoke-fidelity-backlog.mjs` + `npm run smoke:fidelity-backlog`.
