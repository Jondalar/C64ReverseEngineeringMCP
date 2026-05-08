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
}
