/**
 * D64 disk image parser.
 */

import {
  type DiskDirectory,
  type DiskFileEntry,
  type DiskImage,
  SECTORS_PER_TRACK,
  extractFileFromChain,
  parseDirectory,
} from "./base.js";

const D64_SIZE_35_TRACKS = 174848;
const D64_SIZE_35_ERRORS = 175531;
const D64_SIZE_40_TRACKS = 196608;
const D64_SIZE_40_ERRORS = 197376;

export class D64Parser implements DiskImage {
  private readonly data: Uint8Array;
  private readonly trackCount: number;

  constructor(data: Uint8Array) {
    this.data = data;
    this.trackCount = this.detectTrackCount();
  }

  static isD64(data: Uint8Array): boolean {
    const validSizes = [
      D64_SIZE_35_TRACKS,
      D64_SIZE_35_ERRORS,
      D64_SIZE_40_TRACKS,
      D64_SIZE_40_ERRORS,
    ];

    if (!validSizes.includes(data.length) && !(data.length > 170000 && data.length < 200000)) {
      return false;
    }

    try {
      const bamOffset = D64Parser.getOffset(18, 0);
      if (bamOffset < 0 || bamOffset + 256 > data.length) return false;

      const dirTrack = data[bamOffset];
      const dirSector = data[bamOffset + 1];
      return dirTrack === 18 && dirSector >= 0 && dirSector < 19;
    } catch {
      return false;
    }
  }

  private static getOffset(track: number, sector: number): number {
    if (track < 1 || track > 42) return -1;

    const maxSector = SECTORS_PER_TRACK[track] || 17;
    if (sector < 0 || sector >= maxSector) return -1;

    let offset = 0;
    for (let t = 1; t < track; t++) {
      offset += (SECTORS_PER_TRACK[t] || 17) * 256;
    }
    offset += sector * 256;
    return offset;
  }

  private detectTrackCount(): number {
    return this.data.length >= D64_SIZE_40_TRACKS ? 40 : 35;
  }

  getSector(track: number, sector: number): Uint8Array | null {
    const offset = D64Parser.getOffset(track, sector);
    if (offset < 0 || offset + 256 > this.data.length) {
      return null;
    }
    return this.data.slice(offset, offset + 256);
  }

  /**
   * Spec 450 — overwrite a single 256-byte sector in-place.
   * Returns true on success, false if the address is invalid or
   * the source buffer is the wrong size.
   *
   * Note: the D64 format has no on-disk GCR layer; sectors are
   * stored as packed 256-byte blocks per track. Errors-byte map
   * (for 175531 / 197376 byte variants) is NOT updated by this
   * helper — callers that need a fresh error map must zero it
   * separately. For 1541 V1 write tests the error map stays at
   * default (no errors) which matches a freshly-formatted image.
   */
  setSector(track: number, sector: number, bytes: Uint8Array): boolean {
    if (bytes.length !== 256) return false;
    const offset = D64Parser.getOffset(track, sector);
    if (offset < 0 || offset + 256 > this.data.length) return false;
    this.data.set(bytes, offset);
    return true;
  }

  /** Spec 450 — full underlying image bytes (for sha256 / file dump). */
  toBuffer(): Uint8Array {
    return this.data.slice();
  }

  getDirectory(): DiskDirectory {
    return parseDirectory((t, s) => this.getSector(t, s));
  }

  extractFile(entry: DiskFileEntry, stripLoadAddress = false): Uint8Array | null {
    return extractFileFromChain((t, s) => this.getSector(t, s), entry, stripLoadAddress);
  }

  getTrackCount(): number {
    return this.trackCount;
  }
}
