# Bug: The D64 encoder truncates every image to 35 tracks, so a 40-track release loses 85 blocks

- **ID:** BUG-045
- **Date:** 2026-08-14
- **Reporter:** human ("Das Spiel fordert Disk A an, ich lege sie ein, SPACE — es geht nichts weiter")
- **Area:** runtime (trx64-core GCR encoder + daemon media detection)
- **Severity:** high (a whole class of releases is silently unreadable, and the failure looks like a loader hang)
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## What happened

The game asks for Disk A. Mounting it reports success. Pressing SPACE does nothing —
the game never continues. The suspicion was the cockpit (`/mount`, the keyboard path,
the transport). All three were innocent.

## Root cause

**The track count is a property of the image. TRX64 treated it as a property of the
format.**

`gcr.rs` carried

```rust
pub const D64_TRACKS: u8 = 35;
```

and `from_d64` branched on it:

```rust
if track <= D64_TRACKS { /* encode the sectors */ }
else { /* 0x55 fill — an unformatted track */ }
```

`d64_linear_sector` returned `None` above track 35, and `write_dxx_half_track` carried
the same bound in the other direction.

**The disks are 40-track images.** All 15 files are 196 608 bytes = 768 blocks
(35 tracks would be 683 blocks = 174 848). Measured, not assumed:

| file | tracks 36-40 |
|---|---|
| disk A | 21 684 of 21 760 bytes occupied — **99.7 %** |
| disk B | 99.6 % |
| the boot disk | 78.5 % (track 40 blank) |

So **85 blocks = 21 760 bytes per disk** were replaced by an empty track. The loader
steps to track 36, finds no sync, and waits. That is the SPACE that does nothing.

Detection was not at fault and that is what made it hard to see: `D64_SIZES` listed
196 608, so `media/mount` correctly answered "d64" and reported success. The truncation
happened one layer below, in the encoder, without a word.

## What VICE does

`disk_image_check_for_d64` (fsimage-probe.c:83-122) walks 35 → 42, every extra track
adding 17 blocks (they all sit in speed zone 0), matching the length either bare
(`blocks * 256`) or with one error byte per block, and then sets **`image->tracks`**:

```c
checkimage_tracks = NUM_TRACKS_1541;        /* start at track 35 */
checkimage_blocks = D64_FILE_SIZE_35 / 256;
while (1) {
    if (realsize == checkimage_blocks * 256) { errorinfo = 0; break; }
    else if (realsize == checkimage_blocks * 256 + checkimage_blocks) { errorinfo = 1; break; }
    checkimage_tracks++;
    checkimage_blocks += 17;
    if (checkimage_tracks > MAX_TRACKS_1541) return 0;
}
```

Every later check compares against `image->tracks`, never against a constant.

## Resolution

- **Core:** `d64_tracks_for_len(len) -> Option<(tracks, has_error_map)>` ports the VICE
  walk; `d64_tracks_of(bytes)` is the convenience form. `from_d64` derives the count
  from the image, `d64_linear_sector(track, sector, tracks)` takes it as a parameter
  (the way VICE compares against `image->tracks` rather than a constant), and
  `write_dxx_half_track` derives it too — so a save on track 40 is no longer dropped
  with `-1`.
- **Daemon:** `D64_SIZES`, a four-entry table, is gone. `detect_media_kind` calls the
  same walk, so 36/37/38/39/41/42-track images are recognised as well — they were
  rejected outright before.
- **Zone math needed no change:** `d64_speed_zone` already returns zone 0 for tracks
  31-42 (17 sectors, 6250 raw bytes). Only the cap was wrong.

### Gates

- `a_d64_length_names_its_track_count` — the whole 35..42 grid, bare and with error map,
  plus the rejections (0 bytes, off-grid, 43 tracks). Names 196 608 explicitly.
- `a_40_track_d64_encodes_the_tracks_past_35` — every sector of tracks 36-40 decodes back
  to the image's own bytes.
- `a_35_track_d64_leaves_track_36_empty` — widening the bound must not invent tracks the
  file does not carry.
- `d64_write_back_reaches_track_40` — the write direction, which had the same cap.
- `a_mounted_40_track_disk_carries_its_extra_tracks` (daemon) — detection *and* encoding
  together, because detection alone was already green while the disk was being truncated.

### Verified against the real disk

A throwaway probe over a real 40-track release (not committed): 196 608 bytes → 40 tracks, and
**85 sectors on tracks 36-40 round-tripped byte-exact**. Before the fix those same 85
sectors were `0x55` fill.

## Notes / follow-up

- **The error map is still not applied.** A D64 may carry one (175 531 / 197 376 …), and
  such an image mounts and reads its data area normally — but a disk whose protection
  relies on a deliberate read error reads back clean. Now stated at
  `write_dxx_half_track` instead of being implied. Own piece of work.
- **One image in that folder had no write protect** (`rw-rw-r--`;
  the other fourteen are `r--r--r--`). TRX64 mounts every disk read/write and persists
  dirty tracks back into the original file. Its mtime still says 2001, so nothing has
  been written yet — but now that tracks 36-40 are live, a save would land in the
  original. See `project_no_readonly_disk_mount`.
- Same shape as BUG-041: a question about a file was answered by a constant instead of by
  the file.
