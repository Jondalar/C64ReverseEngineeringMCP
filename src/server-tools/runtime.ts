// Spec 238 — V2 MCP tool layer.
//
// Wraps AgentQueryApi (Spec 237) into agent-shaped MCP tools.
// Tools accept session_id + scenario context, return structured
// JSON suitable for save_finding / save_open_question pipeline.
//
// Runtime-only framing (2026-07-09): the c64re runtime is the ONLY runtime a
// tool description may name. External emulators are not an option for RE work
// and must not appear on this surface. The single exception is the `.vsf`
// interchange format, which is labelled LEGACY / DEPRECATED where it appears.

import { isAbsolute, resolve as resolvePath } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

/**
 * Spec 744.4c slice 2b — the ABSTRACT media operation. The client (this MCP)
 * brings the MEDIUM (a host `path`, resolved ABSOLUTE against the caller's
 * project) + the ACTION (`kind`); the runtime's media authority (Spec 709)
 * applies it and returns ONE shape (MediaIngressResult). It routes to the
 * runtime's `media/ingress` — the SAME op the UI uses, broadcasting
 * media/changed so the human sees the LLM's mount live. No legacy
 * mountMedia/swapDisk fork (those returned a different MountResult shape).
 *
 * Spec 806 step 2 — one path. The in-process second implementation is gone.
 *
 * `path` is resolved absolute HERE because the runtime is project-agnostic: a
 * relative path sent raw would resolve against its cwd (wrong project).
 */
function resolveCallerMediaPath(path: string): string {
  if (isAbsolute(path)) return path;
  return resolvePath(process.env.C64RE_PROJECT_DIR ?? process.cwd(), path);
}

async function mediaIngress(
  session_id: string,
  req: { kind: "disk" | "prg" | "crt" | "eject"; path?: string; name?: string; mode?: "load" | "inject-run"; entry?: number; resetPolicy?: "reset" | "power-cycle"; role?: "drive8" | "cartridge" | "auto" },
): Promise<unknown> {
  const { runtimeDaemon } = await import("../runtime/daemon-client.js");
  return runtimeDaemon.mediaIngress(session_id, req);
}

/**
 * Spec 744.4c slice 2 — call an AgentQueryApi method against the active session.
 * It lands on the SAME live machine the human watches; TypedArrays come back
 * normalized to plain arrays. The runtime allowlists which methods are reachable
 * over the narrow `api/call` verb (monitor/step/breakpoint/until/status).
 */
async function callApi<T = unknown>(session_id: string, method: string, ...args: unknown[]): Promise<T> {
  const { runtimeDaemon } = await import("../runtime/daemon-client.js");
  return runtimeDaemon.apiCall<T>(session_id, method, args);
}

/**
 * The WIDE facade verb — every AgentQueryApi method the runtime backs, not just
 * the narrow `api/call` allowlist. Used by the handlers whose method is outside
 * it (`resolvePc`, `diffSnapshots`, `formatDiff`).
 */
async function callApiFull<T = unknown>(session_id: string, op: string, args: unknown[] = []): Promise<T> {
  const { runtimeDaemon } = await import("../runtime/daemon-client.js");
  return runtimeDaemon.call<T>("runtime/call", { session_id, op, args });
}

/** NOT a trace-read path (Spec 802). Every trace-store READ in C64RE now goes
 *  through `./trace-read.js` → the runtime's native reader. What is left here is
 *  the BOOKMARK pair (`runtime_bookmark_add` — a WRITE, which no `trace/read` op
 *  covers — and `runtime_bookmark_list`), both advanced-tier (absent from
 *  DEFAULT_TOOLS), plus the internal TS parity oracle (`workspace-ui/ws-server.ts`).
 *  It stays exported for those two consumers only; do NOT reintroduce it as a
 *  fallback under a reader.
 *
 *  Spec 726-fix — every trace-store reader handler must open the DuckDB file
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
  const { DuckDbQueryBackend } = await import("../analysis/duckdb-backend.js");
  const { ensureSpec726CompatLayer } = await import("../trace/trace-run-store.js");
  // Spec 746.x — LAZY-ON-READ: wait for an in-flight index, trust a present store,
  // or (re)build a missing one from the .c64retrace authority before opening — so a
  // read right after stop() sees the fresh store AND an orphaned store (e.g. a
  // multi-GB trace whose index never built) is recovered on first read. Throws the
  // real reason if the build failed (surfaced instead of a cryptic "not found").
  // BUG-039 — BOUNDED: an unbounded wait here (minutes on a multi-GB log) trips
  // the MCP host's ~180s stall limit and drops the stdio connection.
  const { ensureIndexBounded } = await import("../trace/background-indexer.js");
  await ensureIndexBounded(dbPath);
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
 * Spec 802 — read a trace store THROUGH the runtime, always. One path.
 *
 * BUG-029 originally routed reads into the daemon because it is the only process
 * that can open a store the live runtime holds a lock on; the `localFn` escape
 * hatch behind it was a second, independent reader for the same bytes. It is gone:
 * the runtime reads its own format natively and C64RE carries no reader at all.
 * A missing/unreachable runtime now fails with the setup recipe (see
 * `./trace-read.js`) instead of silently answering from other code.
 */
