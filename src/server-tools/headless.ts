import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
// Spec 723.4b: standalone HeadlessSessionManager + its record formatters retired.
import { findHeadlessTraceByAccess, findHeadlessTraceByPc, loadHeadlessSession, sliceHeadlessTraceByIndex } from "../runtime/headless/trace-query.js";
import { buildHeadlessTraceIndex } from "../runtime/headless/trace-index.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

function parseHexWord(value: string): number {
  const normalized = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,4}$/.test(normalized)) {
    throw new Error(`Invalid 16-bit hex value: ${value}`);
  }
  return parseInt(normalized, 16);
}

function formatHexWord(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function formatHexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function resolveHeadlessProjectDir(context: ServerToolContext, hintPath?: string): string {
  // Spec 723.4b: no longer consults the standalone HeadlessSessionManager.
  if (hintPath) {
    return context.projectDir(hintPath, true);
  }
  return context.projectDir(undefined, true);
}

// Spec 723.4b: headlessSessionToContent + headlessRunResultToContent removed —
// they formatted the retired standalone HeadlessSessionManager records.

async function resolveHeadlessTraceProjectDir(context: ServerToolContext): Promise<string> {
  // Spec 723.4b: no longer consults the standalone HeadlessSessionManager.
  return context.projectDir(undefined, true);
}

function formatHeadlessTraceMatch(match: { index: number; pc: number; bytes: number[]; trap?: string }): string {
  return `${match.index}: ${formatHexWord(match.pc)} [${match.bytes.map(formatHexByte).join(" ")}]${match.trap ? ` ${match.trap}` : ""}`;
}

export function registerHeadlessTools(server: McpServer, context: ServerToolContext): void {
  // Spec 723.4b: the standalone-session interrupt tools (headless_interrupt_request,
  // headless_io_interrupt_trigger, headless_interrupt_clear) were retired — they
  // drove the legacy Cpu6510-based HeadlessSessionManager, had no programmatic
  // caller, and have no IntegratedSession equivalent. No interrupt-injection was
  // added to IntegratedSession.

  // Spec 062 Sprint 63: drive-emulation tools.
  // headless_drive_session_start opens a 1541 drive session backed by
  // a G64 disk image. headless_drive_status / headless_iec_bus_state
  // query state. headless_drive_persist_writes flushes modifications
  // to <image>_session.g64.
  server.tool(
    "runtime_drive_session_start",
    "Spec 062 / R28 L3: open a standalone 1541 drive emulation session backed by a G64 image. Returns a session id usable with the other headless_drive_* tools. Drive emulation runs cycle-accurately with full 6522 VIA + IEC bus modelling. The drive boots via its bundled DOS ROM (resources/roms/dos1541-...bin). For test/runtime tracing of custom loaders and save-game RE.",
    {
      disk_path: z.string().describe("Path to the G64 disk image."),
      start_track: z.number().int().min(1).max(40).optional().describe("Starting track for the head (default 18)."),
      device_id: z.number().int().min(8).max(11).optional().describe("Drive device id 8-11; default 8."),
      pal: z.boolean().optional().describe("PAL timing if true (default), NTSC if false."),
      write_protected: z.boolean().optional().describe("If true, drive treats the image as write-protected."),
    },
    safeHandler("runtime_drive_session_start", async ({ disk_path, start_track, device_id, pal, write_protected }) => {
      const { startDriveSession } = await import("../runtime/headless/drive1541/drive-session-manager.js");
      const record = startDriveSession({
        diskPath: disk_path,
        startTrack: start_track,
        deviceId: device_id,
        isPal: pal,
        writeProtected: write_protected,
      });
      return {
        content: [{
          type: "text" as const,
          text: [
            `Drive session started.`,
            `Session: ${record.sessionId}`,
            `Disk: ${record.diskPath}`,
            `Started: ${record.startedAt}`,
            `Head: track ${record.drive.debugProbe().current_track}`,
            `Drive: VICE1541 (vice-backed standalone session)`,
          ].join("\n"),
        }],
      };
    },
));

  server.tool(
    "runtime_drive_status",
    "Spec 062 Sprint 63: snapshot of a drive session's CPU registers + head position + IRQ pending bits. Use after running drive code to verify state.",
    {
      session_id: z.string(),
    },
    safeHandler("runtime_drive_status", async ({ session_id }) => {
      const { getDriveSession } = await import("../runtime/headless/drive1541/drive-session-manager.js");
      const record = getDriveSession(session_id);
      if (!record) throw new Error(`No drive session ${session_id}`);
      // Spec 704 §11 R3 — vice drive probe. VIA IFR/IER + track-buffer
      // dirty state are not surfaced by the facade probe (parity gap).
      const p = record.drive.debugProbe();
      return {
        content: [{
          type: "text" as const,
          text: [
            `Drive session: ${session_id}`,
            `Disk: ${record.diskPath}`,
            `CPU: PC=${formatHexWord(p.drive_pc)} A=${formatHexByte(p.drive_a)} X=${formatHexByte(p.drive_x)} Y=${formatHexByte(p.drive_y)} SP=${formatHexByte(p.drive_sp)} P=${formatHexByte(p.drive_flags)} cycles=${p.drive_clk}`,
            `Head: track ${p.current_track} (half-track ${p.head_halftrack})`,
            `LED: ${p.led !== 0 ? "on" : "off"}`,
          ].join("\n"),
        }],
      };
    },
));

  server.tool(
    "runtime_iec_bus_state",
    "Spec 062 Sprint 63: dump current IEC bus pin state for a drive session — line state (open-collector wired-AND result) plus each driver's contribution. Useful for debugging custom loader bit-bang protocols.",
    {
      session_id: z.string(),
    },
    safeHandler("runtime_iec_bus_state", async ({ session_id }) => {
      const { getDriveSession } = await import("../runtime/headless/drive1541/drive-session-manager.js");
      const record = getDriveSession(session_id);
      if (!record) throw new Error(`No drive session ${session_id}`);
      // Spec 704 §11 R3 — vice drive-side IEC sample. A standalone session
      // has no C64 driver, so the wired-AND line state isn't composed here;
      // the vice facade exposes the drive's open-collector pulls.
      const s = record.drive.iecLineSample();
      const fmt = (pull: boolean) => pull ? "PULLED LOW (0)" : "released (1)";
      return {
        content: [{
          type: "text" as const,
          text: [
            `IEC bus state — session ${session_id} (drive side, vice)`,
            ``,
            `Drive driver:`,
            `  CLK:     ${fmt(s.drv_clk_pull)}`,
            `  DATA:    ${fmt(s.drv_data_pull)}`,
            `  ATN_ACK: ${fmt(s.drv_atna_pull)}`,
          ].join("\n"),
        }],
      };
    },
));

  // Spec 062 Sprint 65: integrated C64+drive session.
  // Real KERNAL/BASIC/CHARROM loaded so LISTEN/SECOND/CIOUT/UNLSN
  // bit-bang $DD00, drive sees it via IEC bus, drive ROM responds.
  // Path to Murder boot trace.
  server.tool(
    "runtime_session_start",
    "Start a headless C64+1541 session — the product runtime (real KERNAL/BASIC, VICE-shaped 1541, event-catchup). Use to begin a runtime session for loading/running/inspecting a title. Pass trace_out=<path> (+ optional trace_domains=['c64-cpu','memory',...]) to stream a persistent trace.duckdb across the session; then drive with runtime_session_run / runtime_until, stamp phases with runtime_mark, read the live screen with runtime_render_screen, finalize the trace with runtime_trace_finalize, query offline with trace_store_* / runtime_query_events, and runtime_session_close when done (else the session keeps running and pegs a core). Not for the VICE oracle (use vice_*, advanced). ONE MACHINE PER PROCESS: a daemon process runs exactly ONE live machine — the human's UI and you co-drive the SAME session (shared-attach). Before starting, list/status existing sessions and attach to one instead; a SECOND in-process session is NOT isolated — it rebinds the process-global VIC/drive and corrupts the first session's rendering (boot text goes black) until a process restart. For a truly isolated machine (e.g. a throwaway build test) use a SEPARATE backend process. Inputs: disk_path; optional device_id, pal, trace_out, trace_domains. Returns: session id + resolved config + trace status when streaming.",
    {
      disk_path: z.string(),
      device_id: z.number().int().min(8).max(11).optional(),
      pal: z.boolean().optional(),
      start_track: z.number().int().min(1).max(40).optional(),
      write_protected: z.boolean().optional(),
      // Spec 723.2/723.4a: neither useCycleLockstep nor useMicrocodedCpu is a
      // product/workflow param — the runtime is true-drive + microcoded
      // unconditionally. Neither is exposed here.
      // Spec 093: diagnostic ring buffers.
      trace_iec: z.boolean().optional(),
      trace_iec_capacity: z.number().int().min(8).max(65536).optional(),
      trace_drive: z.boolean().optional(),
      trace_drive_capacity: z.number().int().min(8).max(65536).optional(),
      // Spec 093: KERNAL trap toggles (default false for real serial).
      enable_kernal_fileio_traps: z.boolean().optional(),
      enable_kernal_serial_traps: z.boolean().optional(),
      enable_kernal_io_traps: z.boolean().optional(),
      // Spec 726: persistent runtime trace. When set, the session streams a
      // durable trace.duckdb (query later with trace_store_* / runtime_query_events).
      trace_out: z.string().optional().describe("Path (abs or under the project) for the trace.duckdb. Enables persistent streaming trace capture."),
      trace_domains: z.array(z.enum(["c64-cpu", "drive8-cpu", "iec", "vic", "memory"])).optional().describe("Which domains to capture (default c64-cpu + memory). Enables the matching passive producers."),
    },
    safeHandler("runtime_session_start", async ({
      disk_path, device_id, pal, start_track, write_protected,
      trace_iec, trace_iec_capacity, trace_drive, trace_drive_capacity,
      enable_kernal_fileio_traps, enable_kernal_serial_traps, enable_kernal_io_traps,
      trace_out, trace_domains,
    }) => {
      // Spec 744.4c — when a Runtime Daemon endpoint is configured, the product MCP
      // creates the session IN THE DAEMON (the one process-stable authority the UI
      // also uses), NOT a private session in the MCP process. The LLM still sees
      // this stable tool; the daemon owns the IntegratedSession.
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        // Spec 744.4c — the daemon is a PROJECT-AGNOSTIC runtime host: it may serve
        // several projects at once. The session must be self-describing, so the MCP
        // resolves every path to ABSOLUTE against ITS OWN project context here and
        // hands the daemon already-resolved paths. The daemon then resolves nothing
        // against its own spawn-project (resolveTraceOut passes absolute through), so
        // the disk + the trace.duckdb always land in the *caller's* project — not the
        // daemon's. (projectDir-at-spawn below is only the daemon's default-session /
        // UI base; it is not load-bearing for MCP-created sessions.)
        const mcpProject = (() => { try { return resolveHeadlessProjectDir(context); } catch { return undefined; } })();
        const { resolveTraceOut } = await import("./runtime-trace-sink.js");
        // Resolve to ABSOLUTE the same way the trace path is (absolute as-is, else
        // under the MCP's project). NOTE: context.projectDir() returns the project
        // ROOT, not a resolved file path — it is the wrong tool for this.
        const absDisk = disk_path
          ? (resolve(mcpProject ?? process.cwd(), disk_path))
          : disk_path;
        const absTraceOut = trace_out ? resolveTraceOut(trace_out, mcpProject) : undefined;
        // Seed the auto-spawn base so a daemon we start lives in a real project.
        runtimeDaemon.setProjectDir(mcpProject);
        const r = await runtimeDaemon.createSession({ disk_path: absDisk, device_id, pal, start_track, write_protected, trace_out: absTraceOut, trace_domains });
        const lines = [
          `Integrated session started (Runtime Daemon — shared with the UI).`,
          `Session: ${r.sessionId}`,
          `Disk: ${absDisk ?? "(none)"}`,
          `Mode: ${r.mode}`,
          `C64 cycles: ${r.c64Cycles}  PC: ${formatHexWord(r.pc)}`,
        ];
        const t = r.trace as { outputPath?: string; domains?: string[]; runId?: string } | null;
        if (t?.runId) lines.push(`Trace: streaming → ${t.outputPath} [${(t.domains ?? []).join(",")}] run=${t.runId}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }
      // Spec 744.4 — in-process authority (tests / no daemon). Create the session
      // through the single runtime authority, NOT startIntegratedSession directly.
      const { runtimeSessions } = await import("../runtime/headless/runtime-session-service.js");
      const { producerOptsForDomains, startSessionTrace, resolveTraceOut, DEFAULT_TRACE_DOMAINS } =
        await import("./runtime-trace-sink.js");
      const warnings: string[] = [];
      // Spec 726: trace producers are passive (proven by smoke-trace-sink) — they
      // do NOT change emulator behaviour, only emit events for the sink.
      const traceDomains = trace_out ? (trace_domains ?? DEFAULT_TRACE_DOMAINS) : [];
      const traceProducers = trace_out ? producerOptsForDomains(traceDomains) : {};
      // Spec 723.4a: the product runtime is true-drive + microcoded
      // unconditionally — no useCycleLockstep / useMicrocodedCpu inputs.
      const { sessionId, session } = runtimeSessions.start({
        diskPath: disk_path, deviceId: device_id, isPal: pal,
        startTrack: start_track, writeProtected: write_protected,
        traceIec: trace_iec ?? traceProducers.traceIec,
        traceIecCapacity: trace_iec_capacity,
        traceDrive: trace_drive ?? traceProducers.traceDrive,
        traceDriveCapacity: trace_drive_capacity,
        enableBusAccessTrace: traceProducers.enableBusAccessTrace,
        enableKernalFileIoTraps: enable_kernal_fileio_traps,
        enableKernalSerialTraps: enable_kernal_serial_traps,
        enableKernalIoTraps: enable_kernal_io_traps,
      });
      session.resetCold();
      // Spec 726: start streaming the trace AFTER cold reset (cycleStart = post-reset).
      let traceLine = "";
      if (trace_out) {
        const proj = (() => { try { return resolveHeadlessProjectDir(context); } catch { return undefined; } })();
        const outPath = resolveTraceOut(trace_out, proj);
        const t = await startSessionTrace(sessionId, session, outPath, traceDomains);
        traceLine = `Trace: streaming → ${t.outputPath} [${t.domains.join(",")}] run=${t.runId}`;
      }
      const status = session.status();
      const lines: string[] = [
        `Integrated session started.`,
        `Session: ${sessionId}`,
        `Disk: ${disk_path}`,
        `Image format: ${status.runtime.imageFormat}`,
        `Mode: ${status.runtime.mode} (traps=${status.runtime.modeReport.traps} microcoded=${status.runtime.modeReport.microcoded} channels=${status.runtime.modeReport.channels})`,
        `Runtime: event-catchup (CPU: microcoded Cpu65xxVice)`,
        `Drive clock ratio: ${status.runtime.driveClockRatio.toFixed(6)} (drive cycles per C64 cycle)`,
        `KERNAL traps: fileio=${status.runtime.enableKernalFileIoTraps} serial=${status.runtime.enableKernalSerialTraps} io=${status.runtime.enableKernalIoTraps}`,
        `IEC trace: ${status.runtime.iecTraceEnabled ? "ON" : "off"}  Drive PC trace cap: ${status.runtime.drivePcTraceCapacity}`,
        `C64 ROMs: kernal=${status.romSet.kernal}, basic=${status.romSet.basic}, charrom=${status.romSet.charRom}`,
        `C64 PC after cold reset: ${formatHexWord(status.c64.pc)}`,
        `Drive PC after reset: ${formatHexWord(status.drive.pc)}`,
        `Drive head: track ${status.drive.track}`,
      ];
      if (traceLine) lines.push(traceLine);
      if (warnings.length > 0) lines.push("", ...warnings);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
));

  server.tool(
    "runtime_session_run",
    "Advance a session up to N C64 instructions (drive runs proportional cycles), with optional breakpoints / cycle budget / named stop condition. Use to step the machine forward. When the session has a streaming trace active (runtime_session_start trace_out=...), this run automatically chunks + drains the trace queue to trace.duckdb between chunks (behaviour-neutral). Not for run-to-PC only (use runtime_until) or for phase markers (use runtime_mark between calls). Inputs: session_id, max_instructions, optional breakpoints/until/cycle_budget. Returns: counts + final PC.",
    {
      session_id: z.string(),
      max_instructions: z.number().int().min(1).max(10_000_000),
      breakpoints: z.array(z.string()).optional().describe("Hex PC addresses to break on."),
      cycle_budget: z.number().int().optional(),
      until: z.object({
        kind: z.enum(["pc", "raster", "iec", "stable_screen"]).describe("Named stop condition: pc | raster | iec | stable_screen."),
        pc: z.string().optional().describe("Hex PC address (for kind=pc)."),
        side: z.enum(["c64", "drive"]).optional().describe("Which CPU's PC to watch (for kind=pc). Default c64."),
        count: z.number().int().min(1).optional().describe("Number of hits to wait for (for kind=pc). Default 1."),
        line: z.number().int().min(0).max(311).optional().describe("VIC raster line (for kind=raster)."),
        edge: z.enum(["atn-fall", "atn-rise", "clk-fall", "clk-rise", "data-fall", "data-rise"]).optional().describe("IEC line edge (for kind=iec)."),
        frames_stable: z.number().int().min(1).optional().describe("Frames-stable threshold (for kind=stable_screen). Default 3."),
      }).optional().describe("Named stop condition. If set, runs until satisfied (or budget exhausted) instead of max_instructions."),
    },
    safeHandler("runtime_session_run", async ({ session_id, max_instructions, breakpoints, cycle_budget, until }) => {
      // Spec 744.4c — bounded run against the shared Runtime Daemon session.
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        if (until) throw new Error("runtime_session_run with `until` conditions is not yet routed through the Runtime Daemon (744.4c slice 2). Use cycle_budget / max_instructions.");
        const cycles = cycle_budget ?? Math.max(1, (max_instructions ?? 100_000) * 2);
        await runtimeDaemon.run(session_id, cycles);
        const { c64Cycles, cpu } = await runtimeDaemon.state(session_id);
        return { content: [{ type: "text" as const, text: `Ran up to ~${cycles} cycles (Runtime Daemon). cycles=${c64Cycles} pc=${formatHexWord(cpu.pc)}` }] };
      }
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const { sessionTraceActive, drainSessionTrace } = await import("./runtime-trace-sink.js");
      // Spec 726: when a streaming trace is active, run the plain path in chunks
      // and drain to DuckDB between chunks (emulator paused during the async
      // write). runFor(N) == k×runFor(N/k) — chunking is behaviour-neutral.
      const traceActive = await sessionTraceActive(session_id);

      let modeText: string;
      if (until) {
        const stepping = await import("../runtime/headless/stepping.js");
        let stepResult: { exitReason: string; cyclesElapsed: number; instructionsElapsed: number; hit?: unknown };
        switch (until.kind) {
          case "pc": {
            if (!until.pc) throw new Error("until.pc required for kind=pc");
            stepResult = stepping.runUntilPc(session, parseHexWord(until.pc), {
              side: until.side ?? "c64",
              count: until.count,
              budget: max_instructions,
            });
            break;
          }
          case "raster": {
            if (until.line === undefined) throw new Error("until.line required for kind=raster");
            stepResult = stepping.runUntilRaster(session, until.line, max_instructions);
            break;
          }
          case "iec": {
            if (!until.edge) throw new Error("until.edge required for kind=iec");
            stepResult = stepping.runUntilIecEvent(session, until.edge, max_instructions);
            break;
          }
          case "stable_screen": {
            stepResult = stepping.runUntilStableScreen(session, {
              framesStable: until.frames_stable,
              budgetCycles: cycle_budget,
            });
            break;
          }
        }
        modeText = `Until-${until.kind}: ${stepResult.exitReason} (${stepResult.instructionsElapsed} instructions, ${stepResult.cyclesElapsed} cycles)${stepResult.hit ? ` hit=${JSON.stringify(stepResult.hit)}` : ""}`;
        // Spec 726: until paths are a single sync run; drain once after.
        if (traceActive) await drainSessionTrace(session_id);
      } else {
        const bp = breakpoints && breakpoints.length > 0
          ? new Set(breakpoints.map((s) => parseHexWord(s)))
          : undefined;
        if (traceActive) {
          // chunked run + drain between chunks (bounds the transport queue).
          const CHUNK = 200_000;
          const startCyc = session.c64Cpu.cycles;
          let done = 0;
          let aborted: string | undefined;
          while (done < max_instructions) {
            const n = Math.min(CHUNK, max_instructions - done);
            const remaining = cycle_budget !== undefined
              ? cycle_budget - (session.c64Cpu.cycles - startCyc) : undefined;
            if (remaining !== undefined && remaining <= 0) { aborted = "cycle-budget"; break; }
            const r = session.runFor(n, { breakpoints: bp, cycleBudget: remaining });
            done += r.instructionsExecuted;
            await drainSessionTrace(session_id);
            if (r.aborted) { aborted = r.aborted; break; }
            if (r.instructionsExecuted < n) break;
          }
          modeText = `Instructions executed: ${done}${aborted ? ` (aborted: ${aborted})` : ""}`;
        } else {
          const result = session.runFor(max_instructions, { breakpoints: bp, cycleBudget: cycle_budget });
          modeText = `Instructions executed: ${result.instructionsExecuted}${result.aborted ? ` (aborted: ${result.aborted})` : ""}`;
        }
      }

      const status = session.status();
      return {
        content: [{
          type: "text" as const,
          text: [
            `Integrated run — session ${session_id}`,
            modeText,
            `C64: PC=${formatHexWord(status.c64.pc)} A=${formatHexByte(status.c64.a)} cycles=${status.c64.cycles}`,
            `Drive: PC=${formatHexWord(status.drive.pc)} A=${formatHexByte(status.drive.a)} cycles=${status.drive.cycles} track=${status.drive.track}`,
            `IEC: ATN=${status.iecBus.line.atn ? "1" : "0"} CLK=${status.iecBus.line.clk ? "1" : "0"} DATA=${status.iecBus.line.data ? "1" : "0"}`,
          ].join("\n"),
        }],
      };
    },
));

  // Spec 726 — trace marks + finalize (default capture-workflow tools).
  server.tool(
    "runtime_mark",
    "Stamp a named phase marker into the active trace at the current cycle (e.g. 'boot', 'title', 'gameplay'). Requires an active streaming trace — start one with runtime_session_start(trace_out=...). Use to scope later trace queries by phase (between mark cycles). Not for querying marks (use trace_store_anchor_list / trace_store_query). Inputs: session_id, label. Returns: trace status.",
    {
      session_id: z.string(),
      label: z.string().describe("Phase label, e.g. boot-complete / title / scene-1."),
    },
    safeHandler("runtime_mark", async ({ session_id, label }) => {
      // BUG-028 — mark the SHARED daemon session's active trace.
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const s = await runtimeDaemon.mark(session_id, label) as { runId: string; eventCount: number; marks: number };
        return { content: [{ type: "text" as const, text: `Marked "${label}" — run ${s.runId}, ${s.eventCount} events, ${s.marks} marks.` }] };
      }
      const { getRuntimeController } = await import("../runtime/headless/debug/runtime-controller.js");
      const ctrl = getRuntimeController(session_id);
      if (!ctrl?.traceRun.isActive()) throw new Error(`No active trace on session ${session_id} (start one with runtime_session_start trace_out=...).`);
      ctrl.traceRun.mark(label);
      const s = ctrl.traceRun.status();
      return { content: [{ type: "text" as const, text: `Marked "${label}" — run ${s.runId}, ${s.eventCount} events, ${s.marks} marks.` }] };
    },
));

  // Spec 746.2 — start a streaming trace on an ALREADY-RUNNING session (the shared
  // daemon session the human drives). This is the gap BUG/charter closes: before,
  // tracing could ONLY be enabled at runtime_session_start(trace_out=...). Now the
  // LLM can trace the live Wasteland session after the fact, by domain. The default
  // daemon session is built producers-on (Spec 746.1) so iec/drive/memory have data.
  server.tool(
    "runtime_trace_start",
    "Start a streaming trace on a RUNNING session (no need to pre-declare trace_out at session_start). Use to begin capturing the live shared session's execution into a .c64retrace binary timeline (the authority) + a queryable trace.duckdb index. Pick domains (default c64-cpu+memory; add drive8-cpu/iec/vic for the full picture). Then drive with runtime_session_run, stamp phases with runtime_mark, finalize with runtime_trace_finalize, and read the swimlane/offline-stepping with runtime_swimlane_slice / query with trace_store_*. Not for a one-shot scenario (use runtime_session_start trace_out=). Inputs: session_id, optional domains, optional output path. Returns: runId + store path + domains.",
    {
      session_id: z.string(),
      domains: z.array(z.enum(["c64-cpu", "drive8-cpu", "iec", "vic", "sid", "memory"])).optional()
        .describe("Trace domains. Default ['c64-cpu','memory']. The CPU firehose is the swimlane truth; add drive8-cpu/iec for IEC-bus + drive stepping, vic for raster."),
      output: z.string().optional().describe("Path (abs or under the project) for the trace store. Default traces/live_<ts>.duckdb."),
    },
    safeHandler("runtime_trace_start", async ({ session_id, domains, output }) => {
      const doms = domains ?? ["c64-cpu", "memory"];
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        // resolve the output path against the caller's project (project-agnostic daemon)
        let absOut: string | undefined = output;
        if (output) {
          const { resolveTraceOut } = await import("./runtime-trace-sink.js");
          const proj = (() => { try { return resolveHeadlessProjectDir(context); } catch { return undefined; } })();
          absOut = resolveTraceOut(output, proj);
        }
        const r = await runtimeDaemon.traceStartDomains<{ run: { runId: string }; outputPath: string; domains: string[] }>(session_id, doms, absOut);
        return { content: [{ type: "text" as const, text: [
          `Trace started (Runtime Daemon) — run ${r.run.runId}`,
          `Domains: ${r.domains.join(", ")}`,
          `Store: ${r.outputPath}`,
          `Drive the session (runtime_session_run / runtime_until), stamp phases with runtime_mark, then runtime_trace_finalize. Read it with runtime_swimlane_slice / trace_store_*.`,
        ].join("\n") }] };
      }
      // in-process: build the def + start on the session's controller.
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const { captureAllDef, resolveTraceOut } = await import("./runtime-trace-sink.js");
      const { ensureRuntimeController } = await import("../runtime/headless/debug/runtime-controller.js");
      const ctrl = ensureRuntimeController(session_id, session, () => {});
      if (ctrl.traceRun.isActive()) throw new Error(`Trace already active on session ${session_id} — finalize it first.`);
      const proj = (() => { try { return resolveHeadlessProjectDir(context); } catch { return undefined; } })();
      const outPath = resolveTraceOut(output ?? `traces/live_${Date.now().toString(36)}.duckdb`, proj);
      const run = await ctrl.traceRun.start(captureAllDef(doms as never), { controller: ctrl, outputPath: outPath });
      return { content: [{ type: "text" as const, text: [
        `Trace started — run ${run.runId}`,
        `Domains: ${doms.join(", ")}`,
        `Store: ${outPath}`,
      ].join("\n") }] };
    },
));

  server.tool(
    "runtime_trace_finalize",
    "Finalize the active streaming trace: drain remaining events + write the trace_run header, then close the trace.duckdb. Requires an active trace (runtime_trace_start, or runtime_session_start trace_out=...). Call once capture is complete; the store is then queryable any time via trace_store_query / trace_store_top_pcs / trace_store_bus_find / runtime_query_events (pass the trace.duckdb path). Not for marking (use runtime_mark) or progress polling (use runtime_trace_status). Inputs: session_id. Returns: run summary (runId, event/byte counts, mark list, store path).",
    { session_id: z.string() },
    safeHandler("runtime_trace_finalize", async ({ session_id }) => {
      // Spec 746.3 — route to the shared daemon (BUG-028 class: was getRuntimeController-only).
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        // wait_index=true: stop + await the background DuckDB index so the store is
        // queryable on return (the LLM queries next); the UI's instant button omits it.
        const { run } = await runtimeDaemon.traceStop<{ run: { runId: string; eventCount: number; bytesWritten: number; marks: unknown[]; cycleStart: number; cycleEnd: number; evidenceRef: string } }>(session_id, true);
        // Spec 753 — auto-write the page memory map sidecar if mem-row was captured.
        // Fully soft-fail: a failure here (incl. the dynamic import) must NEVER turn
        // a successful finalize into an error envelope.
        let mm: string | null = null;
        try {
          const { writeTraceMemoryMapSidecar } = await import("./trace-store.js");
          mm = await writeTraceMemoryMapSidecar(run.evidenceRef, context, run.runId);
        } catch { /* soft-fail — finalize already succeeded */ }
        return { content: [{ type: "text" as const, text: [
          `Trace finalized (Runtime Daemon) — run ${run.runId}`,
          `Events: ${run.eventCount}  bytes: ${run.bytesWritten}  marks: ${run.marks.length}`,
          `Cycles: ${run.cycleStart}..${run.cycleEnd}`,
          `Store: ${run.evidenceRef}`,
          ...(mm ? [mm] : []),
          `Query it with trace_store_query / trace_store_top_pcs / runtime_swimlane_slice (duckdb_path = the store).`,
        ].join("\n") }] };
      }
      const { getRuntimeController } = await import("../runtime/headless/debug/runtime-controller.js");
      const ctrl = getRuntimeController(session_id);
      if (!ctrl?.traceRun.isActive()) throw new Error(`No active trace on session ${session_id}.`);
      const run = await ctrl.traceRun.stop();
      await ctrl.traceRun.awaitIndex(); // queryable store on return (background index)
      // Spec 753 — auto-write the page memory map sidecar if mem-row was captured.
      // Fully soft-fail (incl. the dynamic import) — never break a good finalize.
      let mm: string | null = null;
      try {
        const { writeTraceMemoryMapSidecar } = await import("./trace-store.js");
        mm = await writeTraceMemoryMapSidecar(run.evidenceRef, context, run.runId);
      } catch { /* soft-fail — finalize already succeeded */ }
      return { content: [{ type: "text" as const, text: [
        `Trace finalized — run ${run.runId}`,
        `Events: ${run.eventCount}  bytes: ${run.bytesWritten}  marks: ${run.marks.length}`,
        `Cycles: ${run.cycleStart}..${run.cycleEnd}`,
        `Store: ${run.evidenceRef}`,
        ...(mm ? [mm] : []),
        `Query it with trace_store_query / trace_store_top_pcs / runtime_query_events (duckdb_path = the store).`,
      ].join("\n") }] };
    },
));

  server.tool(
    "runtime_trace_status",
    "Report the active streaming trace's status — runId, output path, captured event/mark counts, backpressure flag. Requires an active trace started via runtime_session_start(trace_out=...). Use to watch capture progress and decide when to call runtime_trace_finalize. Not for the run's machine state (use runtime_session_status) or offline store queries (use trace_store_info). Inputs: session_id. Returns: trace status JSON.",
    { session_id: z.string() },
    safeHandler("runtime_trace_status", async ({ session_id }) => {
      // Spec 746.3 — route to the shared daemon (BUG-028 class).
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const s = await runtimeDaemon.traceStatus(session_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(s, null, 2) }] };
      }
      const { getRuntimeController } = await import("../runtime/headless/debug/runtime-controller.js");
      const ctrl = getRuntimeController(session_id);
      const s = ctrl?.traceRun.status() ?? { active: false };
      return { content: [{ type: "text" as const, text: JSON.stringify(s, null, 2) }] };
    },
));

  server.tool(
    "runtime_session_snapshot",
    "Capture a structured, round-trippable state snapshot of a session (CPU+RAM+IEC+drive+keyboard+joystick). Use to save/compare machine state. Not for VICE-format bytes (use runtime_save_vsf, advanced) or the rewind tree (use runtime_snapshot_tree, advanced). Inputs: session_id, optional include=['ram']. Returns: structured snapshot.",
    {
      session_id: z.string(),
      include: z.array(z.enum(["ram", "tracks"])).optional().describe("Optional include sections."),
    },
    safeHandler("runtime_session_snapshot", async ({ session_id, include }) => {
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const { snapshot } = await import("../runtime/headless/snapshot.js");
      const snap = snapshot(session, { include });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(snap),
        }],
      };
    },
));

  server.tool(
    "runtime_session_status",
    "Snapshot a running session's machine state — both CPUs, IEC bus, drive, cycle counts. Use to check where execution is. Not for the agent-API surface report (use runtime_status, advanced). Inputs: session_id. Returns: CPU/IEC/drive snapshot.",
    { session_id: z.string() },
    safeHandler("runtime_session_status", async ({ session_id }) => {
      // Spec 744.4c — read the session from the shared Runtime Daemon (the same
      // machine the UI drives), not a private MCP-process session.
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const { c64Cycles, mode, cpu } = await runtimeDaemon.state(session_id);
        return { content: [{ type: "text" as const, text: [
          `Runtime session status (Runtime Daemon) — ${session_id}`,
          ``,
          `C64 CPU: PC=${formatHexWord(cpu.pc)} A=${formatHexByte(cpu.a)} X=${formatHexByte(cpu.x)} Y=${formatHexByte(cpu.y)} SP=${formatHexByte(cpu.sp)} P=${formatHexByte(cpu.flags)}`,
          `         cycles=${c64Cycles}`,
          `Mode: ${mode}`,
        ].join("\n") }] };
      }
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const s = session.status();
      return {
        content: [{
          type: "text" as const,
          text: [
            `Integrated session status — ${session_id}`,
            ``,
            `C64 CPU: PC=${formatHexWord(s.c64.pc)} A=${formatHexByte(s.c64.a)} X=${formatHexByte(s.c64.x)} Y=${formatHexByte(s.c64.y)} SP=${formatHexByte(s.c64.sp)} P=${formatHexByte(s.c64.flags)}`,
            `         cycles=${s.c64.cycles} instructions=${s.c64.instructions}`,
            ``,
            `Drive CPU: PC=${formatHexWord(s.drive.pc)} A=${formatHexByte(s.drive.a)} X=${formatHexByte(s.drive.x)} Y=${formatHexByte(s.drive.y)} SP=${formatHexByte(s.drive.sp)} P=${formatHexByte(s.drive.flags)}`,
            `           cycles=${s.drive.cycles} instructions=${s.drive.instructions} track=${s.drive.track}`,
            ``,
            `IEC bus: ATN=${s.iecBus.line.atn ? "1" : "0 (LOW)"} CLK=${s.iecBus.line.clk ? "1" : "0 (LOW)"} DATA=${s.iecBus.line.data ? "1" : "0 (LOW)"}`,
            ``,
            `ROMs: kernal=${s.romSet.kernal}`,
            `      basic=${s.romSet.basic}`,
            `      chargen=${s.romSet.charRom}`,
          ].join("\n"),
        }],
      };
    },
));

  server.tool(
    "runtime_session_close",
    "Close a runtime session and release its resources. Use when finished with a session started by runtime_session_start: it stops the RuntimeController loop (which otherwise keeps ticking the session and pegs a CPU core ~100% after you are done), finalizes any active streaming trace, and removes the session from the registry — the clean alternative to killing the process. Not for pausing to inspect then resuming (keep the session and use runtime_session_run) or for finalizing only a trace (use runtime_trace_finalize). NOTE: in the one-machine-per-process runtime, closing a session does NOT hand the process-global VIC/drive state back to another session — if you ever ran a second in-process session, the first stays corrupted until a process restart. Inputs: session_id. Returns: what was released. Idempotent (closing an unknown/already-closed session is a no-op success).",
    { session_id: z.string() },
    safeHandler("runtime_session_close", async ({ session_id }) => {
      // Spec 744.4c — close the session in the shared Runtime Daemon (or in-process).
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      const { existed, released } = isDaemonMode()
        ? await runtimeDaemon.closeSession(session_id)
        // Spec 744.4 — in-process: finalize trace + dispose controller + drop session.
        : await (await import("../runtime/headless/runtime-session-service.js")).runtimeSessions.close(session_id);
      return {
        content: [{
          type: "text" as const,
          text: existed || released.length
            ? `Session ${session_id} closed. Released: ${released.join(", ") || "(nothing pending)"}.`
            : `Session ${session_id} was not open (already closed). No-op.`,
        }],
      };
    },
));

  server.tool(
    "runtime_load_prg",
    "Inject a PRG into a session's RAM as if KERNAL LOAD placed it. Use to load a program without a disk. Not for disk LOAD (mount + runtime_type a LOAD line) or static analysis (use analyze_prg). Inputs: session_id, prg_path, optional load_address. Returns: load range.",
    {
      session_id: z.string(),
      prg_path: z.string(),
      load_address: z.string().optional().describe("Override load address (hex). Default = PRG header."),
    },
    safeHandler("runtime_load_prg", async ({ session_id, prg_path, load_address }) => {
      const addr = load_address ? parseHexWord(load_address) : undefined;
      // BUG-028 — inject into the SHARED daemon session. The path is resolved
      // absolute against the MCP's project (the project-agnostic daemon, localhost,
      // reads the caller's file — same rule as session_start's disk_path).
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const mcpProject = (() => { try { return resolveHeadlessProjectDir(context); } catch { return undefined; } })();
        const absPrg = resolve(mcpProject ?? process.cwd(), prg_path);
        const r = await runtimeDaemon.loadPrg<{ loadAddress: number; endAddress: number; bytesLoaded: number }>(session_id, absPrg, addr);
        return { content: [{ type: "text" as const, text: [
          `PRG loaded into RAM (Runtime Daemon).`,
          `Path: ${absPrg}`,
          `Load address: ${formatHexWord(r.loadAddress)}`,
          `End address: ${formatHexWord(r.endAddress)}`,
          `Bytes: ${r.bytesLoaded}`,
        ].join("\n") }] };
      }
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const result = session.loadPrgIntoRam(prg_path, addr);
      return {
        content: [{
          type: "text" as const,
          text: [
            `PRG loaded into RAM.`,
            `Path: ${prg_path}`,
            `Load address: ${formatHexWord(result.loadAddress)}`,
            `End address: ${formatHexWord(result.endAddress)}`,
            `Bytes: ${result.bytesLoaded}`,
          ].join("\n"),
        }],
      };
    },
));

  // Sprint 93.1: queue text typing through CIA1 keyboard matrix.
  server.tool(
    "runtime_type",
    "Queue text into a session's keyboard buffer (CIA1 matrix), as if typed. Use to enter BASIC commands / LOAD lines. Not for joystick (use runtime_joystick). Inputs: session_id, text, optional timing. Returns: queued confirmation.",
    {
      session_id: z.string(),
      text: z.string().describe("Text to type. Use \\r or \\n for RETURN."),
      hold_cycles: z.number().int().min(1000).max(2_000_000).optional(),
      gap_cycles: z.number().int().min(0).max(2_000_000).optional(),
    },
    safeHandler("runtime_type", async ({ session_id, text, hold_cycles, gap_cycles }) => {
      const decoded = text.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      // BUG-028 — type into the SHARED daemon session (the machine the human drives),
      // not a private in-process session. Read tools were routed; this write tool
      // was not, so the LLM could see but not type. Now uniform.
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        await runtimeDaemon.typeText(session_id, decoded, hold_cycles ?? 33000, gap_cycles ?? 33000);
        return { content: [{ type: "text" as const, text: [
          `Queued ${decoded.length} chars on session ${session_id} (Runtime Daemon).`,
          `Hold cycles: ${hold_cycles ?? 33000}  Gap cycles: ${gap_cycles ?? 33000}`,
        ].join("\n") }] };
      }
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      session.typeText(decoded, hold_cycles ?? 33000, gap_cycles ?? 33000);
      return {
        content: [{
          type: "text" as const,
          text: [
            `Queued ${decoded.length} chars on session ${session_id}.`,
            `Hold cycles: ${hold_cycles ?? 33000}  Gap cycles: ${gap_cycles ?? 33000}`,
            `Pending key events: ${session.keyboard.pendingEventCount()}`,
            `Keyboard now-cycle: ${session.keyboard.currentCycle()}`,
          ].join("\n"),
        }],
      };
    },
));

  // Sprint 93.1: joystick port 2 backend.
  server.tool(
    "runtime_joystick",
    "Set joystick port-2 state (up/down/left/right/fire) on a session. Use to drive game input. Not for keyboard (use runtime_type). Inputs: session_id, direction/fire flags. Returns: applied state.",
    {
      session_id: z.string(),
      up: z.boolean().optional(),
      down: z.boolean().optional(),
      left: z.boolean().optional(),
      right: z.boolean().optional(),
      fire: z.boolean().optional(),
    },
    safeHandler("runtime_joystick", async ({ session_id, up, down, left, right, fire }) => {
      // BUG-028 — joystick on the SHARED daemon session.
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        await runtimeDaemon.joystickSet(session_id, 2, { up, down, left, right, fire });
        return { content: [{ type: "text" as const, text: [
          `Joystick port 2 — session ${session_id} (Runtime Daemon)`,
          `up=${!!up} down=${!!down} left=${!!left} right=${!!right} fire=${!!fire}`,
        ].join("\n") }] };
      }
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      session.setJoystick2({ up, down, left, right, fire });
      const j = session.joystick2;
      return {
        content: [{
          type: "text" as const,
          text: [
            `Joystick port 2 — session ${session_id}`,
            `up=${j.up} down=${j.down} left=${j.left} right=${j.right} fire=${j.fire}`,
          ].join("\n"),
        }],
      };
    },
));

  // Spec 093: Maniac Mansion G64 lockstep regression diagnostic.
  server.tool(
    "runtime_diagnose_mm",
    "Spec 093: open or reuse an integrated session, run Maniac Mansion (or any G64) until it reaches the title screen or a known stall heuristic fires (C64 stuck at $46A7, drive PC repeats, cycle budget exhausted). Writes a registered JSON artifact under analysis/headless/ and returns a one-line verdict + key blame. Cycle-lockstep + microcoded CPU enforced; tool will refuse misleading success.",
    {
      disk_path: z.string().describe("Disk image path (G64 expected)."),
      project_dir: z.string().optional(),
      cycle_budget: z.number().int().min(1_000_000).max(2_000_000_000).optional(),
      stall_pc_repeat: z.number().int().min(1000).max(100_000_000).optional(),
      watch_pc: z.string().optional().describe("C64 PC to watch (default $46A7)."),
      device_id: z.number().int().min(8).max(11).optional(),
      pal: z.boolean().optional(),
      output_path: z.string().optional().describe("Override JSON output path. Default = <project>/analysis/headless/mm-g64-lockstep-debug.json."),
    },
    safeHandler("runtime_diagnose_mm", async ({
      disk_path, project_dir, cycle_budget, stall_pc_repeat, watch_pc, device_id, pal, output_path,
    }) => {
      // Spec 744.4 — even the one-shot diagnostic creates its session through the
      // single authority (then closes it), so no product path constructs a private
      // session outside the service.
      const { runtimeSessions } = await import("../runtime/headless/runtime-session-service.js");
      const { diagnoseMm } = await import("../runtime/headless/diagnostic-mm.js");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { dirname, join } = await import("node:path");
      const projectRoot = resolveHeadlessProjectDir(context, project_dir);
      // Spec 723.7b: lockstep is gone; diagnose_mm runs the product event-catchup
      // path with full IEC/drive trace channels enabled (debug-vice-compare).
      const { sessionId, session } = runtimeSessions.start({
        diskPath: disk_path, deviceId: device_id, isPal: pal,
        mode: "debug-vice-compare",
        traceIec: true, traceIecCapacity: 4096,
        traceDrive: true, traceDriveCapacity: 2048,
      });
      session.resetCold();
      let report;
      try {
        report = diagnoseMm(session, {
          cycleBudget: cycle_budget,
          stallPcRepeat: stall_pc_repeat,
          watchPc: watch_pc ? parseHexWord(watch_pc) : undefined,
        });
      } finally {
        await runtimeSessions.close(sessionId); // one-shot diagnostic — release it
      }
      const outPath = output_path
        ? resolve(projectRoot, output_path)
        : join(projectRoot, "analysis", "headless", "mm-g64-lockstep-debug.json");
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(report, null, 2));
      const reg = context.tryRegisterKnowledgeArtifacts(projectRoot, {
        toolName: "runtime_diagnose_mm",
        title: `MM G64 lockstep diagnostic — ${report.run.verdict}`,
        parameters: {
          disk_path,
          cycle_budget: report.run.cycleBudget,
          watch_pc: watch_pc ?? "$46A7",
        },
        inputs: [{ path: disk_path, kind: "g64", scope: "input" }],
        outputs: [{
          path: outPath, kind: "report", scope: "analysis",
          format: "application/json", role: "mm-g64-lockstep-debug",
          producedByTool: "runtime_diagnose_mm",
          tags: ["spec-093", "headless", "iec-debug"],
        }],
        notes: [
          `verdict=${report.run.verdict}`,
          `c64=${formatHexWord(report.finalState.c64.pc)} drive=${formatHexWord(report.finalState.drive.pc)} cyc=${report.finalState.c64.cycles}`,
          `IEC line ATN=${report.finalState.iecLine.atn} CLK=${report.finalState.iecLine.clk} DATA=${report.finalState.iecLine.data}`,
          `blame ATN=${report.run.blame.atnHolder} CLK=${report.run.blame.clkHolder} DATA=${report.run.blame.dataHolder}`,
        ],
      });
      const lines: string[] = [
        `headless_integrated_session_diagnose_mm — session ${sessionId}`,
        `Disk: ${disk_path}`,
        `Format: ${report.imageFormat}  ratio=${report.config.driveClockRatio.toFixed(6)}`,
        `Verdict: ${report.run.verdict}`,
        `Summary: ${report.run.summary}`,
        `Cycles: ${report.run.cyclesExecuted} (budget ${report.run.cycleBudget})  duration=${report.run.durationMs}ms`,
        `C64 final: PC=${formatHexWord(report.finalState.c64.pc)} A=${formatHexByte(report.finalState.c64.a)} cycles=${report.finalState.c64.cycles}`,
        `Drive final: PC=${formatHexWord(report.finalState.drive.pc)} cycles=${report.finalState.drive.cycles} track=${report.finalState.drive.track}`,
        `IEC line: ATN=${report.finalState.iecLine.atn} CLK=${report.finalState.iecLine.clk} DATA=${report.finalState.iecLine.data}`,
        `Blame: ATN=${report.run.blame.atnHolder} CLK=${report.run.blame.clkHolder} DATA=${report.run.blame.dataHolder}`,
        `IEC edges captured: ${report.iecTrace.length}  Drive PC samples: ${report.drivePcTrace.length}`,
        `Report: ${outPath}`,
      ];
      if (reg.runPath) lines.push(`Registered: ${reg.runPath}`);
      if (reg.message) lines.push(reg.message);
      if (report.exception) lines.push(`Exception: ${report.exception.split("\n")[0]}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
));

  server.tool(
    "runtime_render_screen",
    "Render a session's current VIC output to a PNG. Use to see the live screen state. Not for a saved scenario (use the advanced scenario export). Inputs: session_id, out_path. Returns: PNG path + dimensions.",
    {
      session_id: z.string(),
      path: z.string().describe("Output PNG path"),
    },
    safeHandler("runtime_render_screen", async ({ session_id, path }) => {
      // Spec 744.4c — render the shared Runtime Daemon session's screen. The daemon
      // returns a base64 PNG (same frame the UI sees); write it to the requested path.
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      if (isDaemonMode()) {
        const shot = await runtimeDaemon.screenshot(session_id);
        const dataUrl = shot.dataUrl ?? "";
        const b64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
        const buf = Buffer.from(b64, "base64");
        const { writeFileSync } = await import("node:fs");
        writeFileSync(path, buf);
        return { content: [{ type: "text" as const, text: [
          `runtime_render_screen — session ${session_id} (Runtime Daemon)`,
          `Output: ${path}`,
          `Dimensions: ${shot.width ?? "?"}×${shot.height ?? "?"}`,
          `Bytes: ${buf.length}`,
        ].join("\n") }] };
      }
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const r = session.renderToPng(path);
      return {
        content: [{
          type: "text" as const,
          text: [
            `headless_render_screen — session ${session_id}`,
            `Output: ${path}`,
            `Dimensions: ${r.width}×${r.height}`,
            `Bytes: ${r.bytes}`,
            `VIC state: border=$${session.vic.regs[0x20].toString(16)} bg=$${session.vic.regs[0x21].toString(16)} screen-ram-offset=$${session.vic.screenRamOffset().toString(16)}`,
          ].join("\n"),
        }],
      };
    },
));

  // Spec 746.4 — checkpoint ring (scrub / rewind) on the SHARED session. The ring
  // auto-captures a full RuntimeCheckpoint every 25 frames while the session runs
  // (128 MiB bytes-budget, evict-oldest, pinned-exempt). These tools let the LLM
  // list/capture/pin/restore the SAME keyframes the human scrubs in the UI — the
  // basis for "rewind to interesting state, pin as evidence, branch". All route to
  // the daemon (the ring lives there); in-process is the test fallback.
  const cpInProc = async (session_id: string) => {
    const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
    const session = getIntegratedSession(session_id);
    if (!session) throw new Error(`No integrated session ${session_id}`);
    const { ensureRuntimeController } = await import("../runtime/headless/debug/runtime-controller.js");
    return ensureRuntimeController(session_id, session, () => {});
  };

  server.tool(
    "runtime_checkpoint_list",
    "List the session's checkpoint-ring keyframes (id, frame, cycles, pinned) + ring stats (count, bytes, budget). The ring auto-captures a full machine snapshot every ~0.5s while the session runs, for rewind/scrub. Use to see what points you can restore to. Not for the trace timeline (use trace_store_*). Inputs: session_id. Returns: checkpoint refs + stats.",
    { session_id: z.string() },
    safeHandler("runtime_checkpoint_list", async ({ session_id }) => {
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      let r: unknown;
      if (isDaemonMode()) r = await runtimeDaemon.checkpointList(session_id);
      else { const c = await cpInProc(session_id); r = { checkpoints: c.checkpointRing.list(), stats: c.checkpointRing.stats() }; }
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_checkpoint_capture",
    "Capture a checkpoint NOW (a full restorable snapshot of the shared session at the current instruction boundary) and add it to the ring. Use to mark an interesting live moment before it scrolls out of the auto-capture window. Not for a durable file (use runtime_session_snapshot). Inputs: session_id. Returns: the new checkpoint ref + ring stats.",
    { session_id: z.string() },
    safeHandler("runtime_checkpoint_capture", async ({ session_id }) => {
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      const r = isDaemonMode()
        ? await runtimeDaemon.checkpointCapture(session_id)
        : await (async () => { const c = await cpInProc(session_id); const ref = await c.captureCheckpoint(); return { ref, stats: c.checkpointRing.stats() }; })();
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_checkpoint_pin",
    "Pin a checkpoint so the ring never evicts it (the durability primitive — pinned keyframes survive past the ~2.6 min window). Use to retain an interesting state as evidence / a branch base. Not for a file dump (use runtime_session_snapshot). Inputs: session_id, checkpoint id. Returns: ref + stats.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_checkpoint_pin", async ({ session_id, id }) => {
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      const r = isDaemonMode()
        ? await runtimeDaemon.checkpointPin(session_id, id)
        : await (async () => { const c = await cpInProc(session_id); const ref = c.checkpointRing.pin(id); if (!ref) throw new Error(`unknown checkpoint ${id}`); return { ref, stats: c.checkpointRing.stats() }; })();
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_checkpoint_unpin",
    "Unpin a checkpoint (let the ring reclaim it under the byte budget again). Use to release a retained state you no longer need. Inputs: session_id, checkpoint id. Returns: ref + stats.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_checkpoint_unpin", async ({ session_id, id }) => {
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      const r = isDaemonMode()
        ? await runtimeDaemon.checkpointUnpin(session_id, id)
        : await (async () => { const c = await cpInProc(session_id); const ref = c.checkpointRing.unpin(id); if (!ref) throw new Error(`unknown checkpoint ${id}`); return { ref, stats: c.checkpointRing.stats() }; })();
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_checkpoint_restore",
    "Restore the shared session to a checkpoint (REWIND/scrub): the machine jumps back to that full keyframe state and pauses. The human watching the UI sees the same jump (one shared session). Use to rewind to an interesting moment. Not for forward replay of recorded events (that's the branch/scenario path). Inputs: session_id, checkpoint id. Returns: restored ref + new machine state.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_checkpoint_restore", async ({ session_id, id }) => {
      const { isDaemonMode, runtimeDaemon } = await import("./runtime-daemon-client.js");
      const r = isDaemonMode()
        ? await runtimeDaemon.checkpointRestore(session_id, id)
        : await (async () => { const c = await cpInProc(session_id); const restored = await c.restoreCheckpoint(id); return { restored, state: c.state() }; })();
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_drive_session_save_vsf",
    "Spec 062 Sprint 64: save the drive session's full state as a VICE Snapshot Format (VSF) file. Modules: DRIVECPU, DRIVERAM, VIA1d1541, VIA2d1541, IECBUS, GCRHEAD. C64 RAM + MainCPU added when full headless C64 ROM integration lands.",
    {
      session_id: z.string(),
      output_path: z.string(),
    },
    safeHandler("runtime_drive_session_save_vsf", async ({ session_id, output_path }) => {
      const { getDriveSession } = await import("../runtime/headless/drive1541/drive-session-manager.js");
      const { saveDriveSessionVsf } = await import("../runtime/headless/vsf/drive-vsf.js");
      const record = getDriveSession(session_id);
      if (!record) throw new Error(`No drive session ${session_id}`);
      const result = saveDriveSessionVsf(record, output_path);
      return {
        content: [{
          type: "text" as const,
          text: [
            `headless_drive_session_save_vsf — ${session_id}`,
            `Output: ${result.outputPath}`,
            `Bytes: ${result.bytesWritten}`,
            `Modules saved: ${result.modules.join(", ")}`,
          ].join("\n"),
        }],
      };
    },
));

  server.tool(
    "runtime_drive_session_load_vsf",
    "Spec 062 Sprint 64: load a VSF file into a drive session. Modules the headless drive runtime owns are restored; modules it doesn't model (VIC, SID, CIA1, KEYBOARD, etc.) are reported as ignored. Use to resume a previous trace or to import VICE-saved state.",
    {
      session_id: z.string(),
      input_path: z.string(),
    },
    safeHandler("runtime_drive_session_load_vsf", async ({ session_id, input_path }) => {
      const { getDriveSession } = await import("../runtime/headless/drive1541/drive-session-manager.js");
      const { loadDriveSessionVsf } = await import("../runtime/headless/vsf/drive-vsf.js");
      const record = getDriveSession(session_id);
      if (!record) throw new Error(`No drive session ${session_id}`);
      const result = loadDriveSessionVsf(record, input_path);
      const lines = [
        `headless_drive_session_load_vsf — ${session_id}`,
        `Input: ${result.inputPath}`,
        `Loaded modules (${result.loadedModules.length}): ${result.loadedModules.join(", ")}`,
      ];
      if (result.ignoredModules.length > 0) {
        lines.push(`Ignored modules (${result.ignoredModules.length}, not modeled in headless): ${result.ignoredModules.join(", ")}`);
      }
      if (result.errors.length > 0) {
        lines.push(`Errors:`);
        for (const e of result.errors) lines.push(`  ${e.module}: ${e.error}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
));

  server.tool(
    "runtime_drive_persist_writes",
    "Spec 062 Sprint 63 (Q4.C): write modified GCR tracks back to disk as <image>_session.g64. Original image untouched. Returns paths + modified track list. Save-game RE workflow trigger.",
    {
      session_id: z.string(),
      output_path: z.string().optional().describe("Optional override for the session-G64 output path."),
    },
    safeHandler("runtime_drive_persist_writes", async ({ session_id, output_path }) => {
      const { persistDriveSession } = await import("../runtime/headless/drive1541/drive-session-manager.js");
      const result = persistDriveSession(session_id, output_path);
      // Spec 704 §11 R3 — vice-backed PersistResult { written, outputPath?, note? }.
      const lines = [
        `headless_drive_persist_writes — session ${session_id}`,
        `Written: ${result.written ? "yes" : "no"}`,
      ];
      if (result.outputPath) lines.push(`Output: ${result.outputPath}`);
      if (result.note) lines.push(`Note: ${result.note}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
));

}
