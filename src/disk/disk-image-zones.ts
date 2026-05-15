// Spec 447.5 — VICE `diskimage.c` speed-zone + raw-track-size port
// (1541-only V1 scope).
//
// VICE source: src/diskimage/diskimage.c lines 82-266.
// Doctrine: 1:1 literal port per Epic 440 [[feedback_vice_no_alternatives]].
//
// 1541 G64 has 4 speed zones. Track-to-zone mapping is the canonical
// "outer faster, inner slower" pattern:
//   zone 3 (fastest, 21 sectors): tracks  1-17
//   zone 2 (        19 sectors):  tracks 18-24
//   zone 1 (        18 sectors):  tracks 25-30
//   zone 0 (slowest, 17 sectors): tracks 31+
//
// Raw byte counts per zone (bytes per full rotation):
//   zone 0 = 6250, zone 1 = 6666, zone 2 = 7142, zone 3 = 7692
//
// G64 / D64 / P64 / D71 / G71 share the same 4-zone table.
// D67 (2040), D80 / D82 (IEEE) are NOT 1541-V1 and OUT-V1 here.

/**
 * VICE `diskimage.c:201-207` — `raw_track_size_d64[SPEED_ZONE_COUNT]`.
 *
 * Bytes per raw GCR track for the 4 speed zones. 50 000 bits (zone 0,
 * tracks 31+) up to 61 538 bits (zone 3, tracks 1-17).
 */
export const RAW_TRACK_SIZE_D64 = [6250, 6666, 7142, 7692] as const;

/**
 * VICE `diskimage.c:82-94` — `disk_image_speed_map(format, track)` for
 * the DISK_IMAGE_TYPE_G64 / D64 / P64 branch.
 *
 *   (track < 31) + (track < 25) + (track < 18)
 *
 * Result is 0..3 (= speed zone index into `RAW_TRACK_SIZE_D64`).
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export function disk_image_speed_map_g64(track: number): number {
  return (track < 31 ? 1 : 0)
       + (track < 25 ? 1 : 0)
       + (track < 18 ? 1 : 0);
}

/**
 * VICE `diskimage.c:241-264` — `disk_image_raw_track_size(format, track)`
 * for the DISK_IMAGE_TYPE_G64 branch:
 *
 *   raw_track_size_d64[disk_image_speed_map(format, track)]
 *
 * Returns the canonical raw byte count for a track in a 1541 G64
 * image. Used by `fsimage_gcr_read_half_track` to allocate the
 * 0x55-filled buffer for empty half-tracks.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export function disk_image_raw_track_size_g64(track: number): number {
  return RAW_TRACK_SIZE_D64[disk_image_speed_map_g64(track)]!;
}

/**
 * Spec 447.5 — `MAX_GCR_TRACKS` from VICE `gcr.h`. Used by
 * `fsimage_read_gcr_image` to size the per-half-track loop. G64
 * file format max = 84 full tracks = 168 half-tracks.
 */
export const MAX_GCR_TRACKS = 168;
