# Spec 447.5 — `g64-parser.ts` ↔ VICE `fsimage-gcr.c` + `diskimage.c` mapping

**Status:** IN PROGRESS (Phase 1 — mapping; Phase 2 code-port next)
**VICE sources:**
- `src/diskimage/fsimage-gcr.c` (~400 LoC)
- `src/diskimage/fsimage-gcr.h`
- `src/diskimage/diskimage.c` lines 82-264 (speed-map + raw-track-size + sector-map)
- `src/gcr.h` (Spec 445 already ported)
**TS target:** `src/disk/g64-parser.ts` (745 LoC) + new helpers in `src/disk/disk-image-zones.ts`
**Doctrine:** Claude-self literal audit. No subagents. 1541-only V1.

Verdict legend: MATCH / DEVIATION / BUG / MISSING / TS-EXTRA / OMIT-OK / RENAME-NEEDED.

User decision (2026-05-15): **Option A** for Fix #4 — pre-load all
168 half-tracks at parser construction. Truly 1:1. ~1.3 MB max per
mounted disk.

---

## A. Constants

| VICE entity | VICE line | TS counterpart | Verdict |
|---|---|---|---|
| `gcr_image_header_expected_1541[]` = "GCR-1541\0" | fsimage-gcr.c:45-46 | `G64_SIGNATURE = "GCR-1541"` (g64-parser.ts:30) | MATCH |
| `gcr_image_header_expected_1571[]` = "GCR-1571\0" | fsimage-gcr.c:47-49 | `G71_SIGNATURE = "GCR-1571"` (g64-parser.ts:31) | MATCH |
| `MAX_GCR_TRACKS = 168` | gcr.h | currently inferred from header byte 9 | **MISSING** explicit constant → port |
| `NUM_MAX_MEM_BYTES_TRACK = 65536` | gcr.h | not used (TS reads track_len per slot) | OMIT-OK (not load-bearing for 1541 V1) |
| `NUM_MAX_BYTES_TRACK = 7928` | gcr.h | not used | OMIT-OK |
| `SPEED_ZONE_COUNT = 4` | diskimage.h | implicit (4 entries in raw_track_size_d64) | OK — derive from table length |
| `raw_track_size_d64[4]` = {6250, 6666, 7142, 7692} | diskimage.c:201-207 | **MISSING** | **PORT** (Fix #2) |
| `sector_map_d64[4]` = {17, 18, 19, 21} | diskimage.c:132-137 | existing in `src/disk/base.ts` `SECTORS_PER_TRACK` table (per-track) | MATCH (different shape, same values per zone) |
| `gap_size_d64[4]` = {9, 12, 17, ...} | diskimage.c:271-276 | not used by 1541 V1 read path | OMIT-OK |
| `raw_track_size_d67[4]`, `raw_track_size_d80[4]` | diskimage.c | non-1541 (D67=2040, D80/D82=IEEE) | OUT V1 |
| `sector_map_d67[4]`, `sector_map_d80[4]` | diskimage.c | non-1541 | OUT V1 |

---

## B. Functions

| VICE function | VICE line | TS counterpart | Verdict |
|---|---|---|---|
| `fsimage_read_gcr_image(image)` | fsimage-gcr.c:53-75 | `G64Parser.parseHeader` + lazy `ensureTrack` | **DEVIATION → PORT** to literal (Option A: pre-load 168 half-tracks at ctor) |
| `fsimage_gcr_seek_half_track(fsimage, half_track, &max_track_length, &num_half_tracks)` | fsimage-gcr.c:79-120 | `G64Parser.parseHeader` (signature + trackCount + maxTrackSize + trackOffsets) | MATCH-INLINED (TS parses whole header once; VICE re-reads on each seek). Functionally equivalent. |
| `fsimage_gcr_read_half_track(image, half_track, raw)` | fsimage-gcr.c:124-174 | `G64Parser.getRawTrackBySlotIndex` | **BUG (Fix #1)** — offset==0 returns null in TS vs 0x55-filled canonical buffer in VICE. PORT. |
| `fsimage_gcr_read_track(image, track, raw)` | fsimage-gcr.c:176-179 | `G64Parser.getRawTrack(trackNum)` wrapper | MATCH-WRAPPER |
| `disk_image_speed_map(format, track)` | diskimage.c:82-125 | **MISSING** | **PORT** (Fix #2: 1541 branch only) |
| `disk_image_raw_track_size(format, track)` | diskimage.c:241-266 | **MISSING** | **PORT** (Fix #2: 1541 branch only) |
| `disk_image_sector_per_track(format, track)` | diskimage.c:170-194 | `base.ts:SECTORS_PER_TRACK[track]` | MATCH (different shape, same per-track values) |
| `util_le_buf_to_word(buf)` | util.c | inline 2-byte LE in `getRawTrackBySlotIndex` (g64-parser.ts:270) | MATCH-INLINED |
| `util_le_buf_to_dword(buf)` | util.c | inline 4-byte LE in `parseHeader` (g64-parser.ts:207-210) | MATCH-INLINED |
| `fsimage_gcr_read_sector` | fsimage-gcr.c:288+ | OMIT — TS drive emulation uses `gcr_read_sector_vice` directly | OMIT-OK |
| `fsimage_gcr_write_track` | fsimage-gcr.c:279+ | OUT V1 — write-back path is Spec 445 Phase 3 + Spec 450.x | OUT V1 |
| `fsimage_gcr_write_sector` | fsimage-gcr.c | OUT V1 — same reason | OUT V1 |
| `fsimage_gcr_create` | fsimage-gcr.c | OUT V1 — disk-create is not on the 1541-load path | OUT V1 |

---

## C. Header layout

| Field | Offset | Size | VICE handling | TS handling | Verdict |
|---|---|---|---|---|---|
| Signature | 0x00 | 8 bytes | memcmp vs "GCR-1541\0" / "GCR-1571\0" | `String.fromCharCode(... slice(0,8))` compare | MATCH |
| Version | 0x08 | 1 byte | not validated (informational) | `this.version` (informational) | MATCH |
| Track count | 0x09 | 1 byte | validated `> MAX_GCR_TRACKS` → log_error + return -1 | currently no validation | **DEVIATION** → port: throw on > 168 |
| Max track length | 0x0a | 2 bytes (LE) | `util_le_buf_to_word`, NUM_MAX_MEM_BYTES_TRACK check `#if 0`'d | `maxTrackSize` parsed | MATCH (the 65536 check is disabled in VICE) |
| Track offsets | 0x0c | 4 bytes (LE) × N | `util_le_buf_to_dword` per slot at seek-time | parsed up-front into `trackOffsets[]` | MATCH (different timing, same data) |
| Speed-zone offsets | 0x0c + N×4 | 4 bytes (LE) × N | per-half-track value 0-3 (zone) OR pointer to per-byte zone table | parsed up-front into `speedZoneOffsets[]` + resolved on demand in `resolveSpeedZone` | MATCH |

---

## D. `getRawTrackBySlotIndex` line-by-line vs `fsimage_gcr_read_half_track`

VICE fsimage-gcr.c:124-174 ↔ TS g64-parser.ts:264-276.

| Step | VICE | TS current | Verdict |
|---|---|---|---|
| Init raw->{data, size} = NULL/0 | line 137-138 | implicit | MATCH |
| Call `seek_half_track` | line 140 | header pre-parsed; trackOffsets[slotIndex] read | MATCH-INLINED |
| `offset < 0` → return -1 | line 142-144 | not reachable (header validated) | OK |
| `if (offset != 0)` non-empty | line 146 | `if (offset === 0) return null` then continue | **BUG INVERTED** for offset==0 case |
| Read 2-byte track_len LE | line 147-152 | `actualSize = data[offset] \| (data[offset+1] << 8)` | MATCH |
| Validate `track_len > max_track_length` | line 154-159 | **MISSING** — only checks file-bounds | **DEVIATION (Fix #3)** → port |
| `lib_calloc(1, track_len)` + `fread` | line 161-166 | `this.data.slice(offset + 2, offset + 2 + actualSize)` (shares underlying buffer in slice but copies via Uint8Array semantics) | MATCH (different memory model, same byte payload) |
| `else { raw->size = disk_image_raw_track_size(...); raw->data = lib_malloc; memset(0x55) }` | line 168-172 | TS returns `null` | **BUG (Fix #1)** → port 0x55-fill |

---

## E. Required fixes (concrete)

### Fix #1 — Empty-track 0x55 buffer (LOAD-BEARING for Pawn)

`getRawTrackBySlotIndex(slotIndex)` when `offset === 0`:
- VICE: returns `disk_image_raw_track_size(format, halfTrack/2)` bytes filled with 0x55.
- TS today: returns `null`.
- Port: build the canonical-size buffer, `.fill(0x55)`, return.

### Fix #2 — Speed-map + raw-track-size port

New TS module `src/disk/disk-image-zones.ts`:
- `RAW_TRACK_SIZE_D64 = [6250, 6666, 7142, 7692] as const`
- `disk_image_speed_map_g64(track: number): number`
  — 1541 branch only: `(track < 31) + (track < 25) + (track < 18)`.
- `disk_image_raw_track_size_g64(track: number): number`
  — `RAW_TRACK_SIZE_D64[disk_image_speed_map_g64(track)]`.

Hand-pinned VICE values for tracks 1, 17, 18, 24, 25, 30, 31, 35
shipped as unit tests.

### Fix #3 — Track-length validation

In `getRawTrackBySlotIndex`, after parsing `actualSize`, throw if
`actualSize < 1 || actualSize > maxTrackSize`. VICE returns -1 +
log_error; TS = throw (mount is one-shot, no resume).

### Fix #4 — Pre-load all 168 half-tracks (Option A — user picked 2026-05-15)

`parseHeader` continues to fill `trackOffsets[]` + `speedZoneOffsets[]`.
NEW: after header parse, loop `half_track = 0 .. MAX_GCR_TRACKS-1`:
- If `half_track < trackCount`: call `getRawTrackBySlotIndex(half_track)`
  (now returns canonical 0x55 buffer for offset==0).
- Else: allocate `disk_image_raw_track_size_g64(half_track/2)` bytes
  filled with 0x00 (VICE memset 0 — matches fsimage-gcr.c:71). Note:
  VICE uses 0x00 for non-existent (beyond max_half_tracks) tracks,
  but 0x55 for empty-but-existing tracks. **Preserve both
  semantics.**
- Store in `preloadedTracks[half_track]` for `getRawTrackBytes` reads.

Memory: 168 × up-to-7692 = ~1.3 MB / disk. Acceptable.

### Fix #5 — `inspectGCRTrack` audit

Verify zero production callers of `inspectGCRTrack` (gcr.ts:1012)
post-Spec 445. If clean, leave with `@internal inspection-tier`
docstring. If any production code path still calls it, migrate to
`gcr_find_sector_header_vice` / `gcr_read_sector_vice`.

---

## F. Findings (running)

| # | Finding | Severity |
|---|---|---|
| 1 | empty half-track returns null instead of 0x55 canonical buffer | **BUG (Fix #1)** — root cause Pawn FILE NOT FOUND |
| 2 | `disk_image_raw_track_size` + `disk_image_speed_map` missing entirely | **MISSING (Fix #2)** |
| 3 | track-length not validated against maxTrackSize | **DEVIATION (Fix #3)** |
| 4 | Lazy ensureTrack vs VICE pre-load | **DEVIATION → port Option A literal (user choice)** |
| 5 | `trackCount` not validated against MAX_GCR_TRACKS=168 | **DEVIATION** — add throw |
| 6 | `getRawTrackBytes` returns copy not shared ref (Spec 450.x dependency) | Already addressed in Spec 450.x WIP (commit 3155b79); ensure compatibility |
| 7 | `inspectGCRTrack` (gcr.ts:1012) usage post-Spec 445 | Audit-pending (Fix #5) |

---

## G. Acceptance check

- [ ] Mapping doc committed (this file)
- [ ] Fix #1 — empty-track 0x55 fill
- [ ] Fix #2 — disk_image_raw_track_size + speed_map ported
- [ ] Fix #3 — track-length validation
- [ ] Fix #4 — Option A pre-load all 168 half-tracks (user choice)
- [ ] Fix #5 — inspectGCRTrack audit
- [ ] Unit tests pin zone values, track-length, empty-track 0x55
- [ ] **NEW Pawn smoke** — `LOAD"$",8` boots to BASIC READY with directory
- [ ] canary:spec-430 5/5 PASS (no regression)
- [ ] Spec 444 cycle-diff 9999/9999 ±1 (sanity)
- [ ] Production-proof doc with SHAs (no `????`)
