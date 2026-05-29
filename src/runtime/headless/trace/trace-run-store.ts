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
  await ensureSpec726CompatLayer(conn);
  return { conn, inst, path };
}

/** Has this connection's database the Spec 708/726 streaming schema?
 *  Detect by checking for the `trace_event` table — its presence is the
 *  signature of a 726-written store (Spec 217 native stores never have it). */
export async function isSpec726Store(conn: any): Promise<boolean> {
  try {
    const reader = await conn.runAndReadAll(
      `SELECT 1 FROM information_schema.tables
         WHERE table_schema='main' AND table_name='trace_event' LIMIT 1`,
    );
    return reader.getRows().length > 0;
  } catch { return false; }
}

/** Idempotent compat-layer install. Spec 217 readers (trace_store_* tools,
 *  runtime_query_events, anchor-builder, rollup-builder, queries.ts) SELECT
 *  from the legacy schema: meta / instructions / bus_events / chip_events /
 *  anchors / rollups. The Spec 708/726 sink writes trace_run / trace_event /
 *  trace_mark. This function adds a thin compat layer over the new schema so
 *  EVERY legacy reader works against a 726 store with no reader changes.
 *
 *  Called from BOTH the writer (openTraceRunStore) AND the readers (queries.ts
 *  withConn, runtime_query_events / runtime_follow_path / runtime_swimlane_slice
 *  / runtime_trace_taint handlers) — readers must self-heal old files that were
 *  written before the views existed.
 *
 *  Safe to call on non-726 stores (early-out via isSpec726Store). Safe to
 *  call concurrently / repeatedly (CREATE TABLE/VIEW IF NOT EXISTS + CREATE
 *  OR REPLACE VIEW). */
export async function ensureSpec726CompatLayer(conn: any): Promise<void> {
  if (!(await isSpec726Store(conn))) return;
  // meta: key/value pairs the Spec 217 getInfo reader expects. Writer populates
  // schema_version + run identity at writeTraceRunHeader time. If the table
  // already existed (newer 726 store), CREATE IF NOT EXISTS is a no-op.
  await conn.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  // Compat VIEWs over trace_event / trace_mark. CREATE OR REPLACE so a
  // subsequent run with a refined projection upgrades the view in place.
  for (const ddl of [
    // instructions: cpu/drive_pc → one row per executed instruction.
    `CREATE OR REPLACE VIEW instructions AS
       SELECT
         run_id,
         seq,
         CASE WHEN channel = 'drive_pc' OR json_extract_string(data_json, '$.side') = 'drive'
              THEN 'drive8' ELSE 'c64' END AS cpu,
         CAST(COALESCE(json_extract(data_json, '$.clk'), cycle) AS UBIGINT) AS clock,
         cycle AS master_clock,
         CAST(json_extract(data_json, '$.pc') AS USMALLINT) AS pc,
         CAST(json_extract(data_json, '$.opcode') AS UTINYINT) AS opcode,
         CAST(json_extract(data_json, '$.b1') AS UTINYINT) AS b1,
         CAST(json_extract(data_json, '$.b2') AS UTINYINT) AS b2,
         CAST(json_extract(data_json, '$.a') AS UTINYINT) AS a,
         CAST(json_extract(data_json, '$.x') AS UTINYINT) AS x,
         CAST(json_extract(data_json, '$.y') AS UTINYINT) AS y,
         CAST(json_extract(data_json, '$.sp') AS UTINYINT) AS sp,
         CAST(json_extract(data_json, '$.p') AS UTINYINT) AS p,
         'trace_event' AS source
       FROM trace_event
       WHERE channel IN ('cpu', 'drive_pc')`,
    // bus_events: bus_access/io = memory R/W; iec = line_change carrying line states.
    `CREATE OR REPLACE VIEW bus_events AS
       SELECT
         run_id,
         seq,
         CASE WHEN json_extract_string(data_json, '$.side') = 'drive' THEN 'drive8' ELSE 'c64' END AS cpu,
         CAST(COALESCE(json_extract(data_json, '$.cycle_drive'),
                       json_extract(data_json, '$.cycle_c64'),
                       cycle) AS UBIGINT) AS clock,
         cycle AS master_clock,
         CAST(json_extract(data_json, '$.pc') AS USMALLINT) AS pc,
         CASE
           WHEN channel = 'iec' THEN 'line_change'
           ELSE json_extract_string(data_json, '$.op')
         END AS kind,
         CAST(json_extract(data_json, '$.addr') AS USMALLINT) AS addr,
         CAST(json_extract(data_json, '$.value') AS UTINYINT) AS value,
         NULL::UTINYINT AS old_value,
         CASE WHEN channel = 'iec'
              THEN CAST(json_extract(data_json, '$.atn') AS BOOLEAN) END AS line_atn,
         CASE WHEN channel = 'iec'
              THEN CAST(json_extract(data_json, '$.clk') AS BOOLEAN) END AS line_clk,
         CASE WHEN channel = 'iec'
              THEN CAST(json_extract(data_json, '$.data') AS BOOLEAN) END AS line_data,
         'trace_event' AS source
       FROM trace_event
       WHERE channel IN ('bus_access', 'io', 'iec')`,
    // chip_events: no producer publishes chip-shaped rows into trace_event yet.
    `CREATE OR REPLACE VIEW chip_events AS
       SELECT run_id,
              CAST(NULL AS UBIGINT)   AS seq,
              CAST(NULL AS TEXT)      AS cpu,
              CAST(NULL AS UBIGINT)   AS clock,
              CAST(NULL AS UBIGINT)   AS master_clock,
              CAST(NULL AS USMALLINT) AS pc,
              CAST(NULL AS TEXT)      AS chip,
              CAST(NULL AS TEXT)      AS kind,
              CAST(NULL AS UTINYINT)  AS unit,
              CAST(NULL AS UTINYINT)  AS value,
              CAST(NULL AS UTINYINT)  AS old_value,
              CAST(NULL AS TEXT)      AS source
       FROM trace_event WHERE 1=0`,
    // anchors: trace_mark rows surface as named anchors (occurrence per label).
    `CREATE OR REPLACE VIEW anchors AS
       SELECT
         run_id,
         'trace_mark'           AS source,
         CAST(NULL AS TEXT)     AS cpu,
         label                  AS name,
         CAST(NULL AS USMALLINT) AS pc,
         CAST(row_number() OVER (PARTITION BY label ORDER BY cycle) AS UBIGINT) AS occurrence,
         cycle                  AS clock,
         cycle                  AS master_clock,
         cycle                  AS seq
       FROM trace_mark`,
    // rollups: derived structure built by Spec-217 rollup-builder; empty here.
    `CREATE OR REPLACE VIEW rollups AS
       SELECT run_id,
              CAST(NULL AS TEXT)     AS source,
              CAST(NULL AS UTINYINT) AS level,
              CAST(NULL AS UBIGINT)  AS window_index,
              CAST(NULL AS UBIGINT)  AS clock_start,
              CAST(NULL AS UBIGINT)  AS clock_end,
              CAST(NULL AS TEXT)     AS cpu
       FROM trace_event WHERE 1=0`,
  ]) await conn.run(ddl);
  // Backfill meta with schema_version derived from the trace_run header (if
  // present) so an old file that finalized before meta existed still reports
  // the right shape to getInfo. Safe: insert-or-replace, no error if empty.
  await conn.run(
    `INSERT OR REPLACE INTO meta(key, value)
       SELECT 'schema_version', 'spec-708-streaming'
       WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key='schema_version')`,
  );
  await conn.run(
    `INSERT OR REPLACE INTO meta(key, value)
       SELECT 'source', 'trace_event'
       WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key='source')`,
  );
  await conn.run(
    `INSERT OR REPLACE INTO meta(key, value)
       SELECT 'run_id', run_id FROM trace_run
       WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key='run_id') LIMIT 1`,
  );
}

