// Spec 123 (M5.2) v1 — event-indexed search over trace JSONL.
//
// Build per-key offset maps so agents can fetch events by PC or
// memory address without re-scanning the whole file.

import { readFileSync, writeFileSync } from "node:fs";

export interface EventIndex {
  pcOffsets: Map<number, number[]>;       // pc → list of byte offsets
  addrReadOffsets: Map<number, number[]>;  // addr → byte offsets of read events
  addrWriteOffsets: Map<number, number[]>; // addr → byte offsets of write events
  iecEdgeOffsets: number[];                 // any iec channel event
  byChannel: Map<string, number[]>;         // channel → byte offsets
}

export function buildEventIndex(jsonlPath: string): EventIndex {
  const text = readFileSync(jsonlPath, "utf8");
  const idx: EventIndex = {
    pcOffsets: new Map(),
    addrReadOffsets: new Map(),
    addrWriteOffsets: new Map(),
    iecEdgeOffsets: [],
    byChannel: new Map(),
  };
  let off = 0;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10 /* \n */) {
      const line = text.slice(lineStart, i);
      if (line.length > 0) {
        try {
          const ev = JSON.parse(line) as { ts?: number; channel?: string; data?: Record<string, unknown> };
          const ch = ev.channel ?? "unknown";
          if (!idx.byChannel.has(ch)) idx.byChannel.set(ch, []);
          idx.byChannel.get(ch)!.push(lineStart);
          const data = ev.data ?? {};
          if (typeof data.pc === "number") {
            const arr = idx.pcOffsets.get(data.pc) ?? [];
            arr.push(lineStart);
            idx.pcOffsets.set(data.pc, arr);
          }
          if (data.kind === "r" && typeof data.addr === "number") {
            const arr = idx.addrReadOffsets.get(data.addr) ?? [];
            arr.push(lineStart);
            idx.addrReadOffsets.set(data.addr, arr);
          }
          if (data.kind === "w" && typeof data.addr === "number") {
            const arr = idx.addrWriteOffsets.get(data.addr) ?? [];
            arr.push(lineStart);
            idx.addrWriteOffsets.set(data.addr, arr);
          }
          if (ch === "iec") idx.iecEdgeOffsets.push(lineStart);
        } catch { /* skip malformed line */ }
      }
      lineStart = i + 1;
    }
    off++;
  }
  return idx;
}

export function saveEventIndex(idx: EventIndex, outPath: string): void {
  const obj = {
    pcOffsets: Object.fromEntries(idx.pcOffsets),
    addrReadOffsets: Object.fromEntries(idx.addrReadOffsets),
    addrWriteOffsets: Object.fromEntries(idx.addrWriteOffsets),
    iecEdgeOffsets: idx.iecEdgeOffsets,
    byChannel: Object.fromEntries(idx.byChannel),
  };
  writeFileSync(outPath, JSON.stringify(obj));
}

export interface FindEventsResult {
  hits: { offset: number; line: string }[];
  totalHits: number;
}

export function findEventsByPc(jsonlPath: string, idx: EventIndex, pc: number, limit = 50): FindEventsResult {
  const offsets = idx.pcOffsets.get(pc) ?? [];
  const text = readFileSync(jsonlPath, "utf8");
  const hits: { offset: number; line: string }[] = [];
  for (const off of offsets.slice(0, limit)) {
    const eol = text.indexOf("\n", off);
    hits.push({ offset: off, line: text.slice(off, eol >= 0 ? eol : undefined) });
  }
  return { hits, totalHits: offsets.length };
}

export function findEventsByAddr(jsonlPath: string, idx: EventIndex, addr: number, kind: "r" | "w", limit = 50): FindEventsResult {
  const offsets = (kind === "r" ? idx.addrReadOffsets : idx.addrWriteOffsets).get(addr) ?? [];
  const text = readFileSync(jsonlPath, "utf8");
  const hits: { offset: number; line: string }[] = [];
  for (const off of offsets.slice(0, limit)) {
    const eol = text.indexOf("\n", off);
    hits.push({ offset: off, line: text.slice(off, eol >= 0 ? eol : undefined) });
  }
  return { hits, totalHits: offsets.length };
}
