# Spec 449 — `fdc.c` + `cbmdos.h` ↔ `fdc.ts` mapping

**Status:** DONE (audit + port executed atomically; see production-proof for SHAs)
**VICE sources:**
- `src/cbmdos.h` (171 LoC)
- `src/cbmdos.c` (747 LoC)
- `src/drive/ieee/fdc.c` (1253 LoC)
- `src/drive/ieee/fdc.h` (69 LoC)
**TS target:** `src/runtime/headless/drive/fdc.ts` (NEW)
**Doctrine:** 1541-only V1. Claude-self, no subagents.

Verdict legend: MATCH / OUT-V1 / DEVIATION / TS-EXTRA-ACCEPTABLE.

---

## A. In-scope (V1 1541)

| VICE entry | Lines | TS counterpart | Verdict |
|---|---|---|---|
| `enum fdc_err_e` (13 values) | cbmdos.h:104-118 | 13 `export const CBMDOS_FDC_ERR_* = N;` in fdc.ts (NOT a TS-`enum` keyword block) | **MATCH** (byte-identical values, snake_case verbatim) |
| `typedef enum fdc_err_e fdc_err_t` | cbmdos.h:119 | `export type fdc_err_t = number` | **DEVIATION-ACCEPTABLE** — TS `type = number` is structural; VICE `typedef enum` is nominal. Unobservable in practice (C `enum` is int-compatible; both accept any int literal). Caller-side `-CBMDOS_FDC_ERR_SYNC` negative-value soft-error convention (VICE gcr.c) supported on both sides. |

### A.1 fdc_err_t value pins

| Symbol | VICE value | TS value | Verdict |
|---|---|---|---|
| `CBMDOS_FDC_ERR_OK` | 1 | 1 | MATCH |
| `CBMDOS_FDC_ERR_HEADER` | 2 | 2 | MATCH |
| `CBMDOS_FDC_ERR_SYNC` | 3 | 3 | MATCH |
| `CBMDOS_FDC_ERR_NOBLOCK` | 4 | 4 | MATCH |
| `CBMDOS_FDC_ERR_DCHECK` | 5 | 5 | MATCH |
| `CBMDOS_FDC_ERR_VERIFY` | 7 | 7 | MATCH (gap at 6 — VICE skips) |
| `CBMDOS_FDC_ERR_WPROT` | 8 | 8 | MATCH |
| `CBMDOS_FDC_ERR_HCHECK` | 9 | 9 | MATCH |
| `CBMDOS_FDC_ERR_BLENGTH` | 10 | 10 | MATCH |
| `CBMDOS_FDC_ERR_ID` | 11 | 11 | MATCH |
| `CBMDOS_FDC_ERR_FSPEED` | 12 | 12 | MATCH |
| `CBMDOS_FDC_ERR_DRIVE` | 15 | 15 | MATCH (gap 13-14 — VICE skips) |
| `CBMDOS_FDC_ERR_DECODE` | 16 | 16 | MATCH |

Total: 13 values; 2 gaps in numbering (at 6, 13-14) preserved
verbatim — VICE-historical reasons (likely matches WD17xx fault
register bits in IEEE variants; in 1541 path the gaps are
unobservable since gcr.c only emits the populated set).

### A.2 INTERIM purge

| Action | Before | After |
|---|---|---|
| Define `fdc_err_t` enum | `src/disk/gcr.ts:105-127` (INTERIM block) | `src/runtime/headless/drive/fdc.ts` (canonical) |
| Re-export from `gcr.ts` | (defined inline) | re-exports from `fdc.ts` so `src/disk/gcr.ts` consumers continue working unchanged |
| Test import path | `from "../../../src/disk/gcr.js"` | unchanged (gcr.ts re-export shim) |

---

## B. Out-V1 (ticketed)

| VICE source | Reason | Future spec |
|---|---|---|
| `fdc.c` full state machine (1253 LoC) | IEEE-drive-only WD17xx FDC. 1541 has no FDC chip — VIA1+VIA2 directly drive GCR. **No 1541 code path reaches fdc.c.** | post-V1 / 1571-1581 era |
| `fdc.h` (69 LoC) | Same — IEEE-only types. | post-V1 |
| `CBMDOS_IPE_OK` through `_PERMISSION` (47 codes) | cbmdos.h:33-78. Host-level DOS errors via channel-15. 1541 V1 KERNAL-load path doesn't exercise — no DOS command channel emission yet. | DOS-channel spec |
| `CBMDOS_IPE_SEL_PARTN` (2), `_TOOLARGE` (52), `_ILLEGAL_SYSTEM_T_OR_S` (67), `_BAD_PARTN` (77) | 1581-only partition codes. | 1581 spec |
| `CBMDOS_FT_DEL`/`SEQ`/`PRG`/`USR`/`REL`/`CBM`/`DIR` + `_REPLACEMENT`/`_LOCKED`/`_CLOSED` | cbmdos.h:81-90. Filetype constants for dir-listing / file-open. Not exercised in 1541 V1 silicon-equivalent goal. | DOS-channel spec |
| `CBMDOS_FAM_READ`/`WRITE`/`APPEND`/`EOF` | cbmdos.h:93-96. File access modes. Same — not in V1. | DOS-channel spec |
| `CBMDOS_SLOT_NAME_LENGTH = 16` | cbmdos.h:101. Dir slot name length. Used only by dir-listing layer. | DOS-channel spec |
| `cbmdos_cmd_parse_t` struct | cbmdos.h:121-133. DOS command parser input/output struct. | DOS-channel spec |
| `cbmdos_cmd_parse_plus_t` struct | cbmdos.h:135-159. Extended parser. | DOS-channel spec |
| `cbmdos_errortext()` | cbmdos.c. Error-text lookup for channel-15 status. | DOS-channel spec |
| `cbmdos_filetype_get()` | cbmdos.c. | DOS-channel spec |
| `cbmdos_parse_wildcard_check()` / `_compare()` | cbmdos.c. Wildcard match for dir-listing. | DOS-channel spec |
| `cbmdos_dir_slot_create()` | cbmdos.c. Dir slot byte-array builder. | DOS-channel spec |
| `cbmdos_command_parse()` / `_plus()` | cbmdos.c. Top-level command parsers. | DOS-channel spec |

