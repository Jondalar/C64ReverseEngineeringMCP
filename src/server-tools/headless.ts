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
    "Start a headless C64+1541 session — the product runtime (real KERNAL/BASIC, VICE-shaped 1541, event-catchup). Use to begin a runtime session for loading/running/inspecting a title. Not for the VICE oracle (use vice_*, advanced). Inputs: optional disk/cart path, device id, pal. Returns: session id + resolved config.",
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
    },
    safeHandler("runtime_session_start", async ({
      disk_path, device_id, pal, start_track, write_protected,
      trace_iec, trace_iec_capacity, trace_drive, trace_drive_capacity,
      enable_kernal_fileio_traps, enable_kernal_serial_traps, enable_kernal_io_traps,
    }) => {
      const { startIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const warnings: string[] = [];
      // Spec 723.4a: the product runtime is true-drive + microcoded
      // unconditionally — no useCycleLockstep / useMicrocodedCpu inputs.
      const { sessionId, session } = startIntegratedSession({
        diskPath: disk_path, deviceId: device_id, isPal: pal,
        startTrack: start_track, writeProtected: write_protected,
        traceIec: trace_iec, traceIecCapacity: trace_iec_capacity,
        traceDrive: trace_drive, traceDriveCapacity: trace_drive_capacity,
        enableKernalFileIoTraps: enable_kernal_fileio_traps,
        enableKernalSerialTraps: enable_kernal_serial_traps,
        enableKernalIoTraps: enable_kernal_io_traps,
      });
      session.resetCold();
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
      if (warnings.length > 0) lines.push("", ...warnings);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
));

  server.tool(
    "runtime_session_run",
    "Advance a session up to N C64 instructions (drive runs proportional cycles), with optional breakpoints / cycle budget / named stop condition. Use to step the machine forward. Not for run-to-PC only (use runtime_until). Inputs: session_id, max_instructions, optional breakpoints/until. Returns: counts + final PC.",
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
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);

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
      } else {
        const bp = breakpoints && breakpoints.length > 0
          ? new Set(breakpoints.map((s) => parseHexWord(s)))
          : undefined;
        const result = session.runFor(max_instructions, { breakpoints: bp, cycleBudget: cycle_budget });
        modeText = `Instructions executed: ${result.instructionsExecuted}${result.aborted ? ` (aborted: ${result.aborted})` : ""}`;
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
    "runtime_load_prg",
    "Inject a PRG into a session's RAM as if KERNAL LOAD placed it. Use to load a program without a disk. Not for disk LOAD (mount + runtime_type a LOAD line) or static analysis (use analyze_prg). Inputs: session_id, prg_path, optional load_address. Returns: load range.",
    {
      session_id: z.string(),
      prg_path: z.string(),
      load_address: z.string().optional().describe("Override load address (hex). Default = PRG header."),
    },
    safeHandler("runtime_load_prg", async ({ session_id, prg_path, load_address }) => {
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const result = session.loadPrgIntoRam(prg_path, load_address ? parseHexWord(load_address) : undefined);
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
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const decoded = text.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
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
      const { startIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const { diagnoseMm } = await import("../runtime/headless/diagnostic-mm.js");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { dirname, join } = await import("node:path");
      const projectRoot = resolveHeadlessProjectDir(context, project_dir);
      // Spec 723.7b: lockstep is gone; diagnose_mm runs the product event-catchup
      // path with full IEC/drive trace channels enabled (debug-vice-compare).
      const { sessionId, session } = startIntegratedSession({
        diskPath: disk_path, deviceId: device_id, isPal: pal,
        mode: "debug-vice-compare",
        traceIec: true, traceIecCapacity: 4096,
        traceDrive: true, traceDriveCapacity: 2048,
      });
      session.resetCold();
      const report = diagnoseMm(session, {
        cycleBudget: cycle_budget,
        stallPcRepeat: stall_pc_repeat,
        watchPc: watch_pc ? parseHexWord(watch_pc) : undefined,
      });
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
