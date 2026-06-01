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

import { isAbsolute, resolve as resolvePath } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

/**
 * Spec 744.4c slice 2b — the ABSTRACT media operation. The client (this MCP)
 * brings the MEDIUM (a host `path`, resolved ABSOLUTE against the caller's
 * project) + the ACTION (`kind`); the runtime media authority (`ingestMedia`,
 * Spec 709) applies it and returns ONE shape (MediaIngressResult). Both modes
 * converge on that one operation — daemon mode routes to the daemon's
 * `media/ingress` WS (the SAME op the UI uses, broadcasting media/changed so the
 * human sees the LLM's mount live); in-process runs ingestMedia directly. No more
 * legacy mountMedia/swapDisk fork (those returned a different MountResult shape).
 *
 * `path` is resolved absolute HERE because the daemon is project-agnostic: a
 * relative path sent raw would resolve against the daemon's cwd (wrong project).
 */
function resolveCallerMediaPath(path: string): string {
  if (isAbsolute(path)) return path;
  return resolvePath(process.env.C64RE_PROJECT_DIR ?? process.cwd(), path);
}

async function mediaIngress(
  session_id: string,
  req: { kind: "disk" | "prg" | "crt" | "eject"; path?: string; name?: string; mode?: "load" | "inject-run"; entry?: number; resetPolicy?: "reset" | "power-cycle"; role?: "drive8" | "cartridge" },
): Promise<unknown> {
  const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
  if (isDaemonMode()) {
    return runtimeDaemon.mediaIngress(session_id, req);
  }
  // In-process: the same single media authority, via the session's controller.
  const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
  const session = getIntegratedSession(session_id);
  if (!session) throw new Error(`No integrated session ${session_id}`);
  const { ensureRuntimeController } = await import("../runtime/headless/debug/runtime-controller.js");
  const { ingestMedia } = await import("../runtime/headless/media/ingress.js");
  const { buildIngressRequest } = await import("../runtime/headless/media/ingress-request.js");
  const ctrl = ensureRuntimeController(session_id, session, () => {});
  const ireq = buildIngressRequest(req);
  return await ingestMedia(ctrl, ireq, { resumeIfRunning: ireq.kind === "crt" });
}

async function getApi(sessionId: string) {
  const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
  const session = getIntegratedSession(sessionId);
  if (!session) throw new Error(`No integrated session ${sessionId}`);
  const { createAgentQueryApi } = await import("../runtime/headless/v2/agent-api.js");
  return createAgentQueryApi({ session });
}

/**
 * Spec 744.4c slice 2 — call an AgentQueryApi method against the active session,
 * routing to the shared Runtime Daemon when one is configured (so the LLM's
 * analysis/debug actions land on the SAME live machine the human watches), else
 * in-process. Returns the identical value either way — the daemon runs the same
 * AgentQueryApi and normalizes TypedArrays to plain arrays. Per slice the daemon
 * allowlists which methods are reachable (v3-ws-server API_CALL_ALLOWLIST).
 */
async function callApi<T = unknown>(session_id: string, method: string, ...args: unknown[]): Promise<T> {
  const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
  if (isDaemonMode()) {
    return runtimeDaemon.apiCall<T>(session_id, method, args);
  }
  const api = await getApi(session_id) as unknown as Record<string, (...a: unknown[]) => unknown>;
  return api[method](...args) as T;
}

/** Spec 726-fix — every trace-store reader handler must open the DuckDB file
 *  with try/finally CLOSE, otherwise the file's per-process lock leaks across
 *  calls (next reader call on the same file fails with "Conflicting lock is
 *  held"). Also installs the Spec 726 compat layer on open so 726 stores
 *  written before the compat views existed are auto-healed.
 *
 *  Spec 746.3 — READ-ONLY FIRST: a default read-write open takes an EXCLUSIVE
 *  file lock, so a reader (this MCP process) cannot open a store that the daemon
 *  process is touching (live tracing / indexing) → "Could not set lock on". Open
 *  READ_ONLY first: DuckDB allows many concurrent read-only handles across
 *  processes, no exclusive lock. A read-only store cannot CREATE VIEW, so the
 *  compat layer is skipped — fine for live 726 stores (the indexer already wrote
 *  the reader schema). Fall back to read-write (+ compat) only for an OLD store
 *  that needs healing AND when no other process holds the lock. */
export async function withDuckDb<T>(dbPath: string, fn: (conn: any, backend: any) => Promise<T>): Promise<T> {
  const duckdb = await import("@duckdb/node-api");
  const { DuckDbQueryBackend } = await import("../runtime/headless/v2/duckdb-backend.js");
  const { ensureSpec726CompatLayer } = await import("../runtime/headless/trace/trace-run-store.js");
  // 1) read-only (no exclusive lock; works while the daemon holds the file).
  try {
    const inst = await (duckdb as any).DuckDBInstance.create(dbPath, { access_mode: "READ_ONLY" });
    try {
      const conn = await inst.connect();
      const backend = new DuckDbQueryBackend(conn);
      return await fn(conn, backend);
    } finally {
      try { (inst as any).closeSync?.(); } catch { /* ignore */ }
    }
  } catch (e) {
    // read-only failed (e.g. an OLD store missing the reader schema → needs compat
    // CREATE VIEWs, which read-only can't do). Fall back to read-write + heal.
    const inst = await (duckdb as any).DuckDBInstance.create(dbPath);
    try {
      const conn = await inst.connect();
      await ensureSpec726CompatLayer(conn);
      const backend = new DuckDbQueryBackend(conn);
      return await fn(conn, backend);
    } finally {
      try { (inst as any).closeSync?.(); } catch { /* ignore */ }
    }
  }
}

