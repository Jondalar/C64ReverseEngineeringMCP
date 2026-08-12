// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
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
