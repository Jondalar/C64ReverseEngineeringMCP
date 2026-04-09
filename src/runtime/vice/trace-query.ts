import { appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import type { ViceSessionRecord } from "./types.js";
import { decodeTraceInstruction } from "./trace-instruction.js";

export interface ViceTraceInstructionEvent {
  kind: "instruction";
  sampleIndex: number;
  clock: string;
  pc?: number;
  instructionBytes: number[];
  registers: Record<string, number>;
}

export interface ViceTraceSampleEvent {
  kind: "sample";
  sampleIndex: number;
  capturedAt: string;
  currentPc?: number;
  items: number;
}

export type ViceTraceEvent = ViceTraceInstructionEvent | ViceTraceSampleEvent;

export interface ViceTraceMatch {
  sessionId: string;
  sampleIndex: number;
  clock: string;
  pc?: number;
  instructionBytes: number[];
  registers: Record<string, number>;
}

export interface ViceTraceSlice {
  sessionId: string;
  anchorClock: string;
  beforeCount: number;
  afterCount: number;
  found: boolean;
  events: ViceTraceInstructionEvent[];
}

export interface ViceTraceHotspot {
  pc: number;
  count: number;
  firstClock: string;
  lastClock: string;
  firstSampleIndex: number;
  lastSampleIndex: number;
}

export interface ViceTraceCallFrame {
  pc: number;
  clock: string;
  sampleIndex: number;
  targetAddress?: number;
}

export interface ViceTraceNote {
  ts: string;
  title: string;
  note: string;
  anchorClock?: string;
  pc?: number;
  sampleIndex?: number;
}

export async function loadTraceSession(projectDir: string, sessionId?: string): Promise<ViceSessionRecord> {
  if (sessionId) {
    const sessionPath = join(projectDir, "analysis", "runtime", sessionId, "session.json");
    const sessionText = await readFile(sessionPath, "utf8");
    return JSON.parse(sessionText) as ViceSessionRecord;
  }

  const runtimeRoot = join(projectDir, "analysis", "runtime");
  const entries = await readdir(runtimeRoot, { withFileTypes: true });
  const sessions = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const sessionPath = join(runtimeRoot, entry.name, "session.json");
      try {
        const [sessionText, stats] = await Promise.all([
          readFile(sessionPath, "utf8"),
          stat(sessionPath),
        ]);
        const record = JSON.parse(sessionText) as ViceSessionRecord;
        if (record.projectDir !== projectDir) {
          return undefined;
        }
        return {
          record,
          mtimeMs: stats.mtimeMs,
        };
      } catch {
        return undefined;
      }
    }));

  const latest = sessions
    .filter((value): value is { record: ViceSessionRecord; mtimeMs: number } => Boolean(value))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];

  if (!latest) {
    throw new Error("No VICE trace session found.");
  }

  return latest.record;
}

export async function findTraceByPc(
  record: ViceSessionRecord,
  pc: number,
  limit = 20,
): Promise<ViceTraceMatch[]> {
  const matches: ViceTraceMatch[] = [];
  for await (const event of readRuntimeTrace(record.workspace.runtimeTracePath)) {
    if (event.kind !== "instruction" || event.pc !== pc) {
      continue;
    }
    matches.push(toMatch(record.sessionId, event));
    if (matches.length >= limit) {
      break;
    }
  }
  return matches;
}

export async function findTraceByBytes(
  record: ViceSessionRecord,
  bytes: number[],
  mode: "prefix" | "exact" | "contains" = "prefix",
  limit = 20,
): Promise<ViceTraceMatch[]> {
  const matches: ViceTraceMatch[] = [];
  for await (const event of readRuntimeTrace(record.workspace.runtimeTracePath)) {
    if (event.kind !== "instruction") {
      continue;
    }
    if (!matchesBytePattern(event.instructionBytes, bytes, mode)) {
      continue;
    }
    matches.push(toMatch(record.sessionId, event));
    if (matches.length >= limit) {
      break;
    }
  }
  return matches;
}

export async function findTraceByOperand(
  record: ViceSessionRecord,
  address: number,
  limit = 20,
): Promise<ViceTraceMatch[]> {
  const bytes = address <= 0xff
    ? [address & 0xff]
    : [address & 0xff, (address >> 8) & 0xff];
  return findTraceByBytes(record, bytes, bytes.length === 1 ? "contains" : "contains", limit);
}

export async function findTraceMemoryAccess(
  record: ViceSessionRecord,
  address: number,
  access: "read" | "write" | "readwrite" | "any" = "any",
  limit = 20,
): Promise<ViceTraceMatch[]> {
  const matches: ViceTraceMatch[] = [];
  for await (const event of readRuntimeTrace(record.workspace.runtimeTracePath)) {
    if (event.kind !== "instruction") {
      continue;
    }
    const decoded = decodeTraceInstruction(event.instructionBytes);
    if (decoded.directAddress !== address) {
      continue;
    }
    if (access !== "any" && decoded.access !== access && !(access === "readwrite" && decoded.access === "readwrite")) {
      continue;
    }
    matches.push(toMatch(record.sessionId, event));
    if (matches.length >= limit) {
      break;
    }
  }
  return matches;
}

