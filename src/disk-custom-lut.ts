// Custom-LUT disk extraction. Many disks (Lykia, BWC etc.) park their
// real payload table in a non-DOS sector indexed by a fixed-stride
// look-up table. The pipeline-side disk parser only knows the standard
// 1541 directory chain, so we layer custom-LUT support here as a
// dedicated tool that consumes a (track, sector, payload_format)
// description and emits payloads with `origin: "custom"` next to the
// existing KERNAL files.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createDiskParser, SECTORS_PER_TRACK, traceFileSectorChain, type DiskImage } from "./disk/index.js";
import type {
  DiskFileOrigin,
  ExtractedDiskFile,
  ExtractedDiskFileSector,
  ExtractedDiskManifest,
} from "./disk-extractor.js";

export type CustomLutPayloadFormat = "ts_size_load" | "ts_load_size" | "chained" | "raw";

export interface CustomLutOptions {
  imagePath: string;
  lutTrack: number;
  lutSector: number;
  entryOffset?: number;   // default 0
  entryStride?: number;   // default 6
  entryCount?: number;    // default 42
  payloadFormat: CustomLutPayloadFormat;
  /** Hex string (e.g. "fefc0000"); empty/deleted slot marker. */
  sentinelPayload?: string;
  outputDir: string;
  /** Default size for raw payloads when no size is in the entry. Bytes. */
  rawDefaultSize?: number;
}

export interface CustomLutEntry {
  index: number;
  payloadHex: string;
  isSentinel: boolean;
  decoded?: {
    track: number;
    sector: number;
    size?: number;
    loadAddress?: number;
  };
  bytes?: Uint8Array;
  relativePath?: string;
  warnings?: string[];
}

export interface CustomLutExtractResult {
  imagePath: string;
  lutTrack: number;
  lutSector: number;
  payloadFormat: CustomLutPayloadFormat;
  entries: CustomLutEntry[];
  filesAdded: ExtractedDiskFile[];
  manifestPath: string;
}

function md5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

function hexSlice(bytes: Uint8Array, start: number, end: number): string | undefined {
  if (bytes.length === 0) return undefined;
  const slice = bytes.slice(start, end);
  if (slice.length === 0) return undefined;
  return Buffer.from(slice).toString("hex");
}

function isValidTs(track: number, sector: number): boolean {
  if (track < 1 || track > 35) return false;
  const max = SECTORS_PER_TRACK[track];
  if (max === undefined) return false;
  return sector >= 0 && sector < max;
}

function decodeEntry(payload: Uint8Array, format: CustomLutPayloadFormat): CustomLutEntry["decoded"] | undefined {
  if (payload.length < 2) return undefined;
  const t = payload[0]!;
  const s = payload[1]!;
  if (!isValidTs(t, s)) return undefined;
  switch (format) {
    case "raw":
      return { track: t, sector: s };
    case "chained":
      return { track: t, sector: s };
    case "ts_size_load":
      if (payload.length < 6) return undefined;
      return {
        track: t,
        sector: s,
        size: payload[2]! | (payload[3]! << 8),
        loadAddress: payload[4]! | (payload[5]! << 8),
      };
    case "ts_load_size":
      if (payload.length < 6) return undefined;
      return {
        track: t,
        sector: s,
        loadAddress: payload[2]! | (payload[3]! << 8),
        size: payload[4]! | (payload[5]! << 8),
      };
  }
}

function readContiguousSectors(parser: DiskImage, startTrack: number, startSector: number, sizeBytes: number): { bytes: Uint8Array; chain: ExtractedDiskFileSector[] } {
  const out: number[] = [];
  const chain: ExtractedDiskFileSector[] = [];
  let track = startTrack;
  let sector = startSector;
  let remaining = sizeBytes;
  let index = 0;
  while (remaining > 0) {
    const data = parser.getSector(track, sector);
    if (!data) break;
    const take = Math.min(256, remaining);
    for (let i = 0; i < take; i += 1) out.push(data[i]!);
    chain.push({
      index,
      track,
      sector,
      nextTrack: 0,
      nextSector: 0,
      bytesUsed: take,
      isLast: remaining - take <= 0,
    });
    remaining -= take;
    sector += 1;
    if (sector >= (SECTORS_PER_TRACK[track] ?? 0)) {
      sector = 0;
      track += 1;
      if (!SECTORS_PER_TRACK[track]) break;
    }
    index += 1;
  }
  return { bytes: Uint8Array.from(out), chain };
}

