# Spec 445 — gcr.c ↔ gcr.ts mapping

**Status:** PROGRESS (Phase 2b — encode + write-sector ported; read-path re-audit remaining)
**VICE source:** `src/gcr.c` (357 LoC) + `src/gcr.h` (73 LoC)
**TS target:** `src/disk/gcr.ts` (588 LoC) + drive write-back coupling
**Doctrine:** Claude-self, no subagents.

Verdict legend: MATCH / DEVIATION / BUG / MISSING / TS-EXTRA / OMIT-OK.

---

## A. Constants + tables

| VICE entity | VICE lines | TS counterpart | Verdict |
|---|---|---|---|
| `NUM_MAX_BYTES_TRACK = 7928` | gcr.h:38 | needs row check | needs check |
| `NUM_MAX_MEM_BYTES_TRACK = 65536` | gcr.h:42 | needs row check | needs check |
| `MAX_GCR_TRACKS = 168` | gcr.h:45 | needs row check | needs check |
| `SECTOR_GCR_SIZE_WITH_HEADER = 335` | gcr.h:49 | needs row check | needs check |
| `disk_track_t { data, size }` | gcr.h:51-54 | TS uses raw `Uint8Array` | DEVIATION (TS implicit; no wrapper struct) |
| `gcr_t { tracks[MAX_GCR_TRACKS] }` | gcr.h:56-59 | parser owns track storage | OMIT-OK (parser-side, not gcr.ts) |
| `gcr_header_t { sector, track, id2, id1 }` | gcr.h:61-63 | needs check | needs check |
| `GCR_conv_data[16]` encode table | gcr.c:51-57 | `GCR_ENCODE` (`gcr.ts:43-50`) | **PORTED** (Phase 2a, commit 1cb3204) — bit-identical |
| `From_GCR_conv_data[32]` decode table | gcr.c:59-65 | `GCR_DECODE` or `decodeGCRNybble` table — needs verification | needs check |

---

## B. gcr.c functions

| VICE function | VICE lines | TS counterpart | Verdict |
|---|---|---|---|
| `gcr_convert_4bytes_to_GCR` | 68-86 | `gcr_convert_4bytes_to_GCR` (`gcr.ts:69-91`) | **PORTED** (Phase 2a, commit 1cb3204) — bit-identical, verified by round-trip + VICE-pin tests |
| `gcr_convert_GCR_to_4bytes` | 87-111 | `decodeGCRGroup` (`gcr.ts:112`) — needs line-by-line verify | needs check (Sprint 430 subagent flagged but not re-audited) |
| `gcr_convert_sector_to_GCR` | 112-168 | `gcr_convert_sector_to_GCR` (`gcr.ts` Phase 2b) | **PORTED** (Phase 2b) — literal port incl. all 9 CBMDOS_FDC_ERR_* error-injection branches; round-trip verified via gcr_read_sector |
| `gcr_find_sync` | 170-203 | `gcr_find_sync` (`gcr.ts:336`) | needs row check |
| `gcr_decode_block` | 205-232 | `gcr_decode_block` (`gcr.ts:355`) | needs row check (Sprint 430 num-arg fix applied; verify) |
| `gcr_find_sector_header` | 234-261 | `gcr_find_sector_header` (`gcr.ts:373`) | needs row check |
| `gcr_read_sector` | 263-292 | `gcr_read_sector` (`gcr.ts:383`) + `readSectorLikeVice` (`gcr.ts:441`) | needs row check |
| `gcr_write_sector` | 294-346 | `gcr_write_sector` (`gcr.ts` Phase 2b) | **PORTED** (Phase 2b) — literal port incl. bit-aligned cross-byte-boundary writes via `b` carry; track wrap-around; read-back round-trip verified |
| `gcr_create_image` | 348-351 | — | OMIT-OK (TS GC + parser owns) |
| `gcr_destroy_image` | 353-357 | — | OMIT-OK (TS GC) |

---

## C. Runtime write-back coupling (Spec 441 step 4 unfinished)

| Need | Current state | Verdict |
|---|---|---|
| `Drive_t.GCR_write_value` field | PRESENT (Spec 441 step 4a) | MATCH |
| Drive PA store → `GCR_write_value` mirror | PRESENT in via2-gcr-shifter-coupling onPaOutputChanged | MATCH |
| Drive write-mode = 0 + motor on + byte-ready edge → write byte to track | **— MISSING** | **MISSING — Phase 3 port** |
| `Drive_t.GCR_dirty_track` flag | PRESENT field, never set | needs row check (Spec 445 wires it) |
| Track buffer mutation on write | **— MISSING** | **MISSING — Phase 3 port** |

---

## D. Open audit work (Phase 2)

Priority order:
1. **GCR_conv_data table + gcr_convert_4bytes_to_GCR** — core encoder.
2. **gcr_convert_GCR_to_4bytes** ↔ `decodeGCRGroup` line-by-line.
3. **gcr_convert_sector_to_GCR** literal port.
4. **gcr_write_sector** literal port.
5. **gcr_find_sync / decode_block / find_sector_header / read_sector**
   re-audit (Sprint 430 subagent-audit invalidated under Epic 440 doctrine).
6. **Runtime write-back coupling** — drive PA write + write-mode →
   track-buffer mutation.

## E. Test plan

1. **Encode-decode round-trip**: random sector data → encode →
   decode == identity. Per VICE table.
2. **`gcr_write_sector` correctness**: write known sector,
   `gcr_read_sector` returns same data.
3. **Read-path re-audit**: existing canary suite + new tests for
   GCR_DECODE table semantics (Sprint 430 fix).
4. **Regression**: canary 5/5, VICE-baseline cycle-diff still
   9999/9999.

## F. Summary

Phase 1 mapping: 9 constants + 10 functions + 5 coupling rows = **24
rows** (target 30+; will expand in Phase 2b/2c sub-row matrices).

Phase 2a (commit 1cb3204):
- GCR_ENCODE table PORTED (bit-identical to VICE GCR_conv_data[16]).
- gcr_convert_4bytes_to_GCR PORTED (bit-identical, verified by
  exhaustive round-trip + 4 hand-computed VICE pin tests).

Phase 2b (commit pending):
- `fdc_err_t` enum + 13 CBMDOS_FDC_ERR_* constants — INTERIM port
  (Option B per user decision). Will move to Spec 449 when fdc.c
  literal port lands.
- `gcr_header_t` interface — VICE gcr.h:61-63 literal.
- `gcr_convert_sector_to_GCR` PORTED — full sector layout encode
  with all 9 CBMDOS error-injection branches.
- `gcr_write_sector` PORTED — bit-aligned write into raw track buffer
  with cross-byte-boundary support and track wrap-around.

Phase 2c/3 open:
- Re-audit of 6 read-path rows (gcr_find_sync, gcr_decode_block,
  gcr_find_sector_header, gcr_read_sector, decodeGCRGroup,
  GCR_DECODE table) — Sprint 430 subagent verdicts unzuverlässig.
- Runtime write-back coupling (drive PA write + write-mode + motor
  → track buffer mutation).