import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createDiskParser, traceFileSectorChain, type DiskFileEntry, G64Parser } from "./disk/index.js";

export interface ExtractedDiskFileSector {
  index: number;
  track: number;
  sector: number;
  nextTrack: number;
  nextSector: number;
  bytesUsed: number;
  isLast: boolean;
}

export interface ExtractedDiskFile {
  index: number;
  name: string;
  type: DiskFileEntry["type"];
  sizeSectors: number;
  sizeBytes: number;
  track: number;
  sector: number;
  loadAddress?: number;
  relativePath: string;
  sectorChain: ExtractedDiskFileSector[];
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
    files: directory.files.map((entry, index) => ({
      index,
      name: entry.name,
      type: entry.type,
      sizeSectors: entry.size,
      sizeBytes: 0,
      track: entry.track,
      sector: entry.sector,
      loadAddress: entry.loadAddress,
      relativePath: "",
      sectorChain: traceFileSectorChain((t, s) => parser.getSector(t, s), entry),
    })),
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

    files.push({
      index,
      name: entry.name,
      type: entry.type,
      sizeSectors: entry.size,
      sizeBytes: bytes.length,
      track: entry.track,
      sector: entry.sector,
      loadAddress: entry.loadAddress,
      relativePath,
      sectorChain: traceFileSectorChain((t, s) => parser.getSector(t, s), entry),
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
