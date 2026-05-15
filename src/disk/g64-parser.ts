/**
 * G64 disk image parser.
 */

import { createHash } from "node:crypto";
import {
  type DiskDirectory,
  type DiskFileEntry,
  type DiskImage,
  SECTORS_PER_TRACK,
  extractFileFromChain,
  parseDirectory,
} from "./base.js";
import {
  type DecodedSector,
  type GCRBlockPairInspection,
  type GCRHeaderCandidate,
  type GCRReadSectorResult,
  type GCRTrackInspection,
  type SyncMark,
  decodeGCRTrack,
  findSectorHeaderLikeVice,
  findAllSyncMarks,
  inspectGCRTrack,
  readSectorLikeVice,
  renderGCRTrackAscii,
  scanSectorHeadersLikeVice,
} from "./gcr.js";
import {
  MAX_GCR_TRACKS,
  disk_image_raw_track_size_g64,
} from "./disk-image-zones.js";

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
  halfTrack: number;
  slotIndex: number;
  rawOffset: number;
  rawLength: number;
  expectedSectorCount?: number;
  speedZoneRaw: number;
  speedZoneValue?: number;
  speedZoneTableOffset?: number;
  sectors: G64TrackSectorInfo[];
  duplicateSectors: number[];
  missingSectors: number[];
  unexpectedSectors: number[];
  invalidHeaderCount: number;
  invalidDataCount: number;
}

export interface G64SlotInfo {
  track: number;
  halfTrack: number;
  slotIndex: number;
  rawOffset: number;
  rawLength: number;
  hasData: boolean;
  speedZoneRaw: number;
  speedZoneValue?: number;
  speedZoneTableOffset?: number;
}

export interface G64TrackSyncInfo {
  track: number;
  halfTrack: number;
  slotIndex: number;
  rawLength: number;
  syncCount: number;
  syncs: SyncMark[];
}

export interface G64TrackBlockInspection {
  track: number;
  halfTrack: number;
  slotIndex: number;
  rawLength: number;
  chosenParity: 0 | 1;
  chosenParityScore: number;
  alternativeParityScore: number;
  asciiMap: string;
  pairs: GCRBlockPairInspection[];
}

export interface G64ViceStyleSectorRead {
  track: number;
  halfTrack: number;
  slotIndex: number;
  sector: number;
  result: GCRReadSectorResult;
}

export interface G64LutReference {
  track: number;
  sector?: number;
  offset?: number;
  label?: string;
  sourceLine: string;
}

interface G64TrackFingerprint {
  track: number;
  halfTrack: number;
  slotIndex: number;
  rawHash: string;
  decodedHash?: string;
  fillSignature?: string;
  analysis: G64TrackAnalysis;
}

