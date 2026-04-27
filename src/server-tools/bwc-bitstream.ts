import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sandboxDepack } from "../bwc-bitstream-ts/sandbox-depack.js";
import { pack } from "../bwc-bitstream-ts/cruncher.js";
import { parseHeader } from "../bwc-bitstream-ts/header.js";
import { isBitstreamMagic, packRaw, parseRaw } from "../bwc-bitstream-ts/raw.js";
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
    const loadAddress = buf[0]! | (buf[1]! << 8);
    return { bytes: buf.subarray(2), loadAddress };
  }
  return { bytes: buf };
}

function ensureDir(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function defaultDepackOutput(projectRoot: string, inputPath: string, offset: number, ext: string): string {
  const stem = inputPath.split("/").pop()!.replace(/\.[^.]+$/, "");
  return resolve(projectRoot, "analysis", "depack", "bwc", `${stem}-${offset.toString(16).padStart(4, "0")}.${ext}`);
}

export function registerBwcBitstreamTools(server: McpServer, ctx: ServerToolContext): void {
  server.tool(
    "depack_bwc_bitstream",
    "Depack a BWC bit-stream chunk (Pucrunch-derived format with 'pu' magic). Runs the original $C992 depacker in the sandbox and captures the contiguous run of writes at the destination. Returns a PRG with the destination as load address.",
    {
      input_path: z.string().describe("Path to the packed source (cart bank chip or arbitrary binary). Resolved against project dir."),
      offset: z.string().optional().describe("Hex offset into input_path where the chunk starts. Default 0."),
      output_path: z.string().optional().describe("Output PRG path. Default analysis/depack/bwc/<stem>-<offset>.prg."),
      resident_loader_path: z.string().describe("Path to the BWC resident loader PRG containing $C992 (e.g. analysis/prg/resident_loader_c800.prg)."),
      return_header: z.boolean().optional().describe("Include parsed header values in the response."),
      max_steps: z.number().int().positive().optional().describe("Max sandbox instruction count. Default 5_000_000."),
    },
    async (args) => {
      const projectRoot = ctx.projectDir(undefined, true);
      const inputPath = resolve(projectRoot, args.input_path);
      const offset = args.offset ? parseHexU(args.offset, 0xffffff) : 0;
      const buf = readFileSync(inputPath);
      const packed = buf.subarray(offset);
      const residentPath = resolve(projectRoot, args.resident_loader_path);
      const { bytes: residentBytes, loadAddress } = readPrgOrRaw(residentPath);
      const result = sandboxDepack({
        packed,
        residentLoader: residentBytes,
        residentLoadAddress: loadAddress,
        maxSteps: args.max_steps,
      });
      const outPath = args.output_path
        ? resolve(projectRoot, args.output_path)
        : defaultDepackOutput(projectRoot, inputPath, offset, "prg");
      ensureDir(outPath);
      const prg = new Uint8Array(2 + result.unpacked.length);
      prg[0] = result.destAddress & 0xff;
      prg[1] = (result.destAddress >> 8) & 0xff;
      prg.set(result.unpacked, 2);
      writeFileSync(outPath, prg);
      const lines: string[] = [
        `depack_bwc_bitstream finished.`,
        `Input: ${inputPath} +$${offset.toString(16)} (${packed.length} bytes available)`,
        `Output: ${outPath} (${prg.length} bytes incl. 2-byte load header)`,
        `Dest: $${result.destAddress.toString(16)}`,
        `Unpacked size: ${result.unpacked.length} bytes`,
        `Sandbox: ${result.steps} steps, stop=${result.stopReason}`,
      ];
      if (args.return_header) {
        const h = result.header;
        lines.push(``);
        lines.push(`Header:`);
        lines.push(`  skip4=${[...h.skip4].map(b => b.toString(16).padStart(2, "0")).join(" ")}`);
        lines.push(`  cmp_op=$${h.cmpOp.toString(16).padStart(2, "0")}`);
        lines.push(`  N1=${h.n1} N2=${h.n2} N3=${h.n3} N4=${h.n4}`);
        lines.push(`  unused2=${[...h.unused2].map(b => b.toString(16).padStart(2, "0")).join(" ")}`);
        lines.push(`  Y=${h.y} lit_table=${h.litTable.length === 0 ? "(empty)" : "[" + [...h.litTable.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join(" ") + (h.litTable.length > 16 ? " …" : "") + "]"}`);
      }
      return textContent(lines.join("\n"));
    },
  );

  server.tool(
    "pack_bwc_bitstream",
    "Pack a binary into a BWC bit-stream chunk that the original $C992 depacker can decompress. Output is NOT byte-identical to a reference packer — it's a functional re-encoding using literals, LZ-far back-references (length>=3), cmp_op-update, and the 2*N3-1 end marker. Defaults: N1=2, N2=8, N3=128, N4=0, no literal table — matches all observed BWC v1.0.6 chunks. Verified: round-trip via depack_bwc_bitstream is byte-identical for all 6 BWC v1.0.6 boot chunks.",
    {
      input_path: z.string().describe("Path to a PRG (load addr in first 2 bytes) or raw bytes file."),
      load_address: z.string().optional().describe("Hex load address. Required if input is raw (not PRG)."),
      output_path: z.string().optional().describe("Output packed binary path. Default analysis/depack/bwc/<stem>-packed.bin."),
      n1: z.number().int().min(1).max(7).optional().describe("Main-token bit width. Default 2."),
      max_distance: z.number().int().positive().optional().describe("Max LZ back-reference distance in bytes. Default 65535."),
    },
    async (args) => {
      const projectRoot = ctx.projectDir(undefined, true);
      const inputPath = resolve(projectRoot, args.input_path);
      const { bytes, loadAddress } = readPrgOrRaw(inputPath);
      const dest = args.load_address ? parseHexU(args.load_address) : loadAddress;
      if (dest === undefined) {
        throw new Error(`load_address is required when input is not a .prg file`);
      }
      const result = pack(bytes, { dest, n1: args.n1, maxDistance: args.max_distance });
      const stem = inputPath.split("/").pop()!.replace(/\.[^.]+$/, "");
      const outPath = args.output_path
        ? resolve(projectRoot, args.output_path)
        : resolve(projectRoot, "analysis", "depack", "bwc", `${stem}-packed.bin`);
      ensureDir(outPath);
      writeFileSync(outPath, result.packed);
      const ratio = bytes.length === 0 ? 0 : (100 * result.packed.length) / bytes.length;
      return textContent([
        `pack_bwc_bitstream finished.`,
        `Input: ${inputPath} (${bytes.length} bytes, dest=$${dest.toString(16)})`,
        `Output: ${outPath} (${result.packed.length} bytes, ${ratio.toFixed(1)}% of input)`,
        `Stats: literals=${result.stats.plainLiterals} cmp_op_updates=${result.stats.updateLiterals} lz_matches=${result.stats.lzMatches} (${result.stats.lzBytesCovered} bytes covered)`,
        `Header: cmp_op=$${result.header.cmpOp.toString(16)} N1=${result.header.n1}`,
      ].join("\n"));
    },
  );

  server.tool(
    "depack_bwc_raw",
    "Depack a BWC raw chunk (uncompressed). Layout: dest_lo / dest_hi / skip / length_pages / body[length_pages * 256]. Returns a PRG with the destination as load address.",
    {
      input_path: z.string(),
      offset: z.string().optional(),
      output_path: z.string().optional(),
    },
    async (args) => {
      const projectRoot = ctx.projectDir(undefined, true);
      const inputPath = resolve(projectRoot, args.input_path);
      const offset = args.offset ? parseHexU(args.offset, 0xffffff) : 0;
      const buf = readFileSync(inputPath);
      const chunk = parseRaw(buf, offset);
      const outPath = args.output_path
        ? resolve(projectRoot, args.output_path)
        : defaultDepackOutput(projectRoot, inputPath, offset, "prg");
      ensureDir(outPath);
      const prg = new Uint8Array(2 + chunk.body.length);
      prg[0] = chunk.header.dest & 0xff;
      prg[1] = (chunk.header.dest >> 8) & 0xff;
      prg.set(chunk.body, 2);
      writeFileSync(outPath, prg);
      return textContent([
        `depack_bwc_raw finished.`,
        `Input: ${inputPath} +$${offset.toString(16)}`,
        `Output: ${outPath} (${prg.length} bytes)`,
        `Dest: $${chunk.header.dest.toString(16)} length_pages=${chunk.header.lengthPages} body=${chunk.body.length}`,
        `Skip byte: $${chunk.header.skip.toString(16)}`,
      ].join("\n"));
    },
  );

  server.tool(
    "pack_bwc_raw",
    "Pack a binary into the BWC raw chunk format. Body is padded to a multiple of 256 bytes. Refuses inputs that start with 'pu' magic (engine would route as bitstream).",
    {
      input_path: z.string(),
      load_address: z.string().optional(),
      skip_byte: z.number().int().min(0).max(255).optional(),
      output_path: z.string().optional(),
    },
    async (args) => {
      const projectRoot = ctx.projectDir(undefined, true);
      const inputPath = resolve(projectRoot, args.input_path);
      const { bytes, loadAddress } = readPrgOrRaw(inputPath);
      const dest = args.load_address ? parseHexU(args.load_address) : loadAddress;
      if (dest === undefined) throw new Error(`load_address is required when input is not a .prg file`);
      const packed = packRaw(bytes, { dest, skipByte: args.skip_byte });
      const stem = inputPath.split("/").pop()!.replace(/\.[^.]+$/, "");
      const outPath = args.output_path
        ? resolve(projectRoot, args.output_path)
        : resolve(projectRoot, "analysis", "depack", "bwc", `${stem}-raw.bin`);
      ensureDir(outPath);
      writeFileSync(outPath, packed);
      const padded = packed.length - 4 - bytes.length;
      return textContent([
        `pack_bwc_raw finished.`,
        `Input: ${inputPath} (${bytes.length} bytes, dest=$${dest.toString(16)})`,
        `Output: ${outPath} (${packed.length} bytes, padded ${padded})`,
        `length_pages=${(packed.length - 4) / 256}`,
      ].join("\n"));
    },
  );

  server.tool(
    "depack_bwc_chunk",
    "Auto-dispatch on the first two bytes: 'pu' magic → depack_bwc_bitstream, else → depack_bwc_raw. Mirrors the engine's discriminator at $0D79.",
    {
      input_path: z.string(),
      offset: z.string().optional(),
      output_path: z.string().optional(),
      resident_loader_path: z.string().optional().describe("Required if the chunk is bitstream. Path to the resident loader PRG."),
    },
    async (args) => {
      const projectRoot = ctx.projectDir(undefined, true);
      const inputPath = resolve(projectRoot, args.input_path);
      const offset = args.offset ? parseHexU(args.offset, 0xffffff) : 0;
      const buf = readFileSync(inputPath);
      const isBitstream = isBitstreamMagic(buf, offset);

      if (isBitstream) {
        if (!args.resident_loader_path) {
          throw new Error(`chunk has 'pu' magic (bitstream) — resident_loader_path is required`);
        }
        const residentPath = resolve(projectRoot, args.resident_loader_path);
        const { bytes: residentBytes, loadAddress } = readPrgOrRaw(residentPath);
        const result = sandboxDepack({
          packed: buf.subarray(offset),
          residentLoader: residentBytes,
          residentLoadAddress: loadAddress,
        });
        const outPath = args.output_path
          ? resolve(projectRoot, args.output_path)
          : defaultDepackOutput(projectRoot, inputPath, offset, "prg");
        ensureDir(outPath);
        const prg = new Uint8Array(2 + result.unpacked.length);
        prg[0] = result.destAddress & 0xff;
        prg[1] = (result.destAddress >> 8) & 0xff;
        prg.set(result.unpacked, 2);
        writeFileSync(outPath, prg);
        return textContent([
          `depack_bwc_chunk: dispatched as BITSTREAM (pu magic).`,
          `Input: ${inputPath} +$${offset.toString(16)}`,
          `Output: ${outPath} (${prg.length} bytes incl. load header)`,
          `Dest: $${result.destAddress.toString(16)} unpacked=${result.unpacked.length}`,
        ].join("\n"));
      }
      // Raw path
      const chunk = parseRaw(buf, offset);
      const outPath = args.output_path
        ? resolve(projectRoot, args.output_path)
        : defaultDepackOutput(projectRoot, inputPath, offset, "prg");
      ensureDir(outPath);
      const prg = new Uint8Array(2 + chunk.body.length);
      prg[0] = chunk.header.dest & 0xff;
      prg[1] = (chunk.header.dest >> 8) & 0xff;
      prg.set(chunk.body, 2);
      writeFileSync(outPath, prg);
      return textContent([
        `depack_bwc_chunk: dispatched as RAW.`,
        `Input: ${inputPath} +$${offset.toString(16)}`,
        `Output: ${outPath} (${prg.length} bytes incl. load header)`,
        `Dest: $${chunk.header.dest.toString(16)} length_pages=${chunk.header.lengthPages}`,
      ].join("\n"));
    },
  );

  void existsSync; // tree-shake guard
}
