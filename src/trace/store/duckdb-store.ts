// Spec 217 — DuckDB adapter + DuckDbTraceSink.
//
// Loads @duckdb/node-api dynamically so the rest of the MCP server
// does not pay the native-binary cost when not using trace-store.

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  busEventKindFromCode,
  chipEventChipFromCode,
  chipEventKindFromCode,
  decodeBool,
} from "./chunk-buffer.js";
import type {
  BusEventChunk,
  ChipEventChunk,
  InstructionChunk,
  TraceCpu,
  TraceSource,
} from "./chunk-buffer.js";
import type { TraceSink, TraceSinkSummary } from "./trace-sink.js";

export const SCHEMA_VERSION = "2";

// Lightweight "any" shape for the dynamically-loaded duckdb module.
// Keeps trace-store self-contained without forcing a peer dep on the
// rest of the codebase.
type AnyDuckDb = {
  DuckDBInstance: { create(path: string): Promise<unknown> };
};

let duckdbModule: AnyDuckDb | undefined;
async function loadDuckDb(): Promise<AnyDuckDb> {
  if (!duckdbModule) {
    duckdbModule = (await import("@duckdb/node-api")) as unknown as AnyDuckDb;
  }
  return duckdbModule;
}

// Public meta (Spec 217 — required `meta` table fields).
export interface TraceStoreMeta {
  runId: string;
  source: TraceSource;
  capturedAt: string;       // ISO8601
  writerVersion: string;    // git sha (or "dev")
  c64ClockHz: number;
  driveClockHz: number;
  c64ClockZero: bigint | null;
  driveClockZero: bigint | null;
  driveToC64Offset: bigint | null;
}

function bigintOrEmpty(v: bigint | null): string {
  if (v === null) return "";
  return v.toString();
}

export interface OpenStoreOptions {
  path: string;             // .duckdb file path; ":memory:" for tests
  meta: TraceStoreMeta;
}

export interface DuckDbStore {
  conn: any;                // dynamically-typed
  meta: TraceStoreMeta;
  path: string;
  inst: any;
}

export async function openStore(opts: OpenStoreOptions): Promise<DuckDbStore> {
  const duckdb = await loadDuckDb();
  if (opts.path !== ":memory:") {
    await mkdir(dirname(opts.path), { recursive: true });
  }
  const inst = await (duckdb.DuckDBInstance as any).create(opts.path);
  const conn = await (inst as any).connect();
  await applySchema(conn);
  await insertMeta(conn, opts.meta);
  return { conn, meta: opts.meta, path: opts.path, inst };
}

