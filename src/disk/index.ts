export type {
  DiskDirectory,
  DiskFileEntry,
  DiskImage,
} from "./base.js";

export {
  SECTORS_PER_TRACK,
  TRACK_SPEED_ZONE,
  extractFileFromChain,
  extractFilename,
  getFileType,
  parseDirectory,
  petToAscii,
} from "./base.js";

export { D64Parser } from "./d64-parser.js";
export { G64Parser } from "./g64-parser.js";
export * from "./gcr.js";

import type { DiskImage } from "./base.js";
import { D64Parser } from "./d64-parser.js";
import { G64Parser } from "./g64-parser.js";

export function createDiskParser(data: Uint8Array): DiskImage | null {
  if (G64Parser.isG64(data)) {
    return new G64Parser(data);
  }

  if (D64Parser.isD64(data)) {
    return new D64Parser(data);
  }

  return null;
}

export function isDiskImage(data: Uint8Array): boolean {
  return G64Parser.isG64(data) || D64Parser.isD64(data);
}
