import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runSandbox, type SandboxLoad } from "../sandbox/index.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

function parseHexWord(value: string): number {
  const normalized = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,4}$/.test(normalized)) {
    throw new Error(`Invalid 16-bit hex value: ${value}`);
  }
  return parseInt(normalized, 16);
}

function parseHexByte(value: string): number {
  const normalized = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,2}$/.test(normalized)) {
    throw new Error(`Invalid 8-bit hex value: ${value}`);
  }
  return parseInt(normalized, 16);
}

function parseHexBytes(value: string): number[] {
  const cleaned = value.replace(/\s+/g, "").replace(/^0x/i, "");
  if (!/^([0-9a-fA-F]{2})+$/.test(cleaned)) {
    throw new Error("hex_bytes must be an even-length hex string");
  }
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

function formatHexWord(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function formatHexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

const memBlockSchema = z.object({
  // Resolved against project dir if relative.
  prg_path: z.string().optional().describe("Path to a PRG file. First two bytes are load address."),
  raw_path: z.string().optional().describe("Path to a raw blob loaded at `address`."),
  hex_bytes: z.string().optional().describe("Inline hex bytes loaded at `address`."),
  address: z.string().optional().describe("Load address as hex (required for raw_path / hex_bytes)."),
  load_address_override: z.string().optional().describe("Override the PRG load address (rare)."),
  mapping: z.enum(["ram", "rom", "ef_roml", "ef_romh"]).optional().describe("Read/write mapping for this load. \"ram\" (default) is fully writable. \"rom\"/\"ef_roml\"/\"ef_romh\" map the bytes as a READ-ONLY overlay: CPU reads in this range return the load's bytes, writes pass through to a parallel RAM array under the same addresses. Use this for cart depackers where source ($8000+ in ROM) and destination ($8000+ in RAM) collide in a flat sandbox. The CPU port at $01 is NOT emulated — both ef_roml and ef_romh just install the read-only overlay."),
});

export function registerSandboxTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "sandbox_6502_run",
    "Run a 6502 routine in an isolated sandbox: load code/data into a flat 64K RAM, optionally hook PCs to feed bytes from an input stream (e.g. replace a serial-recv subroutine), execute until a stop PC / sentinel RTS / max steps / unimplemented opcode, and return the writes plus final CPU state. Use this for porting depackers, crypto, and custom I/O routines without standing up a full C64 emulator. Sentinel RTS exits when the stack returns to $FFFE (pre-staged at $01FE=$FD, $01FF=$FF). The CPU supports common undocumented opcodes (RLA, SLO, RRA, ISC, LAX, SAX, DCP, ALR, ARR, AXS, ANC, undoc NOPs, JAM).",
    {
      loads: z.array(memBlockSchema).min(1).describe("Memory loads applied in order. Each entry must specify exactly one of prg_path / raw_path / hex_bytes."),
      initial_pc: z.string().describe("Hex PC where execution starts."),
      initial_zp: z.record(z.string(), z.number().int().min(0).max(255)).optional().describe("Zero-page seed values, keyed by hex zp address (e.g. {\"06\": 0, \"07\": 64})."),
      initial_a: z.number().int().min(0).max(255).optional(),
      initial_x: z.number().int().min(0).max(255).optional(),
      initial_y: z.number().int().min(0).max(255).optional(),
      initial_sp: z.number().int().min(0).max(255).optional().describe("Initial SP. Defaults to $FD with sentinel staged."),
      initial_flags: z.number().int().min(0).max(255).optional(),
      input_stream_path: z.string().optional().describe("Path to a file whose bytes are streamed via the hook PCs."),
      input_stream_hex: z.string().optional().describe("Inline hex stream bytes (alternative to input_stream_path)."),
      stream_hook_pcs: z.array(z.string()).optional().describe("List of hex PCs that should be replaced by 'next stream byte → A; C=0; RTS'."),
      stop_pc: z.string().optional().describe("Optional stop PC in hex."),
      max_steps: z.number().int().positive().optional().describe("Maximum instructions executed (default 10_000_000)."),
      return_writes_start: z.string().optional().describe("Restrict returned writes to start ≤ addr ≤ end (hex)."),
      return_writes_end: z.string().optional(),
      return_memory_ranges: z.array(z.object({ start: z.string(), end: z.string() })).optional().describe("Memory ranges to snapshot at end of run."),
      output_path: z.string().optional().describe("If set, write the contiguous span of all returned writes as a PRG (2-byte load header + bytes) to this path."),
    },
    safeHandler("sandbox_6502_run", async (args) => {
      try {
        const projectRoot = context.projectDir(undefined, true);
        const loads: SandboxLoad[] = args.loads.map((entry, idx) => {
          const provided = [entry.prg_path, entry.raw_path, entry.hex_bytes].filter(Boolean).length;
          if (provided !== 1) {
            throw new Error(`loads[${idx}]: specify exactly one of prg_path, raw_path, hex_bytes`);
          }
          if (entry.prg_path) {
            return {
              prgPath: resolve(projectRoot, entry.prg_path),
              loadAddressOverride: entry.load_address_override ? parseHexWord(entry.load_address_override) : undefined,
              mapping: entry.mapping,
            };
          }
          if (entry.raw_path) {
            if (!entry.address) throw new Error(`loads[${idx}]: address is required for raw_path`);
            return { rawPath: resolve(projectRoot, entry.raw_path), address: parseHexWord(entry.address), mapping: entry.mapping };
          }
          if (!entry.address) throw new Error(`loads[${idx}]: address is required for hex_bytes`);
          return { bytes: parseHexBytes(entry.hex_bytes!), address: parseHexWord(entry.address), mapping: entry.mapping };
        });

        const initialZp: Record<number, number> = {};
        for (const [zpStr, value] of Object.entries(args.initial_zp ?? {})) {
          initialZp[parseHexByte(zpStr)] = value;
        }

        let inputStream: number[] | undefined;
        if (args.input_stream_path) {
          const { readFileSync } = await import("node:fs");
          inputStream = Array.from(readFileSync(resolve(projectRoot, args.input_stream_path)));
        } else if (args.input_stream_hex) {
          inputStream = parseHexBytes(args.input_stream_hex);
        }

        const writesRange = (args.return_writes_start && args.return_writes_end)
          ? { start: parseHexWord(args.return_writes_start), end: parseHexWord(args.return_writes_end) }
          : undefined;

        const result = runSandbox({
          loads,
          initialPc: parseHexWord(args.initial_pc),
          initialZp,
          initialA: args.initial_a,
          initialX: args.initial_x,
          initialY: args.initial_y,
          initialSp: args.initial_sp,
          initialFlags: args.initial_flags,
          inputStream,
          streamHookPcs: args.stream_hook_pcs?.map(parseHexWord),
          stopPc: args.stop_pc !== undefined ? parseHexWord(args.stop_pc) : undefined,
          maxSteps: args.max_steps,
          returnWritesRange: writesRange,
          returnMemoryRanges: args.return_memory_ranges?.map((r) => ({ start: parseHexWord(r.start), end: parseHexWord(r.end) })),
        });

        const lines = [
          `sandbox_6502_run finished.`,
          `Stop reason: ${result.stopReason}`,
          `Steps: ${result.steps}`,
          `Final PC: $${formatHexWord(result.finalState.pc)} A=$${formatHexByte(result.finalState.a)} X=$${formatHexByte(result.finalState.x)} Y=$${formatHexByte(result.finalState.y)} SP=$${formatHexByte(result.finalState.sp)} FL=$${formatHexByte(result.finalState.flags)}`,
          `Stream pos: ${result.streamPos}`,
          `Writes returned: ${result.writes.length}`,
        ];
        if (result.unimplementedOpcode) {
          const { describeOpcode } = await import("../sandbox/opcode-table.js");
          const mn = describeOpcode(result.unimplementedOpcode.opcode);
          const mnText = mn === "unknown" ? "" : ` (${mn})`;
          lines.push(`Unimplemented opcode: $${formatHexByte(result.unimplementedOpcode.opcode)}${mnText} @ $${formatHexWord(result.unimplementedOpcode.pc)}`);
        }
        if (result.writtenSpan) {
          lines.push(`Write span: $${formatHexWord(result.writtenSpan.start)}-$${formatHexWord(result.writtenSpan.end)} (${result.writtenSpan.bytes.length} bytes)`);
        }
        for (const snap of result.memorySnapshots) {
          const preview = snap.bytes.slice(0, 32).map(formatHexByte).join(" ");
          lines.push(`Memory $${formatHexWord(snap.start)}-$${formatHexWord(snap.end)} (${snap.bytes.length} bytes): ${preview}${snap.bytes.length > 32 ? " …" : ""}`);
        }

        if (args.output_path && result.writtenSpan) {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { dirname } = await import("node:path");
          const outPath = resolve(projectRoot, args.output_path);
          mkdirSync(dirname(outPath), { recursive: true });
          const buf = Buffer.alloc(2 + result.writtenSpan.bytes.length);
          buf[0] = result.writtenSpan.start & 0xff;
          buf[1] = (result.writtenSpan.start >> 8) & 0xff;
          for (let i = 0; i < result.writtenSpan.bytes.length; i++) buf[2 + i] = result.writtenSpan.bytes[i]!;
          writeFileSync(outPath, buf);
          lines.push(`Wrote PRG: ${outPath} ($${formatHexWord(result.writtenSpan.start)}-$${formatHexWord(result.writtenSpan.end)})`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));
}