export function extractDiskCustomLut(opts: CustomLutOptions): CustomLutExtractResult {
  const data = new Uint8Array(readFileSync(opts.imagePath));
  const parser = createDiskParser(data);
  if (!parser) throw new Error(`Unsupported disk image: ${opts.imagePath}`);
  const sector = parser.getSector(opts.lutTrack, opts.lutSector);
  if (!sector) throw new Error(`LUT sector T${opts.lutTrack}/S${opts.lutSector} unreadable`);

  const entryOffset = opts.entryOffset ?? 0;
  const entryStride = opts.entryStride ?? 6;
  const entryCount = opts.entryCount ?? 42;
  const sentinelHex = opts.sentinelPayload?.toLowerCase().replace(/\s+/g, "");
  const sentinelBytes = sentinelHex
    ? Uint8Array.from((sentinelHex.match(/.{1,2}/g) ?? []).map((b) => Number.parseInt(b, 16)))
    : undefined;
  const rawDefaultSize = opts.rawDefaultSize ?? 256;

  mkdirSync(opts.outputDir, { recursive: true });

  const entries: CustomLutEntry[] = [];
  const filesAdded: ExtractedDiskFile[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    const start = entryOffset + i * entryStride;
    const end = Math.min(sector.length, start + entryStride);
    if (start >= sector.length) break;
    const payload = sector.slice(start, end);
    const payloadHex = Buffer.from(payload).toString("hex");
    const isSentinel = sentinelBytes
      ? payload.length >= sentinelBytes.length && sentinelBytes.every((b, idx) => payload[idx] === b)
      : false;

    if (isSentinel) {
      entries.push({ index: i, payloadHex, isSentinel: true });
      continue;
    }

    const decoded = decodeEntry(payload, opts.payloadFormat);
    if (!decoded) {
      entries.push({ index: i, payloadHex, isSentinel: false, warnings: ["entry decode failed"] });
      continue;
    }

    let bytes: Uint8Array;
    let chain: ExtractedDiskFileSector[];
    if (opts.payloadFormat === "chained") {
      const fileEntry = {
        track: decoded.track,
        sector: decoded.sector,
        size: 0,
        type: "PRG" as const,
        name: `lut_${i}`,
        loadAddress: undefined,
      };
      bytes = readChainedFile(parser, decoded.track, decoded.sector);
      chain = traceFileSectorChain((t, s) => parser.getSector(t, s), fileEntry as never);
    } else if (decoded.size !== undefined) {
      const result = readContiguousSectors(parser, decoded.track, decoded.sector, decoded.size);
      bytes = result.bytes;
      chain = result.chain;
    } else {
      const result = readContiguousSectors(parser, decoded.track, decoded.sector, rawDefaultSize);
      bytes = result.bytes;
      chain = result.chain;
    }

    if (bytes.length === 0) {
      entries.push({ index: i, payloadHex, isSentinel: false, decoded, warnings: ["read produced 0 bytes"] });
      continue;
    }

    const relativePath = `lut${opts.lutTrack}_${opts.lutSector}_e${String(i).padStart(2, "0")}.bin`;
    writeFileSync(join(opts.outputDir, relativePath), bytes);

    const file: ExtractedDiskFile = {
      index: i,
      origin: "custom",
      name: `lut_e${i}`,
      type: "PRG",
      sizeSectors: chain.length,
      sizeBytes: bytes.length,
      track: decoded.track,
      sector: decoded.sector,
      loadAddress: decoded.loadAddress,
      relativePath,
      sectorChain: chain,
      md5: md5Hex(bytes),
      first16: hexSlice(bytes, 0, 16),
      last16: hexSlice(bytes, Math.max(0, bytes.length - 16), bytes.length),
      origin_detail: {
        lut: { track: opts.lutTrack, sector: opts.lutSector, entryIndex: i, payloadHex, payloadFormat: opts.payloadFormat },
      },
    };
    filesAdded.push(file);
    entries.push({ index: i, payloadHex, isSentinel: false, decoded, bytes, relativePath, warnings: [] });
  }

  const manifestPath = join(opts.outputDir, "manifest.json");
  let manifest: Partial<ExtractedDiskManifest> & { files?: ExtractedDiskFile[]; sourceImage?: string; format?: "d64" | "g64" } = {};
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      manifest = {};
    }
  }
  const existingFiles = (manifest.files ?? []).map((entry) => ({
    ...entry,
    origin: (entry.origin as DiskFileOrigin | undefined) ?? "kernal",
  }));
  const merged: ExtractedDiskFile[] = [...existingFiles];
  for (const file of filesAdded) {
    const dupIdx = merged.findIndex((existing) => existing.relativePath === file.relativePath);
    if (dupIdx === -1) merged.push(file);
    else merged[dupIdx] = file;
  }
  const next = {
    ...manifest,
    sourceImage: manifest.sourceImage ?? opts.imagePath,
    sourceFileName: basename(manifest.sourceImage ?? opts.imagePath),
    format: manifest.format ?? "d64",
    fileCount: merged.length,
    files: merged,
  };
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);

  return {
    imagePath: opts.imagePath,
    lutTrack: opts.lutTrack,
    lutSector: opts.lutSector,
    payloadFormat: opts.payloadFormat,
    entries,
    filesAdded,
    manifestPath,
  };
}

