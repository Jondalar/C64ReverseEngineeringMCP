import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { HeadlessMemoryAccess, HeadlessSessionRecord, HeadlessTraceEvent } from "./types.js";

export async function loadHeadlessSession(projectDir: string, sessionId?: string): Promise<HeadlessSessionRecord> {
  if (sessionId) {
    const sessionPath = join(projectDir, "analysis", "headless-runtime", sessionId, "session.json");
    const text = await readFile(sessionPath, "utf8");
    return JSON.parse(text) as HeadlessSessionRecord;
  }

  const root = join(projectDir, "analysis", "headless-runtime");
  const entries = await readdir(root, { withFileTypes: true });
  const sessions = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const sessionPath = join(root, entry.name, "session.json");
      try {
        const [text, stats] = await Promise.all([readFile(sessionPath, "utf8"), stat(sessionPath)]);
        return { record: JSON.parse(text) as HeadlessSessionRecord, mtimeMs: stats.mtimeMs };
      } catch {
        return undefined;
      }
    }));

  const latest = sessions
    .filter((value): value is { record: HeadlessSessionRecord; mtimeMs: number } => Boolean(value))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!latest) {
    throw new Error("No headless runtime session found.");
  }
  return latest.record;
}

export interface HeadlessTraceMatch {
  sessionId: string;
  index: number;
  pc: number;
  bytes: number[];
  trap?: string;
}

export interface HeadlessTraceSlice {
  sessionId: string;
  anchorIndex: number;
  found: boolean;
  events: HeadlessTraceEvent[];
}

export async function findHeadlessTraceByPc(record: HeadlessSessionRecord, pc: number, limit = 20): Promise<HeadlessTraceMatch[]> {
  const matches: HeadlessTraceMatch[] = [];
  for await (const event of readHeadlessTrace(record.workspace.tracePath)) {
    if (event.pc !== pc) {
      continue;
    }
    matches.push(toMatch(record.sessionId, event));
    if (matches.length >= limit) {
      break;
    }
  }
  return matches;
}

export async function findHeadlessTraceByAccess(
  record: HeadlessSessionRecord,
  address: number,
  kind: "read" | "write" | "access" = "access",
  limit = 20,
): Promise<HeadlessTraceMatch[]> {
  const matches: HeadlessTraceMatch[] = [];
  for await (const event of readHeadlessTrace(record.workspace.tracePath)) {
    const hit = event.accesses.some((access) => matchesAccess(access, address, kind));
    if (!hit) {
      continue;
    }
    matches.push(toMatch(record.sessionId, event));
    if (matches.length >= limit) {
      break;
    }
  }
  return matches;
}

export async function sliceHeadlessTraceByIndex(
  record: HeadlessSessionRecord,
  anchorIndex: number,
  beforeCount = 20,
  afterCount = 40,
): Promise<HeadlessTraceSlice> {
  const beforeBuffer: HeadlessTraceEvent[] = [];
  const events: HeadlessTraceEvent[] = [];
  let found = false;
  let afterRemaining = afterCount;
  for await (const event of readHeadlessTrace(record.workspace.tracePath)) {
    if (!found) {
      if (event.index === anchorIndex) {
        found = true;
        events.push(...beforeBuffer, event);
      } else {
        beforeBuffer.push(event);
        if (beforeBuffer.length > beforeCount) {
          beforeBuffer.shift();
        }
      }
      continue;
    }
    if (afterRemaining <= 0) {
      break;
    }
    events.push(event);
    afterRemaining -= 1;
  }
  return {
    sessionId: record.sessionId,
    anchorIndex,
    found,
    events,
  };
}

async function* readHeadlessTrace(tracePath: string): AsyncGenerator<HeadlessTraceEvent> {
  const stream = createReadStream(tracePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    yield JSON.parse(trimmed) as HeadlessTraceEvent;
  }
}

function matchesAccess(access: HeadlessMemoryAccess, address: number, kind: "read" | "write" | "access"): boolean {
  if (access.address !== address) {
    return false;
  }
  return kind === "access" || access.kind === kind;
}

function toMatch(sessionId: string, event: HeadlessTraceEvent): HeadlessTraceMatch {
  return {
    sessionId,
    index: event.index,
    pc: event.pc,
    bytes: [...event.bytes],
    trap: event.trap,
  };
}
