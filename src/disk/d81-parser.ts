/**
 * D81 (1581) disk image parser — Spec 921.
 *
 * 80 tracks of 40 sectors of 256 bytes, no GCR, no zones. The directory entry is the 1541's;
 * only the header (40/0), the BAM (40/1, 40/2) and the CBM partition (file type 5) are new.
 */

import {
  type DirectoryLayout,
  type DiskDirectory,
  type DiskFileEntry,
  type DiskImage,
  type DiskSystemSector,
  type SectorChainWalk,
  extractFileFromChain,
  extractPartition,
  parseDirectory,
  walkFileSectorChain,
  walkPartition,
} from "./base.js";

export const D81_TRACKS = 80;
export const D81_SECTORS_PER_TRACK = 40;
const D81_SIZE = D81_TRACKS * D81_SECTORS_PER_TRACK * 256; // 819200
const D81_SIZE_ERRORS = D81_SIZE + D81_TRACKS * D81_SECTORS_PER_TRACK; // 822400

/** Partitions inside partitions are read this deep, no deeper. */
const MAX_PARTITION_DEPTH = 4;

function d81Layout(header: [number, number], root: boolean): DirectoryLayout {
  return {
    header,
    firstDir: [header[0], 3],
    dirFromHeaderLink: true,
    expectedLinkTrack: root ? 40 : undefined,
    dosFormatOffset: 0x02,
    nameOffset: 0x04,
    idOffset: 0x16,
    dosOffset: 0x19,
    maxType: 5,
    maxTrack: D81_TRACKS,
    sectorsPerTrack: () => D81_SECTORS_PER_TRACK,
  };
}

export class D81Parser implements DiskImage {
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  /** A D81 is its size; the header only decides whether a DOS directory is read. */
  static isD81(data: Uint8Array): boolean {
    return data.length === D81_SIZE || data.length === D81_SIZE_ERRORS;
  }

  private static getOffset(track: number, sector: number): number {
    if (track < 1 || track > D81_TRACKS) return -1;
    if (sector < 0 || sector >= D81_SECTORS_PER_TRACK) return -1;
    return ((track - 1) * D81_SECTORS_PER_TRACK + sector) * 256;
  }

  getSector(track: number, sector: number): Uint8Array | null {
    const offset = D81Parser.getOffset(track, sector);
    if (offset < 0 || offset + 256 > this.data.length) return null;
    return this.data.slice(offset, offset + 256);
  }

  getDirectory(): DiskDirectory {
    const read = (t: number, s: number) => this.getSector(t, s);
    const root = parseDirectory(read, d81Layout([40, 0], true));
    const files: DiskFileEntry[] = [];
    // A partition that starts a sub-disk is listed, then its own files as PART/NAME.
    const expand = (entries: DiskFileEntry[], prefix: string, depth: number, seen: Set<string>): void => {
      for (const entry of entries) {
        const display = prefix === "" ? entry : { ...entry, name: `${prefix}${entry.name}` };
        files.push(display);
        if (entry.type !== "CBM" || depth >= MAX_PARTITION_DEPTH) continue;
        if (!this.isSubdirectory(entry)) continue;
        const key = `${entry.track}/${entry.sector}`;
        if (seen.has(key)) continue;
        const sub = parseDirectory(read, d81Layout([entry.track, entry.sector], false));
        expand(sub.files, `${prefix}${entry.name}/`, depth + 1, new Set([...seen, key]));
      }
    };
    expand(root.files, "", 0, new Set());
    return { ...root, files };
  }

  /** A partition is a subdirectory when it starts at sector 0, spans a multiple of 40 sectors
   *  (at least 120) and its first sector carries `D` at $02. */
  private isSubdirectory(entry: DiskFileEntry): boolean {
    if (entry.sector !== 0 || entry.size < 120 || entry.size % D81_SECTORS_PER_TRACK !== 0) return false;
    return this.getSector(entry.track, entry.sector)?.[2] === 0x44;
  }

  private geometry() {
    return { sectorsPerTrack: () => D81_SECTORS_PER_TRACK, trackCount: D81_TRACKS };
  }

  extractFile(entry: DiskFileEntry, stripLoadAddress = false): Uint8Array | null {
    const read = (t: number, s: number) => this.getSector(t, s);
    if (entry.type === "CBM") return extractPartition(read, entry, this.geometry());
    return extractFileFromChain(read, entry, stripLoadAddress);
  }

  walkFile(entry: DiskFileEntry): SectorChainWalk {
    const read = (t: number, s: number) => this.getSector(t, s);
    if (entry.type === "CBM") return walkPartition(read, entry, this.geometry());
    return walkFileSectorChain(read, entry);
  }

  getTrackCount(): number {
    return D81_TRACKS;
  }

  sectorsPerTrack(track: number): number {
    return track >= 1 && track <= D81_TRACKS ? D81_SECTORS_PER_TRACK : 0;
  }

  allocationTracks(): number {
    return D81_TRACKS;
  }

  /** Header 40/0, BAM 40/1 and 40/2, then the directory chain the header links to. */
  systemSectors(): DiskSystemSector[] {
    const out: DiskSystemSector[] = [
      { track: 40, sector: 0, owner: "Header" },
      { track: 40, sector: 1, owner: "BAM" },
      { track: 40, sector: 2, owner: "BAM" },
    ];
    const seen = new Set(out.map((c) => `${c.track}/${c.sector}`));
    const header = this.getSector(40, 0);
    let track = header && header[0] === 40 ? header[0] : 40;
    let sector = header && header[0] === 40 ? header[1] : 3;
    while (track !== 0) {
      const key = `${track}/${sector}`;
      if (seen.has(key)) break;
      const data = this.getSector(track, sector);
      if (!data) break;
      seen.add(key);
      out.push({ track, sector, owner: "DOS directory", detail: `T${track}/S${sector}` });
      track = data[0];
      sector = data[1];
    }
    return out;
  }
}
