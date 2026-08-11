import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { genericSandboxDepackMany } from "../sandbox/sandbox-depack-generic.js";
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
    "Run a game's OWN 6502 depacker/decryptor over packed bytes and get the plaintext back — the sandbox CPU executes the resident routine against ANY packed blob, no MCP code change per variant. Use when a payload is self-decrypting (XOR / RLE / custom crypto) so disasm_prg sees real code: point it at the resident loader, the depack entry_pc, and the zeropage source-pointer convention (default $52/$53). It runs to sentinel RTS / stop_pc / max_steps; the contiguous run of writes at dest_address (or the largest contiguous run) is returned as the unpacked bytes. Not for a standard packer (use try_depack / suggest_depacker); not for running arbitrary code (use sandbox_6502_run).",
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
      items: z.array(z.object({
        input_path: z.string().optional().describe("Override the shared input_path for this item."),
        offset: z.string().optional().describe("Hex offset for this item."),
        length: z.string().optional().describe("Hex length for this item."),
        source_load_address: z.string().optional(),
        dest_address: z.string().optional(),
        output_path: z.string().optional(),
        // Per-item register seeds. A real campaign needs these: a chunk loader that
        // takes its END ADDRESS in A/X has a different value for every chunk, so
        // without them the batch could only ever run one payload's worth of work.
        initial_a: z.number().int().min(0).max(255).optional(),
        initial_x: z.number().int().min(0).max(255).optional(),
        initial_y: z.number().int().min(0).max(255).optional(),
      })).optional().describe(
        "Spec 805 — depack N payloads in ONE runtime process instead of N. Every field ABOVE is the shared template (the resident loader, entry_pc, the zeropage convention, the caps); each item overrides only what differs — normally just offset/length/dest. This is the campaign case: one depacker, many chunks. Measured 18x faster than the same payloads one call at a time, because a process start costs ~740 ms and the depack itself costs milliseconds. Results are byte-identical to running them singly, and a payload that fails is reported in its own slot without sinking the rest.",
      ),
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

      // Spec 805 — one process for N payloads. A single call is items=[{}]: the
      // same code path, so single and batch cannot drift.
      const items = args.items && args.items.length > 0 ? args.items : [{}];
      const shared = {
        residentLoader: residentBytes,
        residentLoadAddress,
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
        captureRange,
        stopPc: args.stop_pc ? parseHexU(args.stop_pc) : undefined,
      };

      const prepared = items.map((item) => {
        const itemInputAbs = item.input_path ? resolve(projectRoot, item.input_path) : inputAbs;
        const buf = item.input_path ? readFileSync(itemInputAbs) : inputBuf;
        const off = item.offset !== undefined ? parseHexU(item.offset, 0xffffff) : offset;
        const len = item.length !== undefined ? parseHexU(item.length, 0xffffff) : length;
        const bytes = len === undefined ? buf.subarray(off) : buf.subarray(off, off + len);
        const srcLoad = item.source_load_address ?? args.source_load_address;
        const dest = item.dest_address ?? args.dest_address;
        return {
          inputAbs: itemInputAbs,
          offset: off,
          outputPath: item.output_path ?? args.output_path,
          opts: {
            ...shared,
            packed: bytes,
            sourceLoadAddress: srcLoad ? parseHexU(srcLoad) : undefined,
            destAddress: dest ? parseHexU(dest) : undefined,
            initialA: item.initial_a ?? shared.initialA,
            initialX: item.initial_x ?? shared.initialX,
            initialY: item.initial_y ?? shared.initialY,
          },
        };
      });

      const outcomes = genericSandboxDepackMany(prepared.map((p) => p.opts));

      const lines: string[] = [];
      let okCount = 0;
      for (const [i, outcome] of outcomes.entries()) {
        const p = prepared[i];
        const label = `+$${p.offset.toString(16)}`;
        if (!outcome.ok) {
          lines.push(`  ${label} FAILED — ${outcome.error}`);
          continue;
        }
        okCount += 1;
        const result = outcome.result;
        const stem = p.inputAbs.split("/").pop()!.replace(/\.[^.]+$/, "");
        const outPath = p.outputPath
          ? resolve(projectRoot, p.outputPath)
          : resolve(projectRoot, "analysis", "depack", `${stem}-${p.offset.toString(16).padStart(4, "0")}.prg`);
        mkdirSync(dirname(outPath), { recursive: true });
        const prg = new Uint8Array(2 + result.unpacked.length);
        prg[0] = result.destAddress & 0xff;
        prg[1] = (result.destAddress >> 8) & 0xff;
        prg.set(result.unpacked, 2);
        writeFileSync(outPath, prg);
        lines.push(
          `  ${label} → ${outPath} · dest $${result.destAddress.toString(16)} · ` +
            `unpacked ${result.unpacked.length} · ${result.steps} steps, stop=${result.stopReason}`,
        );
      }

      const failed = outcomes.length - okCount;
      return textContent([
        outcomes.length === 1
          ? `sandbox_depack finished.`
          : `sandbox_depack finished — ${outcomes.length} payload(s) in ONE runtime process` +
            `${failed ? `, ${failed} failed` : ""}.`,
        `Input: ${inputAbs}`,
        `Resident loader: ${residentAbs} @ $${residentLoadAddress.toString(16)} (${residentBytes.length} bytes)`,
        `Entry PC: $${parseHexU(args.entry_pc).toString(16)}`,
        ...lines,
        ...(failed ? [``, `${failed} payload(s) failed; the rest are written. A failure is reported per payload, never as a batch abort.`] : []),
      ].join("\n"));
    },
  );
}
