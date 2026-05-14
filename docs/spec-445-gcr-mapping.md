# Spec 445 — gcr.c ↔ gcr.ts mapping

**Status:** PROGRESS (Phase 2c — read-path Claude-self re-audit complete, 1 BUG found, 1 USER-FRAGE pending)
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
| `From_GCR_conv_data[32]` decode table | gcr.c:59-65 | `GCR_DECODE` (`gcr.ts:36-41`) | **MATCH** (Phase 2c) — bit-identical to VICE 32-entry table |

---

## B. gcr.c functions

| VICE function | VICE lines | TS counterpart | Verdict |
|---|---|---|---|
| `gcr_convert_4bytes_to_GCR` | 68-86 | `gcr_convert_4bytes_to_GCR` (`gcr.ts:69-91`) | **PORTED** (Phase 2a, commit 1cb3204) — bit-identical, verified by round-trip + VICE-pin tests |
| `gcr_convert_GCR_to_4bytes` | 87-111 | `decodeGCRGroup` / `decodeGCRGroupDetailed` (`gcr.ts:255, 288`) | **MATCH** (Phase 2c) — VICE 24-bit shift register vs TS direct bit-extraction: both extract 8 × 5-bit nybbles from the 40-bit GCR stream at identical positions (39..35, 34..30, ..., 4..0). Sprint 430 subagent flag CLEARED. |
| `gcr_convert_sector_to_GCR` | 112-168 | `gcr_convert_sector_to_GCR` (`gcr.ts` Phase 2b) | **PORTED** (Phase 2b) — literal port incl. all 9 CBMDOS_FDC_ERR_* error-injection branches; round-trip verified via gcr_read_sector |
| `gcr_find_sync` | 170-203 | `gcr_find_sync` / `findSyncMarkFromBit` (`gcr.ts:512, 659`) | **MATCH** (Phase 2c) — VICE 10-bit window vs TS consecutive-ones counter: semantically equivalent (both return position of FIRST 0 bit after ≥10 consecutive 1s). VICE w starts 0; TS counter starts 0; both behave identically given fresh state. |
| `gcr_decode_block` | 205-232 | `gcr_decode_block` (`gcr.ts:531`) | **MATCH** (Phase 2c) — Sprint 430 num-arg fix verified present (TS treats `num` as GROUPS = 5 GCR → 4 raw bytes, matches VICE). TS uses intermediate `readAlignedBytesFromBit` buffer; VICE uses in-place shift register. Output identical. |
| `gcr_find_sector_header` | 234-261 | `gcr_find_sector_header` / `findSectorHeaderLikeVice` (`gcr.ts:549, 702`) | **BUG** (Phase 2c finding) — TS returns `null` for BOTH "no syncs at all" and "syncs found but no matching sector". VICE distinguishes: returns `-CBMDOS_FDC_ERR_SYNC = -3` for no-syncs vs `-CBMDOS_FDC_ERR_HEADER = -2` for no-match. **Lossy.** Propagates to `gcr_write_sector` returning `CBMDOS_FDC_ERR_HEADER` for both cases. **Fix required in Phase 2c.** |
| `gcr_read_sector` | 263-292 | `gcr_read_sector` / `readSectorLikeVice` (`gcr.ts:559, 712`) | **MATCH-WITH-PROPAGATED-BUG** — semantic MATCH (header sync → data sync → decode 65 groups → chksum). Return shape differs (rich object vs int). Inherits the lossy error from `gcr_find_sector_header`: returns `header_not_found` for both "no syncs" and "no matching sector" cases. Fix follows the find_sector_header fix. |
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

Phase 2c (Claude-self re-audit, no subagent):

| Row | Verdict |
|---|---|
| `gcr_find_sync` | MATCH (semantically equivalent algorithm) |
| `gcr_decode_block` | MATCH (Sprint 430 num-arg fix verified) |
| `gcr_find_sector_header` | **BUG** — lossy SYNC/HEADER error collapse |
| `gcr_read_sector` | MATCH-WITH-PROPAGATED-BUG (inherits find_sector_header) |
| `decodeGCRGroup` (= `gcr_convert_GCR_to_4bytes`) | MATCH |
| `GCR_DECODE` table (= `From_GCR_conv_data[32]`) | MATCH |

**Phase 2c finding #1 (BUG):** `gcr_find_sector_header` returns
`null` for both:
- "no syncs at all on track" (VICE: `-CBMDOS_FDC_ERR_SYNC = -3`)
- "syncs present but no matching sector" (VICE: `-CBMDOS_FDC_ERR_HEADER = -2`)

`gcr_write_sector` in Phase 2b therefore returns `CBMDOS_FDC_ERR_HEADER`
for both cases (line 593-596). Real divergence: VICE caller sees
`CBMDOS_FDC_ERR_SYNC` for empty/sync-less tracks.

**Fix planned (Phase 2c-fix):** new function
`gcr_find_sector_header_vice(raw, sector)` returning
`{ candidate: GCRHeaderCandidate } | { error: fdc_err_t }`.
Existing null-returning `gcr_find_sector_header` retained for
back-compat consumers; `gcr_write_sector` switched to the new
discriminated function.

**Phase 2c USER-FRAGE (gates fix landing):** `disk_track_t.size` vs
`raw.length` latent footgun — VICE uses explicit track-size field
(buffer can be over-allocated up to NUM_MAX_MEM_BYTES_TRACK = 65536).
TS uses `raw.length` directly. Three options A/B/C — see Spec 445
charter "Open question". User decision required.

Phase 3 open:
- Runtime write-back coupling (drive PA write + write-mode + motor
  → track buffer mutation).