// Legacy Spec-217 native-store reads. SEPARATED from the convenience readers
// (queries.ts) so the product reader path contains zero `FROM meta` /
// `FROM instructions` (Spec 726 §6a / Spec 729 E2E-I).
//
// These functions are reached ONLY for a genuine Spec-217 native store — one
// that has real `instructions` / `bus_events` / `meta` BASE tables and NO
// `trace_event` table. Such stores are produced only by dev/VICE capture
// scripts (src/runtime/trace-store/duckdb-store.ts), never by the live MCP sink.
// A Spec 726 live-sink store NEVER reaches this module.
import type { TraceStoreInfo } from "./queries.js";

export async function getInfoLegacy217(conn: any): Promise<TraceStoreInfo> {
  const metaRows = await conn.runAndReadAll("SELECT key, value FROM meta ORDER BY key");
  const meta: Record<string, string> = {};
  for (const [k, v] of metaRows.getRows()) meta[String(k)] = String(v);

  const counts = await conn.runAndReadAll(`
    SELECT 'instructions', count(*) FROM instructions
    UNION ALL SELECT 'bus_events', count(*) FROM bus_events
    UNION ALL SELECT 'chip_events', count(*) FROM chip_events
    UNION ALL SELECT 'anchors', count(*) FROM anchors
    UNION ALL SELECT 'rollups', count(*) FROM rollups
  `);
  const tableCounts: Record<string, bigint> = {};
  for (const [t, n] of counts.getRows()) {
    tableCounts[String(t)] = typeof n === "bigint" ? n : BigInt(n);
  }

  const range = await conn.runAndReadAll(
    `SELECT MIN(master_clock), MAX(master_clock) FROM instructions WHERE master_clock IS NOT NULL`);
  const r = range.getRows();
  let masterClockRange: { min: bigint; max: bigint } | undefined;
  if (r[0]?.[0] !== null && r[0]?.[0] !== undefined) {
    masterClockRange = {
      min: typeof r[0][0] === "bigint" ? r[0][0] : BigInt(r[0][0]),
      max: typeof r[0][1] === "bigint" ? r[0][1] : BigInt(r[0][1]),
    };
  }
  return { meta, tableCounts, masterClockRange };
}

/** FROM-source for legacy stores. Used only when isLiveSink === false. */
export const LEGACY_INSTRUCTIONS = "instructions";
export const LEGACY_BUS_EVENTS = "bus_events";
export const LEGACY_ANCHORS = "anchors";
