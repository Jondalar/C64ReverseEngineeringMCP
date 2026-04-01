/**
 * G64 disk image parser.
 */

import {
  type DiskDirectory,
  type DiskFileEntry,
  type DiskImage,
  SECTORS_PER_TRACK,
  extractFileFromChain,
  parseDirectory,
} from "./base.js";
import { type DecodedSector, decodeGCRTrack } from "./gcr.js";

const G64_SIGNATURE = "GCR-1541";
const G71_SIGNATURE = "GCR-1571";

const HEADER_SIGNATURE = 0x00;
const HEADER_VERSION = 0x08;
const HEADER_TRACK_COUNT = 0x09;
const HEADER_TRACK_SIZE = 0x0a;
const HEADER_TRACK_OFFSETS = 0x0c;

export class G64Parser implements DiskImage {
  private readonly data: Uint8Array;
  private version = 0;
  private trackCount = 0;
  private maxTrackSize = 0;
  private readonly trackOffsets: number[] = [];
  private readonly speedZoneOffsets: number[] = [];
  private readonly sectorCache = new Map<string, Uint8Array | null>();

  constructor(data: Uint8Array) {
    this.data = data;
    this.parseHeader();
  }

  static isG64(data: Uint8Array): boolean {
    if (data.length < 12) return false;
    const sig = String.fromCharCode(...data.slice(0, 8));
    return sig === G64_SIGNATURE || sig === G71_SIGNATURE;
  }

  private parseHeader(): void {
    const sig = String.fromCharCode(...this.data.slice(HEADER_SIGNATURE, HEADER_SIGNATURE + 8));
    if (sig !== G64_SIGNATURE && sig !== G71_SIGNATURE) {
      throw new Error(`Invalid G64 signature: ${sig}`);
    }

    this.version = this.data[HEADER_VERSION];
    this.trackCount = this.data[HEADER_TRACK_COUNT];
    this.maxTrackSize = this.data[HEADER_TRACK_SIZE] | (this.data[HEADER_TRACK_SIZE + 1] << 8);

    for (let i = 0; i < this.trackCount; i++) {
      const offsetPos = HEADER_TRACK_OFFSETS + i * 4;
      const offset = this.data[offsetPos]
        | (this.data[offsetPos + 1] << 8)
        | (this.data[offsetPos + 2] << 16)
        | (this.data[offsetPos + 3] << 24);
      this.trackOffsets.push(offset >>> 0);
    }

    const speedZoneStart = HEADER_TRACK_OFFSETS + this.trackCount * 4;
    for (let i = 0; i < this.trackCount; i++) {
      const offsetPos = speedZoneStart + i * 4;
      const offset = this.data[offsetPos]
        | (this.data[offsetPos + 1] << 8)
        | (this.data[offsetPos + 2] << 16)
        | (this.data[offsetPos + 3] << 24);
      this.speedZoneOffsets.push(offset >>> 0);
    }
  }

  private getRawTrack(trackNum: number): Uint8Array | null {
    const trackIndex = (trackNum - 1) * 2;
    if (trackIndex < 0 || trackIndex >= this.trackOffsets.length) {
      return null;
    }

    const offset = this.trackOffsets[trackIndex];
    if (offset === 0) {
      return null;
    }

    const actualSize = this.data[offset] | (this.data[offset + 1] << 8);
    if (offset + 2 + actualSize > this.data.length) {
      return null;
    }

    return this.data.slice(offset + 2, offset + 2 + actualSize);
  }

  private decodeTrack(trackNum: number): DecodedSector[] {
    const trackData = this.getRawTrack(trackNum);
    return trackData ? decodeGCRTrack(trackData) : [];
  }

  getSector(track: number, sector: number): Uint8Array | null {
    const cacheKey = `${track}:${sector}`;
    if (this.sectorCache.has(cacheKey)) {
      return this.sectorCache.get(cacheKey) ?? null;
    }

    const maxSector = SECTORS_PER_TRACK[track];
    if (!maxSector || sector < 0 || sector >= maxSector) {
      this.sectorCache.set(cacheKey, null);
      return null;
    }

    const sectors = this.decodeTrack(track);
    let result: Uint8Array | null = null;

    for (const decoded of sectors) {
      if (decoded.track === track && decoded.sector === sector && decoded.dataValid) {
        result = decoded.data;
        break;
      }
    }

    for (const decoded of sectors) {
      const key = `${decoded.track}:${decoded.sector}`;
      if (!this.sectorCache.has(key) && decoded.dataValid) {
        this.sectorCache.set(key, decoded.data);
      }
    }

    if (!this.sectorCache.has(cacheKey)) {
      this.sectorCache.set(cacheKey, null);
    }

    return result;
  }

  getDirectory(): DiskDirectory {
    return parseDirectory((t, s) => this.getSector(t, s));
  }

  extractFile(entry: DiskFileEntry, stripLoadAddress = false): Uint8Array | null {
    return extractFileFromChain((t, s) => this.getSector(t, s), entry, stripLoadAddress);
  }

  getTrackCount(): number {
    return Math.floor(this.trackCount / 2);
  }

  getVersion(): number {
    return this.version;
  }
}
