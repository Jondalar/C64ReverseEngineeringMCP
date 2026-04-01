import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

export function toPosixRelative(basePath: string, targetPath: string): string {
  return targetPath
    .replace(`${basePath}/`, "")
    .replaceAll("\\", "/");
}
