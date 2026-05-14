# Spec 442 — viacore.c production-proof

**Status:** DONE
**Date:** 2026-05-14
**Branch:** `1541-literal-vice`
**Doctrine:** Claude-self literal audit. No subagents
([[feedback_1541_port_workflow]]).

## Source of truth

VICE `src/core/viacore.c` (2243 LoC) + `src/via.h` (252 LoC) is the
canonical model. TS `src/runtime/headless/via/via6522-vice.ts`
(1341 LoC pre-patch / ~1340 LoC post-patch) is the literal port.

## Audit coverage

Section-by-section verdict (per `docs/spec-442-viacore-mapping.md`):

| Section | VICE function family | Verdict |
|---|---|---|
| A | via.h constants + via_context_t struct (50 fields) | MATCH (modulo 3 omit-OK fields + 1 omit-OK enabled flag) |
| B.1 | viacore_disable | MISSING — ticketed-out (V1 single-drive, no caller) |
| B.2 | viacore_reset | MATCH (Phase 2 line-by-line) |
| B.3 | viacore_signal | MATCH (Phase 3) |
| B.4 | viacore_store (16 register paths) | MATCH (Phase 5 line-by-line) |
| B.5 | viacore_read / viacore_read_ (16 register paths) | MATCH (Phase 5) |
| B.6 | viacore_peek | MATCH (Phase 7, after IFR-raw fix) |
| B.7 | viacore_t1_zero_alarm | MATCH (assertion via test) |
| B.8 | set_cb2_output_state | MATCH (Phase 6) |
| B.9 | viacore_cache_cb12_io_status | MATCH (Phase 6) |
| B.10 | viacore_set_sr (burst hack) | MATCH (Phase 2) |
| B.11 | viacore_t2_zero_alarm | MATCH (assertion via test) |
| B.12 | viacore_t2_underflow_alarm | MATCH (assertion via test) |
| B.13 | viacore_t2_shift_alarm | MATCH (assertion via test) |
| B.14 | do_shiftregister (8-mode FSM) | MATCH (Phase 6) |
| B.15 | viacore_phi2_sr_alarm | MATCH (existing test) |
| B.16 | viacore_setup_context / viacore_init | MATCH (DEVIATION-ALLOWED — constructor pattern) |
| B.17 | viacore_shutdown | MISSING — ticketed-out (Spec 444 cleanup) |
| B.18 | viacore_snapshot_write_module | MATCH (state shape) |
| B.19 | viacore_snapshot_read_module | MISSING — ticketed-out (Spec 451 VSF) |
| B.20 | viacore_dump | OUT-OF-SCOPE (debug-only) |

## Patches applied in Spec 442

1. **MYVIA_NEED_LATCHING = false flag (Phase 4)** —
   `via6522-vice.ts:197-203` introduces literal-VICE-drive gate.
   7 functional latch sites gated:
   - `signal()` CA1 (`:431`)
   - `setCb1` (`:496`)
   - `read()` PRA / PRA_NHS / PRB (`:903,914,933`)
   - `peek()` PRA / PRA_NHS / PRB (`:1009,1016`)

2. **viacore_peek IFR raw (Phase 7)** — `via6522-vice.ts:1035-1039`
   was synthesising bit 7 from `(ifr & ier)`. VICE peek returns
   raw `ifr`. Synthesis lives in viacore_read only. Now matches
   `viacore.c:1284-1285`.

3. **Conformance tests** —
   `tests/unit/via/viacore-conformance.test.ts` (13 cases, all
   cite VICE line numbers).
   `tests/unit/via/via-ila-ilb-latch.test.ts` rewritten to assert
   literal-VICE-drive behaviour (MYVIA=false).

## Ticketed-out (deferred to later specs)

| Item | Target spec | Reason |
|---|---|---|
| `viacore_disable` + `enabled` flag | Spec 444 | No caller in V1 (single-drive headless); cleanup task |
| `viacore_shutdown` | Spec 444 | Process-exit alarm/string cleanup |
| `viacore_snapshot_read_module` | Spec 451 | VSF cross-load with VICE, out of V1 critical path |
| `viacore_dump` | OUT | Debug-only, never load-bearing |
| `read_clk / read_offset` | OMIT | Write-only in VICE viacore.c (`:403,1057,1833`), non-load-bearing |

## Verification

| Check | Result |
|---|---|
| `npm run build` (full) | PASS |
| `tests/unit/via/viacore-conformance.test.ts` | 13/13 PASS |
| `tests/unit/via/via-ila-ilb-latch.test.ts` (rewritten) | 5/5 PASS |
| `tests/unit/via/via-register-rw.test.ts` | 19/19 PASS |
| `tests/unit/via/via-ca-cb-handshake.test.ts` | 10/10 PASS |
| `tests/unit/via/via-sr-modes.test.ts` | 6/6 PASS |
| `tests/unit/via/via-t1-pb7-toggle.test.ts` | 8/8 PASS |
| `tests/unit/via/via-write-offset.test.ts` | 4/4 PASS |
| Total VIA unit suite | **65/65 PASS** |
| `tests/unit/drive/rotation.test.ts` | 15/15 PASS |
| `npm run canary:spec-430` (motm/mm-s1/im2/scramble/lnr-s1) | **5/5 PASS** (motm/mm-s1/im2/scramble smoke PASS, lnr-s1 red-as-expected) |

## Commits

```
f3be04b Spec 442 charter
365894a Spec 442 Phase 1 — mapping skeleton
a7d7e5b Spec 442 Phase 2 — reset/set_sr/read_clk verified
0f55072 Spec 442 Phase 3 — signal/set_cb1/set_cb2 audit
cd1d872 Spec 442 Phase 4 — MYVIA_NEED_LATCHING gate
????    Spec 442 Phase 5 — store/read audit
????    Spec 442 Phase 6+7 — shift_register / cache_cb12 / peek
????    Spec 442 Phase 8 — viacore-conformance + revised ila/ilb tests
????    Spec 442 Phase 9 — production-proof + PLAN/epic update (this)
```

## Doctrine compliance

- ☑ No subagent verdicts (every row authored by Claude reading
  both VICE and TS source side-by-side)
- ☑ "MACH es GENAU so wie VICE" — MYVIA gate + IFR-peek-raw fix
  prefer literal-VICE over silicon-correct alternatives
- ☑ No new TS-OO abstractions
- ☑ No "verbesserungen" — every TS-only convenience flagged or
  removed
- ☑ One source of truth restored (gating eliminates the
  divergence from VICE drive build)
- ☑ Sequential per [[feedback_sequential_specs]] — Spec 442
  closes before Spec 443 starts

## Open items for follow-on specs

1. **Spec 443** (via1d1541 + via2d1541 device wiring re-audit) —
   verify backend signatures + storePcr void-return tightening.
2. **Spec 444** (drivecpu literal + viacore_shutdown/disable) —
   port the lifecycle methods.
3. **Spec 451** (VSF cross-load validation) — implement
   `viacore_snapshot_read_module` + verify module-name matches
   VICE `my_module_name`.
