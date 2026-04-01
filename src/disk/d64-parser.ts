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
