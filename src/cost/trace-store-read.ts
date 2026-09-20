// Spec 861 D3 — reading the two streams the evaluation needs, through the one
// trace-read door (Spec 802: the store is read INSIDE the runtime, which owns
// the format; C64RE never opens a `.duckdb` itself).
//
// Both streams are pulled in `seq` order and in pages, because the evaluation is
// per instruction and a frame of C64 time is about twenty thousand of them. The
// cap is explicit and the report says when it was reached — a window silently
// cut in half would make every total below it wrong.

import { traceStoreFn } from "../server-tools/trace-read.js";
import { parseAnchorLabel, type Anchor, type InsnRow, type MemRow } from "./trace-cost.js";

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));

type Row = unknown[];

async function page(storePath: string, sql: string, limit: number): Promise<Row[]> {
  return traceStoreFn<Row[]>("safeQuery", storePath, { sql, limit });
}

export interface WindowOptions {
  cpu?: string;
  /** clock window, inclusive */
  from?: number;
  to?: number;
  /** hard cap on rows pulled per stream */
  max?: number;
  pageSize?: number;
}

function clockClause(options: WindowOptions): string {
  const parts: string[] = [`cpu = '${(options.cpu ?? "c64").replace(/'/gu, "")}'`];
  if (options.from !== undefined) parts.push(`clock >= ${Math.floor(options.from)}`);
  if (options.to !== undefined) parts.push(`clock <= ${Math.ceil(options.to)}`);
  return parts.join(" AND ");
}

export async function readInstructionRows(storePath: string, options: WindowOptions = {}): Promise<{ rows: InsnRow[]; capped: boolean }> {
  const max = options.max ?? 400_000;
  const pageSize = Math.min(options.pageSize ?? 50_000, max);
  const rows: InsnRow[] = [];
  for (let offset = 0; rows.length < max; offset += pageSize) {
    const sql =
      `SELECT seq, clock, pc, opcode, b1, b2, a, x, y, sp, p FROM instructions ` +
      `WHERE ${clockClause(options)} ORDER BY seq LIMIT ${pageSize} OFFSET ${offset}`;
    const got = await page(storePath, sql, pageSize);
    for (const r of got) {
      rows.push({
        seq: num(r[0]), clock: num(r[1]), pc: num(r[2]), opcode: num(r[3]),
        b1: num(r[4]), b2: num(r[5]), a: num(r[6]), x: num(r[7]), y: num(r[8]), sp: num(r[9]), p: num(r[10]),
      });
    }
    if (got.length < pageSize) return { rows, capped: false };
  }
  return { rows, capped: true };
}

export async function readMemRows(storePath: string, options: WindowOptions = {}): Promise<{ rows: MemRow[]; capped: boolean }> {
  const max = options.max ?? 1_200_000;
  const pageSize = Math.min(options.pageSize ?? 50_000, max);
  const rows: MemRow[] = [];
  for (let offset = 0; rows.length < max; offset += pageSize) {
    const sql =
      `SELECT seq, clock, pc, kind, addr, value FROM bus_events ` +
      `WHERE ${clockClause(options)} AND kind IN ('read','write') ORDER BY seq LIMIT ${pageSize} OFFSET ${offset}`;
    const got = await page(storePath, sql, pageSize);
    for (const r of got) {
      rows.push({
        seq: num(r[0]), clock: num(r[1]), pc: r[2] === null ? null : num(r[2]),
        kind: String(r[3]), addr: num(r[4]), value: r[5] === null ? null : num(r[5]),
      });
    }
    if (got.length < pageSize) return { rows, capped: false };
  }
  return { rows, capped: true };
}

/** The frame boundary the capture marked (§4.5), read back out of the store. */
export async function readAnchor(storePath: string): Promise<Anchor | null> {
  const rows = await page(storePath, `SELECT label, cycle FROM trace_mark ORDER BY cycle LIMIT 50`, 50);
  for (const r of rows) {
    const anchor = parseAnchorLabel(String(r[0]), num(r[1]));
    if (anchor) return anchor;
  }
  return null;
}

/** The store's own summary, for the header line. */
export async function storeInfo(storePath: string): Promise<{ meta: Record<string, string>; tableCounts: Record<string, number | string> }> {
  return traceStoreFn("getInfo", storePath);
}
