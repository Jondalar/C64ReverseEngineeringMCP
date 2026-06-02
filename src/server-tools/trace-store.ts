// Spec 217 Phase 1 — MCP tools for trace-store DuckDB queries.
//
// Read-only access to a trace-store path. Tools share a single
// resolver: paths must point to a `.duckdb` file or a directory that
// contains `trace.duckdb`.

import { resolve as resolvePath, isAbsolute } from "node:path";
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

// Bug-fix (post-Spec 726): `input` is a PATH to a trace.duckdb (or a directory
// holding one), NOT a project hint. The previous implementation passed `input`
// as `hintPath` to `context.projectDir()`, which used it only to pick a project
// root and then discarded it — every non-root path failed with "directory has
// no trace.duckdb". Resolve the input itself: absolute as-is, relative under
// the project dir.
// Spec 746.x — ONE read path. In daemon mode the store is read INSIDE the daemon
// process (the runtime owns the store; clients ask, they don't open it themselves),
// which also picks up the daemon-side awaitIndex so a read right after stop() sees
// the fresh, atomically-published index. Out of daemon mode (tests/standalone) the
// index worker lives in this process, so the local queries.ts call is correct.
async function routeStoreRead<T>(fn: string, dbPath: string, args: Record<string, unknown>, localFn: () => Promise<T>): Promise<T> {
  const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
  if (isDaemonMode()) return runtimeDaemon.traceRead<T>("store_fn", dbPath, { fn, args });
  return localFn();
}

export function resolveStorePath(input: string, context: ServerToolContext): string {
  const proj = (() => { try { return context.projectDir(undefined, false); } catch { return undefined; } })();
  const abs = isAbsolute(input) ? resolvePath(input) : resolvePath(proj ?? process.cwd(), input);
  if (!existsSync(abs)) {
    // Spec 746.x — a MISSING .duckdb is acceptable when its .c64retrace authority
    // exists: the reader path (ensureIndex) rebuilds the index from it lazily
    // (recovers an orphaned store, e.g. a multi-GB trace whose index never built).
    // Pass the path through so the rebuild can run instead of being blocked here.
    const retrace = abs.endsWith(".duckdb") ? abs.slice(0, -".duckdb".length) + ".c64retrace" : abs + ".c64retrace";
    if (existsSync(retrace)) return abs;
    throw new Error(`trace store path not found: ${abs}`);
  }
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
    "Report the DuckDB trace-store status — runs, event counts, schema. Use to see what trace evidence exists. Not for querying events (use trace_store_query). Inputs: optional run id. Returns: store summary.",
    {
      path: z.string().describe("Path to trace.duckdb or its parent directory."),
    },
    safeHandler("trace_store_info", async ({ path }) => {
      const dbPath = resolveStorePath(path, context);
      const info = await routeStoreRead("getInfo", dbPath, {}, () => getInfo(dbPath));
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
    "List named trace anchors (saved cycle/PC markers) for a run. Use to see bookmarked points in a trace. Not for finding the nearest one (use trace_store_anchor_find). Inputs: run id. Returns: anchors.",
    {
      path: z.string().describe("Path to trace.duckdb or its parent directory."),
    },
    safeHandler("trace_store_anchor_list", async ({ path }) => {
      const dbPath = resolveStorePath(path, context);
      const rows = await routeStoreRead("listAnchors", dbPath, {}, () => listAnchors(dbPath));
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
    "Find the trace anchor nearest a cycle/PC. Use to jump to a bookmarked point. Not for listing all (use trace_store_anchor_list). Inputs: run id, cycle/PC. Returns: nearest anchor.",
    {
      path: z.string().describe("Path to trace.duckdb or its parent directory."),
      name: z.string().describe("Anchor name (alphanumeric/underscore/dash only)."),
      limit: z.number().int().positive().max(10000).optional().describe("Max occurrences to return (default 200)."),
    },
    safeHandler("trace_store_anchor_find", async ({ path, name, limit }) => {
      const dbPath = resolveStorePath(path, context);
      const rows = await routeStoreRead("findAnchor", dbPath, { name, limit: limit ?? 200 }, () => findAnchor(dbPath, name, limit ?? 200));
      const lines = [`occurrences of '${name}' (${rows.length}):`, ``];
      lines.push(`occ\tpc\tclock\tseq`);
      for (const r of rows) lines.push(`${r.occurrence}\t${fmtHex(r.pc)}\t${r.clock}\t${r.seq}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_top_pcs",
    "Return the most-executed PCs in a trace run (hot spots). Use to find where time goes. Not for a specific PC's events (use trace_store_query). Inputs: run id, limit. Returns: ranked PCs.",
    {
      path: z.string().describe("Path to trace.duckdb or its parent directory."),
      cpu: z.enum(["c64", "drive8"]).describe("CPU side."),
      limit: z.number().int().positive().max(200).optional().describe("Max rows (default 20)."),
    },
    safeHandler("trace_store_top_pcs", async ({ path, cpu, limit }) => {
      const dbPath = resolveStorePath(path, context);
      const rows = await routeStoreRead("topPcs", dbPath, { cpu, limit: limit ?? 20 }, () => topPcs(dbPath, cpu, limit ?? 20));
      const lines = [`top ${rows.length} PCs for cpu=${cpu}:`, ``];
      for (const r of rows) lines.push(`${fmtHex(r.pc)}\t${r.count}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_bus_find",
    "Find IEC/bus events in the trace store ($DD00 / CIA2 / VIA reads+writes). Use to debug loader/bus protocols from durable evidence. Not for CPU PCs (use trace_store_top_pcs). Inputs: run id, lane/value filters. Returns: bus events.",
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
      const rows = await routeStoreRead("findBusEvents", dbPath, { addr: n, limit: limit ?? 100 }, () => findBusEvents(dbPath, n, limit ?? 100));
      const lines = [`bus_events at ${fmtHex(n)} (${rows.length}):`, ``, `seq\tcpu\tkind\tclock\tpc\tvalue`];
      for (const r of rows) {
        lines.push(`${r.seq}\t${r.cpu}\t${r.kind}\t${r.clock}\t${r.pc !== null ? fmtHex(r.pc) : ""}\t${r.value ?? ""}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "trace_store_query",
    "Run a structured query over the DuckDB trace store (by PC, address, event family, cycle range). Use for durable trace evidence. Not for live state (use runtime_monitor_*). Inputs: query filters. Returns: matching rows.",
    {
      path: z.string().describe("Path to trace.duckdb or its parent directory."),
      sql: z.string().describe("Read-only SELECT or WITH query."),
      limit: z.number().int().positive().max(2000).optional().describe("Max rows returned (default 200)."),
    },
    safeHandler("trace_store_query", async ({ path, sql, limit }) => {
      const dbPath = resolveStorePath(path, context);
      const rows = await routeStoreRead("safeQuery", dbPath, { sql, limit: limit ?? 200 }, () => safeQuery(dbPath, sql, limit ?? 200));
      const lines = [`query (${rows.length} rows):`, ``];
      for (const r of rows) {
        lines.push(r.map((c) => typeof c === "bigint" ? c.toString() : String(c)).join("\t"));
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );
}
