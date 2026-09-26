// Synthetic D64 image builder. Produces a 35-track 174848-byte D64 with a
// single PRG file. Used for headless smoke fixtures (Spec 097 L1 + the
// G64 builder path).
//
// Layout follows the standard 1541 directory:
//   - Track 18 sector 0: BAM (block availability map + disk header).
//   - Track 18 sector 1: first directory sector.
//   - First file sector: track 17 sector 0 (or as configured).
//   - File chain via 2-byte next-track / next-sector pointer.

import { SECTORS_PER_TRACK } from "./base.js";

const D64_TRACK_COUNT = 35;
const D64_TOTAL_SECTORS = (() => {
  let total = 0;
  for (let t = 1; t <= D64_TRACK_COUNT; t++) total += SECTORS_PER_TRACK[t]!;
  return total;
})();

export const D64_BYTES = D64_TOTAL_SECTORS * 256; // 683 × 256 = 174848.

export interface D64BuildFile {
  // Filename is up to 16 PETSCII bytes. Caller supplies ASCII; builder
  // pads to 16 with $A0.
  name: string;
  // PRG payload INCLUDING the 2-byte load-address header (lo, hi).
  // For LOAD"X",8,1 the load address is honored; for `,8` the file
  // loads to its embedded address.
  payload: Uint8Array;
  // First track for the file chain. Default 17 (one track below directory).
  startTrack?: number;
  startSector?: number;
}

export interface D64BuildOptions {
  diskName?: string;       // up to 16 PETSCII; ASCII in, padded to 16.
  diskId?: string;         // 2 chars ASCII.
  files: D64BuildFile[];
}

// Compute D64 byte offset for (track, sector).
export function d64Offset(track: number, sector: number): number {
  if (track < 1 || track > D64_TRACK_COUNT) throw new Error(`track ${track} out of range`);
  const max = SECTORS_PER_TRACK[track]!;
  if (sector < 0 || sector >= max) throw new Error(`track ${track} sector ${sector} out of range`);
  let offset = 0;
  for (let t = 1; t < track; t++) offset += SECTORS_PER_TRACK[t]! * 256;
  offset += sector * 256;
  return offset;
}

function petPad16(s: string, fill = 0xa0): Uint8Array {
  const out = new Uint8Array(16);
  out.fill(fill);
  for (let i = 0; i < Math.min(16, s.length); i++) {
    let c = s.charCodeAt(i);
    if (c >= 0x61 && c <= 0x7a) c -= 0x20; // ASCII lower → PETSCII upper.
    out[i] = c & 0xff;
  }
  return out;
}

