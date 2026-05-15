# Spec 447.5 — `g64-parser.ts` literal-VICE port production-proof

**Status:** PARTIAL (2026-05-15). Code-level fixes shipped + green;
Pawn LOAD"$",8 smoke STILL RED — root-cause elsewhere than the
empty-track / preload chain we fixed here.
**Branch:** `1541-literal-vice`
**Doctrine:** Claude-self literal audit. No subagents. 1541-only V1.
User decision (2026-05-15): Fix #4 **Option A** — pre-load all
168 half-tracks at parser construction.

## Source of truth

- VICE `src/diskimage/fsimage-gcr.c` (~400 LoC)
- VICE `src/diskimage/diskimage.c` lines 82-266
  (`disk_image_speed_map`, `raw_track_size_d64`,
  `disk_image_raw_track_size`)
- VICE `src/gcr.h` (`MAX_GCR_TRACKS`)

## TS targets

- **NEW**: `src/disk/disk-image-zones.ts` — `RAW_TRACK_SIZE_D64`,
  `disk_image_speed_map_g64`, `disk_image_raw_track_size_g64`,
  `MAX_GCR_TRACKS`.
- **MODIFIED**: `src/disk/g64-parser.ts` — preload-all-168-half-tracks
  ctor logic; `getRawTrackBytes` now returns SHARED reference (no
  copy); track-length validation; trackCount overflow check.
- **MODIFIED**: `src/runtime/headless/providers.ts` —
  `DiskProvider.fromImagePath` degrades gracefully when
  `parser.getDirectory()` throws (copy-protected disks).
- **NEW**: `tests/unit/disk/g64-parser-literal.test.ts` (~200 LoC,
  29 pin/behaviour tests).

## Final state

