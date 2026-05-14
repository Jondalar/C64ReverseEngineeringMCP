# Spec 444 — drivecpu literal port production-proof

**Status:** DONE
**Date:** 2026-05-14
**Branch:** `1541-literal-vice`
**Doctrine:** Claude-self literal audit. No subagents.

## Source of truth

- VICE `src/drive/drivecpu.c` (737 LoC)
- VICE `src/drive/drivecpu.h` (62 LoC)
- VICE `src/drive/drivetypes.h` (`drivecpu_context_t` @ 59-110)

## TS targets

- `src/runtime/headless/drive/drive-cpu.ts` (1321→1356 LoC)
- `src/runtime/headless/via/via6522-vice.ts` (Spec 442 + Phase 2a additions)
- `src/runtime/headless/via/via2d1541.ts` (Phase 2a additions)

## Audit coverage

`docs/spec-444-drivecpu-mapping.md` — 37-row mapping + 5 sub-row
matrices (B.1-B.5) + Phase 2b deep-dive sections (E.1-E.3).

| Section | Scope | Verdict |
|---|---|---|
| A | `drivecpu_context_t` struct (20 fields) | 12 PORTED / MATCH, 6 OMIT-OK (debug/monitor/banking), 2 DEFER → Spec 451 |
| B | `drivecpu.c` functions (17) | 8 PORTED-WRAPPER / PORTED-IMPLICIT, 3 DEVIATION-DOCUMENTED, 6 OMIT-OK / DEFER |
| B.1 | `drivecpu_setup_context` sub-rows (9) | All PORTED-WRAPPER or OMIT-OK |
| B.2 | `drivecpu_trigger_reset` | DEVIATION-DOCUMENTED (sync vs async; not load-bearing V1) |
| B.3 | `drivecpu_set_overflow` | PORTED-WRAPPER (literal V flag at `drive-cpu.ts:854,856` inside richer fireByteReady wrapper) |
| B.4 | `drivecpu_shutdown` | OMIT-OK (all C `lib_free`; TS GC handles) |
| B.5 | `drivecpu_set_irq` analog | PORTED-LITERAL (Spec 410 chip-side push via `Via1d1541.attachIrqLine`) |
| D | Bundled cleanups (4) | 3 PATCHED (disable, LED, =null on storePcr correction), 1 OMIT-OK (shutdown) |
| E.1 | `drive_cpu_execute` ↔ `executeToClock` | PORTED-WRAPPER; 3 sub-deviations documented (chunking, sleeping, dispatch mode) |
| E.2 | `cpu_reset` / `drivecpu_reset` / `drivecpu_reset_clk` | 7-row sub-matrix; 2 DEVIATION-DOCUMENTED (lastClk peg, cycleAccum clear) |
| E.3 | `drivecpu_jam` | OMIT-OK (V1 stock DOS never JAMs; field present for snapshot) |

**Verdict tally:**
- MATCH / MATCH-WRAPPER / PORTED: 22
- MATCH-DEVIATION (constructor pattern): 6
- DEVIATION-DOCUMENTED (sync vs async reset, lastClk peg, cycleAccum): 3
- MINOR-DEVIATION (wake_up stale-skip, JAM dispatcher): 3
- OMIT-OK (monitor, DMA, banking, debug, identification, JAM, shutdown): 9
- DEFER → Spec 451 (snapshot R/W, snap_module_name): 3
- **BUG / load-bearing MISSING: 0**

## Patches applied in Spec 444

### Phase 2a — bundled cleanups (Spec 442/443 ticketed)

1. **`Via6522Vice.disable()` + `enabled` field** (`via6522-vice.ts:295-303,
   416-436`). Literal port of VICE `viacore_disable` (viacore.c:364-372):
   - 5 alarm_unset calls + `enabled = false`
   - `reset()` restores `enabled = true` (viacore.c:438)

2. **VIA2 backend reset mirrors `led_status = 1` to shadowDrive**
   (`via2d1541.ts:179-187`). Literal port of VICE `via2d.c:423-431`.
   Replaces previous no-op reset.

3. **storePcr void-tightening — CORRECTION**: VICE viacore.h:211 actually
   declares `uint8_t store_pcr(...)`. TS BYTE return MATCH. Spec 442
   initial mapping was wrong. No patch needed.

4. **viacore_shutdown**: VICE body is all `lib_free` C-alloc calls; TS GC
   handles. OMIT-OK documented.

### Phase 2b — drivecpu_context_t struct fields + execute audit

