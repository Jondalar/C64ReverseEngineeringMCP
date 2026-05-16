// Spec 611 phase 611.7c — G64 image parser (pre-encoded GCR).
//
// VICE source:  src/diskimage/fsimage-gcr.c (header / per-track seek
//               + read) + src/diskimage/fsimage-gcr.h.
// Doc anchor:   docs/vice-1541-arch.md §13 G (image formats).
//
// G64 is the pre-encoded GCR disk-image format. Per-track raw GCR
// bytes are stored verbatim — gaps, custom byte alignment, and any
// copy-protection signatures must be preserved as-is. NO sector
// reconstruction, NO byte normalization. The parser only walks the
// header, per-half-track table, and per-track length+bytes blocks.
//
// File layout per VICE `fsimage_gcr_seek_half_track()` /
// `fsimage_gcr_read_half_track()`:
//   bytes 0..8   = magic "GCR-1541\0" (or "GCR-1571\0" for 1571 G64)
//   byte  9      = num_half_tracks (typically 84 for 1541)
//   bytes 10..11 = max_track_length (uint16 little-endian)
//   bytes 12..    : num_half_tracks × uint32_le track-data offsets
//                    (0 = no data on this half-track)
//   bytes 12+4N.. : num_half_tracks × uint32_le speed-zone entries
//                    (0..3 = literal speed zone, or offset to per-track
//                     speed pattern; 611.7c reads the value as-is and
//                     only treats 0..3 as the zone)
//   per-track data block: 2-byte uint16_le `track_len` + `track_len`
//                          raw GCR bytes (no normalization)

import {
  type DiskTrack,
  MAX_GCR_TRACKS,
} from "./gcr.js";

export const G64_MAGIC_1541 = new Uint8Array([
  0x47, 0x43, 0x52, 0x2d, 0x31, 0x35, 0x34, 0x31, 0x00,
]);
export const G64_MAGIC_1571 = new Uint8Array([
  0x47, 0x43, 0x52, 0x2d, 0x31, 0x35, 0x37, 0x31, 0x00,
]);

export interface G64Header {
  variant: "1541" | "1571";
  numHalfTracks: number;       // typically 84 for 1541
  maxTrackLength: number;      // uint16 LE
}

export interface G64ParsedTrack {
  /** Original per-half-track table index (1-based, half-track number). */
  halfTrack: number;
  /** Byte length of stored track GCR data (= raw->size in VICE). */
  byteLength: number;
  /** Bit length implied by VICE's bit-walk model: equal to bytes*8;
   *  G64 doesn't carry a separate sub-byte bit count. Custom-gap /
   *  custom-protection lengths show up here as non-canonical
   *  byteLength values. */
  bitLength: number;
  /** Speed-zone entry as read from the second table — literal value.
   *  0..3 = canonical zone; values ≥ 4 are *pointers* to per-track
   *  speed patterns and are left as-is for higher phases. */
  speedZoneRaw: number;
  /** Raw GCR bytes — pre-encoded, unmodified. */
  data: Uint8Array;
}

export interface G64Image {
  header: G64Header;
  /** Length MAX_GCR_TRACKS (168). Slot i = half-track (i+1).
   *  null if the entry's offset was 0 (no data on that half-track). */
  tracks: (G64ParsedTrack | null)[];
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Parse G64 header. Throws on unknown magic / impossible field values. */
export function parseG64Header(bytes: Uint8Array): G64Header {
  if (bytes.length < 12) {
    throw new Error(`[VICE1541] G64 too small: ${bytes.length} bytes`);
  }
  const magic = bytes.subarray(0, 9);
  let variant: "1541" | "1571";
  if (bytesEq(magic, G64_MAGIC_1541)) variant = "1541";
  else if (bytesEq(magic, G64_MAGIC_1571)) variant = "1571";
  else {
    throw new Error(
      `[VICE1541] G64 header magic mismatch: got [${[...magic].map((v) => v.toString(16).padStart(2, "0")).join(",")}]`,
    );
  }
  const numHalfTracks = bytes[9] ?? 0;
  if (numHalfTracks === 0 || numHalfTracks > MAX_GCR_TRACKS) {
    throw new Error(`[VICE1541] G64 num_half_tracks out of range: ${numHalfTracks}`);
  }
  const maxTrackLength = readU16LE(bytes, 10);
  return { variant, numHalfTracks, maxTrackLength };
}

/**
 * Parse a G64 image. Preserves pre-encoded track bytes verbatim — no
 * gap normalization, no sector reconstruction, no byte alignment.
 *
 * Returns 168 slots (MAX_GCR_TRACKS). For typical 1541 G64 only the
 * first 84 will have non-null entries (half-tracks 1..84); higher
 * slots stay null (1571 tracks 85+).
 */
export function parseG64Image(bytes: Uint8Array): G64Image {
  const header = parseG64Header(bytes);
  const N = header.numHalfTracks;
  const trackOffsetTable = 12;
  const speedOffsetTable = trackOffsetTable + N * 4;

  const tracks: (G64ParsedTrack | null)[] = [];
  for (let i = 0; i < MAX_GCR_TRACKS; i++) tracks.push(null);

  for (let i = 0; i < N; i++) {
    const trackOffset = readU32LE(bytes, trackOffsetTable + i * 4);
    const speedRaw = readU32LE(bytes, speedOffsetTable + i * 4);
    if (trackOffset === 0) continue; // no data on this half-track

    // Per VICE fsimage_gcr_read_half_track: 2-byte LE track_len, then raw bytes.
    if (trackOffset + 2 > bytes.length) {
      throw new Error(
        `[VICE1541] G64 half-track ${i + 1}: trackOffset $${trackOffset.toString(16)} past EOF`,
      );
    }
    const byteLength = readU16LE(bytes, trackOffset);
    if (byteLength < 1 || byteLength > header.maxTrackLength) {
      throw new Error(
        `[VICE1541] G64 half-track ${i + 1}: track_len ${byteLength} out of [1..${header.maxTrackLength}]`,
      );
    }
    if (trackOffset + 2 + byteLength > bytes.length) {
      throw new Error(
        `[VICE1541] G64 half-track ${i + 1}: track data past EOF`,
      );
    }
    // Pre-encoded GCR bytes copied verbatim — NO normalization.
    const data = new Uint8Array(byteLength);
    data.set(bytes.subarray(trackOffset + 2, trackOffset + 2 + byteLength));
    tracks[i] = {
      halfTrack: i + 1,
      byteLength,
      bitLength: byteLength * 8,
      speedZoneRaw: speedRaw,
      data,
    };
  }

  return { header, tracks };
}

/**
 * Convert a parsed G64 image into the VICE `gcr_t.tracks[]` shape
 * (length MAX_GCR_TRACKS, DiskTrack per entry). Slots without data
 * use the parser-null state translated to `{ data: null, size: 0 }`.
 */
export function g64ToGcrTracks(g64: G64Image): DiskTrack[] {
  const out: DiskTrack[] = [];
  for (const slot of g64.tracks) {
    if (slot === null) out.push({ data: null, size: 0 });
    else out.push({ data: slot.data, size: slot.byteLength });
  }
  return out;
}