function readChainedFile(parser: DiskImage, track: number, sector: number): Uint8Array {
  const visited = new Set<string>();
  const out: number[] = [];
  let curT = track;
  let curS = sector;
  while (curT !== 0) {
    const key = `${curT}/${curS}`;
    if (visited.has(key)) break;
    visited.add(key);
    const data = parser.getSector(curT, curS);
    if (!data) break;
    const nextT = data[0]!;
    const nextS = data[1]!;
    const last = nextT === 0;
    const take = last ? Math.max(0, nextS - 1) : 254;
    for (let i = 2; i < 2 + take; i += 1) out.push(data[i]!);
    if (last) break;
    curT = nextT;
    curS = nextS;
  }
  return Uint8Array.from(out);
}

export interface DiskSectorOwnership {
  track: number;
  sector: number;
  owner: string;
  role: "system" | "kernal_file" | "custom_file" | "unclaimed_padding" | "orphan_data";
  detail?: string;
  overlaps?: string[];
}

export interface DiskSectorAllocationResult {
  imagePath: string;
  diskName?: string;
  diskId?: string;
  totalSectors: number;
  ownership: DiskSectorOwnership[];
  overlapsCount: number;
  unclaimedCount: number;
}

export function diskSectorAllocation(imagePath: string, manifestPath: string): DiskSectorAllocationResult {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: ExtractedDiskFile[]; diskName?: string; diskId?: string };
  const files = manifest.files ?? [];

  const ownership: DiskSectorOwnership[] = [];
  const lookup = new Map<string, DiskSectorOwnership>();
  let total = 0;

  for (const trackEntry of Object.entries(SECTORS_PER_TRACK)) {
    const track = Number.parseInt(trackEntry[0]!, 10);
    if (track > 35) continue;
    for (let sector = 0; sector < trackEntry[1]; sector += 1) {
      total += 1;
      let role: DiskSectorOwnership["role"] = "unclaimed_padding";
      let owner = "(free)";
      let detail: string | undefined;
      if (track === 18 && sector === 0) { role = "system"; owner = "BAM"; }
      else if (track === 18) { role = "system"; owner = "DOS directory"; detail = `T18/S${sector}`; }
      const slot: DiskSectorOwnership = { track, sector, owner, role, detail };
      ownership.push(slot);
      lookup.set(`${track}/${sector}`, slot);
    }
  }

  let overlapsCount = 0;
  for (const file of files) {
    for (const cell of file.sectorChain) {
      const key = `${cell.track}/${cell.sector}`;
      const slot = lookup.get(key);
      if (!slot) continue;
      const role = file.origin === "custom" ? "custom_file" : "kernal_file";
      if (slot.role !== "unclaimed_padding" && slot.role !== role) {
        slot.overlaps = slot.overlaps ?? [];
        slot.overlaps.push(`${file.origin}:${file.name}`);
        overlapsCount += 1;
        continue;
      }
      slot.role = role;
      slot.owner = `${file.origin}:${file.name}`;
      slot.detail = file.relativePath;
    }
  }

  let unclaimedCount = 0;
  for (const slot of ownership) {
    if (slot.role === "unclaimed_padding") unclaimedCount += 1;
  }

  return {
    imagePath,
    diskName: manifest.diskName,
    diskId: manifest.diskId,
    totalSectors: total,
    ownership,
    overlapsCount,
    unclaimedCount,
  };
}

export interface SuggestedLutSector {
  track: number;
  sector: number;
  stride: number;
  count: number;
  confidence: number;
  reasons: string[];
}

export function suggestDiskLutSector(imagePath: string): SuggestedLutSector[] {
  const data = new Uint8Array(readFileSync(imagePath));
  const parser = createDiskParser(data);
  if (!parser) throw new Error(`Unsupported disk image: ${imagePath}`);

  const candidates: SuggestedLutSector[] = [];
  const strides = [4, 5, 6, 8];

  for (const trackEntry of Object.entries(SECTORS_PER_TRACK)) {
    const track = Number.parseInt(trackEntry[0]!, 10);
    if (track > 35) continue;
    for (let sector = 0; sector < trackEntry[1]; sector += 1) {
      const bytes = parser.getSector(track, sector);
      if (!bytes || bytes.length < 16) continue;
      for (const stride of strides) {
        const maxEntries = Math.floor(bytes.length / stride);
        if (maxEntries < 4) continue;
        let validCount = 0;
        let zeroCount = 0;
        for (let i = 0; i < maxEntries; i += 1) {
          const t = bytes[i * stride]!;
          const s = bytes[i * stride + 1]!;
          if (t === 0 && s === 0) { zeroCount += 1; continue; }
          if (isValidTs(t, s)) validCount += 1;
        }
        const ratio = validCount / Math.max(1, maxEntries - zeroCount);
        if (validCount >= 4 && ratio >= 0.7) {
          candidates.push({
            track,
            sector,
            stride,
            count: validCount,
            confidence: Math.min(0.95, 0.4 + ratio * 0.5 + Math.min(0.2, validCount / 60)),
            reasons: [
              `${validCount} valid (T,S) pairs at stride ${stride} (${(ratio * 100).toFixed(0)}% of non-empty slots).`,
              zeroCount > 0 ? `${zeroCount} zero-pair slots may be sentinels or unused.` : "no zero-pair gaps in scan window.",
            ],
          });
        }
      }
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 16);
}
