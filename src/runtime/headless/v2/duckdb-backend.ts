// Spec 232 — DuckDB-backed implementation of QueryEventsBackend.
//
// Wraps an existing duckdb connection (from src/runtime/trace-store).
// Inlines parameters safely (int / float / string with escape).

import type { QueryEventsBackend } from "./query-events.js";

interface DuckConn {
  runAndReadAll(sql: string): Promise<{ getRowObjects(): any[]; getRows(): unknown[][] }>;
}

export class DuckDbQueryBackend implements QueryEventsBackend {
  constructor(private readonly conn: DuckConn) {}

  private liveSink?: boolean;
  async isLiveSink(): Promise<boolean> {
    if (this.liveSink === undefined) {
      try {
        const r = await this.conn.runAndReadAll(
          `SELECT 1 FROM information_schema.tables
             WHERE table_schema='main' AND table_name='trace_event' LIMIT 1`);
        this.liveSink = r.getRows().length > 0;
      } catch { this.liveSink = false; }
    }
    return this.liveSink;
  }

  async exec(sql: string, params: unknown[]): Promise<any[]> {
    // Inline parameters. SQL has '?' placeholders.
    let i = 0;
    const filled = sql.replace(/\?/g, () => {
      const p = params[i++];
      return inlineParam(p);
    });
    if (i !== params.length) {
      throw new Error(`param count mismatch: sql has ${i} placeholders, ${params.length} params`);
    }
    const r = await this.conn.runAndReadAll(filled);
    return r.getRowObjects();
  }
}

function inlineParam(p: unknown): string {
  if (p === null || p === undefined) return "NULL";
  if (typeof p === "number") {
    if (!Number.isFinite(p)) throw new Error(`non-finite param: ${p}`);
    return String(p);
  }
  if (typeof p === "bigint") return p.toString();
  if (typeof p === "boolean") return p ? "TRUE" : "FALSE";
  if (typeof p === "string") return `'${p.replace(/'/g, "''")}'`;
  throw new Error(`unsupported param type: ${typeof p}`);
}
