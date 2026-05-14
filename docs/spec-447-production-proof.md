# Spec 447 — memiec.c + driverom.c production-proof

**Status:** DONE (2026-05-14, 1541 V1 scope)
**Branch:** `1541-literal-vice`
**Doctrine:** Claude-self literal audit. No subagents.

## Source of truth

- VICE `src/drive/iec/memiec.c` (281 LoC)
- VICE `src/drive/driverom.c` (544 LoC)
- VICE `src/drive/iec/iecrom.c:78-178` (ROM image expansion for stock
  16K → 32K trap_rom mirror semantics)

## TS targets

- `src/runtime/headless/drive/drive-cpu.ts` (DriveBus dispatch tables)
- `src/runtime/headless/drive/drive-rom.ts` (ROM IO)

## Audit coverage

`docs/spec-447-memiec-driverom-mapping.md` — 30+ row mapping
(memiec dispatch ranges + static helpers + driverom functions).

## Final state

| Verdict | Count |
|---|---|
| MATCH / MATCH-INLINED | 22 (1541 dispatch ranges + static helpers) |
| PORTED-LITERAL (Spec 447 patch) | 2 (ROM mirrors $80-$9F + $A0-$BF) |
| MATCH-IMPLICIT | 2 (driverom_load + driverom_init) |
| OUT V1 | 5 (RAM expansion flags, non-1541 cases, DS1216 RTC) |
| DEFER → Spec 451 | 2 (driverom snapshot R/W) |
| TS-EXTRA-NOT-PORTED | 1 (driverom_initialize_traps optimization) |
| OMIT (UI) | 1 (driverom_test_load) |
| **BUG / load-bearing MISSING** | **0** |

## Spec 447 patches

1. **ROM mirror $80-$BF** (`drive-cpu.ts:511-575`):
   Literal port of VICE memiec.c:169 + memiec.c:174.
   - $80-$9F → `romReadLow` reads `rom[0..$1FFF]`
   - $A0-$BF → `romReadMid` reads `rom[$2000..$3FFF]`
   On stock 1541 16K split-ROM, this mirrors the canonical
   $C000-$FFFF data (VICE iecrom.c:175-178 duplicates 16K into both
   halves of the 32K trap_rom buffer). TS rom buffer = 16K canonical
   → reading low/mid offsets returns same bytes as the canonical
   window. Verified by 4 mirror-equivalence tests.

## Findings

- 1541 stock memory dispatch was already nearly complete in TS
  pre-Spec-447 (Sprint 113 Phase 2 built readTab/storeTab/peekTab
  dispatch with VICE memiec.c:138-176 line cites). Spec 447 closes
  the only gap: $80-$BF ROM mirror.
- `drive_read_zero/store_zero/peek_zero` (memiec.c:112-128) are
  semantically identical to RAM read/write for V1 1541. TS unifies
  them under a single RAM handler — VICE separates for 6510 zero-page
  addressing-mode fast-path. Observable behaviour identical.
- `drive_store_*` all set `cpu_last_data = value` per VICE; TS
  `ramStore` sets `this.lastBusValue = v` — MATCH.
- ROM is RO: TS `storeTab[]` stays at default `storeFree` for ROM
  pages (memiec.c:169 passes NULL for store_func, dispatch macro
  skips). Write attempts update `lastBusValue` only, no ROM mutation.

## Ticketed-out (deferred)

| Item | Target | Reason |
|---|---|---|
| `drive_ram2/4/6/8/a_enabled` expansion RAM | OUT V1 | Stock 1541 has none; 1541-II/3rd-party add-ons OUT |
| memiec.c cases for 1571/1571CR/1581/2000/4000/CMDHD | OUT V1 | Non-1541 drives per Spec 440 |
| DS1216 RTC (drive_read_rom_ds1216) | OUT V1 | 4000-series only |
| `driverom_test_load` | OMIT | UI/monitor only |
| `driverom_initialize_traps` (idle trap-patch) | TS-EXTRA-NOT-PORTED | Optimization; TS executes wait-loop natively (correct, slower). Could revisit if perf gates require. |
| `driverom_snapshot_write/read` | Spec 451 | VSF cross-load |
| 1541-II 32K ROM image support | OUT V1 | Stock 16K split-ROM only; 32K image would need DRIVE_ROM_SIZE expansion |

## Verification

| Check | Result |
|---|---|
| `npm run build` | PASS |
| `tests/unit/drive/memiec-conformance.test.ts` (NEW) | 16/16 PASS |
| `tests/integration/drivecpu-vs-vice-baseline.test.mjs` | 9999/9999 within ±1 (no regression) |
| `npm run canary:spec-430` | **5/5 PASS** |
| All other unit suites | 184/184 PASS (no regression) |
| **Total unit suite** | **200/200 PASS** (was 184, +16 memiec) |

## Commits

```
????    Spec 447 charter — memiec.c + driverom.c literal port (+ archive duplicate)
????    Spec 447 DONE — $80-$BF ROM mirror port + 16 memiec-conformance tests + mapping + production-proof (this)
```

## Doctrine compliance

- ☑ No subagent verdicts
- ☑ "MACH es GENAU so wie VICE" — $80-$BF mirror per memiec.c:169,174
  literal; rom-buffer offset arithmetic matches trap_rom semantics
- ☑ Hand-verified ROM mirror equivalence via 4 pinned tests
- ☑ 1541 V1 carve-out documented for non-1541 dispatch branches
- ☑ Sequential per [[feedback_sequential_specs]] — 447 closes before
  448 starts

## Open for follow-on specs

1. **Spec 448** — alarm.c literal port.
2. **Spec 449** — fdc.c + cbmdos.h literal port (consumes INTERIM
   fdc_err_t from Spec 445).
3. **Spec 451** — VSF cross-load (driverom snapshot R/W).
4. **Spec 452** — rotation tick BEFORE cpu.
