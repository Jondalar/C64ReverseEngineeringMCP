// Spec 217 Phase 1 — read-only query helpers against a trace-store
// DuckDB file. Used by both the trace-store-query CLI and the
// trace_store_* MCP tools. Loads @duckdb/node-api dynamically.

import { existsSync } from "node:fs";

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

async function withConn<T>(dbPath: string, fn: (conn: any) => Promise<T>): Promise<T> {
  if (!existsSync(dbPath)) throw new Error(`trace store not found: ${dbPath}`);
  const duckdb = await loadDuckDb();
  const inst = await (duckdb.DuckDBInstance as any).create(dbPath);
  try {
    const conn = await (inst as any).connect();
    // Self-heal: install the Spec 726 compat layer (meta + instructions / bus_events /
    // chip_events / anchors / rollups views over trace_event/trace_mark) if this
    // file is a 726 streaming store written before the views existed. No-op on
    // native Spec 217 stores.
    const { ensureSpec726CompatLayer } = await import("../headless/trace/trace-run-store.js");
    await ensureSpec726CompatLayer(conn);
    return await fn(conn);
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
  return withConn(dbPath, async (conn) => {
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
      `SELECT MIN(master_clock), MAX(master_clock) FROM instructions WHERE master_clock IS NOT NULL`,
    );
    const r = range.getRows();
    let masterClockRange: { min: bigint; max: bigint } | undefined;
    if (r[0]?.[0] !== null && r[0]?.[0] !== undefined) {
      masterClockRange = {
        min: typeof r[0][0] === "bigint" ? r[0][0] : BigInt(r[0][0]),
        max: typeof r[0][1] === "bigint" ? r[0][1] : BigInt(r[0][1]),
      };
    }

    return { meta, tableCounts, masterClockRange };
  });
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
  return withConn(dbPath, async (conn) => {
    const rows = await conn.runAndReadAll(`
      SELECT name, cpu, pc, count(*) AS n, MIN(clock), MAX(clock)
      FROM anchors
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
  return withConn(dbPath, async (conn) => {
    const rows = await conn.runAndReadAll(`
      SELECT occurrence, pc, clock, seq
      FROM anchors
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
  return withConn(dbPath, async (conn) => {
    const rows = await conn.runAndReadAll(`
      SELECT pc, count(*) AS n
      FROM instructions
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
  return withConn(dbPath, async (conn) => {
    const rows = await conn.runAndReadAll(`
      SELECT seq, cpu, kind, clock, pc, value
      FROM bus_events
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
