# Spec 444 — drivecpu literal port production-proof

**Status:** DONE (2026-05-14)
**Branch:** `1541-literal-vice`
**Doctrine:** Claude-self literal audit. No subagents.
[[feedback_1541_port_workflow]] + [[feedback_vice_no_alternatives]].

## Source of truth

- VICE `src/drive/drivecpu.c` (737 LoC)
- VICE `src/drive/drivecpu.h` (62 LoC)
- VICE `src/drive/drivetypes.h` (`drivecpu_context_t` @ 59-110)

## TS targets

- `src/runtime/headless/drive/drive-cpu.ts` (1321 → 1356 → 1320 LoC after Phase 4 purge)
- `src/runtime/headless/via/via6522-vice.ts` (Spec 442 + Spec 444 additions)
- `src/runtime/headless/via/via2d1541.ts` (Spec 444 additions)

## Audit coverage

`docs/spec-444-drivecpu-mapping.md` — 37-row mapping + 5 sub-row matrices
(B.1-B.5) + 3 deep-dive sections (E.1 execute, E.2 reset, E.3 jam) +
F-prime Phase 3 review-fix table + F.4 Phase 4 purge table.

## Final patch state (per-field / per-function, post-Phase-4)

This table is the **authoritative** end state. Earlier phases
(2a/2b/3) experimented with intermediate forms that Phase 4 superseded;
those intermediates are NOT current production code.

