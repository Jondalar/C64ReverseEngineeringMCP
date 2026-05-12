import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { genericSandboxDepack } from "../sandbox/sandbox-depack-generic.js";
import type { ServerToolContext } from "./types.js";

function parseHexU(s: string, max = 0xffff): number {
  const cleaned = s.trim().replace(/^[$#]/, "");
  const v = parseInt(cleaned, 16);
  if (Number.isNaN(v) || v < 0 || v > max) throw new Error(`bad hex: "${s}"`);
  return v;
}

function readPrgOrRaw(path: string): { bytes: Uint8Array; loadAddress?: number } {
  const buf = readFileSync(path);
  if (path.toLowerCase().endsWith(".prg") && buf.length >= 2) {
    return { bytes: buf.subarray(2), loadAddress: buf[0]! | (buf[1]! << 8) };
  }
  return { bytes: buf };
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function registerSandboxDepackTool(server: McpServer, ctx: ServerToolContext): void {
  server.tool(
    "sandbox_depack",
    "Generic sandbox-driven depacker. Run ANY 6502 depacker (the resident routine inside a custom loader) against ANY packed byte-blob without an MCP code change for each variant. The BWC bit-stream sandbox-depack helper is a domain-specific shim over this engine; new packer formats only need entry_pc + zeropage source-pointer convention. The depacker runs to sentinel RTS / stop_pc / max_steps in the sandbox CPU; the contiguous run of writes at dest_address (or the largest contiguous run anywhere) is returned as the unpacked bytes.",
    {
      project_dir: z.string().optional(),
      input_path: z.string().describe("Path to the packed source bytes (chip dump, disk file, raw blob)."),
      offset: z.string().optional().describe("Hex offset into input_path where the packed payload starts. Default 0."),
      length: z.string().optional().describe("Optional hex length to slice (default: from offset to end of file)."),
      resident_loader_path: z.string().describe("Path to the resident loader PRG/binary that contains the depacker."),
      resident_load_address: z.string().optional().describe("Hex load address for resident_loader. Default: from PRG header if .prg, else error."),
      source_load_address: z.string().optional().describe("Hex address where the packed payload is placed in the sandbox. Default = end of resident loader."),
      entry_pc: z.string().describe("Hex PC of the depacker entry point inside the resident loader."),
      source_zp_low: z.number().int().min(0).max(255).optional().describe("Zero-page byte holding the source pointer's low byte. Default $52."),
      source_zp_high: z.number().int().min(0).max(255).optional().describe("Zero-page high source-pointer byte. Default $53."),
      initial_zp: z.record(z.string(), z.number().int().min(0).max(255)).optional().describe("Other zero-page seed values, keyed by hex zp address."),
      initial_a: z.number().int().min(0).max(255).optional(),
      initial_x: z.number().int().min(0).max(255).optional(),
      initial_y: z.number().int().min(0).max(255).optional(),
      initial_sp: z.number().int().min(0).max(255).optional(),
      initial_flags: z.number().int().min(0).max(255).optional(),
      max_steps: z.number().int().positive().optional().describe("Sandbox instruction cap. Default 5_000_000."),
      dest_address: z.string().optional().describe("Hex dest address — where the depacker writes. If unset, returns the largest contiguous write run."),
      capture_range_start: z.string().optional().describe("Hex lower bound for the write capture window (inclusive)."),
      capture_range_end: z.string().optional().describe("Hex upper bound for the write capture window (inclusive)."),
      stop_pc: z.string().optional().describe("Hex stop PC (default: sentinel RTS exit at $FFFE)."),
      output_path: z.string().optional().describe("Output PRG path (2-byte load header + unpacked bytes). Default analysis/depack/<input>-<offset>.prg."),
    },
    async (args) => {
      const projectRoot = ctx.projectDir(undefined, true);
      const inputAbs = resolve(projectRoot, args.input_path);
      const inputBuf = readFileSync(inputAbs);
      const offset = args.offset ? parseHexU(args.offset, 0xffffff) : 0;
      const length = args.length ? parseHexU(args.length, 0xffffff) : undefined;
      const packed = length === undefined ? inputBuf.subarray(offset) : inputBuf.subarray(offset, offset + length);

      const residentAbs = resolve(projectRoot, args.resident_loader_path);
      const { bytes: residentBytes, loadAddress: prgLoadAddress } = readPrgOrRaw(residentAbs);
      const residentLoadAddress = args.resident_load_address ? parseHexU(args.resident_load_address) : prgLoadAddress;
      if (residentLoadAddress === undefined) {
        throw new Error("resident_load_address is required when resident_loader_path is not a .prg file");
      }

      const captureRange = (args.capture_range_start && args.capture_range_end)
        ? { start: parseHexU(args.capture_range_start), end: parseHexU(args.capture_range_end) }
        : undefined;

      const initialZp: Record<number, number> = {};
      for (const [k, v] of Object.entries(args.initial_zp ?? {})) {
        initialZp[parseHexU(k, 0xff)] = v;
      }

      const result = genericSandboxDepack({
        packed,
        residentLoader: residentBytes,
        residentLoadAddress,
        sourceLoadAddress: args.source_load_address ? parseHexU(args.source_load_address) : undefined,
        entryPc: parseHexU(args.entry_pc),
        sourceZpLow: args.source_zp_low,
        sourceZpHigh: args.source_zp_high,
        initialZp,
        initialA: args.initial_a,
        initialX: args.initial_x,
        initialY: args.initial_y,
        initialSp: args.initial_sp,
        initialFlags: args.initial_flags,
        maxSteps: args.max_steps,
        destAddress: args.dest_address ? parseHexU(args.dest_address) : undefined,
        captureRange,
        stopPc: args.stop_pc ? parseHexU(args.stop_pc) : undefined,
      });

      const stem = inputAbs.split("/").pop()!.replace(/\.[^.]+$/, "");
      const outPath = args.output_path
        ? resolve(projectRoot, args.output_path)
        : resolve(projectRoot, "analysis", "depack", `${stem}-${offset.toString(16).padStart(4, "0")}.prg`);
      mkdirSync(dirname(outPath), { recursive: true });
      const prg = new Uint8Array(2 + result.unpacked.length);
      prg[0] = result.destAddress & 0xff;
      prg[1] = (result.destAddress >> 8) & 0xff;
      prg.set(result.unpacked, 2);
      writeFileSync(outPath, prg);

      return textContent([
        `sandbox_depack finished.`,
        `Input: ${inputAbs} +$${offset.toString(16)} (${packed.length} bytes)`,
        `Resident loader: ${residentAbs} @ $${residentLoadAddress.toString(16)} (${residentBytes.length} bytes)`,
        `Entry PC: $${result.entryPc.toString(16)}`,
        `Output: ${outPath} (${prg.length} bytes incl. load header)`,
        `Dest: $${result.destAddress.toString(16)} unpacked=${result.unpacked.length}`,
        `Sandbox: ${result.steps} steps, stop=${result.stopReason}, total writes=${result.writes.length}`,
      ].join("\n"));
    },
  );
}