/** Spec 726.2 — STREAMING: append a batch of trace_event rows into the open
 *  store. Called from the run-loop chunk boundary (emulator paused). Bounded SQL
 *  via 500-row chunks. Safe to call before the trace_run header exists (no FK). */
export async function appendTraceEvents(
  store: TraceRunStore,
  runId: string,
  events: TraceEventRow[],
): Promise<void> {
  if (events.length === 0) return;
  const { conn } = store;
  const CHUNK = 500;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    const values = slice.map((e) =>
      `(${sq(runId)}, ${num(e.seq)}, ${num(e.cycle)}, ${sq(e.channel)}, ${sq(e.triggerKind)}, ${sq(e.captureKind)}, ${sq(e.dataJson)})`,
    ).join(", ");
    await conn.run(`INSERT INTO trace_event VALUES ${values}`);
  }
}

/** Spec 726.2 — write the trace_run header + trace_mark rows. Done at STOP, when
 *  final counts (cycleEnd / eventCount / bytesWritten / overheadMs) are known. */
export async function writeTraceRunHeader(
  store: TraceRunStore,
  run: RuntimeTraceRun,
  def: RuntimeTraceDefinition,
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
  if (run.marks.length > 0) {
    const values = run.marks.map((m) => `(${sq(run.runId)}, ${num(m.cycle)}, ${sq(m.label)})`).join(", ");
    await conn.run(`INSERT INTO trace_mark VALUES ${values}`);
  }
  // Populate meta with schema_version + run identity so Spec-217 readers
  // (getInfo) return populated meta. Last-writer-wins for multi-run stores.
  const metaRows: Array<[string, string]> = [
    ["schema_version", "spec-708-streaming"],
    ["writer_version", "spec-726.2c"],
    ["run_id", run.runId],
    ["source", "trace_event"],
    ["captured_at", new Date().toISOString()],
    ["def_id", run.definitionId],
    ["def_name", def.name],
    ["retention", def.retention],
  ];
  for (const [k, v] of metaRows) {
    await conn.run(`INSERT OR REPLACE INTO meta VALUES (${sq(k)}, ${sq(v)})`);
  }
}

/** Legacy one-shot writer (scenario path / tests): header + all events + marks
 *  in one call. The streaming path uses appendTraceEvents + writeTraceRunHeader. */
export async function writeTraceRun(
  store: TraceRunStore,
  run: RuntimeTraceRun,
  def: RuntimeTraceDefinition,
  events: TraceEventRow[],
): Promise<void> {
  await writeTraceRunHeader(store, run, def);
  await appendTraceEvents(store, run.runId, events);
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
