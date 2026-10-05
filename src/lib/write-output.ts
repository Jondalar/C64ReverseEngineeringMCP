import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file to a path the caller named, creating its folder first. A tool that takes
 * `output_path` / `path` must not refuse because `analysis/screens/` is not there yet.
 */
export function writeFileCreatingDirs(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** The PNG bytes of a daemon `data:image/png;base64,...` URL (or a bare base64 body). */
export function pngBytesFromDataUrl(dataUrl: string): Buffer {
  const b64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
  return Buffer.from(b64, "base64");
}
