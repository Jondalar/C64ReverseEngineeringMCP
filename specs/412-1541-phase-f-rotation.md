# Spec 412 — 1541 Phase F: Rotation

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 411
**Doctrine:** 1:1 VICE TDE port.

## Goal

Bring rotation / GCR shifter / disk physics in line with
`docs/vice-1541-arch.md §13 Phase F` (steps 22–26) and §8.

## Doc anchor

- §13 Phase F
- §8.1 state, §8.2 GCR encoding, §8.3 per-cycle rotation step,
  §8.4 SYNC detection, §8.5 wobble, §8.6 track stepping reload
- §12 per-cycle tick order (rotation is step 1 in §12)
- §14 invariants 1, 9

## Canonical content (verbatim §13 Phase F)

22. Per-half-track GCR buffer (`gcr->tracks[ht].data` + `.size`).
23. `drive_set_half_track()`: reload `GCR_track_start_ptr` and
    `GCR_current_track_size` when stepping.
24. `rotation_rotate_disk()` called once per drive cycle from
    `drivecpu_rotate()` macro:
    - `accum += delta * bits_per_cycle[zone] * wobble`
    - While bit-cell overflows, advance one bit (read or write).
    - Update `zero_count`; SYNC detect when ≥10.
    - On 8-bit boundary, pulse CA1, set `byte_ready_edge`, update
      VIA2 PA.
25. Wobble model: PRNG-driven RPM modulation; default amplitude
    matches stock 1541.
26. Mark track dirty on write; writeback on detach.

## VICE source cite

- Rotation: `src/drive/rotation.c`.
- GCR conversion: `src/diskimage/fsimage-gcr.c`.

## Audit — current TS state

Files:

- `src/runtime/headless/drive/gcr-shifter.ts`
- `src/runtime/headless/drive/track-buffer.ts`
- `src/runtime/headless/drive/head-position.ts`

Status:

- GCR shifter present and default ON since 2026-05-06 (memo
  `project_gcr_default_flipped`).
- Real 1:1 VICE rotation.c port = default; legacy flag
  `C64RE_USE_LEGACY_GCR=1` for revert.
- motm half-track stepInward cap at track 35 (memo `motm-via1-ca1`).

Deviations to verify:

1. **Rotation per drive cycle** (§14 invariant 1, §13 step 24):
   - Required: `rotation_rotate_disk()` runs **exactly** once per
     drive CPU cycle (not per N cycles, not at instruction
     boundary).
   - Current TS: gcrShifter ticked from session per N drive cycles
     (verify). Per spec 400 audit deviation 1, rotation is OUTSIDE
     the per-drive-cycle loop. Move it INTO the loop per §12 step 1.
   - **TODO fresh session**: relocate rotation tick into drive-cpu
     cycle-stepped path; remove session-side tick.

2. **`bits_per_cycle[zone]` table** (§8.3):
   - Required: 4-zone table from `rotation.c`.
   - **TODO**: cite VICE table values; diff vs TS.

3. **SYNC detect on ≥10 ones** (§8.4):
   - Required: zero_count tracks consecutive 1-bits; SYNC at ≥10.
   - **TODO**: verify TS.

4. **Wobble** (§8.5, §13 step 25):
   - Required: PRNG-driven RPM modulation; matches stock 1541
     amplitude.
   - Current TS: wobble flag exists; verify amplitude vs VICE.

5. **Track stepping reload** (§8.6, §13 step 23):
   - Required: on half-track change, reload `track_start_ptr` +
     `track_size`.
   - Current TS: `HeadPosition.maxHalfTracks` updated on mount swap
     (memo `mount-swap-fixed`). Verify drive_set_half_track analog.

6. **Dirty track + writeback** (§13 step 26):
   - Required: write path marks track dirty; detach writes back.
   - Current TS: probably read-only currently. Stub or skip until
     write support (memo `drive-write-support.md` archived).

## TS extras to DELETE

- Legacy GCR shifter (already opt-in via `C64RE_USE_LEGACY_GCR=1`).
  Remove the flag and the legacy path entirely — VICE has one
  rotation impl.

## NTSC stub

- Rotation is mechanical (= 300 RPM, fixed) and clock-independent
  at chip level. No NTSC stub.

## Producer changes

1. Move rotation tick INTO drive-cycle loop per §12 step 1.
2. Pin `bits_per_cycle[zone]` to VICE exact.
3. Verify SYNC detect, wobble, track stepping.
4. Remove legacy GCR shifter + flag.

## Consumer changes

- Drive-cpu cycle-stepped loop calls `rotation_rotate_disk()`
  before opcode work each cycle.
- Session-side GCR shifter tick removed.

## Acceptance

- Build clean.
- VICE drive testprogs 4/4 PASS.
- New smoke `scripts/smoke-412-rotation-per-cycle.mjs`: assert
  rotation tick count == drive cycle count after 1M drive cycles.
- New smoke `scripts/smoke-412-sync-detect.mjs`: synthetic GCR
  stream with SYNC marker (≥10 ones), assert SYNC line goes low
  at the right bit.
- MM s1 (depends on GCR for fastloader) + Scramble Infinity (Krill
  loader) both still complete.

## Open Questions

- **OQ-412-1**: Wobble PRNG seed — VICE uses fixed or system-time?
  Determinism matters for diff-trace.
- **OQ-412-2**: `bits_per_cycle[zone]` exact 4-zone values from
  `rotation.c` — pin in doc §8.3 with VICE constants.

## Files touched

- `src/runtime/headless/drive/gcr-shifter.ts` (modify)
- `src/runtime/headless/drive/drive-cpu.ts` (rotation tick inside
  cycle loop)
- `src/runtime/headless/integrated-session.ts` (drop session-side
  GCR tick)
- 2 new smokes
- `specs/412-1541-phase-f-rotation.md` (this)

## Next spec

Spec 413 — 1541 Phase G: Image formats.
