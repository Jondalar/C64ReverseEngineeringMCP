/**
 * Base interfaces and utilities for disk image parsers.
 */

export interface DiskFileEntry {
  name: string;
  type: "PRG" | "SEQ" | "DEL" | "USR" | "REL";
  size: number;
  track: number;
  sector: number;
  loadAddress?: number;
}

export interface DiskDirectory {
  name: string;
  id: string;
  files: DiskFileEntry[];
}

export interface DiskImage {
  getDirectory(): DiskDirectory;
  extractFile(entry: DiskFileEntry, stripLoadAddress?: boolean): Uint8Array | null;
  getSector(track: number, sector: number): Uint8Array | null;
}

export const SECTORS_PER_TRACK: Record<number, number> = {
  1: 21, 2: 21, 3: 21, 4: 21, 5: 21, 6: 21, 7: 21, 8: 21, 9: 21,
  10: 21, 11: 21, 12: 21, 13: 21, 14: 21, 15: 21, 16: 21, 17: 21,
  18: 19, 19: 19, 20: 19, 21: 19, 22: 19, 23: 19, 24: 19,
  25: 18, 26: 18, 27: 18, 28: 18, 29: 18, 30: 18,
  31: 17, 32: 17, 33: 17, 34: 17, 35: 17,
  36: 17, 37: 17, 38: 17, 39: 17, 40: 17,
  41: 17, 42: 17,
};

export const TRACK_SPEED_ZONE: Record<number, number> = {
  ...Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i + 1, 3])),
  ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i + 18, 2])),
  ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i + 25, 1])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 31, 0])),
};

export function petToAscii(pet: number): string {
  if (pet >= 0x41 && pet <= 0x5a) return String.fromCharCode(pet + 0x20);
  if (pet >= 0xc1 && pet <= 0xda) return String.fromCharCode(pet - 0x80);
  if (pet >= 0x20 && pet <= 0x7e) return String.fromCharCode(pet);
  return " ";
}

export function extractFilename(bytes: Uint8Array): string {
  let name = "";
  for (let i = 0; i < 16 && i < bytes.length; i++) {
    if (bytes[i] === 0xa0) break;
    name += petToAscii(bytes[i]);
  }
  return name.trim();
}

export function getFileType(typeByte: number): DiskFileEntry["type"] {
  const type = typeByte & 0x07;
  switch (type) {
    case 0x01:
      return "SEQ";
    case 0x02:
      return "PRG";
    case 0x03:
      return "USR";
    case 0x04:
      return "REL";
    default:
      return "DEL";
  }
}

export function parseDirectory(getSector: (t: number, s: number) => Uint8Array | null): DiskDirectory {
  const files: DiskFileEntry[] = [];
  const bamSector = getSector(18, 0);
  if (!bamSector) {
    throw new Error("Cannot read BAM sector (18/0)");
  }

  let diskName = "";
  for (let i = 0; i < 16; i++) {
    const byte = bamSector[0x90 + i];
    if (byte === 0xa0) break;
    diskName += petToAscii(byte);
  }

  const diskId = String.fromCharCode(bamSector[0xa2]) + String.fromCharCode(bamSector[0xa3]);

  let dirTrack = 18;
  let dirSector = 1;

  while (dirTrack !== 0) {
    const sector = getSector(dirTrack, dirSector);
    if (!sector) break;

    for (let i = 0; i < 8; i++) {
      const offset = i * 32;
      const typeByte = sector[offset + 2];
      if ((typeByte & 0x80) === 0) continue;

      const fileTrack = sector[offset + 3];
      const fileSector = sector[offset + 4];
      if (fileTrack === 0) continue;

      const nameBytes = sector.slice(offset + 5, offset + 21);
      const filename = extractFilename(nameBytes);
      const sizeLow = sector[offset + 0x1e];
      const sizeHigh = sector[offset + 0x1f];
      const sizeSectors = sizeLow | (sizeHigh << 8);

      files.push({
        name: filename,
        type: getFileType(typeByte),
        size: sizeSectors,
        track: fileTrack,
        sector: fileSector,
      });
    }

    dirTrack = sector[0];
    dirSector = sector[1];
  }

  return {
    name: diskName || "UNTITLED",
    id: diskId,
    files,
  };
}

export function extractFileFromChain(
  getSector: (t: number, s: number) => Uint8Array | null,
  entry: DiskFileEntry,
  stripLoadAddress = false,
): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let track = entry.track;
  let sector = entry.sector;
  let totalBytes = 0;

  while (track !== 0) {
    const sectorData = getSector(track, sector);
    if (!sectorData) break;

    const nextTrack = sectorData[0];
    const nextSector = sectorData[1];

    if (nextTrack === 0) {
      const bytesUsed = nextSector > 0 ? nextSector - 1 : 254;
      chunks.push(sectorData.slice(2, 2 + bytesUsed));
      totalBytes += bytesUsed;
    } else {
      chunks.push(sectorData.slice(2));
      totalBytes += 254;
    }

    track = nextTrack;
    sector = nextSector;
  }

  if (chunks.length === 0) return null;

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  if (entry.type === "PRG" && result.length >= 2) {
    entry.loadAddress = result[0] | (result[1] << 8);
    if (stripLoadAddress) {
      return result.slice(2);
    }
  }

  return result;
}
