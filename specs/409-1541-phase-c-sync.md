# Spec 409 — 1541 Phase C: Sync model

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 408
**Doctrine:** 1:1 VICE TDE port.

## Goal

Bring drive-sync (host C64 ↔ drive 6502 clocks) in line with
`docs/vice-1541-arch.md §13 Phase C` (steps 7–10) and §5.

## Doc anchor

- §13 Phase C
- §5.1 16.16 fixed-point factor
- §5.2 why fixed-point
- §5.3 PAL/NTSC switch
- §5.4 what "sync" means
- §14 invariants 3, 12
- `docs/vice-iec-arc42.md` §5.12 sync_factor init
- `docs/vice-iec-arc42.md` §5.11 push-flush call sites
- `docs/vice-iec-arc42.md` §6 sequence diagrams

## Canonical content (verbatim §13 Phase C)

7. `sync_factor` 16.16 fixed-point computed from
   host_freq / drive_freq. Re-compute on PAL/NTSC switch.
8. `drivecpu_execute(drv, host_clk)` push-mode entry:
   - Convert (host_clk - last_clk) cycles to drive cycles via
     fixed-point accumulation.
   - Run 6502 instructions until `drive_clk ≥ stop_clk`.
   - Update `last_clk = host_clk`.
9. `drive_cpu_execute_all(host_clk)` loop wrapper.
10. `drive_cpu_execute_one(unit, host_clk)` single-unit wrapper.
    Both required for IEC bus push-flush from C64 side.

## VICE source cite

- `drivesync_factor`: `src/drive/drivesync.c:53`
  `drive_set_machine_parameter()`.
- `drivecpu_execute`: `src/drive/drivecpu.c:356`.
- `drive_cpu_execute_all`: `src/drive/drive.c:1001`.
- `drive_cpu_execute_one`: `src/drive/drive.c:991`.

## Audit — current TS state

Files:

- `src/runtime/headless/drive/drive-cpu.ts`
- `src/runtime/headless/integrated-session.ts` (drive catchup site)
- Sync constants: search for `sync_factor`, `syncFactor16dot16`.

Status (per spec 400 audit):

- 16.16 fixed-point factor present (`syncFactor16dot16`,
  `cycleAccumulator16dot16`).
- Push-mode wrapper present in `IntegratedSession`.
- §14 invariant 3 satisfied in shape.

Deviations to verify:

1. **PAL/NTSC sync_factor init** (§5.3, §13 step 7,
   iec-arc42 §5.12):
   - Required: `sync_factor = (host_freq << 16) / drive_freq`.
     PAL: `985248 / 1000000 = 0xFC53` (≈ 0.985 in 16.16 = `0xFC53`
     correction: VICE uses `0x103C5` per arc42 §5.12 — verify exact
     constant).
   - **TODO fresh session**: cite `drivesync.c:53` for exact init
     constants.

2. **Push-flush call sites** (iec-arc42 §5.11):
   - Required: `drive_cpu_execute_all` called from C64 CIA2 PA
     read/write and at well-defined points (per arc42 §6 diagrams).
   - Current TS: catchup happens in main C64 step loop (per cycle?
     per instruction? per IEC line change?). Verify exact set of
     call sites matches arc42 §5.11 enumeration.
   - **TODO fresh session**: enumerate VICE call sites; compare TS.

3. **Single-unit vs all-units wrappers** (§13 steps 9–10):
   - Required: both wrappers. Single-unit for targeted PA writes;
     all-units for general flush.
   - Current TS: only one path likely. Add per-unit variant for
     multi-drive readiness even if 1541-only now.

## TS extras to DELETE

- Any "drive catchup at instruction boundary" abstraction not in
  VICE's push-flush model (= drive only catches up when host
  explicitly calls execute_*).

## NTSC stub

- `sync_factor` re-init on PAL/NTSC switch. `// TODO NTSC` for
  alternate constant; PAL hard-coded.

## Producer changes

1. Pin `sync_factor` to VICE exact constant; cite `drivesync.c:53`.
2. Enumerate push-flush call sites; align TS to arc42 §5.11 set.
3. Provide `drive_cpu_execute_one(unit, host_clk)` variant.

## Consumer changes

- C64 CIA2 PA read/write paths in
  `headless-machine-kernel.ts`: call `drive_cpu_execute_all` before
  the actual bus mutation per arc42 §5.11.

## Acceptance

- Build clean.
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.
- New smoke `scripts/smoke-409-sync-factor.mjs`: assert
  `sync_factor` constant matches VICE PAL value.
- New smoke `scripts/smoke-409-push-flush.mjs`: write to $DD00,
  verify drive caught up to host clock pre-write.
- MM + Scramble unchanged.

## Open Questions

- **OQ-409-1**: Exact PAL sync_factor — arc42 §5.12 says
  `(C64_FREQ << 16) / DRIVE_FREQ`. Compute: `985248 * 65536 /
  1000000 ≈ 64559` = `0xFC2F`. Verify in VICE source.
- **OQ-409-2**: NTSC sync_factor formula — does VICE recompute on
  every video-mode switch or once at init?
- **OQ-409-3**: Drive-side `cycles_per_second = 1000000` constant
  vs C64 PAL `985248` — confirm both are stable references in TS.

## Files touched

- `src/runtime/headless/drive/drive-cpu.ts` (sync constants)
- `src/runtime/headless/integrated-session.ts` (push-flush sites)
- 2 new smokes
- `specs/409-1541-phase-c-sync.md` (this)

## Next spec

Spec 410 — 1541 Phase D: VIA1 (IEC interface).
