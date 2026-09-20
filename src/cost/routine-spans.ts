// Spec 861 §4.4 — which routine a pc belongs to.
//
// The graph's routines, with their extents. Where one covers the address, the
// routine is the graph's. Where several could — a multiload, a banked cartridge,
// two payloads at one address — residency decides, and until 804's byte match is
// asked here the row is attributed only where it is UNAMBIGUOUS: `evaluateTrace`
// counts the rest as unattributed and never guesses.

import { GraphStore } from "../knowledge-graph/store.js";
import type { RoutineSpan } from "./trace-cost.js";

export function routineSpans(projectDir: string): RoutineSpan[] {
  let store;
  try {
    store = GraphStore.open(projectDir, { readOnly: true });
  } catch {
    return []; // no graph: every row is unattributed, and the report says so
  }
  try {
    const rows = store.db
      .prepare(
        "SELECT id, layer, name, address, end_address FROM nodes WHERE kind = 'routine' ORDER BY address, id, layer",
      )
      .all() as Array<{ id: string; layer: string; name: string | null; address: number; end_address: number | null }>;
    const byId = new Map<string, RoutineSpan>();
    for (const r of rows) {
      const current = byId.get(r.id);
      const label = r.layer === "human" ? r.name ?? current?.label : current?.label ?? r.name;
      byId.set(r.id, {
        id: r.id,
        label: label ?? r.id,
        start: r.address,
        end: r.end_address ?? current?.end ?? r.address,
      });
    }
    return [...byId.values()].sort((a, b) => a.start - b.start);
  } finally {
    store.close();
  }
}