| VICE entity | Final TS state (post-Phase-4) |
|---|---|
| `drivecpu_context_t.stop_clk` | **PORTED-LITERAL**. `DriveCpu.stop_clk` public field, ADDITIVE across `executeToClock` calls per VICE drivecpu.c:388, used as inner-loop terminator (`while (cycled.cycles < stop_clk)`). |
| `drivecpu_context_t.last_exc_cycles` | **PORTED-LITERAL**. `DriveCpu.last_exc_cycles` public field, cleared in `softReset`/`reset` only — exactly matching VICE drivecpu_reset_clk:189. Phase 2b's invented `max(0, cycles - stop_clk)` formula was purged in Phase 4. |
| `drivecpu_context_t.is_jammed` | **PORTED-FIELD-ONLY**. Field present for snapshot compat; no V1 JAM dispatcher (stock 1541 DOS never JAMs). |
| `drivecpu_context_t.cycle_accum` | **PORTED-LITERAL**. Private `cycleAccum`, preserved across `softReset` per VICE drivecpu_reset_clk semantics. Hard `reset()` clears it (power-cycle). |
| `drivecpu_context_t.last_clk` | **PORTED-LITERAL**. Private `lastClk`, set to `c64Clk` argument in `softReset(c64Clk, pc?)` (= VICE `last_clk = maincpu_clk`). Signature enforces mid-run contract in code. |
| `via_context_t.enabled` (VIA1/VIA2) | **PORTED-LITERAL**. `Via6522Vice.enabled` field; `disable()` method sets `false` + alarm_unset × 5; `reset()` restores `true`. Per viacore.c:364-372 + :438. |
| `drivecpu_execute` (drivecpu.c:356-445) | **PORTED-LITERAL VICE-SHAPE**. `executeToClock(c64Clk)` mirrors VICE step-for-step: `drivecpuWakeUp` prologue → cycles delta → 10000-cycle outer chunking → `stop_clk += (cycleAccum >>> 16)` ADDITIVE → `cycleAccum &= 0xffff` fractional → `while (cycled.cycles < stop_clk) executeCycle()` inner loop → `lastClk = c64Clk` epilogue. Phase 2b's `while (cycleAccum >= 0x10000)` loop was purged in Phase 3; Phase 4 confirmed/extended. |
| `drivecpu_wake_up` (drivecpu.c:255-264) | **PORTED-LITERAL**. Private `drivecpuWakeUp(c64Clk)`: if `c64Clk - lastClk > 0xffffff && driveClk > 934639` then `lastClk = c64Clk`. Called at top of `executeToClock`. |
| `drivecpu_sleep` (drivecpu.c:266-269, empty body) | **PORTED-LITERAL no-op**. TS `sleeping` flag entirely purged in Phase 4 (was output-affecting TS-EXTRA). `wakeUp()` retained as no-op stub for VICE-name parity. |
| `drivecpu_set_overflow` (drivecpu.c:219-223) | **PORTED-LITERAL** (core) inside Spec 411/441-owned wrapper. `fireByteReady` at `drive-cpu.ts:854,856` sets `cpu.reg_p \|= 0x40` literal; richer wrapper (PCR gate + CA1 falling edge + onSoEdge trace) is Spec 411 + Spec 441 owned. |
| VIA2 IRQ propagation (via2d.c:113-122) | **PORTED-LITERAL chip-push**. Phase 4 added `Via2d1541.attachIrqLine(cpuIntStatus)`; `setInt` backend pushes to `InterruptCpuStatus.setIrq` with `chipPrev` guard. Polling at instruction boundary in `executeToClock` DROPPED. Mirrors Spec 410 VIA1 model. |
| VIA2 backend `reset` led_status | **PORTED-LITERAL**. `reset: () => { shadowDrive.led_status = 1; }` per via2d.c:423-431. |
| `driveDispatchMode` / "vice-whole-instruction" mode | **PURGED**. Was Spec 428 pre-rewrite Fehlversuch. Field, ctor opt, threading through `integrated-session.ts` + `headless-machine-kernel.ts`, env var `C64RE_DRIVE_DISPATCH`, smoke script, and Spec 428 doc all deleted (Spec 428 archived as SUPERSEDED-BY-444-PHASE-4). |
| `drivecpu_init` / `drivecpu_setup_context` | **PORTED-WRAPPER**. DriveCpu + DriveBus constructors inline VICE setup. See mapping B.1 sub-rows. |
| `drivecpu_reset` / `cpu_reset` / `drivecpu_reset_clk` | **PORTED-LITERAL**. `softReset(c64Clk, pc?)` mirrors VICE drivecpu_reset_clk: `last_clk = c64Clk`, `last_exc_cycles = 0`, `stop_clk = 0`, `cycle_accum` preserved. |
| `drivecpu_trigger_reset` (drivecpu.c:214-217) | **DEVIATION-DOCUMENTED**. TS uses sync `softReset` instead of VICE's async IK_RESET flag. Not load-bearing for V1 (no in-flight RMW between trigger and dispatch). |
| `drivecpu_shutdown` | **OMIT-OK**. VICE body is all C `lib_free`; TS GC. |
| `drivecpu_jam` dispatcher | **OMIT-OK** (V1 stock DOS never JAMs); `is_jammed` field exists for snapshot compat. |
| `drivecpu_snapshot_write/read_module` + `snap_module_name` | **DEFER → Spec 451** (VSF cross-load). |
| `drive_generic_dma`, banking, monitor, identification_string, R65C02_regs | **OUT (V1)** — DMA not in 1541, banking uses TS dispatch tables, no monitor UI, logging-only string, 6502 not 65C02. |
| Rotation tick AFTER cpu | **TICKETED → Spec 452** (OPEN). BEFORE pattern regresses Krill loader; root cause out of Spec 444 scope. Documented in `drive-cpu.ts:1232` comment + Spec 452. |

## Verdict tally (post-Phase-4)

| Verdict | Count |
|---|---|
| PORTED-LITERAL / PORTED-WRAPPER / PORTED-FIELD-ONLY | 13 |
| MATCH-DEVIATION (constructor pattern) | 2 (drivecpu_init / setup_context) |
| DEVIATION-DOCUMENTED | 1 (drivecpu_trigger_reset sync vs async) |
| OMIT-OK | 6 (shutdown, jam dispatcher, dump, identification, banking, R65C02) |
| OUT (V1) | 3 (DMA, monitor, parallel cable carve-outs from Spec 443) |
| DEFER → Spec 451 | 3 (snapshot R/W, snap_module_name, restore_int) |
| TICKETED → Spec 452 | 1 (rotation tick AFTER cpu) |
| PURGED in Phase 4 | 1 (driveDispatchMode kludge family) |
| **BUG / load-bearing MISSING** | **0** |

No `MINOR-DEVIATION` rows remain after Phase 4 purge. The 3 MINOR
rows in earlier phases (wake_up stale-skip, cycleAccum reset, JAM
dispatcher) were either fully ported (wake_up), corrected (cycleAccum
preserved), or kept as OMIT-OK (JAM).

