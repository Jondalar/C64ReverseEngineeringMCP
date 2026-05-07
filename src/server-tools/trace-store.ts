// Spec 217 Phase 1 — MCP tools for trace-store DuckDB queries.
//
// Read-only access to a trace-store path. Tools share a single
// resolver: paths must point to a `.duckdb` file or a directory that
// contains `trace.duckdb`.

import { resolve as resolvePath } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findAnchor,
  findBusEvents,
  getInfo,
  listAnchors,
  safeQuery,
  topPcs,
} from "../runtime/trace-store/queries.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

function resolveStorePath(input: string, context: ServerToolContext): string {
  const abs = resolvePath(context.projectDir(input, true));
  if (!existsSync(abs)) throw new Error(`trace store path not found: ${abs}`);
  if (statSync(abs).isDirectory()) {
    const candidate = resolvePath(abs, "trace.duckdb");
    if (!existsSync(candidate)) {
      throw new Error(`directory has no trace.duckdb: ${abs}`);
    }
    return candidate;
  }
  return abs;
}

function fmtHex(n: number): string {
  return "$" + (n & 0xffff).toString(16).padStart(4, "0").toUpperCase();
}

export function registerTraceStoreTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "trace_store_info",
    "Summarize a trace-store: meta, table counts, master_clock range. Path may be a .duckdb file or a directory containing trace.duckdb.",
    {
      path: z.string().describe("Path to trace.duckdb or its parent directory."),
    },
    safeHandler("trace_store_info", async ({ path }) => {
      const dbPath = resolveStorePath(path, context);
      const info = await getInfo(dbPath);
      const lines = [`trace_store_info: ${dbPath}`, ``, `meta:`];
      for (const [k, v] of Object.entries(info.meta)) lines.push(`  ${k} = ${v}`);
      lines.push(``, `tables:`);
      for (const [t, n] of Object.entries(info.tableCounts)) lines.push(`  ${t} = ${n}`);
      if (info.masterClockRange) {
        lines.push(``, `master_clock range: ${info.masterClockRange.min} .. ${info.masterClockRange.max}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_anchor_list",
    "List all anchors in a trace store with occurrence counts and clock range.",
    {
      path: z.string().describe("Path to trace.duckdb or its parent directory."),
    },
    safeHandler("trace_store_anchor_list", async ({ path }) => {
      const dbPath = resolveStorePath(path, context);
      const rows = await listAnchors(dbPath);
      const lines = [`anchors (${rows.length}):`, ``];
      lines.push(`name\tcpu\tpc\toccurrences\tfirst_clock\tlast_clock`);
      for (const r of rows) {
        lines.push(`${r.name}\t${r.cpu}\t${fmtHex(r.pc)}\t${r.occurrences}\t${r.firstClock}\t${r.lastClock}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_anchor_find",
    "List occurrences of a single anchor by name. Returns up to `limit` rows.",
    {
      path: z.string().describe("Path to trace.duckdb or its parent directory."),
      name: z.string().describe("Anchor name (alphanumeric/underscore/dash only)."),
      limit: z.number().int().positive().max(10000).optional().describe("Max occurrences to return (default 200)."),
    },
    safeHandler("trace_store_anchor_find", async ({ path, name, limit }) => {
      const dbPath = resolveStorePath(path, context);
      const rows = await findAnchor(dbPath, name, limit ?? 200);
      const lines = [`occurrences of '${name}' (${rows.length}):`, ``];
      lines.push(`occ\tpc\tclock\tseq`);
      for (const r of rows) lines.push(`${r.occurrence}\t${fmtHex(r.pc)}\t${r.clock}\t${r.seq}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_top_pcs",
    "Return the top-N most-frequent PCs for a given CPU side (c64 | drive8).",
    {
      path: z.string().describe("Path to trace.duckdb or its parent directory."),
      cpu: z.enum(["c64", "drive8"]).describe("CPU side."),
      limit: z.number().int().positive().max(200).optional().describe("Max rows (default 20)."),
    },
    safeHandler("trace_store_top_pcs", async ({ path, cpu, limit }) => {
      const dbPath = resolveStorePath(path, context);
      const rows = await topPcs(dbPath, cpu, limit ?? 20);
      const lines = [`top ${rows.length} PCs for cpu=${cpu}:`, ``];
      for (const r of rows) lines.push(`${fmtHex(r.pc)}\t${r.count}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_bus_find",
    "List bus_events at a target address (read+write+RMW).",
    {
      path: z.string().describe("Path to trace.duckdb or its parent directory."),
      addr: z.string().describe("Address as hex (e.g. $DD00, 0xDD00, DD00) or decimal."),
      limit: z.number().int().positive().max(10000).optional().describe("Max rows (default 100)."),
    },
    safeHandler("trace_store_bus_find", async ({ path, addr, limit }) => {
      const dbPath = resolveStorePath(path, context);
      const cleaned = String(addr).trim().replace(/^\$/, "").replace(/^0x/i, "");
      let n: number;
      if (/^[0-9a-fA-F]+$/.test(cleaned) && (cleaned.length > 1 || /[a-fA-F]/.test(cleaned))) {
        n = parseInt(cleaned, 16);
      } else {
        n = Number(addr);
      }
      const rows = await findBusEvents(dbPath, n, limit ?? 100);
      const lines = [`bus_events at ${fmtHex(n)} (${rows.length}):`, ``, `seq\tcpu\tkind\tclock\tpc\tvalue`];
      for (const r of rows) {
        lines.push(`${r.seq}\t${r.cpu}\t${r.kind}\t${r.clock}\t${r.pc !== null ? fmtHex(r.pc) : ""}\t${r.value ?? ""}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_query",
    "Run a read-only SELECT/WITH SQL query against the trace store. Result rows capped at `limit`.",
    {
      path: z.string().describe("Path to trace.duckdb or its parent directory."),
      sql: z.string().describe("Read-only SELECT or WITH query."),
      limit: z.number().int().positive().max(2000).optional().describe("Max rows returned (default 200)."),
    },
    safeHandler("trace_store_query", async ({ path, sql, limit }) => {
      const dbPath = resolveStorePath(path, context);
      const rows = await safeQuery(dbPath, sql, limit ?? 200);
      const lines = [`query (${rows.length} rows):`, ``];
      for (const r of rows) {
        lines.push(r.map((c) => typeof c === "bigint" ? c.toString() : String(c)).join("\t"));
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );
}
