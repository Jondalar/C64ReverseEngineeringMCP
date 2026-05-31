# Bug: Custom true-drive (drive-side GCR) writes do not persist to a D64-backed mounted image

- **ID:** BUG-023
- **Date:** 2026-05-31
- **Reporter:** llm
- **Area:** runtime
- **Severity:** high
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## FIXED 2026-05-31 — VICE-faithful host-file WRITE-THROUGH

### Porting doctrine (RFL audit-failure class — read this)

This bug was not a missing `writeFile` call; it is a **VICE-port side-effect
class**. Codify it:

1. **VICE `fwrite`/`fpwrite`/file side effects MUST map to real host-file writes
   in the TS port.** Replacing an `fopen`/`fwrite` fd with an in-RAM buffer drops
   VICE's externally-observable behaviour. The port must reproduce the host write
   at the same semantic point.
2. **`media.bytes` is a cache/mirror, NOT the persistence authority** for writable
   path-backed media. The host file is the authority. Boundary persistence
   (unmount/swap/snapshot) is a safety flush, not the primary mechanism.
3. **Any test that claims VICE file persistence MUST re-read the file from the
   filesystem** (bytes AND mtime) — never assert only on in-RAM `media.bytes`, a
   checkpoint blob, or a `_session.g64` side-file.
4. **Same class applies to writable CARTRIDGE state** (EasyFlash flash → host
   `.crt`): a cartridge write must reach the host file at its VICE write point,
   not only RAM/checkpoint. Tracked as a follow-up (BUG-023-cart).

### Root cause

VICE's disk-image `fd` is the real file: `drive_gcr_data_writeback` →
`fsimage_dxx/gcr_write_half_track` → `fwrite` changes the host `.d64`/`.g64` at
the writeback commit. Our port replaced the `fd` with the in-RAM `media.bytes`
`Uint8Array` and `util_fpwrite` wrote only RAM — so the host file (and its mtime)
never changed after a game format/copy/save.

### Fix — write-through at the diskimage write point

- `fsimage_dxx_write_half_track` / `fsimage_gcr_write_half_track` call an optional
  `fsimage.hostFlush()` right after `util_fpwrite` (the VICE `fwrite` point).
- The facade (`makeDiskImage`, bridge — node:fs stays out of `vice1541/` per PL-5)
  installs `hostFlush` for writable path-backed media: it writes the committed
  in-RAM image to the backing file. Read-only media installs no hook → never
  written.
- `Drive1541Media.backingPath` carries the host path; `mount.ts` passes it on
  attach. So a drive write reaches disk **immediately at the writeback**, with no
  unmount/snapshot — exactly like VICE.
- Boundary persistence (`persistMountedDiskToFile` + `runtime_media_persist` +
  unmount/swap writeback) is kept as a SAFETY flush for the final not-yet-
  committed track, not the primary path.

### Gate — re-reads the host file

`scripts/smoke-023-write-through.mjs` (`npm run smoke:023-write-through`, 7/7):
temp `.d64` FILE → write a sector through the real drive path →
`drive_gcr_data_writeback` (the commit point, no detach/unmount/snapshot) →
**RE-READ the file from the filesystem** → host bytes changed + host mtime
advanced + remount sees the sector; read-only path-backed media leaves the host
file + mtime untouched. Plus `smoke:023-host-file` (8/8, boundary persist),
`smoke:023-via` (6/6), `smoke:023-snapshot-flush` (4/4), `smoke:023`,
`probe-single-path` (25/25), `check:mcp-product-surface` (all green), `build:mcp`.

### Why earlier gates missed it

| Test | Verifies RAM media | Verifies host file (re-read + mtime) | Verdict |
|---|---|---|---|
| smoke:023 / -via / -snapshot-flush | yes (`media.bytes` / GCRIMAGE blob) | **no** | missed |
| KERNAL SAVE (617) | yes (in-memory `fsimage.fd`) | no | missed |
| probe-714 / 707 / 709 | yes (checkpoint blob) | no | missed |
| smoke-write-support | side-file `_session.g64` | no (not the original) | missed |
| **smoke:023-write-through** (new) | — | **YES (re-reads file + mtime)** | catches it |

