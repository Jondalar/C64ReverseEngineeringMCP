# Bug: Custom true-drive (drive-side GCR) writes do not persist to a D64-backed mounted image

- **ID:** BUG-023
- **Date:** 2026-05-31
- **Reporter:** llm
- **Area:** runtime
- **Severity:** high
- **Status:** investigating <!-- open | investigating | fixed | wontfix | duplicate -->

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

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
