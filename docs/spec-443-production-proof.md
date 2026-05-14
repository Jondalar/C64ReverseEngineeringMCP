# Spec 443 — via1d1541 + via2d device port production-proof

**Status:** DONE
**Date:** 2026-05-14
**Branch:** `1541-literal-vice`
**Doctrine:** Claude-self literal audit. No subagents.

## Source of truth

- VICE `src/drive/iec/via1d1541.c` (420 LoC) + `.h`
- VICE `src/drive/iecieee/via2d.c` (566 LoC)

## TS targets

- `src/runtime/headless/via/via1d1541.ts` (360 LoC) — VIA1 device
  wrapper + backend
- `src/runtime/headless/via/via2d1541.ts` (250 LoC) — VIA2 device
  wrapper + backend
- `src/runtime/headless/drive/via2-gcr-shifter-coupling.ts` (209 LoC)
  — VIA2 rotation hookup (Spec 441 owned, re-verified)
- `src/runtime/headless/iec/iec-bus-core.ts` — IEC bus state +
  `drive_store_pb` literal port

## Audit coverage

`docs/spec-443-via-device-mapping.md` — 48 row mapping.

| Section | Coverage | Verdict |
|---|---|---|
| A.1 VIA1 backend callbacks (17 rows) | set_ca2/cb2/int/restore_int, undump/store_pra/prb/pcr/acr, store_sr/t2l, reset, read_pra/prb | 11 MATCH + 4 OMIT-OK + 2 carve-out |
| A.2 VIA1 setup/init (2 rows) | viacore_init, setup_context | DEVIATION-OK (constructor pattern) |
| A.3 VIA1 bus entries (4 rows) | store/read/peek/dump | 3 MATCH + 1 OMIT-OK |
| B.1 VIA2 backend callbacks (14 rows) | set_ca2/cb2/int, via2d_update_pcr, store_pra/prb/pcr/acr/sr/t2l, reset, read_pra/prb | 12 MATCH (Spec 441 owned) + 1 MINOR (reset led_status=1) + 1 OMIT-OK |
| B.2 VIA2 setup/bus (5 rows) | init, setup_context, store/read/peek/dump | DEVIATION-OK + MATCH + OMIT-OK |
| C DDR formulae (4 rows) | VIA1 PA/PB read, VIA2 PA/PB read | MATCH |

**Verdict tally:**
- MATCH: 41
- MATCH-with-extension: 2
- MINOR-DEVIATION: 2 (VIA2 reset led_status=1; storePcr signature)
- OMIT-OK: 9 (undumps, dumps, restore_int, 1571/parallel cable)
- **BUG / MISSING (load-bearing): 0**

## Patches applied in Spec 443

None — all paths already MATCH after Spec 441 (rotation flip) + Spec 442
(MYVIA gate + peek-raw fix). Spec 443 was an audit-only spec verifying
the device wrappers against VICE post-441/442 changes.

## Phase 2 deep-dive results (5 open rows)

| Row | Verdict | Detail |
|---|---|---|
| `iec.drive_store_pb` body | MATCH | bit-for-bit vs VICE store_prb 229-241 |
| VIA1 attachIrqLine guard | MATCH-with-extension | Spec 410 chip-side push; chipPrev single-fire |
| VIA1 CA1 ATN edge | MATCH | Spec 432 path; canary 5/5 PASS confirms post-441/442 |
| VIA2 store_prb | MATCH | Spec 441 owned; all 6 sub-paths verified |
| VIA2 reset | MINOR-DEVIATION | TS no-op vs VICE `led_status=1`; UI-only, not load-bearing |

## Ticketed-out (deferred)

| Item | Target spec | Reason |
|---|---|---|
| `undump_pra/prb/pcr/acr` (VIA1 + VIA2) | Spec 451 | VSF reload only |
| `restore_int` (VIA1 + VIA2) | Spec 451 | VSF reload |
| `via1d1541_dump` / `via2d_dump` | OUT | Debug-only |
| `read_pra` parallel cable cases | OUT (V1) | No parallel cable in V1 (Epic 440) |
| `read_pra` 1571 path | OUT (V1) | 1571 own epic; 1541-only V1 |
| VIA2 reset `led_status=1` tightening | low-priority | UI-only, optional |

## Verification

| Check | Result |
|---|---|
| `npm run build` (full) | PASS |
| `tests/unit/via/via-device-conformance.test.ts` (new) | 8/8 PASS |
| `tests/unit/via/viacore-conformance.test.ts` | 13/13 PASS |
| `tests/unit/via/via-register-rw.test.ts` | 19/19 PASS |
| `tests/unit/via/via-ca-cb-handshake.test.ts` | 10/10 PASS |
| `tests/unit/via/via-sr-modes.test.ts` | 6/6 PASS |
| `tests/unit/via/via-t1-pb7-toggle.test.ts` | 8/8 PASS |
| `tests/unit/via/via-write-offset.test.ts` | 4/4 PASS |
| `tests/unit/via/via-ila-ilb-latch.test.ts` | 5/5 PASS |
| **Total VIA unit suite** | **73/73 PASS** across 8 files |
| `tests/unit/drive/rotation.test.ts` | 15/15 PASS |
| `npm run canary:spec-430` | **5/5 PASS** (motm/mm-s1/im2/scramble smoke PASS, lnr-s1 red-as-expected) |

## Commits

```
7900c38 Spec 443 charter
56c3579 Spec 443 Phase 1 — mapping skeleton
c9c66d9 Spec 443 Phase 2 — VIA1/VIA2 deep-dive resolved
9637b3a Spec 443 Phase 3 — device-level conformance tests (8/8)
2e8fb78 Spec 443 DONE — production-proof + PLAN/epic update
```

## Doctrine compliance

- ☑ No subagent verdicts (every row Claude-authored)
- ☑ "MACH es GENAU so wie VICE" — no patch needed since paths
  already literal post-Spec-441/442
- ☑ No new TS-OO abstractions
- ☑ No "verbesserungen"
- ☑ One source of truth maintained
- ☑ Sequential per [[feedback_sequential_specs]] — Spec 443
  closes before Spec 444 starts

## Open items for follow-on specs

1. **Spec 444** (drivecpu literal + viacore_shutdown/disable) —
   port lifecycle + clean up storePcr void-tightening + VIA2
   reset led_status if cheap.
2. **Spec 451** (VSF cross-load) — implement undumps, restore_int,
   snapshot read; verify module-name matches.
