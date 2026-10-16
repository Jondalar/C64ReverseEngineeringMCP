import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readBinary(path: string): Buffer {
  return readFileSync(path);
}

export function writeBinary(path: string, data: Uint8Array): void {
  ensureDir(dirname(path));
  writeFileSync(path, data);
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// `targetPath` relative to `basePath`, with "/" separators. A target outside
// `basePath` keeps its full path. path.relative, not a `${basePath}/` prefix
// strip: on Windows the separator is "\\" and the prefix never matched, so the
// manifests kept absolute paths that later join()s doubled.
export function toPosixRelative(basePath: string, targetPath: string): string {
  const rel = relative(basePath, targetPath);
  const inside = rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel);
  return (inside ? rel : targetPath).replaceAll("\\", "/");
}