5. **`DriveCpu.stop_clk`** (`drive-cpu.ts:706-717`). Public field; set at
   `executeToClock` entry to `cpu.cycles + (cycleAccum >>> 16)`. Mirrors
   VICE drivecpu.c:388.

6. **`DriveCpu.last_exc_cycles`** (`drive-cpu.ts:720-727`). Public field;
   computed at end of `executeToClock` inner loop as
   `max(0, consumed - target)`. Mirrors VICE drivetypes.h:81.

7. **`DriveCpu.is_jammed`** (`drive-cpu.ts:730-739`). Public field; V1
   has no JAM dispatcher (stock DOS never executes JAM opcodes).
   Snapshot compat only.

## Ticketed-out (deferred)

| Item | Target | Reason |
|---|---|---|
| `drivecpu_snapshot_write_module` | Spec 451 | VSF format |
| `drivecpu_snapshot_read_module` | Spec 451 | VSF format |
| `snap_module_name` | Spec 451 | VSF cross-load |
| `drivecpu_jam` dispatcher | OUT (V1) | Stock DOS never JAMs |
| `drivecpu_wake_up` stale-clock-skip | low-priority | Not load-bearing V1 |
| `drivecpu_shutdown` explicit teardown | OUT (V1) | TS GC handles |
| `drivecpu_trigger_reset` async via IK_RESET | OUT (V1) | Not load-bearing for V1 |
| `monitor_interface` | OUT (V1) | No monitor UI |
| `identification_string` | OUT (V1) | Logging only |
| `d_bank_base/start/limit/pageone` | OUT | TS uses readTab/storeTab dispatch |
| `drive_generic_dma` | OUT | DMA not in V1 1541 |

## Verification

| Check | Result |
|---|---|
| `npm run build` (full) | PASS |
| `tests/unit/via/viacore-conformance.test.ts` | 15/15 PASS (+2 disable/reset) |
| `tests/unit/via/via2-device-conformance.test.ts` | 16/16 PASS (+1 reset led_status) |
| `tests/unit/via/via-device-conformance.test.ts` | 8/8 PASS |
| `tests/unit/via/via-register-rw.test.ts` | 19/19 PASS |
| `tests/unit/via/via-ca-cb-handshake.test.ts` | 10/10 PASS |
| `tests/unit/via/via-sr-modes.test.ts` | 6/6 PASS |
| `tests/unit/via/via-t1-pb7-toggle.test.ts` | 8/8 PASS |
| `tests/unit/via/via-write-offset.test.ts` | 4/4 PASS |
| `tests/unit/via/via-ila-ilb-latch.test.ts` | 5/5 PASS |
| **Total VIA suite** | **91/91 PASS** (9 files; +3 Spec 444) |
| `tests/unit/drive/drivecpu-conformance.test.ts` (NEW) | 6/6 PASS |
| `tests/unit/drive/rotation.test.ts` | 15/15 PASS |
| `tests/unit/drive/gcr-shifter.test.ts` | 13/13 PASS |
| **Total drive suite** | **34/34 PASS** (3 files; +6 Spec 444) |
| `npm run canary:spec-430` | **5/5 PASS** (motm/mm-s1/im2/scramble smoke, lnr-s1 red-as-expected) |

## Commits

```
788d8be Spec 444 charter
5849474 Spec 444 Phase 1 — mapping skeleton
5b1ff87 Spec 444 Phase 1b — 4 missing rows explicit (review-doctrine)
6c3c4d6 Spec 444 Phase 2a — bundled cleanups from Spec 442/443
2bed9c8 Spec 444 Phase 2b — drivecpu_context_t fields + execute audit
0b1e46b Spec 444 DONE — production-proof + PLAN/epic update
```

## Doctrine compliance

- ☑ No subagent verdicts
- ☑ "MACH es GENAU so wie VICE" — fields literal + executeToClock
  semantics audited line-by-line
- ☑ No new TS-OO abstractions
- ☑ No "verbesserungen"
- ☑ One source of truth maintained
- ☑ Sequential per [[feedback_sequential_specs]] — Spec 444 closes
  before Spec 445 starts
- ☑ Phase 1b doctrine-review compliance: 4 missing rows explicit
  before any Phase 2b code touched (user-flagged "no audit-subagent
  fail-mode")

## Open items for follow-on specs

1. **Spec 445** (gcr.c write-path + encode) — gcr_decode_block already
   audited (Spec 430); write-path port + encode complete the chip.
2. **Spec 451** (VSF cross-load) — implement drivecpu/viacore snapshot
   R/W; snap_module_name verification; full state-restore.