Every prior gate stopped at RAM/blob; none re-read the host file, so the missing
`fwrite` side effect was invisible. Doctrine #3 above closes that.

The earlier "D64 decode-lossy" (synthetic boundary) and "snapshot-flush no-op"
(in-blob detail, fix kept at `be50bab9`) findings are SECONDARY, not the
user-facing bug.

## REOPENED 2026-05-31 — real root cause: no RAM-media → backing-file writeback

The "fixed" status was premature. Real UI repro: Wasteland running in the UI
formats + copies onto the mounted project disk
`/Users/alex/Development/C64/Cracking/Wasteland_EF/blanks/blank_s1.d64`; the host
file stays empty AND its filesystem mtime does not change. So nothing ever
writes the backing file.

**Final root cause:** a mounted disk is only `media.bytes` in RAM. GCR writeback
flushes at most GCR → `media.bytes`; there is NO final writeback
`media.bytes → backing .d64/.g64 file`. VICE writes to a real `fd`
(`fopen "r+"`); our port's `fd` is an in-RAM `Uint8Array`, so `fwrite`/`fflush`
hit RAM and never the disk file (`mount.ts:157` reads the file once; no
`writeFileSync` back to the path exists anywhere).

The prior "D64 decode-lossy" and "snapshot-flush no-op" findings are SECONDARY
notes (a synthetic boundary + an in-blob detail), NOT the user-facing bug. The
snapshot-flush fix (commit be50bab9) is kept but is insufficient on its own.

## RFL code audit + real VIA→rotation probe (2026-05-31) — SUPERSEDES the "D64 decode-bound" note below

VICE persists the same `.d64` custom save; ours does not → treat as a PORT bug,
not "D64 unsuitable". Field-by-field RFL audit (VICE `/src` ↔ TS `vice1541/`) of
the whole write path found **every bit-level field a faithful match**:

| Area | VICE | TS | Verdict |
|---|---|---|---|
| VIA2 `store_pra` ($1C01→GCR_write_value) | via2d.c:180-191 | via2d.ts:355-368 | match |
| `set_cb2` head-mode guard | via2d.c:95-107 | via2d.ts:225-234 | match |
| `via2d_update_pcr` (`read_write_mode=pcrval&0x20`) | via2d.c:170-177 | via2d.ts:339-346 | match |
| viacore `set_cb2_output_state` ($C0→low→write) | viacore.c:1350-1376 | viacore.ts:379-401 | match |
| rotation WRITE branch + `write_next_bit` + `GCR_dirty_track` | rotation.c:495-569 / 227-252 | rotation.ts:602-664 / 361-389 | match |
| `read_write_mode` init = 1 | drive.c:258 | drive.ts:553 | match |
| D64 writeback decode-fail behaviour | fsimage-dxx.c | fsimage_dxx.ts:369-393 | match |
| **snapshot `drive_gcr_data_writeback_all`** | **VICE flushes all dirty GCR→image before snapshot** | **`drive_snapshot.ts:330` = `() => { /* no-op */ }`** | **DIVERGE** |

**Real VIA→rotation probe** (`scripts/smoke-023-via-rotation-write-path.mjs`,
`npm run smoke:023-via`, 6/6): drives the actual chain a custom save uses —
`STA $1C0C=$E0`(read)→`$C0`(write) flips `read_write_mode` 0x20→0 via the real
VIA store; `STA $1C01` writes through `rotation_rotate_disk` set `GCR_dirty_track=1`
(head moved 512 bits); **detach decodes the written track into the mounted D64**.
So the per-op write path is correct END TO END. (The earlier `smoke:023`
classifier drove `write_next_bit` directly with a test-set `read_write_mode` — a
shortcut; it only proved the synthetic boundary, not the real path.)

