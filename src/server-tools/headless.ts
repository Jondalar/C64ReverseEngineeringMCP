import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getHeadlessSessionManager, getPreferredHeadlessSessionManager } from "../runtime/headless/index.js";
import type { HeadlessRunResult, HeadlessSessionRecord } from "../runtime/headless/types.js";
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
  if (hintPath) {
    return context.projectDir(hintPath, true);
  }
  const preferred = getPreferredHeadlessSessionManager();
  if (preferred) {
    return preferred.getProjectDir();
  }
  return context.projectDir(undefined, true);
}

function headlessSessionToContent(record: HeadlessSessionRecord, headline: string): { content: [{ type: "text"; text: string }] } {
  const lines = [
    headline,
    `Session: ${record.sessionId}`,
    `State: ${record.state}`,
    `Project: ${record.projectDir}`,
    `PC: ${formatHexWord(record.currentPc)}`,
  ];
  if (record.prgPath) lines.push(`PRG: ${record.prgPath}`);
  if (record.diskPath) lines.push(`Disk: ${record.diskPath}`);
  if (record.crtPath) lines.push(`CRT: ${record.crtPath}`);
  lines.push(`Workspace: ${record.workspace.sessionDir}`);
  lines.push(`Trace: ${record.workspace.tracePath}`);
  if (record.entryPoint !== undefined) lines.push(`Entry: ${formatHexWord(record.entryPoint)}`);
  if (record.inferredBasicSys !== undefined) lines.push(`BASIC SYS: ${formatHexWord(record.inferredBasicSys)}`);
  if (record.startedAt) lines.push(`Started: ${record.startedAt}`);
  if (record.stoppedAt) lines.push(`Stopped: ${record.stoppedAt}`);
  if (record.lastTrap) lines.push(`Last trap: ${record.lastTrap}`);
  if (record.lastError) lines.push(`Last error: ${record.lastError}`);
  if (record.loaderState.fileName) lines.push(`Loader filename: ${record.loaderState.fileName}`);
  if (record.loaderState.device !== null) lines.push(`Loader device: ${record.loaderState.device}`);
  if (record.loaderState.secondaryAddress !== null) lines.push(`Loader SA: ${record.loaderState.secondaryAddress}`);
  if (record.breakpoints.length > 0) lines.push(`Breakpoints: ${record.breakpoints.length}`);
  if (record.watchRanges.length > 0) lines.push(`Watch ranges: ${record.watchRanges.length}`);
  lines.push(`IRQ/NMI: irqPending=${record.irqState.irqPending ? "yes" : "no"} nmiPending=${record.irqState.nmiPending ? "yes" : "no"} irqCount=${record.irqState.irqCount} nmiCount=${record.irqState.nmiCount}`);
  lines.push(`I/O IRQ state: VIC status=${formatHexByte(record.ioInterrupts.vicIrqStatus)} mask=${formatHexByte(record.ioInterrupts.vicIrqMask)} | CIA1 status=${formatHexByte(record.ioInterrupts.cia1Status)} mask=${formatHexByte(record.ioInterrupts.cia1Mask)} | CIA2 status=${formatHexByte(record.ioInterrupts.cia2Status)} mask=${formatHexByte(record.ioInterrupts.cia2Mask)}`);
  if (record.cartridge) {
    lines.push(`Cartridge: ${record.cartridge.name} (${record.cartridge.mapperType}) bank=${record.cartridge.currentBank}`);
    lines.push(`Cart lines: EXROM=${record.cartridge.exrom} GAME=${record.cartridge.game}${record.cartridge.controlRegister !== undefined ? ` control=${formatHexByte(record.cartridge.controlRegister)}` : ""}`);
    if (record.cartridge.flashMode) lines.push(`Cart flash mode: ${record.cartridge.flashMode}`);
    if (record.cartridge.writable) lines.push("Cart writes: enabled");
  }
  if (record.loadEvents.length > 0) {
    lines.push("Load events:");
    for (const event of record.loadEvents.slice(-5)) {
      lines.push(`- "${event.name}" -> ${formatHexWord(event.startAddress)}-${formatHexWord((event.endAddress - 1) & 0xffff)} from ${event.source}`);
    }
  }
  if (record.recentTrace.length > 0) {
    const last = record.recentTrace[record.recentTrace.length - 1]!;
    const bytes = last.bytes.map(formatHexByte).join(" ");
    lines.push(`Recent trace tail: ${formatHexWord(last.pc)} [${bytes}]${last.trap ? ` ${last.trap}` : ""}`);
    lines.push(`Last banks: $00=${formatHexByte(last.bankInfo.cpuPortDirection)} $01=${formatHexByte(last.bankInfo.cpuPortValue)} basic=${last.bankInfo.basicVisible ? "on" : "off"} kernal=${last.bankInfo.kernalVisible ? "on" : "off"} io=${last.bankInfo.ioVisible ? "on" : "off"} char=${last.bankInfo.charVisible ? "on" : "off"}`);
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function headlessRunResultToContent(
  result: HeadlessRunResult,
  record: HeadlessSessionRecord,
  headline: string,
): { content: [{ type: "text"; text: string }] } {
  const lines = [
    headline,
    `Reason: ${result.reason}`,
    `Steps executed: ${result.stepsExecuted}`,
    `PC: ${formatHexWord(result.currentPc)}`,
  ];
  if (result.lastTrap) lines.push(`Trap: ${result.lastTrap}`);
  if (result.breakpointId) lines.push(`Breakpoint: ${result.breakpointId}`);
  if (record.recentTrace.length > 0) {
    const last = record.recentTrace[record.recentTrace.length - 1]!;
    lines.push(`Last instruction: ${formatHexWord(last.pc)} [${last.bytes.map(formatHexByte).join(" ")}]`);
    lines.push(`Cycles: ${last.before.cycles} -> ${last.after.cycles}`);
    lines.push(`CPU port: $00=${formatHexByte(last.bankInfo.cpuPortDirection)} $01=${formatHexByte(last.bankInfo.cpuPortValue)}`);
    lines.push(`Banks: basic=${last.bankInfo.basicVisible ? "on" : "off"} kernal=${last.bankInfo.kernalVisible ? "on" : "off"} io=${last.bankInfo.ioVisible ? "on" : "off"} char=${last.bankInfo.charVisible ? "on" : "off"}`);
    lines.push(`Stack(before): SP=${formatHexByte(last.beforeStack.sp)} [${last.beforeStack.bytes.map(formatHexByte).join(" ")}]`);
    lines.push(`Stack(after): SP=${formatHexByte(last.afterStack.sp)} [${last.afterStack.bytes.map(formatHexByte).join(" ")}]`);
    if (last.accesses.length > 0) {
      lines.push("Accesses:");
      for (const access of last.accesses.slice(0, 12)) {
        lines.push(`- ${access.kind} ${formatHexWord(access.address)}=${formatHexByte(access.value)} (${access.region})`);
      }
    }
    if (last.watchHits.length > 0) {
      lines.push("Watch hits:");
      for (const hit of last.watchHits) {
        lines.push(`- ${hit.name} ${formatHexWord(hit.start)}-${formatHexWord(hit.end)} via ${hit.touchedBy.join("/")}${hit.bytes ? ` bytes=[${hit.bytes.slice(0, 16).map(formatHexByte).join(" ")}${hit.bytes.length > 16 ? " ..." : ""}]` : ""}`);
      }
    }
    lines.push("Recent trace:");
    for (const event of record.recentTrace.slice(-8)) {
      const bytes = event.bytes.map(formatHexByte).join(" ");
      const suffix = event.trap ? ` ${event.trap}` : event.watchHits.length > 0 ? ` watch=${event.watchHits.map((hit) => hit.name).join(",")}` : "";
      lines.push(`- ${formatHexWord(event.pc)} [${bytes}]${suffix}`);
    }
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

async function resolveHeadlessTraceProjectDir(context: ServerToolContext): Promise<string> {
  const preferred = getPreferredHeadlessSessionManager();
  return preferred?.getProjectDir() ?? context.projectDir(undefined, true);
}

function formatHeadlessTraceMatch(match: { index: number; pc: number; bytes: number[]; trap?: string }): string {
  return `${match.index}: ${formatHexWord(match.pc)} [${match.bytes.map(formatHexByte).join(" ")}]${match.trap ? ` ${match.trap}` : ""}`;
}

export function registerHeadlessTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "headless_session_start",
    "Start a headless C64 RE runtime session with optional PRG and disk image attached.",
    {
      prg_path: z.string().optional().describe("Optional PRG to load into RAM before execution."),
      disk_path: z.string().optional().describe("Optional D64/G64 disk image used to satisfy KERNAL LOAD traps."),
      crt_path: z.string().optional().describe("Optional CRT cartridge image attached to the headless memory map."),
      mapper_type: z.enum(["easyflash", "megabyter", "magicdesk", "ocean", "normal_8k", "normal_16k", "ultimax"]).optional().describe("Optional explicit mapper type for CRT handling."),
      entry_pc: z.string().optional().describe("Optional explicit entry PC in hex, e.g. 080D."),
    },
    safeHandler("headless_session_start", async ({ prg_path, disk_path, crt_path, mapper_type, entry_pc }) => {
      try {
        const hintPath = prg_path ?? disk_path ?? crt_path;
        const projectRoot = resolveHeadlessProjectDir(context, hintPath);
        const manager = getHeadlessSessionManager(projectRoot);
        const record = manager.startSession({
          prgPath: prg_path ? resolve(projectRoot, prg_path) : undefined,
          diskPath: disk_path ? resolve(projectRoot, disk_path) : undefined,
          crtPath: crt_path ? resolve(projectRoot, crt_path) : undefined,
          mapperType: mapper_type,
          entryPc: entry_pc ? parseHexWord(entry_pc) : undefined,
        });
        return headlessSessionToContent(record, "Headless runtime session started.");
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_session_status",
    "Show the current headless C64 RE runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_session_status", async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        const record = manager.getStatus();
        if (!record) {
          return { content: [{ type: "text" as const, text: "No headless runtime session is active." }] };
        }
        return headlessSessionToContent(record, "Headless runtime session status.");
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_session_stop",
    "Stop the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_session_stop", async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        const record = manager.stopSession("stopped by user");
        if (!record) {
          return { content: [{ type: "text" as const, text: "No headless runtime session is active." }] };
        }
        return headlessSessionToContent(record, "Headless runtime session stopped.");
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_session_step",
    "Execute one instruction in the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_session_step", async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        const result = manager.stepSession();
        const record = manager.getStatus();
        if (!record) {
          throw new Error("Headless session disappeared after step.");
        }
        return headlessRunResultToContent(result, record, "Headless runtime stepped one instruction.");
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_session_run",
    "Run the active headless runtime session for a bounded number of instructions or until a stop PC is reached. Spec 011 Sprint 8: trace_mode controls trace I/O cost — 'full' logs every event (default), 'sampled' logs every Nth event (sample_every, default 16), 'off' disables trace writes for the run.",
    {
      max_instructions: z.number().int().positive().optional().describe("Maximum instruction count to execute (default: 1000)."),
      stop_pc: z.string().optional().describe("Optional stop PC in hex."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
      trace_mode: z.enum(["full", "sampled", "off"]).optional().describe("Spec 011: trace mode for this run. Default 'full'."),
      sample_every: z.number().int().positive().optional().describe("Spec 011: when trace_mode='sampled', log every Nth event. Default 16."),
    },
    safeHandler("headless_session_run", async ({ max_instructions, stop_pc, hint_path, trace_mode, sample_every }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        const result = manager.runSession({
          maxInstructions: max_instructions,
          stopPc: stop_pc ? parseHexWord(stop_pc) : undefined,
          traceMode: trace_mode,
          sampleEvery: sample_every,
        });
        const record = manager.getStatus();
        if (!record) {
          throw new Error("Headless session disappeared after run.");
        }
        return headlessRunResultToContent(result, record, "Headless runtime run complete.");
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_breakpoint_add",
    "Add an execution or memory-access breakpoint to the active headless runtime session.",
    {
      address: z.string().optional().describe("Single breakpoint address as hex, e.g. 080D"),
      start: z.string().optional().describe("Start address for a range breakpoint/watchpoint."),
      end: z.string().optional().describe("End address for a range breakpoint/watchpoint, inclusive."),
      operation: z.enum(["exec", "read", "write", "access"]).optional().describe("Breakpoint kind; read/write/access break on effective memory accesses, including indirect ones."),
      label: z.string().optional().describe("Optional human-readable label for the breakpoint."),
      temporary: z.boolean().optional().describe("Whether the breakpoint should auto-remove after it hits once."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_breakpoint_add", async ({ address, start, end, operation, label, temporary, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        const kind = operation ?? "exec";
        const startAddress = parseHexWord(start ?? address ?? "");
        const endAddress = parseHexWord(end ?? start ?? address ?? "");
        let id: string;
        if (kind === "exec") {
          manager.addBreakpoint(startAddress, temporary ?? false);
          id = `exec:${startAddress.toString(16)}`;
        } else {
          id = manager.addAccessBreakpoint(kind, startAddress, endAddress, temporary ?? false, label);
        }
        return {
          content: [{
            type: "text" as const,
            text: `Headless breakpoint added: ${kind} ${formatHexWord(startAddress)}-${formatHexWord(endAddress)}${label ? ` (${label})` : ""}${temporary ? " (temporary)" : ""}\nID: ${id}`,
          }],
        };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_breakpoint_clear",
    "Clear all execution and memory-access breakpoints from the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_breakpoint_clear", async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        manager.clearBreakpoints();
        return { content: [{ type: "text" as const, text: "Headless breakpoints cleared." }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_watch_add",
    "Register a watched memory range whose bytes and access kinds should be included directly in trace output when touched.",
    {
      name: z.string().describe("Short label for the watched range."),
      start: z.string().describe("Start address as hex."),
      end: z.string().describe("End address as hex, inclusive."),
      include_bytes: z.boolean().optional().describe("Whether to include the watched bytes when the range is touched."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_watch_add", async ({ name, start, end, include_bytes, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        const startAddress = parseHexWord(start);
        const endAddress = parseHexWord(end);
        const id = manager.addWatchRange(name, startAddress, endAddress, include_bytes ?? true);
        return {
          content: [{
            type: "text" as const,
            text: `Headless watch range added: ${name} ${formatHexWord(startAddress)}-${formatHexWord(endAddress)}\nID: ${id}`,
          }],
        };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_watch_clear",
    "Clear all watched memory ranges from the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_watch_clear", async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        manager.clearWatchRanges();
        return { content: [{ type: "text" as const, text: "Headless watch ranges cleared." }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_interrupt_request",
    "Mark an IRQ or NMI as pending in the active headless runtime session. The runtime will dispatch it between instructions when possible.",
    {
      interrupt: z.enum(["irq", "nmi"]).describe("Interrupt line to request."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_interrupt_request", async ({ interrupt, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        manager.requestInterrupt(interrupt);
        return { content: [{ type: "text" as const, text: `Headless ${interrupt.toUpperCase()} requested.` }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_io_interrupt_trigger",
    "Trigger a simple VIC/CIA interrupt source in the headless runtime. If the corresponding mask bit is enabled, this will queue an IRQ or NMI.",
    {
      source: z.enum(["vic", "cia1", "cia2"]).describe("Interrupt source to trigger."),
      mask: z.number().int().min(1).max(31).optional().describe("Bit mask to set in the source status register (default: 1)."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_io_interrupt_trigger", async ({ source, mask, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        manager.triggerIoInterrupt(source, mask ?? 0x01);
        const record = manager.getStatus();
        if (!record) {
          throw new Error("No headless runtime session is active.");
        }
        return headlessSessionToContent(record, `Headless ${source.toUpperCase()} interrupt source triggered.`);
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_interrupt_clear",
    "Clear pending IRQ and/or NMI state in the active headless runtime session.",
    {
      interrupt: z.enum(["irq", "nmi", "both"]).optional().describe("Which pending interrupt to clear; defaults to both."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_interrupt_clear", async ({ interrupt, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        if (!interrupt || interrupt === "both") {
          manager.clearInterrupt();
        } else {
          manager.clearInterrupt(interrupt);
        }
        return { content: [{ type: "text" as const, text: `Headless pending interrupt state cleared (${interrupt ?? "both"}).` }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_trace_tail",
    "Render the most recent headless runtime trace events with access, stack, bank, and watch metadata.",
    {
      limit: z.number().int().positive().max(64).optional().describe("How many recent events to render (default: 12)."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_trace_tail", async ({ limit, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        const record = manager.getStatus();
        if (!record) {
          return { content: [{ type: "text" as const, text: "No headless runtime session is active." }] };
        }
        const events = record.recentTrace.slice(-(limit ?? 12));
        const lines = [`Headless trace tail for session ${record.sessionId}:`, `Count: ${events.length}`];
        for (const event of events) {
          lines.push(`${formatHexWord(event.pc)} [${event.bytes.map(formatHexByte).join(" ")}] cycles=${event.before.cycles}->${event.after.cycles}${event.trap ? ` trap=${event.trap}` : ""}`);
          lines.push(`  regs: A=${formatHexByte(event.after.a)} X=${formatHexByte(event.after.x)} Y=${formatHexByte(event.after.y)} SP=${formatHexByte(event.after.sp)} FL=${formatHexByte(event.after.flags)}`);
          lines.push(`  stack: before[${event.beforeStack.bytes.map(formatHexByte).join(" ")}] after[${event.afterStack.bytes.map(formatHexByte).join(" ")}]`);
          lines.push(`  ports: $00=${formatHexByte(event.bankInfo.cpuPortDirection)} $01=${formatHexByte(event.bankInfo.cpuPortValue)} basic=${event.bankInfo.basicVisible ? "on" : "off"} kernal=${event.bankInfo.kernalVisible ? "on" : "off"} io=${event.bankInfo.ioVisible ? "on" : "off"} char=${event.bankInfo.charVisible ? "on" : "off"}`);
          lines.push(`  irq: irqPending=${event.irqState.irqPending ? "yes" : "no"} nmiPending=${event.irqState.nmiPending ? "yes" : "no"} irqCount=${event.irqState.irqCount} nmiCount=${event.irqState.nmiCount}`);
          if (event.accesses.length > 0) {
            lines.push(`  accesses: ${event.accesses.map((access) => `${access.kind}@${formatHexWord(access.address)}=${formatHexByte(access.value)}(${access.region})`).join(", ")}`);
          }
          if (event.watchHits.length > 0) {
            lines.push(`  watches: ${event.watchHits.map((hit) => `${hit.name}@${formatHexWord(hit.start)}-${formatHexWord(hit.end)} via ${hit.touchedBy.join("/")}`).join(", ")}`);
          }
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_trace_find_pc",
    "Find occurrences of a PC in a persisted headless runtime trace.",
    {
      pc: z.string().describe("PC to search, e.g. 63A1"),
      limit: z.number().int().positive().max(100).optional().describe("Maximum matches to return."),
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
    },
    safeHandler("headless_trace_find_pc", async ({ pc, limit, session_id }) => {
      try {
        const parsedPc = parseHexWord(pc);
        const record = await loadHeadlessSession(await resolveHeadlessTraceProjectDir(context), session_id);
        const matches = await findHeadlessTraceByPc(record, parsedPc, limit ?? 20);
        const lines = [`Headless trace PC matches for ${formatHexWord(parsedPc)}:`, `Count: ${matches.length}`];
        for (const match of matches) {
          lines.push(`- ${formatHeadlessTraceMatch(match)}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_trace_find_access",
    "Find headless trace events that touched a specific effective memory address.",
    {
      address: z.string().describe("Target address as hex."),
      access: z.enum(["read", "write", "access"]).optional().describe("Access kind filter; defaults to access."),
      limit: z.number().int().positive().max(100).optional().describe("Maximum matches to return."),
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
    },
    safeHandler("headless_trace_find_access", async ({ address, access, limit, session_id }) => {
      try {
        const parsedAddress = parseHexWord(address);
        const record = await loadHeadlessSession(await resolveHeadlessTraceProjectDir(context), session_id);
        const matches = await findHeadlessTraceByAccess(record, parsedAddress, access ?? "access", limit ?? 20);
        const lines = [`Headless trace access matches for ${formatHexWord(parsedAddress)}:`, `Count: ${matches.length}`];
        for (const match of matches) {
          lines.push(`- ${formatHeadlessTraceMatch(match)}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_trace_slice",
    "Return a focused window around a persisted headless trace event index.",
    {
      anchor_index: z.number().int().nonnegative().describe("Event index to anchor on."),
      before: z.number().int().nonnegative().max(200).optional().describe("How many events before the anchor to include."),
      after: z.number().int().nonnegative().max(400).optional().describe("How many events after the anchor to include."),
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
    },
    safeHandler("headless_trace_slice", async ({ anchor_index, before, after, session_id }) => {
      try {
        const record = await loadHeadlessSession(await resolveHeadlessTraceProjectDir(context), session_id);
        const slice = await sliceHeadlessTraceByIndex(record, anchor_index, before ?? 20, after ?? 40);
        const lines = [
          `Headless trace slice around event ${anchor_index}:`,
          `Found: ${slice.found ? "yes" : "no"}`,
          `Count: ${slice.events.length}`,
        ];
        for (const event of slice.events) {
          const suffix = event.trap ? ` trap=${event.trap}` : event.watchHits.length > 0 ? ` watch=${event.watchHits.map((hit) => hit.name).join(",")}` : "";
          lines.push(`- ${event.index}: ${formatHexWord(event.pc)} [${event.bytes.map(formatHexByte).join(" ")}]${suffix}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_trace_build_index",
    "Build a persistent PC/access hotspot index for a headless runtime trace session.",
    {
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
      limit: z.number().int().positive().max(256).optional().describe("How many top PCs/accesses to keep in the summary."),
    },
    safeHandler("headless_trace_build_index", async ({ session_id, limit }) => {
      try {
        const record = await loadHeadlessSession(await resolveHeadlessTraceProjectDir(context), session_id);
        const index = await buildHeadlessTraceIndex(record, limit ?? 64);
        const lines = [
          `Headless trace index built for session ${index.sessionId}.`,
          `Trace path: ${index.tracePath}`,
          `Index path: ${record.workspace.indexPath}`,
          `Events: ${index.traceEventCount}`,
          `Unique PCs: ${index.uniquePcCount}`,
          `Unique access addresses: ${index.uniqueAccessAddressCount}`,
          "Top PCs:",
        ];
        for (const entry of index.topPcs.slice(0, 10)) {
          lines.push(`- ${formatHexWord(entry.pc)} count=${entry.count} first=${entry.firstIndex} last=${entry.lastIndex}${entry.trapCount ? ` traps=${entry.trapCount}` : ""}`);
        }
        lines.push("Top accesses:");
        for (const entry of index.topAccesses.slice(0, 10)) {
          lines.push(`- ${formatHexWord(entry.address)} reads=${entry.reads} writes=${entry.writes} first=${entry.firstIndex} last=${entry.lastIndex}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "headless_monitor_registers",
    "Read CPU registers from the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_monitor_registers", async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        const regs = manager.getRegisters();
        return {
          content: [{
            type: "text" as const,
            text: [
              "Headless registers:",
              `PC: ${formatHexWord(regs.pc)}`,
              `A: ${formatHexByte(regs.a)}`,
              `X: ${formatHexByte(regs.x)}`,
              `Y: ${formatHexByte(regs.y)}`,
              `SP: ${formatHexByte(regs.sp)}`,
              `FL: ${formatHexByte(regs.flags)}`,
              `Cycles: ${regs.cycles}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  // Spec 062 Sprint 63: drive-emulation tools.
  // headless_drive_session_start opens a 1541 drive session backed by
  // a G64 disk image. headless_drive_status / headless_iec_bus_state
  // query state. headless_drive_persist_writes flushes modifications
  // to <image>_session.g64.
  server.tool(
    "headless_drive_session_start",
    "Spec 062 / R28 L3: open a standalone 1541 drive emulation session backed by a G64 image. Returns a session id usable with the other headless_drive_* tools. Drive emulation runs cycle-accurately with full 6522 VIA + IEC bus modelling. The drive boots via its bundled DOS ROM (resources/roms/dos1541-...bin). For test/runtime tracing of custom loaders and save-game RE.",
    {
      disk_path: z.string().describe("Path to the G64 disk image."),
      start_track: z.number().int().min(1).max(40).optional().describe("Starting track for the head (default 18)."),
      device_id: z.number().int().min(8).max(11).optional().describe("Drive device id 8-11; default 8."),
      pal: z.boolean().optional().describe("PAL timing if true (default), NTSC if false."),
      write_protected: z.boolean().optional().describe("If true, drive treats the image as write-protected."),
    },
    safeHandler("headless_drive_session_start", async ({ disk_path, start_track, device_id, pal, write_protected }) => {
      const { startDriveSession } = await import("../runtime/headless/drive/drive-session-manager.js");
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
            `Head: track ${record.headPosition.currentTrack}`,
            `Drive ROM: ${record.session.drive.bus.romSource}${record.session.drive.bus.romPath ? ` (${record.session.drive.bus.romPath})` : ""}`,
          ].join("\n"),
        }],
      };
    },
));

  server.tool(
    "headless_drive_status",
    "Spec 062 Sprint 63: snapshot of a drive session's CPU registers + head position + IRQ pending bits. Use after running drive code to verify state.",
    {
      session_id: z.string(),
    },
    safeHandler("headless_drive_status", async ({ session_id }) => {
      const { getDriveSession } = await import("../runtime/headless/drive/drive-session-manager.js");
      const record = getDriveSession(session_id);
      if (!record) throw new Error(`No drive session ${session_id}`);
      const drive = record.session.drive;
      const via1 = drive.bus.via1;
      const via2 = drive.bus.via2;
      return {
        content: [{
          type: "text" as const,
          text: [
            `Drive session: ${session_id}`,
            `Disk: ${record.diskPath}`,
            `CPU: PC=${formatHexWord(drive.cpu.pc)} A=${formatHexByte(drive.cpu.a)} X=${formatHexByte(drive.cpu.x)} Y=${formatHexByte(drive.cpu.y)} SP=${formatHexByte(drive.cpu.sp)} P=${formatHexByte(drive.cpu.flags)} cycles=${drive.cpu.cycles}`,
            `Head: track ${record.headPosition.currentTrack} (half-track ${record.headPosition.currentHalfTrack})`,
            `VIA1 IFR=${formatHexByte(via1.ifr)} IER=${formatHexByte(via1.ier)} IRQ=${via1.irqAsserted() ? "asserted" : "—"}`,
            `VIA2 IFR=${formatHexByte(via2.ifr)} IER=${formatHexByte(via2.ier)} IRQ=${via2.irqAsserted() ? "asserted" : "—"}`,
            `Track buffer: ${record.trackBuffer.isModified() ? `MODIFIED (${record.trackBuffer.modifiedTracks().size} tracks)` : "clean"}`,
          ].join("\n"),
        }],
      };
    },
));

  server.tool(
    "headless_iec_bus_state",
    "Spec 062 Sprint 63: dump current IEC bus pin state for a drive session — line state (open-collector wired-AND result) plus each driver's contribution. Useful for debugging custom loader bit-bang protocols.",
    {
      session_id: z.string(),
    },
    safeHandler("headless_iec_bus_state", async ({ session_id }) => {
      const { getDriveSession } = await import("../runtime/headless/drive/drive-session-manager.js");
      const record = getDriveSession(session_id);
      if (!record) throw new Error(`No drive session ${session_id}`);
      const snap = record.session.iecBus.snapshot();
      const fmt = (b: boolean) => b ? "released (1)" : "PULLED LOW (0)";
      return {
        content: [{
          type: "text" as const,
          text: [
            `IEC bus state — session ${session_id}`,
            ``,
            `Line state (wired-AND):`,
            `  ATN:  ${fmt(snap.line.atn)}`,
            `  CLK:  ${fmt(snap.line.clk)}`,
            `  DATA: ${fmt(snap.line.data)}`,
            ``,
            `C64 driver:`,
            `  ATN:  ${fmt(snap.c64.atnReleased)}`,
            `  CLK:  ${fmt(snap.c64.clkReleased)}`,
            `  DATA: ${fmt(snap.c64.dataReleased)}`,
            ``,
            `Drive driver:`,
            `  CLK:     ${fmt(snap.drive.clkReleased)}`,
            `  DATA:    ${fmt(snap.drive.dataReleased)}`,
            `  ATN_ACK: ${fmt(snap.drive.atnAckReleased)}`,
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
    "headless_integrated_session_start",
    "Spec 062 Sprint 65: open an integrated C64+1541 drive session. Real C64 KERNAL/BASIC/CHARROM ROMs loaded; CIA2 PA wired to the IEC bus; drive CPU runs cycle-accurately in lockstep with the C64. Custom drive loaders (LISTEN/SECOND/CIOUT M-W/M-E + runtime $DD00 bit-bang) work end-to-end. Returns session id for the other integrated_session tools.",
    {
      disk_path: z.string(),
      device_id: z.number().int().min(8).max(11).optional(),
      pal: z.boolean().optional(),
      start_track: z.number().int().min(1).max(40).optional(),
      write_protected: z.boolean().optional(),
    },
    safeHandler("headless_integrated_session_start", async ({ disk_path, device_id, pal, start_track, write_protected }) => {
      const { startIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const { sessionId, session } = startIntegratedSession({
        diskPath: disk_path, deviceId: device_id, isPal: pal,
        startTrack: start_track, writeProtected: write_protected,
      });
      session.resetCold();
      const status = session.status();
      return {
        content: [{
          type: "text" as const,
          text: [
            `Integrated session started.`,
            `Session: ${sessionId}`,
            `Disk: ${disk_path}`,
            `C64 ROMs: kernal=${status.romSet.kernal}, basic=${status.romSet.basic}, charrom=${status.romSet.charRom}`,
            `C64 PC after cold reset: ${formatHexWord(status.c64.pc)}`,
            `Drive PC after reset: ${formatHexWord(status.drive.pc)}`,
            `Drive head: track ${status.drive.track}`,
          ].join("\n"),
        }],
      };
    },
));

  server.tool(
    "headless_integrated_session_run",
    "Spec 062 Sprint 65: run an integrated session for up to N C64 instructions. Drive runs proportional cycles per the dual-clock accumulator. Optional breakpoints + cycle budget abort. Returns counts + final PC.",
    {
      session_id: z.string(),
      max_instructions: z.number().int().min(1).max(10_000_000),
      breakpoints: z.array(z.string()).optional().describe("Hex PC addresses to break on."),
      cycle_budget: z.number().int().optional(),
    },
    safeHandler("headless_integrated_session_run", async ({ session_id, max_instructions, breakpoints, cycle_budget }) => {
      const { getIntegratedSession } = await import("../runtime/headless/integrated-session-manager.js");
      const session = getIntegratedSession(session_id);
      if (!session) throw new Error(`No integrated session ${session_id}`);
      const bp = breakpoints && breakpoints.length > 0
        ? new Set(breakpoints.map((s) => parseHexWord(s)))
        : undefined;
      const result = session.runFor(max_instructions, { breakpoints: bp, cycleBudget: cycle_budget });
      const status = session.status();
      return {
        content: [{
          type: "text" as const,
          text: [
            `Integrated run — session ${session_id}`,
            `Instructions executed: ${result.instructionsExecuted}${result.aborted ? ` (aborted: ${result.aborted})` : ""}`,
            `C64: PC=${formatHexWord(status.c64.pc)} A=${formatHexByte(status.c64.a)} cycles=${status.c64.cycles}`,
            `Drive: PC=${formatHexWord(status.drive.pc)} A=${formatHexByte(status.drive.a)} cycles=${status.drive.cycles} track=${status.drive.track}`,
            `IEC: ATN=${status.iecBus.line.atn ? "1" : "0"} CLK=${status.iecBus.line.clk ? "1" : "0"} DATA=${status.iecBus.line.data ? "1" : "0"}`,
          ].join("\n"),
        }],
      };
    },
));

  server.tool(
    "headless_integrated_session_status",
    "Spec 062 Sprint 65: snapshot of an integrated session — both CPUs + IEC bus + ROM source.",
    { session_id: z.string() },
    safeHandler("headless_integrated_session_status", async ({ session_id }) => {
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
    "headless_integrated_session_load_prg",
    "Spec 062 Sprint 65: inject a PRG into the C64's RAM as if KERNAL LOAD had completed. Useful for skipping the BASIC READY prompt and jumping straight into a bootloader. Returns load address + bytes loaded.",
    {
      session_id: z.string(),
      prg_path: z.string(),
      load_address: z.string().optional().describe("Override load address (hex). Default = PRG header."),
    },
    safeHandler("headless_integrated_session_load_prg", async ({ session_id, prg_path, load_address }) => {
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

  server.tool(
    "headless_render_screen",
    "Spec 065 Phase A: render the integrated session's current VIC state to a PNG file. Text mode only in Phase 65b; bitmap + sprites in Phase 65d/e. Returns the file path + dimensions + bytes written.",
    {
      session_id: z.string(),
      path: z.string().describe("Output PNG path"),
    },
    safeHandler("headless_render_screen", async ({ session_id, path }) => {
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
    "headless_drive_session_save_vsf",
    "Spec 062 Sprint 64: save the drive session's full state as a VICE Snapshot Format (VSF) file. Modules: DRIVECPU, DRIVERAM, VIA1d1541, VIA2d1541, IECBUS, GCRHEAD. C64 RAM + MainCPU added when full headless C64 ROM integration lands.",
    {
      session_id: z.string(),
      output_path: z.string(),
    },
    safeHandler("headless_drive_session_save_vsf", async ({ session_id, output_path }) => {
      const { getDriveSession } = await import("../runtime/headless/drive/drive-session-manager.js");
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
    "headless_drive_session_load_vsf",
    "Spec 062 Sprint 64: load a VSF file into a drive session. Modules the headless drive runtime owns are restored; modules it doesn't model (VIC, SID, CIA1, KEYBOARD, etc.) are reported as ignored. Use to resume a previous trace or to import VICE-saved state.",
    {
      session_id: z.string(),
      input_path: z.string(),
    },
    safeHandler("headless_drive_session_load_vsf", async ({ session_id, input_path }) => {
      const { getDriveSession } = await import("../runtime/headless/drive/drive-session-manager.js");
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
    "headless_drive_persist_writes",
    "Spec 062 Sprint 63 (Q4.C): write modified GCR tracks back to disk as <image>_session.g64. Original image untouched. Returns paths + modified track list. Save-game RE workflow trigger.",
    {
      session_id: z.string(),
      output_path: z.string().optional().describe("Optional override for the session-G64 output path."),
    },
    safeHandler("headless_drive_persist_writes", async ({ session_id, output_path }) => {
      const { persistDriveSession } = await import("../runtime/headless/drive/drive-session-manager.js");
      const result = persistDriveSession(session_id, output_path);
      const lines = [
        `headless_drive_persist_writes — session ${session_id}`,
        `Output: ${result.outputPath}`,
      ];
      if (result.skipped) {
        lines.push(`Skipped: ${result.skipped}`);
      } else {
        lines.push(`Modified tracks: ${result.modifiedTracks.join(", ")}`);
        lines.push(`Bytes written: ${result.bytesWritten}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
));

  server.tool(
    "headless_monitor_memory",
    "Read a memory range from the active headless runtime session.",
    {
      start: z.string().describe("Start address as hex, e.g. 0801 or $0801"),
      end: z.string().describe("End address as hex, inclusive"),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    safeHandler("headless_monitor_memory", async ({ start, end, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        const startAddress = parseHexWord(start);
        const endAddress = parseHexWord(end);
        const bytes = manager.readMemory(startAddress, endAddress);
        return {
          content: [{
            type: "text" as const,
            text: [
              `Headless memory ${formatHexWord(startAddress)}-${formatHexWord(endAddress)} (${bytes.length} bytes)`,
              Array.from(bytes, (value, index) => `${formatHexWord(startAddress + index)}: ${formatHexByte(value)}`).join("\n"),
            ].join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));
}
