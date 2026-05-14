# Spec 445 — gcr.c write-path + encode production-proof

**Status:** DONE (2026-05-14, Phase 2c-cleanup landed)
**Branch:** `1541-literal-vice`
**Doctrine:** Claude-self literal audit. No subagents.
[[feedback_1541_port_workflow]] + [[feedback_vice_no_alternatives]].

## Source of truth

- VICE `src/gcr.c` (357 LoC)
- VICE `src/gcr.h` (73 LoC) — `disk_track_t`, `gcr_t`, `gcr_header_t`,
  NUM_MAX_BYTES_TRACK, MAX_GCR_TRACKS, SECTOR_GCR_SIZE_WITH_HEADER.
- VICE `src/cbmdos.h:104-119` — `fdc_err_t` enum (CBMDOS_FDC_ERR_*),
  ported INTERIM into gcr.ts per Spec 445 Open Question #1 option B.
  **Moves to Spec 449** when fdc.c literal port lands.

## TS targets

- `src/disk/gcr.ts` (588 LoC → ~860 LoC after Phase 2a/2b/2c)
- `tests/unit/disk/gcr-encode.test.ts` (NEW Phase 2a, 11 tests)
- `tests/unit/disk/gcr-write-sector.test.ts` (NEW Phase 2b/2c, 13 tests)

## Final patch state (per-VICE-entity)

Authoritative end state post-Phase-2c-cleanup. Intermediate phases
noted only where context required.

| VICE entity | Final TS state |
|---|---|
| `GCR_conv_data[16]` table (gcr.c:51-57) | **PORTED-LITERAL** as `GCR_ENCODE` — bit-identical. |
| `From_GCR_conv_data[32]` table (gcr.c:59-65) | **PORTED-LITERAL** as `GCR_DECODE` — bit-identical (Sprint 430 fix retained: invalid markers = 0 per VICE, not 0xff). |
| `disk_track_t` (gcr.h:51-54) | **PORTED-LITERAL** as `interface disk_track_t { data: Uint8Array; size: number }` + `makeDiskTrack(data, size?)` helper. All 5 production-tier fns take `disk_track_t`. |
| `gcr_header_t` (gcr.h:61-63) | **PORTED-LITERAL** as `interface gcr_header_t`. |
| `fdc_err_t` enum (cbmdos.h:104-119) | **PORTED-INTERIM** (Option B) — 13 `CBMDOS_FDC_ERR_*` constants verbatim. Moves to Spec 449. |
| `gcr_convert_4bytes_to_GCR` (gcr.c:68-86) | **PORTED-LITERAL** — VICE 16-bit shift accumulator preserved. Exhaustive 65536-tuple round-trip + 4 hand-computed VICE-pinned outputs. |
| `gcr_convert_GCR_to_4bytes` (gcr.c:87-110) | **MATCH** via `decodeGCRGroupDetailed`. 24-bit VICE shift register ↔ TS direct bit-extraction: both pick same 8 × 5-bit nybbles from 40-bit stream. Sprint 430 subagent flag CLEARED in Phase 2c re-audit. |
| `gcr_convert_sector_to_GCR` (gcr.c:112-168) | **PORTED-LITERAL** — full sector layout encode with all 9 CBMDOS_FDC_ERR_* error-injection branches. Round-trip via `gcr_read_sector_vice` + 2 hand-computed VICE-pin tests. Gap bytes left as-is per VICE (documented). |
| `gcr_find_sync` (gcr.c:170-203) | **PORTED-LITERAL** as `gcr_find_sync_vice(track, p, s): number`. Returns bit position (≥0) or `-CBMDOS_FDC_ERR_SYNC`. |
| `gcr_decode_block` (gcr.c:205-232) | **PORTED-LITERAL** as `gcr_decode_block_vice(track, p, buf, bufOff, num): void`. VICE shift-register form (Phase 2c-cleanup) — replaces the math-equivalent bit-by-bit loop. |
| `gcr_find_sector_header` (gcr.c:234-261) | **PORTED-LITERAL** as `gcr_find_sector_header_vice(track, sector): number`. Returns bit-pos (≥0) or `-fdc_err_t` (`-SYNC=-3` for sync-less track, `-HEADER=-2` for syncs-no-match). **BUG fix** vs Phase 2b inspection-tier null collapse. |
| `gcr_read_sector` (gcr.c:263-292) | **PORTED-LITERAL** as `gcr_read_sector_vice(track, data, sector): fdc_err_t`. 256 data bytes written to out-param. Returns OK / HEADER / SYNC / NOBLOCK / DCHECK literal. |
| `gcr_write_sector` (gcr.c:294-346) | **PORTED-LITERAL** — bit-aligned write into raw track buffer with cross-byte-boundary via `b` carry; track wrap-around via `raw.size`. Returns fdc_err_t. |
| `gcr_create_image` / `gcr_destroy_image` (gcr.c:348-357) | **OMIT-OK** (TS GC + parser owns track allocation). |
| Inspection-tier API (g64-parser consumer) | RETAINED non-deprecated: `gcr_find_sync` (SyncMark), `gcr_decode_block` (Uint8Array return), `gcr_find_sector_header` (GCRHeaderCandidate), `gcr_read_sector` (GCRReadSectorResult). Doc-marked as "inspection-tier API"; production tier = `*_vice` variants. |