async function applySchema(conn: any): Promise<void> {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS meta (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS instructions (
       run_id        TEXT,
       seq           UBIGINT,
       cpu           TEXT,
       clock         UBIGINT,
       master_clock  UBIGINT,
       pc            USMALLINT,
       opcode        UTINYINT,
       b1            UTINYINT,
       b2            UTINYINT,
       a             UTINYINT,
       x             UTINYINT,
       y             UTINYINT,
       sp            UTINYINT,
       p             UTINYINT,
       source        TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS bus_events (
       run_id        TEXT,
       seq           UBIGINT,
       cpu           TEXT,
       clock         UBIGINT,
       master_clock  UBIGINT,
       pc            USMALLINT,
       kind          TEXT,
       addr          USMALLINT,
       value         UTINYINT,
       old_value     UTINYINT,
       line_atn      BOOLEAN,
       line_clk      BOOLEAN,
       line_data     BOOLEAN,
       source        TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS bus_event_extras (
       run_id      TEXT,
       parent_seq  UBIGINT,
       key         TEXT,
       value       TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS chip_events (
       run_id        TEXT,
       seq           UBIGINT,
       cpu           TEXT,
       clock         UBIGINT,
       master_clock  UBIGINT,
       pc            USMALLINT,
       chip          TEXT,
       kind          TEXT,
       unit          UTINYINT,
       value         UTINYINT,
       old_value     UTINYINT,
       source        TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS chip_event_extras (
       run_id      TEXT,
       parent_seq  UBIGINT,
       key         TEXT,
       value       TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS anchors (
       run_id        TEXT,
       source        TEXT,
       cpu           TEXT,
       name          TEXT,
       pc            USMALLINT,
       occurrence    UBIGINT,
       clock         UBIGINT,
       master_clock  UBIGINT,
       seq           UBIGINT
     )`,
    `CREATE TABLE IF NOT EXISTS rollups (
       run_id          TEXT,
       source          TEXT,
       level           UTINYINT,
       window_index    UBIGINT,
       clock_start     UBIGINT,
       clock_end       UBIGINT,
       cpu             TEXT,
       top_pcs_json    JSON,
       bus_counts_json JSON,
       irq_counts_json JSON,
       phase           TEXT
     )`,
    // Spec 242 — trace bookmarks / annotations
    `CREATE TABLE IF NOT EXISTS trace_bookmarks (
       run_id      TEXT NOT NULL,
       id          TEXT NOT NULL PRIMARY KEY,
       cycle       UBIGINT NOT NULL,
       family      TEXT,
       event_key   TEXT,
       label       TEXT NOT NULL,
       note        TEXT,
       author_tag  TEXT,
       tags        TEXT[],
       bind_mode   TEXT NOT NULL DEFAULT 'both'
     )`,
  ];
  for (const stmt of ddl) {
    await conn.run(stmt);
  }
}

async function insertMeta(conn: any, meta: TraceStoreMeta): Promise<void> {
  const rows: Array<[string, string]> = [
    ["schema_version",      SCHEMA_VERSION],
    ["run_id",              meta.runId],
    ["source",              meta.source],
    ["captured_at",         meta.capturedAt],
    ["writer_version",      meta.writerVersion],
    ["c64_clock_hz",        meta.c64ClockHz.toString()],
    ["drive_clock_hz",      meta.driveClockHz.toString()],
    ["c64_clock_zero",      bigintOrEmpty(meta.c64ClockZero)],
    ["drive_clock_zero",    bigintOrEmpty(meta.driveClockZero)],
    ["drive_to_c64_offset", bigintOrEmpty(meta.driveToC64Offset)],
  ];
  const app = await conn.createAppender("meta");
  for (const [k, v] of rows) {
    app.appendVarchar(k);
    app.appendVarchar(v);
    app.endRow();
  }
  app.flushSync();
  app.closeSync();
}

export async function closeStore(store: DuckDbStore): Promise<void> {
  if (store.inst?.closeSync) store.inst.closeSync();
}

export interface ParquetExportOptions {
  outDir: string;
  compression?: "ZSTD" | "SNAPPY" | "UNCOMPRESSED";
  rowGroupSize?: number;
}

export async function exportParquet(store: DuckDbStore, opts: ParquetExportOptions): Promise<string[]> {
  await mkdir(opts.outDir, { recursive: true });
  const tables = ["instructions", "bus_events", "bus_event_extras", "chip_events", "chip_event_extras", "anchors", "rollups", "meta"];
  const written: string[] = [];
  const compression = opts.compression ?? "ZSTD";
  const rowGroup = opts.rowGroupSize ?? 1_000_000;
  for (const t of tables) {
    const out = `${opts.outDir}/${t}.parquet`;
    const sql = `COPY (SELECT * FROM ${t}) TO '${out}' (FORMAT PARQUET, COMPRESSION ${compression}, ROW_GROUP_SIZE ${rowGroup})`;
    await store.conn.run(sql);
    written.push(out);
  }
  return written;
}

// DuckDbTraceSink — primary sink. Uses Appender per Spec 217 ingestion-path
// preferred ordering. No JSON.stringify, no per-row SQL.

export interface DuckDbTraceSinkOptions {
  store: DuckDbStore;
}

export class DuckDbTraceSink implements TraceSink {
  private instructionsWritten = 0;
  private busEventsWritten = 0;
  private chipEventsWritten = 0;
  private startedAt = Date.now();
  private stallTotalMs = 0;
  private stallEventCount = 0;
  private chunksDropped = 0;

  constructor(private opts: DuckDbTraceSinkOptions) {}

  async writeInstructionChunk(chunk: InstructionChunk): Promise<void> {
    if (chunk.count === 0) return;
    const app = await this.opts.store.conn.createAppender("instructions");
    const cpuStr = chunk.cpu;
    const sourceStr = chunk.source;
    const runId = this.opts.store.meta.runId;
    const n = chunk.count;
    for (let i = 0; i < n; i++) {
      app.appendVarchar(runId);
      app.appendUBigInt(chunk.seq[i]);
      app.appendVarchar(cpuStr);
      app.appendUBigInt(chunk.clock[i]);
      if (chunk.masterClockNull[i]) app.appendNull(); else app.appendUBigInt(chunk.masterClock[i]);
      app.appendUSmallInt(chunk.pc[i]);
      app.appendUTinyInt(chunk.opcode[i]);
      if (chunk.b1Null[i]) app.appendNull(); else app.appendUTinyInt(chunk.b1[i]);
      if (chunk.b2Null[i]) app.appendNull(); else app.appendUTinyInt(chunk.b2[i]);
      app.appendUTinyInt(chunk.a[i]);
      app.appendUTinyInt(chunk.x[i]);
      app.appendUTinyInt(chunk.y[i]);
      app.appendUTinyInt(chunk.sp[i]);
      app.appendUTinyInt(chunk.p[i]);
      app.appendVarchar(sourceStr);
      app.endRow();
    }
    app.flushSync();
    app.closeSync();
    this.instructionsWritten += n;
  }

  async writeBusEventChunk(chunk: BusEventChunk): Promise<void> {
    if (chunk.count === 0) return;
    const app = await this.opts.store.conn.createAppender("bus_events");
    const cpuStr = chunk.cpu;
    const sourceStr = chunk.source;
    const runId = this.opts.store.meta.runId;
    const n = chunk.count;
    for (let i = 0; i < n; i++) {
      app.appendVarchar(runId);
      app.appendUBigInt(chunk.seq[i]);
      app.appendVarchar(cpuStr);
      app.appendUBigInt(chunk.clock[i]);
      if (chunk.masterClockNull[i]) app.appendNull(); else app.appendUBigInt(chunk.masterClock[i]);
      if (chunk.pcNull[i]) app.appendNull(); else app.appendUSmallInt(chunk.pc[i]);
      app.appendVarchar(busEventKindFromCode(chunk.kindCode[i]));
      if (chunk.addrNull[i]) app.appendNull(); else app.appendUSmallInt(chunk.addr[i]);
      if (chunk.valueNull[i]) app.appendNull(); else app.appendUTinyInt(chunk.value[i]);
      if (chunk.oldValueNull[i]) app.appendNull(); else app.appendUTinyInt(chunk.oldValue[i]);
      const atn = decodeBool(chunk.lineAtn[i]);
      const clk = decodeBool(chunk.lineClk[i]);
      const dat = decodeBool(chunk.lineData[i]);
      if (atn === null) app.appendNull(); else app.appendBoolean(atn);
      if (clk === null) app.appendNull(); else app.appendBoolean(clk);
      if (dat === null) app.appendNull(); else app.appendBoolean(dat);
      app.appendVarchar(sourceStr);
      app.endRow();
    }
    app.flushSync();
    app.closeSync();
    this.busEventsWritten += n;
  }

  async writeChipEventChunk(chunk: ChipEventChunk): Promise<void> {
    if (chunk.count === 0) return;
    const app = await this.opts.store.conn.createAppender("chip_events");
    const cpuStr = chunk.cpu;
    const sourceStr = chunk.source;
    const runId = this.opts.store.meta.runId;
    const n = chunk.count;
    for (let i = 0; i < n; i++) {
      app.appendVarchar(runId);
      app.appendUBigInt(chunk.seq[i]);
      app.appendVarchar(cpuStr);
      app.appendUBigInt(chunk.clock[i]);
      if (chunk.masterClockNull[i]) app.appendNull(); else app.appendUBigInt(chunk.masterClock[i]);
      if (chunk.pcNull[i]) app.appendNull(); else app.appendUSmallInt(chunk.pc[i]);
      app.appendVarchar(chipEventChipFromCode(chunk.chipCode[i]));
      app.appendVarchar(chipEventKindFromCode(chunk.kindCode[i]));
      app.appendUTinyInt(chunk.unit[i]);
      if (chunk.valueNull[i]) app.appendNull(); else app.appendUTinyInt(chunk.value[i]);
      if (chunk.oldValueNull[i]) app.appendNull(); else app.appendUTinyInt(chunk.oldValue[i]);
      app.appendVarchar(sourceStr);
      app.endRow();
    }
    app.flushSync();
    app.closeSync();
    this.chipEventsWritten += n;
  }

  async close(): Promise<TraceSinkSummary> {
    return {
      instructionsWritten: this.instructionsWritten,
      busEventsWritten: this.busEventsWritten,
      chipEventsWritten: this.chipEventsWritten,
      durationMs: Date.now() - this.startedAt,
      stallTotalMs: this.stallTotalMs,
      stallEventCount: this.stallEventCount,
      chunksDropped: this.chunksDropped,
    };
  }
}
