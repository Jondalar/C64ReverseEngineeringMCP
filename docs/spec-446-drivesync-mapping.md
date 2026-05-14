# Spec 446 — drivesync.c ↔ drive-cpu.ts mapping

**Status:** DONE (2026-05-14)
**VICE source:** `src/drive/drivesync.c` (117 LoC) + `src/drive/drivesync.h` (38 LoC)
**TS target:** `src/runtime/headless/drive/drive-cpu.ts` (constants + 3 methods)
**Doctrine:** Claude-self, no subagents.

Verdict legend: MATCH / PORTED / DEVIATION / OMIT-OK / OUT.

---

## A. Constants

| VICE | Lines | TS | Verdict |
|---|---|---|---|
| `C64_PAL_CYCLES_PER_SEC = 985248` | c64.h:35 | `C64_PAL_CYCLES_PER_SEC` (drive-cpu.ts:102) | **PORTED-LITERAL** |
| `C64_NTSC_CYCLES_PER_SEC = 1022730` | c64.h:42 | `C64_NTSC_CYCLES_PER_SEC` (drive-cpu.ts:104) | **PORTED-LITERAL** |
| `1000000.0` drive freq literal (drivesync.c:57) | — | `DRIVE_NOMINAL_HZ = 1_000_000` (drive-cpu.ts:111) | **PORTED-LITERAL** |
| `static unsigned int sync_factor` module-static | drivesync.c:39 | per-instance `DriveCpu.syncFactor16dot16` | DEVIATION-OK (single-drive V1 = semantic MATCH; multi-drive would need module-static + fan-out) |

## B. Functions

| VICE function | Lines | TS counterpart | Verdict |
|---|---|---|---|
| `drive_sync_cpu_set_factor(drv, sf)` static helper | 41-45 | inlined into `driveSetMachineParameter` | MATCH-INLINED |
| `drivesync_factor(drv)` — apply `clock_frequency * sync_factor` | 47-51 | inlined into `driveSetMachineParameter` body (`this.clockFrequency * Math.floor(...)`) | MATCH-INLINED |
| `drive_set_machine_parameter(cycles_per_sec)` | 53-62 | `DriveCpu.driveSetMachineParameter(cyclesPerSec)` (drive-cpu.ts:971) — `Math.floor(65536.0 * (1000000.0 / cyclesPerSec))` literal | **PORTED-LITERAL** |
| `drivesync_set_1571(drv, new_sync)` | 64-76 | — | **OUT (V1)** — 1571 OUT per Spec 440 |
| `drivesync_set_4000(drv, new_sync)` | 78-84 | — | **OUT (V1)** — 4000-series OUT |
| `drivesync_clock_frequency(unit, type)` | 86-117 | `DriveCpu.drivesync_clock_frequency(driveType)` static (Spec 446 port) — full dispatch table | **PORTED-LITERAL** |

## C. Spec 446 additions

1. **`DriveCpu.drivesync_clock_frequency(driveType)`** static method
   — literal port of VICE drivesync.c:86-117. Returns 1 or 2 per drive
   type. For 1541-family (1540/1541/1541II/1570/1571/1571CR) = 1.
   For 1551/1581/2000/4000/CMDHD = 2. For IEEE drives (2031/2040/3040/
   4040/1001/8050/8250/9000) = 1. Default = 1. Unreachable in V1
   (1541-only) but ported for VICE-shape parity.

2. **`DriveCpu.setPalNtsc(mode)`** convenience helper — wraps
   `driveSetMachineParameter(C64_PAL_CYCLES_PER_SEC)` or
   `(C64_NTSC_CYCLES_PER_SEC)`. TS-EXTRA documented as wrapper.

## D. Summary

5 constants + 6 functions = **11 rows**.

| Verdict | Count |
|---|---|
| PORTED-LITERAL | 5 (3 constants + driveSetMachineParameter + drivesync_clock_frequency) |
| MATCH-INLINED | 2 (drive_sync_cpu_set_factor + drivesync_factor — inlined into driveSetMachineParameter) |
| DEVIATION-OK | 1 (sync_factor module-static → per-instance; single-drive V1 semantic MATCH) |
| OUT (V1) | 2 (drivesync_set_1571 + drivesync_set_4000 — non-1541 drives) |
| TS-EXTRA | 1 (setPalNtsc convenience helper) |
| **BUG / load-bearing MISSING** | **0** |

## E. Tests

`tests/unit/drive/drivesync-conformance.test.ts` (NEW, 17 tests):
- Constants pinned: PAL=985248, NTSC=1022730, DRIVE_NOMINAL_HZ=1e6.
- SYNC_FACTOR_1541_PAL = 66517 (0x103D5, hand-computed: floor(65536e6/985248)).
- SYNC_FACTOR_1541_NTSC = 64079 (0xFA4F).
- driveSetMachineParameter PAL/NTSC application.
- clock_frequency multiplier honoured.
- driveSetMachineParameter rejects zero/negative cyclesPerSec.
- setPalNtsc PAL/NTSC + mid-session switch.
- drivesync_clock_frequency dispatch for 1541 / 1551 / 4000 / IEEE / unknown.
- DriveCpu (1541) clockFrequency = 1 const.

All 17 PASS first run.