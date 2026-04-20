import { dirname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPreferredViceSessionManager, getViceSessionManager } from "../runtime/vice/index.js";
import type { ViceSessionRecord, ViceTraceAnalysis } from "../runtime/vice/types.js";
import type { ViceMemspace, ViceMonitorEvent } from "../runtime/vice/monitor-client.js";
import type { ViceSessionManager } from "../runtime/vice/session-manager.js";
import {
  addTraceNote,
  findTraceMemoryAccess,
  findTraceByBytes,
  findTraceByOperand,
  findTraceByPc,
  followTraceFromPc,
  listTraceNotes,
  loadTraceSession,
  sliceTraceByClock,
  traceCallPath,
  traceHotspots,
  type ViceTraceInstructionEvent,
  type ViceTraceMatch,
  type ViceTraceNote,
} from "../runtime/vice/trace-query.js";
import {
  buildTraceIndex,
  loadTraceIndex,
  type ViceTraceIndex,
  type ViceTraceIndexEntry,
} from "../runtime/vice/trace-index.js";
import {
  buildTraceWindowIndex,
  loadTraceWindowIndex,
  type ViceTracePhaseBoundary,
  type ViceTracePhaseSummary,
  type ViceTraceWindowSummary,
} from "../runtime/vice/trace-window-index.js";
import {
  buildTraceContextIndex,
  loadTraceContextIndex,
  sliceTraceContext,
  type ViceTraceContextWriteStat,
  type ViceTraceContextSummary,
} from "../runtime/vice/trace-context-index.js";
import type { ServerToolContext } from "./types.js";