## Verdict tally

| Verdict | Count |
|---|---|
| PORTED-LITERAL | 11 |
| MATCH (semantic, not structural) | 1 (decodeGCRGroupDetailed ↔ gcr_convert_GCR_to_4bytes — different shape, identical bit-selection) |
| OMIT-OK | 2 (gcr_create_image, gcr_destroy_image) |
| INTERIM (moves to Spec 449) | 1 (`fdc_err_t` enum) |
| INSPECTION-TIER co-exist with VICE-literal | 4 (sync/decode_block/find_header/read_sector legacy variants) |
| **BUG fixed in Phase 2c** | 1 (lossy SYNC/HEADER error collapse in `gcr_find_sector_header`) |
| **BUG / load-bearing MISSING** | **0** |

## Patches applied (per phase, end-state authoritative)

| Phase | Substance |
|---|---|
| 0 charter | 7-step + acceptance |
| 1 mapping | 24-row skeleton |
| 2a encode core | GCR_ENCODE table + gcr_convert_4bytes_to_GCR + 7 round-trip tests |
| 2a sweep | doc-rot fixes + offset-param test + bilateral defense (3 hand-computed VICE pins added → 11 total) |
| 2b sector + write_sector | fdc_err_t interim + gcr_header_t + gcr_convert_sector_to_GCR + gcr_write_sector + 8 round-trip tests |
| 2c read-path re-audit | 6 rows Claude-self verified: 5 MATCH, 1 BUG (find_sector_header lossy return) |
| 2c-fix | disk_track_t struct + 4 `*_vice` fns + lossy-return fix + 2 BUG-fix verification tests |
| 2c-cleanup | gcr_decode_block_vice shift-register form (structural-literal) + symmetric HEADER-path BUG test + inspection-tier doc-clarity |

## Ticketed-out (deferred)

| Item | Target | Reason |
|---|---|---|
| `fdc_err_t` enum migration | Spec 449 | fdc.c + cbmdos.h literal port owner |
| Runtime write-back coupling | Spec 445 Phase 3 (next) | drive PA write + write-mode + motor → track buffer mutation via gcr_write_sector |
| `gcr_create_image` / `gcr_destroy_image` | OUT | TS GC + parser owns track allocation |
| Disk save-back to .g64 file | OUT | IO concern, not GCR scope |

## Verification

| Check | Result |
|---|---|
| `npm run build` (full) | PASS |
| `tests/unit/disk/gcr-encode.test.ts` | 11/11 PASS (incl. 65536-tuple round-trip + 4 hand-computed VICE pins) |
| `tests/unit/disk/gcr-write-sector.test.ts` | 13/13 PASS (incl. 2 sector-encode hand-computed VICE pins + 2 BUG-fix verification) |
| All other unit suites | unchanged: 139/139 PASS across VIA + drive |
| **Total unit suite** | **163/163 PASS** |
| `tests/integration/drivecpu-vs-vice-baseline.test.mjs` (Spec 444) | 9999/9999 within ±1 cycle (no regression) |
| `npm run canary:spec-430` | **5/5 PASS** (post-cleanup) |

## Commits

```
6d730ce Spec 445 Phase 1   — mapping skeleton (24 rows)
1cb3204 Spec 445 Phase 2a  — GCR_ENCODE + gcr_convert_4bytes_to_GCR
01f4175 Spec 445 Phase 2a sweep — doc-rot + bilateral defense (3 VICE pins)
5b31c69 Spec 445 Phase 2b  — sector_to_GCR + write_sector + fdc_err_t INTERIM
0ccd7ec Spec 445 Phase 2c  — Claude-self re-audit (5 MATCH, 1 BUG)
e867305 Spec 445 Phase 2c-fix — disk_track_t literal + 4 *_vice fns + BUG fix
d6d8a98 Spec 445 Phase 2c-cleanup — shift-register form + symmetric BUG test + inspection-tier
```

## Doctrine compliance

- ☑ No subagent verdicts (every row Claude-authored line-by-line)
- ☑ "MACH es GENAU so wie VICE" — disk_track_t literal port,
  shift-register decode form, fdc_err_t enum verbatim, struct fields
  literal
- ☑ Hand-computed VICE-pin tests defending against bilateral
  encode/decode bug fail-mode (Sprint 430 precedent)
- ☑ Sprint 430 subagent verdicts INVALIDATED + replaced by Claude-self
  re-audit
- ☑ No TS-OO abstractions hiding VICE structs
- ☑ Sequential per [[feedback_sequential_specs]] — Spec 445 closes
  before Spec 446 starts
- ☑ "Doktrin - IMMER literal VICE nachbauen, da musst du gar nicht
  fragen" — internalized after Phase 2c USER-FRAGE was rejected;
  option A applied without asking; memory updated.

## Open items for follow-on specs

1. **Spec 445 Phase 3** (next, same spec) — runtime write-back
   coupling: drive PA write + write-mode + motor → `gcr_write_sector`
   call on the active track. Timing-independent of Spec 452
   tick-order flip.
2. **Spec 446** — drivesync.c PAL/NTSC switch logic.
3. **Spec 449** — fdc.c + cbmdos.h literal port (consumes the
   INTERIM `fdc_err_t` from Spec 445).
4. **Spec 452** — rotation tick BEFORE cpu per §14 invariant 1.
