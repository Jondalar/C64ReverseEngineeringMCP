// Synthetic G64 builder. Wraps a D64 image's logical sectors into a
// G64 physical track stream with proper SYNC + GCR header + GCR data
// per VICE conventions.
//
// Spec 413 — 1541 Phase G step 27 ("D64 attach: per track, encode
// each sector's header + data into GCR; store in
// gcr->tracks[ht].data").
//
// Doctrine: 1:1 VICE TDE port.
// Doc:  docs/vice-1541-arch.md §9.1 (D64 attach encode loop),
//       §9.4 (format dispatch),
//       §13 Phase G step 27,
//       §17 OQ-413-1 (eager at attach, NOT on-demand).
// VICE: src/drive/driveimage.c:169-220 drive_image_attach() →
//       src/diskimage/diskimage.c disk_image_read_image() →
//       src/diskimage/fsimage-dxx.c:149-280 fsimage_read_dxx_image().
//       VICE walks every track once at attach time and fills
//       gcr->tracks[half_track].data with the encoded GCR stream.
//       This builder does the same thing in TS: invoked at mount
//       time (mount.ts:142-143, headless-machine-kernel.ts:157-159)
//       so the G64Parser sees a fully-encoded image, not lazy-encoded
//       per-track.
//
// G64 file layout:
//   0x00..0x07: "GCR-1541"
//   0x08:       version (0)
//   0x09:       track count (84 — half-tracks 1.0, 1.5, … 42.5)
//   0x0a..0x0b: max track size (LE u16, e.g. 7928)
//   0x0c+ N×4:  track offsets table
//   then       speed-zone offsets table (N×4)
//   then       per-track: u16 actual size + GCR bytes padded to max size

import { SECTORS_PER_TRACK, TRACK_SPEED_ZONE } from "./base.js";
import { encodeSectorGCR } from "./gcr-encode.js";

const G64_SIGNATURE = [0x47, 0x43, 0x52, 0x2d, 0x31, 0x35, 0x34, 0x31];
const G64_TRACK_COUNT = 84;
const G64_MAX_TRACK_SIZE = 7928;

// Track byte capacity by speed zone. Standard VICE values.
const TRACK_BYTES_BY_ZONE: Record<number, number> = {
  0: 6250,
  1: 6666,
  2: 7142,
  3: 7692,
};

export interface G64BuildOptions {
  d64: Uint8Array;
  // Optional disk ID bytes for the GCR header. Default 'S1'.
  id1?: number;
  id2?: number;
}

function d64Offset(track: number, sector: number): number {
  let offset = 0;
  for (let t = 1; t < track; t++) offset += SECTORS_PER_TRACK[t]! * 256;
  offset += sector * 256;
  return offset;
}

export function buildG64(opts: G64BuildOptions): Uint8Array {
  const { d64 } = opts;
  const id1 = opts.id1 ?? 0x53; // 'S'
  const id2 = opts.id2 ?? 0x31; // '1'

  // Build encoded track buffers (only for the 35 real tracks; half-tracks
  // and tracks 36..42 stay zero-offset = "no data").
  const encodedTracks = new Map<number, Uint8Array>();
  for (let track = 1; track <= 35; track++) {
    const sectors = SECTORS_PER_TRACK[track]!;
    const zone = TRACK_SPEED_ZONE[track]!;
    const trackCapacity = TRACK_BYTES_BY_ZONE[zone]!;
    // Build the GCR stream for this track. Allocate gap so total fits
    // inside the speed-zone capacity. Each sector: SYNC(5) + 10 + gap(9) +
    // SYNC(5) + 325 + tail. Header+header-gap+data = 24 + 325 = 349. Two
    // SYNCs = 10. Per-sector fixed = 359. Tail gap = (capacity / sectors)
    // - 359, capped to a sensible minimum.
    const perSectorBudget = Math.floor(trackCapacity / sectors);
    let tailGap = perSectorBudget - (5 + 10 + 9 + 5 + 325);
    if (tailGap < 8) tailGap = 8;
    const buffers: Uint8Array[] = [];
    for (let sector = 0; sector < sectors; sector++) {
      const dataOffset = d64Offset(track, sector);
      const data = d64.subarray(dataOffset, dataOffset + 256);
      buffers.push(encodeSectorGCR(track, sector, id1, id2, data, tailGap));
    }
    let total = 0;
    for (const b of buffers) total += b.length;
    if (total > trackCapacity) total = trackCapacity;
    const trackData = new Uint8Array(trackCapacity);
    trackData.fill(0x55);
    let p = 0;
    for (const b of buffers) {
      const room = trackCapacity - p;
      if (room <= 0) break;
      const slice = b.length <= room ? b : b.subarray(0, room);
      trackData.set(slice, p);
      p += slice.length;
    }
    encodedTracks.set(track, trackData);
  }

  // Compute total file size.
  // Header: 12 bytes + 84 × 4 (offsets) + 84 × 4 (speed) = 12 + 672 = 684.
  // Per real track: 2 (size) + max-track-size (7928) padded.
  const headerSize = 12 + G64_TRACK_COUNT * 4 + G64_TRACK_COUNT * 4;
  const realTracks = encodedTracks.size;
  const trackBlockSize = 2 + G64_MAX_TRACK_SIZE;
  const totalSize = headerSize + realTracks * trackBlockSize;
  const out = new Uint8Array(totalSize);

  // Header.
  out.set(G64_SIGNATURE, 0);
  out[0x08] = 0;                                 // version
  out[0x09] = G64_TRACK_COUNT;                   // track count
  out[0x0a] = G64_MAX_TRACK_SIZE & 0xff;
  out[0x0b] = (G64_MAX_TRACK_SIZE >> 8) & 0xff;

  // Lay out tracks. Slot index = (track - 1) * 2; half-tracks are slot+1.
  let writePos = headerSize;
  for (let track = 1; track <= 35; track++) {
    const enc = encodedTracks.get(track);
    if (!enc) continue;
    const slotIndex = (track - 1) * 2;
    const offsetTablePos = 0x0c + slotIndex * 4;
    out[offsetTablePos + 0] = writePos & 0xff;
    out[offsetTablePos + 1] = (writePos >> 8) & 0xff;
    out[offsetTablePos + 2] = (writePos >> 16) & 0xff;
    out[offsetTablePos + 3] = (writePos >> 24) & 0xff;
    // Speed-zone table — encode as inline u32 = zone (0..3).
    const speedTablePos = 0x0c + G64_TRACK_COUNT * 4 + slotIndex * 4;
    const zone = TRACK_SPEED_ZONE[track]!;
    out[speedTablePos + 0] = zone & 0xff;
    // Track data: u16 actual size + GCR bytes (padded to max size by buffer fill).
    out[writePos + 0] = enc.length & 0xff;
    out[writePos + 1] = (enc.length >> 8) & 0xff;
    out.set(enc, writePos + 2);
    // Pad remainder of the slot with $55 (already zero — overwrite to be explicit).
    if (enc.length < G64_MAX_TRACK_SIZE) {
      out.fill(0x55, writePos + 2 + enc.length, writePos + 2 + G64_MAX_TRACK_SIZE);
    }
    writePos += trackBlockSize;
  }

  return out;
}
