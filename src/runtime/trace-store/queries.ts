// Spec 217 Phase 1 — read-only query helpers against a trace-store
// DuckDB file. Used by both the trace-store-query CLI and the
// trace_store_* MCP tools. Loads @duckdb/node-api dynamically.

import { existsSync } from "node:fs";
import { INSTRUCTIONS_726, BUS_EVENTS_726, ANCHORS_726, isLiveSinkStore } from "./schema726.js";
import { getInfoLegacy217, LEGACY_INSTRUCTIONS, LEGACY_BUS_EVENTS, LEGACY_ANCHORS } from "./queries-legacy217.js";

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

async function withConn<T>(dbPath: string, fn: (conn: any, isLiveSink: boolean) => Promise<T>): Promise<T> {
  if (!existsSync(dbPath)) throw new Error(`trace store not found: ${dbPath}`);
  const duckdb = await loadDuckDb();
  // BUG-029 — open READ_ONLY first: a read-write handle takes a cross-process file
  // lock, so a reader process cannot open a store another process (the daemon) is
  // touching → "Could not set lock". A read-only open needs no exclusive lock. A
  // 726 live-sink store already has the reader schema, so no compat CREATE VIEW is
  // needed (read-only can't write). Fall back to read-write + compat ONLY for a
  // legacy Spec-217 native store that needs the bridge views built.
  try {
    const inst = await (duckdb.DuckDBInstance as any).create(dbPath, { access_mode: "READ_ONLY" });
    try {
      const conn = await (inst as any).connect();
      const liveSink = await isLiveSinkStore(conn);
      if (liveSink) return await fn(conn, liveSink);
      // legacy store opened read-only but needs compat views → re-open read-write.
      throw Object.assign(new Error("legacy-store-needs-compat"), { __legacy: true });
    } finally {
      (inst as any).closeSync?.();
    }
  } catch (e: any) {
    if (!e?.__legacy) {
      // read-only failed for a real reason (e.g. legacy store can't even open RO);
      // fall through to the read-write path below.
    }
  }
  const inst = await (duckdb.DuckDBInstance as any).create(dbPath);
  try {
    const conn = await (inst as any).connect();
    const liveSink = await isLiveSinkStore(conn);
    if (!liveSink) {
      const { ensureSpec726CompatLayer } = await import("../headless/trace/trace-run-store.js");
      await ensureSpec726CompatLayer(conn);
    }
    return await fn(conn, liveSink);
  } finally {
    (inst as any).closeSync?.();
  }
}

export interface TraceStoreInfo {
  meta: Record<string, string>;
  tableCounts: Record<string, bigint>;
  masterClockRange?: { min: bigint; max: bigint };
}

export async function getInfo(dbPath: string): Promise<TraceStoreInfo> {
  return withConn(dbPath, async (conn, isLiveSink) => {
    if (isLiveSink) return getInfo726(conn);
    return getInfoLegacy217(conn);
  });
}

/** 726 store: read run identity from trace_run + counts from trace_event /
 *  trace_mark directly. No meta/instructions table is named. */
