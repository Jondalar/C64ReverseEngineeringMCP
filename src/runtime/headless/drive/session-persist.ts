// Session persist: writes modified GCR tracks back to disk as
// `<image>_session.g64`. Original image untouched.
//
// Per Spec 062 Q4.C: read+write+persist. Save-game RE workflow needs
// modifications visible across sessions; original image stays clean
// so a fresh boot is always reproducible.

import { writeFileSync } from "node:fs";
import { dirname, basename, extname, resolve as resolvePath } from "node:path";
import type { G64Parser } from "../../../disk/g64-parser.js";
import type { TrackBuffer } from "./head-position.js";

export interface PersistResult {
  outputPath: string;
  modifiedTracks: number[];
  bytesWritten: number;
  skipped?: "no-modifications";
}

export function defaultSessionG64Path(originalImagePath: string): string {
  const dir = dirname(originalImagePath);
  const ext = extname(originalImagePath);
  const stem = basename(originalImagePath, ext);
  return resolvePath(dir, `${stem}_session${ext || ".g64"}`);
}

export function persistTrackBuffer(
  parser: G64Parser,
  trackBuffer: TrackBuffer,
  originalImagePath: string,
  outputPath?: string,
): PersistResult {
  const path = outputPath ?? defaultSessionG64Path(originalImagePath);
  if (!trackBuffer.isModified()) {
    return { outputPath: path, modifiedTracks: [], bytesWritten: 0, skipped: "no-modifications" };
  }
  const mods = trackBuffer.modifiedTracks();
  const newImage = parser.buildModifiedImage(mods);
  writeFileSync(path, newImage);
  return {
    outputPath: path,
    modifiedTracks: [...mods.keys()].sort((a, b) => a - b),
    bytesWritten: newImage.length,
  };
}
