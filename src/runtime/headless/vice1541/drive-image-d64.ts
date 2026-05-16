// Spec 611 phase 611.7b — D64 image parser + GCR encoder.
//
// VICE source: src/diskimage/diskimage.c (tables) + src/diskimage/fsimage-dxx.c
//              (D64 byte layout) + src/diskimage/fsimage-gcr.c (encode path)
//              + src/gcr.c (gcr_convert_sector_to_GCR)
//
// Scope per Codex 17:08 UTC: D64 → VICE-shaped GCR track buffers only.
// No LOAD shortcut, no directory shortcut, no IEC changes.
//
// Format: stock 1541 D64 = 35 tracks, 683 sectors × 256 bytes = 174848.

import {
  CBMDOS_FDC_ERR_OK,
  gcr_convert_sector_to_GCR,
  NUM_MAX_BYTES_TRACK,
  type DiskTrack,
  type GcrHeader,
} from "./gcr.js";

/** Stock 1541 D64 file size — 35 tracks, no error info. */
export const D64_SIZE_35 = 174_848;
/** With error info: 35 × extra 1 byte per sector = +683. */
export const D64_SIZE_35_WITH_ERRORS = D64_SIZE_35 + 683;
/** 40-track D64 (some images extend to track 40). */
export const D64_SIZE_40 = 196_608;
export const D64_SIZE_40_WITH_ERRORS = D64_SIZE_40 + 768;

/** VICE diskimage.c:201-206 raw_track_size_d64[]. Index by speed_zone. */
export const RAW_TRACK_SIZE_D64: readonly number[] = [6250, 6666, 7142, 7692];

/** VICE diskimage.c:132-137 sector_map_d64[]. Index by speed_zone. */
export const SECTOR_MAP_D64: readonly number[] = [17, 18, 19, 21];

/** VICE diskimage.c:271-276 gap_size_d64[]. Inter-sector gap. */
export const GAP_SIZE_D64: readonly number[] = [9, 12, 17, 8];

/** VICE disk_image_header_gap_size for D64 = 9 (fixed). */
export const HEADER_GAP_D64 = 9;

/** VICE disk_image_sync_size for D64 = 5 (40 bits). */
export const SYNC_SIZE_D64 = 5;

/** VICE diskimage.c:82-94 disk_image_speed_map for D64.
 *  Returns 0..3 speed zone for the given track (1-based). */
export function diskImageSpeedMapD64(track: number): number {
  return (track < 31 ? 1 : 0) + (track < 25 ? 1 : 0) + (track < 18 ? 1 : 0);
}

/** Sectors-per-track lookup for D64. */
export function sectorsPerTrackD64(track: number): number {
  return SECTOR_MAP_D64[diskImageSpeedMapD64(track)]!;
}

/** Raw GCR track byte size for D64. */
export function rawTrackSizeD64(track: number): number {
  return RAW_TRACK_SIZE_D64[diskImageSpeedMapD64(track)]!;
}

/** Inter-sector gap byte size for D64. */
export function gapSizeD64(track: number): number {
  return GAP_SIZE_D64[diskImageSpeedMapD64(track)]!;
}

/** Linear byte offset in a 35-track D64 to (track, sector). */
export function d64SectorByteOffset(track: number, sector: number): number {
  // Pre-track cumulative sector count.
  let cum = 0;
  for (let t = 1; t < track; t++) cum += sectorsPerTrackD64(t);
  return (cum + sector) * 256;
}

/** Read disk-ID bytes (id1, id2) from T18S0 of a D64 image (0xA2, 0xA3). */
export function readD64DiskId(bytes: Uint8Array): { id1: number; id2: number } {
  const t18s0 = d64SectorByteOffset(18, 0);
  return { id1: bytes[t18s0 + 0xa2] ?? 0x30, id2: bytes[t18s0 + 0xa3] ?? 0x30 };
}

export interface D64ImageInfo {
  trackCount: number;
  sectorCount: number;
  hasErrorInfo: boolean;
}

/** Recognise the D64 file size and return layout info. */
export function probeD64(bytes: Uint8Array): D64ImageInfo {
  const len = bytes.length;
  if (len === D64_SIZE_35) return { trackCount: 35, sectorCount: 683, hasErrorInfo: false };
  if (len === D64_SIZE_35_WITH_ERRORS) return { trackCount: 35, sectorCount: 683, hasErrorInfo: true };
  if (len === D64_SIZE_40) return { trackCount: 40, sectorCount: 768, hasErrorInfo: false };
  if (len === D64_SIZE_40_WITH_ERRORS) return { trackCount: 40, sectorCount: 768, hasErrorInfo: true };
  throw new Error(`[VICE1541] unrecognised D64 size: ${len} bytes`);
}

