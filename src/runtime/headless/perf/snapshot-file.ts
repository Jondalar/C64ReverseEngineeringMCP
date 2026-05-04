// Spec 134 (M8.2) v1 — persistent snapshot/resume.
//
// Wraps Spec 101's in-memory snapshot in a JSON file format with
// version header. Re-uses existing `snapshot()` / `restore()`.

import { readFileSync, writeFileSync } from "node:fs";

export const SNAPSHOT_FILE_VERSION = 1;

export interface SnapshotFileHeader {
  version: number;
  schema: 1;
  savedAt: string;            // ISO timestamp
  cyclesAtSave: number;
  diskPath?: string;
  mode?: string;
  includeTraces: boolean;
}

export interface SnapshotFile<TPayload = unknown> {
  header: SnapshotFileHeader;
  payload: TPayload;
}

export function saveSnapshotFile(
  path: string,
  payload: unknown,
  meta: Omit<SnapshotFileHeader, "version" | "schema" | "savedAt">,
): void {
  const out: SnapshotFile = {
    header: {
      version: SNAPSHOT_FILE_VERSION,
      schema: 1,
      savedAt: new Date().toISOString(),
      ...meta,
    },
    payload,
  };
  writeFileSync(path, JSON.stringify(out));
}

export function loadSnapshotFile<T = unknown>(path: string): SnapshotFile<T> {
  const text = readFileSync(path, "utf8");
  const obj = JSON.parse(text) as SnapshotFile<T>;
  if (obj.header.version !== SNAPSHOT_FILE_VERSION) {
    throw new Error(`Unsupported snapshot version ${obj.header.version} (expected ${SNAPSHOT_FILE_VERSION})`);
  }
  return obj;
}
