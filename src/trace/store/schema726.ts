// Spec 726 §6a — reader-side projections of the LIVE-writer schema.
//
// The durable trace store written by the live sink (Spec 726) has exactly three
// base tables:
//
//   trace_run(run_id, …, cycle_start, cycle_end, event_count, created_at, …)
//   trace_event(run_id, seq, cycle, channel, trigger_kind, capture_kind, data_json)
//   trace_mark(run_id, cycle, label)
//
// Convenience readers MUST consume THIS schema directly. They must NOT query the
// legacy Spec-217 `meta` / `instructions` tables — those existed only as a
// compat shim and are forbidden as active reader tables (Spec 726 §6a, Spec 729
// E2E-I). The functions here return inline SQL CTEs over trace_event / trace_mark
// with neutral names, so a reader SELECTs from `(<cte>)` and never names a legacy
// table.
//
// Detection: a store written by the live sink has the trace_event table. A
// genuine legacy Spec-217 native store does not — those keep the old reader path
// (the compat layer is the bridge for them, not for 726 stores).

/** SQL: one executed instruction per row, projected from trace_event cpu rows.
 *  Columns: run_id, seq, cpu, clock, master_clock, pc, opcode, b1, b2, a, x, y, sp, p. */
export const INSTRUCTIONS_726 = `
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
    CAST(json_extract(data_json, '$.p') AS UTINYINT) AS p
  FROM trace_event
  WHERE channel IN ('cpu', 'drive_pc')`;

/** SQL: one bus/IEC event per row, projected from trace_event bus rows.
 *  Columns: run_id, seq, cpu, clock, master_clock, pc, kind, addr, value,
 *  line_atn, line_clk, line_data. */
export const BUS_EVENTS_726 = `
  SELECT
    run_id,
    seq,
    CASE WHEN json_extract_string(data_json, '$.side') = 'drive' THEN 'drive8' ELSE 'c64' END AS cpu,
    CAST(COALESCE(json_extract(data_json, '$.cycle_drive'),
                  json_extract(data_json, '$.cycle_c64'),
                  cycle) AS UBIGINT) AS clock,
    cycle AS master_clock,
    CAST(json_extract(data_json, '$.pc') AS USMALLINT) AS pc,
    CASE WHEN channel = 'iec' THEN 'line_change'
         ELSE json_extract_string(data_json, '$.op') END AS kind,
    CAST(json_extract(data_json, '$.addr') AS USMALLINT) AS addr,
    CAST(json_extract(data_json, '$.value') AS UTINYINT) AS value,
    CASE WHEN channel = 'iec' THEN CAST(json_extract(data_json, '$.atn') AS BOOLEAN) END AS line_atn,
    CASE WHEN channel = 'iec' THEN CAST(json_extract(data_json, '$.clk') AS BOOLEAN) END AS line_clk,
    CASE WHEN channel = 'iec' THEN CAST(json_extract(data_json, '$.data') AS BOOLEAN) END AS line_data
  FROM trace_event
  WHERE channel IN ('bus_access', 'io', 'iec')`;

/** SQL: named anchors from trace_mark (occurrence per label).
 *  Columns: run_id, name, cpu, pc, occurrence, clock, seq. */
export const ANCHORS_726 = `
  SELECT
    run_id,
    label AS name,
    CAST(NULL AS TEXT) AS cpu,
    CAST(NULL AS USMALLINT) AS pc,
    CAST(row_number() OVER (PARTITION BY label ORDER BY cycle) AS UBIGINT) AS occurrence,
    cycle AS clock,
    cycle AS seq
  FROM trace_mark`;

/** Detect a live-sink (726) store by the presence of the trace_event table. */
export async function isLiveSinkStore(conn: any): Promise<boolean> {
  try {
    const r = await conn.runAndReadAll(
      `SELECT 1 FROM information_schema.tables
         WHERE table_schema='main' AND table_name='trace_event' LIMIT 1`);
    return r.getRows().length > 0;
  } catch { return false; }
}