async function getInfo726(conn: any): Promise<TraceStoreInfo> {
  const meta: Record<string, string> = { schema: "trace_run/trace_event/trace_mark", source: "live-sink-726" };
  const runRows = await conn.runAndReadAll(
    `SELECT run_id, def_id, def_version, retention, created_at FROM trace_run LIMIT 1`);
  const rr = runRows.getRows()[0];
  if (rr) {
    if (rr[0] != null) meta.run_id = String(rr[0]);
    if (rr[1] != null) meta.def_id = String(rr[1]);
    if (rr[2] != null) meta.def_version = String(rr[2]);
    if (rr[3] != null) meta.retention = String(rr[3]);
    if (rr[4] != null) meta.created_at = String(rr[4]);
  }

  // Per-channel event counts + mark count — the durable shape, named by channel.
  const counts = await conn.runAndReadAll(`
    SELECT 'events:' || channel AS k, count(*) AS n FROM trace_event GROUP BY channel
    UNION ALL SELECT 'events:total', count(*) FROM trace_event
    UNION ALL SELECT 'marks', count(*) FROM trace_mark
  `);
  const tableCounts: Record<string, bigint> = {};
  for (const [t, n] of counts.getRows()) {
    tableCounts[String(t)] = typeof n === "bigint" ? n : BigInt(n);
  }

  const range = await conn.runAndReadAll(
    `SELECT MIN(cycle), MAX(cycle) FROM trace_event WHERE cycle IS NOT NULL`);
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

export interface AnchorRow {
  name: string;
  cpu: string;
  pc: number;
  occurrences: number;
  firstClock: bigint | null;
  lastClock: bigint | null;
}

export async function listAnchors(dbPath: string): Promise<AnchorRow[]> {
  return withConn(dbPath, async (conn, isLiveSink) => {
    const from = isLiveSink ? `(${ANCHORS_726})` : LEGACY_ANCHORS;
    const rows = await conn.runAndReadAll(`
      SELECT name, cpu, pc, count(*) AS n, MIN(clock), MAX(clock)
      FROM ${from}
      GROUP BY name, cpu, pc
      ORDER BY n DESC
    `);
    return rows.getRows().map((r: unknown[]) => ({
      name: String(r[0]),
      cpu: String(r[1]),
      pc: Number(r[2]),
      occurrences: Number(r[3]),
      firstClock: r[4] === null ? null : (typeof r[4] === "bigint" ? r[4] : BigInt(r[4] as number)),
      lastClock: r[5] === null ? null : (typeof r[5] === "bigint" ? r[5] : BigInt(r[5] as number)),
    }));
  });
}

export interface AnchorOccurrence {
  occurrence: number;
  pc: number;
  clock: bigint;
  seq: bigint;
}

export async function findAnchor(
  dbPath: string,
  name: string,
  limit = 200,
): Promise<AnchorOccurrence[]> {
  // sanitize name (alphanumeric + underscore + dash only)
  if (!/^[a-zA-Z0-9_\-]+$/.test(name)) throw new Error(`invalid anchor name: ${name}`);
  return withConn(dbPath, async (conn, isLiveSink) => {
    const from = isLiveSink ? `(${ANCHORS_726})` : LEGACY_ANCHORS;
    const rows = await conn.runAndReadAll(`
      SELECT occurrence, pc, clock, seq
      FROM ${from}
      WHERE name = '${name}'
      ORDER BY occurrence
      LIMIT ${Math.max(1, Math.min(10000, limit))}
    `);
    return rows.getRows().map((r: unknown[]) => ({
      occurrence: Number(r[0]),
      pc: Number(r[1]),
      clock: typeof r[2] === "bigint" ? r[2] : BigInt(r[2] as number),
      seq: typeof r[3] === "bigint" ? r[3] : BigInt(r[3] as number),
    }));
  });
}

export interface PcCount { pc: number; count: number }

export async function topPcs(
  dbPath: string,
  cpu: "c64" | "drive8",
  limit = 20,
): Promise<PcCount[]> {
  return withConn(dbPath, async (conn, isLiveSink) => {
    const from = isLiveSink ? `(${INSTRUCTIONS_726})` : LEGACY_INSTRUCTIONS;
    const rows = await conn.runAndReadAll(`
      SELECT pc, count(*) AS n
      FROM ${from}
      WHERE cpu = '${cpu}'
      GROUP BY pc
      ORDER BY n DESC
      LIMIT ${Math.max(1, Math.min(200, limit))}
    `);
    return rows.getRows().map((r: unknown[]) => ({ pc: Number(r[0]), count: Number(r[1]) }));
  });
}

export async function findBusEvents(
  dbPath: string,
  addr: number,
  limit = 100,
): Promise<Array<{ seq: bigint; cpu: string; kind: string; clock: bigint; pc: number | null; value: number | null }>> {
  return withConn(dbPath, async (conn, isLiveSink) => {
    const from = isLiveSink ? `(${BUS_EVENTS_726})` : LEGACY_BUS_EVENTS;
    const rows = await conn.runAndReadAll(`
      SELECT seq, cpu, kind, clock, pc, value
      FROM ${from}
      WHERE addr = ${addr & 0xffff}
      ORDER BY seq
      LIMIT ${Math.max(1, Math.min(10000, limit))}
    `);
    return rows.getRows().map((r: unknown[]) => ({
      seq: typeof r[0] === "bigint" ? r[0] : BigInt(r[0] as number),
      cpu: String(r[1]),
      kind: String(r[2]),
      clock: typeof r[3] === "bigint" ? r[3] : BigInt(r[3] as number),
      pc: r[4] === null ? null : Number(r[4]),
      value: r[5] === null ? null : Number(r[5]),
    }));
  });
}

export async function safeQuery(
  dbPath: string,
  sql: string,
  rowLimit = 200,
): Promise<unknown[][]> {
  const lc = sql.toLowerCase().trim();
  if (!lc.startsWith("select") && !lc.startsWith("with")) {
    throw new Error("only SELECT/WITH queries are allowed");
  }
  return withConn(dbPath, async (conn) => {
    const rows = await conn.runAndReadAll(sql);
    const all = rows.getRows();
    return all.slice(0, rowLimit);
  });
}
