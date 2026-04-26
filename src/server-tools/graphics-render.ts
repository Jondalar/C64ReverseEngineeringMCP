import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodePng } from "../graphics-render/png-encoder.js";
import {
  PALETTES,
  decodeBitmap,
  decodeCharmap,
  decodeCharset,
  decodeSprites,
  type DecodedImage,
  type PaletteName,
} from "../graphics-render/c64-decoders.js";
import type { ServerToolContext } from "./types.js";

const KIND_VALUES = ["sprite", "charset", "bitmap", "charmap"] as const;
type RenderKind = (typeof KIND_VALUES)[number];
const PALETTE_VALUES = Object.keys(PALETTES) as PaletteName[];

function parseAddress(value: string): number {
  const trimmed = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error(`Invalid hex address: ${value}`);
  }
  const parsed = Number.parseInt(trimmed, 16);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid hex address: ${value}`);
  }
  return parsed;
}

function readPrgLoadAddress(prgPath: string): number {
  const buffer = readFileSync(prgPath);
  if (buffer.length < 2) {
    throw new Error(`PRG too short: ${prgPath}`);
  }
  return buffer.readUInt16LE(0);
}

function decode(kind: RenderKind, params: {
  bytes: Uint8Array;
  charsetBytes?: Uint8Array;
  multicolor: boolean;
  palette: PaletteName;
  fg: number;
  bg: number;
  c1: number;
  c2: number;
  columns?: number;
  screen?: Uint8Array;
  colorRam?: Uint8Array;
}): DecodedImage {
  const palette = { palette: params.palette, fg: params.fg, bg: params.bg, c1: params.c1, c2: params.c2 };
  switch (kind) {
    case "sprite":
      return decodeSprites(params.bytes, { ...palette, multicolor: params.multicolor, columns: params.columns });
    case "charset":
      return decodeCharset(params.bytes, { ...palette, multicolor: params.multicolor, columns: params.columns });
    case "bitmap":
      return decodeBitmap(params.bytes, { ...palette, multicolor: params.multicolor, screen: params.screen, colorRam: params.colorRam });
    case "charmap": {
      if (!params.charsetBytes || params.charsetBytes.length === 0) {
        throw new Error("charmap render requires charset_path / charset_offset / charset_length");
      }
      return decodeCharmap(params.bytes, params.charsetBytes, { ...palette, columns: params.columns });
    }
    default:
      throw new Error(`Unsupported kind: ${kind}`);
  }
}

interface RenderInputs {
  projectDir: string;
  inputPath: string;
  offsetMode: "file" | "address";
  offsetValue: number;
  length: number;
  kind: RenderKind;
  multicolor: boolean;
  palette: PaletteName;
  fg: number;
  bg: number;
  c1: number;
  c2: number;
  columns?: number;
  charsetPath?: string;
  charsetOffset?: number;
  charsetLength?: number;
  charsetOffsetMode?: "file" | "address";
  outputPath: string;
}

function resolveByteWindow(inputAbsPath: string, mode: "file" | "address", value: number, length: number): Uint8Array {
  const buffer = readFileSync(inputAbsPath);
  let fileOffset: number;
  if (mode === "file") {
    fileOffset = value;
  } else {
    const loadAddress = readPrgLoadAddress(inputAbsPath);
    fileOffset = (value - loadAddress) + 2; // 2-byte PRG header
  }
  if (fileOffset < 0 || fileOffset >= buffer.length) {
    throw new Error(`Resolved file offset ${fileOffset} is out of bounds for ${inputAbsPath} (size ${buffer.length}).`);
  }
  const end = Math.min(buffer.length, fileOffset + length);
  return new Uint8Array(buffer.subarray(fileOffset, end));
}

export function registerGraphicsRenderTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "render_graphics_preview",
    "Render a slice of a PRG (or any binary) as a PNG using one of the C64 graphics decoders (sprite, charset, bitmap, charmap). Useful for visually confirming whether a candidate region holds graphics or noise; saves the PNG under <project>/session/graphics-previews/ and returns its path so a multimodal LLM (or a human) can inspect it.",
    {
      project_dir: z.string().optional().describe("Project root. When omitted, resolved from input_path."),
      input_path: z.string().describe("Path to the PRG / binary file (relative to project_dir or absolute)."),
      kind: z.enum(KIND_VALUES).describe("Decoder kind: sprite (24x21 blocks), charset (8x8 glyphs), bitmap (320x200), charmap (screen-RAM bytes paired with a charset)."),
      offset: z.string().optional().describe("Byte offset into the file in hex (e.g. \"0042\"). Mutually exclusive with address."),
      address: z.string().optional().describe("C64 memory address in hex (e.g. \"0800\"). Resolved against the PRG load address."),
      length: z.string().describe("Hex byte length of the slice (e.g. \"0040\" for one sprite, \"0800\" for a 2 KB charset, \"1F40\" for a full hires bitmap)."),
      multicolor: z.boolean().optional().describe("Use C64 multicolor (4-colour 2-bit pairs) for sprite/charset/bitmap kinds."),
      palette: z.enum(["pepto", "vice", "colodore"]).optional().describe("C64 palette to use. Default: pepto."),
      fg: z.number().int().min(0).max(15).optional().describe("Foreground colour index (default 1 = white)."),
      bg: z.number().int().min(0).max(15).optional().describe("Background colour index (default 0 = black)."),
      c1: z.number().int().min(0).max(15).optional().describe("Multicolour pair colour 1 (default 11 = dark grey)."),
      c2: z.number().int().min(0).max(15).optional().describe("Multicolour pair colour 2 (default 12 = mid grey)."),
      columns: z.number().int().positive().optional().describe("Layout columns: sprites default 8, charsets default 32, charmaps default 40."),
      charset_path: z.string().optional().describe("Path to the charset binary used by kind=charmap (default: same as input_path)."),
      charset_offset: z.string().optional().describe("Hex byte offset of the charset slice (kind=charmap)."),
      charset_address: z.string().optional().describe("Hex C64 address of the charset (kind=charmap, resolved via PRG header)."),
      charset_length: z.string().optional().describe("Hex byte length of the charset slice (kind=charmap, default 0800 = 2 KB)."),
      output_path: z.string().optional().describe("Output PNG path (relative to project_dir or absolute). Defaults under session/graphics-previews/."),
    },
    async ({
      project_dir,
      input_path,
      kind,
      offset,
      address,
      length,
      multicolor,
      palette,
      fg,
      bg,
      c1,
      c2,
      columns,
      charset_path,
      charset_offset,
      charset_address,
      charset_length,
      output_path,
    }) => {
      try {
        const pd = context.projectDir(project_dir ?? input_path, true);
        const inputAbs = resolve(pd, input_path);
        if (!offset && !address) {
          throw new Error("Provide either offset or address.");
        }
        if (offset && address) {
          throw new Error("Provide only one of offset or address.");
        }
        const offsetMode: "file" | "address" = offset ? "file" : "address";
        const offsetValue = parseAddress(offset ?? address!);
        const lengthBytes = parseAddress(length);
        if (lengthBytes <= 0) {
          throw new Error("length must be greater than zero.");
        }

        const bytes = resolveByteWindow(inputAbs, offsetMode, offsetValue, lengthBytes);

        let charsetBytes: Uint8Array | undefined;
        if (kind === "charmap") {
          const charsetAbs = charset_path ? resolve(pd, charset_path) : inputAbs;
          if (!charset_offset && !charset_address) {
            throw new Error("kind=charmap requires charset_offset or charset_address.");
          }
          if (charset_offset && charset_address) {
            throw new Error("Provide only one of charset_offset or charset_address.");
          }
          const cMode: "file" | "address" = charset_offset ? "file" : "address";
          const cValue = parseAddress(charset_offset ?? charset_address!);
          const cLength = charset_length ? parseAddress(charset_length) : 0x0800;
          charsetBytes = resolveByteWindow(charsetAbs, cMode, cValue, cLength);
        }

        const decoded = decode(kind, {
          bytes,
          charsetBytes,
          multicolor: multicolor ?? false,
          palette: palette ?? "pepto",
          fg: fg ?? 1,
          bg: bg ?? 0,
          c1: c1 ?? 11,
          c2: c2 ?? 12,
          columns,
        });

        const png = encodePng(decoded.pixels, decoded.width, decoded.height);

        const stem = basename(inputAbs).replace(/\.[^.]+$/, "");
        const tag = offsetMode === "address" ? `addr-${offsetValue.toString(16).toUpperCase().padStart(4, "0")}` : `off-${offsetValue.toString(16).toUpperCase().padStart(4, "0")}`;
        const variant = `${kind}${multicolor ? "-mc" : ""}-${palette ?? "pepto"}`;
        const defaultOut = join(pd, "session", "graphics-previews", `${stem}_${tag}_${variant}_${lengthBytes.toString(16).toUpperCase().padStart(4, "0")}.png`);
        const outAbs = output_path ? resolve(pd, output_path) : defaultOut;
        mkdirSync(dirname(outAbs), { recursive: true });
        writeFileSync(outAbs, png);

        const lines = [
          `Rendered ${kind}${multicolor ? " (multicolor)" : ""} preview.`,
          `Input: ${inputAbs}`,
          `Slice: ${offsetMode}=${offsetMode === "address" ? "$" : ""}${offsetValue.toString(16).toUpperCase()} length=$${lengthBytes.toString(16).toUpperCase()} (${lengthBytes} bytes${bytes.length !== lengthBytes ? `, truncated to ${bytes.length} bytes at EOF` : ""})`,
          `Palette: ${palette ?? "pepto"} fg=${fg ?? 1} bg=${bg ?? 0}${multicolor ? ` c1=${c1 ?? 11} c2=${c2 ?? 12}` : ""}`,
          `Image: ${decoded.width}x${decoded.height}`,
          `PNG: ${outAbs}`,
          "",
          "Open the PNG (or pass it to a multimodal LLM) and decide whether the slice contains graphics or random bytes; iterate with different offsets/kinds/multicolor settings as needed.",
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  server.tool(
    "scan_graphics_candidates",
    "Render a sweep of PNG previews across an address window — every `step` bytes, multiple kinds (sprite/charset, hires + multicolor) — so a multimodal LLM can scrub the dump visually and pick the slices that hold real graphics. Saves a small PNG per probe under <project>/session/graphics-scan/<run-id>/ and returns the manifest as JSON-like text.",
    {
      project_dir: z.string().optional().describe("Project root. When omitted, resolved from input_path."),
      input_path: z.string().describe("Path to the PRG / binary file."),
      start_address: z.string().describe("Hex C64 start address for the sweep, e.g. \"0800\"."),
      end_address: z.string().describe("Hex C64 end address (inclusive), e.g. \"4000\"."),
      step: z.string().optional().describe("Hex byte stride between probes (default 0040 = one sprite, also a multiple of 8 charset glyphs)."),
      window: z.string().optional().describe("Hex byte length per preview (default 0100 = 4 sprites or 32 glyphs)."),
      kinds: z.array(z.enum(["sprite", "charset"])).optional().describe("Which decoders to render at each probe. Default: [sprite, charset]."),
      include_multicolor: z.boolean().optional().describe("Also render multicolor variants alongside hires. Default: true."),
      palette: z.enum(["pepto", "vice", "colodore"]).optional().describe("C64 palette. Default: pepto."),
      run_id: z.string().optional().describe("Optional identifier to namespace the output directory; defaults to a timestamp."),
    },
    async ({
      project_dir,
      input_path,
      start_address,
      end_address,
      step,
      window,
      kinds,
      include_multicolor,
      palette,
      run_id,
    }) => {
      try {
        const pd = context.projectDir(project_dir ?? input_path, true);
        const inputAbs = resolve(pd, input_path);
        const startAddr = parseAddress(start_address);
        const endAddr = parseAddress(end_address);
        if (endAddr <= startAddr) {
          throw new Error("end_address must be greater than start_address.");
        }
        const stride = step ? parseAddress(step) : 0x0040;
        const windowBytes = window ? parseAddress(window) : 0x0100;
        const probeKinds = (kinds && kinds.length > 0 ? kinds : ["sprite", "charset"]) as RenderKind[];
        const includeMc = include_multicolor ?? true;
        const palName: PaletteName = (palette ?? "pepto") as PaletteName;
        const runStamp = run_id ?? new Date().toISOString().replace(/[:.]/g, "-");
        const outDir = join(pd, "session", "graphics-scan", runStamp);
        mkdirSync(outDir, { recursive: true });

        const buffer = readFileSync(inputAbs);
        const loadAddress = readPrgLoadAddress(inputAbs);
        const manifest: Array<{
          address: string;
          fileOffset: number;
          length: number;
          kind: RenderKind;
          multicolor: boolean;
          png: string;
        }> = [];

        let renderCount = 0;
        const MAX_RENDERS = 256; // keep the scan from exploding the disk
        for (let addr = startAddr; addr <= endAddr; addr += stride) {
          const fileOffset = (addr - loadAddress) + 2;
          if (fileOffset < 0 || fileOffset >= buffer.length) continue;
          const slice = new Uint8Array(buffer.subarray(fileOffset, Math.min(buffer.length, fileOffset + windowBytes)));
          if (slice.length === 0) continue;

          const variants: Array<{ kind: RenderKind; multicolor: boolean }> = [];
          for (const kind of probeKinds) {
            variants.push({ kind, multicolor: false });
            if (includeMc) variants.push({ kind, multicolor: true });
          }

          for (const variant of variants) {
            if (renderCount >= MAX_RENDERS) break;
            try {
              const decoded = decode(variant.kind, {
                bytes: slice,
                multicolor: variant.multicolor,
                palette: palName,
                fg: 1,
                bg: 0,
                c1: 11,
                c2: 12,
              });
              const png = encodePng(decoded.pixels, decoded.width, decoded.height);
              const name = `addr-${addr.toString(16).toUpperCase().padStart(4, "0")}_${variant.kind}${variant.multicolor ? "-mc" : ""}.png`;
              const pngPath = join(outDir, name);
              writeFileSync(pngPath, png);
              manifest.push({
                address: `$${addr.toString(16).toUpperCase().padStart(4, "0")}`,
                fileOffset,
                length: slice.length,
                kind: variant.kind,
                multicolor: variant.multicolor,
                png: pngPath,
              });
              renderCount += 1;
            } catch {
              // skip variants that the decoder rejects (e.g. bitmap on a too-small slice)
            }
          }
          if (renderCount >= MAX_RENDERS) break;
        }

        const manifestPath = join(outDir, "manifest.json");
        writeFileSync(manifestPath, JSON.stringify({
          input: inputAbs,
          loadAddress,
          startAddress: startAddr,
          endAddress: endAddr,
          stride,
          window: windowBytes,
          palette: palName,
          renders: manifest,
        }, null, 2));

        const summary = manifest.slice(0, 8).map((entry) => `  ${entry.address} ${entry.kind}${entry.multicolor ? "-mc" : ""} → ${entry.png}`);
        const lines = [
          `Graphics scan complete: ${manifest.length} preview PNGs.`,
          `Run dir: ${outDir}`,
          `Manifest: ${manifestPath}`,
          "",
          "First entries:",
          ...summary,
          manifest.length > 8 ? `  …and ${manifest.length - 8} more (see manifest).` : "",
          "",
          "Hand the manifest (or directly the PNG paths) to a multimodal LLM and ask which slices contain real graphics. Persist confirmed candidates via save_finding / save_artifact and the corresponding annotation.",
        ];
        return { content: [{ type: "text" as const, text: lines.filter((line) => line !== "").join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );
}