export function buildD64(opts: D64BuildOptions): Uint8Array {
  if (opts.files.length > 8) {
    throw new Error("synthetic builder limited to 8 files (single dir sector)");
  }
  const img = new Uint8Array(D64_BYTES);

  // ── BAM (track 18 sector 0) ─────────────────────────────────────────
  const bam = d64Offset(18, 0);
  img[bam + 0x00] = 18; // first dir track
  img[bam + 0x01] = 0x01; // first dir sector
  img[bam + 0x02] = 0x41; // DOS version 'A'
  img[bam + 0x03] = 0x00;
  // BAM entries: 4 bytes per track (free count + 24-bit allocation map),
  // tracks 1..35. We mark every sector free, then unset bits for the
  // sectors we allocate.
  const trackFreeCount: number[] = new Array(D64_TRACK_COUNT + 1).fill(0);
  const trackBits: number[][] = new Array(D64_TRACK_COUNT + 1).fill(0).map(() => [0xff, 0xff, 0xff]);
  for (let t = 1; t <= D64_TRACK_COUNT; t++) {
    trackFreeCount[t] = SECTORS_PER_TRACK[t]!;
    // High bits in trackBits beyond sector count must be 0.
    const sectors = SECTORS_PER_TRACK[t]!;
    const lastByte = Math.floor((sectors - 1) / 8);
    const trailingBitsInLastByte = sectors - lastByte * 8;
    trackBits[t]![lastByte] = (1 << trailingBitsInLastByte) - 1;
    for (let i = lastByte + 1; i < 3; i++) trackBits[t]![i] = 0;
  }
  // Disk header.
  const diskName = petPad16(opts.diskName ?? "SYNTHETIC");
  img.set(diskName, bam + 0x90);
  img[bam + 0xa0] = 0xa0;
  img[bam + 0xa1] = 0xa0;
  const diskId = opts.diskId ?? "S1";
  img[bam + 0xa2] = diskId.charCodeAt(0) & 0xff;
  img[bam + 0xa3] = (diskId.charCodeAt(1) ?? 0x20) & 0xff;
  img[bam + 0xa4] = 0xa0;
  img[bam + 0xa5] = 0x32; // '2'
  img[bam + 0xa6] = 0x41; // 'A'
  img[bam + 0xa7] = 0xa0;
  img[bam + 0xa8] = 0xa0;
  img[bam + 0xa9] = 0xa0;
  img[bam + 0xaa] = 0xa0;

  // ── Allocate file payloads ──────────────────────────────────────────
  // Each sector holds 254 data bytes + 2-byte (track, sector) chain link.
  const dirSec = d64Offset(18, 1);
  img[dirSec + 0x00] = 0x00; // last directory sector
  img[dirSec + 0x01] = 0xff; // bytes used = max
  // Mark dir sector + BAM allocated.
  const allocate = (track: number, sector: number) => {
    if (track === 0) return;
    trackFreeCount[track]!--;
    const byteIdx = Math.floor(sector / 8);
    const bitIdx = sector % 8;
    trackBits[track]![byteIdx] = trackBits[track]![byteIdx]! & ~(1 << bitIdx) & 0xff;
  };
  allocate(18, 0); // BAM
  allocate(18, 1); // dir

  for (let fileIndex = 0; fileIndex < opts.files.length; fileIndex++) {
    const f = opts.files[fileIndex]!;
    const startTrack = f.startTrack ?? 17;
    const startSector = f.startSector ?? 0;
    let track = startTrack;
    let sector = startSector;

    // Walk payload, write 254 bytes per sector + chain pointer.
    let written = 0;
    let prevOffset = -1;
    while (written < f.payload.length) {
      const remaining = f.payload.length - written;
      const chunk = Math.min(254, remaining);
      const offset = d64Offset(track, sector);
      img.set(f.payload.subarray(written, written + chunk), offset + 2);
      // Patch previous sector's chain link to point at this sector.
      if (prevOffset >= 0) {
        img[prevOffset + 0] = track;
        img[prevOffset + 1] = sector;
      }
      allocate(track, sector);
      // Default last-sector marker: track=0, sector=last-byte-pos.
      img[offset + 0] = 0x00;
      img[offset + 1] = (chunk + 1) & 0xff;
      prevOffset = offset;
      written += chunk;
      // Pick next sector. Simple linear allocation within the file's
      // starting track; if exhausted, advance to next track. Skip track 18.
      if (written < f.payload.length) {
        sector++;
        if (sector >= SECTORS_PER_TRACK[track]!) {
          sector = 0;
          track++;
          if (track === 18) track = 19;
          if (track > D64_TRACK_COUNT) {
            throw new Error("synthetic disk full");
          }
        }
      }
    }

    // Directory entry slot. Each slot is 32 bytes; slot 0 occupies
    // bytes 0..31 with bytes 0-1 being the sector's next-dir chain
    // pointer (already set above). Slots 1..7 start at +32, +64, etc.;
    // their own bytes 0-1 stay zero (only slot 0's bytes 0-1 are the
    // chain pointer).
    const slot = dirSec + fileIndex * 0x20;
    img[slot + 0x02] = 0x82; // PRG, $80 = file closed.
    img[slot + 0x03] = startTrack;
    img[slot + 0x04] = startSector;
    img.set(petPad16(f.name), slot + 0x05);
    // 0x15..0x17: REL side track/sector + record length (unused).
    // 0x18..0x1d: GEOS info — leave zero.
    const sectorCount = Math.ceil(f.payload.length / 254);
    img[slot + 0x1e] = sectorCount & 0xff;
    img[slot + 0x1f] = (sectorCount >> 8) & 0xff;
  }

  // ── Write BAM allocation map after files have allocated ────────────
  for (let t = 1; t <= D64_TRACK_COUNT; t++) {
    const entry = bam + 0x04 + (t - 1) * 4;
    img[entry + 0] = trackFreeCount[t]!;
    img[entry + 1] = trackBits[t]![0]!;
    img[entry + 2] = trackBits[t]![1]!;
    img[entry + 3] = trackBits[t]![2]!;
  }

  return img;
}