**Root cause (narrowed):** the drive emulation writes + persists correctly on
detach/seek. The field failure is the **persistence/inspect path**: the `.d64`
view only updates via the detach/seek writeback decode, and the snapshot/dump
path's `drive_gcr_data_writeback_all()` is a **no-op**, so a dump/snapshot taken
while the disk is still mounted captures the embedded `.d64` media payload at its
**clean baseline** (writes ride only in the verbatim GCRIMAGE blob). VICE calls
`drive_gcr_data_writeback_all()` before snapshot write → its `.d64` reflects the
writes. **Minimal fix candidate:** wire `drive_gcr_data_writeback_all` to call
`drive_gcr_data_writeback` for each active drive (matching VICE), and/or flush
dirty GCR before exposing/dumping the mounted `.d64`. **Minimal gate:** write via
the real path → snapshot/dump → the embedded `.d64` must reflect the writes.

NOTE: the "decode-bound / D64 unsuitable for non-standard GCR" classification
below is **superseded** — it only proved a synthetic boundary (a deliberately
corrupted sector), not the real game, and VICE persists the same real `.d64`.

## Root class (generalized 2026-05-31)

**Not Wasteland-specific.** The product gap is: **custom / fastloader save+write
paths that write raw GCR via the drive CPU (STA $1C01), to a D64-backed mounted
image, are not persisted.** Two real fixtures, both `.d64`, both non-KERNAL:

- **Wasteland** Utils → Copy (strongest analysis fixture; full drive-code map).
- **Scramble** HighScore save (krill/$DD00-class save path; regression/product
  fixture).

KERNAL/DOS file SAVE (Spec 617) is a different path and is NOT the issue.

## Classifier gate + findings (`scripts/smoke-023-custom-drive-write-persist.mjs`, `npm run smoke:023`)

Drives the REAL write path (`write_next_bit` — the same sink `store_pra` feeds
from `$1C01`) into a writable image, layer by layer:

| Layer | Result |
|---|---|
| `$1C01` write sets `GCR_dirty_track` | **yes** |
| detach triggers `drive_gcr_data_writeback` | **yes** (boundary = seek/detach only) |
| A. **standard** CBM-GCR sector write → D64 | **PERSISTS** (T20/S5 byte-exact) |
| B. **custom/non-standard** GCR write → D64 | **LOST** (lossy GCR→sector decode) |
| C. same custom GCR via verbatim path (snapshot/restore = G64-class) | **PERSISTS** byte-for-byte |

**Verdict: the loss is DECODE-bound, not dirty/flush-bound.** The dirty flag and
the detach writeback both fire; a *standard* drive-side GCR write round-trips to
D64 fine. The D64 write-back (`fsimage_dxx_write_half_track`) decodes each track
GCR→sectors via `gcr_read_sector`; any sector the CBM decoder can't read is
written as **zeros** (`tmpSect` stays zero on `rf != CBMDOS_FDC_ERR_OK`). The
verbatim GCR path (`snapshotDiskImage`/`restoreDiskImage`, the same raw-GCR
mechanism a `.g64` target uses) keeps the exact bytes.

Matches the field evidence: the Utils-format BAM/dir (standard CBM GCR) decode +
persist; the game-data copy (custom GCR) decodes-fails → zeros.

**Snapshot boundary (secondary):** `drive_gcr_data_writeback_all` is a no-op in
the snapshot hook bundle (`vice1541/drive_snapshot.ts`), and D64 `media.bytes`
only updates on the writeback decode (seek/detach). So a session snapshot/dump
*without* a detach does not flush the D64 — a separate persistence-boundary gap.

## Open question (decides the fix)

The classifier proves the D64 decode is lossy for **non-decodable** GCR, but uses
a *synthetic* corrupted sector. It does NOT yet prove the real games write
truly-non-standard GCR. Two possibilities remain:

1. **Games write genuinely non-standard GCR** (custom sync/header/format) →
   D64 is inherently unsuitable for this save class → product must use a
   **G64-backed / verbatim-GCR** writable target, or a format-aware writeback.
2. **Games write standard CBM GCR** that `gcr_read_sector` (or the write timing)
   wrongly rejects → **port/decoder bug** in the D64 write-back path.