export async function sliceTraceByClock(
  record: ViceSessionRecord,
  anchorClock: string,
  beforeCount = 40,
  afterCount = 80,
): Promise<ViceTraceSlice> {
  const beforeBuffer: ViceTraceInstructionEvent[] = [];
  const events: ViceTraceInstructionEvent[] = [];
  let found = false;
  let afterRemaining = afterCount;

  for await (const event of readRuntimeTrace(record.workspace.runtimeTracePath)) {
    if (event.kind !== "instruction") {
      continue;
    }

    if (!found) {
      if (event.clock === anchorClock) {
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
    anchorClock,
    beforeCount,
    afterCount,
    found,
    events,
  };
}

export async function traceHotspots(
  record: ViceSessionRecord,
  limit = 20,
): Promise<ViceTraceHotspot[]> {
  const pcStats = new Map<number, {
    count: number;
    firstClock: string;
    lastClock: string;
    firstSampleIndex: number;
    lastSampleIndex: number;
  }>();

  for await (const event of readRuntimeTrace(record.workspace.runtimeTracePath)) {
    if (event.kind !== "instruction" || event.pc === undefined) {
      continue;
    }
    const existing = pcStats.get(event.pc);
    if (existing) {
      existing.count += 1;
      existing.lastClock = event.clock;
      existing.lastSampleIndex = event.sampleIndex;
    } else {
      pcStats.set(event.pc, {
        count: 1,
        firstClock: event.clock,
        lastClock: event.clock,
        firstSampleIndex: event.sampleIndex,
        lastSampleIndex: event.sampleIndex,
      });
    }
  }

  return [...pcStats.entries()]
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, limit)
    .map(([pc, stat]) => ({
      pc,
      count: stat.count,
      firstClock: stat.firstClock,
      lastClock: stat.lastClock,
      firstSampleIndex: stat.firstSampleIndex,
      lastSampleIndex: stat.lastSampleIndex,
    }));
}

export async function traceCallPath(
  record: ViceSessionRecord,
  anchorClock: string,
  beforeCount = 600,
): Promise<ViceTraceCallFrame[]> {
  const slice = await sliceTraceByClock(record, anchorClock, beforeCount, 0);
  if (!slice.found || slice.events.length === 0) {
    return [];
  }

  const frames: ViceTraceCallFrame[] = [];
  let pendingReturns = 0;

  for (let index = slice.events.length - 1; index >= 0; index -= 1) {
    const event = slice.events[index]!;
    const decoded = decodeTraceInstruction(event.instructionBytes);
    if (decoded.isReturn) {
      pendingReturns += 1;
      continue;
    }
    if (!decoded.isCall) {
      continue;
    }
    if (pendingReturns > 0) {
      pendingReturns -= 1;
      continue;
    }
    frames.push({
      pc: event.pc ?? 0,
      clock: event.clock,
      sampleIndex: event.sampleIndex,
      targetAddress: decoded.operand,
    });
    if (frames.length >= 16) {
      break;
    }
  }

  return frames.reverse();
}

export async function addTraceNote(
  record: ViceSessionRecord,
  note: Omit<ViceTraceNote, "ts">,
): Promise<ViceTraceNote> {
  const entry: ViceTraceNote = {
    ts: new Date().toISOString(),
    ...note,
  };
  await appendFile(resolveTraceNotesPath(record), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function listTraceNotes(record: ViceSessionRecord, limit = 50): Promise<ViceTraceNote[]> {
  const notes: ViceTraceNote[] = [];
  try {
    for await (const line of readJsonlLines(resolveTraceNotesPath(record))) {
      try {
        notes.push(JSON.parse(line) as ViceTraceNote);
      } catch {
        // ignore malformed note rows
      }
    }
  } catch {
    return [];
  }
  return notes.slice(-limit).reverse();
}

function resolveTraceNotesPath(record: ViceSessionRecord): string {
  if (record.workspace.traceNotesPath) {
    return record.workspace.traceNotesPath;
  }
  if (record.workspace.traceDir) {
    return join(record.workspace.traceDir, "trace-notes.jsonl");
  }
  return join(dirname(record.workspace.runtimeTracePath), "trace-notes.jsonl");
}

async function* readRuntimeTrace(path: string): AsyncGenerator<ViceTraceEvent> {
  for await (const line of readJsonlLines(path)) {
    try {
      const event = JSON.parse(line) as ViceTraceEvent;
      if (event.kind === "sample" || event.kind === "instruction") {
        yield event;
      }
    } catch {
      // ignore malformed runtime trace rows
    }
  }
}

async function* readJsonlLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({
    input,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      if (!line.trim()) {
        continue;
      }
      yield line;
    }
  } finally {
    reader.close();
    input.destroy();
  }
}

function matchesBytePattern(
  haystack: number[],
  needle: number[],
  mode: "prefix" | "exact" | "contains",
): boolean {
  if (needle.length === 0) {
    return false;
  }
  if (mode === "exact") {
    return haystack.length === needle.length && haystack.every((value, index) => value === needle[index]);
  }
  if (mode === "prefix") {
    return haystack.length >= needle.length && needle.every((value, index) => haystack[index] === value);
  }
  for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    if (needle.every((value, index) => haystack[offset + index] === value)) {
      return true;
    }
  }
  return false;
}

function toMatch(sessionId: string, event: ViceTraceInstructionEvent): ViceTraceMatch {
  return {
    sessionId,
    sampleIndex: event.sampleIndex,
    clock: event.clock,
    pc: event.pc,
    instructionBytes: event.instructionBytes,
    registers: event.registers,
  };
}
