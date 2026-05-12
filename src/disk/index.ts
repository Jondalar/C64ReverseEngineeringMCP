export type {
  DiskDirectory,
  DiskFileEntry,
  DiskImage,
} from "./base.js";

export {
  SECTORS_PER_TRACK,
  TRACK_SPEED_ZONE,
  extractFileFromChain,
  traceFileSectorChain,
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

// Spec 413 — 1541 Phase G: image format dispatch.
//
// Doctrine: 1:1 VICE TDE port.
// Doc:  docs/vice-1541-arch.md §9.4 (format dispatch),
//       §13 Phase G steps 27-30,
//       §17 OQ-413-1 (D64→GCR eager at attach),
//       §17 OQ-413-2 (P64 deferred — format-probe fall-through stub).
// VICE: src/diskimage/diskimage.c (probe order + dispatch),
//       src/drive/driveimage.c:169-220 drive_image_attach().
//
// Probe order matches VICE: G64 / G71 magic header first, then D64 by
// size + BAM heuristic. P64 is recognised here only enough to fall
// through cleanly — the actual flux-level decoder is deferred per
// OQ-413-2 (no in-scope title needs it; G64 covers all current
// copy-protected disks).
export function createDiskParser(data: Uint8Array): DiskImage | null {
  if (G64Parser.isG64(data)) {
    return new G64Parser(data);
  }

  if (D64Parser.isD64(data)) {
    return new D64Parser(data);
  }

  // Spec 413 OQ-413-2 — P64 stub. VICE diskimage.c recognises P64 by
  // the "P64-1541" 8-byte magic. We probe the same magic so the
  // dispatcher can return null cleanly (= "unsupported image"), giving
  // upstream a deterministic signal instead of a nondescript decode
  // failure deep in D64 / G64 parsers. Full P64 decode is post
  // arch-port (TODO: src/diskimage/p64.c port).
  if (isP64Magic(data)) {
    return null; // not implemented: post-arch-port (Spec 413 OQ-413-2)
  }

  return null;
}

export function isDiskImage(data: Uint8Array): boolean {
  return G64Parser.isG64(data) || D64Parser.isD64(data);
}

// Spec 413 OQ-413-2 — P64 magic probe.
// VICE p64.c:97 — `if (memcmp(buffer, "P64-1541", 8) == 0)`.
// We expose this so callers (mount paths, MCP tools) can produce a
// helpful "P64 unsupported" error instead of mis-classifying as D64.
export function isP64Magic(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  return (
    data[0] === 0x50 && // 'P'
    data[1] === 0x36 && // '6'
    data[2] === 0x34 && // '4'
    data[3] === 0x2d && // '-'
    data[4] === 0x31 && // '1'
    data[5] === 0x35 && // '5'
    data[6] === 0x34 && // '4'
    data[7] === 0x31    // '1'
  );
}