Decide by capturing the ACTUAL GCR Wasteland/Scramble write (real run) and
feeding it through `gcr_read_sector`, and/or reading the drive-code GCR writer
(`$062A`). Real-fixture regression gate still TODO: boot Scramble → write
HighScore → detach/reattach → assert sector bytes changed (+ same for Wasteland
Utils Copy).

## Environment

- Branch / commit: master @ 7b4e4140
- Surface: mcp full (runtime session) / ui-v3 Live drive
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`
- Tool / endpoint / tab: `runtime_session_*` + mounted writable media (Live drive)

## What happened

Running *Wasteland*'s in-game **Utils → Copy** disk duplicator (and equally its in-game
save) drives a **custom 1541 write job**, not a KERNAL/DOS file write. The C64 sends the
256-byte buffer over the game's own 2-bit `$DD00` serial protocol; the **1541 CPU** then
executes the loaded drive code to do a **GCR-level head write** (`$0300` cmd dispatch →
`CMD_WRITE_PATH $0338-$0362` → seek `$049E` → header-match `$0569` → GCR writer `$062A`
→ `STA $1C01`). The on-screen `"Writing."` step completes, but the mounted target image
shows **no game data written** — it stays byte-identical to the freshly Utils-formatted
blank (all sectors zero except T18/S0 BAM + T18/S1 dir).

This means custom drive-code GCR writes performed inside a runtime session are not being
persisted back to the mounted disk image. KERNAL/DOS file writes are not the path here —
the regular save-fidelity work (Spec 617 / BUG-017-area) does not cover a game that ships
its **own drive code** and writes raw GCR via the 1541 job queue.

## Expected

When a runtime session runs a program that uploads custom 1541 drive code and issues GCR
write jobs (`$062A`/`$1C01` head writes via the drive CPU), those writes must be applied
to the in-memory GCR track and **flushed back to the mounted image** on
detach/unmount/snapshot — so a writable `.d64`/`.g64` reflects the game's writes, exactly
as real 1541 true-drive emulation would. A subsequent re-read (or host-side inspection)
must see the written sectors.

## Repro steps

1. Mount a writable Wasteland working disk (standard 35-track CBM, id `WL`) as the copy
   target in a runtime session.
2. Boot Wasteland side 1, reach the title menu, choose **Utils**, run **Copy** for a side
   (the overlay shows `Reading.` then `Writing.`).
3. Let the copy finish, detach/unmount the image, inspect it on the host.

Minimal command / call:

```text
runtime_session_start  (Wasteland side 1, true-drive path, writable target mounted)
# navigate menu: Utils -> Copy -> side #
# after "Writing." completes:
runtime_media_unmount / snapshot, then inspect the target .d64 on disk
```

## Evidence

- Error / output (verbatim): the target image is unchanged after a reported copy —

```text
# all 4 GameDisks/*.d64 (post-"copy") == blanks/*.d64 byte-for-byte:
md5 GameDisks/Wasteland_s1.d64 .. s4  -> a839ece8fef5cefa3ba2d3a3edbb6d04 (all)
md5 blanks/blank_s1.d64 .. s4         -> a839ece8fef5cefa3ba2d3a3edbb6d04 (all)
# non-zero sectors per "copied" disk: 2/683  (only T18/S0 BAM + T18/S1 dir)
# disk name "WASTELAND BLANK", id WL  = fresh Utils format, zero game data
```

- NOTE on evidence strength: the four `GameDisks/*.d64` above were partly a host-side
  file copy of the blanks, so they are not by themselves proof of a runtime write-back
  failure. The bug is raised on the *mechanism*: Wasteland's write is a custom-drive-code
  GCR job, and we have not yet observed it persist to any mounted image. Needs a clean
  controlled run (below) to confirm and to capture the exact failing layer.

- Artifacts: project write-path analysis in
  `Wasteland_EF/docs/LOADER.md` §4c (Disk WRITE path) + §4d (working-disk format);
  drive write code `analysis/disk/wasteland_s1[...]/drivecode/t18s12-15_0300_disasm.asm`
  (`$0338` CMD_WRITE_PATH, `$062A` GCR writer); C64-side write branch in `02_2.0_full.asm`
  (`$FF00`: `LDA $F3; CMP #$02; BCS $FF79`).

## Scope guess (optional)

Reporter confirms the runtime **always runs true drive emulation** (no virtual-device /
KERNAL-trap path exists anymore) — so the custom `$0338` write job *does* execute on the
real 1541 CPU. That rules out the "job never ran" cause and points the bug at the
**write-back / persistence layer**:
1. GCR-track writes (`$062A` → `$1C01`) update the in-memory GCR track but are **not
   flushed back to the mounted image** on unmount/detach/snapshot (dirty-track
   write-back gap), OR the image-type write-back is missing/incomplete for the mounted
   format (note: working disks are mounted as **`.d64`**, not `.g64`).
2. Target effectively mounted read-only despite "writable" intent.

(Investigation of the MCP write-back code belongs to the runtime/MCP session, not this
report — left for the owner.)

## Notes / follow-up

- Confirm which runtime drive mode was active during the copy (true-drive vs virtual
  device). If virtual device: this overlaps the fastloader/true-drive contract
  (Spec 614 per-cycle scheduling, Spec 618 `$DD00` fastloader) and BUG should point there.
- Suggested controlled gate: boot Wasteland, run Utils Copy of one side into a writable
  blank, then re-read 3 known sectors via the same `$FC00` path AND host-inspect the
  image; both must show the written bytes.
- Cross-link: this blocks the Wasteland EF crack's writable-volume / save model design
  (the EF port must emulate this GCR write to a flash-backed volume).

---

## Resolution

- **Root cause:** the snapshot/dump GCR-flush hook was a no-op. VICE calls
  `drive_gcr_data_writeback_all()` before writing a snapshot (drive.c /
  drive-snapshot.c) so every dirty GCR track is decoded back into its `.d64`
  image; our `vice1541-facade.ts` installed `drive_gcr_data_writeback_all: () =>
  {}` into the drive_snapshot hooks. So a dump/snapshot taken while the disk was
  mounted captured the embedded `.d64` media payload at its clean baseline — the
  drive-side custom GCR writes (Wasteland Utils Copy, Scramble HighScore) rode
  only in the verbatim GCRIMAGE blob and never appeared in the `.d64` view. The
  per-op write path (VIA2 → rotation → write_next_bit → detach decode) was a
  faithful VICE port and worked end to end (proven by `smoke:023-via`); only the
  snapshot-flush wiring diverged.
- **Fix:** wire the facade's `drive_gcr_data_writeback_all` hook to the real
  `drive_gcr_data_writeback_all()` (drive.ts, already a faithful port of VICE
  drive.c:849-870) instead of the no-op (`src/runtime/headless/drive1541/
  vice1541-facade.ts`). Narrow: no G64 policy, no auto-conversion.
- **Fix commits:** audit `2250a8dc`; fix (this change).
- **Gate proving the fix:** `scripts/smoke-023-snapshot-flush.mjs`
  (`npm run smoke:023-snapshot-flush`, 4/4) — a dirty GCR track (written through
  the real `write_next_bit` sink, no detach) is blank in the mounted `.d64`
  before a snapshot and equals the written sector after `snapshot()` triggers the
  now-wired writeback-all; GCRIMAGE restore/read-back also sees the bytes.
  Plus `smoke:023-via` (6/6, real VIA→rotation path) and `smoke:023` (classifier)
  stay green; `probe-single-path` 25/25.
- **Prior "D64 decode-bound / unsuitable" finding:** documented ONLY as a
  synthetic boundary (a deliberately corrupted sector in `smoke:023`), NOT the
  real bug — VICE persists the same real `.d64`.
- **Regression risk:** low. The change only replaces a no-op with the existing
  faithful `drive_gcr_data_writeback_all` on the snapshot path; it flushes dirty
  GCR→image exactly as VICE does before a snapshot. Single-path probe green.