/**
 * Encode one D64 track into a *temporary* GCR buffer (no wraparound
 * yet — the final-buffer skew copy happens in `encodeD64ToGcrTracks`).
 *
 * Per-sector layout matches VICE `fsimage-dxx.c:262-284`:
 *   - `gcr_convert_sector_to_GCR()` writes
 *     `SECTOR_GCR_SIZE_WITH_HEADER + headergap + synclen*2 + …`
 *     bytes (= 354 bytes with `headergap=9`, `synclen=5`).
 *   - Plus `gap` (per-zone inter-sector gap) AFTER each sector.
 *
 * Returns { data, bytesWritten } so the caller can compute
 * trackoffset like VICE does: `(ptr - tempgcr) - gap`.
 */
function encodeD64TrackTemp(
  d64Bytes: Uint8Array,
  track: number,
  diskId: { id1: number; id2: number },
): { data: Uint8Array; bytesWritten: number; gap: number; rawSize: number } {
  const sectorCount = sectorsPerTrackD64(track);
  const rawSize = rawTrackSizeD64(track);
  const gap = gapSizeD64(track);
  const data = new Uint8Array(rawSize);
  data.fill(0x55);

  // VICE per-sector write: SECTOR_GCR_SIZE_WITH_HEADER (335) +
  // headergap (9) + synclen*2 (10) = 354 bytes. Plus inter-sector
  // `gap` after each sector.
  const perSectorEncoded = 335 + HEADER_GAP_D64 + SYNC_SIZE_D64 * 2; // = 354
  let off = 0;
  for (let s = 0; s < sectorCount; s++) {
    const sectorOff = d64SectorByteOffset(track, s);
    const sectorBuf = d64Bytes.subarray(sectorOff, sectorOff + 256);
    const header: GcrHeader = {
      sector: s,
      track,
      id2: diskId.id2,
      id1: diskId.id1,
    };
    if (off + perSectorEncoded + gap > rawSize) break;
    gcr_convert_sector_to_GCR(
      sectorBuf,
      0,
      data,
      off,
      header,
      HEADER_GAP_D64,
      SYNC_SIZE_D64,
      CBMDOS_FDC_ERR_OK,
    );
    off += perSectorEncoded + gap;
  }
  return { data, bytesWritten: off, gap, rawSize };
}

/**
 * Encode the entire D64 image into per-track GCR buffers (1-indexed
 * tracks, slot 0 unused for symmetry with VICE's `tracks[1..N]`).
 *
 * VICE `fsimage-dxx.c:285-304` track-offset / wraparound copy:
 *
 *   trackoffset += (ptr - tempgcr) - gap;       // bytes written less last gap
 *   trackoffset += (track_size * 100) / 270;     // step-time bytes
 *   trackoffset %= track_size;
 *   memset(final, 0x55, track_size);
 *   memcpy(final + trackoffset, tempgcr, track_size - trackoffset);
 *   memcpy(final, tempgcr + (track_size - trackoffset), trackoffset);
 *
 * `trackoffset` is accumulated *across tracks*. Final buffer is the
 * temporary buffer rotated forward by `trackoffset` bytes (with
 * wraparound). This matches the physical disk's per-track skew
 * approximation called out in the VICE comment block.
 */
export function encodeD64ToGcrTracks(d64Bytes: Uint8Array): DiskTrack[] {
  const info = probeD64(d64Bytes);
  const diskId = readD64DiskId(d64Bytes);
  const tracks: DiskTrack[] = [{ data: null, size: 0 }];

  let trackoffset = 0;
  for (let t = 1; t <= info.trackCount; t++) {
    if (rawTrackSizeD64(t) > NUM_MAX_BYTES_TRACK) {
      throw new Error(
        `[VICE1541] D64 track ${t} raw_size ${rawTrackSizeD64(t)} > ${NUM_MAX_BYTES_TRACK}`,
      );
    }
    const temp = encodeD64TrackTemp(d64Bytes, t, diskId);
    trackoffset += temp.bytesWritten - temp.gap; // less the trailing gap of last sector
    trackoffset += Math.floor((temp.rawSize * 100) / 270);
    trackoffset = trackoffset % temp.rawSize;

    const final = new Uint8Array(temp.rawSize);
    final.fill(0x55);
    // Copy `tempgcr` rotated forward by `trackoffset` bytes:
    //   final[trackoffset .. rawSize-1]  = tempgcr[0 .. rawSize-trackoffset-1]
    //   final[0 .. trackoffset-1]        = tempgcr[rawSize-trackoffset .. rawSize-1]
    final.set(temp.data.subarray(0, temp.rawSize - trackoffset), trackoffset);
    final.set(temp.data.subarray(temp.rawSize - trackoffset), 0);
    tracks.push({ data: final, size: temp.rawSize });
  }
  return tracks;
}
