import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getHeadlessSessionManager, getPreferredHeadlessSessionManager } from "../runtime/headless/index.js";
import type { HeadlessRunResult, HeadlessSessionRecord } from "../runtime/headless/types.js";
import { findHeadlessTraceByAccess, findHeadlessTraceByPc, loadHeadlessSession, sliceHeadlessTraceByIndex } from "../runtime/headless/trace-query.js";
import { buildHeadlessTraceIndex } from "../runtime/headless/trace-index.js";
import type { ServerToolContext } from "./types.js";

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
    async ({ prg_path, disk_path, crt_path, mapper_type, entry_pc }) => {
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
  );

  server.tool(
    "headless_session_status",
    "Show the current headless C64 RE runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
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
  );

  server.tool(
    "headless_session_stop",
    "Stop the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
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
  );

  server.tool(
    "headless_session_step",
    "Execute one instruction in the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
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
  );

  server.tool(
    "headless_session_run",
    "Run the active headless runtime session for a bounded number of instructions or until a stop PC is reached.",
    {
      max_instructions: z.number().int().positive().optional().describe("Maximum instruction count to execute (default: 1000)."),
      stop_pc: z.string().optional().describe("Optional stop PC in hex."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ max_instructions, stop_pc, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        const result = manager.runSession({
          maxInstructions: max_instructions,
          stopPc: stop_pc ? parseHexWord(stop_pc) : undefined,
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
  );

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
    async ({ address, start, end, operation, label, temporary, hint_path }) => {
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
  );

  server.tool(
    "headless_breakpoint_clear",
    "Clear all execution and memory-access breakpoints from the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        manager.clearBreakpoints();
        return { content: [{ type: "text" as const, text: "Headless breakpoints cleared." }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

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
    async ({ name, start, end, include_bytes, hint_path }) => {
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
  );

  server.tool(
    "headless_watch_clear",
    "Clear all watched memory ranges from the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        manager.clearWatchRanges();
        return { content: [{ type: "text" as const, text: "Headless watch ranges cleared." }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  server.tool(
    "headless_interrupt_request",
    "Mark an IRQ or NMI as pending in the active headless runtime session. The runtime will dispatch it between instructions when possible.",
    {
      interrupt: z.enum(["irq", "nmi"]).describe("Interrupt line to request."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ interrupt, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(context, hint_path));
        manager.requestInterrupt(interrupt);
        return { content: [{ type: "text" as const, text: `Headless ${interrupt.toUpperCase()} requested.` }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  server.tool(
    "headless_io_interrupt_trigger",
    "Trigger a simple VIC/CIA interrupt source in the headless runtime. If the corresponding mask bit is enabled, this will queue an IRQ or NMI.",
    {
      source: z.enum(["vic", "cia1", "cia2"]).describe("Interrupt source to trigger."),
      mask: z.number().int().min(1).max(31).optional().describe("Bit mask to set in the source status register (default: 1)."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ source, mask, hint_path }) => {
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
  );

  server.tool(
    "headless_interrupt_clear",
    "Clear pending IRQ and/or NMI state in the active headless runtime session.",
    {
      interrupt: z.enum(["irq", "nmi", "both"]).optional().describe("Which pending interrupt to clear; defaults to both."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ interrupt, hint_path }) => {
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
  );

  server.tool(
    "headless_trace_tail",
    "Render the most recent headless runtime trace events with access, stack, bank, and watch metadata.",
    {
      limit: z.number().int().positive().max(64).optional().describe("How many recent events to render (default: 12)."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ limit, hint_path }) => {
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
  );

  server.tool(
    "headless_trace_find_pc",
    "Find occurrences of a PC in a persisted headless runtime trace.",
    {
      pc: z.string().describe("PC to search, e.g. 63A1"),
      limit: z.number().int().positive().max(100).optional().describe("Maximum matches to return."),
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
    },
    async ({ pc, limit, session_id }) => {
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
  );

  server.tool(
    "headless_trace_find_access",
    "Find headless trace events that touched a specific effective memory address.",
    {
      address: z.string().describe("Target address as hex."),
      access: z.enum(["read", "write", "access"]).optional().describe("Access kind filter; defaults to access."),
      limit: z.number().int().positive().max(100).optional().describe("Maximum matches to return."),
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
    },
    async ({ address, access, limit, session_id }) => {
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
  );

  server.tool(
    "headless_trace_slice",
    "Return a focused window around a persisted headless trace event index.",
    {
      anchor_index: z.number().int().nonnegative().describe("Event index to anchor on."),
      before: z.number().int().nonnegative().max(200).optional().describe("How many events before the anchor to include."),
      after: z.number().int().nonnegative().max(400).optional().describe("How many events after the anchor to include."),
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
    },
    async ({ anchor_index, before, after, session_id }) => {
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
  );

  server.tool(
    "headless_trace_build_index",
    "Build a persistent PC/access hotspot index for a headless runtime trace session.",
    {
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
      limit: z.number().int().positive().max(256).optional().describe("How many top PCs/accesses to keep in the summary."),
    },
    async ({ session_id, limit }) => {
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
  );

  server.tool(
    "headless_monitor_registers",
    "Read CPU registers from the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
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
  );

  server.tool(
    "headless_monitor_memory",
    "Read a memory range from the active headless runtime session.",
    {
      start: z.string().describe("Start address as hex, e.g. 0801 or $0801"),
      end: z.string().describe("End address as hex, inclusive"),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ start, end, hint_path }) => {
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
  );
}
