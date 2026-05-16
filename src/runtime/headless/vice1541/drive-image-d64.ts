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
 * Encode a single D64 track to a GCR track buffer per VICE
 * fsimage-gcr.c semantics: for each sector in the track, emit
 * `gcr_convert_sector_to_GCR(buffer, dest, header, gap=header_gap_d64,
 * sync=sync_size_d64)` which writes 5 SYNC + 5 header + 5 ID + gap +
 * 5 SYNC + 325 data block bytes per sector. Inter-sector gap is the
 * per-zone `gap_size_d64`. Total track length is bounded by
 * raw_track_size_d64; any remaining bytes are 0x55 padding (VICE pads
 * with 0x55 = "no sync" filler).
 */
export function encodeD64Track(
  d64Bytes: Uint8Array,
  track: number,
  diskId: { id1: number; id2: number },
): DiskTrack {
  const sectorCount = sectorsPerTrackD64(track);
  const rawSize = rawTrackSizeD64(track);
  const gap = gapSizeD64(track);
  const data = new Uint8Array(rawSize);
  data.fill(0x55); // VICE fills unused bytes with 0x55.

  // Bytes per sector in the encoded GCR stream:
  //   5 SYNC + 5 header(GCR) + 5 ID(GCR) + header_gap + 5 SYNC +
  //   1 marker + 64 × 5 GCR data blocks + epilogue
  //   = 5 + 5 + 5 + 9 + 5 + 325 = 354 bytes per VICE.
  //   Plus per-zone inter-sector gap.
  const bytesPerSectorBlock = 5 + 5 + 5 + HEADER_GAP_D64 + 5 + 325; // = 354
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
    // Bounds check: don't overflow the raw track buffer.
    if (off + bytesPerSectorBlock + gap > rawSize) {
      // VICE quietly truncates excess; this shouldn't trigger with stock
      // D64 sizes but guard anyway.
      break;
    }
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
    off += bytesPerSectorBlock + gap;
  }
  return { data, size: rawSize };
}

/**
 * Encode the entire D64 image into per-track GCR buffers (1-indexed
 * tracks, slot 0 unused for symmetry with VICE's `tracks[1..N]`).
 */
export function encodeD64ToGcrTracks(d64Bytes: Uint8Array): DiskTrack[] {
  const info = probeD64(d64Bytes);
  const diskId = readD64DiskId(d64Bytes);
  const tracks: DiskTrack[] = [{ data: null, size: 0 }];
  for (let t = 1; t <= info.trackCount; t++) {
    if (rawTrackSizeD64(t) > NUM_MAX_BYTES_TRACK) {
      throw new Error(
        `[VICE1541] D64 track ${t} raw_size ${rawTrackSizeD64(t)} > ${NUM_MAX_BYTES_TRACK}`,
      );
    }
    tracks.push(encodeD64Track(d64Bytes, t, diskId));
  }
  return tracks;
}
