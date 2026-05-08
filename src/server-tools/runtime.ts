// Spec 238 — V2 MCP tool layer.
//
// Wraps AgentQueryApi (Spec 237) into agent-shaped MCP tools.
// Tools accept session_id + scenario context, return structured
// JSON suitable for save_finding / save_open_question pipeline.
//
// Headless-over-VICE framing (2026-05-09): every tool description
// recommends headless as the default. VICE consult only via
// `runtime_compare_with_vice` and only when scenario absent from
// baseline corpus.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

async function getApi(sessionId: string) {
  const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
  const session = getIntegratedSession(sessionId);
  if (!session) throw new Error(`No integrated session ${sessionId}`);
  const { createAgentQueryApi } = await import("../runtime/headless/v2/agent-api.js");
  return createAgentQueryApi({ session });
}

export function registerRuntimeTools(server: McpServer, _context: ServerToolContext): void {
  // ---- Monitor (Spec 248) ----
  server.tool(
    "runtime_monitor_registers",
    "Spec 248 — read CPU registers (c64 or drive). Headless-first: prefer this over `vice_monitor_registers`.",
    {
      session_id: z.string(),
      memspace: z.enum(["c64", "drive"]).optional(),
    },
    safeHandler("runtime_monitor_registers", async ({ session_id, memspace }) => {
      const api = await getApi(session_id);
      const r = api.monitorRegisters(memspace ?? "c64");
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_monitor_memory",
    "Spec 248 — read raw memory range (c64 or drive). Headless-first.",
    {
      session_id: z.string(),
      start: z.number(),
      end: z.number(),
    },
    safeHandler("runtime_monitor_memory", async ({ session_id, start, end }) => {
      const api = await getApi(session_id);
      const bytes = api.monitorMemory(start, end);
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(" ");
      return { content: [{ type: "text", text: `${bytes.length} bytes from $${start.toString(16)}-$${end.toString(16)}:\n${hex}` }] };
    }),
  );

  server.tool(
    "runtime_monitor_disasm",
    "Spec 248 — disassemble N instructions starting at addr. Use indirect-target resolution from trace when available.",
    {
      session_id: z.string(),
      addr: z.number(),
      count: z.number().default(10),
    },
    safeHandler("runtime_monitor_disasm", async ({ session_id, addr, count }) => {
      const api = await getApi(session_id);
      const lines = api.monitorDisasm(addr, count);
      return { content: [{ type: "text", text: lines.map(l => l.text).join("\n") }] };
    }),
  );

  server.tool(
    "runtime_step_into",
    "Spec 248 — single-step one instruction.",
    { session_id: z.string() },
    safeHandler("runtime_step_into", async ({ session_id }) => {
      const api = await getApi(session_id);
      api.stepInto();
      const r = api.monitorRegisters("c64");
      return { content: [{ type: "text", text: `stepped to PC=$${r.pc.toString(16)}` }] };
    }),
  );

  server.tool(
    "runtime_step_over",
    "Spec 248 — defensive step-over with stack-watch + cycle budget. Reports if sub-routine modified flow.",
    {
      session_id: z.string(),
      budget: z.number().optional(),
    },
    safeHandler("runtime_step_over", async ({ session_id, budget }) => {
      const api = await getApi(session_id);
      const r = api.stepOver(budget !== undefined ? { budget } : undefined);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_until",
    "Spec 248 — run until PC reaches target addr or budget exhausted.",
    {
      session_id: z.string(),
      addr: z.number(),
      budget: z.number().optional(),
    },
    safeHandler("runtime_until", async ({ session_id, addr, budget }) => {
      const api = await getApi(session_id);
      const r = api.until(addr, budget !== undefined ? { budget } : undefined);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  // ---- Breakpoints (Spec 241) ----
  server.tool(
    "runtime_breakpoint_add",
    "Spec 241 — add PC breakpoint with VICE-style action (halt/log/snapshot/trace_burst).",
    {
      session_id: z.string(),
      id: z.string(),
      pc: z.number(),
      action: z.enum(["halt", "log", "snapshot", "trace_burst"]).default("halt"),
    },
    safeHandler("runtime_breakpoint_add", async ({ session_id, id, pc, action }) => {
      const api = await getApi(session_id);
      api.addPcBreakpoint(id, pc, action);
      return { content: [{ type: "text", text: `breakpoint ${id} added at PC=$${pc.toString(16)} action=${action}` }] };
    }),
  );

  server.tool(
    "runtime_breakpoint_list",
    "Spec 241 — list all registered breakpoints.",
    { session_id: z.string() },
    safeHandler("runtime_breakpoint_list", async ({ session_id }) => {
      const api = await getApi(session_id);
      const list = api.listBreakpoints();
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_breakpoint_remove",
    "Spec 241 — remove breakpoint by id.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_breakpoint_remove", async ({ session_id, id }) => {
      const api = await getApi(session_id);
      const ok = api.removeBreakpoint(id);
      return { content: [{ type: "text", text: ok ? `removed ${id}` : `${id} not found` }] };
    }),
  );

  // ---- Snapshot diff (Spec 246) ----
  server.tool(
    "runtime_save_vsf",
    "Spec 251 — save full session state as VICE Snapshot Format bytes.",
    {
      session_id: z.string(),
      output_path: z.string(),
    },
    safeHandler("runtime_save_vsf", async ({ session_id, output_path }) => {
      const api = await getApi(session_id);
      const bytes = api.saveVsf();
      const { writeFileSync } = await import("node:fs");
      writeFileSync(output_path, bytes);
      return { content: [{ type: "text", text: `saved ${bytes.length} bytes to ${output_path}` }] };
    }),
  );

  server.tool(
    "runtime_load_vsf",
    "Spec 251 — restore full session state from VSF file.",
    {
      session_id: z.string(),
      input_path: z.string(),
    },
    safeHandler("runtime_load_vsf", async ({ session_id, input_path }) => {
      const api = await getApi(session_id);
      const { readFileSync } = await import("node:fs");
      const bytes = new Uint8Array(readFileSync(input_path));
      api.loadVsf(bytes);
      return { content: [{ type: "text", text: `loaded ${bytes.length} bytes from ${input_path}` }] };
    }),
  );

  // ---- Resolve PC (Spec 235) ----
  server.tool(
    "runtime_resolve_pc",
    "Spec 235 — resolve PC to project label/routine/segment/source-line. Layered lookup.",
    {
      session_id: z.string(),
      artifact_id: z.string(),
      pc: z.number(),
    },
    safeHandler("runtime_resolve_pc", async ({ session_id, artifact_id, pc }) => {
      const api = await getApi(session_id);
      const r = api.resolvePc(artifact_id, pc);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  // ---- Status ----
  server.tool(
    "runtime_status",
    "Spec 237 — AgentQueryApi facade introspection. Reports what V2 surface is available + session cycle counts.",
    { session_id: z.string() },
    safeHandler("runtime_status", async ({ session_id }) => {
      const api = await getApi(session_id);
      const s = api.status();
      return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
    }),
  );

  // ---- Snapshot diff between two VSF files ----
  server.tool(
    "runtime_diff_snapshots",
    "Spec 246 — semantic diff between two VSF snapshot files. Returns RAM changedRanges + CPU/CIA/VIC/SID/PLA chip diffs.",
    {
      a_path: z.string(),
      b_path: z.string(),
      enrich: z.boolean().default(false),
    },
    safeHandler("runtime_diff_snapshots", async ({ a_path, b_path, enrich }) => {
      const { readFileSync } = await import("node:fs");
      const { diffSnapshots, formatDiff } = await import("../runtime/headless/v2/snapshot-diff.js");
      const a = new Uint8Array(readFileSync(a_path));
      const b = new Uint8Array(readFileSync(b_path));
      const diff = diffSnapshots(a, b, { enrich });
      const text = formatDiff(diff);
      return { content: [{ type: "text", text }] };
    }),
  );

  // ---- Trace store query (Spec 232) ----
  server.tool(
    "runtime_query_events",
    "Spec 232 — query event-indexed trace store. Filter by family + cycle/pc/addr ranges. Headless-first: prefer over `vice_trace_*` for V2 workflows.",
    {
      run_id: z.string(),
      family: z.string(),
      duckdb_path: z.string(),
      cycle_start: z.number().optional(),
      cycle_end: z.number().optional(),
      pc_start: z.number().optional(),
      pc_end: z.number().optional(),
      addr_start: z.number().optional(),
      addr_end: z.number().optional(),
      limit: z.number().default(1000),
    },
    safeHandler("runtime_query_events", async (args) => {
      const { queryEvents } = await import("../runtime/headless/v2/query-events.js");
      const { DuckDbQueryBackend } = await import("../runtime/headless/v2/duckdb-backend.js");
      const duckdb = await import("@duckdb/node-api");
      const inst = await (duckdb as any).DuckDBInstance.create(args.duckdb_path);
      const conn = await inst.connect();
      const backend = new DuckDbQueryBackend(conn);
      const q: any = { runId: args.run_id, family: args.family, limit: args.limit };
      if (args.cycle_start !== undefined && args.cycle_end !== undefined) q.cycleRange = [args.cycle_start, args.cycle_end];
      if (args.pc_start !== undefined && args.pc_end !== undefined) q.pcRange = [args.pc_start, args.pc_end];
      if (args.addr_start !== undefined && args.addr_end !== undefined) q.addrRange = [args.addr_start, args.addr_end];
      const rows = await queryEvents(backend, q);
      return { content: [{ type: "text", text: `${rows.length} rows\n${JSON.stringify(rows.slice(0, 200), null, 2)}` }] };
    }),
  );

  // ---- Follow-a-path (Spec 233) ----
  server.tool(
    "runtime_follow_path",
    "Spec 233 — follow causal chain back from an event. 5 rules: pc_predecessor, stack_frame, mem_dep, irq_origin, io_dep. Optional cross-domain (c64↔drive via IEC).",
    {
      run_id: z.string(),
      duckdb_path: z.string(),
      end_event_cycle: z.number(),
      end_event_family: z.string(),
      end_event_key: z.string().describe("JSON-encoded event key"),
      max_depth: z.number().default(50),
      cycle_window: z.number().default(100_000),
      cross_domain: z.boolean().default(true),
    },
    safeHandler("runtime_follow_path", async (args) => {
      const { followPath } = await import("../runtime/headless/v2/follow-path.js");
      const { DuckDbQueryBackend } = await import("../runtime/headless/v2/duckdb-backend.js");
      const duckdb = await import("@duckdb/node-api");
      const inst = await (duckdb as any).DuckDBInstance.create(args.duckdb_path);
      const conn = await inst.connect();
      const backend = new DuckDbQueryBackend(conn);
      const chain = await followPath(backend, {
        runId: args.run_id,
        endEventCycle: args.end_event_cycle,
        endEventFamily: args.end_event_family as any,
        endEventKey: JSON.parse(args.end_event_key),
        maxDepth: args.max_depth,
        cycleWindow: args.cycle_window,
        crossDomain: args.cross_domain,
      });
      return { content: [{ type: "text", text: JSON.stringify(chain, null, 2) }] };
    }),
  );

  // ---- Swimlane (Spec 234) ----
  server.tool(
    "runtime_swimlane_slice",
    "Spec 234 — transaction-level swimlane (cpu+bus+drive). Compact mode default.",
    {
      run_id: z.string(),
      duckdb_path: z.string(),
      cycle_start: z.number(),
      cycle_end: z.number(),
      compact: z.boolean().default(true),
    },
    safeHandler("runtime_swimlane_slice", async (args) => {
      const { swimlaneSlice } = await import("../runtime/headless/v2/swimlane.js");
      const { renderMarkdown } = await import("../runtime/headless/v2/swimlane-render.js");
      const { DuckDbQueryBackend } = await import("../runtime/headless/v2/duckdb-backend.js");
      const duckdb = await import("@duckdb/node-api");
      const inst = await (duckdb as any).DuckDBInstance.create(args.duckdb_path);
      const conn = await inst.connect();
      const backend = new DuckDbQueryBackend(conn);
      const slice = await swimlaneSlice(backend, {
        runId: args.run_id,
        cycleRange: [args.cycle_start, args.cycle_end],
        compact: args.compact,
      });
      const md = renderMarkdown(slice, { maxRows: 200 });
      return { content: [{ type: "text", text: md }] };
    }),
  );

  // ---- Taint (Spec 244) ----
  server.tool(
    "runtime_trace_taint",
    "Spec 244 — taint analysis / dataflow. Walks back from (cycle, addr) via 5 contribution kinds. Cross-domain bridge default-on.",
    {
      run_id: z.string(),
      duckdb_path: z.string(),
      start_cycle: z.number(),
      start_addr: z.number(),
      max_depth: z.number().default(100),
      cycle_window: z.number().default(1_000_000),
    },
    safeHandler("runtime_trace_taint", async (args) => {
      const { traceTaint } = await import("../runtime/headless/v2/taint.js");
      const { DuckDbQueryBackend } = await import("../runtime/headless/v2/duckdb-backend.js");
      const duckdb = await import("@duckdb/node-api");
      const inst = await (duckdb as any).DuckDBInstance.create(args.duckdb_path);
      const conn = await inst.connect();
      const backend = new DuckDbQueryBackend(conn);
      const graph = await traceTaint(backend, {
        runId: args.run_id,
        startCycle: args.start_cycle,
        startAddr: args.start_addr,
        maxDepth: args.max_depth,
        cycleWindow: args.cycle_window,
      });
      return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
    }),
  );

  // ---- Loader profile (Spec 245) ----
  server.tool(
    "runtime_profile_loader",
    "Spec 245 — fastloader / protection profiling. IO touches + IEC activity + disk activity + 5 protection-pattern detectors with confidence scoring.",
    {
      duckdb_path: z.string(),
      scenario_id: z.string(),
      cycle_start: z.number(),
      cycle_end: z.number(),
    },
    safeHandler("runtime_profile_loader", async (args) => {
      const { profileLoader } = await import("../runtime/headless/v2/loader-profile.js");
      const { DuckDbQueryBackend } = await import("../runtime/headless/v2/duckdb-backend.js");
      const duckdb = await import("@duckdb/node-api");
      const inst = await (duckdb as any).DuckDBInstance.create(args.duckdb_path);
      const conn = await inst.connect();
      const backend = new DuckDbQueryBackend(conn);
      const profile = await profileLoader(backend, args.scenario_id, [args.cycle_start, args.cycle_end]);
      return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
    }),
  );

  // ---- Fingerprint scan (Spec 247) ----
  server.tool(
    "runtime_scan_fingerprints",
    "Spec 247 — match routine bytes against bundled/TREX/local fingerprint libraries. Lookup chain via C64RE_FINGERPRINT_LIBS env.",
    {
      artifact_id: z.string(),
      bytes_hex: z.string().describe("Hex-encoded artifact bytes (no 0x prefix, no spaces)"),
      base_addr: z.number(),
      report_all: z.boolean().default(false),
      min_confidence: z.number().default(0.5),
    },
    safeHandler("runtime_scan_fingerprints", async (args) => {
      const { scanFingerprints } = await import("../runtime/headless/v2/fingerprint.js");
      const cleanHex = args.bytes_hex.replace(/[^0-9a-fA-F]/g, "");
      const bytes = new Uint8Array(cleanHex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
      }
      const matches = scanFingerprints(args.artifact_id, bytes, args.base_addr, {
        reportAll: args.report_all, threshold: args.min_confidence,
      });
      return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
    }),
  );

  // ---- Bookmarks (Spec 242) ----
  server.tool(
    "runtime_bookmark_add",
    "Spec 242 — add trace bookmark with bind mode (cycle/event-key/both). Persisted in trace store DuckDB.",
    {
      duckdb_path: z.string(),
      run_id: z.string(),
      cycle: z.number(),
      label: z.string(),
      family: z.string().optional(),
      event_key_json: z.string().optional(),
      note: z.string().optional(),
      bind_mode: z.enum(["cycle", "event-key", "both"]).default("both"),
      tags: z.array(z.string()).optional(),
    },
    safeHandler("runtime_bookmark_add", async (args) => {
      const { addBookmark } = await import("../runtime/headless/v2/bookmarks.js");
      const { DuckDbQueryBackend } = await import("../runtime/headless/v2/duckdb-backend.js");
      const duckdb = await import("@duckdb/node-api");
      const inst = await (duckdb as any).DuckDBInstance.create(args.duckdb_path);
      const conn = await inst.connect();
      const backend = new DuckDbQueryBackend(conn);
      const id = await addBookmark(backend as any, {
        runId: args.run_id, cycle: args.cycle, label: args.label,
        family: args.family as any,
        eventKey: args.event_key_json ? JSON.parse(args.event_key_json) : undefined,
        note: args.note, bindMode: args.bind_mode, tags: args.tags,
      });
      return { content: [{ type: "text", text: `bookmark added: ${id}` }] };
    }),
  );

  server.tool(
    "runtime_bookmark_list",
    "Spec 242 — list bookmarks for a run.",
    {
      duckdb_path: z.string(),
      run_id: z.string(),
      cycle_start: z.number().optional(),
      cycle_end: z.number().optional(),
    },
    safeHandler("runtime_bookmark_list", async (args) => {
      const { listBookmarks } = await import("../runtime/headless/v2/bookmarks.js");
      const { DuckDbQueryBackend } = await import("../runtime/headless/v2/duckdb-backend.js");
      const duckdb = await import("@duckdb/node-api");
      const inst = await (duckdb as any).DuckDBInstance.create(args.duckdb_path);
      const conn = await inst.connect();
      const backend = new DuckDbQueryBackend(conn);
      const range = args.cycle_start !== undefined && args.cycle_end !== undefined ? [args.cycle_start, args.cycle_end] as [number, number] : undefined;
      const list = await listBookmarks(backend as any, args.run_id, range);
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    }),
  );

  // ---- Regression (Spec 250) ----
  server.tool(
    "runtime_regression_capture_baseline",
    "Spec 250 — LLM-explicit baseline capture for a scenario. Writes baseline.duckdb + ram-end.bin + screenshot.png + meta.json.",
    {
      scenario_id: z.string(),
    },
    safeHandler("runtime_regression_capture_baseline", async ({ scenario_id }) => {
      // Note: requires scenarioRegistry map at runtime; for now pass empty map (= scenario must be runScenario-loadable separately).
      // Real wiring requires V2 scenario registry; defer to follow-up. Stub returns guidance.
      return { content: [{ type: "text", text: `runtime_regression_capture_baseline: scenarioRegistry not yet wired in MCP server. Use scripts/regress-cli.mjs capture ${scenario_id} directly.` }] };
    }),
  );

  server.tool(
    "runtime_regression_compare",
    "Spec 250 — compare current scenario run against captured baseline. Returns no_drift / minor_drift / structural_change / broken classification.",
    {
      scenario_id: z.string(),
    },
    safeHandler("runtime_regression_compare", async ({ scenario_id }) => {
      return { content: [{ type: "text", text: `runtime_regression_compare: scenarioRegistry not yet wired in MCP server. Use scripts/regress-cli.mjs compare ${scenario_id} directly.` }] };
    }),
  );
}
