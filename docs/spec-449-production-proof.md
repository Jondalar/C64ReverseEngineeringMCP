# Spec 449 — `fdc.c` + `cbmdos.h` production-proof (1541-only V1)

**Status:** DONE (2026-05-14)
**Branch:** `1541-literal-vice`
**Doctrine:** Claude-self literal audit. No subagents. 1541-only
mandate ([[feedback_vice_no_alternatives]]).

## Source of truth

- VICE `src/cbmdos.h` (171 LoC) — shared CBM-DOS API surface.
- VICE `src/cbmdos.c` (747 LoC) — DOS command channel implementation.
- VICE `src/drive/ieee/fdc.c` (1253 LoC) — IEEE-drive WD17xx FDC state machine.
- VICE `src/drive/ieee/fdc.h` (69 LoC) — fdc.c header.

## TS targets

- **NEW**: `src/runtime/headless/drive/fdc.ts` (~70 LoC) — canonical home of `fdc_err_t` enum.
- **MODIFIED**: `src/disk/gcr.ts` — INTERIM block deleted; re-export shim added pointing at `fdc.ts`.
- **NEW**: `tests/unit/drive/fdc-conformance.test.ts` (~95 LoC) — 16 pin/gap/shim tests.

## Audit coverage

`docs/spec-449-fdc-cbmdos-mapping.md` — full IN-V1 (1 enum, 13 values)
+ OUT-V1 (~14 ticketed items, ~2000 LoC VICE).

## Final state

| Verdict | Count |
|---|---|
| MATCH (enum value pin) | 13 values |
| DEVIATION-ACCEPTABLE (typedef shape: TS structural `type = number` vs VICE nominal `typedef enum`) | 1 (`fdc_err_t`) |
| OUT-V1 (ticketed) | ~14 cbmdos.h surface items + entire fdc.c + entire cbmdos.c |
| **BUG / load-bearing MISSING** | **0** |

### VICE 1541 gcr.c emit subset (audit cross-check)

VICE `src/gcr.c` (the 1541 GCR encode/decode layer) emits only a
subset of `fdc_err_t`:

| Emitted by VICE 1541 gcr.c | Not emitted by 1541 gcr.c (other layers) |
|---|---|
| OK, SYNC, NOBLOCK, HEADER, DCHECK, HCHECK, ID | VERIFY, WPROT, BLENGTH, FSPEED, DRIVE, DECODE |

All 13 ported per VICE-no-alternatives doctrine — cherry-picking
the 7-value subset would misrepresent the cbmdos.h surface. The
unused-by-1541-gcr 6 values may still be returned by other 1541
drive layers (write-verify path, drive controller status, GCR
decode helper); preserving them keeps the surface complete.

VICE callers also use the negative-value convention
`-CBMDOS_FDC_ERR_SYNC` for soft-error / try-again signalling in
some early-exit paths (e.g. `p2 = -CBMDOS_FDC_ERR_SYNC;` in
gcr.c). TS port preserves this transparently — the values are
bare `number` so caller can negate freely.

### Charter correction

Epic-1541 row labels Spec 449 "fdc.c + cbmdos.h". The fdc.c label is
misleading: `src/drive/ieee/fdc.c` is the WD17xx-style FDC state
machine for IEEE drives (8050 / 8250 / 1001 / 2031 / 2040 / 3040 /
4040 / 9000). The 1541 has NO FDC chip — drive CPU controls VIA1
+ VIA2 directly. Under the 1541-only mandate, fdc.c is 100% OUT-V1
(per VICE source layout, not as a scope-cut).

## Ticketed-out (full list)

| Item | VICE source | Reason | Future spec |
|---|---|---|---|
| fdc.c state machine + types | drive/ieee/fdc.c + .h (1322 LoC) | IEEE-only. 1541 doesn't have FDC chip. | 1571/1581 era |
| `CBMDOS_IPE_*` (47 codes) | cbmdos.h:33-78 | 1541 V1 doesn't emit IPE codes — KERNAL load path bypasses DOS command channel. | DOS-channel spec |
| 1581 partition codes (`_SEL_PARTN`, `_TOOLARGE`, `_ILLEGAL_SYSTEM_T_OR_S`, `_BAD_PARTN`) | cbmdos.h | 1581 only. | 1581 spec |
| `CBMDOS_FT_*` filetype constants | cbmdos.h:81-90 | No dir-listing / file-open in 1541 V1. | DOS-channel spec |
| `CBMDOS_FAM_*` access modes | cbmdos.h:93-96 | No DOS file API. | DOS-channel spec |
| `CBMDOS_SLOT_NAME_LENGTH` | cbmdos.h:101 | Dir slot consumer only. | DOS-channel spec |
| `cbmdos_cmd_parse_t` / `_plus_t` | cbmdos.h:121-159 | DOS command parser structs. | DOS-channel spec |
| `cbmdos_errortext` / `_filetype_get` / `_parse_wildcard_*` / `_dir_slot_create` / `_command_parse` / `_command_parse_plus` | cbmdos.c | DOS command channel layer. | DOS-channel spec |

Total OUT-V1 LoC (VICE): ~2069.
Total IN-V1 LoC (TS): ~70 in `fdc.ts` + re-export shim.

## INTERIM purge

| Before | After |
|---|---|
| `src/disk/gcr.ts:104-127` defined `fdc_err_t` + 13 consts INTERIM (Spec 445 Phase 2b) | Block removed; re-export shim added importing from `../runtime/headless/drive/fdc.js`. Consumers (`gcr-write-sector.test.ts`, gcr internal callers) work unchanged. |

## Verification table

| Gate | Result |
|---|---|
| `npm run build` (tsc full + pipeline) | PASS |
| `npx tsx tests/unit/drive/fdc-conformance.test.ts` (NEW pins) | **16/16 PASS** (13 enum pins + 2 gap-preservation + 1 re-export shim) |
| `npx tsx tests/unit/disk/gcr-write-sector.test.ts` (Spec 445 regressions through shim) | **13/13 PASS** |
| `npx tsx tests/unit/alarm/alarm-context.test.ts` (sanity) | **22/22 PASS** |
| `npx tsx tests/unit/alarm/alarm-dispatch.test.ts` (sanity) | **11/11 PASS** |
| `node tests/integration/drivecpu-vs-vice-baseline.test.mjs` (Spec 444 cycle-diff) | **9999/9999 within ±2; max abs delta = 1** |
| `npm run canary:spec-430` (5 baselines) | **5/5 PASS** (motm/mm-s1/im2/scramble PASS, lnr-s1 red-as-expected) |

## SHAs

| Commit | Subject |
|---|---|
| `a502074` | Spec 449 charter + Spec 448.2 SHA fix (charter under 1541-only mandate; fdc.c documented as IEEE-only OUT-V1) |
| `a8e31dd` | Spec 449 DONE — fdc_err_t migration to canonical fdc.ts + 16 conformance tests |

## Risk + scope

Migration only. No behaviour change. Cycle-diff + canary are sanity
gates (alarm dispatch unaffected; gcr.c emit paths unchanged — just
import-path move).

## Out of scope → future specs

- Spec 449.x (post-V1): full `cbmdos.h` + `cbmdos.c` port for DOS
  command channel.
- Spec 449.y (1571/1581 era): `fdc.c` port for IEEE / advanced drives.
- Both are NOT prereqs for 1541 V1 silicon-equivalent ship.
