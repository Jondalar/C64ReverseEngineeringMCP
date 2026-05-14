# Spec 446 — `drivesync.c` PAL/NTSC switch logic literal port

**Status:** OPEN
**Priority:** HIGH
**Parent:** Epic 440
**Depends on:** Spec 441-445 (rotation, viacore, devices, drivecpu, gcr)
**Doctrine:** Claude-self literal audit. No subagents.

**Anchors:**
- `docs/vice-1541-arch.md` §5.1 (sync_factor formula), §5.3 (PAL/NTSC)
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drivesync.c` (117 LoC)
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drivesync.h` (38 LoC)
- `/Users/alex/Development/C64/Tools/vice/vice/src/c64/c64.h:35,42` (PAL/NTSC constants)

## Klartext

`drivesync.c` ist klein (117 LoC, 5 functions). Aktueller TS-stand
per chip-matrix: "NUR PAL-CONST". Aber reading the code: `DriveCpu.
driveSetMachineParameter(cyclesPerSec)` exists + matches VICE literal
math (`Math.floor(65536 * 1000000 / cyclesPerSec)`). NTSC constant
exported (1022730). So most of drivesync is already in.

What's actually missing:
1. `drivesync_clock_frequency(unit, type)` — type-to-frequency
   dispatch literal (1541 = 1). Trivial for V1 single-type drive
   but needed for VICE-shape parity.
2. Explicit `setPalNtsc(mode)` convenience helper that calls
   `driveSetMachineParameter` with the right constant.
3. Tests for PAL/NTSC switch + sync_factor application.

Per Epic 440 doctrine ([[feedback_pal_first_ntsc_later]] — PAL is
production, NTSC validation deferred): Spec 446 ports the **switch
mechanism** but Spec 451 still owns NTSC regression validation.

## VICE source of truth

| File | LoC | Functions |
|---|---|---|
| `drive/drivesync.c` | 117 | `drive_sync_cpu_set_factor` (static), `drivesync_factor`, `drive_set_machine_parameter`, `drivesync_set_1571`, `drivesync_set_4000`, `drivesync_clock_frequency` |
| `drive/drivesync.h` | 38 | public API: `drivesync_factor`, `drivesync_set_1571`, `drivesync_set_4000`, `drivesync_clock_frequency` |

## Headless target

`src/runtime/headless/drive/drive-cpu.ts` — existing:
- `C64_PAL_CYCLES_PER_SEC = 985248` const
- `C64_NTSC_CYCLES_PER_SEC = 1022730` const
- `DriveCpu.clockFrequency: 1` const (1541-only)
- `DriveCpu.syncFactor16dot16` mutable field
- `DriveCpu.driveSetMachineParameter(cyclesPerSec)` literal VICE
- `DriveCpu.setSyncRatio(driveCyclesPerC64Cycle)` legacy convenience

## Scope

In scope (1541-only V1):
- `drive_set_machine_parameter(cycles_per_sec)` — already PORTED as
  `driveSetMachineParameter`. **Re-audit** line-by-line vs VICE.
- `drivesync_factor(drv)` — apply sync_factor with clock_frequency.
  For 1541 always `clockFrequency * sync_factor` = `1 * sync_factor`.
  **Verify** TS applies this correctly.
- `drivesync_clock_frequency(unit, type)` — type→frequency dispatch.
  Spec 446 port: 1541 = 1; other 1541-family rows in switch table
  literal (V1 only uses 1541 but the table must mirror VICE).
- `setPalNtsc(mode: "pal" | "ntsc")` convenience helper —
  TS-EXTRA but documented as wrapper around
  `driveSetMachineParameter`.

Out of scope (other specs / OUT V1):
- `drivesync_set_1571` — 1571 2MHz switch (1571 OUT V1 per Spec 440)
- `drivesync_set_4000` — 4000-series (OUT V1)
- Per-drive `sync_factor` static (TS uses per-instance; semantic
  equivalent for single-drive V1)

## Acceptance

1. `docs/spec-446-drivesync-mapping.md` row-per-function verdict
   matrix.
2. Each BUG → fix patch.
3. Each MISSING → port-patch.
4. `tests/unit/drive/drivesync-conformance.test.ts` (NEW) PASS:
   - PAL syncFactor = floor(65536 * 1000000 / 985248) = 66518
   - NTSC syncFactor = floor(65536 * 1000000 / 1022730) = 64079
   - Switch PAL → NTSC mid-session re-applies factor
   - `clockFrequency` multiplier honoured (`drivesync_factor` analog)
   - `drivesync_clock_frequency` returns 1 for 1541
5. `npm run canary:spec-430` 5/5 PASS.
6. `tests/integration/drivecpu-vs-vice-baseline.test.mjs` 9999/9999
   within ±1 (no regression).
7. `docs/spec-446-production-proof.md` committed.
8. No subagent verdicts.

## Do Not

- Do not delegate audit to subagent.
- Do not port 1571 / 4000-series helpers (OUT V1).
- Do not start Spec 447 before 446 DONE.

## Workflow gates

7-step per [[feedback_1541_port_workflow]].
