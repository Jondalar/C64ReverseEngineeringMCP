import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createDiskParser, walkFileSectorChain, type DiskFileEntry, type SectorChainStatus, G64Parser } from "./disk/index.js";

export type DiskFileOrigin = "kernal" | "custom";

export interface ExtractedDiskFileSector {
  index: number;
  track: number;
  sector: number;
  nextTrack: number;
  nextSector: number;
  bytesUsed: number;
  isLast: boolean;
}

export interface ExtractedDiskFileOriginDetail {
  // Free-form per-origin payload. For "kernal" the directory T/S of the
  // entry. For "custom" the LUT T/S, entry index, and raw payload bytes.
  [key: string]: unknown;
}

export interface ExtractedDiskFile {
  index: number;
  origin: DiskFileOrigin;
  name: string;
  type: DiskFileEntry["type"];
  sizeSectors: number;
  sizeBytes: number;
  track: number;
  sector: number;
  loadAddress?: number;
  /** Spec 832 D2 — the payload's byte format as the extractor KNOWS it: "prg" only
   *  when the file is a PRG whose first two bytes survived `loadAddressRejection`,
   *  "raw" otherwise. Optional so manifests written before 832 still parse. */
  format?: "prg" | "raw";
  /** Why `loadAddress` is absent on a PRG-typed entry (Spec 832 D2). */
  loadAddressNote?: string;
  relativePath: string;
  sectorChain: ExtractedDiskFileSector[];
  /** How the block chain ENDED. Anything but "complete" means `sectorChain` is the
   *  reachable prefix, not the file's extent — see `chainNote`. Optional so manifests
   *  written before this existed still parse. */
  chainStatus?: SectorChainStatus;
  /** Why the chain did not terminate cleanly; absent when it did. */
  chainNote?: string;
  md5?: string;
  first16?: string;
  last16?: string;
  kindGuess?: string;
  origin_detail?: ExtractedDiskFileOriginDetail;
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

export interface ExtractedDiskManifest {
  sourceImage: string;
  format: "d64" | "g64";
  diskName: string;
  diskId: string;
  outputDir: string;
  manifestPath: string;
  files: ExtractedDiskFile[];
}

function sanitizeName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || "unnamed";
}

function extensionForType(type: DiskFileEntry["type"]): string {
  switch (type) {
    case "PRG":
      return ".prg";
    case "SEQ":
      return ".seq";
    case "USR":
      return ".usr";
    case "REL":
      return ".rel";
    default:
      return ".del";
  }
}

export function readDiskDirectory(imagePath: string): ExtractedDiskManifest {
  const data = new Uint8Array(readFileSync(imagePath));
  const parser = createDiskParser(data);
  if (!parser) {
    throw new Error(`Unsupported disk image: ${imagePath}`);
  }

  const directory = parser.getDirectory();
  const format = parser instanceof G64Parser ? "g64" : "d64";

  return {
    sourceImage: imagePath,
    format,
    diskName: directory.name,
    diskId: directory.id,
    outputDir: "",
    manifestPath: "",
    files: directory.files.map((entry, index): ExtractedDiskFile => {
      const walk = walkFileSectorChain((t, s) => parser.getSector(t, s), entry);
      return {
        index,
        origin: "kernal",
        name: entry.name,
        type: entry.type,
        sizeSectors: entry.size,
        sizeBytes: 0,
        track: entry.track,
        sector: entry.sector,
        // readDiskDirectory never reads a file's bytes, so it never learns a load
        // address — it does not guess one from the directory entry either.
        loadAddress: entry.loadAddress,
        format: entry.type === "PRG" && entry.loadAddress !== undefined ? "prg" : "raw",
        loadAddressNote: entry.loadAddressNote,
        relativePath: "",
        sectorChain: walk.links,
        chainStatus: walk.status,
        chainNote: walk.note,
        origin_detail: {
          directoryEntry: { track: entry.track, sector: entry.sector },
        },
      };
    }),
  };
}

export function extractDiskImage(imagePath: string, outputDir: string): ExtractedDiskManifest {
  const data = new Uint8Array(readFileSync(imagePath));
  const parser = createDiskParser(data);
  if (!parser) {
    throw new Error(`Unsupported disk image: ${imagePath}`);
  }

  mkdirSync(outputDir, { recursive: true });
  const directory = parser.getDirectory();
  const files: ExtractedDiskFile[] = [];

  directory.files.forEach((entry, index) => {
    const bytes = parser.extractFile(entry, false);
    if (!bytes) {
      return;
    }

    const relativePath = `${String(index + 1).padStart(2, "0")}_${sanitizeName(entry.name)}${extensionForType(entry.type)}`;
    writeFileSync(join(outputDir, relativePath), bytes);

    // The chain is walked WITH its termination verdict: `extractFile` above stops on the
    // same cycle / unreadable sector this walk does, so a truncated blob and a truncated
    // span list agree with each other and nothing downstream can tell either is short.
    // Only this verdict can.
    const walk = walkFileSectorChain((t, s) => parser.getSector(t, s), entry);

    files.push({
      index,
      origin: "kernal",
      name: entry.name,
      type: entry.type,
      sizeSectors: entry.size,
      sizeBytes: bytes.length,
      track: entry.track,
      sector: entry.sector,
      // Set by extractFile above — present only when the first two bytes can be an
      // address for a file this size (Spec 832 D2).
      loadAddress: entry.loadAddress,
      format: entry.type === "PRG" && entry.loadAddress !== undefined ? "prg" : "raw",
      loadAddressNote: entry.loadAddressNote,
      relativePath,
      sectorChain: walk.links,
      chainStatus: walk.status,
      chainNote: walk.note,
      md5: md5Hex(bytes),
      first16: hexSlice(bytes, 0, 16),
      last16: hexSlice(bytes, Math.max(0, bytes.length - 16), bytes.length),
      origin_detail: {
        directoryEntry: { track: entry.track, sector: entry.sector },
      },
    });
  });

  const format = parser instanceof G64Parser ? "g64" : "d64";
  const manifestPath = join(outputDir, "manifest.json");
  const manifest = {
    sourceImage: imagePath,
    sourceFileName: basename(imagePath),
    format,
    diskName: directory.name,
    diskId: directory.id,
    fileCount: files.length,
    files,
  };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    sourceImage: imagePath,
    format,
    diskName: directory.name,
    diskId: directory.id,
    outputDir,
    manifestPath,
    files,
  };
}