function hashBytes(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

function hashDecodedSectors(sectors: DecodedSector[]): string | undefined {
  if (!sectors.length) {
    return undefined;
  }
  const hash = createHash("sha1");
  const sorted = [...sectors].sort((left, right) => left.sector - right.sector);
  for (const sector of sorted) {
    hash.update(Uint8Array.from([sector.track & 0xff, sector.sector & 0xff, sector.headerValid ? 1 : 0, sector.dataValid ? 1 : 0]));
    hash.update(sector.data);
  }
  return hash.digest("hex");
}

function detectFillSignature(sectors: DecodedSector[]): string | undefined {
  if (!sectors.length) {
    return undefined;
  }
  const valid = sectors.filter((sector) => sector.data.length === 256);
  if (!valid.length) {
    return undefined;
  }
  const previewLength = 4;
  const preview = valid[0]!.data.slice(0, previewLength);
  if (!valid.every((sector) => sector.data.slice(0, previewLength).every((byte, index) => byte === preview[index]!))) {
    return undefined;
  }
  const fillerLike = valid.every((sector) => {
    const distinct = new Set(sector.data);
    if (distinct.size > 4) {
      return false;
    }
    const frequency = new Map<number, number>();
    for (const byte of sector.data) {
      frequency.set(byte, (frequency.get(byte) ?? 0) + 1);
    }
    const dominant = [...frequency.values()].sort((left, right) => right - left)[0] ?? 0;
    return dominant >= 240;
  });
  if (!fillerLike) {
    return undefined;
  }
  const previewText = [...valid[0]!.data.slice(0, 8)]
    .map((byte) => `$${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join(" ");
  return `${previewText}${valid[0]!.data.length > previewLength ? " ..." : ""}`;
}

export class G64Parser implements DiskImage {
  private readonly data: Uint8Array;
  private version = 0;
  private trackCount = 0;
  private maxTrackSize = 0;
  private readonly trackOffsets: number[] = [];
  private readonly speedZoneOffsets: number[] = [];
  private readonly sectorCache = new Map<string, Uint8Array | null>();

  // Spec 447.5 Fix #4 (Option A — user choice 2026-05-15) — literal
  // VICE `fsimage_read_gcr_image` semantics: pre-load all 168
  // half-tracks at parser construction. Each slot is a real
  // canonical-sized Uint8Array (loaded from the file when
  // trackOffsets[slot] != 0, 0x55-filled when offset == 0 and slot
  // is within trackCount, 0x00-filled for slots beyond trackCount).
  // Indexed by `slotIndex` (0..167).
  private readonly preloadedTracks: Uint8Array[] = [];

  constructor(data: Uint8Array) {
    this.data = data;
    this.parseHeader();
    this.preloadAllTracks();
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

    // Spec 447.5 — VICE fsimage-gcr.c:98-102 validates num_half_tracks
    // against MAX_GCR_TRACKS. Port: throw on overflow.
    if (this.trackCount > MAX_GCR_TRACKS) {
      throw new Error(
        `G64 track count ${this.trackCount} exceeds MAX_GCR_TRACKS=${MAX_GCR_TRACKS}`,
      );
    }

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

  /**
   * Spec 447.5 Fix #4 (Option A) — literal `fsimage_read_gcr_image`
   * (VICE fsimage-gcr.c:53-75). Loops all `MAX_GCR_TRACKS` half-track
   * slots, allocates a canonical-sized buffer for each, and fills it
   * according to VICE semantics:
   *
   *   - slot < trackCount && offset != 0 — read track bytes from file
   *     (validated against maxTrackSize per Fix #3).
   *   - slot < trackCount && offset == 0 — allocate `disk_image_raw_track_size_g64`
   *     bytes, memset(0x55) (Fix #1).
   *   - slot >= trackCount — allocate canonical-sized buffer,
   *     memset(0x00). VICE uses 0x00 here, distinct from the
   *     0x55-canonical empty-track buffer.
   *
   * After this loop, `preloadedTracks[slot]` is non-null for every
   * slot in `0..MAX_GCR_TRACKS-1`. Drive emulation never needs to
   * branch on a null pointer.
   */
  private preloadAllTracks(): void {
    for (let slot = 0; slot < MAX_GCR_TRACKS; slot++) {
      const halfTrack = slot + 2; // VICE half_track = slot + 2 (1-based half-track count)
      const wholeTrack = halfTrack >> 1;

      if (slot < this.trackCount) {
        const offset = this.trackOffsets[slot] ?? 0;
        if (offset !== 0) {
          // Existing track — read track_len + bytes from file.
          if (offset + 2 > this.data.length) {
            throw new Error(
              `G64 track ${wholeTrack} (slot ${slot}) offset ${offset} exceeds file size ${this.data.length}`,
            );
          }
          const trackLen = this.data[offset]! | (this.data[offset + 1]! << 8);
          // Spec 447.5 Fix #3 — VICE fsimage-gcr.c:154-159 validation.
          if (trackLen < 1 || trackLen > this.maxTrackSize) {
            throw new Error(
              `G64 track ${wholeTrack} (slot ${slot}) length ${trackLen} not in [1, ${this.maxTrackSize}]`,
            );
          }
          if (offset + 2 + trackLen > this.data.length) {
            throw new Error(
              `G64 track ${wholeTrack} (slot ${slot}) extends past file (offset=${offset}, len=${trackLen}, file=${this.data.length})`,
            );
          }
          this.preloadedTracks.push(
            new Uint8Array(this.data.slice(offset + 2, offset + 2 + trackLen)),
          );
        } else {
          // Spec 447.5 Fix #1 — empty half-track in file (offset==0).
          // VICE fsimage-gcr.c:168-172 allocates canonical-size + 0x55 fill.
          const size = disk_image_raw_track_size_g64(wholeTrack);
          const buf = new Uint8Array(size);
          buf.fill(0x55);
          this.preloadedTracks.push(buf);
        }
      } else {
        // Beyond trackCount — VICE fsimage-gcr.c:67-72 zero-fills.
        const size = disk_image_raw_track_size_g64(wholeTrack);
        const buf = new Uint8Array(size);
        // memset 0 (Uint8Array default)
        this.preloadedTracks.push(buf);
      }
    }
  }

  private trackToSlotIndex(trackNum: number): number {
    const slotIndex = Math.round((trackNum - 1) * 2);
    const normalizedTrack = 1 + (slotIndex / 2);
    if (Math.abs(normalizedTrack - trackNum) > 0.001) {
      throw new Error(`G64 track must be specified in 0.5 increments (for example 18 or 18.5). Received: ${trackNum}`);
    }
    // Spec 447.5 Fix #4 — Option A preloads all MAX_GCR_TRACKS slots,
    // so callers may query any slot in [0, MAX_GCR_TRACKS-1] even if
    // the file's declared trackCount is smaller. Slots beyond
    // trackCount contain zero-filled canonical buffers per VICE
    // fsimage_read_gcr_image semantics.
    if (slotIndex < 0 || slotIndex >= MAX_GCR_TRACKS) {
      throw new Error(`Track ${trackNum} is outside the G64 image range.`);
    }
    return slotIndex;
  }

  private slotIndexToTrack(slotIndex: number): number {
    return 1 + (slotIndex / 2);
  }

  private slotIndexToHalfTrack(slotIndex: number): number {
    return slotIndex + 2;
  }

  private resolveSpeedZone(slotIndex: number): {
    raw: number;
    value?: number;
    tableOffset?: number;
  } {
    const raw = this.speedZoneOffsets[slotIndex] ?? 0;
    if (raw <= 3) {
      return { raw, value: raw };
    }
    if (raw + 1 <= this.data.length) {
      return {
        raw,
        value: this.data[raw],
        tableOffset: raw,
      };
    }
    return { raw };
  }

  // Spec 447.5 — serves preloaded buffer (Option A). Returns null
  // only when slotIndex is out of bounds (= track > 84). For any
  // valid 1541 / 1571 slot, returns a real Uint8Array — non-empty
  // tracks contain GCR data from the file, empty tracks contain
  // 0x55-fill (literal VICE fsimage_gcr_read_half_track semantics).
  private getRawTrackBySlotIndex(slotIndex: number): Uint8Array | null {
    if (slotIndex < 0 || slotIndex >= MAX_GCR_TRACKS) return null;
    return this.preloadedTracks[slotIndex] ?? null;
  }

  private getRawTrack(trackNum: number): Uint8Array | null {
    return this.getRawTrackBySlotIndex(this.trackToSlotIndex(trackNum));
  }

  // Spec 062 Sprint 62: public accessor for the drive emulator's
  // track-buffer needs the raw GCR byte stream.
  //
  // Spec 447.5: returns the SHARED preloaded Uint8Array (no copy).
  // Drive writes via `_write_next_bit` mutate the underlying buffer
  // directly; this matches VICE pointer semantics where
  // `dptr->GCR_track_start_ptr` aliases the in-memory track buffer
  // owned by `disk_image_t->gcr->tracks[half_track].data`.
  //
  // Spec 450.x: shared reference is REQUIRED for drive write-back to
  // propagate into the persist path. The prior `new Uint8Array(raw)`
  // copy detached drive writes from the track buffer and lost them.
  getRawTrackBytes(trackNum: number): Uint8Array | null {
    return this.getRawTrack(trackNum);
  }

  // Spec 062 Sprint 62: returns the original underlying file bytes
  // (read-only — used by session-persist.ts to clone the image and
  // splice in modified tracks).
  getRawImageBytes(): Uint8Array {
    return this.data;
  }

  // Spec 062 Sprint 62: writes modified track bytes back into a copy
  // of the image. Caller passes the modified buffer per track. Returns
  // the new image bytes (length unchanged; buffer copied + spliced).
  buildModifiedImage(modifiedTracks: Map<number, Uint8Array>): Uint8Array {
    const out = new Uint8Array(this.data.length);
    out.set(this.data);
    for (const [trackNum, bytes] of modifiedTracks) {
      const slotIndex = this.trackToSlotIndex(trackNum);
      const offset = this.trackOffsets[slotIndex]!;
      if (offset === 0) continue;
      const actualSize = out[offset]! | (out[offset + 1]! << 8);
      const writeLen = Math.min(bytes.length, actualSize);
      out.set(bytes.slice(0, writeLen), offset + 2);
    }
    return out;
  }

  // (track count exposed via existing getTrackCount further down)

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
    const expectedSectorCount = Number.isInteger(trackNum)
      ? SECTORS_PER_TRACK[Math.floor(trackNum)]
      : undefined;
    const speedZone = this.resolveSpeedZone(slotIndex);
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
      halfTrack: this.slotIndexToHalfTrack(slotIndex),
      slotIndex,
      rawOffset,
      rawLength: trackData.length,
      expectedSectorCount,
      speedZoneRaw: speedZone.raw,
      speedZoneValue: speedZone.value,
      speedZoneTableOffset: speedZone.tableOffset,
      sectors,
      duplicateSectors,
      missingSectors,
      unexpectedSectors,
      invalidHeaderCount: decoded.filter((sector) => !sector.headerValid).length,
      invalidDataCount: decoded.filter((sector) => !sector.dataValid).length,
    };
  }

  getSlotInfo(trackNum: number): G64SlotInfo | null {
    const slotIndex = this.trackToSlotIndex(trackNum);
    const rawOffset = this.trackOffsets[slotIndex];
    const trackData = this.getRawTrackBySlotIndex(slotIndex);
    const speedZone = this.resolveSpeedZone(slotIndex);
    return {
      track: this.slotIndexToTrack(slotIndex),
      halfTrack: this.slotIndexToHalfTrack(slotIndex),
      slotIndex,
      rawOffset,
      rawLength: trackData?.length ?? 0,
      hasData: rawOffset !== 0 && trackData !== null,
      speedZoneRaw: speedZone.raw,
      speedZoneValue: speedZone.value,
      speedZoneTableOffset: speedZone.tableOffset,
    };
  }

  listSlots(includeEmpty = false): G64SlotInfo[] {
    const slots: G64SlotInfo[] = [];
    for (let slotIndex = 0; slotIndex < this.trackOffsets.length; slotIndex += 1) {
      const track = this.slotIndexToTrack(slotIndex);
      const info = this.getSlotInfo(track);
      if (!info) {
        continue;
      }
      if (!includeEmpty && !info.hasData) {
        continue;
      }
      slots.push(info);
    }
    return slots;
  }

  getTrackSyncInfo(trackNum: number): G64TrackSyncInfo | null {
    const slotIndex = this.trackToSlotIndex(trackNum);
    const trackData = this.getRawTrackBySlotIndex(slotIndex);
    if (!trackData) {
      return null;
    }
    const syncs = findAllSyncMarks(trackData);
    return {
      track: trackNum,
      halfTrack: this.slotIndexToHalfTrack(slotIndex),
      slotIndex,
      rawLength: trackData.length,
      syncCount: syncs.length,
      syncs,
    };
  }

  inspectTrackBlocks(trackNum: number, asciiWidth = 96): G64TrackBlockInspection | null {
    const slotIndex = this.trackToSlotIndex(trackNum);
    const trackData = this.getRawTrackBySlotIndex(slotIndex);
    if (!trackData) {
      return null;
    }
    const inspected: GCRTrackInspection = inspectGCRTrack(trackData);
    return {
      track: trackNum,
      halfTrack: this.slotIndexToHalfTrack(slotIndex),
      slotIndex,
      rawLength: trackData.length,
      chosenParity: inspected.chosenParity,
      chosenParityScore: inspected.chosenParityScore,
      alternativeParityScore: inspected.alternativeParityScore,
      asciiMap: renderGCRTrackAscii(inspected, trackData.length, asciiWidth),
      pairs: inspected.pairs,
    };
  }

  scanTrackHeadersLikeVice(trackNum: number): Array<GCRHeaderCandidate & { track: number; halfTrack: number; slotIndex: number }> {
    const slotIndex = this.trackToSlotIndex(trackNum);
    const trackData = this.getRawTrackBySlotIndex(slotIndex);
    if (!trackData) {
      return [];
    }
    return scanSectorHeadersLikeVice(trackData).map((candidate) => ({
      track: trackNum,
      halfTrack: this.slotIndexToHalfTrack(slotIndex),
      slotIndex,
      ...candidate,
    }));
  }

  findTrackSectorLikeVice(trackNum: number, sector: number): (GCRHeaderCandidate & { track: number; halfTrack: number; slotIndex: number }) | null {
    const slotIndex = this.trackToSlotIndex(trackNum);
    const trackData = this.getRawTrackBySlotIndex(slotIndex);
    if (!trackData) {
      return null;
    }
    const candidate = findSectorHeaderLikeVice(trackData, sector);
    if (!candidate) {
      return null;
    }
    return {
      track: trackNum,
      halfTrack: this.slotIndexToHalfTrack(slotIndex),
      slotIndex,
      ...candidate,
    };
  }

  readTrackSectorLikeVice(trackNum: number, sector: number): G64ViceStyleSectorRead | null {
    const slotIndex = this.trackToSlotIndex(trackNum);
    const trackData = this.getRawTrackBySlotIndex(slotIndex);
    if (!trackData) {
      return null;
    }
    return {
      track: trackNum,
      halfTrack: this.slotIndexToHalfTrack(slotIndex),
      slotIndex,
      sector,
      result: readSectorLikeVice(trackData, sector),
    };
  }

  extractRawTrack(trackNum: number): Uint8Array | null {
    const raw = this.getRawTrack(trackNum);
    return raw ? raw.slice() : null;
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

  private buildFingerprints(): G64TrackFingerprint[] {
    const fingerprints: G64TrackFingerprint[] = [];
    for (let slotIndex = 0; slotIndex < this.trackOffsets.length; slotIndex += 1) {
      const track = this.slotIndexToTrack(slotIndex);
      const raw = this.getRawTrackBySlotIndex(slotIndex);
      if (!raw) {
        continue;
      }
      const analysis = this.getTrackAnalysis(track);
      if (!analysis) {
        continue;
      }
      const decoded = this.decodeTrack(track);
      fingerprints.push({
        track,
        halfTrack: this.slotIndexToHalfTrack(slotIndex),
        slotIndex,
        rawHash: hashBytes(raw),
        decodedHash: hashDecodedSectors(decoded),
        fillSignature: detectFillSignature(decoded),
        analysis,
      });
    }
    return fingerprints;
  }

  analyzeAnomalies(): {
    version: number;
    trackCount: number;
    halfTrackCount: number;
    tracksWithData: number[];
    slotsWithData: number[];
    anomalies: Array<{
      track: number;
      issue: string;
      details?: string;
    }>;
  } {
    return this.analyzeAnomaliesWithOptions();
  }

  analyzeAnomaliesWithOptions(options?: {
    lutReferences?: G64LutReference[];
  }): {
    version: number;
    trackCount: number;
    halfTrackCount: number;
    tracksWithData: number[];
    slotsWithData: number[];
    anomalies: Array<{
      track: number;
      issue: string;
      details?: string;
    }>;
  } {
    const anomalies: Array<{ track: number; issue: string; details?: string }> = [];
    const tracksWithData: number[] = [];
    const slotsWithData: number[] = [];
    const fingerprints = this.buildFingerprints();
    const fingerprintByTrack = new Map<number, G64TrackFingerprint>();
    const anomalyKeys = new Set<string>();

    const pushAnomaly = (track: number, issue: string, details?: string) => {
      const key = `${track}|${issue}|${details ?? ""}`;
      if (anomalyKeys.has(key)) {
        return;
      }
      anomalyKeys.add(key);
      anomalies.push({ track, issue, details });
    };

    for (const fingerprint of fingerprints) {
      const trackNum = fingerprint.track;
      const analysis = fingerprint.analysis;
      tracksWithData.push(trackNum);
      slotsWithData.push(fingerprint.halfTrack);
      fingerprintByTrack.set(trackNum, fingerprint);
      if (!Number.isInteger(trackNum)) {
        pushAnomaly(trackNum, "halftrack_raw_data", `${analysis.rawLength} bytes`);
      }
      if (analysis.duplicateSectors.length > 0) {
        pushAnomaly(trackNum, "duplicate_sectors", analysis.duplicateSectors.join(", "));
      }
      if (analysis.missingSectors.length > 0) {
        pushAnomaly(trackNum, "missing_sectors", analysis.missingSectors.join(", "));
      }
      if (analysis.unexpectedSectors.length > 0) {
        pushAnomaly(trackNum, "unexpected_sector_ids", analysis.unexpectedSectors.join(", "));
      }
      if (analysis.invalidDataCount > 0) {
        pushAnomaly(trackNum, "invalid_data_blocks", String(analysis.invalidDataCount));
      }
      if (analysis.sectors.some((sector) => sector.track !== Math.floor(trackNum))) {
        pushAnomaly(
          trackNum,
          "off_track_headers",
          analysis.sectors
            .filter((sector) => sector.track !== Math.floor(trackNum))
            .map((sector) => `${sector.track}/${sector.sector}`)
            .join(", "),
        );
      }
      if (fingerprint.fillSignature) {
        pushAnomaly(trackNum, "fill_pattern_track", fingerprint.fillSignature);
      }
    }

    for (let i = 0; i < fingerprints.length; i += 1) {
      const current = fingerprints[i]!;
      for (let j = i + 1; j < fingerprints.length; j += 1) {
        const other = fingerprints[j]!;
        if (current.rawHash === other.rawHash && Math.abs(current.slotIndex - other.slotIndex) === 1) {
          pushAnomaly(current.track, "raw_track_duplicate", `identical raw data to track ${other.track}`);
          pushAnomaly(other.track, "raw_track_duplicate", `identical raw data to track ${current.track}`);
        }
        if (current.decodedHash && current.decodedHash === other.decodedHash && current.rawHash !== other.rawHash) {
          pushAnomaly(current.track, "decoded_track_duplicate", `decoded sectors identical to track ${other.track} despite different raw GCR`);
          pushAnomaly(other.track, "decoded_track_duplicate", `decoded sectors identical to track ${current.track} despite different raw GCR`);
        }
      }
    }

    if (options?.lutReferences?.length) {
      for (const reference of options.lutReferences) {
        const fingerprint = fingerprintByTrack.get(reference.track);
        if (!fingerprint) {
          pushAnomaly(reference.track, "lut_reference_missing_track", reference.sourceLine);
          pushAnomaly(reference.track, "missing_extended_track_data", reference.sourceLine);
          continue;
        }
        const issues = anomalies
          .filter((anomaly) => anomaly.track === reference.track)
          .map((anomaly) => anomaly.issue);
        const suspicious = issues.some((issue) => issue === "raw_track_duplicate"
          || issue === "decoded_track_duplicate"
          || issue === "fill_pattern_track");
        if (suspicious) {
          pushAnomaly(reference.track, "lut_reference_track_is_filler", reference.sourceLine);
        }
        if (reference.sector !== undefined) {
          const matchingSector = fingerprint.analysis.sectors.find((sector) => sector.sector === reference.sector && sector.dataValid);
          if (!matchingSector) {
            pushAnomaly(reference.track, "lut_reference_sector_unavailable", reference.sourceLine);
          }
        }
        if (reference.track > this.getTrackCount() || !fingerprint.analysis.sectors.length) {
          pushAnomaly(reference.track, "missing_extended_track_data", reference.sourceLine);
        }
      }
    }

    return {
      version: this.version,
      trackCount: this.getTrackCount(),
      halfTrackCount: this.trackCount,
      tracksWithData: [...new Set(tracksWithData)].sort((left, right) => left - right),
      slotsWithData: [...new Set(slotsWithData)].sort((left, right) => left - right),
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

  getHalfTrackCount(): number {
    return this.trackCount;
  }

  getVersion(): number {
    return this.version;
  }
}