async function daemonTraceRead<T>(
  op: string,
  duckdbPath: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { traceRead } = await import("./trace-read.js");
  return traceRead<T>(op, duckdbPath, args);
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
      hypothesis: z.string().optional().describe("REQUIRED (read-before-runtime gate): a concrete $address you are investigating + what you READ that points there. The liveness map CONFIRMS a free/dead-RAM hypothesis; it is not how you discover structure. Fishing (no address / no rationale) is refused — read first (disasm_prg / inspect_address_range / project_search)."),
    },
    safeHandler("runtime_memory_access_map", async ({ session_id, cycles, classes, min_bytes, hypothesis }) => {
      const { checkRuntimeDiscipline } = await import("./discipline-gate.js");
      const gate = await checkRuntimeDiscipline(hypothesis, { tool: "runtime_memory_access_map", act: "mapping live RAM read/write liveness" });
      if (!gate.allowed) return { content: [{ type: "text" as const, text: gate.refusal! }] };
      const hx = (n: number) => "$" + (n & 0xffff).toString(16).padStart(4, "0");
      const renderMap = (tally: Record<string, number>, regions: Array<{ start: number; end: number; cls: string; reads: number; writes: number }>) => {
        const rows = regions.map(r => `  ${hx(r.start)}-${hx(r.end)}  ${r.cls.padEnd(9)} r=${r.reads} w=${r.writes}`);
        const text = `memory-access map over ${cycles} cyc — regions by class: ${JSON.stringify(tally)}\n` +
          `${classes.join("/")} regions ≥${min_bytes}B:\n${rows.join("\n") || "  (none)"}`;
        return { content: [{ type: "text" as const, text }], structuredContent: { tally, regions } };
      };
      // Spec 744.4c slice 2c — run the liveness window on the SHARED session.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.memoryAccessMap<{ tally: Record<string, number>; regions: any[] }>(session_id, cycles, classes, min_bytes);
      return renderMap(r.tally, r.regions);
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
    "Add PC breakpoint with an action (halt/log/snapshot/trace_burst).",
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
    "List all registered breakpoints.",
    { session_id: z.string() },
    safeHandler("runtime_breakpoint_list", async ({ session_id }) => {
      const list = await callApi(session_id, "listBreakpoints");
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_breakpoint_remove",
    "Remove breakpoint by id.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_breakpoint_remove", async ({ session_id, id }) => {
      const ok = await callApi<boolean>(session_id, "removeBreakpoint", id);
      return { content: [{ type: "text", text: ok ? `removed ${id}` : `${id} not found` }] };
    }),
  );

  // ---- Snapshot diff (Spec 246) ----
  server.tool(
    "runtime_save_vsf",
    "Save full session state as .vsf bytes (VICE Snapshot Format — LEGACY, DEPRECATED; kept only for interchange with external emulators). For a durable .c64re snapshot use the runtime's snapshot dump.",
    {
      session_id: z.string(),
      output_path: z.string(),
    },
    safeHandler("runtime_save_vsf", async ({ session_id, output_path }) => {
      // Spec 744.4c slice 2c — snapshot the shared session to a host VSF file. The
      // path is resolved absolute against the caller's project; the daemon
      // (localhost) writes that same file — bytes never cross the wire.
      const abs = resolveCallerMediaPath(output_path);
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.vsfSave<{ savedPath: string; bytes: number }>(session_id, abs);
      return { content: [{ type: "text", text: `saved ${r.bytes} bytes to ${r.savedPath}` }] };
    }),
  );

  server.tool(
    "runtime_load_vsf",
    "Restore full session state from a .vsf file (VICE Snapshot Format — LEGACY, DEPRECATED; interchange only). Auto-detects a foreign x64sc-written .vsf (VIC-IISC module → full 64K RAM + MAINCPU + VIC-IISC pipeline + CIA1/2 injected) vs a c64re-own .vsf, and dispatches to the right loader.",
    {
      session_id: z.string(),
      input_path: z.string(),
    },
    safeHandler("runtime_load_vsf", async ({ session_id, input_path }) => {
      // Spec 744.4c slice 2c — restore the shared session from a host VSF file. The
      // daemon (localhost) reads the caller-resolved abs path; bytes never cross.
      const abs = resolveCallerMediaPath(input_path);
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.vsfLoad<{ loadedPath: string; bytes: number; source?: string; loadedModules?: string[] }>(session_id, abs);
      const origin = r.source === "vice-x64sc" ? "foreign .vsf (legacy VICE Snapshot Format)" : "c64re snapshot";
      return { content: [{ type: "text", text: `loaded ${r.bytes} bytes from ${r.loadedPath} (${origin}${r.loadedModules ? `; modules: ${r.loadedModules.join(", ")}` : ""})` }] };
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
      // Spec 806 step 2 — `resolvePc` is outside the narrow api/call allowlist, so
      // it goes through the wide facade verb. Same method, same return shape.
      const r = await callApiFull(session_id, "resolvePc", [artifact_id, pc]);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  // ---- Status ----
  server.tool(
    "runtime_status",
    "AgentQueryApi facade introspection. Reports what V2 surface is available + session cycle counts.",
    { session_id: z.string() },
    safeHandler("runtime_status", async ({ session_id }) => {
      const s = await callApi(session_id, "status");
      return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
    }),
  );

  // ---- Snapshot diff between two VSF files ----
  server.tool(
    "runtime_diff_snapshots",
    "Use to see exactly what changed between two VSF snapshot files — RAM changedRanges plus CPU/CIA/VIC/SID/PLA chip diffs. Not for a live memory read (use runtime_monitor_memory) or capturing a snapshot (use runtime_checkpoint_capture).",
    {
      a_path: z.string(),
      b_path: z.string(),
      enrich: z.boolean().default(false),
      hypothesis: z.string().optional().describe("REQUIRED (read-before-runtime gate): a concrete $address + what you READ that points there. The snapshot delta CONFIRMS a hypothesis about what a step changed; it is not how you discover the payload. Fishing (no address / no rationale) is refused — read first (disasm_prg / inspect_address_range / project_search)."),
    },
    safeHandler("runtime_diff_snapshots", async ({ a_path, b_path, hypothesis }) => {
      const { checkRuntimeDiscipline } = await import("./discipline-gate.js");
      const gate = await checkRuntimeDiscipline(hypothesis, { tool: "runtime_diff_snapshots", act: "diffing two machine snapshots" });
      if (!gate.allowed) return { content: [{ type: "text" as const, text: gate.refusal! }] };
      // Spec 806 step 2 — the diff runs in the runtime (`diffSnapshots` + `formatDiff`
      // on the wide facade verb). The FILES are still read here, because the paths are
      // the caller's: the buffers travel as the same number-array transport `saveVsf`
      // uses. `enrich` stays in the input schema and stays inert — the diff was always
      // a pure state-diff and never consumed the flag.
      const { readFileSync } = await import("node:fs");
      const a = Array.from(readFileSync(a_path));
      const b = Array.from(readFileSync(b_path));
      // No session_id: this tool diffs two FILES, not a live machine (the facade
      // verb accepts the field and ignores it — there is one machine per process).
      const diff = await callApiFull("", "diffSnapshots", [a, b]);
      const text = await callApiFull<string>("", "formatDiff", [diff]);
      return { content: [{ type: "text", text }] };
    }),
  );

  // ---- Whitebox component-diff of two .c64re snapshots (Spec 794) ----
  server.tool(
    "runtime_component_diff",
    "Whitebox component-diff of two .c64re snapshots: a per-component equivalence VERDICT (cpu/ram/colorram/cia/vic/sid/drive incl. Floppy RAM + internal chip state) with a caller exclusion mask. Use to SCORE a candidate snapshot against a baseline — the sandbox fan-out eval step, a refactor-equivalence check, or which component a change actually moved. Not a live memory read (use runtime_monitor_memory), not the VSF-file diff (use runtime_diff_snapshots).",
    {
      a_path: z.string().describe("Baseline .c64re snapshot"),
      b_path: z.string().describe("Candidate .c64re snapshot"),
      exclude: z
        .object({
          components: z.array(z.string()).optional().describe("Whole components to exclude, e.g. sid, drive.ram, vic"),
          lanes: z.array(z.string()).optional().describe("Volatile lanes: cycles|raster|sid_noise|open_bus|framebuffer"),
          presets: z.array(z.string()).optional().describe("Named presets: equivalence (mask all volatile lanes)"),
          ranges: z
            .array(z.object({ space: z.string(), from: z.string(), to: z.string() }))
            .optional()
            .describe("Address windows to exclude; space = c64ram|colorram|driveram|drivezp (Floppy RAM = driveram $0000-$07FF)"),
        })
        .optional(),
      hypothesis: z
        .string()
        .optional()
        .describe("REQUIRED (read-before-runtime gate): a concrete $address + what you READ that points there. The diff CONFIRMS what a change moved; it is not how you discover the payload."),
    },
    safeHandler("runtime_component_diff", async ({ a_path, b_path, exclude, hypothesis }) => {
      const { checkRuntimeDiscipline } = await import("./discipline-gate.js");
      const gate = await checkRuntimeDiscipline(hypothesis, {
        tool: "runtime_component_diff",
        act: "diffing two machine snapshots at component granularity",
      });
      if (!gate.allowed) return { content: [{ type: "text" as const, text: gate.refusal! }] };

      const { resolveTrx64Cli, runTrx64CliJson } = await import("../sandbox/trx64cli.js");
      const cli = resolveTrx64Cli();
      const ex = exclude ?? {};
      const args: string[] = ["diff", a_path, b_path, "--json"];
      for (const c of ex.components ?? []) args.push("--component", c);
      for (const l of ex.lanes ?? []) args.push("--lane", l);
      for (const p of ex.presets ?? []) args.push("--preset", p);
      for (const r of ex.ranges ?? []) args.push("--exclude", `${r.space}:${r.from}-${r.to}`);

      let diff: any;
      try {
        diff = runTrx64CliJson(cli, args);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `runtime_component_diff: ${(e as Error).message}` }] };
      }
      const v = diff?.verdict ?? {};
      const head = [
        `VERDICT: ${v.identical ? "IDENTICAL" : "DIFFERS"}`,
        v.differing?.length ? `differing: ${v.differing.join(", ")}` : "",
        v.excluded?.length ? `excluded: ${v.excluded.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text" as const, text: `${head}\n\n${JSON.stringify(diff, null, 2)}` }] };
    }),
  );

  // ---- Candidate model (Spec 796) — live scenario-bound overlay branches ----
  const candidateDaemon = async () => {
    const { runtimeDaemon } = await import("../runtime/daemon-client.js");
    return runtimeDaemon;
  };

  server.tool(
    "runtime_candidate_create",
    "Create a live candidate: a baseline checkpoint anchor + a bound scenario (deterministic replay) + an empty overlay patch-set. Runs the NO-PATCH scenario once to cache the equivalence baseline. Start an iterate-your-own-code loop on a fixed snapshot. Inputs: session_id, anchor (checkpoint id), scenario {inputs, cycleBudget}. Returns: the candidate {id, ...}.",
    { session_id: z.string(), anchor: z.string(), scenario: z.object({ inputs: z.array(z.any()).optional(), cycleBudget: z.number().optional() }).optional() },
    safeHandler("runtime_candidate_create", async ({ session_id, anchor, scenario }) => {
      const d = await candidateDaemon();
      const r = await d.call("runtime/candidate_create", { session_id, anchor, scenario: scenario ?? {} });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_candidate_patch",
    "Add/replace an overlay patch on a candidate (assemble ⊕ overlay in one step). Give `source_path` (an .asm/.tas file, assembled here → bytes) OR pre-assembled `bytes`. `space` ram|roml|romh + `bank` + `addr` (CPU window addr) target RAM or a cart bank (795). Re-adding at the same target REPLACES (iterate a fix). Inputs: session_id, id, addr, space?, bank?, source_path?|bytes?. Returns: the candidate.",
    { session_id: z.string(), id: z.string(), addr: z.number(), space: z.enum(["ram", "roml", "romh"]).optional(), bank: z.number().optional(), source_path: z.string().optional(), bytes: z.array(z.number()).optional() },
    safeHandler("runtime_candidate_patch", async ({ session_id, id, addr, space, bank, source_path, bytes }) => {
      let src = "";
      let b = bytes;
      if (source_path && (!b || b.length === 0)) {
        const projectDir = process.env.C64RE_PROJECT_DIR ?? process.cwd();
        const { assembleSource } = await import("../assemble-source.js");
        const res = await assembleSource({ projectDir, sourcePath: source_path, assembler: "auto" });
        if (res.exitCode !== 0) throw new Error(`assemble failed: ${res.stderr || res.stdout}`);
        const { readFileSync } = await import("node:fs");
        const prg = readFileSync(res.outputPath);
        b = Array.from(prg.subarray(2)); // strip the 2-byte PRG load address
        src = readFileSync(res.sourcePath, "utf8");
      }
      const d = await candidateDaemon();
      const r = await d.call("runtime/candidate_patch", { session_id, id, addr, space: space ?? "ram", bank, source: src, bytes: b ?? [] });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_candidate_run",
    "Run a candidate: restore its baseline anchor, apply ALL its patches, play the bound scenario (deterministic), and AUTO-DIFF (794) vs the no-patch baseline → the verdict 'what did my code change / is it equivalent'. Ephemeral (anchor untouched). Inputs: session_id, id. Returns: {registers, verdict, ranCycles, diff}.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_candidate_run", async ({ session_id, id }) => {
      const d = await candidateDaemon();
      const r = await d.call("runtime/candidate_run", { session_id, id });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_candidate_remove_patch",
    "Remove the overlay patch at (space, bank, addr) from a candidate. Inputs: session_id, id, addr, space?, bank?. Returns: the candidate + removed:bool.",
    { session_id: z.string(), id: z.string(), addr: z.number(), space: z.enum(["ram", "roml", "romh"]).optional(), bank: z.number().optional() },
    safeHandler("runtime_candidate_remove_patch", async ({ session_id, id, addr, space, bank }) => {
      const d = await candidateDaemon();
      const r = await d.call("runtime/candidate_remove_patch", { session_id, id, addr, space: space ?? "ram", bank });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_candidate_list",
    "List candidates (id omitted) or show one candidate's patches + last verdict. Inputs: session_id, id?. Returns: candidate(s).",
    { session_id: z.string(), id: z.string().optional() },
    safeHandler("runtime_candidate_list", async ({ session_id, id }) => {
      const d = await candidateDaemon();
      const r = await d.call("runtime/candidate_list", { session_id, id });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_candidate_delete",
    "Delete a candidate from the session store. Inputs: session_id, id. Returns: {id, deleted}.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_candidate_delete", async ({ session_id, id }) => {
      const d = await candidateDaemon();
      const r = await d.call("runtime/candidate_delete", { session_id, id });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_candidate_export",
    "Export a candidate's accumulated source-patch-set = the delta seed (the code that goes into the real build; the final-delta shaping is a later step). Inputs: session_id, id. Returns: {id, patches:[{space,bank,addr,source}]}.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_candidate_export", async ({ session_id, id }) => {
      const d = await candidateDaemon();
      const r = await d.call("runtime/candidate_export", { session_id, id });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_candidate_derive_delta",
    "Derive the FINAL CODE DELTA from a candidate: turn its exported source-patch-set into a build-ready delta on disk — one .asm per target (each carries its own org) + delta-manifest.json + DELTA.md. The code that goes into the real build (the meaning-bridge payoff). Inputs: session_id, id, out_dir? (default <project>/delta-<id>). Returns: outDir + written files + manifest.",
    { session_id: z.string(), id: z.string(), out_dir: z.string().optional() },
    safeHandler("runtime_candidate_derive_delta", async ({ session_id, id, out_dir }) => {
      const d = await candidateDaemon();
      const exp = (await d.call("runtime/candidate_export", { session_id, id })) as {
        id: string;
        patches: { space: string; bank?: number | null; addr: number; source: string }[];
      };
      const { writeDelta } = await import("../candidate-delta.js");
      const { resolve } = await import("node:path");
      const { safeSegment } = await import("../lib/id-path.js");
      const projectDir = process.env.C64RE_PROJECT_DIR ?? process.cwd();
      // Spec 838 D1 — a candidate id is an identifier, and `delta-<id>` is a
      // directory. Sanitised for the strictest platform we target, not this one.
      const outDir = out_dir ? resolve(projectDir, out_dir) : resolve(projectDir, `delta-${safeSegment(exp.id)}`);
      const res = writeDelta({ id: exp.id, patches: exp.patches ?? [] }, outDir);
      return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_find_cheat",
    "Cheat-candidate finder: diff two checkpoint anchors' full RAM to find addresses that DECREASED (candidate life/health/ammo counters), ranked smallest-delta first. The FINDER half of the cheat loop; verify a candidate by freezing an address (runtime_candidate_patch at that addr with its original value) + runtime_candidate_run to confirm it holds across the scenario. Inputs: session_id, before (anchor before the loss), after (anchor after), max?. Returns: ranked candidates {addr, before, after, delta}.",
    { session_id: z.string(), before: z.string(), after: z.string(), max: z.number().optional() },
    safeHandler("runtime_find_cheat", async ({ session_id, before, after, max }) => {
      const d = await candidateDaemon();
      const r = (await d.call("runtime/find_cheat_candidates", { session_id, before, after, max: max ?? 32 })) as {
        count: number;
        candidates: { addr: number; before: number; after: number; delta: number }[];
      };
      const top = (r.candidates ?? [])
        .slice(0, 8)
        .map((c) => `  $${(c.addr & 0xffff).toString(16).padStart(4, "0")}: ${c.before} → ${c.after} (−${c.delta})`)
        .join("\n");
      const hint = r.count
        ? `\n\nNext: freeze the likeliest counter — create a candidate, runtime_candidate_patch(id, addr, bytes:[<original>]), then runtime_candidate_run to confirm it holds across the scenario.`
        : `\n\nNo RAM decreased between the two anchors — check they bracket the life-loss.`;
      return { content: [{ type: "text" as const, text: `${r.count} cheat candidate(s):\n${top}${hint}\n\n${JSON.stringify(r, null, 2)}` }] };
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
      // Spec 802 — the runtime reads its own store; C64RE has no local reader.
      const rows = await daemonTraceRead<any[]>("query_events", args.duckdb_path, q);
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
      hypothesis: z.string().optional().describe("REQUIRED (read-before-runtime gate): a concrete $address + what you READ that points there. Following a path CONFIRMS a control-flow hypothesis you formed by reading; it is not how you discover it. Fishing (no address / no rationale) is refused — read first (disasm_prg / inspect_address_range / project_search)."),
    },
    safeHandler("runtime_follow_path", async (args) => {
      const { checkRuntimeDiscipline } = await import("./discipline-gate.js");
      const gate = await checkRuntimeDiscipline(args.hypothesis, { tool: "runtime_follow_path", act: "reconstructing the call/branch chain to an event" });
      if (!gate.allowed) return { content: [{ type: "text" as const, text: gate.refusal! }] };
      const q = {
        runId: args.run_id,
        endEventCycle: args.end_event_cycle,
        endEventFamily: args.end_event_family as any,
        endEventKey: JSON.parse(args.end_event_key),
        maxDepth: args.max_depth,
        cycleWindow: args.cycle_window,
        crossDomain: args.cross_domain,
      };
      const chain = await daemonTraceRead<any>("follow_path", args.duckdb_path, q);
      return { content: [{ type: "text", text: JSON.stringify(chain, null, 2) }] };
    }),
  );

  // ---- Swimlane (Spec 234) ----
  server.tool(
    "runtime_swimlane_slice",
    "Return a per-lane (C64 PC / drive PC / IEC / VIA) slice of the trace around a cycle window. Use to compare lanes at a moment of interest. Not for a single-PC search (use trace_store_query). Each C64 step carries a derived `flow` lane (main|irq|nmi); pass `focus` to keep only one (e.g. focus='irq' to see just the interrupt handler). Inputs: run id, cycle window, optional focus. Returns: per-lane events.",
    {
      run_id: z.string(),
      duckdb_path: z.string(),
      cycle_start: z.number(),
      cycle_end: z.number(),
      compact: z.boolean().default(true),
      focus: z.enum(["main", "irq", "nmi"]).optional().describe("keep only rows in this execution-context lane."),
      nmi_vector: z.number().optional().describe("Optional $FFFA target to sharpen NMI-vs-IRQ for an NMI taken from main flow."),
    },
    safeHandler("runtime_swimlane_slice", async (args) => {
      // Spec 802 — the SLICE comes from the runtime (structured); the markdown
      // rendering stays here. Formatting a remote result is not a second reader.
      const { renderMarkdown } = await import("../monitor/swimlane-render.js");
      const slice = await daemonTraceRead<any>(
        "swimlane", args.duckdb_path,
        { run_id: args.run_id, cycle_start: args.cycle_start, cycle_end: args.cycle_end, compact: args.compact, focus: args.focus, nmi_vector: args.nmi_vector },
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
      hypothesis: z.string().optional().describe("REQUIRED (read-before-runtime gate): a concrete $address + what you READ that points there. Taint CONFIRMS a data-flow hypothesis you formed by reading; it is not how you discover where a value comes from. Fishing (no address / no rationale) is refused — read first (disasm_prg / inspect_address_range / project_search)."),
    },
    safeHandler("runtime_trace_taint", async (args) => {
      const { checkRuntimeDiscipline } = await import("./discipline-gate.js");
      const gate = await checkRuntimeDiscipline(args.hypothesis, { tool: "runtime_trace_taint", act: "following data-flow taint" });
      if (!gate.allowed) return { content: [{ type: "text" as const, text: gate.refusal! }] };
      const q = { runId: args.run_id, startCycle: args.start_cycle, startAddr: args.start_addr, maxDepth: args.max_depth, cycleWindow: args.cycle_window };
      const graph = await daemonTraceRead<any>("taint", args.duckdb_path, q);
      return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
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
      hypothesis: z.string().optional().describe("REQUIRED (read-before-runtime gate): a concrete $address + what you READ that points there. A loader profile CONFIRMS a hypothesis about a phase you already located by reading; it is not how you discover the loader's structure. Fishing (no address / no rationale) is refused — read first (disasm_prg / inspect_address_range / project_search)."),
    },
    safeHandler("runtime_profile_loader", async (args) => {
      const { checkRuntimeDiscipline } = await import("./discipline-gate.js");
      const gate = await checkRuntimeDiscipline(args.hypothesis, { tool: "runtime_profile_loader", act: "profiling loader phases/hotspots" });
      if (!gate.allowed) return { content: [{ type: "text" as const, text: gate.refusal! }] };
      const profile = await daemonTraceRead<any>(
        "profile_loader", args.duckdb_path,
        { scenario_id: args.scenario_id, cycle_start: args.cycle_start, cycle_end: args.cycle_end },
      );
      return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
    }),
  );

  // ---- Fingerprint scan (Spec 247) ----
  server.tool(
    "runtime_scan_fingerprints",
    "Match routine bytes against bundled/TREX/local fingerprint libraries. Lookup chain via C64RE_FINGERPRINT_LIBS env.",
    {
      artifact_id: z.string(),
      bytes_hex: z.string().describe("Hex-encoded artifact bytes (no 0x prefix, no spaces)"),
      base_addr: z.number(),
      report_all: z.boolean().default(false),
      min_confidence: z.number().default(0.5),
    },
    safeHandler("runtime_scan_fingerprints", async (args) => {
      const { scanFingerprints } = await import("../analysis/fingerprint.js");
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
    "Add trace bookmark with bind mode (cycle/event-key/both). Persisted in trace store DuckDB.",
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
      const { addBookmark } = await import("../analysis/bookmarks.js");
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
    "List bookmarks for a run.",
    {
      duckdb_path: z.string(),
      run_id: z.string(),
      cycle_start: z.number().optional(),
      cycle_end: z.number().optional(),
    },
    safeHandler("runtime_bookmark_list", async (args) => {
      const { listBookmarks } = await import("../analysis/bookmarks.js");
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
    "LLM-explicit baseline capture for a scenario. Writes baseline.duckdb + ram-end.bin + screenshot.png + meta.json.",
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
    "Compare current scenario run against captured baseline. Returns no_drift / minor_drift / structural_change / broken classification.",
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
    "Render N seconds of the LIVE session's SID audio (reSID) to a stereo s16le 44.1kHz WAV. Use to capture audio from a running integrated session. Exports the LIVE session only; there is no scenario-export tool. Inputs: session_id, out_path, duration_sec. Returns: WAV path + stats.",
    {
      session_id: z.string(),
      out_path: z.string(),
      duration_sec: z.number(),
    },
    safeHandler("runtime_session_export_audio", async ({ session_id, out_path, duration_sec }) => {
      // Runs on the shared machine — the same session the UI drives.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.call("audio/export", { session_id, out_path, duration_sec });
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  // ---- Media browser + mount (Spec 265) ----
  server.tool(
    "runtime_media_list_paths",
    "List configured fs roots for media browser (samples/, $C64RE_PROJECT_DIR, ~/Downloads, user-added).",
    {},
    safeHandler("runtime_media_list_paths", async () => {
      const { listFsRoots } = await import("../media-format/fs-browser.js");
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
      const { browseDir } = await import("../media-format/fs-browser.js");
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
    "Take media OUT of the machine. role=drive8 (default): eject the disk — open the drive door. The running 1541 senses the disk was removed (write-protect line), so this is STEP 1 of answering a game's \"Insert side N\" prompt: unmount, then runtime_session_run a bit to let the drive register the removal, then runtime_media_mount the new side and runtime_session_run again, then runtime_type the RETURN. Dirty sectors are written back first; the drive keeps running. role=cartridge: PULL THE CARTRIDGE. Programmed flash/EEPROM is written back to the host .crt first, then the cart comes out, and pulling a cart COLD-RESETS the machine — that is what it does on real hardware, so RAM is gone and the C64 boots to BASIC. To save the flash and keep playing, use runtime_media_persist role=cartridge instead. role=auto: whatever is actually in the machine (cartridge first, else the disk). Use to remove media or to begin a hardware-style side-swap. Not for the first mount (use runtime_media_mount). Inputs: session_id, role. Returns: eject result.",
    {
      session_id: z.string().describe("Session to take the media out of — \"shared\" is the live machine the human is watching"),
      slot: z.number().int().default(8).describe("Drive slot for role=drive8: 8 (primary) or 9. Meaningless for a cartridge, which has no drive number."),
      role: z.enum(["drive8", "cartridge", "auto"]).default("drive8").describe("What to take out: drive8 = the disk (drive keeps running), cartridge = pull the cart (persists flash, then COLD-RESETS the machine), auto = whatever is in there (cartridge first, else the disk)."),
    },
    safeHandler("runtime_media_unmount", async ({ session_id, slot, role }) => {
      // Spec 839 / issue #18 — the slot guard is about a DRIVE. A cartridge has no
      // drive number, so demanding 8-or-9 for one refused the only op that pulls it:
      // the daemon has taken role "cartridge" (and slot 0, and "auto") since the UI
      // needed it, and this tool was the single door that said no.
      if (role === "drive8") {
        if (slot !== 8 && slot !== 9) throw new Error(`slot must be 8 or 9, got ${slot}`);
        if (slot === 9) throw new Error("drive 9 not supported in v1 (drive8-only)");
      }
      // Spec 744.4c slice 2b — eject via the one abstract media op.
      const result = await mediaIngress(session_id, { kind: "eject", role });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }),
  );

  server.tool(
    "runtime_media_persist",
    "Write mounted media's in-RAM state back to its host backing file WITHOUT ejecting. role=drive8 (default): flushes drive-side GCR writes → the .d64/.g64 on disk, atomically; host mtime changes. role=cartridge: re-packs the programmed cartridge flash/EEPROM → the host .crt (EasyFlash etc.) — the only way to save flash AND keep playing, since unmounting a cartridge pulls it (cold reset). Use to save a game's disk writes (format/copy/save) or EAPI flash writes while keeping the media mounted. Not for ejecting (use runtime_media_unmount, which persists then ejects) or for a session snapshot (use runtime_checkpoint_capture). Read-only / non-dirty media is never overwritten. Inputs: session_id, role. Returns: { written, path, bytes } or the reason it was skipped.",
    {
      session_id: z.string(),
      slot: z.number().int().default(8),
      role: z.enum(["drive8", "cartridge"]).default("drive8"),
    },
    safeHandler("runtime_media_persist", async ({ session_id, slot, role }) => {
      if (role === "drive8" && slot !== 8 && slot !== 9) throw new Error(`slot must be 8 or 9, got ${slot}`);
      // Spec 744.4c slice 2c — persist the shared session's disk to its host file.
      // Write-through (Spec 742) is preserved: the backing path was set absolute at
      // mount time, so the daemon (localhost) writes the CALLER's .d64/.g64.
      // role=cartridge runs the same cartridge persist as the eject path
      // (BUG-023-cart) — flash → host .crt, cart stays attached.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const result = await runtimeDaemon.mediaPersist(session_id, slot, role);
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

  server.tool(
    "runtime_swap_disk_and_continue",
    "Answer a game's \"Insert side N. (RETURN)\" prompt in ONE call, the hardware way: eject the old disk → run so the 1541 senses the removal → insert the new disk → run so it senses the insertion → press RETURN → run on so the prompt advances. Use this for a multi-disk title that WAITS for a side-swap. Not for a title that isn't waiting (use runtime_media_swap for the atomic path, which gives the drive no cycles to sense the change). Read the screen first (runtime_render_screen) to know which side is asked for. Inputs: session_id, path (new image), optional confirm_input (default RETURN), settle_cycles, post_cycles. Returns: { mounted, screenBefore, screenAfter, promptCleared, advanced }.",
    {
      session_id: z.string(),
      path: z.string().describe("Absolute path to the new disk image (the side to insert)"),
      confirm_input: z.string().optional().describe("Key(s) to answer the prompt; default RETURN (\\r). Empty = no key."),
      settle_cycles: z.number().int().optional().describe("Cycles to run after eject AND after insert so the drive senses the change (default 1.5M)"),
      post_cycles: z.number().int().optional().describe("Cycles to run after the confirm key (default 4M)"),
    },
    safeHandler("runtime_swap_disk_and_continue", async ({ session_id, path, confirm_input, settle_cycles, post_cycles }) => {
      const abs = resolveCallerMediaPath(path);
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const result = await runtimeDaemon.swapDiskAndContinue(session_id, abs, { confirm_input, settle_cycles, post_cycles });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }),
  );

  // ---- Spec 264 — Input (keyboard + joystick) tools ----

  server.tool(
    "runtime_input_load_vicerc",
    "ADVANCED. Use to parse a legacy `vicerc` emulator config and read its joystick keyset bindings (KeySet2*, JoyDevice2), to bootstrap a c64re config from pre-existing settings. Not for the c64re config file (use runtime_input_load_config) or saving (use runtime_input_save_config).",
    { vicerc_path: z.string().optional() },
    safeHandler("runtime_input_load_vicerc", async ({ vicerc_path }) => {
      const { loadVicerc } = await import("../input/vicerc-loader.js");
      const cfg = loadVicerc(vicerc_path);
      return { content: [{ type: "text", text: JSON.stringify(cfg, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_input_load_config",
    "Read the resolved host-key → C64-action map for a project: which key on the HUMAN's keyboard drives which joystick direction or C64 key, merged from three levels (built-in default → the human's global ~/.config/c64re/input.json → <project>/runtime/input.json) with the SOURCE of each binding reported, so \"why is fire on M here\" is answerable without opening two files. Use it before driving input, or to explain a mapping. Note the runtime itself has no keyset — it takes actions (session/key_down, session/joystick_set), and the mapping belongs to each client; this is C64RE's. Not for changing one (use runtime_input_save_config). Inputs: optional project_dir. Returns: { bindings: [{action, code, source}], conflicts, swallowedByJoystick, paths }.",
    {
      project_dir: z.string().optional().describe("Project whose overrides to apply. Omitted: C64RE_PROJECT_DIR, i.e. the project this server was started for."),
      vicerc_path: z.string().optional().describe("ADVANCED. Seed the global level from a legacy VICE `vicerc` keyset when no global file exists yet."),
    },
    safeHandler("runtime_input_load_config", async ({ project_dir, vicerc_path }) => {
      const { resolveKeyset, conflicts, swallowedByJoystick, globalKeysetPath, projectKeysetPath } =
        await import("../input/keyset.js");
      const projectDir = project_dir ?? process.env.C64RE_PROJECT_DIR ?? process.cwd();
      const bindings = resolveKeyset({ projectDir });
      const { loadInputConfig } = await import("../input/input-config.js");
      // The gamepad + keyboard-mode halves are still the Spec 264 config's, and stay
      // global on purpose: they are properties of the human's hardware, not the game.
      const legacy = loadInputConfig({ vicercPath: vicerc_path });
      return { content: [{ type: "text", text: JSON.stringify({
        bindings,
        conflicts: conflicts(bindings),
        swallowedByJoystick: swallowedByJoystick(bindings),
        paths: { global: globalKeysetPath(), project: projectKeysetPath(projectDir) },
        keyboardMode: legacy.keyboardMode,
        gamepad: legacy.gamepad,
      }, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_input_save_config",
    "Bind ONE C64 action to ONE host key, or clear that binding so it falls back a level. Writes only the override — a level never stores a copy of the whole map, because a copy drifts the moment the level below changes. scope=project (default) writes <project>/runtime/input.json, the game's own mapping; scope=global writes ~/.config/c64re/input.json, the human's preference across projects. Use it to move a joystick direction off a letter the game needs to type (the Ultima VI case: keyboard AND stick at once). Not for reading the map (use runtime_input_load_config). Never touches vicerc. Inputs: action, code (omit to clear), scope, project_dir. Returns: the level's bindings after the write.",
    {
      action: z.object({
        kind: z.enum(["joystick", "key"]).describe("joystick = a direction or fire on a port; key = a C64 matrix key"),
        port: z.union([z.literal(1), z.literal(2)]).optional().describe("joystick only: control port 1 or 2"),
        bit: z.enum(["up", "down", "left", "right", "fire"]).optional().describe("joystick only: which direction, or fire"),
        matrix: z.string().optional().describe("key only: the C64 matrix name — \"A\", \"F1\", \"RUN_STOP\", the same vocabulary session/key_down takes"),
      }).describe("What the C64 should do — the binding is action ← key, so you start from what the GAME needs"),
      code: z.string().optional().describe("The host key, as a browser KeyboardEvent.code: \"KeyW\", \"Space\", \"Numpad8\", \"ArrowUp\". OMIT to clear this level's override so the action falls back to the level below."),
      scope: z.enum(["global", "project"]).default("project").describe("Where the binding lands: project = this game's mapping (default), global = the human's own across all projects"),
      project_dir: z.string().optional().describe("Project to write to when scope=project. Omitted: C64RE_PROJECT_DIR."),
    },
    safeHandler("runtime_input_save_config", async ({ action, code, scope, project_dir }) => {
      const { setBinding, clearBinding, globalKeysetPath, projectKeysetPath, actionLabel } =
        await import("../input/keyset.js");
      const a = action.kind === "joystick"
        ? { kind: "joystick" as const, port: (action.port ?? 2) as 1 | 2, bit: action.bit ?? "up" }
        : { kind: "key" as const, matrix: action.matrix ?? "" };
      if (a.kind === "joystick" && !action.bit) throw new Error("action.bit required for a joystick binding (up|down|left|right|fire)");
      if (a.kind === "key" && !a.matrix) throw new Error("action.matrix required for a key binding (e.g. \"RUN_STOP\")");
      const projectDir = project_dir ?? process.env.C64RE_PROJECT_DIR ?? process.cwd();
      const path = scope === "global" ? globalKeysetPath() : projectKeysetPath(projectDir);
      const bindings = code ? setBinding(path, a, code) : clearBinding(path, a);
      const verb = code ? `${actionLabel(a)} <- ${code}` : `cleared ${actionLabel(a)}`;
      return { content: [{ type: "text", text: `${verb}\n${path}\n${JSON.stringify(bindings, null, 2)}` }] };
    }),
  );

  // ---- Spec 268 — Scenario registry ----

  server.tool(
    "runtime_scenario_list",
    "List scenarios from samples/scenarios/ and $C64RE_PROJECT_DIR/scenarios/. Returns summaries sorted by date.",
    {},
    safeHandler("runtime_scenario_list", async () => {
      // Spec 806 step 2 — the scenario registry lives in the runtime: it owns the
      // project `scenarios/` dir and merges its in-memory copies over the disk scan.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const scenarios = await runtimeDaemon.call("runtime/scenario_list", {});
      return { content: [{ type: "text", text: JSON.stringify(scenarios, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_scenario_save",
    "Save a scenario JSON to project dir (or samples if no project dir). Returns file path.",
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
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const scenario: any = { id, diskPath, mode, cycleBudget, inputs, startSnapshot: startSnapshot ?? "" };
      const r = await runtimeDaemon.call<{ id: string; filePath?: string }>("runtime/scenario_save", { scenario });
      // The runtime writes into ITS project's `scenarios/` dir (the MCP starts it
      // with --project, so that is the caller's). A runtime started without one
      // keeps the scenario in memory and returns no path — say so rather than
      // printing "saved to undefined".
      return { content: [{ type: "text", text: r.filePath ? `saved to ${r.filePath}` : `saved ${r.id} (in memory — the runtime has no project scenarios dir)` }] };
    }),
  );

  server.tool(
    "runtime_scenario_load",
    "Load a single scenario by id. Checks project dir first, then samples.",
    { id: z.string() },
    safeHandler("runtime_scenario_load", async ({ id }) => {
      // The runtime raises `scenario '<id>' not found` itself — same message.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const s = await runtimeDaemon.call("runtime/scenario_load", { id });
      return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_scenario_delete",
    "Delete a scenario JSON by id. Returns true if found and removed.",
    { id: z.string() },
    safeHandler("runtime_scenario_delete", async ({ id }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const { deleted } = await runtimeDaemon.call<{ deleted: boolean }>("runtime/scenario_delete", { id });
      return { content: [{ type: "text", text: deleted ? `deleted ${id}` : `${id} not found` }] };
    }),
  );

  server.tool(
    "runtime_snapshot_tree",
    "Use to see the full branch tree of a rewind session — which checkpoints branch where. Not for capturing a checkpoint (use runtime_checkpoint_capture) or seeking/restoring one (use runtime_rewind). Requires a session with an active RewindManager.",
    { session_id: z.string() },
    safeHandler("runtime_snapshot_tree", async ({ session_id }) => {
      // Spec 744.4c slice 2c — runtime/snapshot_tree sets scenarioId+diskPath+mode
      // for beginRewindSession (the facade verb does NOT, and throws). Same shared
      // session as the UI.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const tree = await runtimeDaemon.snapshotTree(session_id);
      return { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_promote_branch",
    "Use to keep a transient rewind branch as a persistent, replayable Scenario record. Not for a durable machine-state file (the runtime's .c64re dump) or capturing a checkpoint (use runtime_checkpoint_capture).",
    { session_id: z.string(), branch_id: z.string() },
    safeHandler("runtime_promote_branch", async ({ session_id, branch_id }) => {
      // Spec 744.4c slice 2c — runtime/promote_branch on the shared session.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.promoteBranch(session_id, branch_id);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_run_scenario",
    "Replay a saved scenario by id, returns ReplayResult hashes.",
    { id: z.string() },
    safeHandler("runtime_run_scenario", async ({ id }) => {
      // Spec 806 step 2 — deterministic replay in the runtime: it looks the id up in
      // its own registry and returns the ReplayResult. The load + startSnapshot
      // decoding that used to happen here is the runtime's, on the far side of the id.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const result = await runtimeDaemon.call("runtime/scenario_run", { id });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }),
  );

  // ---- Spec 271 — Parallel batch scenario runner ----

  server.tool(
    "runtime_run_scenarios_parallel",
    "Replay several scenarios as one batch. Returns batchId + progress for polling.",
    {
      scenario_ids: z.array(z.string()).min(1),
      worker_count: z.number().int().min(1).optional(),
    },
    safeHandler("runtime_run_scenarios_parallel", async ({ scenario_ids, worker_count }) => {
      // Spec 806 step 2 — the batch runner is the runtime's (`batch/start`), which
      // owns the scenario registry the ids resolve against and pushes the same
      // batch/progress notifications. Poll it with runtime_batch_status.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const entry = await runtimeDaemon.call("batch/start", {
        scenarioIds: scenario_ids,
        workerCount: worker_count,
      });
      return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_batch_status",
    "Poll progress of a parallel batch. Returns completed / total and status.",
    { batch_id: z.string() },
    safeHandler("runtime_batch_status", async ({ batch_id }) => {
      // The runtime raises `batch '<id>' not found` itself — same message.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const entry = await runtimeDaemon.call("batch/status", { batchId: batch_id });
      return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_batch_results",
    "Collect ReplayResult per scenario once batch is done. Errors per-scenario included.",
    { batch_id: z.string() },
    safeHandler("runtime_batch_results", async ({ batch_id }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.call<{ batch: { status?: string; completed?: number; total?: number } }>(
        "batch/results", { batchId: batch_id },
      );
      if (r.batch?.status === "running") throw new Error(`batch '${batch_id}' still running (${r.batch.completed}/${r.batch.total})`);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  // ---- Spec 269 — export: RETIRED (Spec 806 step 3) ----
  //
  // `runtime_export_{screenshot,video,audio}` replayed a saved SCENARIO from its
  // start to a cycle in an in-process TS machine and wrote a PNG / MP4 / WAV.
  // There is no `export/*` method group on the daemon: `session/screenshot` +
  // `runtime/render_screen` give the LIVE frame (no scenario, no cycle, no scale)
  // and `audio/export` renders the LIVE session's SID (that is
  // `runtime_session_export_audio`, which stays). Composing scenario_run +
  // render_screen would be a new feature wearing an old tool's name, so the three
  // retire with the emulator. All three were ADVANCED-only. (Spec 806 §7.2)

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
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.vicInspectAt(session_id, x, y, checkpoint_id);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }),
  );

  // ── Spec 839 — the rest of the Visual-Origin Join (Spec 721) ────────────────
  //
  // `runtime_vic_inspect_at` resolves ONE pixel. The human's UI has had the other
  // two halves since Spec 710/721 — a region, and the join from a visible thing to
  // where it CAME FROM — and the LLM had neither, so "what draws this?" was a
  // question only a human could ask of a running machine.
  //
  // Both stay MCP tools rather than monitor verbs: they answer with a node list and
  // an asset match, and rendering that as monitor text would flatten exactly the
  // structure a caller needs.
  //
  // `vic/inspect/promote` and `/evidence` are deliberately NOT exposed. Promote
  // stores evidence in the DAEMON's session, which dies with it; C64RE's half of the
  // Leitregel is meaning and memory, and that door is `save_finding` into the graph.
  // Two evidence stores in front of one LLM is how findings get lost.

  /** Region and origin both need a retained checkpoint, and `at_capture` is the one
   *  place that captures + pins one. A caller without an id gets it from there, so
   *  the capture policy stays in the daemon and does not fork. */
  const checkpointFor = async (session_id: string, x: number, y: number, given?: string): Promise<string> => {
    if (given) return given;
    const { runtimeDaemon } = await import("../runtime/daemon-client.js");
    const r = await runtimeDaemon.vicInspectAt<{ checkpointId?: string }>(session_id, x, y);
    if (!r?.checkpointId) throw new Error("could not capture a checkpoint to inspect (is the session running?)");
    return r.checkpointId;
  };

  server.tool(
    "runtime_vic_inspect_region",
    "Resolve a RECTANGLE of the frozen display to the distinct sources drawing it — the screen/colour/charset/bitmap/sprite refs behind every pixel in the box, deduplicated to a node list. Use it to ask what an on-screen OBJECT is made of (a sprite, a status panel, a tile) instead of probing pixel by pixel. Not for one pixel (use runtime_vic_inspect_at) and not for where the bytes came FROM (use runtime_vic_origin). Coordinates are VISIBLE-frame pixels, 0..384 x 0..272 with the border included — NOT the 0..319 x 0..199 display frame runtime_vic_inspect_at uses. Inputs: session_id, x, y, width, height, optional checkpoint_id. Returns: { nodes }.",
    {
      session_id: z.string().describe("Session to inspect — \"shared\" is the live machine the human is watching"),
      x: z.number().describe("Left edge, VISIBLE-frame pixels (0..384, border included)"),
      y: z.number().describe("Top edge, VISIBLE-frame pixels (0..272, border included)"),
      width: z.number().describe("Box width in visible-frame pixels"),
      height: z.number().describe("Box height in visible-frame pixels"),
      checkpoint_id: z.string().optional().describe("Inspect this retained checkpoint. Omitted: capture and pin a fresh one from the live machine (which pauses it), the same way runtime_vic_inspect_at does."),
    },
    safeHandler("runtime_vic_inspect_region", async ({ session_id, x, y, width, height, checkpoint_id }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const cp = await checkpointFor(session_id, x, y, checkpoint_id);
      const r = await runtimeDaemon.vicInspectRegion(session_id, cp, { x, y, width, height });
      return { content: [{ type: "text", text: JSON.stringify({ checkpointId: cp, ...(r as object) }, null, 2) }] };
    }),
  );

  server.tool(
    "runtime_vic_origin",
    "The Visual-Origin Join: take a pixel of the frozen picture and answer where the bytes behind it CAME FROM — the VIC/RAM node, then an exact byte-hash match against the mounted medium (sprite / charset / bitmap blocks), plus what the project already knows about that asset. Use it to tie something visible on screen back to a file, a sector and a disassembly. Not for what a pixel IS right now (use runtime_vic_inspect_at) and not for a whole object's composition (use runtime_vic_inspect_region). With nothing mounted the match set is empty and the answer says runtime_generated — that is an honest answer, not a failure. Coordinates are VISIBLE-frame pixels, 0..384 x 0..272 with the border included — NOT the display frame runtime_vic_inspect_at uses. Inputs: session_id, x, y, optional checkpoint_id. Returns: { node, classification, result, knowledge, medium }.",
    {
      session_id: z.string().describe("Session to inspect — \"shared\" is the live machine the human is watching"),
      x: z.number().describe("Pixel x, VISIBLE-frame (0..384, border included)"),
      y: z.number().describe("Pixel y, VISIBLE-frame (0..272, border included)"),
      checkpoint_id: z.string().optional().describe("Inspect this retained checkpoint. Omitted: capture and pin a fresh one from the live machine (which pauses it)."),
    },
    safeHandler("runtime_vic_origin", async ({ session_id, x, y, checkpoint_id }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const cp = await checkpointFor(session_id, x, y, checkpoint_id);
      const r = await runtimeDaemon.vicOrigin(session_id, cp, x, y);
      return { content: [{ type: "text", text: JSON.stringify({ checkpointId: cp, ...(r as object) }, null, 2) }] };
    }),
  );
}
