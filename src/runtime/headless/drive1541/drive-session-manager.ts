// Standalone drive-session manager (Spec 704 §11 R3 — vice-backed rebuild).
//
// Holds standalone Vice1541 drive instances for the headless_drive_session_*
// MCP tools (inspect a 1541 + disk in isolation from a full C64 boot). The
// legacy DriveSession (drive/**) is removed; each session now wraps a
// Vice1541Facade.
//
// CAVEAT (vice1541 module globals): vice1541 keeps drive state in
// module-level globals (Spec 612 Naming Law). A standalone drive session
// therefore shares those globals with any concurrently-live integrated
// session — run standalone drive sessions in isolation, not alongside an
// active C64 session. This matches the original standalone tool's intent.

import { existsSync, readFileSync } from "node:fs";
import { Vice1541Facade } from "./vice1541-facade.js";
import type { Drive1541Media } from "./drive1541.js";

export interface DriveSessionRecord {
  sessionId: string;
  diskPath: string;
  startedAt: string;
  drive: Vice1541Facade;
}

let nextId = 1;
const sessions = new Map<string, DriveSessionRecord>();

export interface StartDriveSessionOptions {
  diskPath: string;
  startTrack?: number;        // accepted for API compat (vice tracks its own head)
  deviceId?: number;          // default 8
  isPal?: boolean;            // default true
  writeProtected?: boolean;   // default false
}

export interface PersistResult {
  written: boolean;
  outputPath?: string;
  note?: string;
}

function mediaKind(path: string): Drive1541Media["kind"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".d64")) return "d64";
  if (lower.endsWith(".p64")) return "p64";
  return "g64";
}

export function startDriveSession(opts: StartDriveSessionOptions): DriveSessionRecord {
  if (!existsSync(opts.diskPath)) {
    throw new Error(`Disk image not found: ${opts.diskPath}`);
  }
  const bytes = new Uint8Array(readFileSync(opts.diskPath));
  const drive = new Vice1541Facade();
  drive.attachDisk({
    kind: mediaKind(opts.diskPath),
    bytes,
    readOnly: opts.writeProtected ?? false,
  });
  const record: DriveSessionRecord = {
    sessionId: `drive-${nextId++}`,
    diskPath: opts.diskPath,
    startedAt: new Date().toISOString(),
    drive,
  };
  sessions.set(record.sessionId, record);
  return record;
}

export function getDriveSession(sessionId: string): DriveSessionRecord | undefined {
  return sessions.get(sessionId);
}

export function listDriveSessions(): DriveSessionRecord[] {
  return [...sessions.values()];
}

export function stopDriveSession(sessionId: string): boolean {
  const record = sessions.get(sessionId);
  if (record) record.drive.detachDisk();
  return sessions.delete(sessionId);
}

export function persistDriveSession(sessionId: string, _outputPath?: string): PersistResult {
  const record = sessions.get(sessionId);
  if (!record) throw new Error(`No drive session ${sessionId}`);
  // Spec 704 §11 R3 — VICE writes dirty GCR back on detach
  // (drive_image_detach). A standalone "persist without detach" accessor is
  // a vice-facade follow-up; for now report no explicit write-back.
  return {
    written: false,
    note: "vice drive write-back occurs on detach (drive_image_detach); standalone persist accessor pending",
  };
}