Total OUT-V1: ~2000 LoC VICE.
Total IN-V1: ~20 LoC TS.

---

## C. Algorithm audit per ported item

### `fdc_err_t` enum (cbmdos.h:104-119)

| VICE | TS | Verdict |
|---|---|---|
| `enum fdc_err_e {` | `enum fdc_err_t {` (or const-block) | MATCH — TS uses const-block for tree-shake friendliness; numeric values + names byte-identical |
| `CBMDOS_FDC_ERR_OK = 1, …` 13 entries | 13 matching `export const CBMDOS_FDC_ERR_* = N;` | MATCH (pin tests per A.1) |
| `};` | `};` | MATCH |
| `typedef enum fdc_err_e fdc_err_t;` | `export type fdc_err_t = number;` | MATCH (TS structural — no nominal enum-typedef pair; numeric type + named-const block models the same surface) |

---

## D. Findings summary

| # | Finding | Severity |
|---|---|---|
| 1 | INTERIM `fdc_err_t` block in `src/disk/gcr.ts:105-127` is correct port of cbmdos.h:104-119; only location wrong (should be in `drive/fdc.ts`). | **CLEANUP-NEEDED** (this spec) |
| 2 | Spec charter calls this "fdc.c + cbmdos.h" but fdc.c is `drive/ieee/` — NOT a 1541 file. | **CHARTER-CORRECTION** |
| 3 | Two value gaps (at 6, 13-14) in VICE enum — preserved verbatim, no 1541 observable effect. | MATCH |
| 4 | Rest of cbmdos.h + cbmdos.c is DOS-channel infrastructure not exercised by 1541 V1 KERNAL load path. | OUT-V1 (ticketed) |
| 5 | fdc.c is WD17xx-style FDC chip state machine for IEEE drives (8050/8250/1001/etc). 1541 doesn't have an FDC chip. | OUT-V1 (per layout, not scope-cut) |
| 6 | TS `type fdc_err_t = number` is structural alias; VICE `typedef enum` is nominal. C is int-compatible so behavioural identical, but strictly TS-EXTRA-ACCEPTABLE not literal MATCH. | DEVIATION-ACCEPTABLE |
| 7 | VICE 1541 gcr.c (src/gcr.c) emits only subset {OK, SYNC, NOBLOCK, HEADER, DCHECK, HCHECK, ID} — remaining 6 values (VERIFY, WPROT, BLENGTH, FSPEED, DRIVE, DECODE) emit from other layers (write-verify, drive controller, GCR decoder). All 13 ported per VICE-no-alternatives doctrine; cherry-picking subset would misrepresent the cbmdos.h surface. | INFO |
| 8 | VICE callers use negative-value convention `-CBMDOS_FDC_ERR_SYNC` for soft-error / try-again signalling (e.g. `p2 = -CBMDOS_FDC_ERR_SYNC` in gcr.c). TS port preserves this since values are bare `number`; caller can negate transparently. | INFO (caller-side, not enum-side) |

**No load-bearing algorithm BUGs found.** Two DEVIATION-ACCEPTABLE
tags (TS structural type, defensive nominal-vs-structural difference)
documented for honesty; both unobservable in practice.

---

## E. Acceptance check

- [x] Mapping doc committed (this file)
- [x] `fdc.ts` literal port — `fdc_err_t` enum + 13 consts
- [x] INTERIM block in `gcr.ts` purged → re-export from `fdc.ts`
- [x] `fdc-conformance.test.ts` — 13 pin tests vs cbmdos.h
- [x] `npm run build` PASS
- [x] alarm-context + alarm-dispatch regressions PASS (no scope overlap, sanity gate)
- [x] Spec 444 cycle-diff 9999/9999 within ±2 (sanity gate)
- [x] canary:spec-430 5/5 PASS
- [x] Production-proof doc with SHAs
