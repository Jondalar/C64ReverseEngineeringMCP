// Spec 611 phase 611.3 — explicit `drive_init()` port.
//
// VICE source: src/drive/drive.c:239-261
//   drive->byte_ready_level = 1;
//   drive->byte_ready_edge  = 1;
//   drive->GCR_write_value  = 0x55;
//   drive->read_write_mode  = 1;
//   drive_set_half_track(36, 0, drive);
//
// Spec 611 §1 forbids silently writing these values in the allocation
// helper (`createAllocatedDriveContext()`). They live here, on the
// `driveInit()` boundary, so the post-init state is observable in the
// gate evidence and 611.4+ cannot drift from VICE bring-up order.

import type { DiskUnitContext } from "./diskunit.js";
import { RW_MODE_READ, type DriveContext } from "./drive-context.js";

/**
 * The default starting half-track per VICE drive.c:261
 *   drive_set_half_track(36, 0, drive)
 * 36 half-tracks = track 18 (the directory track on a 1541).
 */
export const DRIVE_INIT_DEFAULT_HALFTRACK = 36;

/** GCR_write_value initial pattern per VICE drive.c:242. */
export const DRIVE_INIT_GCR_WRITE_VALUE = 0x55;

/**
 * Port of VICE `drive_init()` for the 1541 drive slot 0.
 *
 * Call this once after `createAllocatedDiskUnitContext()` +
 * `createAllocatedDriveContext()` are wired together. Must NOT be
 * called twice without an intervening `lib_calloc()`-equivalent reset.
 */
export function driveInit(diskunit: DiskUnitContext): void {
  const drive: DriveContext | null = diskunit.drives[0] ?? null;
  if (!drive) {
    throw new Error(
      "[VICE1541] driveInit: diskunit.drives[0] is null. " +
        "Call createAllocatedDriveContext(0) and wire it before driveInit().",
    );
  }
  if (drive.diskunit !== diskunit) {
    throw new Error(
      "[VICE1541] driveInit: drive.diskunit back-pointer not set. " +
        "Set drive.diskunit = diskunit before driveInit().",
    );
  }

  // VICE drive.c:239-261 post-init writes.
  drive.byteReadyLevel = 1;
  drive.byteReadyEdge = 1;
  drive.gcrWriteValue = DRIVE_INIT_GCR_WRITE_VALUE;
  drive.readWriteMode = RW_MODE_READ; // = 1
  driveSetHalfTrack(drive, DRIVE_INIT_DEFAULT_HALFTRACK, 0);

  diskunit.enable = 1; // drive is now usable
}

/**
 * Port of VICE `drive_set_half_track(num, side, drive)`
 * (src/drive/drive.c:689-).
 *
 * Phase 611.3 covered the positional effect (write the new
 * current_half_track + side). Phase 611.7d adds the GCR track pointer
 * recalc per VICE drive.c:721:
 *
 *     dptr->GCR_track_start_ptr =
 *         dptr->gcr->tracks[dptr->current_half_track - 2 + side*tmp].data;
 *
 * For 1541 (single-side), `side = 0` so the per-half-track buffer is
 * `gcr->tracks[current_half_track - 2]`. With no image attached
 * (gcr === null), gcrTrackStartPtr stays null and rotation_1541_simple
 * falls back to byte=0.
 */
export function driveSetHalfTrack(
  drive: DriveContext,
  halfTrack: number,
  side: number,
): void {
  drive.currentHalfTrack = halfTrack;
  drive.side = side;
  // GCR pointer recalc per VICE drive.c:721 (1541 single-side path).
  if (drive.gcr !== null) {
    const idx = halfTrack - 2;
    const slot = drive.gcr.tracks[idx];
    if (slot && slot.data) {
      drive.gcrTrackStartPtr = slot.data;
      drive.gcrCurrentTrackSize = slot.size;
    } else {
      drive.gcrTrackStartPtr = null;
      drive.gcrCurrentTrackSize = 0;
    }
  }
  // Rotation accumulator reset deferred to rotation_set_track if needed.
}
