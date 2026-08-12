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
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { HeadlessSessionRecord, HeadlessTraceEvent } from "./types.js";

export interface HeadlessTraceIndexEntry {
  pc: number;
  count: number;
  firstIndex: number;
  lastIndex: number;
  trapCount: number;
  lastBytes: number[];
}

export interface HeadlessAccessIndexEntry {
  address: number;
  reads: number;
  writes: number;
  firstIndex: number;
  lastIndex: number;
}

export interface HeadlessTraceIndex {
  sessionId: string;
  tracePath: string;
  traceEventCount: number;
  uniquePcCount: number;
  uniqueAccessAddressCount: number;
  topPcs: HeadlessTraceIndexEntry[];
  topAccesses: HeadlessAccessIndexEntry[];
  pcStats: Record<string, HeadlessTraceIndexEntry>;
  accessStats: Record<string, HeadlessAccessIndexEntry>;
}

export async function buildHeadlessTraceIndex(record: HeadlessSessionRecord, limit = 64): Promise<HeadlessTraceIndex> {
  const pcStats = new Map<number, HeadlessTraceIndexEntry>();
  const accessStats = new Map<number, HeadlessAccessIndexEntry>();
  let traceEventCount = 0;

  for await (const event of readHeadlessTrace(record.workspace.tracePath)) {
    traceEventCount += 1;
    const pcEntry = pcStats.get(event.pc);
    if (pcEntry) {
      pcEntry.count += 1;
      pcEntry.lastIndex = event.index;
      pcEntry.lastBytes = [...event.bytes];
      if (event.trap) pcEntry.trapCount += 1;
    } else {
      pcStats.set(event.pc, {
        pc: event.pc,
        count: 1,
        firstIndex: event.index,
        lastIndex: event.index,
        trapCount: event.trap ? 1 : 0,
        lastBytes: [...event.bytes],
      });
    }

    for (const access of event.accesses) {
      const accessEntry = accessStats.get(access.address);
      if (accessEntry) {
        if (access.kind === "read") accessEntry.reads += 1;
        if (access.kind === "write") accessEntry.writes += 1;
        accessEntry.lastIndex = event.index;
      } else {
        accessStats.set(access.address, {
          address: access.address,
          reads: access.kind === "read" ? 1 : 0,
          writes: access.kind === "write" ? 1 : 0,
          firstIndex: event.index,
          lastIndex: event.index,
        });
      }
    }
  }

  const index: HeadlessTraceIndex = {
    sessionId: record.sessionId,
    tracePath: record.workspace.tracePath,
    traceEventCount,
    uniquePcCount: pcStats.size,
    uniqueAccessAddressCount: accessStats.size,
    topPcs: [...pcStats.values()].sort((a, b) => b.count - a.count).slice(0, limit),
    topAccesses: [...accessStats.values()].sort((a, b) => (b.reads + b.writes) - (a.reads + a.writes)).slice(0, limit),
    pcStats: Object.fromEntries([...pcStats.entries()].map(([pc, entry]) => [pc.toString(16).toUpperCase().padStart(4, "0"), entry])),
    accessStats: Object.fromEntries([...accessStats.entries()].map(([address, entry]) => [address.toString(16).toUpperCase().padStart(4, "0"), entry])),
  };

  await writeFile(record.workspace.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

export async function loadHeadlessTraceIndex(indexPath: string): Promise<HeadlessTraceIndex> {
  const text = await readFile(indexPath, "utf8");
  return JSON.parse(text) as HeadlessTraceIndex;
}

async function* readHeadlessTrace(tracePath: string): AsyncGenerator<HeadlessTraceEvent> {
  const stream = createReadStream(tracePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed) as HeadlessTraceEvent;
  }
}