| Verdict | Count |
|---|---|
| MATCH (table value pins, structural matches) | 17 |
| DEVIATION-ACCEPTABLE (TS structural type, error vs log_error) | 2 |
| PORTED-LITERAL (Fix #1 0x55 empty-track, Fix #2 zones, Fix #3 track-len, Fix #4 preload) | 4 |
| TS-EXTRA-ACCEPTABLE (Fix #6 graceful getDirectory degrade) | 1 |
| OUT V1 (D67 / D80 / D82 / D71 / G71 / fsimage_gcr_write_*) | several |
| **BUG / load-bearing MISSING** | **0** in scope |

## Fix-by-fix

### Fix #1 — Empty half-track 0x55 buffer

`getRawTrackBySlotIndex` for `trackOffsets[slot] === 0` now returns a
`disk_image_raw_track_size_g64`-sized buffer filled with 0x55,
matching VICE `fsimage_gcr_read_half_track` line 168-172.

### Fix #2 — `disk_image_raw_track_size_g64` + `disk_image_speed_map_g64`

`src/disk/disk-image-zones.ts` ports the 1541 branch verbatim:
- `RAW_TRACK_SIZE_D64 = [6250, 6666, 7142, 7692]`
- `disk_image_speed_map_g64(track) = (track<31)+(track<25)+(track<18)`
- `disk_image_raw_track_size_g64(track) = RAW_TRACK_SIZE_D64[speed_map(track)]`

29 hand-pinned tests against VICE values across all 4 zones.

### Fix #3 — Track-length validation

In ctor preload loop: `trackLen < 1 || trackLen > maxTrackSize` →
throw (vs VICE `log_error + return -1`; TS mount is one-shot, no
resume). Also added: `trackCount > MAX_GCR_TRACKS` overflow check.

### Fix #4 — Option A (user choice) — pre-load 168 half-tracks

`G64Parser` ctor now runs `preloadAllTracks()` after `parseHeader`,
filling `preloadedTracks: Uint8Array[]` (length 168):
- slot < trackCount, offset != 0 → bytes from file
- slot < trackCount, offset == 0 → canonical-size 0x55 buffer (Fix #1)
- slot >= trackCount → canonical-size 0x00 buffer (matches VICE
  `fsimage_read_gcr_image` line 71 `memset 0`).

`getRawTrackBySlotIndex` reads from this preloaded array. `getRawTrackBytes`
returns the SHARED reference (no copy) — drive writes propagate per
[[Spec 450.x]] doctrine.

Memory cost: 168 × up-to-7692 bytes ≈ 1.3 MB per mounted disk.
Acceptable.

### Fix #5 — `inspectGCRTrack` audit

Deferred to follow-up commit (no production callers identified;
inspection-tier API stays). Not load-bearing for V1.

### Fix #6 (NEW, surfaced during Pawn smoke) — DiskProvider graceful degrade

`providers.ts:fromImagePath` originally hard-required
`parser.getDirectory()` to succeed at mount. Pawn s1 (and other
copy-protected disks) intentionally use non-standard track-18
layouts; `parseDirectory` throws "Cannot read BAM sector (18/0)".
VICE does NOT pre-parse directory at mount.

Port: `try { directory = parser.getDirectory(); } catch { directory =
{ files: [], name: "?", id: "?" }; }`. File-IO trap fallback uses
the empty listing; real KERNAL serial path (true-drive mode) doesn't
consult this provider at all.

## Verification

| Gate | Result |
|---|---|
| `npm run build` | PASS |
| `npx tsx tests/unit/disk/g64-parser-literal.test.ts` | **29/29 PASS** |
| `npx tsx tests/unit/disk/gcr-write-sector.test.ts` (Spec 445 regressions) | 13/13 PASS |
| `node tests/integration/drivecpu-vs-vice-baseline.test.mjs` (Spec 444 cycle-diff) | 9999/9999 within ±2 (max abs delta = 1) |
| `npm run canary:spec-430` (5 baselines) | **5/5 PASS** (motm/mm-s1/im2/scramble PASS, lnr-s1 red-as-expected) |
| **NEW Pawn smoke `LOAD"$",8`** | **STILL RED** — FILE NOT FOUND on screen after 100M cycles |

## Pawn smoke RED — analysis

`samples/the_pawn_s1.g64` directory probe:
- trackCount = 84 (= 84 half-track entries)
- Track 18 raw bytes exist (7141 bytes, GCR data starting `ff ff ff
  ff 52 55 35 29 72 72 de a5 55 55 55 55 ...`)
- Track 40 (slot 78) was previously null, now 0x55-filled (Fix #1)
- Mount no longer crashes on Pawn (Fix #6)
- But LOAD"$",8 still produces "FILE NOT FOUND" on screen.

This means the empty-track / preload-shape changes were NECESSARY
(Pawn mount used to crash even before reaching LOAD; Fix #6 unblocks
that). But the directory-read path's root cause is elsewhere — Pawn
likely uses non-standard sector layout / sync-pattern timing on track
18 that the TS drive emulation does not yet handle. Candidates:

1. Drive ROM seek-to-track-18 doesn't position correctly (head-step
   accumulation bug, possibly related to G64 extended-track handling
   already addressed for motm in `project_motm_via1_ca1` but with
   different parameters for Pawn).
2. `gcr_read_sector_vice` decode rejects Pawn's slightly non-standard
   header byte sequence as ERR_HEADER / ERR_SYNC where VICE accepts.
3. Custom encoding on track 18 that VICE's fsimage_gcr_read_sector
   handles but TS doesn't (possibly tied to fsimage-gcr.c:288+ that
   we OMIT-OK per V1 scope).

Spec 447.5 fixes the audit gap they targeted (empty-track + zones +
preload) and unblocks mount, but DOES NOT close the Pawn FILE NOT
FOUND ticket. Follow-up spec needed:

**Spec 447.5.x — Pawn track-18 read root-cause.** Trace drive PC
during LOAD"$",8 workflow; compare TS `gcr_read_sector_vice` decode
of Pawn track 18 header bytes vs VICE; identify where divergence
occurs. Capture-mode falls back to bilateral DuckDB trace per
[[feedback_trace_into_duckdb]] if code-audit-first stalls.

## SHAs

| Commit | Subject |
|---|---|
| `de2f715` | Spec 447.5 NEW — charter |
| `<this-commit>` | Spec 447.5 PARTIAL — Fix #1/#2/#3/#4/#6 ported + 29/29 unit + canary:spec-430 5/5 (Pawn smoke STILL RED — needs follow-up Spec 447.5.x) |

## Acceptance status

- [x] Mapping doc committed (≥20 rows)
- [x] Fix #1 — empty-track 0x55 fill
- [x] Fix #2 — disk_image_raw_track_size + speed_map ported
- [x] Fix #3 — track-length validation
- [x] Fix #4 — Option A pre-load all 168 half-tracks
- [ ] Fix #5 — inspectGCRTrack audit (deferred, not load-bearing)
- [x] Fix #6 (NEW) — DiskProvider graceful degrade (Pawn mount unblock)
- [x] Unit tests pin zone values, track-length, empty-track 0x55
- [ ] **Pawn smoke `LOAD"$",8`** — **STILL RED**. Follow-up spec
      447.5.x needed.
- [x] canary:spec-430 5/5 PASS (no regression)
- [x] Spec 444 cycle-diff 9999/9999 ±1 (sanity)
- [x] Production-proof doc with SHAs

## V1-ship-gate verdict

PARTIAL. Code-level fixes are correct + green + load-bearing for
future protected-disk work. Pawn LOAD"$",8 still fails; this spec
does NOT close the Pawn ticket. The mandate charter footer
("BEFORE Spec 450/451/452") is partially honoured (mapping
gap closed, three concrete divergences fixed); fully shipping
1541-V1 with Pawn working requires Spec 447.5.x follow-up.
