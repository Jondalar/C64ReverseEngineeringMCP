// Spec 232 — typed event query API on top of Spec 217 DuckDB store.
//
// Maps EventQuery → SQL against the existing instructions /
// bus_events / chip_events tables. Family identifies which table +
// kind filter. New families that don't yet have a producer return
// empty result (= ok, additive).

import type { EventFamily, EventRow } from "./trace-events.js";

export interface EventQuery {
  runId: string;
  family: EventFamily;
  cycleRange?: [number, number];
  pcRange?: [number, number];
  addrRange?: [number, number];
  /** SQL WHERE fragment, sandboxed (= no semicolons / unions). */
  predicate?: string;
  limit?: number;
}

interface FamilyMapping {
  table: "instructions" | "bus_events" | "chip_events";
  kindFilter?: string;     // chip_events.kind / bus_events.kind value
  chipFilter?: string;     // chip_events.chip value
  rowFromDb: (row: any, runId: string) => EventRow;
}

const MAP: Record<EventFamily, FamilyMapping | null> = {
  cpu_step: {
    table: "instructions",
    rowFromDb: (r, runId) => ({
      runId, family: "cpu_step",
      cycle: Number(r.clock),
      pc: Number(r.pc),
      opcode: Number(r.opcode),
      a: Number(r.a), x: Number(r.x), y: Number(r.y),
      sp: Number(r.sp), flags: Number(r.p),
    }),
  },
  mem_read: {
    table: "bus_events",
    kindFilter: "read",
    rowFromDb: (r, runId) => ({
      runId, family: "mem_read",
      cycle: Number(r.clock),
      pc: Number(r.pc ?? 0), addr: Number(r.addr ?? 0),
      value: Number(r.value ?? 0), region: "ram",
    }),
  },
  mem_write: {
    table: "bus_events",
    kindFilter: "write",
    rowFromDb: (r, runId) => ({
      runId, family: "mem_write",
      cycle: Number(r.clock),
      pc: Number(r.pc ?? 0), addr: Number(r.addr ?? 0),
      value: Number(r.value ?? 0), region: "ram",
    }),
  },
  irq_assert: {
    table: "chip_events",
    kindFilter: "irq_assert",
    rowFromDb: (r, runId) => ({
      runId, family: "irq_assert",
      cycle: Number(r.clock),
      source: r.chip ?? "manual",
    }),
  },
  irq_ack: {
    table: "chip_events",
    kindFilter: "irq_ack",
    rowFromDb: (r, runId) => ({
      runId, family: "irq_ack",
      cycle: Number(r.clock),
      source: r.chip ?? "manual",
    }),
  },
  nmi_assert: {
    table: "chip_events",
    kindFilter: "nmi_assert",
    rowFromDb: (r, runId) => ({
      runId, family: "nmi_assert",
      cycle: Number(r.clock),
      source: r.chip ?? "manual",
    }),
  },
  cia_timer_underflow: {
    table: "chip_events",
    kindFilter: "timer_underflow",
    rowFromDb: (r, runId) => ({
      runId, family: "cia_timer_underflow",
      cycle: Number(r.clock),
      chip: r.chip,
      timer: Number(r.unit) === 0 ? "ta" : "tb",
    }),
  },
  // bus_events.kind="line_change" carries all 3 lines. Filter on
  // line_atn / line_clk / line_data IS NOT NULL via predicate at
  // query time when caller wants a specific line.
  drive_atn_change: {
    table: "bus_events",
    kindFilter: "line_change",
    rowFromDb: (r, runId) => ({
      runId, family: "drive_atn_change",
      cycle: Number(r.clock),
      level: r.line_atn ? 1 : 0,
    }),
  },
  drive_clk_change: {
    table: "bus_events",
    kindFilter: "line_change",
    rowFromDb: (r, runId) => ({
      runId, family: "drive_clk_change",
      cycle: Number(r.clock),
      level: r.line_clk ? 1 : 0,
    }),
  },
  drive_data_change: {
    table: "bus_events",
    kindFilter: "line_change",
    rowFromDb: (r, runId) => ({
      runId, family: "drive_data_change",
      cycle: Number(r.clock),
      level: r.line_data ? 1 : 0,
    }),
  },
  gcr_byte: {
    table: "chip_events",
    kindFilter: "byte_ready",
    rowFromDb: (r, runId) => ({
      runId, family: "gcr_byte",
      cycle: Number(r.clock),
      byte: Number(r.value),
      trackHalf: Number(r.unit ?? 0),
    }),
  },
  trap_fire: {
    table: "chip_events",
    kindFilter: "trap_fire",
    rowFromDb: (r, runId) => ({
      runId, family: "trap_fire",
      cycle: Number(r.clock),
      hookName: String(r.chip ?? "unknown"),
    }),
  },

  // Families with no current producer — return empty.
  cpu_jam: null,
  mem_indirect_resolve: null,
  reset_assert: null,
  vic_badline: null,
  vic_raster_irq: null,
  vic_sprite_collision: null,
  vic_dma_steal: null,
  cia_register_read: null,
  cia_register_write: null,
  via_timer_underflow: null,
  via_register_read: null,
  via_register_write: null,
  sid_register_write: null,
  keyboard_press: null,
  keyboard_release: null,
  hook_audit: null,
  breakpoint_hit: null,
};

