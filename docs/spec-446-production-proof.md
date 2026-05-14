# Spec 446 — drivesync.c production-proof

**Status:** DONE (2026-05-14)
**Branch:** `1541-literal-vice`
**Doctrine:** Claude-self literal audit. No subagents.

## Source of truth

- VICE `src/drive/drivesync.c` (117 LoC)
- VICE `src/drive/drivesync.h` (38 LoC)
- VICE `src/c64/c64.h:35,42` — PAL/NTSC constants

## TS targets

- `src/runtime/headless/drive/drive-cpu.ts` (constants + 3 methods)

## Audit coverage

`docs/spec-446-drivesync-mapping.md` — 11 row mapping (5 constants +
6 functions).

## Final state

| Verdict | Count | Notes |
|---|---|---|
| PORTED-LITERAL | 5 | 3 constants + driveSetMachineParameter + drivesync_clock_frequency |
| MATCH-INLINED | 2 | drive_sync_cpu_set_factor + drivesync_factor inlined into driveSetMachineParameter |
| DEVIATION-OK | 1 | sync_factor module-static → per-instance (single-drive V1 = MATCH; multi-drive future would need fan-out) |
| OUT (V1) | 2 | drivesync_set_1571 + drivesync_set_4000 (non-1541 drives, Spec 440 carve-out) |
| TS-EXTRA | 1 | setPalNtsc convenience helper |
| **BUG / load-bearing MISSING** | **0** |

## Patches applied (Spec 446)

1. `DriveCpu.drivesync_clock_frequency(driveType): 1 | 2` static method
   — literal VICE drivesync.c:86-117 dispatch table. 1541-family = 1,
   1551/1581/4000-family = 2, IEEE drives = 1, default = 1.
2. `DriveCpu.setPalNtsc(mode: "pal" | "ntsc")` instance method —
   wraps `driveSetMachineParameter` with the correct C64 cycles
   constant.

## Findings

- `drive_set_machine_parameter` was already PORTED-LITERAL in Spec 409
  (`DriveCpu.driveSetMachineParameter`). Spec 446 audit confirms
  bit-identical formula `Math.floor(65536.0 * (1000000.0 / cyclesPerSec))`
  + `clock_frequency * sync_factor` multiplier applied.
- PAL sync_factor = 66517 (0x103D5), NTSC = 64079 (0xFA4F).
  Hand-computed from VICE formula in tests for bilateral-bug defense.
- **`drivesync_clock_frequency` result NOT instance-wired.**
  `DriveCpu.clockFrequency` is hardcoded `1` (1541-only V1 const).
  The new static `drivesync_clock_frequency(driveType)` returns the
  correct table value but its output is not consumed anywhere — pure
  utility. For V1 1541-only this is observable-equivalent
  (clockFrequency = 1 either way). Multi-drive future port (Spec 451)
  must wire `instance.clockFrequency =
  DriveCpu.drivesync_clock_frequency(type)` in the constructor.
- No regression in canary or integration cycle-diff (Spec 444).

## Ticketed-out (deferred)

| Item | Target | Reason |
|---|---|---|
| `drivesync_set_1571` | OUT V1 | 1571 not in Spec 440 V1 scope |
| `drivesync_set_4000` | OUT V1 | 4000-series not in V1 |
| Multi-drive `sync_factor` fan-out | Spec 451 (multi-drive) | V1 = single 1541 (single instance carries the value) |
| `drivesync_clock_frequency` wire-up to instance | Spec 451 (multi-drive) | static utility unconsumed; multi-drive needs ctor to set `instance.clockFrequency` from dispatch table |
| Function split (drive_sync_cpu_set_factor + drivesync_factor inlined into driveSetMachineParameter) | Spec 451 (multi-drive) | VICE drivesync.c keeps three separate fns for the `for(dnr=0; dnr<NUM_DISK_UNITS; dnr++)` fan-out loop in `drive_set_machine_parameter`. Single-drive V1 = semantic MATCH; multi-drive port must split back into three methods to reproduce the loop. |
| NTSC regression validation | Spec 451 | full-game NTSC test |

## Verification

| Check | Result |
|---|---|
| `npm run build` | PASS |
| `tests/unit/drive/drivesync-conformance.test.ts` (NEW) | 17/17 PASS |
| `tests/integration/drivecpu-vs-vice-baseline.test.mjs` | 9999/9999 within ±1 (no regression) |
| `npm run canary:spec-430` | **5/5 PASS** |
| All other unit suites | 167/167 PASS (no regression) |
| **Total unit suite** | **184/184 PASS** |

## Commits

```
058bc45 Spec 446 charter — drivesync.c PAL/NTSC switch literal port
5819f56 Spec 446 DONE — drivesync_clock_frequency + setPalNtsc + 17 tests
????    Spec 446 doc-hygiene — fill SHAs + archive duplicate charter + wire-up findings (this)
```

## Doctrine compliance

- ☑ No subagent verdicts
- ☑ "MACH es GENAU so wie VICE" — drive_set_machine_parameter
  literal already PORTED in Spec 409; drivesync_clock_frequency
  dispatch table verbatim
- ☑ Hand-computed PAL/NTSC sync_factor pins (bilateral defense)
- ☑ PAL-first per [[feedback_pal_first_ntsc_later]] — NTSC switch
  mechanism ported, full NTSC game validation = Spec 451
- ☑ Sequential per [[feedback_sequential_specs]] — 446 closes
  before 447 starts

## Open for follow-on specs

1. **Spec 447** — memiec.c + driverom.c literal.
2. **Spec 451** — NTSC regression test (full-game canary in NTSC mode).
