// Spec 804 §4.2 — names on trace rows, residency decided per row from the trace itself.

import type { SymbolResolver } from "./resolver.js";
import { nameRows } from "./structured.js";
import { TraceTimeline, type SafeQuery } from "./trace-bytes.js";
import type { ResolveRequest, RuntimeSpace } from "./types.js";

type Row = Record<string, unknown>;

function spaceOfRow(row: Row): RuntimeSpace {
  return row.cpu === "drive8" || row.side === "drive" || /drive/iu.test(String(row.family ?? "")) ? "drive8" : "c64";
}

function cycleOfRow(row: Row): number {
  const c = row.cycle ?? row.master_clock ?? row.clock;
  return typeof c === "number" ? c : Number(c ?? 0);
}

export async function nameTraceRows(rows: Row[], how: { resolver: SymbolResolver; query: SafeQuery }): Promise<Row[]> {
  if (how.resolver.size === 0 || rows.length === 0) return rows;
  const requests: ResolveRequest[] = [];
  for (const r of rows) {
    for (const key of ["pc", "addr"]) {
      const v = r[key];
      if (typeof v === "number" && v >= 0 && v <= 0xffff) requests.push({ space: spaceOfRow(r), addr: v });
    }
  }
  const needed = how.resolver.neededBytes(requests);
  const timelines = new Map<RuntimeSpace, TraceTimeline>();
  for (const [space, addrs] of needed) timelines.set(space, await TraceTimeline.build(how.query, space, addrs));
  const empty = new TraceTimeline();
  return nameRows(rows, [{ key: "pc", role: "pc" }, { key: "addr", role: "memory" }], {
    resolver: how.resolver,
    spaceOf: spaceOfRow,
    bytesFor: (row) => (timelines.get(spaceOfRow(row)) ?? empty).at(cycleOfRow(row)),
  });
}