/**
 * BUG-029 — read a trace store, routing the read INTO the daemon process when one is
 * configured (the only process that can open a store the live daemon holds a lock on;
 * a DuckDB read-write handle takes a cross-process lock). The daemon opens its own
 * store read-only in-process and returns rows. Out of daemon mode, runs `localFn`
 * against `withDuckDb` directly. The path is resolved absolute caller-side so the
 * project-agnostic daemon reads the caller's file.
 */
async function daemonTraceRead<T>(
  op: string,
  duckdbPath: string,
  args: Record<string, unknown>,
  localFn: () => Promise<T>,
): Promise<T> {
  const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
  if (isDaemonMode()) {
    const abs = isAbsolute(duckdbPath) ? duckdbPath : resolvePath(process.env.C64RE_PROJECT_DIR ?? process.cwd(), duckdbPath);
    return runtimeDaemon.traceRead<T>(op, abs, args);
  }
  return localFn();
}

export function registerRuntimeTools(server: McpServer, _context: ServerToolContext): void {
  // ---- Monitor (Spec 248) ----
  server.tool(
    "runtime_monitor_registers",
    "Read a session's CPU registers (PC/A/X/Y/SP/flags) + cycle count. Use to inspect live CPU state. Not for memory (use runtime_monitor_memory). Inputs: session_id. Returns: register dump.",
    {
      session_id: z.string(),
      memspace: z.enum(["c64", "drive"]).optional(),
    },
    safeHandler("runtime_monitor_registers", async ({ session_id, memspace }) => {
      const r = await callApi(session_id, "monitorRegisters", memspace ?? "c64");
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_monitor_memory",
    "Read a memory range from a session as hex/bytes. Use to inspect live RAM/IO. Not for disassembly (use runtime_monitor_disasm) or static artifacts (use read_artifact). Inputs: session_id, address, length. Returns: bytes.",
    {
      session_id: z.string(),
      start: z.number(),
      end: z.number(),
    },
    safeHandler("runtime_monitor_memory", async ({ session_id, start, end }) => {
      const bytes = await callApi<number[]>(session_id, "monitorMemory", start, end);
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(" ");
      return { content: [{ type: "text", text: `${bytes.length} bytes from $${start.toString(16)}-$${end.toString(16)}:\n${hex}` }] };
    }),
  );

  // Spike — runtime memory-access / region-liveness map. Runs the session for
  // `cycles` with a per-page read/write observer, classifies every region:
  // unused / read-only / dead (written, never read after) / live. Answers
  // "which RAM is free / dead / reclaimable" — for loader homes, save buffers,
  // overlay scratch, dead-data archaeology. Attach AT the phase of interest
  // (e.g. after boot, in gameplay) so the window reflects that phase.
  server.tool(
    "runtime_memory_access_map",
    "Spike — per-region read/write liveness map over a runtime window. Classes: unused | read-only | dead (written, never read after) | live. Finds free/dead/reclaimable RAM. Run AT the phase you care about (e.g. in-game).",
    {
      session_id: z.string(),
      cycles: z.number().default(2_000_000).describe("CPU cycles to observe (the workload window)"),
      classes: z.array(z.enum(["unused", "read-only", "dead", "live"])).default(["dead", "unused"]).describe("region classes to report"),
      min_bytes: z.number().default(256).describe("minimum region size to report"),
    },
    safeHandler("runtime_memory_access_map", async ({ session_id, cycles, classes, min_bytes }) => {
      const hx = (n: number) => "$" + (n & 0xffff).toString(16).padStart(4, "0");
      const renderMap = (tally: Record<string, number>, regions: Array<{ start: number; end: number; cls: string; reads: number; writes: number }>) => {
        const rows = regions.map(r => `  ${hx(r.start)}-${hx(r.end)}  ${r.cls.padEnd(9)} r=${r.reads} w=${r.writes}`);
        const text = `memory-access map over ${cycles} cyc — regions by class: ${JSON.stringify(tally)}\n` +
          `${classes.join("/")} regions ≥${min_bytes}B:\n${rows.join("\n") || "  (none)"}`;
        return { content: [{ type: "text" as const, text }], structuredContent: { tally, regions } };
      };
      // Spec 744.4c slice 2c — run the liveness window on the SHARED session.
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const r = await runtimeDaemon.memoryAccessMap<{ tally: Record<string, number>; regions: any[] }>(session_id, cycles, classes, min_bytes);
        return renderMap(r.tally, r.regions);
      }
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const { MemoryAccessTracker } = await import("../runtime/headless/debug/memory-access-map.js");
      const t = new MemoryAccessTracker(session.c64Bus);
      t.attach();
      session.runFor(cycles, { cycleBudget: cycles });
      const map = t.finish();
      const want = new Set(classes);
      const tally = map.regions.reduce((a, r) => { a[r.cls] = (a[r.cls] || 0) + 1; return a; }, {} as Record<string, number>);
      const regions = map.regions.filter(r => want.has(r.cls) && (r.end - r.start + 1) >= min_bytes);
      return renderMap(tally, regions);
    }),
  );

  server.tool(
    "runtime_monitor_disasm",
    "Disassemble live memory at an address in a session. Use to read code at the current PC or a target. Not for a static PRG (use disasm_prg). Inputs: session_id, address, count. Returns: disassembly lines.",
    {
      session_id: z.string(),
      addr: z.number(),
      count: z.number().default(10),
    },
    safeHandler("runtime_monitor_disasm", async ({ session_id, addr, count }) => {
      const lines = await callApi<Array<{ text: string }>>(session_id, "monitorDisasm", addr, count);
      return { content: [{ type: "text", text: lines.map(l => l.text).join("\n") }] };
    }),
  );

  server.tool(
    "runtime_step_into",
    "Execute one instruction in a session, stepping INTO subroutines. Use for fine-grained single-step debugging. Not for stepping over a JSR (use runtime_step_over). Inputs: session_id. Returns: new PC + registers.",
    { session_id: z.string() },
    safeHandler("runtime_step_into", async ({ session_id }) => {
      await callApi(session_id, "stepInto");
      const r = await callApi<{ pc: number }>(session_id, "monitorRegisters", "c64");
      return { content: [{ type: "text", text: `stepped to PC=$${r.pc.toString(16)}` }] };
    }),
  );

  server.tool(
    "runtime_step_over",
    "Execute one instruction in a session, stepping OVER JSR (runs the subroutine to its return). Use to skip into-call detail. Not for entering the call (use runtime_step_into). Inputs: session_id. Returns: new PC + registers.",
    {
      session_id: z.string(),
      budget: z.number().optional(),
    },
    safeHandler("runtime_step_over", async ({ session_id, budget }) => {
      const r = await callApi(session_id, "stepOver", budget !== undefined ? { budget } : undefined);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_until",
    "Run a session until the PC reaches a target address or the cycle budget is exhausted. Use to reach a known code point. Not for N-instruction stepping (use runtime_session_run). Inputs: session_id, target PC, budget. Returns: stop reason + PC.",
    {
      session_id: z.string(),
      addr: z.number(),
      budget: z.number().optional(),
    },
    safeHandler("runtime_until", async ({ session_id, addr, budget }) => {
      const r = await callApi(session_id, "until", addr, budget !== undefined ? { budget } : undefined);
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
      await callApi(session_id, "addPcBreakpoint", id, pc, action);
      return { content: [{ type: "text", text: `breakpoint ${id} added at PC=$${pc.toString(16)} action=${action}` }] };
    }),
  );

  server.tool(
    "runtime_breakpoint_list",
    "Spec 241 — list all registered breakpoints.",
    { session_id: z.string() },
    safeHandler("runtime_breakpoint_list", async ({ session_id }) => {
      const list = await callApi(session_id, "listBreakpoints");
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_breakpoint_remove",
    "Spec 241 — remove breakpoint by id.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_breakpoint_remove", async ({ session_id, id }) => {
      const ok = await callApi<boolean>(session_id, "removeBreakpoint", id);
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
      // Spec 744.4c slice 2c — snapshot the shared session to a host VSF file. The
      // path is resolved absolute against the caller's project; the daemon
      // (localhost) writes that same file — bytes never cross the wire.
      const abs = resolveCallerMediaPath(output_path);
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const r = await runtimeDaemon.vsfSave<{ savedPath: string; bytes: number }>(session_id, abs);
        return { content: [{ type: "text", text: `saved ${r.bytes} bytes to ${r.savedPath}` }] };
      }
      const api = await getApi(session_id);
      const bytes = api.saveVsf();
      const { writeFileSync } = await import("node:fs");
      writeFileSync(abs, bytes);
      return { content: [{ type: "text", text: `saved ${bytes.length} bytes to ${abs}` }] };
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
      // Spec 744.4c slice 2c — restore the shared session from a host VSF file. The
      // daemon (localhost) reads the caller-resolved abs path; bytes never cross.
      const abs = resolveCallerMediaPath(input_path);
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const r = await runtimeDaemon.vsfLoad<{ loadedPath: string; bytes: number }>(session_id, abs);
        return { content: [{ type: "text", text: `loaded ${r.bytes} bytes from ${r.loadedPath}` }] };
      }
      const api = await getApi(session_id);
      const { readFileSync } = await import("node:fs");
      const bytes = new Uint8Array(readFileSync(abs));
      api.loadVsf(bytes);
      return { content: [{ type: "text", text: `loaded ${bytes.length} bytes from ${abs}` }] };
    }),
  );

  // ---- Resolve PC (Spec 235) ----
  server.tool(
    "runtime_resolve_pc",
    "Resolve a PC/address to its symbol / segment / source context. Use to label an address while debugging. Not for raw bytes (use runtime_monitor_memory). Inputs: session_id, address. Returns: resolved context.",
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
      const s = await callApi(session_id, "status");
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
    "Query captured runtime trace events (cpu/mem/irq/drive/vic/cia) for a session or run. Use to find what happened during a run. Not for live registers (use runtime_monitor_registers). Inputs: session/run id, filters. Returns: matching events.",
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
      const q: any = { runId: args.run_id, family: args.family, limit: args.limit };
      if (args.cycle_start !== undefined && args.cycle_end !== undefined) q.cycleRange = [args.cycle_start, args.cycle_end];
      if (args.pc_start !== undefined && args.pc_end !== undefined) q.pcRange = [args.pc_start, args.pc_end];
      if (args.addr_start !== undefined && args.addr_end !== undefined) q.addrRange = [args.addr_start, args.addr_end];
      // BUG-029 — daemon-side read.
      const rows = await daemonTraceRead<any[]>(
        "query_events", args.duckdb_path, q,
        async () => {
          const { queryEvents } = await import("../runtime/headless/v2/query-events.js");
          return withDuckDb(args.duckdb_path, async (_conn, backend) => queryEvents(backend, q));
        },
      );
      return { content: [{ type: "text", text: `${rows.length} rows\n${JSON.stringify(rows.slice(0, 200), null, 2)}` }] };
    }),
  );

  // ---- Follow-a-path (Spec 233) ----
  server.tool(
    "runtime_follow_path",
    "Follow the execution path from a PC through a trace (call/branch chain). Use to reconstruct the control flow of a run. Not for static flow (use build_flow_graph_view, advanced). Inputs: run id, start PC. Returns: ordered path.",
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
      return withDuckDb(args.duckdb_path, async (_conn, backend) => {
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
      });
    }),
  );

  // ---- Swimlane (Spec 234) ----
  server.tool(
    "runtime_swimlane_slice",
    "Return a per-lane (C64 PC / drive PC / IEC / VIA) slice of the trace around a cycle window. Use to compare lanes at a moment of interest. Not for a single-PC search (use trace_store_query). Inputs: run id, cycle window. Returns: per-lane events.",
    {
      run_id: z.string(),
      duckdb_path: z.string(),
      cycle_start: z.number(),
      cycle_end: z.number(),
      compact: z.boolean().default(true),
    },
    safeHandler("runtime_swimlane_slice", async (args) => {
      const { renderMarkdown } = await import("../runtime/headless/v2/swimlane-render.js");
      // BUG-029 — daemon-side read so a live-daemon store lock doesn't block us.
      const slice = await daemonTraceRead<any>(
        "swimlane", args.duckdb_path,
        { run_id: args.run_id, cycle_start: args.cycle_start, cycle_end: args.cycle_end, compact: args.compact },
        async () => {
          const { swimlaneSlice } = await import("../runtime/headless/v2/swimlane.js");
          return withDuckDb(args.duckdb_path, async (_conn, backend) =>
            swimlaneSlice(backend, { runId: args.run_id, cycleRange: [args.cycle_start, args.cycle_end], compact: args.compact }));
        },
      );
      const md = renderMarkdown(slice, { maxRows: 200 });
      return { content: [{ type: "text", text: md }] };
    }),
  );

  // ---- Taint (Spec 244) ----
  server.tool(
    "runtime_trace_taint",
    "Follow data-flow taint from a source byte/address through a trace. Use to find where a value came from or went. Not for plain event listing (use runtime_query_events). Inputs: run id, source. Returns: taint chain.",
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
      return withDuckDb(args.duckdb_path, async (_conn, backend) => {
        const graph = await traceTaint(backend, {
          runId: args.run_id,
          startCycle: args.start_cycle,
          startAddr: args.start_addr,
          maxDepth: args.max_depth,
          cycleWindow: args.cycle_window,
        });
        return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
      });
    }),
  );

  // ---- Loader profile (Spec 245) ----
  server.tool(
    "runtime_profile_loader",
    "Profile a loader run — time/cycles per phase + hotspots. Use to understand loader performance/structure. Not for byte-level events (use runtime_query_events). Inputs: run id. Returns: loader profile.",
    {
      duckdb_path: z.string(),
      scenario_id: z.string(),
      cycle_start: z.number(),
      cycle_end: z.number(),
    },
    safeHandler("runtime_profile_loader", async (args) => {
      const { profileLoader } = await import("../runtime/headless/v2/loader-profile.js");
      return withDuckDb(args.duckdb_path, async (_conn, backend) => {
        const profile = await profileLoader(backend, args.scenario_id, [args.cycle_start, args.cycle_end]);
        return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
      });
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
      return withDuckDb(args.duckdb_path, async (_conn, backend) => {
        const id = await addBookmark(backend as any, {
          runId: args.run_id, cycle: args.cycle, label: args.label,
          family: args.family as any,
          eventKey: args.event_key_json ? JSON.parse(args.event_key_json) : undefined,
          note: args.note, bindMode: args.bind_mode, tags: args.tags,
        });
        return { content: [{ type: "text", text: `bookmark added: ${id}` }] };
      });
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
      return withDuckDb(args.duckdb_path, async (_conn, backend) => {
        const range = args.cycle_start !== undefined && args.cycle_end !== undefined ? [args.cycle_start, args.cycle_end] as [number, number] : undefined;
        const list = await listBookmarks(backend as any, args.run_id, range);
        return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
      });
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

  // ---- Spec 263 — SID audio export ----
  server.tool(
    "runtime_session_export_audio",
    "Render N seconds of the LIVE session's SID audio (reSID) to a stereo s16le 44.1kHz WAV. Use to capture audio from a running integrated session. Not for a saved scenario (use runtime_export_audio). Inputs: session_id, out_path, duration_sec. Returns: WAV path + stats.",
    {
      session_id: z.string(),
      out_path: z.string(),
      duration_sec: z.number(),
    },
    safeHandler("runtime_session_export_audio", async ({ session_id, out_path, duration_sec }) => {
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const { AudioExportSession } = await import("../runtime/headless/audio/sid-audio-recorder.js");
      const { exportSessionAudio } = await import("../runtime/headless/audio/export.js");
      const exp = new AudioExportSession(session as any, { sampleRate: 44100 });
      const r = exportSessionAudio(session as any, exp, out_path, duration_sec);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  // ---- Media browser + mount (Spec 265) ----
  server.tool(
    "runtime_media_list_paths",
    "Spec 265 — list configured fs roots for media browser (samples/, $C64RE_PROJECT_DIR, ~/Downloads, user-added).",
    {},
    safeHandler("runtime_media_list_paths", async () => {
      const { listFsRoots } = await import("../runtime/headless/media/fs-browser.js");
      const roots = listFsRoots();
      return { content: [{ type: "text", text: JSON.stringify(roots, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_media_browse",
    "Browse mountable media (disks/carts) from the project + configured roots. Use to find a disk/cart to mount. Not for mounting it (use runtime_media_mount). Inputs: optional path filter. Returns: media entries.",
    {
      path: z.string().describe("Absolute or relative directory path to browse"),
    },
    safeHandler("runtime_media_browse", async ({ path }) => {
      const { browseDir } = await import("../runtime/headless/media/fs-browser.js");
      const result = browseDir(path);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_media_mount",
    "Mount a disk/cart image into a session's drive (no drive reset — like inserting media on real hardware; the running 1541 senses a disk is now present). Use to insert media before LOAD, or as STEP 2 of a hardware-style side-swap (after runtime_media_unmount + runtime_session_run); then runtime_session_run and runtime_type the RETURN to answer an \"Insert side N\" prompt. Not for removing media (use runtime_media_unmount). Inputs: session_id, path. Returns: mount result.",
    {
      session_id: z.string(),
      slot: z.number().int().default(8).describe("Drive slot: 8 (primary) or 9"),
      path: z.string().describe("Absolute path to the media file"),
    },
    safeHandler("runtime_media_mount", async ({ session_id, slot, path }) => {
      if (slot !== 8 && slot !== 9) throw new Error(`slot must be 8 or 9, got ${slot}`);
      if (slot === 9) throw new Error("drive 9 not supported in v1 (drive8-only)");
      // Spec 744.4c slice 2b — one abstract media op against the shared session.
      const kind = path.toLowerCase().endsWith(".crt") ? "crt" : path.toLowerCase().endsWith(".prg") ? "prg" : "disk";
      const result = await mediaIngress(session_id, { kind, path: resolveCallerMediaPath(path) });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_media_unmount",
    "Eject the disk — open the drive door. The running 1541 senses the disk was removed (write-protect line), so this is STEP 1 of answering a game's \"Insert side N\" prompt: unmount, then runtime_session_run a bit to let the drive register the removal, then runtime_media_mount the new side and runtime_session_run again, then runtime_type the RETURN. Writes back if dirty; the drive keeps running. Use to remove media or to begin a hardware-style side-swap. Not for the first mount (use runtime_media_mount). Inputs: session_id. Returns: eject result.",
    {
      session_id: z.string(),
      slot: z.number().int().default(8),
    },
    safeHandler("runtime_media_unmount", async ({ session_id, slot }) => {
      if (slot !== 8 && slot !== 9) throw new Error(`slot must be 8 or 9, got ${slot}`);
      if (slot === 9) throw new Error("drive 9 not supported in v1 (drive8-only)");
      // Spec 744.4c slice 2b — eject via the one abstract media op.
      const result = await mediaIngress(session_id, { kind: "eject", role: "drive8" });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }),
  );

  server.tool(
    "runtime_media_persist",
    "Write the mounted disk's in-RAM image back to its host backing file WITHOUT ejecting (flushes drive-side GCR writes → the .d64/.g64 on disk, atomically; host mtime changes). Use to save a game's disk writes (format/copy/save) while keeping it mounted. Not for ejecting the disk (use runtime_media_unmount, which persists then ejects) or for a session snapshot (use runtime_session_snapshot). Read-only media is never overwritten. Inputs: session_id. Returns: { written, path, bytes } or the reason it was skipped.",
    {
      session_id: z.string(),
      slot: z.number().int().default(8),
    },
    safeHandler("runtime_media_persist", async ({ session_id, slot }) => {
      if (slot !== 8 && slot !== 9) throw new Error(`slot must be 8 or 9, got ${slot}`);
      // Spec 744.4c slice 2c — persist the shared session's disk to its host file.
      // Write-through (Spec 742) is preserved: the backing path was set absolute at
      // mount time, so the daemon (localhost) writes the CALLER's .d64/.g64.
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const result = await runtimeDaemon.mediaPersist(session_id, slot);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const { persistMountedDiskToFile } = await import("../runtime/headless/media/mount.js");
      const result = persistMountedDiskToFile(session);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }),
  );

  server.tool(
    "runtime_media_swap",
    "Swap the mounted disk for another in ONE atomic step (detach+attach with no drive cycles between). Use for a quick change when nothing is polling the drive (e.g. before a fresh LOAD). NOT for a game that prompts \"Insert side N\" and waits: a real 1541 senses the disk being pulled out and a new one pushed in over many drive cycles, which an atomic swap gives no time for — instead drive it like hardware (runtime_media_unmount → runtime_session_run → runtime_media_mount → runtime_session_run, then runtime_type the RETURN). Read the screen with runtime_render_screen to know when a side-change is being asked for. Inputs: session_id, path. Returns: swap result.",
    {
      session_id: z.string(),
      slot: z.number().int().default(8),
      path: z.string().describe("Absolute path to the new disk image"),
    },
    safeHandler("runtime_media_swap", async ({ session_id, slot, path }) => {
      if (slot !== 8 && slot !== 9) throw new Error(`slot must be 8 or 9, got ${slot}`);
      if (slot === 9) throw new Error("drive 9 not supported in v1 (drive8-only)");
      // Spec 744.4c slice 2b — swap = ingest a new disk (the authority detaches the
      // old + attaches the new). Same single op + shape as mount.
      const result = await mediaIngress(session_id, { kind: "disk", path: resolveCallerMediaPath(path) });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }),
  );

  // ---- Spec 264 — Input (keyboard + joystick) tools ----

  server.tool(
    "runtime_input_load_vicerc",
    "Spec 264 — Parse ~/.config/vice/vicerc and return joystick keyset bindings (KeySet2*, JoyDevice2). Bootstrap config from VICE settings.",
    { vicerc_path: z.string().optional() },
    safeHandler("runtime_input_load_vicerc", async ({ vicerc_path }) => {
      const { loadVicerc } = await import("../runtime/headless/input/vicerc-loader.js");
      const cfg = loadVicerc(vicerc_path);
      return { content: [{ type: "text", text: JSON.stringify(cfg, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_input_load_config",
    "Spec 264 — Load InputConfig from ~/.config/c64re/joystick.json, bootstrapping from vicerc if file absent.",
    {
      config_path: z.string().optional(),
      vicerc_path: z.string().optional(),
    },
    safeHandler("runtime_input_load_config", async ({ config_path, vicerc_path }) => {
      const { loadInputConfig } = await import("../runtime/headless/input/input-config.js");
      const cfg = loadInputConfig({ configPath: config_path, vicercPath: vicerc_path });
      return { content: [{ type: "text", text: JSON.stringify(cfg, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_input_save_config",
    "Spec 264 — Save InputConfig to ~/.config/c64re/joystick.json. Never touches vicerc.",
    {
      config: z.object({
        version: z.literal(1),
        keyboardMode: z.enum(["qwerty", "positional"]),
        joystickPort: z.union([z.literal(1), z.literal(2)]),
        keyset: z.object({
          north: z.string(), east: z.string(), south: z.string(),
          west: z.string(), fire: z.string(),
        }),
        gamepad: z.object({
          axisH: z.number(), axisV: z.number(),
          deadzone: z.number(), fireButton: z.number(),
        }),
      }),
      config_path: z.string().optional(),
    },
    safeHandler("runtime_input_save_config", async ({ config, config_path }) => {
      const { saveInputConfig } = await import("../runtime/headless/input/input-config.js");
      saveInputConfig(config as any, config_path);
      return { content: [{ type: "text", text: `Saved to ${config_path ?? "~/.config/c64re/joystick.json"}` }] };
    }),
  );

  // ---- Spec 268 — Scenario registry ----

  server.tool(
    "runtime_scenario_list",
    "Spec 268 — list scenarios from samples/scenarios/ and $C64RE_PROJECT_DIR/scenarios/. Returns summaries sorted by date.",
    {},
    safeHandler("runtime_scenario_list", async () => {
      const { listScenarios } = await import("../runtime/headless/v2/scenario-registry.js");
      const scenarios = listScenarios();
      return { content: [{ type: "text", text: JSON.stringify(scenarios, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_scenario_save",
    "Spec 268 — save a scenario JSON to project dir (or samples if no project dir). Returns file path.",
    {
      id: z.string(),
      diskPath: z.string(),
      mode: z.enum(["true-drive"]),  // Spec 723.3: fast-trap / real-kernal removed
      cycleBudget: z.number(),
      inputs: z.array(z.object({
        atCycle: z.number(),
        kind: z.enum(["keyboard", "joystick1", "joystick2"]),
        payload: z.unknown(),
      })).default([]),
      startSnapshot: z.string().optional().describe("VSF file path or omit for empty (scenario is a plan only)."),
    },
    safeHandler("runtime_scenario_save", async ({ id, diskPath, mode, cycleBudget, inputs, startSnapshot }) => {
      const { saveScenario } = await import("../runtime/headless/v2/scenario-registry.js");
      const scenario: any = { id, diskPath, mode, cycleBudget, inputs, startSnapshot: startSnapshot ?? "" };
      const { filePath } = saveScenario(scenario);
      return { content: [{ type: "text", text: `saved to ${filePath}` }] };
    }),
  );

  server.tool(
    "runtime_scenario_load",
    "Spec 268 — load a single scenario by id. Checks project dir first, then samples.",
    { id: z.string() },
    safeHandler("runtime_scenario_load", async ({ id }) => {
      const { loadScenario } = await import("../runtime/headless/v2/scenario-registry.js");
      const s = loadScenario(id);
      if (!s) throw new Error(`scenario '${id}' not found`);
      return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_scenario_delete",
    "Spec 268 — delete a scenario JSON by id. Returns true if found and removed.",
    { id: z.string() },
    safeHandler("runtime_scenario_delete", async ({ id }) => {
      const { deleteScenario } = await import("../runtime/headless/v2/scenario-registry.js");
      const ok = deleteScenario(id);
      return { content: [{ type: "text", text: ok ? `deleted ${id}` : `${id} not found` }] };
    }),
  );

  server.tool(
    "runtime_snapshot_tree",
    "Spec 268 — return the full branch tree for a rewind session. Requires session with active RewindManager.",
    { session_id: z.string() },
    safeHandler("runtime_snapshot_tree", async ({ session_id }) => {
      // Spec 744.4c slice 2c — route to the daemon's runtime/snapshot_tree (which
      // sets scenarioId+diskPath+mode for beginRewindSession; the in-process
      // getApi path did NOT, so it threw). Same shared session as the UI.
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const tree = await runtimeDaemon.snapshotTree(session_id);
        return { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] };
      }
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const { createAgentQueryApi } = await import("../runtime/headless/v2/agent-api.js");
      const api = createAgentQueryApi({ session, scenarioId: session_id, diskPath: session.diskPath || session_id, mode: "true-drive" });
      const rm = api.beginRewindSession();
      const handle = rm.handle();
      const branches: Record<string, any> = {};
      for (const [k, v] of handle.branches) branches[k] = v;
      return { content: [{ type: "text", text: JSON.stringify({
        scenarioId: handle.scenarioId,
        rootBranchId: handle.rootBranchId,
        rootSnapshotId: handle.rootSnapshotId,
        ringSize: handle.ringSize,
        branches,
      }, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_promote_branch",
    "Spec 268 — promote a transient rewind branch to a persistent Scenario record.",
    { session_id: z.string(), branch_id: z.string() },
    safeHandler("runtime_promote_branch", async ({ session_id, branch_id }) => {
      // Spec 744.4c slice 2c — route to the daemon's runtime/promote_branch.
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const r = await runtimeDaemon.promoteBranch(session_id, branch_id);
        return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
      }
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const { createAgentQueryApi } = await import("../runtime/headless/v2/agent-api.js");
      const api = createAgentQueryApi({ session, scenarioId: session_id, diskPath: session.diskPath || session_id, mode: "true-drive" });
      const rm = api.beginRewindSession();
      const { scenarioId, scenario, patches } = rm.promoteBranch(branch_id);
      return { content: [{ type: "text", text: JSON.stringify({ scenarioId, scenario, patches }, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_run_scenario",
    "Spec 268 / 231 — replay a saved scenario by id, returns ReplayResult hashes.",
    { id: z.string() },
    safeHandler("runtime_run_scenario", async ({ id }) => {
      const { loadScenario } = await import("../runtime/headless/v2/scenario-registry.js");
      const { runScenario } = await import("../runtime/headless/v2/scenario.js");
      const s = loadScenario(id);
      if (!s) throw new Error(`scenario '${id}' not found`);
      const scenario: any = {
        ...s,
        startSnapshot: typeof s.startSnapshot === "string" && s.startSnapshot
          ? s.startSnapshot
          : Buffer.from(s.startSnapshot as string ?? "", "base64"),
      };
      const result = runScenario(scenario);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }),
  );

  // ---- Spec 271 — Parallel batch scenario runner ----

  server.tool(
    "runtime_run_scenarios_parallel",
    "Spec 271 — run multiple scenarios in parallel via worker_threads. Returns batchId for polling.",
    {
      scenario_ids: z.array(z.string()).min(1),
      worker_count: z.number().int().min(1).optional(),
    },
    safeHandler("runtime_run_scenarios_parallel", async ({ scenario_ids, worker_count }) => {
      const { WorkerPool, resolveWorkerCount } = await import("../runtime/headless/parallel/scenario-pool.js");
      const { createBatch, updateProgress, completeBatch, failBatch, serialiseBatch } = await import("../runtime/headless/parallel/batch-store.js");

      const n = resolveWorkerCount(scenario_ids.length, worker_count);
      const entry = createBatch(scenario_ids, n);

      const pool = new WorkerPool({
        workerCount: n,
        projectDir: process.env.C64RE_PROJECT_DIR,
        onProgress: (completed, _total) => updateProgress(entry.batchId, completed),
      });

      // Fire-and-forget; results accumulate in store.
      pool.runBatch(scenario_ids).then(results => {
        completeBatch(entry.batchId, results);
      }).catch((e: Error) => {
        failBatch(entry.batchId, e.message ?? String(e));
      });

      return { content: [{ type: "text", text: JSON.stringify(serialiseBatch(entry), null, 2) }] };
    }),
  );

  server.tool(
    "runtime_batch_status",
    "Spec 271 — poll progress of a parallel batch. Returns completed / total and status.",
    { batch_id: z.string() },
    safeHandler("runtime_batch_status", async ({ batch_id }) => {
      const { getBatch, serialiseBatch } = await import("../runtime/headless/parallel/batch-store.js");
      const entry = getBatch(batch_id);
      if (!entry) throw new Error(`batch '${batch_id}' not found`);
      return { content: [{ type: "text", text: JSON.stringify(serialiseBatch(entry), null, 2) }] };
    }),
  );

  server.tool(
    "runtime_batch_results",
    "Spec 271 — collect ReplayResult per scenario once batch is done. Errors per-scenario included.",
    { batch_id: z.string() },
    safeHandler("runtime_batch_results", async ({ batch_id }) => {
      const { getBatch, serialiseBatch, serialiseResults } = await import("../runtime/headless/parallel/batch-store.js");
      const entry = getBatch(batch_id);
      if (!entry) throw new Error(`batch '${batch_id}' not found`);
      if (entry.status === "running") throw new Error(`batch '${batch_id}' still running (${entry.completed}/${entry.total})`);
      return { content: [{ type: "text", text: JSON.stringify({
        batch: serialiseBatch(entry),
        results: serialiseResults(entry),
      }, null, 2) }] };
    }),
  );

  // ---- Spec 269 — export ----

  server.tool(
    "runtime_export_screenshot",
    "Spec 269 — export PNG screenshot for a scenario. Runs scenario from start to atCycle (or end). Scale 1/2/4 for pixel-art upscale.",
    {
      scenario_id: z.string(),
      out_path: z.string(),
      scale: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional().default(1),
      at_cycle: z.number().optional(),
    },
    safeHandler("runtime_export_screenshot", async ({ scenario_id, out_path, scale, at_cycle }) => {
      const { exportScreenshot } = await import("../runtime/headless/export/screenshot.js");
      const result = await exportScreenshot(scenario_id, out_path, {
        scale: scale as 1 | 2 | 4,
        atCycle: at_cycle,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_export_video",
    "Spec 269 — export MP4 video for a scenario via ffmpeg (must be installed). PAL 50fps, RGBA + s16le piped to ffmpeg.",
    {
      scenario_id: z.string(),
      out_path: z.string(),
      duration: z.number().optional().default(5),
      scale: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional().default(1),
    },
    safeHandler("runtime_export_video", async ({ scenario_id, out_path, duration, scale }) => {
      const { exportVideo } = await import("../runtime/headless/export/video.js");
      const result = await exportVideo(scenario_id, out_path, {
        duration,
        scale: scale as 1 | 2 | 4,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_export_audio",
    "Render a saved SCENARIO's SID audio to a stereo s16le WAV (part of the runtime_export_* scenario family). Use to capture audio from a scenario run. Not for a live session (use runtime_session_export_audio). Inputs: scenario_id, out_path, duration. Returns: WAV path + stats.",
    {
      scenario_id: z.string(),
      out_path: z.string(),
      duration: z.number().optional().default(5),
      format: z.enum(["wav"]).optional().default("wav"),
    },
    safeHandler("runtime_export_audio", async ({ scenario_id, out_path, duration }) => {
      const { exportScenarioAudio } = await import("../runtime/headless/export/audio-export.js");
      const result = await exportScenarioAudio(scenario_id, out_path, { duration });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }),
  );

  // ---- Spec 710 — frozen-VIC inspect (checkpoint-bound, no execution advance) ----
  server.tool(
    "runtime_vic_inspect_at",
    "Resolve a frozen display pixel to its exact VIC/RAM provenance (screen/color/charset/bitmap/sprite refs) on a retained checkpoint, without advancing execution. Use to explain what produces a given pixel. Not for live rendering (use runtime_render_screen). Inputs: checkpoint, x in 0..319, y in 0..199. Returns: provenance refs.",
    {
      session_id: z.string(),
      x: z.number(),
      y: z.number(),
      checkpoint_id: z.string().optional(),
    },
    safeHandler("runtime_vic_inspect_at", async ({ session_id, x, y, checkpoint_id }) => {
      // Spec 744.4c slice 2c — resolve a frozen pixel on the SHARED session's
      // checkpoint ring (the same frames the human inspects).
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const r = await runtimeDaemon.vicInspectAt(session_id, x, y, checkpoint_id);
        return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
      }
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const { ensureRuntimeController } = await import("../runtime/headless/debug/runtime-controller.js");
      const { buildVicInspectSnapshot, resolveNodeAt } = await import("../runtime/headless/inspect/vic-inspect.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`no session ${session_id}`);
      const ctrl = ensureRuntimeController(session_id, session, () => {});
      let id = checkpoint_id;
      if (!id) {
        if (ctrl.runState === "running") ctrl.pause();
        const ref = await ctrl.captureCheckpoint();
        ctrl.checkpointRing.pin(ref.id);
        id = ref.id;
      }
      const cp = ctrl.checkpointRing.restoreSnapshot(String(id))?.payload as any;
      if (!cp || !cp.vic || !cp.ram) throw new Error(`runtime_vic_inspect_at: unknown checkpoint ${id}`);
      const frame = buildVicInspectSnapshot(cp);
      const provenance = cp.vicProvenance ?? undefined; // 710.4/710.5 — from the checkpoint payload
      const node = resolveNodeAt(cp, x | 0, y | 0, provenance);
      return { content: [{ type: "text", text: JSON.stringify({ checkpointId: id, frame, node, hasProvenance: !!provenance }, null, 2) }] };
    }),
  );
}
