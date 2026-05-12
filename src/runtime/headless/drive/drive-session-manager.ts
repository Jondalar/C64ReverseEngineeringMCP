// DriveSessionManager — singleton holder for active DriveSession
// instances. Sprint 63: minimal manager that the new
// headless_drive_session_* MCP tools use for state lookup.
//
// This is intentionally separate from the existing
// HeadlessSessionManager (which orchestrates a single C64 trace
// session). Full integration of drive emulation into the C64
// session-manager is a follow-up sprint; for now drive sessions
// stand alone.

import { existsSync, readFileSync } from "node:fs";
import { G64Parser } from "../../../disk/g64-parser.js";
import { DriveSession } from "./drive-session.js";
import { TrackBuffer, HeadPosition } from "./head-position.js";
import { persistTrackBuffer, type PersistResult } from "./session-persist.js";

export interface DriveSessionRecord {
  sessionId: string;
  diskPath: string;
  startedAt: string;
  trackBuffer: TrackBuffer;
  headPosition: HeadPosition;
  parser: G64Parser;
  session: DriveSession;
}

let nextId = 1;
const sessions = new Map<string, DriveSessionRecord>();

export interface StartDriveSessionOptions {
  diskPath: string;
  startTrack?: number;        // default 18
  deviceId?: number;          // default 8
  isPal?: boolean;            // default true
  writeProtected?: boolean;   // default false
}

export function startDriveSession(opts: StartDriveSessionOptions): DriveSessionRecord {
  if (!existsSync(opts.diskPath)) {
    throw new Error(`Disk image not found: ${opts.diskPath}`);
  }
  const data = readFileSync(opts.diskPath);
  const parser = new G64Parser(data);
  const trackBuffer = new TrackBuffer(parser);
  const headPosition = new HeadPosition({ startTrack: opts.startTrack ?? 18 });
  const session = new DriveSession({
    isPal: opts.isPal,
    deviceId: opts.deviceId,
    gcr: { trackBuffer, headPosition, writeProtected: opts.writeProtected },
  });
  const record: DriveSessionRecord = {
    sessionId: `drive-${nextId++}`,
    diskPath: opts.diskPath,
    startedAt: new Date().toISOString(),
    trackBuffer, headPosition, parser, session,
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
  return sessions.delete(sessionId);
}

export function persistDriveSession(sessionId: string, outputPath?: string): PersistResult {
  const record = sessions.get(sessionId);
  if (!record) throw new Error(`No drive session ${sessionId}`);
  return persistTrackBuffer(record.parser, record.trackBuffer, record.diskPath, outputPath);
}