## Verification

| Check | Result |
|---|---|
| `npm run build` (full) | PASS |
| `tests/unit/via/viacore-conformance.test.ts` | 15/15 |
| `tests/unit/via/via2-device-conformance.test.ts` | 16/16 |
| `tests/unit/via/via-device-conformance.test.ts` | 8/8 |
| `tests/unit/via/via-register-rw.test.ts` | 19/19 |
| `tests/unit/via/via-ca-cb-handshake.test.ts` | 10/10 |
| `tests/unit/via/via-sr-modes.test.ts` | 6/6 |
| `tests/unit/via/via-t1-pb7-toggle.test.ts` | 8/8 |
| `tests/unit/via/via-write-offset.test.ts` | 4/4 |
| `tests/unit/via/via-ila-ilb-latch.test.ts` | 5/5 |
| `tests/unit/drive/drivecpu-conformance.test.ts` | 9/9 |
| `tests/unit/drive/rotation.test.ts` | 15/15 |
| `tests/unit/drive/gcr-shifter.test.ts` | 13/13 |
| `tests/unit/drive/sync-detector.test.ts` | 11/11 |
| **Total unit suite** | **139/139 PASS** |
| `tests/integration/drivecpu-vs-vice-baseline.test.mjs` (NEW Phase 4) | **9999/9999 within ±1 cycle** (max observed delta = 1; assertion bounded ±2) over 10k VICE im2 drive8 instructions |
| `npm run canary:spec-430` | **5/5 PASS** (motm/mm-s1/im2/scramble smoke, lnr-s1 red-as-expected) |

## Commits

```
788d8be Spec 444 charter
5849474 Spec 444 Phase 1   — mapping skeleton (37 rows)
5b1ff87 Spec 444 Phase 1b  — 4 missing rows explicit (B.1-B.5 sub-matrices)
6c3c4d6 Spec 444 Phase 2a  — bundled cleanups (Via6522Vice.disable + VIA2 LED + storePcr correction)
2bed9c8 Spec 444 Phase 2b  — drivecpu_context_t fields + execute audit
0b1e46b Spec 444 v1 close  — (superseded by Phase 3)
cd9ad49 Spec 444 doc fixup — fill commit SHA
9e2edd8 Spec 444 Phase 3   — VICE-literal loop shape + wake_up port + Spec 411 IRQ migration
d9eae14 Spec 444 Phase 4   — TS-EXTRA purge + VICE-baseline cycle-diff smoke (this proof)
```

Phase boundaries explain the size: Phase 2a/2b were valid intermediate
ports; Phase 3 + Phase 4 superseded them with user-review feedback.
Final state is what's described in "Final patch state" above; earlier
intermediates are committed history only.

## Doctrine compliance

- ☑ No subagent verdicts (every row Claude-authored)
- ☑ "MACH es GENAU so wie VICE" — Phase 4 purged all TS-EXTRA
  divergences from production path (sleeping, dispatchMode, invented
  last_exc_cycles formula)
- ☑ No new TS-OO abstractions
- ☑ No "verbesserungen" — literal-VICE shape including cycle-stepped-only
  dispatch
- ☑ One source of truth — Spec 428 archived as superseded
- ☑ Sequential per [[feedback_sequential_specs]] — Spec 444 closes
  before Spec 445 starts
- ☑ Review-doctrine: 4 missing rows explicit (Phase 1b); 5 doctrine
  violations all addressed (Phase 3); TS-EXTRA purge complete (Phase 4)
- ☑ VICE-oracle smoke: cycle-diff vs VICE im2 baseline 9999/9999
  within ±1 cycle

## Open items for follow-on specs

1. **Spec 452** — rotation tick BEFORE cpu (currently AFTER, Krill
   regression blocker). Dedicated drive-timing spec inside Epic 440
   (pre-rewrite Spec 412 is archived; not a valid live reference).
2. **Spec 445** — gcr.c write-path + encode (next sequential spec).
3. **Spec 451** — VSF cross-load: drivecpu_snapshot_write/read_module,
   snap_module_name, restore_int.
