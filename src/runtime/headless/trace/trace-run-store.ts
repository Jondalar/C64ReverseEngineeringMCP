// Spec 708.3 — DuckDB persistence for declarative trace runs.
//
// Reuses the project's DuckDB engine (@duckdb/node-api, same as the Spec 217
// trace-store) but adds 708 EVIDENCE tables (trace_run / trace_event /
// trace_mark) in the SAME store — the chunk schema (instructions/bus/chip) is
// firehose-shaped and does not carry run/definition/checkpoint/media linkage.
// This is an extension of the store, NOT a parallel diagnostic path.
//
// Spec 726.2 — STREAMING writer: `appendTraceEvents` flushes batches into the
// open store DURING the run (called from the run-loop chunk boundary), so there
// is no in-RAM cap and no end-of-run stall. `writeTraceRunHeader` writes the
// trace_run + trace_mark rows at stop (final counts known then). The legacy
// one-shot `writeTraceRun` is kept = header + events + marks in one call (used
// by the scenario path / tests).

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeTraceDefinition, RuntimeTraceRun } from "./trace-definition.js";

type AnyDuckDb = { DuckDBInstance: { create(path: string): Promise<any> } };
let duckdbModule: AnyDuckDb | undefined;
async function loadDuckDb(): Promise<AnyDuckDb> {
  if (!duckdbModule) duckdbModule = (await import("@duckdb/node-api")) as unknown as AnyDuckDb;
  return duckdbModule;
}

export interface TraceEventRow {
  seq: number;
  cycle: number;
  channel: string;
  triggerKind: string;
  captureKind: string;
  dataJson: string;
}

export interface TraceRunStore { conn: any; inst: any; path: string }

const sq = (s: string): string => `'${String(s).replace(/'/g, "''")}'`;
const num = (n: number | undefined | null): string => (n == null ? "NULL" : String(Math.trunc(n)));

export async function openTraceRunStore(path: string): Promise<TraceRunStore> {
  const duckdb = await loadDuckDb();
  if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  const inst = await duckdb.DuckDBInstance.create(path);
  const conn = await inst.connect();
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS trace_run (
       run_id TEXT PRIMARY KEY, def_id TEXT, def_version INTEGER, def_json TEXT, name TEXT,
       start_checkpoint_id TEXT, stop_checkpoint_id TEXT, media_sha TEXT, media_name TEXT, branch_id TEXT,
       cycle_start UBIGINT, cycle_end UBIGINT, event_count UBIGINT, bytes_written UBIGINT,
       overhead_ms DOUBLE, retention TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS trace_event (
       run_id TEXT, seq UBIGINT, cycle UBIGINT, channel TEXT,
       trigger_kind TEXT, capture_kind TEXT, data_json TEXT)`,
    `CREATE TABLE IF NOT EXISTS trace_mark (run_id TEXT, cycle UBIGINT, label TEXT)`,
  ]) await conn.run(ddl);
  return { conn, inst, path };
}

export async function writeTraceRun(
  store: TraceRunStore,
  run: RuntimeTraceRun,
  def: RuntimeTraceDefinition,
  events: TraceEventRow[],
): Promise<void> {
  const { conn } = store;
  await conn.run(
    `INSERT INTO trace_run VALUES (${sq(run.runId)}, ${sq(run.definitionId)}, ${num(run.definitionVersion)}, ` +
    `${sq(JSON.stringify(def))}, ${sq(def.name)}, ${run.startCheckpointId ? sq(run.startCheckpointId) : "NULL"}, ` +
    `${run.stopCheckpointId ? sq(run.stopCheckpointId) : "NULL"}, ` +
    `${run.media?.sha256 ? sq(run.media.sha256) : "NULL"}, ${run.media?.sourceName ? sq(run.media.sourceName) : "NULL"}, ` +
    `${run.branchId ? sq(run.branchId) : "NULL"}, ${num(run.cycleStart)}, ${num(run.cycleEnd)}, ` +
    `${num(run.eventCount)}, ${num(run.bytesWritten)}, ${run.overheadMs == null ? "NULL" : run.overheadMs}, ` +
    `${sq(def.retention)}, ${sq(new Date().toISOString())})`,
  );

  // batch trace_event inserts (chunks keep the SQL string bounded)
  const CHUNK = 500;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    const values = slice.map((e) =>
      `(${sq(run.runId)}, ${num(e.seq)}, ${num(e.cycle)}, ${sq(e.channel)}, ${sq(e.triggerKind)}, ${sq(e.captureKind)}, ${sq(e.dataJson)})`,
    ).join(", ");
    await conn.run(`INSERT INTO trace_event VALUES ${values}`);
  }

  if (run.marks.length > 0) {
    const values = run.marks.map((m) => `(${sq(run.runId)}, ${num(m.cycle)}, ${sq(m.label)})`).join(", ");
    await conn.run(`INSERT INTO trace_mark VALUES ${values}`);
  }
}

export async function closeTraceRunStore(store: TraceRunStore): Promise<void> {
  try { store.inst?.closeSync?.(); } catch { /* ignore */ }
}

/** Helper for gates/tools: run a read query, return rows as value arrays
 *  (matches the trace-store queries.ts DuckDB read API: runAndReadAll/getRows). */
export async function queryTraceRunStore(store: TraceRunStore, sql: string): Promise<unknown[][]> {
  const reader = await store.conn.runAndReadAll(sql);
  return reader.getRows() as unknown[][];
}
