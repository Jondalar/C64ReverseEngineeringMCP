import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createDiskParser, type DiskFileEntry, type DiskImage } from "../../disk/index.js";

export interface PrgFile {
  path: string;
  fileName: string;
  bytes: Uint8Array;
  loadAddress: number;
  payload: Uint8Array;
}

export function readPrgFile(prgPath: string): PrgFile {
  const bytes = new Uint8Array(readFileSync(prgPath));
  if (bytes.length < 2) {
    throw new Error(`PRG too short: ${prgPath}`);
  }
  const loadAddress = bytes[0]! | (bytes[1]! << 8);
  return {
    path: prgPath,
    fileName: basename(prgPath),
    bytes,
    loadAddress,
    payload: bytes.slice(2),
  };
}

function normalizeCbmName(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/\u00A0/g, " ");
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = normalizeCbmName(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "u");
}

export class DiskProvider {
  private readonly parser: DiskImage;
  private readonly files: DiskFileEntry[];

  private constructor(
    public readonly imagePath: string,
    parser: DiskImage,
    files: DiskFileEntry[],
    public readonly diskName: string,
    public readonly diskId: string,
  ) {
    this.parser = parser;
    this.files = files;
  }

  static fromImagePath(imagePath: string): DiskProvider {
    const data = new Uint8Array(readFileSync(imagePath));
    const parser = createDiskParser(data);
    if (!parser) {
      throw new Error(`Unsupported disk image: ${imagePath}`);
    }
    const directory = parser.getDirectory();
    return new DiskProvider(imagePath, parser, directory.files, directory.name, directory.id);
  }

  listFiles(): DiskFileEntry[] {
    return this.files.map((entry) => ({ ...entry }));
  }

  findFile(nameOrPattern: string): { entry: DiskFileEntry; bytes: Uint8Array } | undefined {
    const regex = wildcardToRegex(nameOrPattern);
    const entry = this.files.find((candidate) => regex.test(normalizeCbmName(candidate.name)));
    if (!entry) {
      return undefined;
    }
    const bytes = this.parser.extractFile(entry, false);
    if (!bytes) {
      return undefined;
    }
    return { entry: { ...entry }, bytes };
  }
}
