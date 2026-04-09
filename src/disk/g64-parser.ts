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

export interface G64TrackSectorInfo {
  track: number;
  sector: number;
  headerValid: boolean;
  dataValid: boolean;
  dataLength: number;
}

export interface G64TrackAnalysis {
  track: number;
  slotIndex: number;
  rawOffset: number;
  rawLength: number;
  expectedSectorCount?: number;
  speedZoneOffset?: number;
  sectors: G64TrackSectorInfo[];
  duplicateSectors: number[];
  missingSectors: number[];
  unexpectedSectors: number[];
  invalidHeaderCount: number;
  invalidDataCount: number;
}

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

  private trackToSlotIndex(trackNum: number): number {
    const slotIndex = Math.round((trackNum - 1) * 2);
    const normalizedTrack = 1 + (slotIndex / 2);
    if (Math.abs(normalizedTrack - trackNum) > 0.001) {
      throw new Error(`G64 track must be specified in 0.5 increments (for example 18 or 18.5). Received: ${trackNum}`);
    }
    if (slotIndex < 0 || slotIndex >= this.trackOffsets.length) {
      throw new Error(`Track ${trackNum} is outside the G64 image range.`);
    }
    return slotIndex;
  }

  private getRawTrack(trackNum: number): Uint8Array | null {
    const trackIndex = this.trackToSlotIndex(trackNum);

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

  getTrackAnalysis(trackNum: number): G64TrackAnalysis | null {
    const slotIndex = this.trackToSlotIndex(trackNum);
    const rawOffset = this.trackOffsets[slotIndex];
    if (rawOffset === 0) {
      return null;
    }

    const trackData = this.getRawTrack(trackNum);
    if (!trackData) {
      return null;
    }

    const decoded = decodeGCRTrack(trackData);
    const expectedSectorCount = SECTORS_PER_TRACK[Math.floor(trackNum)];
    const sectorCounts = new Map<number, number>();
    const sectors: G64TrackSectorInfo[] = decoded.map((sector) => {
      sectorCounts.set(sector.sector, (sectorCounts.get(sector.sector) ?? 0) + 1);
      return {
        track: sector.track,
        sector: sector.sector,
        headerValid: sector.headerValid,
        dataValid: sector.dataValid,
        dataLength: sector.data.length,
      };
    });

    const duplicateSectors = [...sectorCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([sector]) => sector)
      .sort((left, right) => left - right);

    const presentSectors = new Set(decoded.map((sector) => sector.sector));
    const missingSectors = expectedSectorCount === undefined
      ? []
      : Array.from({ length: expectedSectorCount }, (_, index) => index)
        .filter((sector) => !presentSectors.has(sector));

    const unexpectedSectors = expectedSectorCount === undefined
      ? []
      : [...presentSectors]
        .filter((sector) => sector < 0 || sector >= expectedSectorCount)
        .sort((left, right) => left - right);

    return {
      track: trackNum,
      slotIndex,
      rawOffset,
      rawLength: trackData.length,
      expectedSectorCount,
      speedZoneOffset: this.speedZoneOffsets[slotIndex] || undefined,
      sectors,
      duplicateSectors,
      missingSectors,
      unexpectedSectors,
      invalidHeaderCount: decoded.filter((sector) => !sector.headerValid).length,
      invalidDataCount: decoded.filter((sector) => !sector.dataValid).length,
    };
  }

  extractTrackSectors(trackNum: number, sectors?: number[]): Array<{
    track: number;
    sector: number;
    data: Uint8Array;
    dataValid: boolean;
    headerValid: boolean;
  }> {
    const wanted = sectors ? new Set(sectors) : undefined;
    return this.decodeTrack(trackNum)
      .filter((sector) => !wanted || wanted.has(sector.sector))
      .sort((left, right) => left.sector - right.sector)
      .map((sector) => ({
        track: sector.track,
        sector: sector.sector,
        data: sector.data,
        dataValid: sector.dataValid,
        headerValid: sector.headerValid,
      }));
  }

  analyzeAnomalies(): {
    version: number;
    trackCount: number;
    tracksWithData: number[];
    anomalies: Array<{
      track: number;
      issue: string;
      details?: string;
    }>;
  } {
    const anomalies: Array<{ track: number; issue: string; details?: string }> = [];
    const tracksWithData: number[] = [];

    for (let slotIndex = 0; slotIndex < this.trackOffsets.length; slotIndex++) {
      const trackNum = 1 + (slotIndex / 2);
      if (!this.trackOffsets[slotIndex]) {
        continue;
      }
      tracksWithData.push(trackNum);
      const analysis = this.getTrackAnalysis(trackNum);
      if (!analysis) {
        continue;
      }
      if (analysis.duplicateSectors.length > 0) {
        anomalies.push({
          track: trackNum,
          issue: "duplicate_sectors",
          details: analysis.duplicateSectors.join(", "),
        });
      }
      if (analysis.missingSectors.length > 0) {
        anomalies.push({
          track: trackNum,
          issue: "missing_sectors",
          details: analysis.missingSectors.join(", "),
        });
      }
      if (analysis.unexpectedSectors.length > 0) {
        anomalies.push({
          track: trackNum,
          issue: "unexpected_sector_ids",
          details: analysis.unexpectedSectors.join(", "),
        });
      }
      if (analysis.invalidDataCount > 0) {
        anomalies.push({
          track: trackNum,
          issue: "invalid_data_blocks",
          details: String(analysis.invalidDataCount),
        });
      }
      if (analysis.sectors.some((sector) => sector.track !== Math.floor(trackNum))) {
        anomalies.push({
          track: trackNum,
          issue: "off_track_headers",
          details: analysis.sectors
            .filter((sector) => sector.track !== Math.floor(trackNum))
            .map((sector) => `${sector.track}/${sector.sector}`)
            .join(", "),
        });
      }
    }

    return {
      version: this.version,
      trackCount: this.getTrackCount(),
      tracksWithData,
      anomalies,
    };
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