export interface QueryEventsBackend {
  /** Run a SELECT and return rows. Backend = duckdb connection wrapper. */
  exec(sql: string, params: unknown[]): Promise<any[]>;
  /** True when the connected store is a Spec 726 live-sink store
   *  (trace_run/trace_event/trace_mark). Then the logical instruction / bus
   *  table names resolve to schema726 projections instead of the legacy
   *  compat-view names (Spec 726 §6a — readers never name the legacy tables). */
  isLiveSink?(): Promise<boolean>;
}

export async function queryEvents(backend: QueryEventsBackend, q: EventQuery): Promise<EventRow[]> {
  const mapping = MAP[q.family];
  if (!mapping) return [];

  // Resolve the logical table to a real FROM source. On a 726 store, project
  // straight from trace_event so no query names the legacy meta/instructions
  // tables; chip_events has no 726 producer yet → returns empty (additive).
  const liveSink = backend.isLiveSink ? await backend.isLiveSink() : false;
  let fromSource: string = mapping.table;
  if (liveSink) {
    const { INSTRUCTIONS_726, BUS_EVENTS_726 } = await import("../../trace-store/schema726.js");
    if (mapping.table === "instructions") fromSource = `(${INSTRUCTIONS_726})`;
    else if (mapping.table === "bus_events") fromSource = `(${BUS_EVENTS_726})`;
    else return []; // chip_events: no 726 producer
  }

  const where: string[] = ["run_id = ?"];
  const params: unknown[] = [q.runId];
  if (mapping.kindFilter !== undefined) {
    where.push("kind = ?");
    params.push(mapping.kindFilter);
  }
  if (mapping.chipFilter !== undefined) {
    where.push("chip = ?");
    params.push(mapping.chipFilter);
  }
  if (q.cycleRange) {
    where.push("clock BETWEEN ? AND ?");
    params.push(q.cycleRange[0], q.cycleRange[1]);
  }
  if (q.pcRange && (mapping.table === "bus_events" || mapping.table === "instructions")) {
    where.push("pc BETWEEN ? AND ?");
    params.push(q.pcRange[0], q.pcRange[1]);
  }
  if (q.addrRange && mapping.table === "bus_events") {
    where.push("addr BETWEEN ? AND ?");
    params.push(q.addrRange[0], q.addrRange[1]);
  }
  if (q.predicate) {
    if (/[;]|UNION|DROP|DELETE|INSERT|UPDATE/i.test(q.predicate)) {
      throw new Error("predicate contains forbidden tokens");
    }
    where.push(`(${q.predicate})`);
  }

  const limit = q.limit && q.limit > 0 && q.limit <= 100000 ? q.limit : 10000;
  const sql = `SELECT * FROM ${fromSource} WHERE ${where.join(" AND ")} ORDER BY clock LIMIT ${limit}`;
  const rows = await backend.exec(sql, params);
  return rows.map((r) => mapping.rowFromDb(r, q.runId));
}