export function registerViceTools(server: McpServer, context: ServerToolContext): void {
  const projectDir = context.projectDir;
  const cliResultToContent = context.cliResultToContent;

  function viceSessionToContent(record: ViceSessionRecord, headline: string): { content: [{ type: "text"; text: string }] } {
    const lines = [
      headline,
      `Session: ${record.sessionId}`,
      `State: ${record.state}`,
      `Monitor port: ${record.monitorPort} (${record.monitorReady ? "listening" : "not ready"})`,
      `Workspace: ${record.workspace.sessionDir}`,
      `Config copy: ${record.configWorkspace.sourceConfigPath}`,
    ];
  
    if (record.pid) lines.push(`PID: ${record.pid}`);
    if (record.viceBinary) lines.push(`VICE binary: ${record.viceBinary}`);
    if (record.startedAt) lines.push(`Started: ${record.startedAt}`);
    if (record.stoppedAt) lines.push(`Stopped: ${record.stoppedAt}`);
    if (record.stopReason) lines.push(`Stop reason: ${record.stopReason}`);
    if (record.media) {
      lines.push(`Media: ${record.media.path}`);
      lines.push(`Media type: ${record.media.type} (${record.media.autostart ? "autostart" : "attach only"})`);
    }
    lines.push(`Session file: ${record.workspace.sessionPath}`);
    lines.push(`Trace events: ${record.workspace.eventsLogPath}`);
    lines.push(`Summary: ${record.workspace.summaryPath}`);
    if (record.lastError) lines.push(`Last error: ${record.lastError}`);
  
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
  
  function parseHexWord(value: string): number {
    const normalized = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{1,4}$/.test(normalized)) {
      throw new Error(`Invalid 16-bit hex value: ${value}`);
    }
    return parseInt(normalized, 16);
  }
  
  function parseHexByteSequence(value: string): number[] {
    const normalized = value
      .replace(/0x/gi, "")
      .replace(/\$/g, "")
      .replace(/[^0-9a-fA-F]/g, " ")
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    if (normalized.length === 1 && normalized[0]!.length > 2 && normalized[0]!.length % 2 === 0) {
      return normalized[0]!.match(/../g)!.map((part) => parseInt(part, 16));
    }
    if (normalized.length === 0) {
      throw new Error(`Invalid byte sequence: ${value}`);
    }
    return normalized.map((part) => {
      if (!/^[0-9a-fA-F]{1,2}$/.test(part)) {
        throw new Error(`Invalid byte value in sequence: ${value}`);
      }
      return parseInt(part, 16);
    });
  }
  
  function formatHexWord(value: number): string {
    return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  
  function formatHexByte(value: number): string {
    return value.toString(16).toUpperCase().padStart(2, "0");
  }
  
  function defaultViceExportPath(projectRoot: string, kind: "snapshot" | "prg" | "bin", startAddress?: number, endAddress?: number): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const exportsDir = join(projectRoot, "analysis", "runtime", "exports");
    switch (kind) {
      case "snapshot":
        return join(exportsDir, `vice-snapshot-${stamp}.vsf`);
      case "prg":
        return join(exportsDir, `memory-${formatHexWord(startAddress ?? 0).slice(1)}-${formatHexWord(endAddress ?? 0).slice(1)}.prg`);
      case "bin":
        return join(exportsDir, `memory-${formatHexWord(startAddress ?? 0).slice(1)}-${formatHexWord(endAddress ?? 0).slice(1)}.bin`);
    }
  }
  
  function defaultViceDisplayPath(projectRoot: string): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    return join(projectRoot, "analysis", "runtime", "exports", `display-${stamp}.pgm`);
  }
  
  async function resolveViceManager(hintPath?: string): Promise<{ manager: ViceSessionManager; projectRoot: string }> {
    if (hintPath) {
      const pd = projectDir(hintPath, true);
      return { manager: getViceSessionManager(pd), projectRoot: pd };
    }
    const preferred = await getPreferredViceSessionManager();
    if (preferred) {
      return { manager: preferred, projectRoot: preferred.getProjectDir() };
    }
    const pd = projectDir();
    return { manager: getViceSessionManager(pd), projectRoot: pd };
  }
  
  async function resolveTraceProjectDir(): Promise<string> {
    const preferred = await getPreferredViceSessionManager();
    return preferred?.getProjectDir() ?? projectDir();
  }
  
  function parseViceMemspace(value?: string): ViceMemspace {
    switch ((value ?? "main").toLowerCase()) {
      case "main":
        return 0x00;
      case "drive8":
        return 0x01;
      case "drive9":
        return 0x02;
      case "drive10":
        return 0x03;
      case "drive11":
        return 0x04;
      default:
        throw new Error(`Unsupported memspace: ${value}`);
    }
  }
  
  function formatViceMemspace(memspace: number): string {
    switch (memspace) {
      case 0x00:
        return "main";
      case 0x01:
        return "drive8";
      case 0x02:
        return "drive9";
      case 0x03:
        return "drive10";
      case 0x04:
        return "drive11";
      default:
        return `memspace-${memspace}`;
    }
  }
  
  function parseBreakpointOperation(value?: string): number {
    switch ((value ?? "exec").toLowerCase()) {
      case "load":
        return 0x01;
      case "store":
        return 0x02;
      case "exec":
        return 0x04;
      default:
        throw new Error(`Unsupported breakpoint operation: ${value}`);
    }
  }
  
  function formatBreakpointOperation(value: number): string {
    const parts: string[] = [];
    if (value & 0x01) parts.push("load");
    if (value & 0x02) parts.push("store");
    if (value & 0x04) parts.push("exec");
    return parts.join("+") || `op-${value}`;
  }
  
  function parseResetTarget(value?: string): number {
    switch ((value ?? "system").toLowerCase()) {
      case "system":
        return 0x00;
      case "power":
        return 0x01;
      case "drive8":
        return 0x08;
      case "drive9":
        return 0x09;
      case "drive10":
        return 0x0a;
      case "drive11":
        return 0x0b;
      default:
        throw new Error(`Unsupported reset target: ${value}`);
    }
  }
  
  function formatMonitorEvent(event: ViceMonitorEvent): string {
    switch (event.kind) {
      case "checkpoint":
        return [
          `Event: checkpoint hit`,
          `Checkpoint #: ${event.checkpoint.checkpointNumber}`,
          `Range: ${formatHexWord(event.checkpoint.startAddress)}-${formatHexWord(event.checkpoint.endAddress)}`,
          `Hit count: ${event.checkpoint.hitCount}`,
        ].join("\n");
      case "stopped":
        return `Event: stopped\nPC: ${formatHexWord(event.pc)}`;
      case "jam":
        return `Event: jam\nPC: ${formatHexWord(event.pc)}`;
      case "resumed":
        return `Event: resumed\nPC: ${formatHexWord(event.pc)}`;
      case "registers":
        return `Event: registers broadcast\nCount: ${event.registers.length}`;
    }
  }
  
  const VICE_TRACE_DEFAULT_INTERVAL_MS = 100;
  const VICE_TRACE_DEFAULT_CPU_HISTORY_COUNT = 65_535;
  const VICE_TRACE_DEFAULT_MONITOR_CHIS_LINES = 16_777_215;
  
  function viceTraceAnalysisToContent(
    analysis: ViceTraceAnalysis,
    headline: string,
    stopMethod: string,
  ): { content: [{ type: "text"; text: string }] } {
    const lines = [
      headline,
      `Session: ${analysis.sessionId}`,
      `Stop method: ${stopMethod}`,
      `State: ${analysis.state}`,
      `Stop reason: ${analysis.stopReason ?? "unknown"}`,
      `CPU history items: ${analysis.cpuHistoryItems}`,
    ];
  
    if (analysis.media) {
      lines.push(`Media: ${analysis.media.path}`);
      lines.push(`Media type: ${analysis.media.type} (${analysis.media.autostart ? "autostart" : "attach only"})`);
    }
    if (analysis.durationMs !== undefined) {
      lines.push(`Duration: ${analysis.durationMs} ms`);
    }
    if (analysis.currentPc !== undefined) {
      lines.push(`Current PC: ${formatHexWord(analysis.currentPc)}`);
    }
  
    lines.push("Region buckets:");
    for (const [name, count] of Object.entries(analysis.regionBuckets)) {
      lines.push(`- ${name}: ${count}`);
    }
  
    if (analysis.topPcs.length > 0) {
      lines.push("Top PCs:");
      for (const pc of analysis.topPcs.slice(0, 8)) {
        lines.push(`- ${formatHexWord(pc.pc)}: ${pc.count}`);
      }
    }
  
    lines.push("Artifacts:");
    lines.push(`- session: ${analysis.artifacts.sessionPath}`);
    lines.push(`- summary: ${analysis.artifacts.summaryPath}`);
    lines.push(`- events: ${analysis.artifacts.eventsLogPath}`);
    lines.push(`- snapshot: ${analysis.artifacts.traceSnapshotPath}`);
    lines.push(`- analysis: ${analysis.artifacts.traceAnalysisPath}`);
    lines.push(`- runtime trace: ${analysis.artifacts.runtimeTracePath}`);
  
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
  
  function viceRuntimeTraceStatusToContent(
    status: {
      sessionId: string;
      active: boolean;
      intervalMs?: number;
      cpuHistoryCount?: number;
      monitorChisLines?: number;
      sampleIndex: number;
      lastClock?: string;
      tracePath: string;
    },
    headline: string,
  ): { content: [{ type: "text"; text: string }] } {
    const lines = [
      headline,
      `Session: ${status.sessionId}`,
      `Active: ${status.active ? "yes" : "no"}`,
      `Sample index: ${status.sampleIndex}`,
      `Trace path: ${status.tracePath}`,
    ];
    if (status.intervalMs !== undefined) lines.push(`Interval: ${status.intervalMs} ms`);
    if (status.cpuHistoryCount !== undefined) lines.push(`CPU history count: ${status.cpuHistoryCount}`);
    if (status.monitorChisLines !== undefined) lines.push(`MonitorChisLines: ${status.monitorChisLines}`);
    if (status.lastClock !== undefined) lines.push(`Last clock: ${status.lastClock}`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
  
  function formatTraceMatch(match: ViceTraceMatch): string {
    const bytes = match.instructionBytes.map(formatHexByte).join(" ");
    const pc = match.pc === undefined ? "?" : formatHexWord(match.pc);
    const registers = ["A", "X", "Y", "SP", "FL"]
      .filter((name) => match.registers[name] !== undefined)
      .map((name) => `${name}=${match.registers[name]}`)
      .join(" ");
    return `${pc}  [${bytes}]  sample=${match.sampleIndex} clock=${match.clock}${registers ? `  ${registers}` : ""}`;
  }
  
  function formatSemanticLink(entry?: ViceTraceIndexEntry): string | undefined {
    const semantic = entry?.semantic;
    if (!semantic) {
      return undefined;
    }
    const parts: string[] = [];
    if (semantic.label) parts.push(`label=${semantic.label}`);
    if (semantic.routineName) parts.push(`routine=${semantic.routineName}`);
    if (semantic.segmentKind) parts.push(`segment=${semantic.segmentKind}`);
    if (semantic.segmentLabel) parts.push(`segment_label=${semantic.segmentLabel}`);
    return parts.length > 0 ? `  -> ${parts.join(" | ")}` : undefined;
  }
  
  function formatTraceInstructionEvent(event: ViceTraceInstructionEvent): string {
    const bytes = event.instructionBytes.map(formatHexByte).join(" ");
    const pc = event.pc === undefined ? "?" : formatHexWord(event.pc);
    const registers = ["A", "X", "Y", "SP", "FL"]
      .filter((name) => event.registers[name] !== undefined)
      .map((name) => `${name}=${event.registers[name]}`)
      .join(" ");
    return `${pc}  [${bytes}]  sample=${event.sampleIndex} clock=${event.clock}${registers ? `  ${registers}` : ""}`;
  }
  
  function traceNotesToContent(notes: ViceTraceNote[], sessionId: string): { content: [{ type: "text"; text: string }] } {
    const lines = [`Trace notes for session ${sessionId}:`, `Count: ${notes.length}`];
    for (const note of notes) {
      lines.push("");
      lines.push(`[${note.ts}] ${note.title}`);
      if (note.anchorClock) lines.push(`Clock: ${note.anchorClock}`);
      if (note.pc !== undefined) lines.push(`PC: ${formatHexWord(note.pc)}`);
      if (note.sampleIndex !== undefined) lines.push(`Sample: ${note.sampleIndex}`);
      lines.push(note.note);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
  
  function getIndexedPcEntry(index: ViceTraceIndex | undefined, pc: number | undefined): ViceTraceIndexEntry | undefined {
    if (!index || pc === undefined) {
      return undefined;
    }
    return index.pcIndex.find((entry) => entry.pc === pc);
  }
  
  function formatTraceWindowSummary(window: ViceTraceWindowSummary): string {
    const parts = [
      `window=${window.windowIndex}`,
      `level=${window.level}`,
      `size=${window.size}`,
      `phase=${window.phaseId}`,
      `instructions=${window.instructionCount}`,
      `clock=${window.startClock}->${window.endClock}`,
    ];
    if (window.dominantRoutine) parts.push(`routine=${window.dominantRoutine}`);
    if (window.dominantSegment) parts.push(`segment=${window.dominantSegment}`);
    if (window.dominantPc !== undefined) parts.push(`pc=${formatHexWord(window.dominantPc)}`);
    return parts.join("  ");
  }
  
  function formatTracePhaseSummary(phase: ViceTracePhaseSummary): string {
    const parts = [
      `phase=${phase.phaseId}`,
      `windows=${phase.startWindowIndex}-${phase.endWindowIndex}`,
      `instructions=${phase.instructionCount}`,
      `clock=${phase.startClock}->${phase.endClock}`,
    ];
    if (phase.dominantRoutine) parts.push(`routine=${phase.dominantRoutine}`);
    if (phase.dominantSegment) parts.push(`segment=${phase.dominantSegment}`);
    return parts.join("  ");
  }
  
  function formatPhaseBoundary(boundary: ViceTracePhaseBoundary): string {
    const reasons = boundary.reasons.length > 0 ? `  reasons=${boundary.reasons.join("; ")}` : "";
    return `window ${boundary.previousWindowIndex} -> ${boundary.currentWindowIndex}  phase ${boundary.previousPhaseId} -> ${boundary.currentPhaseId}  score=${boundary.score}${reasons}`;
  }
  
  function formatAddressStats(stats: ViceTraceContextWriteStat[]): string {
    if (stats.length === 0) {
      return "none";
    }
    return stats
      .map((entry) => `${formatHexWord(entry.address)} r=${entry.reads} w=${entry.writes}`)
      .join(", ");
  }
  
  function formatTraceContextSummary(context: ViceTraceContextSummary): string {
    const parts = [
      `${context.id}`,
      `kind=${context.kind}`,
      `confidence=${context.confidence}`,
      `instructions=${context.instructionCount}`,
      `clock=${context.entryClock}->${context.exitClock}`,
    ];
    if (context.entryPc !== undefined) parts.push(`entry=${formatHexWord(context.entryPc)}`);
    if (context.exitPc !== undefined) parts.push(`exit=${formatHexWord(context.exitPc)}`);
    if (context.dominantRoutine) parts.push(`routine=${context.dominantRoutine}`);
    parts.push(`classification=${context.classification}`);
    return parts.join("  ");
  }
  
  // ── Tool: vice-session-start ─────────────────────────────────────────
  server.tool(
      "vice_session_start",
      "Start a visible x64sc VICE session using a copied user config. Optional media is attached or autostarted via VICE start arguments. Only one active session is supported.",
      {
        media_path: z.string().optional().describe("Optional path to a PRG/CRT/D64/G64 file to attach on startup"),
        media_type: z.enum(["prg", "crt", "d64", "g64"]).optional().describe("Optional media type override"),
        autostart: z.boolean().optional().describe("Autostart media on startup (default: true). D64/G64 with false attaches to drive 8 only."),
      },
      async ({ media_path, media_type, autostart }) => {
        try {
          const { manager } = await resolveViceManager(media_path);
          const record = await manager.startSession({
            mediaPath: media_path,
            mediaType: media_type,
            autostart,
          });
          return viceSessionToContent(record, "VICE session started.");
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-runtime-start ──────────────────────────────────
    server.tool(
      "vice_trace_runtime_start",
      "Start a visible VICE session with periodic CPU-history sampling. The user can interact with the emulator and close VICE manually; use vice_trace_analyze_last_session afterwards.",
      {
        media_path: z.string().optional().describe("Path to a PRG/CRT/D64/G64 file to attach on startup"),
        media_type: z.enum(["prg", "crt", "d64", "g64"]).optional().describe("Optional media type override"),
        autostart: z.boolean().optional().describe("Autostart media on startup (default: true)"),
        bootstrap_reset: z.boolean().optional().describe("After the binary monitor is attached, issue a system reset and continue before tracing begins. Defaults to true when no media is provided."),
        sample_interval_ms: z.number().int().positive().optional().describe(`Delay between runtime-trace samples (default: ${VICE_TRACE_DEFAULT_INTERVAL_MS})`),
        cpu_history_count: z.number().int().positive().optional().describe(`CPU-history depth to request per sample (default: ${VICE_TRACE_DEFAULT_CPU_HISTORY_COUNT})`),
        monitor_chis_lines: z.number().int().positive().optional().describe(`Monitor CPU-history retention size to configure for the session (default: ${VICE_TRACE_DEFAULT_MONITOR_CHIS_LINES})`),
      },
      async ({ media_path, media_type, autostart, bootstrap_reset, sample_interval_ms, cpu_history_count, monitor_chis_lines }) => {
        try {
          const { manager } = await resolveViceManager(media_path);
          const record = await manager.startSession({
            mediaPath: media_path,
            mediaType: media_type,
            autostart,
            runtimeTraceBootstrapReset: bootstrap_reset ?? !media_path,
            runtimeTrace: {
              enabled: true,
              intervalMs: sample_interval_ms ?? VICE_TRACE_DEFAULT_INTERVAL_MS,
              cpuHistoryCount: cpu_history_count ?? VICE_TRACE_DEFAULT_CPU_HISTORY_COUNT,
              monitorChisLines: monitor_chis_lines ?? VICE_TRACE_DEFAULT_MONITOR_CHIS_LINES,
            },
          });
          return viceSessionToContent(record, "VICE runtime trace session started.");
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-start ──────────────────────────────────────────
    server.tool(
      "vice_trace_start",
      "Enable periodic CPU-history sampling on the active VICE session without restarting the emulator.",
      {
        sample_interval_ms: z.number().int().positive().optional().describe(`Delay between runtime-trace samples (default: ${VICE_TRACE_DEFAULT_INTERVAL_MS})`),
        cpu_history_count: z.number().int().positive().optional().describe(`CPU-history depth to request per sample (default: ${VICE_TRACE_DEFAULT_CPU_HISTORY_COUNT})`),
        monitor_chis_lines: z.number().int().positive().optional().describe(`Monitor CPU-history retention size to record in trace config (default: ${VICE_TRACE_DEFAULT_MONITOR_CHIS_LINES})`),
      },
      async ({ sample_interval_ms, cpu_history_count, monitor_chis_lines }) => {
        try {
          const { manager } = await resolveViceManager();
          const status = await manager.startRuntimeTrace({
            enabled: true,
            intervalMs: sample_interval_ms ?? VICE_TRACE_DEFAULT_INTERVAL_MS,
            cpuHistoryCount: cpu_history_count ?? VICE_TRACE_DEFAULT_CPU_HISTORY_COUNT,
            monitorChisLines: monitor_chis_lines ?? VICE_TRACE_DEFAULT_MONITOR_CHIS_LINES,
          });
          return viceRuntimeTraceStatusToContent(status, "VICE runtime trace started.");
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-status ─────────────────────────────────────────
    server.tool(
      "vice_trace_status",
      "Report whether runtime tracing is currently active on the active VICE session.",
      {},
      async () => {
        try {
          const { manager } = await resolveViceManager();
          const status = await manager.getRuntimeTraceStatus();
          if (!status) {
            return { content: [{ type: "text" as const, text: "No active VICE session exists." }] };
          }
          return viceRuntimeTraceStatusToContent(status, "VICE runtime trace status.");
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-stop ───────────────────────────────────────────
    server.tool(
      "vice_trace_stop",
      "Stop periodic CPU-history sampling on the active VICE session without closing VICE.",
      {},
      async () => {
        try {
          const { manager } = await resolveViceManager();
          const status = await manager.stopRuntimeTrace();
          return viceRuntimeTraceStatusToContent(status, "VICE runtime trace stopped.");
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-session-status ────────────────────────────────────────
    server.tool(
      "vice_session_status",
      "Report the current or most recent VICE session state, including workspace paths and monitor-port readiness.",
      {},
      async () => {
        try {
          const { manager } = await resolveViceManager();
          const record = await manager.getStatus();
          if (!record) {
            return { content: [{ type: "text" as const, text: "No VICE session exists." }] };
          }
          return viceSessionToContent(record, "VICE session status.");
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-session-stop ──────────────────────────────────────────
    server.tool(
      "vice_session_stop",
      "Stop the active VICE session. The server waits briefly, then escalates to SIGTERM and SIGKILL if needed, and finalizes session artifacts.",
      {},
      async () => {
        try {
          const { manager } = await resolveViceManager();
          const result = await manager.stopSession();
          return viceSessionToContent(result.record, `VICE session stopped via ${result.stopMethod}.`);
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-stop-and-analyze ───────────────────────────────
    server.tool(
      "vice_trace_stop_and_analyze",
      "Capture a final register snapshot plus CPU history from the active VICE session, stop the session, write trace artifacts, and return a compact analysis summary.",
      {
        cpu_history_count: z.number().int().positive().optional().describe("How many CPU-history items to request before stopping (default: 20000)"),
      },
      async ({ cpu_history_count }) => {
        try {
          const { manager } = await resolveViceManager();
          const result = await manager.stopAndAnalyze(cpu_history_count ?? 20_000);
          return viceTraceAnalysisToContent(result.analysis, "VICE trace captured and analyzed.", result.stopMethod);
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-analyze-last-session ───────────────────────────
    server.tool(
      "vice_trace_analyze_last_session",
      "Analyze the most recently completed VICE runtime-trace session. Use this after the user has closed VICE manually.",
      {},
      async () => {
        try {
          const { manager } = await resolveViceManager();
          const analysis = await manager.analyzeLastSession();
          return viceTraceAnalysisToContent(analysis, "VICE runtime trace analyzed.", "manual_exit");
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-build-index ────────────────────────────────────
    server.tool(
      "vice_trace_build_index",
      "Build a persistent search index for a completed runtime trace, including continuity metrics and optional semantic links from an annotations JSON.",
      {
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        annotations_path: z.string().optional().describe("Optional path to an _annotations.json file used to link observed PCs back to semantic code knowledge."),
      },
      async ({ session_id, annotations_path }) => {
        try {
          const pd = annotations_path ? projectDir(annotations_path) : await resolveTraceProjectDir();
          const record = await loadTraceSession(pd, session_id);
          const annotationsPath = annotations_path ? resolve(pd, annotations_path) : undefined;
          const index = await buildTraceIndex(record, { annotationsPath });
          const lines = [
            `Trace index built for session ${record.sessionId}.`,
            `Index path: ${record.workspace.traceIndexPath ?? join(dirname(record.workspace.runtimeTracePath), "trace-index.json")}`,
            `Trace path: ${record.workspace.runtimeTracePath}`,
            `Continuity: ${index.continuity.status}`,
            `Samples: ${index.continuity.sampleCount}`,
            `Max clock gap: ${index.continuity.maxClockGap}`,
            `Full-window samples: ${index.continuity.fullWindowSampleCount}`,
            `Saturated samples: ${index.continuity.saturatedSampleCount}`,
            `Indexed PCs: ${index.pcIndex.length}`,
          ];
          if (index.annotationsPath) {
            lines.push(`Semantic links: ${index.annotationsPath}`);
          }
          if (index.continuity.maxClockGapBetweenSamples) {
            const gap = index.continuity.maxClockGapBetweenSamples;
            lines.push(`Largest gap between samples: ${gap.previousSampleIndex} -> ${gap.currentSampleIndex} (${gap.previousClockLast} -> ${gap.currentClockFirst})`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-build-pyramid-index ────────────────────────────
    server.tool(
      "vice_trace_build_pyramid_index",
      "Build a persistent semantic zoom index over the raw VICE runtime trace, including multi-scale windows, aggregate routine/segment/address summaries, and phase detection.",
      {
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        annotations_path: z.string().optional().describe("Optional path to an _annotations.json file used to attach routine/segment semantics."),
        window_sizes: z.array(z.number().int().positive()).optional().describe("Optional explicit window sizes in instructions, e.g. [256, 1024, 4096]."),
      },
      async ({ session_id, annotations_path, window_sizes }) => {
        try {
          const pd = annotations_path ? projectDir(annotations_path) : await resolveTraceProjectDir();
          const record = await loadTraceSession(pd, session_id);
          const annotationsPath = annotations_path ? resolve(pd, annotations_path) : undefined;
          const index = await buildTraceWindowIndex(record, {
            annotationsPath,
            windowSizes: window_sizes,
          });
          const lines = [
            `Trace pyramid index built for session ${record.sessionId}.`,
            `Index path: ${record.workspace.traceWindowIndexPath}`,
            `Trace path: ${record.workspace.runtimeTracePath}`,
            `Levels: ${index.levels.map((level) => `${level.level}:${level.size}x${level.windowCount}`).join(", ")}`,
            `Phases: ${index.phases.length}`,
            `Phase boundaries: ${index.phaseBoundaries.length}`,
            `Total instructions: ${index.overview.totalInstructions}`,
            `Unique PCs: ${index.overview.uniquePcCount}`,
            `Unique routines: ${index.overview.uniqueRoutineCount}`,
            `Unique segments: ${index.overview.uniqueSegmentCount}`,
            `Unique addresses: ${index.overview.uniqueAddressCount}`,
          ];
          if (index.annotationsPath) {
            lines.push(`Semantic links: ${index.annotationsPath}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-build-context-index ────────────────────────────
    server.tool(
      "vice_trace_build_context_index",
      "Build a persistent interrupt/context index for the VICE runtime trace so IRQ/NMI-like execution paths can be isolated without scanning the full raw trace every time.",
      {
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        annotations_path: z.string().optional().describe("Optional path to an _annotations.json file used to identify known IRQ/NMI handlers."),
      },
      async ({ session_id, annotations_path }) => {
        try {
          const pd = annotations_path ? projectDir(annotations_path) : await resolveTraceProjectDir();
          const record = await loadTraceSession(pd, session_id);
          const annotationsPath = annotations_path ? resolve(pd, annotations_path) : undefined;
          const index = await buildTraceContextIndex(record, { annotationsPath });
          const lines = [
            `Trace context index built for session ${record.sessionId}.`,
            `Index path: ${record.workspace.traceContextIndexPath}`,
            `Trace path: ${record.workspace.runtimeTracePath}`,
            `Contexts: ${index.contexts.length}`,
          ];
          if (index.annotationsPath) {
            lines.push(`Semantic links: ${index.annotationsPath}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-hotspots ───────────────────────────────────────
    server.tool(
      "vice_trace_hotspots",
      "Summarize the hottest PCs in a completed VICE runtime trace. Use this as the first entry point before drilling into slices.",
      {
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        limit: z.number().int().positive().optional().describe("How many hotspots to return (default: 20)"),
      },
      async ({ session_id, limit }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const index = await loadTraceIndex(record);
          const hotspots = await traceHotspots(record, limit ?? 20);
          const lines = [
            `Trace hotspots for session ${record.sessionId}:`,
            `Trace file: ${record.workspace.runtimeTracePath}`,
            `Count: ${hotspots.length}`,
          ];
          if (index) {
            lines.push(`Indexed continuity: ${index.continuity.status} (max clock gap ${index.continuity.maxClockGap})`);
          }
          for (const hotspot of hotspots) {
            lines.push(`${formatHexWord(hotspot.pc)}  count=${hotspot.count}  firstSample=${hotspot.firstSampleIndex}  lastSample=${hotspot.lastSampleIndex}  firstClock=${hotspot.firstClock}  lastClock=${hotspot.lastClock}`);
            const semantic = formatSemanticLink(getIndexedPcEntry(index, hotspot.pc));
            if (semantic) {
              lines.push(semantic);
            }
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-zoom-overview ──────────────────────────────────
    server.tool(
      "vice_trace_zoom_overview",
      "Summarize the multi-scale trace pyramid so you can zoom out to the dominant windows and detected execution phases before opening raw slices.",
      {
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        level: z.number().int().nonnegative().optional().describe("Optional pyramid level to highlight. Defaults to 0."),
        limit: z.number().int().positive().optional().describe("How many windows/phases to include (default: 8)."),
      },
      async ({ session_id, level, limit }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const index = await loadTraceWindowIndex(record);
          if (!index) {
            throw new Error(`Trace pyramid index not found at ${record.workspace.traceWindowIndexPath}. Run vice_trace_build_pyramid_index first.`);
          }
          const levelEntry = index.levels.find((entry) => entry.level === (level ?? 0)) ?? index.levels[0];
          if (!levelEntry) {
            throw new Error("Trace pyramid index contains no levels.");
          }
          const lines = [
            `Trace zoom overview for session ${record.sessionId}:`,
            `Index path: ${record.workspace.traceWindowIndexPath}`,
            `Selected level: ${levelEntry.level} (window size ${levelEntry.size})`,
            `Windows at level: ${levelEntry.windowCount}`,
            `Phases: ${index.phases.length}`,
            `Phase boundaries: ${index.phaseBoundaries.length}`,
            `Total instructions: ${index.overview.totalInstructions}`,
            `Top routines: ${index.overview.topRoutines.slice(0, 6).map((entry) => `${entry.key}=${entry.count}`).join(", ") || "none"}`,
            `Top segments: ${index.overview.topSegments.slice(0, 6).map((entry) => `${entry.key}=${entry.count}`).join(", ") || "none"}`,
            `Top addresses: ${index.overview.topAddresses.slice(0, 6).map((entry) => `${formatHexWord(entry.address)} r=${entry.reads} w=${entry.writes}`).join(", ") || "none"}`,
            "",
            "Phases:",
          ];
          for (const phase of index.phases.slice(0, limit ?? 8)) {
            lines.push(formatTracePhaseSummary(phase));
          }
          lines.push("");
          lines.push(`Windows at level ${levelEntry.level}:`);
          for (const window of levelEntry.windows.slice(0, limit ?? 8)) {
            lines.push(formatTraceWindowSummary(window));
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-zoom-window ────────────────────────────────────
    server.tool(
      "vice_trace_zoom_window",
      "Inspect one window from the trace pyramid, or drill into all base windows that belong to a detected phase.",
      {
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        level: z.number().int().nonnegative().optional().describe("Pyramid level for a direct window lookup (default: 0)."),
        window_index: z.number().int().nonnegative().optional().describe("Window index inside the selected level."),
        phase_id: z.number().int().nonnegative().optional().describe("Optional phase id to inspect instead of a single window."),
      },
      async ({ session_id, level, window_index, phase_id }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const index = await loadTraceWindowIndex(record);
          if (!index) {
            throw new Error(`Trace pyramid index not found at ${record.workspace.traceWindowIndexPath}. Run vice_trace_build_pyramid_index first.`);
          }
  
          const lines: string[] = [`Trace zoom detail for session ${record.sessionId}:`, `Index path: ${record.workspace.traceWindowIndexPath}`];
          if (phase_id !== undefined) {
            const phase = index.phases.find((entry) => entry.phaseId === phase_id);
            if (!phase) {
              throw new Error(`Phase ${phase_id} not found.`);
            }
            lines.push(formatTracePhaseSummary(phase));
            lines.push(`Top addresses: ${formatAddressStats(phase.topAddresses.slice(0, 10))}`);
            lines.push("");
            lines.push("Base windows in phase:");
            const baseLevel = index.levels.find((entry) => entry.level === 0);
            for (const window of (baseLevel?.windows ?? []).filter((entry) => entry.phaseId === phase_id)) {
              lines.push(formatTraceWindowSummary(window));
            }
          } else {
            if (window_index === undefined) {
              throw new Error("Provide either phase_id or window_index.");
            }
            const levelEntry = index.levels.find((entry) => entry.level === (level ?? 0));
            if (!levelEntry) {
              throw new Error(`Level ${level ?? 0} not found.`);
            }
            const window = levelEntry.windows.find((entry) => entry.windowIndex === window_index);
            if (!window) {
              throw new Error(`Window ${window_index} not found at level ${levelEntry.level}.`);
            }
            lines.push(formatTraceWindowSummary(window));
            lines.push(`Top routines: ${window.topRoutines.map((entry) => `${entry.key}=${entry.count}`).join(", ") || "none"}`);
            lines.push(`Top segments: ${window.topSegments.map((entry) => `${entry.key}=${entry.count}`).join(", ") || "none"}`);
            lines.push(`Top addresses: ${formatAddressStats(window.topAddresses.slice(0, 10))}`);
            lines.push(`Feature vector: calls=${window.features.callCount} returns=${window.features.returnCount} branches=${window.features.branchCount} writes=${window.features.writeCount} io_writes=${window.features.ioWriteCount} vector_writes=${window.features.vectorWriteCount} rti=${window.features.rtiCount}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-find-phase-changes ─────────────────────────────
    server.tool(
      "vice_trace_find_phase_changes",
      "List the strongest phase boundaries detected from the trace window feature vectors.",
      {
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        limit: z.number().int().positive().optional().describe("How many boundaries to include (default: 12)."),
      },
      async ({ session_id, limit }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const index = await loadTraceWindowIndex(record);
          if (!index) {
            throw new Error(`Trace pyramid index not found at ${record.workspace.traceWindowIndexPath}. Run vice_trace_build_pyramid_index first.`);
          }
          const lines = [
            `Phase boundaries for session ${record.sessionId}:`,
            `Count: ${index.phaseBoundaries.length}`,
          ];
          for (const boundary of index.phaseBoundaries.slice(0, limit ?? 12)) {
            lines.push(formatPhaseBoundary(boundary));
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-find-pc ────────────────────────────────────────
    server.tool(
      "vice_trace_find_pc",
      "Find occurrences of a specific PC in a completed VICE runtime trace. Returns anchor clocks you can pass to vice_trace_slice.",
      {
        pc: z.string().describe("Hex PC to search for, e.g. 63A1"),
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        limit: z.number().int().positive().optional().describe("How many matches to return (default: 20)"),
      },
      async ({ pc, session_id, limit }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const pcValue = parseHexWord(pc);
          const index = await loadTraceIndex(record);
          const matches = await findTraceByPc(record, pcValue, limit ?? 20);
          const lines = [
            `Trace PC search for ${formatHexWord(pcValue)} in session ${record.sessionId}:`,
            `Trace file: ${record.workspace.runtimeTracePath}`,
            `Matches: ${matches.length}`,
          ];
          if (index) {
            lines.push(`Indexed continuity: ${index.continuity.status} (max clock gap ${index.continuity.maxClockGap})`);
          }
          for (const match of matches) {
            lines.push(formatTraceMatch(match));
            const semantic = formatSemanticLink(getIndexedPcEntry(index, match.pc));
            if (semantic) {
              lines.push(semantic);
            }
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-list-contexts ──────────────────────────────────
    server.tool(
      "vice_trace_list_contexts",
      "List indexed IRQ/NMI/interrupt contexts so you can isolate a handler execution path before opening raw trace slices.",
      {
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        kind: z.enum(["irq", "nmi", "interrupt"]).optional().describe("Optional context kind filter."),
        limit: z.number().int().positive().optional().describe("How many contexts to include (default: 20)."),
      },
      async ({ session_id, kind, limit }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const index = await loadTraceContextIndex(record);
          if (!index) {
            throw new Error(`Trace context index not found at ${record.workspace.traceContextIndexPath}. Run vice_trace_build_context_index first.`);
          }
          const contexts = index.contexts
            .filter((entry) => !kind || entry.kind === kind)
            .sort((left, right) => BigInt(left.entryClock) > BigInt(right.entryClock) ? 1 : -1)
            .slice(0, limit ?? 20);
          const lines = [
            `Trace contexts for session ${record.sessionId}:`,
            `Index path: ${record.workspace.traceContextIndexPath}`,
            `Count: ${contexts.length}`,
          ];
          for (const context of contexts) {
            lines.push(formatTraceContextSummary(context));
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-slice-context ──────────────────────────────────
    server.tool(
      "vice_trace_slice_context",
      "Return the raw instruction slice for one indexed interrupt context, with optional padding before and after the context span.",
      {
        context_id: z.string().describe("Context id from vice_trace_list_contexts, e.g. ctx-0003"),
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        before: z.number().int().nonnegative().optional().describe("How many instructions before the context to include."),
        after: z.number().int().nonnegative().optional().describe("How many instructions after the context to include."),
      },
      async ({ context_id, session_id, before, after }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const index = await loadTraceContextIndex(record);
          if (!index) {
            throw new Error(`Trace context index not found at ${record.workspace.traceContextIndexPath}. Run vice_trace_build_context_index first.`);
          }
          const context = index.contexts.find((entry) => entry.id === context_id);
          if (!context) {
            throw new Error(`Context ${context_id} not found.`);
          }
          const slice = await sliceTraceContext(record, context, before ?? 0, after ?? 0);
          const lines = [
            `Trace context slice for session ${record.sessionId}:`,
            formatTraceContextSummary(context),
            `Events returned: ${slice.events.length}`,
          ];
          for (const event of slice.events) {
            lines.push(formatTraceInstructionEvent(event));
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-context-writes ─────────────────────────────────
    server.tool(
      "vice_trace_context_writes",
      "Show the dominant memory writes and call edges recorded for one indexed interrupt context.",
      {
        context_id: z.string().describe("Context id from vice_trace_list_contexts, e.g. ctx-0003"),
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      },
      async ({ context_id, session_id }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const index = await loadTraceContextIndex(record);
          if (!index) {
            throw new Error(`Trace context index not found at ${record.workspace.traceContextIndexPath}. Run vice_trace_build_context_index first.`);
          }
          const context = index.contexts.find((entry) => entry.id === context_id);
          if (!context) {
            throw new Error(`Context ${context_id} not found.`);
          }
          const lines = [
            `Trace context writes for session ${record.sessionId}:`,
            formatTraceContextSummary(context),
            `Top writes: ${formatAddressStats(context.topWrites)}`,
            "Call edges:",
          ];
          if (context.callEdges.length === 0) {
            lines.push("none");
          } else {
            for (const edge of context.callEdges) {
              lines.push(`${formatHexWord(edge.fromPc)} -> ${formatHexWord(edge.toPc)}  count=${edge.count}`);
            }
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-follow-from-pc ─────────────────────────────────
    server.tool(
      "vice_trace_follow_from_pc",
      "Follow the concrete linear execution path after entering a given PC in the completed runtime trace. Useful for questions like 'I entered at $8400, what happened next exactly?'",
      {
        pc: z.string().describe("Hex PC to start from, e.g. 8400"),
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        occurrence: z.number().int().positive().optional().describe("Which occurrence of that PC to follow (default: 1)."),
        max_instructions: z.number().int().positive().optional().describe("Maximum instructions to include before truncating (default: 200)."),
        stop_on_return: z.boolean().optional().describe("Whether to stop when the traced frame returns via RTS/RTI (default: true)."),
      },
      async ({ pc, session_id, occurrence, max_instructions, stop_on_return }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const pcValue = parseHexWord(pc);
          const result = await followTraceFromPc(record, pcValue, {
            occurrence,
            maxInstructions: max_instructions,
            stopOnReturn: stop_on_return,
          });
          const lines = [
            `Trace follow-from-PC for ${formatHexWord(pcValue)} in session ${record.sessionId}:`,
            `Occurrence: ${result.occurrence}`,
            `Found: ${result.found ? "yes" : "no"}`,
            `Stop reason: ${result.stopReason}`,
            `Anchor clock: ${result.anchorClock ?? "n/a"}`,
            `Events returned: ${result.events.length}`,
          ];
          for (const event of result.events) {
            lines.push(formatTraceInstructionEvent(event));
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-find-bytes ─────────────────────────────────────
    server.tool(
      "vice_trace_find_bytes",
      "Find instructions in a completed VICE runtime trace by raw byte pattern. Useful when you know the exact opcode bytes from ASM.",
      {
        bytes: z.string().describe("Byte pattern, e.g. 'A9 FE 8D 00 DC' or 'A9FE8D00DC'"),
        mode: z.enum(["prefix", "exact", "contains"]).optional().describe("Match mode (default: prefix)"),
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        limit: z.number().int().positive().optional().describe("How many matches to return (default: 20)"),
      },
      async ({ bytes, mode, session_id, limit }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const parsedBytes = parseHexByteSequence(bytes);
          const matches = await findTraceByBytes(record, parsedBytes, mode ?? "prefix", limit ?? 20);
          const lines = [
            `Trace byte search [${parsedBytes.map(formatHexByte).join(" ")}] in session ${record.sessionId}:`,
            `Mode: ${mode ?? "prefix"}`,
            `Matches: ${matches.length}`,
          ];
          for (const match of matches) {
            lines.push(formatTraceMatch(match));
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-find-operand ───────────────────────────────────
    server.tool(
      "vice_trace_find_operand",
      "Find instructions in a completed VICE runtime trace whose raw instruction bytes contain a target operand address. Useful for I/O and data-address probing.",
      {
        address: z.string().describe("Hex address to search inside instruction operands, e.g. D020 or DC00"),
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        limit: z.number().int().positive().optional().describe("How many matches to return (default: 20)"),
      },
      async ({ address, session_id, limit }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const parsedAddress = parseHexWord(address);
          const matches = await findTraceByOperand(record, parsedAddress, limit ?? 20);
          const lines = [
            `Trace operand search for ${formatHexWord(parsedAddress)} in session ${record.sessionId}:`,
            `Matches: ${matches.length}`,
          ];
          for (const match of matches) {
            lines.push(formatTraceMatch(match));
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-find-memory-access ─────────────────────────────
    server.tool(
      "vice_trace_find_memory_access",
      "Find direct memory accesses to a specific address in a completed VICE runtime trace, classified as read, write, or readwrite when possible.",
      {
        address: z.string().describe("Hex address to match as a direct instruction operand, e.g. D020 or DC00"),
        access: z.enum(["any", "read", "write", "readwrite"]).optional().describe("Access kind filter (default: any)"),
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        limit: z.number().int().positive().optional().describe("How many matches to return (default: 20)"),
      },
      async ({ address, access, session_id, limit }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const parsedAddress = parseHexWord(address);
          const index = await loadTraceIndex(record);
          const matches = await findTraceMemoryAccess(record, parsedAddress, access ?? "any", limit ?? 20);
          const lines = [
            `Trace memory-access search for ${formatHexWord(parsedAddress)} in session ${record.sessionId}:`,
            `Access filter: ${access ?? "any"}`,
            `Matches: ${matches.length}`,
          ];
          if (index) {
            lines.push(`Indexed continuity: ${index.continuity.status} (max clock gap ${index.continuity.maxClockGap})`);
          }
          for (const match of matches) {
            lines.push(formatTraceMatch(match));
            const semantic = formatSemanticLink(getIndexedPcEntry(index, match.pc));
            if (semantic) {
              lines.push(semantic);
            }
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-slice ──────────────────────────────────────────
    server.tool(
      "vice_trace_slice",
      "Return a focused instruction window around an anchor clock from a completed VICE runtime trace. Use this after vice_trace_find_pc or vice_trace_find_bytes.",
      {
        anchor_clock: z.string().describe("Exact clock value from a trace match"),
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        before: z.number().int().nonnegative().optional().describe("How many instructions before the anchor to include (default: 40)"),
        after: z.number().int().nonnegative().optional().describe("How many instructions after the anchor to include (default: 80)"),
      },
      async ({ anchor_clock, session_id, before, after }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const slice = await sliceTraceByClock(record, anchor_clock, before ?? 40, after ?? 80);
          const lines = [
            `Trace slice for session ${record.sessionId}:`,
            `Anchor clock: ${anchor_clock}`,
            `Found: ${slice.found ? "yes" : "no"}`,
            `Events returned: ${slice.events.length}`,
          ];
          for (const event of slice.events) {
            lines.push(formatTraceInstructionEvent(event));
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-call-path ──────────────────────────────────────
    server.tool(
      "vice_trace_call_path",
      "Heuristically reconstruct the JSR caller chain leading to an anchor clock in a completed runtime trace.",
      {
        anchor_clock: z.string().describe("Exact clock value from a trace match"),
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        before: z.number().int().positive().optional().describe("How many prior instructions to scan for the call chain (default: 600)"),
      },
      async ({ anchor_clock, session_id, before }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const index = await loadTraceIndex(record);
          const frames = await traceCallPath(record, anchor_clock, before ?? 600);
          const lines = [
            `Trace call path for session ${record.sessionId}:`,
            `Anchor clock: ${anchor_clock}`,
            `Frames: ${frames.length}`,
          ];
          if (index) {
            lines.push(`Indexed continuity: ${index.continuity.status} (max clock gap ${index.continuity.maxClockGap})`);
          }
          for (const frame of frames) {
            const target = frame.targetAddress === undefined ? "?" : formatHexWord(frame.targetAddress);
            lines.push(`${formatHexWord(frame.pc)}  -> ${target}  sample=${frame.sampleIndex} clock=${frame.clock}`);
            const semantic = formatSemanticLink(getIndexedPcEntry(index, frame.targetAddress ?? frame.pc));
            if (semantic) {
              lines.push(semantic);
            }
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-add-note ───────────────────────────────────────
    server.tool(
      "vice_trace_add_note",
      "Append a reasoning note/bookmark to a completed VICE trace session so investigation can proceed step by step without losing findings.",
      {
        title: z.string().describe("Short note title"),
        note: z.string().describe("The actual finding or hypothesis to preserve"),
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        anchor_clock: z.string().optional().describe("Optional anchor clock this note refers to"),
        pc: z.string().optional().describe("Optional PC this note refers to, e.g. 63A1"),
        sample_index: z.number().int().nonnegative().optional().describe("Optional sample index this note refers to"),
      },
      async ({ title, note, session_id, anchor_clock, pc, sample_index }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const saved = await addTraceNote(record, {
            title,
            note,
            anchorClock: anchor_clock,
            pc: pc ? parseHexWord(pc) : undefined,
            sampleIndex: sample_index,
          });
          return traceNotesToContent([saved], record.sessionId);
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-trace-list-notes ─────────────────────────────────────
    server.tool(
      "vice_trace_list_notes",
      "List saved reasoning notes/bookmarks for a completed VICE trace session.",
      {
        session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
        limit: z.number().int().positive().optional().describe("How many recent notes to return (default: 50)"),
      },
      async ({ session_id, limit }) => {
        try {
          const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
          const notes = await listTraceNotes(record, limit ?? 50);
          return traceNotesToContent(notes, record.sessionId);
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-registers ─────────────────────────────────────
    server.tool(
      "vice_monitor_registers",
      "Read CPU register values from the active VICE session. If the machine is running, the monitor may stop it to collect state.",
      {},
      async () => {
        try {
          const { manager } = await resolveViceManager();
          const { registers, descriptors } = await manager.readRegisters();
          const nameById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor.name]));
          const lines = ["VICE CPU registers:"];
          for (const register of registers) {
            const name = nameById.get(register.id) ?? `R${register.id}`;
            lines.push(`${name}: ${formatHexWord(register.value)}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-memory ────────────────────────────────────────
    server.tool(
      "vice_monitor_memory",
      "Read a memory range from the active VICE session.",
      {
        start: z.string().describe("Start address as hex, e.g. 0801 or $0801"),
        end: z.string().describe("End address as hex, inclusive"),
        bank_id: z.number().int().nonnegative().optional().describe("Optional bank ID; defaults to 0"),
        memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
      },
      async ({ start, end, bank_id, memspace }) => {
        try {
          const startAddress = parseHexWord(start);
          const endAddress = parseHexWord(end);
          if (endAddress < startAddress) {
            throw new Error("end must be >= start");
          }
          const { manager } = await resolveViceManager();
          const memspaceId = parseViceMemspace(memspace);
          const data = await manager.readMemory(startAddress, endAddress, bank_id ?? 0, memspaceId);
          const lines = [
            `Memory ${formatHexWord(startAddress)}-${formatHexWord(endAddress)} (${data.length} bytes)`,
            `Memspace: ${formatViceMemspace(memspaceId)}`,
            `Bank ID: ${bank_id ?? 0}`,
            data.toString("hex").replace(/(..)/g, "$1 ").trim(),
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-write-memory ─────────────────────────────────
    server.tool(
      "vice_monitor_write_memory",
      "Write bytes into the active VICE session memory.",
      {
        start: z.string().describe("Start address as hex, e.g. 0801 or $0801"),
        data_hex: z.string().describe("Hex bytes to write, e.g. 'a9 00 8d 20 d0'"),
        bank_id: z.number().int().nonnegative().optional().describe("Optional bank ID; defaults to 0"),
        memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
        side_effects: z.boolean().optional().describe("Whether the write should trigger side effects"),
      },
      async ({ start, data_hex, bank_id, memspace, side_effects }) => {
        try {
          const startAddress = parseHexWord(start);
          const bytes = data_hex.replace(/[^0-9a-fA-F]/g, "");
          if (bytes.length === 0 || bytes.length % 2 !== 0) {
            throw new Error("data_hex must contain an even number of hex digits.");
          }
          const data = Buffer.from(bytes, "hex");
          const { manager } = await resolveViceManager();
          const memspaceId = parseViceMemspace(memspace);
          await manager.writeMemory(startAddress, data, bank_id ?? 0, memspaceId, side_effects ?? false);
          return {
            content: [{
              type: "text" as const,
              text: `Wrote ${data.length} bytes at ${formatHexWord(startAddress)}.\nMemspace: ${formatViceMemspace(memspaceId)}\nBank ID: ${bank_id ?? 0}`,
            }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-set-registers ────────────────────────────────
    server.tool(
      "vice_monitor_set_registers",
      "Set CPU register values in the active VICE session.",
      {
        registers: z.record(z.string(), z.string()).describe("Register map, e.g. {\"PC\":\"080D\",\"A\":\"00\",\"X\":\"10\"}"),
        memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
      },
      async ({ registers, memspace }) => {
        try {
          const parsedRegisters = Object.fromEntries(
            Object.entries(registers).map(([name, value]) => [name, parseHexWord(value)]),
          );
          const { manager } = await resolveViceManager();
          const memspaceId = parseViceMemspace(memspace);
          const applied = await manager.setRegistersByName(parsedRegisters, memspaceId);
          const lines = ["Registers updated:"];
          for (const register of applied) {
            lines.push(`${register.id}: ${formatHexWord(register.value)}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-breakpoint-add ───────────────────────────────
    server.tool(
      "vice_monitor_breakpoint_add",
      "Add a breakpoint/watchpoint/tracepoint in the active VICE session.",
      {
        start: z.string().describe("Start address as hex, e.g. 080D"),
        end: z.string().optional().describe("Optional end address; defaults to start"),
        operation: z.enum(["exec", "load", "store"]).optional().describe("Operation to watch; defaults to exec"),
        stop_when_hit: z.boolean().optional().describe("Whether VICE should stop when the checkpoint triggers"),
        enabled: z.boolean().optional().describe("Whether the checkpoint is enabled immediately"),
        temporary: z.boolean().optional().describe("Whether the checkpoint is temporary"),
        memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
      },
      async ({ start, end, operation, stop_when_hit, enabled, temporary, memspace }) => {
        try {
          const { manager } = await resolveViceManager();
          const checkpoint = await manager.addBreakpoint({
            startAddress: parseHexWord(start),
            endAddress: end ? parseHexWord(end) : undefined,
            operation: parseBreakpointOperation(operation),
            stopWhenHit: stop_when_hit ?? true,
            enabled: enabled ?? true,
            temporary: temporary ?? false,
            memspace: parseViceMemspace(memspace),
          });
          const lines = [
            "Breakpoint added.",
            `Checkpoint #: ${checkpoint.checkpointNumber}`,
            `Range: ${formatHexWord(checkpoint.startAddress)}-${formatHexWord(checkpoint.endAddress)}`,
            `Operation: ${formatBreakpointOperation(checkpoint.operation)}`,
            `Stop when hit: ${checkpoint.stopWhenHit ? "yes" : "no"}`,
            `Temporary: ${checkpoint.temporary ? "yes" : "no"}`,
            `Memspace: ${formatViceMemspace(checkpoint.memspace)}`,
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-breakpoint-list ──────────────────────────────
    server.tool(
      "vice_monitor_breakpoint_list",
      "List checkpoints currently configured in the active VICE session.",
      {},
      async () => {
        try {
          const { manager } = await resolveViceManager();
          const result = await manager.listBreakpoints();
          const lines = [`Checkpoints: ${result.count}`];
          for (const checkpoint of result.checkpoints) {
            lines.push(
              `#${checkpoint.checkpointNumber} ${formatHexWord(checkpoint.startAddress)}-${formatHexWord(checkpoint.endAddress)} ${formatBreakpointOperation(checkpoint.operation)} ${checkpoint.enabled ? "enabled" : "disabled"} ${checkpoint.stopWhenHit ? "stop" : "trace"} ${checkpoint.temporary ? "temporary" : "persistent"} ${formatViceMemspace(checkpoint.memspace)}`,
            );
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-breakpoint-delete ────────────────────────────
    server.tool(
      "vice_monitor_breakpoint_delete",
      "Delete a checkpoint from the active VICE session.",
      {
        checkpoint_number: z.number().int().nonnegative().describe("Checkpoint number to delete"),
      },
      async ({ checkpoint_number }) => {
        try {
          const { manager } = await resolveViceManager();
          await manager.deleteBreakpoint(checkpoint_number);
          return {
            content: [{ type: "text" as const, text: `Deleted checkpoint #${checkpoint_number}.` }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-session-send-keys ────────────────────────────────────
    server.tool(
      "vice_session_send_keys",
      "Feed text, PETSCII bytes, or named special keys into the active VICE keyboard buffer.",
      {
        text: z.string().optional().describe("Text to feed into the keyboard buffer"),
        petscii_bytes: z.array(z.number().int().min(0).max(255)).optional().describe("Raw PETSCII bytes to queue into the keyboard buffer"),
        special_keys: z.array(z.enum(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "RETURN"])).optional().describe("Named C64 special keys to queue using PETSCII control codes"),
      },
      async ({ text, petscii_bytes, special_keys }) => {
        try {
          const { manager } = await resolveViceManager();
          const provided = [text !== undefined, petscii_bytes !== undefined, special_keys !== undefined].filter(Boolean).length;
          if (provided !== 1) {
            throw new Error("Provide exactly one of text, petscii_bytes, or special_keys.");
          }
  
          if (text !== undefined) {
            await manager.sendKeys(text);
            return {
              content: [{ type: "text" as const, text: `Queued ${text.length} characters into the VICE keyboard buffer.` }],
            };
          }
  
          if (petscii_bytes !== undefined) {
            await manager.sendPetsciiBytes(petscii_bytes);
            return {
              content: [{ type: "text" as const, text: `Queued ${petscii_bytes.length} PETSCII byte(s) into the VICE keyboard buffer.` }],
            };
          }
  
          const resolved = await manager.sendSpecialKeys(special_keys ?? []);
          return {
            content: [{ type: "text" as const, text: `Queued special key(s) ${JSON.stringify(special_keys ?? [])} as PETSCII byte(s) ${JSON.stringify(resolved)}.` }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-session-joystick ────────────────────────────────────
    server.tool(
      "vice_session_joystick",
      "Send keyset-based joystick input into the active visible VICE session. Uses the copied VICE config and currently expects JoyDevice<port>=3 with KeySet<port>* bindings.",
      {
        directions: z.array(z.enum(["up", "down", "left", "right", "fire"])).min(1).describe("Joystick directions/buttons to hold simultaneously"),
        duration_ms: z.number().int().positive().optional().describe("How long to hold the joystick input before releasing it (default: 120 ms)"),
        port: z.number().int().min(1).max(2).optional().describe("Control port / keyset number to use (default: 2)"),
      },
      async ({ directions, duration_ms, port }) => {
        try {
          const { manager } = await resolveViceManager();
          const result = await manager.sendJoystickInput(port ?? 2, directions, duration_ms ?? 120);
          return {
            content: [{
              type: "text" as const,
              text: `Sent joystick input on port ${port ?? 2}: ${directions.join("+")} for ${duration_ms ?? 120} ms using keys ${result.characters.map((character) => JSON.stringify(character)).join(", ")}.`,
            }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-session-attach-media ─────────────────────────────────
    server.tool(
      "vice_session_attach_media",
      "Autostart or autoload media into an already running VICE session via the binary monitor.",
      {
        media_path: z.string().describe("Path to the media file to load"),
        run_after_loading: z.boolean().optional().describe("Whether to run after loading (default: true)"),
        file_index: z.number().int().nonnegative().optional().describe("File index for disk-image autoload; defaults to 0"),
      },
      async ({ media_path, run_after_loading, file_index }) => {
        try {
          const { manager, projectRoot } = await resolveViceManager();
          await manager.attachMedia(media_path, run_after_loading ?? true, file_index ?? 0);
          return {
            content: [{ type: "text" as const, text: `Attached/autostarted media: ${resolve(projectRoot, media_path)}` }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-display ──────────────────────────────────────
    server.tool(
      "vice_monitor_display",
      "Capture the current VICE display buffer and save it as an 8-bit grayscale PGM preview plus JSON metadata.",
      {
        output_path: z.string().optional().describe("Output path for the PGM image; defaults to analysis/runtime/exports/display-<timestamp>.pgm"),
        use_vicii: z.boolean().optional().describe("On C128, capture VIC-II instead of VDC (default: true)"),
      },
      async ({ output_path, use_vicii }) => {
        try {
          const { manager, projectRoot } = await resolveViceManager();
          const result = await manager.captureDisplay(output_path ?? defaultViceDisplayPath(projectRoot), use_vicii ?? true);
          return {
            content: [{
              type: "text" as const,
              text: [
                "VICE display captured.",
                `Image: ${result.imagePath}`,
                `Metadata: ${result.metadataPath}`,
                `Debug size: ${result.debugWidth}x${result.debugHeight}`,
                `Inner size: ${result.innerWidth}x${result.innerHeight}`,
                `Bits per pixel: ${result.bitsPerPixel}`,
                `Bytes written: ${result.bytesWritten}`,
              ].join("\n"),
            }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-reset ────────────────────────────────────────
    server.tool(
      "vice_monitor_reset",
      "Reset the active VICE machine or one of its drives.",
      {
        target: z.enum(["system", "power", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Reset target; defaults to system"),
      },
      async ({ target }) => {
        try {
          const { manager } = await resolveViceManager();
          const code = parseResetTarget(target);
          await manager.resetMachine(code);
          return {
            content: [{ type: "text" as const, text: `Reset sent to ${target ?? "system"}.` }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-backtrace ─────────────────────────────────────
    server.tool(
      "vice_monitor_backtrace",
      "Build a heuristic call stack from the 6502 stack page in the active VICE session. This is inferred from stack contents; the binary monitor does not expose a dedicated backtrace command.",
      {
        max_frames: z.number().int().positive().optional().describe("Maximum number of stack-derived frames to return (default: 16)"),
      },
      async ({ max_frames }) => {
        try {
          const { manager } = await resolveViceManager();
          const result = await manager.buildBacktrace(max_frames ?? 16);
          const lines = [
            "VICE heuristic backtrace:",
            `SP: ${formatHexWord(result.stackPointer)}`,
            `Stack scan start: ${formatHexWord(result.stackBase)}`,
          ];
          if (result.frames.length === 0) {
            lines.push("No candidate return addresses found on the current stack.");
          } else {
            for (const frame of result.frames) {
              lines.push(
                `${formatHexWord(frame.stackAddress)}: raw=${formatHexWord(frame.rawReturnAddress)} -> RTS target ${formatHexWord(frame.returnPc)}`,
              );
            }
          }
          lines.push("Note: this is inferred from stacked return addresses and may include non-call data.");
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-bank ──────────────────────────────────────────
    server.tool(
      "vice_monitor_bank",
      "List the available VICE memory banks for the active machine. Use the returned bank IDs with vice_monitor_memory, vice_monitor_save, or vice_monitor_binary_save.",
      {},
      async () => {
        try {
          const { manager } = await resolveViceManager();
          const banks = await manager.getBanksAvailable();
          const lines = ["VICE available banks:"];
          for (const bank of banks) {
            lines.push(`${bank.id}: ${bank.name}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-snapshot ──────────────────────────────────────
    server.tool(
      "vice_monitor_snapshot",
      "Save a VICE snapshot (.vsf) from the active session.",
      {
        output_path: z.string().optional().describe("Output path for the snapshot file; defaults to analysis/runtime/exports/vice-snapshot-<timestamp>.vsf"),
        save_roms: z.boolean().optional().describe("Include ROMs in the snapshot (default: true)"),
        save_disks: z.boolean().optional().describe("Include disk state in the snapshot (default: true)"),
      },
      async ({ output_path, save_roms, save_disks }) => {
        try {
          const { manager, projectRoot } = await resolveViceManager();
          const writtenPath = await manager.saveSnapshot(
            output_path ?? defaultViceExportPath(projectRoot, "snapshot"),
            save_roms ?? true,
            save_disks ?? true,
          );
          return {
            content: [{ type: "text" as const, text: `VICE snapshot saved.\nPath: ${writtenPath}` }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-save ──────────────────────────────────────────
    server.tool(
      "vice_monitor_save",
      "Save a memory range from the active VICE session as a PRG file with a load-address header.",
      {
        start: z.string().describe("Start address as hex, e.g. 0801 or $0801"),
        end: z.string().describe("End address as hex, inclusive"),
        output_path: z.string().optional().describe("Output path for the PRG; defaults to analysis/runtime/exports/memory-<start>-<end>.prg"),
        bank_id: z.number().int().nonnegative().optional().describe("Optional bank ID; defaults to 0"),
        memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
      },
      async ({ start, end, output_path, bank_id, memspace }) => {
        try {
          const startAddress = parseHexWord(start);
          const endAddress = parseHexWord(end);
          const { manager, projectRoot } = await resolveViceManager();
          const memspaceId = parseViceMemspace(memspace);
          const result = await manager.saveMemoryRange(
            startAddress,
            endAddress,
            output_path ?? defaultViceExportPath(projectRoot, "prg", startAddress, endAddress),
            {
              bankId: bank_id ?? 0,
              memspace: memspaceId,
              includeLoadAddress: true,
            },
          );
          return {
            content: [{
              type: "text" as const,
              text: [
                `VICE memory saved as PRG.`,
                `Path: ${result.outputPath}`,
                `Bytes: ${result.bytesWritten}`,
                `Memspace: ${formatViceMemspace(result.memspace)}`,
                `Bank ID: ${result.bankId}`,
              ].join("\n"),
            }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-binary-save ───────────────────────────────────
    server.tool(
      "vice_monitor_binary_save",
      "Save a memory range from the active VICE session as a raw binary file without a load-address header.",
      {
        start: z.string().describe("Start address as hex, e.g. 0801 or $0801"),
        end: z.string().describe("End address as hex, inclusive"),
        output_path: z.string().optional().describe("Output path for the binary; defaults to analysis/runtime/exports/memory-<start>-<end>.bin"),
        bank_id: z.number().int().nonnegative().optional().describe("Optional bank ID; defaults to 0"),
        memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
      },
      async ({ start, end, output_path, bank_id, memspace }) => {
        try {
          const startAddress = parseHexWord(start);
          const endAddress = parseHexWord(end);
          const { manager, projectRoot } = await resolveViceManager();
          const memspaceId = parseViceMemspace(memspace);
          const result = await manager.saveMemoryRange(
            startAddress,
            endAddress,
            output_path ?? defaultViceExportPath(projectRoot, "bin", startAddress, endAddress),
            {
              bankId: bank_id ?? 0,
              memspace: memspaceId,
              includeLoadAddress: false,
            },
          );
          return {
            content: [{
              type: "text" as const,
              text: [
                `VICE memory saved as raw binary.`,
                `Path: ${result.outputPath}`,
                `Bytes: ${result.bytesWritten}`,
                `Memspace: ${formatViceMemspace(result.memspace)}`,
                `Bank ID: ${result.bankId}`,
              ].join("\n"),
            }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-continue ──────────────────────────────────────
    server.tool(
      "vice_monitor_continue",
      "Resume execution in the active VICE session until the next breakpoint or manual stop.",
      {},
      async () => {
        try {
          const { manager } = await resolveViceManager();
          const result = await manager.continueExecution();
          return {
            content: [{ type: "text" as const, text: `VICE resumed.\nPC: ${formatHexWord(result.pc)}` }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-step ──────────────────────────────────────────
    server.tool(
      "vice_monitor_step",
      "Advance the active VICE session by one instruction and stop again.",
      {},
      async () => {
        try {
          const { manager } = await resolveViceManager();
          const result = await manager.stepInto();
          return {
            content: [{ type: "text" as const, text: `VICE stepped one instruction.\nPC: ${formatHexWord(result.pc)}` }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-monitor-next ──────────────────────────────────────────
    server.tool(
      "vice_monitor_next",
      "Advance the active VICE session by one instruction, stepping over subroutine calls.",
      {},
      async () => {
        try {
          const { manager } = await resolveViceManager();
          const result = await manager.stepOver();
          return {
            content: [{ type: "text" as const, text: `VICE stepped over one instruction.\nPC: ${formatHexWord(result.pc)}` }],
          };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
    );
  
    // ── Tool: vice-debug-run ─────────────────────────────────────────────
    server.tool(
      "vice_debug_run",
      "Set execution breakpoints in the active VICE session, continue execution, and return when a breakpoint, stop, or JAM event occurs.",
      {
        breakpoints: z.array(z.string()).min(1).describe("Breakpoint addresses as hex strings, e.g. [\"080D\", \"C000\"]"),
        timeout_ms: z.number().int().positive().optional().describe("How long to wait for a breakpoint or stop event (default: 15000)"),
        temporary: z.boolean().optional().describe("Whether created breakpoints are temporary"),
      },
      async ({ breakpoints, timeout_ms, temporary }) => {
        try {
          const { manager } = await resolveViceManager();
          const result = await manager.debugRun(breakpoints.map(parseHexWord), timeout_ms ?? 15_000, temporary ?? false);
          const lines = [
            "VICE debug run complete.",
            `Breakpoint IDs: ${result.breakpoints.join(", ")}`,
            formatMonitorEvent(result.event),
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return cliResultToContent({
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          });
        }
      },
  );
}
