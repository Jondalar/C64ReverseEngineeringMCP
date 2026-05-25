// src/runtime/headless/inspect/asset-join-tracedb.ts
//
// Spec 721.J2 — DuckDB-backed TraceChainSource over the Spec 708 `io` channel
// (BusAccessEvent: { op, addr, value, pc }). The resolver (asset-join.ts) is
// sync; DuckDB is async — so this is an ASYNC FACTORY that indexes the io events
// once and returns a sync `TraceChainSource`. Source-agnostic (Spec 721 §2): the
// io events come from either an agent headless trace or a human UI TRACE-ON run.

import type { TraceRunStore } from "../trace/trace-run-store.js";
import { queryTraceRunStore } from "../trace/trace-run-store.js";
import type { TraceChainSource, TraceWriter } from "./asset-join.js";

/** Merge a sorted addr list into contiguous [addr,length) ranges. */
function mergeRanges(addrs: number[]): Array<{ addr: number; length: number }> {
  if (addrs.length === 0) return [];
  const sorted = [...new Set(addrs)].sort((a, b) => a - b);
  const out: Array<{ addr: number; length: number }> = [];
  let start = sorted[0]!, prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i]!;
    if (a <= prev + 1) { prev = a; continue; }
    out.push({ addr: start, length: prev - start + 1 });
    start = a; prev = a;
  }
  out.push({ addr: start, length: prev - start + 1 });
  return out;
}

/**
 * Index the run's `io` channel writes/reads and return a sync TraceChainSource.
 * `writerOf(range)` returns the dominant writer PC of that range + the contiguous
 * RAM ranges that PC read (the copy/depack source bytes).
 */
export async function loadTraceChainSourceFromDuckDb(
  store: TraceRunStore,
  runId: string,
): Promise<TraceChainSource> {
  const rid = runId.replace(/'/g, "''");
  const ioFilter = `run_id='${rid}' AND channel='io'`;
  const writeRows = await queryTraceRunStore(
    store,
    `SELECT CAST(json_extract(data_json,'$.addr') AS BIGINT) AS addr,
            CAST(json_extract(data_json,'$.pc')   AS BIGINT) AS pc
       FROM trace_event
      WHERE ${ioFilter} AND json_extract_string(data_json,'$.op')='write'`,
  );
  const readRows = await queryTraceRunStore(
    store,
    `SELECT CAST(json_extract(data_json,'$.pc')   AS BIGINT) AS pc,
            CAST(json_extract(data_json,'$.addr') AS BIGINT) AS addr
       FROM trace_event
      WHERE ${ioFilter} AND json_extract_string(data_json,'$.op')='read'`,
  );

  const writes = writeRows.map((r) => ({ addr: Number(r[0]), pc: Number(r[1]) }));
  const readsByPc = new Map<number, number[]>();
  for (const r of readRows) {
    const pc = Number(r[0]); const addr = Number(r[1]);
    (readsByPc.get(pc) ?? readsByPc.set(pc, []).get(pc)!).push(addr);
  }

  return {
    writerOf(addr: number, length: number): TraceWriter | null {
      const inRange = writes.filter((w) => w.addr >= addr && w.addr < addr + length);
      if (inRange.length === 0) return null;
      // dominant writer PC of the range
      const counts = new Map<number, number>();
      for (const w of inRange) counts.set(w.pc, (counts.get(w.pc) ?? 0) + 1);
      let pc = inRange[0]!.pc, best = -1;
      for (const [p, c] of counts) if (c > best) { best = c; pc = p; }
      return { pc, reads: mergeRanges(readsByPc.get(pc) ?? []) };
    },
  };
}
