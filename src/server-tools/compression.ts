import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ByteBoozerDepacker,
  depackExomizerSfx,
  depackExomizerRaw,
  packByteBoozer,
  packExomizerRaw,
  packExomizerSharedEncoding,
  packExomizerSfx,
  readBinaryFile,
  RleDepacker,
  RlePacker,
  suggestDepackers,
  writeBinaryFile,
} from "../compression-tools.js";
import {
  packClipped,
  packStandardPrg,
} from "../byteboozer-cruncher.js";
import { lykiaEncode } from "../byteboozer-lykia-encoder.js";
import { lykiaDecompress } from "../byteboozer-lykia-decoder.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

interface SharedEncodingManifestCandidate {
  runIndex: number;
  source: string;
  sampleCount: number;
  encodingBytes: number;
  totalPayloadBytes: number;
  totalBytes: number;
}

interface SharedEncodingManifestRecord {
  totalOriginalBytes: number;
  totalPayloadBytes: number;
  totalBytes: number;
  packedFiles?: Array<unknown>;
  chosenCandidate: SharedEncodingManifestCandidate;
}

interface SharedEncodingManifestSetSummary {
  label: string;
  manifestPaths: string[];
  manifestCount: number;
  fileCount: number;
  totalOriginalBytes: number;
  totalPayloadBytes: number;
  totalBytes: number;
  totalEncodingBytes: number;
  chosenCandidates: SharedEncodingManifestCandidate[];
}

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

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function readSharedEncodingManifest(context: ServerToolContext, manifestPath: string): SharedEncodingManifestRecord {
  const raw = JSON.parse(context.readTextFile(manifestPath));
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { totalOriginalBytes?: unknown }).totalOriginalBytes !== "number" ||
    typeof (raw as { totalPayloadBytes?: unknown }).totalPayloadBytes !== "number" ||
    typeof (raw as { totalBytes?: unknown }).totalBytes !== "number" ||
    typeof (raw as { chosenCandidate?: unknown }).chosenCandidate !== "object" ||
    (raw as { chosenCandidate?: unknown }).chosenCandidate === null
  ) {
    throw new Error(`Invalid shared-encoding manifest: ${manifestPath}`);
  }
  const candidate = (raw as { chosenCandidate: Record<string, unknown> }).chosenCandidate;
  if (
    typeof candidate.runIndex !== "number" ||
    typeof candidate.source !== "string" ||
    typeof candidate.sampleCount !== "number" ||
    typeof candidate.encodingBytes !== "number" ||
    typeof candidate.totalPayloadBytes !== "number" ||
    typeof candidate.totalBytes !== "number"
  ) {
    throw new Error(`Manifest chosenCandidate is incomplete: ${manifestPath}`);
  }
  return raw as SharedEncodingManifestRecord;
}

function summarizeSharedEncodingManifestSet(
  context: ServerToolContext,
  projectRoot: string,
  label: string,
  manifestPaths: string[],
): SharedEncodingManifestSetSummary {
  const resolvedPaths = manifestPaths.map((manifestPath) => resolve(projectRoot, manifestPath));
  const manifests = resolvedPaths.map((manifestPath) => readSharedEncodingManifest(context, manifestPath));
  return {
    label,
    manifestPaths: resolvedPaths,
    manifestCount: manifests.length,
    fileCount: manifests.reduce((sum, manifest) => sum + (manifest.packedFiles?.length ?? 0), 0),
    totalOriginalBytes: manifests.reduce((sum, manifest) => sum + manifest.totalOriginalBytes, 0),
    totalPayloadBytes: manifests.reduce((sum, manifest) => sum + manifest.totalPayloadBytes, 0),
    totalBytes: manifests.reduce((sum, manifest) => sum + manifest.totalBytes, 0),
    totalEncodingBytes: manifests.reduce((sum, manifest) => sum + manifest.chosenCandidate.encodingBytes, 0),
    chosenCandidates: manifests.map((manifest) => manifest.chosenCandidate),
  };
}

export function registerCompressionTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "pack_rle",
    "Compress a binary blob with the built-in C64 RLE format used by Mike's loader.",
    {
      input_path: z.string().describe("Path to the input file to compress"),
      output_path: z.string().optional().describe("Optional output path for the packed data"),
      include_header: z.boolean().optional().describe("Whether to prepend a 2-byte load address header"),
      write_address: z.string().optional().describe("Optional load address for the header, e.g. 8000"),
      optimal: z.boolean().optional().describe("Use optimal parsing instead of greedy packing (default: true)"),
    },
    safeHandler("pack_rle", async ({ input_path, output_path, include_header, write_address, optimal }) => {
      try {
        const pd = context.projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path ? resolve(pd, output_path) : `${inputAbs}.rle`;
        const data = await readBinaryFile(inputAbs);
        const packer = new RlePacker({
          includeHeader: include_header ?? false,
          writeAddress: write_address ? parseHexWord(write_address) : undefined,
          optimal: optimal ?? true,
        });
        const result = packer.pack(data);
        await writeBinaryFile(outputAbs, result.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              "RLE pack complete.",
              `Input: ${inputAbs}`,
              `Output: ${outputAbs}`,
              `Original size: ${result.originalSize}`,
              `Compressed size: ${result.compressedSize}`,
              `Ratio: ${result.ratio.toFixed(4)}`,
              `RLE runs: ${result.runCount}`,
              `Copy segments: ${result.copyCount}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "depack_rle",
    "Decompress the built-in C64 RLE format used by Mike's loader.",
    {
      input_path: z.string().describe("Path to the packed RLE file"),
      output_path: z.string().optional().describe("Optional output path for the unpacked data"),
      has_header: z.boolean().optional().describe("Treat the first two bytes as a load address header"),
      max_size: z.number().int().positive().optional().describe("Optional hard output-size ceiling"),
    },
    safeHandler("depack_rle", async ({ input_path, output_path, has_header, max_size }) => {
      try {
        const pd = context.projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path ? resolve(pd, output_path) : `${inputAbs}.unpacked.bin`;
        const data = await readBinaryFile(inputAbs);
        const depacker = new RleDepacker();
        const result = depacker.unpack(data, {
          hasHeader: has_header ?? false,
          maxSize: max_size,
        });
        await writeBinaryFile(outputAbs, result.data);
        const lines = [
          "RLE depack complete.",
          `Input: ${inputAbs}`,
          `Output: ${outputAbs}`,
          `Unpacked bytes: ${result.byteCount}`,
          `RLE runs: ${result.runCount}`,
          `Copy segments: ${result.copyCount}`,
        ];
        if (result.headerAddress !== undefined) {
          lines.push(`Load header: ${formatHexWord(result.headerAddress)}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "pack_exomizer_raw",
    "Compress a file with the built-in TypeScript Exomizer raw implementation.",
    {
      input_path: z.string().describe("Path to the input file"),
      output_path: z.string().optional().describe("Optional output path for the packed file"),
      backwards: z.boolean().optional().describe("Use Exomizer backward mode (-b)"),
      reverse_output: z.boolean().optional().describe("Write the outfile in reverse order (-r)"),
      no_encoding_header: z.boolean().optional().describe("Do not write the Exomizer encoding header (-E)"),
    },
    safeHandler("pack_exomizer_raw", async ({ input_path, output_path, backwards, reverse_output, no_encoding_header }) => {
      try {
        const pd = context.projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path ? resolve(pd, output_path) : `${inputAbs}.exo`;
        const result = await packExomizerRaw({
          inputPath: inputAbs,
          backwards,
          reverseOutput: reverse_output,
          noEncodingHeader: no_encoding_header,
        });
        await writeBinaryFile(outputAbs, result.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              "Exomizer raw pack complete.",
              `Input: ${inputAbs}`,
              `Output: ${outputAbs}`,
              `Original size: ${result.originalSize}`,
              `Compressed size: ${result.compressedSize}`,
              `Ratio: ${result.ratio.toFixed(4)}`,
              result.encoding ? `Encoding: ${result.encoding}` : "",
            ].filter(Boolean).join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "depack_exomizer_raw",
    "Decompress an Exomizer raw stream via the built-in TypeScript implementation.",
    {
      input_path: z.string().describe("Path to the Exomizer-packed file"),
      output_path: z.string().optional().describe("Optional output path for the unpacked file"),
      backwards: z.boolean().optional().describe("Use Exomizer backward mode (-b)"),
      reverse_output: z.boolean().optional().describe("Write the outfile in reverse order (-r)"),
    },
    safeHandler("depack_exomizer_raw", async ({ input_path, output_path, backwards, reverse_output }) => {
      try {
        const pd = context.projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path ? resolve(pd, output_path) : `${inputAbs}.unpacked.bin`;
        const result = await depackExomizerRaw({
          inputPath: inputAbs,
          backwards,
          reverseOutput: reverse_output,
        });
        await writeBinaryFile(outputAbs, result.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              "Exomizer raw depack complete.",
              `Input: ${inputAbs}`,
              `Output: ${outputAbs}`,
              `Unpacked bytes: ${result.byteCount}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "depack_exomizer_sfx",
    "Decompress an Exomizer self-extracting wrapper via the built-in TypeScript 6502-emulated depacker.",
    {
      input_path: z.string().describe("Path to the Exomizer SFX file"),
      output_path: z.string().optional().describe("Optional output path for the unpacked PRG"),
      entry_address: z.string().optional().describe("Optional entry override for desfx, e.g. 080D or 'load'"),
    },
    safeHandler("depack_exomizer_sfx", async ({ input_path, output_path, entry_address }) => {
      try {
        const pd = context.projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path ? resolve(pd, output_path) : `${inputAbs}.desfx.prg`;
        const result = await depackExomizerSfx({
          inputPath: inputAbs,
          entryAddress: entry_address ? (entry_address.toLowerCase() === "load" ? "load" : parseHexWord(entry_address)) : undefined,
        });
        await writeBinaryFile(outputAbs, result.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              "Exomizer SFX depack complete.",
              `Input: ${inputAbs}`,
              `Output: ${outputAbs}`,
              `Load address: ${formatHexWord(result.outputStart)}`,
              `End address: ${formatHexWord((result.outputEnd - 1) & 0xffff)}`,
              `Entry after decrunch: ${formatHexWord(result.entryPoint)}`,
              `Cycles: ${result.cycles}`,
              `PRG bytes: ${result.data.length}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "pack_exomizer_sfx",
    "Compress one or more input files into an Exomizer self-extracting binary via the local exomizer CLI.",
    {
      target: z.string().describe("Exomizer sfx target operand, e.g. 'sys', 'systrim,080d', 'basic', 'bin', or '$080d'"),
      input_specs: z.array(z.string()).min(1).describe("One or more Exomizer input specs in CLI form: 'file.prg' or 'file.bin,0x2000'"),
      output_path: z.string().optional().describe("Optional output path for the generated SFX binary"),
      extra_args: z.array(z.string()).optional().describe("Optional extra Exomizer CLI flags, e.g. ['-q', '-t52']"),
    },
    safeHandler("pack_exomizer_sfx", async ({ target, input_specs, output_path, extra_args }) => {
      try {
        const pd = context.projectDir(output_path ?? input_specs[0], true);
        const outputAbs = output_path
          ? resolve(pd, output_path)
          : `${resolve(pd, input_specs[0].split(",")[0] ?? input_specs[0])}.sfx.prg`;
        const result = await packExomizerSfx({
          projectDir: pd,
          target,
          inputSpecs: input_specs,
          outputPath: outputAbs,
          extraArgs: extra_args,
        });
        if (result.exitCode !== 0) {
          return context.cliResultToContent(result);
        }
        const outputBytes = (await readBinaryFile(result.outputPath)).length;
        return {
          content: [{
            type: "text" as const,
            text: [
              "Exomizer SFX pack complete.",
              `Target: ${target}`,
              `Inputs: ${input_specs.join(" | ")}`,
              `Output: ${result.outputPath}`,
              `Output bytes: ${outputBytes}`,
              `Command: ${result.command} ${result.args.join(" ")}`,
              result.stdout.trim() ? `\n[stdout]\n${result.stdout.trim()}` : "",
              result.stderr.trim() ? `\n[stderr]\n${result.stderr.trim()}` : "",
            ].filter(Boolean).join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "pack_exomizer_shared_encoding",
    "Discover or reuse a shared Exomizer encoding table in pure TypeScript, then pack many files without embedding the table in each payload.",
    {
      input_paths: z.array(z.string()).min(1).describe("Input files to evaluate and pack with one shared encoding"),
      output_dir: z.string().optional().describe("Optional output directory for packed payloads, encoding files, and manifest"),
      discover_runs: z.number().int().positive().optional().describe("How many candidate discovery runs to evaluate (default: 1)"),
      sample_size: z.number().int().positive().optional().describe("How many files to sample in non-global discovery runs (default: up to 32)"),
      seed: z.number().int().optional().describe("Optional seed for random sampling in discovery runs"),
      imported_encoding: z.string().optional().describe("Optional existing encoding string or @file to reuse instead of discovering a new one"),
      max_passes: z.number().int().positive().optional().describe("Optimization passes used while discovering candidate encodings (default: 100)"),
      favor_speed: z.boolean().optional().describe("Favor compression speed over ratio while deriving candidate encodings"),
      backwards: z.boolean().optional().describe("Use Exomizer backward mode while packing payloads"),
      reverse_output: z.boolean().optional().describe("Reverse packed payload byte order after packing"),
      packed_suffix: z.string().optional().describe("Suffix appended to each packed payload (default: .exo)"),
    },
    safeHandler("pack_exomizer_shared_encoding", async ({ input_paths, output_dir, discover_runs, sample_size, seed, imported_encoding, max_passes, favor_speed, backwards, reverse_output, packed_suffix }) => {
      try {
        const pd = context.projectDir(output_dir ?? input_paths[0], true);
        const outputAbs = output_dir ? resolve(pd, output_dir) : join(pd, "analysis", "compression", "shared-encoding");
        const result = await packExomizerSharedEncoding({
          projectDir: pd,
          inputPaths: input_paths,
          outputDir: outputAbs,
          discoverRuns: discover_runs,
          sampleSize: sample_size,
          seed,
          importedEncoding: imported_encoding,
          maxPasses: max_passes,
          favorSpeed: favor_speed,
          backwards,
          reverseOutput: reverse_output,
          packedSuffix: packed_suffix,
        });
        return {
          content: [{
            type: "text" as const,
            text: [
              "Exomizer shared-encoding pack complete.",
              `Inputs: ${input_paths.length}`,
              `Output dir: ${result.outputDir}`,
              `Encoding text: ${result.encodingTextPath}`,
              `Encoding binary: ${result.encodingBinaryPath}`,
              `Manifest: ${result.manifestPath}`,
              `Chosen candidate: run ${result.chosenCandidate.runIndex} (${result.chosenCandidate.source})`,
              `Encoding bytes: ${result.chosenCandidate.encodingBytes}`,
              `Payload bytes: ${result.totalPayloadBytes}`,
              `Total bytes: ${result.totalBytes}`,
              `Original bytes: ${result.totalOriginalBytes}`,
              `Top candidates: ${result.candidates.slice(0, 3).map((candidate) => `run ${candidate.runIndex} ${candidate.source} total=${candidate.totalBytes}`).join(" | ")}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "pack_byteboozer",
    "Compress a file with ByteBoozer2 via the local b2 CLI.",
    {
      input_path: z.string().describe("Path to the input file"),
      output_path: z.string().optional().describe("Optional output path for the packed file"),
      executable_start: z.string().optional().describe("Optional execution start address passed as -c xxxx"),
      relocate_to: z.string().optional().describe("Optional relocation address passed as -r xxxx"),
      clip_start_address: z.boolean().optional().describe("Clip the start address in the output file (-b)"),
    },
    safeHandler("pack_byteboozer", async ({ input_path, output_path, executable_start, relocate_to, clip_start_address }) => {
      try {
        if (executable_start && relocate_to) {
          throw new Error("Provide either executable_start or relocate_to, not both.");
        }
        const pd = context.projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path ? resolve(pd, output_path) : `${inputAbs}.b2`;
        const result = await packByteBoozer({
          projectDir: pd,
          inputPath: inputAbs,
          outputPath: outputAbs,
          executableStart: executable_start ? parseHexWord(executable_start) : undefined,
          relocateTo: relocate_to ? parseHexWord(relocate_to) : undefined,
          clipStartAddress: clip_start_address,
        });
        if (result.exitCode !== 0) {
          return context.cliResultToContent(result);
        }
        return {
          content: [{
            type: "text" as const,
            text: [
              "ByteBoozer2 pack complete.",
              `Input: ${inputAbs}`,
              `Output: ${result.outputPath}`,
              `Command: ${result.command} ${result.args.join(" ")}`,
              result.stdout.trim() ? `\n[stdout]\n${result.stdout.trim()}` : "",
              result.stderr.trim() ? `\n[stderr]\n${result.stderr.trim()}` : "",
            ].filter(Boolean).join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "pack_byteboozer_native",
    "Compress a file with the native TypeScript ByteBoozer tooling. Supports the reference ByteBoozer2 standard PRG and clipped (-b) formats, plus Lykia's cart-specific modified-BB2 stream format with explicit end_addr.",
    {
      input_path: z.string().describe("Path to the input file. If PRG (2-byte load address header), those bytes are used as the decode destination unless dest_address is supplied explicitly."),
      output_path: z.string().optional().describe("Optional output path. Default: <input_path>.b2"),
      preset: z.enum(["standard", "clipped", "lykia"]).default("standard").describe("standard = b2 (4-byte header [load,dest]); clipped = b2 -b (2-byte header [dest]); lykia = Lykia $020C format (4-byte header [dest,end])"),
      dest_address: z.string().optional().describe("Override decode destination address (hex). Defaults to the PRG load address from input bytes 0-1."),
      relocate_to: z.string().optional().describe("Relocation target for the decrunch-in-place start address (hex). Only applies to standard preset."),
      strip_prg_header: z.boolean().optional().describe("Treat the input file as RAW payload (no PRG load-address header). You must supply dest_address in this case."),
    },
    safeHandler("pack_byteboozer_native", async ({ input_path, output_path, preset, dest_address, relocate_to, strip_prg_header }) => {
      try {
        const pd = context.projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path ? resolve(pd, output_path) : `${inputAbs}.b2`;

        const raw = await readBinaryFile(inputAbs);

        let loadAddr: number | undefined;
        let payload: Uint8Array;
        if (strip_prg_header) {
          if (!dest_address) {
            throw new Error("strip_prg_header requires dest_address to be supplied.");
          }
          payload = raw;
        } else {
          if (raw.length < 2) {
            throw new Error("Input file is shorter than the 2-byte PRG load-address header.");
          }
          loadAddr = raw[0]! | (raw[1]! << 8);
          payload = raw.slice(2);
        }

        const dest = dest_address
          ? parseHexWord(dest_address)
          : loadAddr ?? (() => { throw new Error("No destination: supply dest_address or a PRG input."); })();
        const reloc = relocate_to ? parseHexWord(relocate_to) : undefined;

        let packed: {
          output: Uint8Array;
          result: {
            destAddress: number;
            inputSize: number;
            margin?: number;
            literalRuns?: number;
            matches?: number;
          };
        };
        if (preset === "standard") {
          packed = packStandardPrg(payload, dest, reloc);
        } else if (preset === "clipped") {
          packed = packClipped(payload, dest);
        } else {
          const encoded = lykiaEncode(payload, dest);
          packed = {
            output: encoded.stream,
            result: {
              destAddress: dest,
              inputSize: encoded.stats.totalInputBytes,
              literalRuns: encoded.stats.literalRuns,
              matches: encoded.stats.matches,
            },
          };
        }

        await writeBinaryFile(outputAbs, packed.output);

        const detailLines = [
          `Destination address: $${packed.result.destAddress.toString(16).toUpperCase().padStart(4, "0")}`,
          `Input payload size:  ${packed.result.inputSize}`,
        ];
        if (packed.result.margin !== undefined) {
          detailLines.push(`Margin:              ${packed.result.margin}`);
        }
        if (packed.result.literalRuns !== undefined || packed.result.matches !== undefined) {
          detailLines.push(`Literal runs:        ${packed.result.literalRuns ?? 0}`);
          detailLines.push(`Matches:             ${packed.result.matches ?? 0}`);
        }

        return {
          content: [{
            type: "text" as const,
            text: [
              `ByteBoozer2 native pack complete (preset=${preset}).`,
              `Input:  ${inputAbs}  (${raw.length} bytes)`,
              `Output: ${outputAbs} (${packed.output.length} bytes)`,
              ...detailLines,
              `Compression ratio:   ${packed.result.inputSize > 0 ? (packed.result.inputSize / packed.output.length).toFixed(2) : "n/a"}×`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "compare_exomizer_shared_encoding_sets",
    "Compare one or more shared-encoding manifest sets, e.g. global vs 2-cluster vs 4-cluster, by total bytes, payload bytes, and encoding overhead.",
    {
      comparison_sets: z.array(z.object({
        label: z.string().describe("Short label for this strategy, e.g. global, 2-cluster, 4-cluster"),
        manifest_paths: z.array(z.string()).min(1).describe("One or more manifest.json files belonging to this strategy"),
      })).min(2).describe("Two or more manifest sets to compare"),
    },
    safeHandler("compare_exomizer_shared_encoding_sets", async ({ comparison_sets }) => {
      try {
        const hintPath = comparison_sets[0]?.manifest_paths[0];
        const pd = context.projectDir(hintPath, true);
        const summaries = comparison_sets.map((set) => summarizeSharedEncodingManifestSet(context, pd, set.label, set.manifest_paths));
        const best = [...summaries].sort((left, right) => left.totalBytes - right.totalBytes)[0];
        if (!best) {
          throw new Error("No manifest sets could be compared.");
        }
        const originalTotals = new Set(summaries.map((summary) => summary.totalOriginalBytes));
        return {
          content: [{
            type: "text" as const,
            text: [
              "Exomizer shared-encoding comparison complete.",
              `Best set: ${best.label} (${best.totalBytes} bytes total)`,
              originalTotals.size === 1
                ? `Comparable original bytes: ${best.totalOriginalBytes}`
                : `Warning: original byte totals differ across sets: ${Array.from(originalTotals).join(", ")}`,
              "",
              "Sets:",
              ...summaries
                .sort((left, right) => left.totalBytes - right.totalBytes)
                .map((summary) => {
                  const savingsPercent = summary.totalOriginalBytes > 0
                    ? ((summary.totalOriginalBytes - summary.totalBytes) / summary.totalOriginalBytes) * 100
                    : 0;
                  const payloadSharePercent = summary.totalBytes > 0
                    ? (summary.totalPayloadBytes / summary.totalBytes) * 100
                    : 0;
                  const deltaToBest = summary.totalBytes - best.totalBytes;
                  return [
                    `- ${summary.label}: manifests=${summary.manifestCount}, files=${summary.fileCount}, total=${summary.totalBytes}, payload=${summary.totalPayloadBytes}, encoding=${summary.totalEncodingBytes}, savings=${formatPercent(savingsPercent)}, payload_share=${formatPercent(payloadSharePercent)}, delta_to_best=${deltaToBest >= 0 ? "+" : ""}${deltaToBest}`,
                    `  Candidates: ${summary.chosenCandidates.map((candidate, index) => `#${index + 1} run ${candidate.runIndex} ${candidate.source} total=${candidate.totalBytes}`).join(" | ")}`,
                  ].join("\n");
                }),
            ].join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "depack_byteboozer",
    "Decompress a ByteBoozer2 raw .b2 file or executable wrapper in pure TypeScript.",
    {
      input_path: z.string().describe("Path to the ByteBoozer2-packed file"),
      output_path: z.string().optional().describe("Optional output path for the unpacked data"),
      offset: z.string().optional().describe("Optional hex file offset to start from"),
      length: z.string().optional().describe("Optional hex byte length to limit the input slice"),
    },
    safeHandler("depack_byteboozer", async ({ input_path, output_path, offset, length }) => {
      try {
        const pd = context.projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const raw = await readBinaryFile(inputAbs);
        const start = offset ? parseHexWord(offset) : 0;
        const end = length ? Math.min(raw.length, start + parseHexWord(length)) : raw.length;
        const slice = raw.slice(start, end);
        const outputAbs = output_path ? resolve(pd, output_path) : `${inputAbs}.byteboozer.unpacked.bin`;
        const result = new ByteBoozerDepacker().unpack(slice);
        await writeBinaryFile(outputAbs, result.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              "ByteBoozer2 depack complete.",
              `Input: ${inputAbs}`,
              `Slice: $${start.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`,
              `Output: ${outputAbs}`,
              `Mode: ${result.mode}`,
              `Output address: ${formatHexWord(result.outputAddress)}`,
              result.sourceLoadAddress !== undefined ? `Source load address: ${formatHexWord(result.sourceLoadAddress)}` : "",
              `Unpacked bytes: ${result.byteCount}`,
              `Consumed bytes: ${result.inputConsumed}`,
            ].filter(Boolean).join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "depack_byteboozer_lykia",
    "Decompress a Lykia-variant ByteBoozer2 stream (modified 4-byte header: dest_lo, dest_hi, end_lo, end_hi; BB2_BITBUF seeded from supplied dest_hi). Pure TypeScript port of the $020C in-game depacker.",
    {
      input_path: z.string().describe("Path to the Lykia BB2 stream file"),
      output_path: z.string().optional().describe("Optional output path for the unpacked data"),
      offset: z.string().optional().describe("Optional hex file offset to start from"),
      length: z.string().optional().describe("Optional hex byte length to limit the input slice"),
      dest_hi: z.string().optional().describe("Optional BITBUF seed (hex byte). Defaults to stream byte 1 (the header dest_hi)."),
    },
    safeHandler("depack_byteboozer_lykia", async ({ input_path, output_path, offset, length, dest_hi }) => {
      try {
        const pd = context.projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const raw = await readBinaryFile(inputAbs);
        const start = offset ? parseHexWord(offset) : 0;
        const end = length ? Math.min(raw.length, start + parseHexWord(length)) : raw.length;
        const slice = raw.slice(start, end);
        const seed = dest_hi !== undefined ? parseHexWord(dest_hi) & 0xFF : (slice[1] ?? 0);
        const outputAbs = output_path ? resolve(pd, output_path) : `${inputAbs}.bb2lykia.unpacked.bin`;
        const result = lykiaDecompress(slice, seed);
        await writeBinaryFile(outputAbs, result.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              "Lykia ByteBoozer2 depack complete.",
              `Input: ${inputAbs}`,
              `Slice: $${start.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`,
              `Output: ${outputAbs}`,
              `Seed (bitbuf / dest_hi): $${seed.toString(16).padStart(2, "0").toUpperCase()}`,
              `Dest address: ${formatHexWord(result.destAddress)}`,
              `End address: ${formatHexWord(result.endAddress)}`,
              `Final ptr: ${formatHexWord(result.finalPtr)}`,
              `Unpacked bytes: ${result.data.length}`,
              `Stream bytes read: ${result.bytesRead}`,
              `Termination: ${result.termination}`,
            ].filter(Boolean).join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "suggest_depacker",
    "Probe a file or a sliced subrange and suggest likely depackers such as RLE, Exomizer raw, or ByteBoozer-like wrappers.",
    {
      input_path: z.string().describe("Path to the input file to probe"),
      offset: z.string().optional().describe("Optional hex offset into the file, e.g. 001A"),
      length: z.string().optional().describe("Optional hex length to limit the probe window"),
    },
    safeHandler("suggest_depacker", async ({ input_path, offset, length }) => {
      try {
        const pd = context.projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const suggestions = await suggestDepackers({
          projectDir: pd,
          inputPath: inputAbs,
          offset: offset ? parseHexWord(offset) : undefined,
          length: length ? parseHexWord(length) : undefined,
        });
        const lines = [
          `Depacker suggestions for ${inputAbs}:`,
          `Candidates: ${suggestions.length}`,
        ];
        for (const suggestion of suggestions) {
          lines.push("");
          lines.push(`${suggestion.format}  confidence=${suggestion.confidence.toFixed(2)}  window=$${suggestion.offset.toString(16).toUpperCase()}+$${suggestion.length.toString(16).toUpperCase()}`);
          lines.push(suggestion.reason);
          if (suggestion.unpackedSize !== undefined) {
            lines.push(`Unpacked size: ${suggestion.unpackedSize} bytes`);
          }
          for (const note of suggestion.notes ?? []) {
            lines.push(`- ${note}`);
          }
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "try_depack",
    "Try a specific depacker against a file or sliced subrange. Supports built-in RLE, Exomizer raw, and host-side ByteBoozer2 depack.",
    {
      input_path: z.string().describe("Path to the packed input file"),
      format: z.enum(["rle", "exomizer_raw", "exomizer_sfx", "byteboozer2"]).describe("Which depacker to try"),
      output_path: z.string().optional().describe("Optional output path for the unpacked data"),
      offset: z.string().optional().describe("Optional hex file offset to start from"),
      length: z.string().optional().describe("Optional hex byte length to limit the input slice"),
      has_rle_header: z.boolean().optional().describe("For RLE only: treat the first two bytes of the slice as a load header"),
      max_size: z.number().int().positive().optional().describe("For RLE only: hard ceiling for unpacked size"),
      backwards: z.boolean().optional().describe("For Exomizer raw only: use -b"),
      reverse_output: z.boolean().optional().describe("For Exomizer raw only: use -r"),
      entry_address: z.string().optional().describe("For Exomizer SFX only: optional desfx entry override, e.g. 080D or 'load'"),
    },
    safeHandler("try_depack", async ({ input_path, format, output_path, offset, length, has_rle_header, max_size, backwards, reverse_output, entry_address }) => {
      try {
        const pd = context.projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const raw = await readBinaryFile(inputAbs);
        const start = offset ? parseHexWord(offset) : 0;
        const end = length ? Math.min(raw.length, start + parseHexWord(length)) : raw.length;
        const slice = raw.slice(start, end);
        const outputAbs = output_path ? resolve(pd, output_path) : `${inputAbs}.${format}.unpacked.bin`;

        if (format === "rle") {
          const depacker = new RleDepacker();
          const result = depacker.unpack(slice, {
            hasHeader: has_rle_header ?? false,
            maxSize: max_size,
          });
          await writeBinaryFile(outputAbs, result.data);
          const lines = [
            "RLE depack complete.",
            `Input: ${inputAbs}`,
            `Slice: $${start.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`,
            `Output: ${outputAbs}`,
            `Unpacked bytes: ${result.byteCount}`,
            `Consumed bytes: ${result.consumedBytes}`,
            `Terminated: ${result.terminated ? "yes" : "no"}`,
          ];
          if (result.headerAddress !== undefined) {
            lines.push(`Load header: ${formatHexWord(result.headerAddress)}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        if (format === "byteboozer2") {
          const depacker = new ByteBoozerDepacker();
          const result = depacker.unpack(slice);
          await writeBinaryFile(outputAbs, result.data);
          return {
            content: [{
              type: "text" as const,
              text: [
                "ByteBoozer2 depack complete.",
                `Input: ${inputAbs}`,
                `Slice: $${start.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`,
                `Output: ${outputAbs}`,
                `Mode: ${result.mode}`,
                `Output address: ${formatHexWord(result.outputAddress)}`,
                result.sourceLoadAddress !== undefined ? `Source load address: ${formatHexWord(result.sourceLoadAddress)}` : "",
                `Unpacked bytes: ${result.byteCount}`,
                `Consumed bytes: ${result.inputConsumed}`,
              ].filter(Boolean).join("\n"),
            }],
          };
        }

        if (format === "exomizer_sfx") {
          const tempInput = `${outputAbs}.inputslice.prg`;
          await writeBinaryFile(tempInput, slice);
          const result = await depackExomizerSfx({
            inputPath: tempInput,
            entryAddress: entry_address ? (entry_address.toLowerCase() === "load" ? "load" : parseHexWord(entry_address)) : undefined,
          });
          await writeBinaryFile(outputAbs, result.data);
          return {
            content: [{
              type: "text" as const,
              text: [
                "Exomizer SFX depack complete.",
                `Input: ${inputAbs}`,
                `Slice: $${start.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`,
                `Output: ${outputAbs}`,
                `Load address: ${formatHexWord(result.outputStart)}`,
                `End address: ${formatHexWord((result.outputEnd - 1) & 0xffff)}`,
                `Entry after decrunch: ${formatHexWord(result.entryPoint)}`,
                `Cycles: ${result.cycles}`,
                `PRG bytes: ${result.data.length}`,
              ].join("\n"),
            }],
          };
        }

        const tempInput = `${outputAbs}.inputslice.bin`;
        await writeBinaryFile(tempInput, slice);
        const sliceResult = await depackExomizerRaw({
          inputPath: tempInput,
          backwards,
          reverseOutput: reverse_output,
        });
        await writeBinaryFile(outputAbs, sliceResult.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              "Exomizer raw depack complete.",
              `Input: ${inputAbs}`,
              `Slice: $${start.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`,
              `Output: ${outputAbs}`,
              `Unpacked bytes: ${sliceResult.byteCount}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
));

  server.tool(
    "record_file_packer",
    "Persist packer / format / notes metadata into a disk or cart manifest so the workspace UI can render a packer tag and offer a depack-aware hex view. Identify the file by its index, name, or relativePath. Use this after suggest_depacker / try_depack / depack tools confirm what the bytes are. To set a fallback for every file in the manifest pass scope=\"manifest-default\" instead of a file selector.",
    {
      manifest_path: z.string().describe("Path to the manifest.json (relative to project dir or absolute)."),
      file_index: z.number().int().nonnegative().optional().describe("Match files[].index. Mutually exclusive with file_name / file_relative_path."),
      file_name: z.string().optional().describe("Match files[].name."),
      file_relative_path: z.string().optional().describe("Match files[].relativePath."),
      scope: z.enum(["file", "manifest-default"]).optional().describe("Default 'file'. 'manifest-default' writes top-level defaultPacker / defaultFormat instead."),
      packer: z.string().describe("Packer identifier. Conventions: rle, byteboozer, byteboozer-lykia, exomizer_raw, exomizer_sfx, custom-lz77, plain."),
      format: z.string().optional().describe("Optional format / dialect (e.g. 'prg', 'raw', 'sfx-loader')."),
      notes: z.array(z.string()).optional().describe("Optional notes appended to files[].notes."),
    },
    safeHandler("record_file_packer", async ({ manifest_path, file_index, file_name, file_relative_path, scope, packer, format, notes }) => {
      try {
        const pd = context.projectDir(manifest_path, true);
        const abs = resolve(pd, manifest_path);
        if (!existsSync(abs)) {
          throw new Error(`Manifest not found at ${abs}`);
        }
        const text = readFileSync(abs, "utf8");
        const manifest = JSON.parse(text) as { files?: Array<Record<string, unknown>>; defaultPacker?: string; defaultFormat?: string };
        if (scope === "manifest-default") {
          manifest.defaultPacker = packer;
          if (format !== undefined) manifest.defaultFormat = format;
          writeFileSync(abs, `${JSON.stringify(manifest, null, 2)}\n`);
          return { content: [{ type: "text" as const, text: `Set defaultPacker=${packer}${format ? ` defaultFormat=${format}` : ""} on ${abs}.` }] };
        }
        if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
          throw new Error("Manifest has no files[] array.");
        }
        const fileEntry = manifest.files.find((entry) => {
          if (file_index !== undefined && entry.index === file_index) return true;
          if (file_name !== undefined && entry.name === file_name) return true;
          if (file_relative_path !== undefined && entry.relativePath === file_relative_path) return true;
          return false;
        });
        if (!fileEntry) {
          throw new Error("No matching file entry. Provide file_index, file_name, or file_relative_path that matches the manifest.");
        }
        fileEntry.packer = packer;
        if (format !== undefined) fileEntry.format = format;
        if (notes && notes.length > 0) {
          const existing = Array.isArray(fileEntry.notes) ? (fileEntry.notes as string[]) : [];
          fileEntry.notes = [...existing, ...notes];
        }
        writeFileSync(abs, `${JSON.stringify(manifest, null, 2)}\n`);
        const label = file_relative_path ?? file_name ?? `index ${file_index}`;
        return { content: [{ type: "text" as const, text: `Recorded packer=${packer}${format ? ` format=${format}` : ""} on ${label} in ${abs}.` }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "link_cart_chunk_to_asm",
    "Link a cartridge LUT chunk to a disassembly (.asm/.tass) artifact via a RelationRecord. Idempotently creates a chunk entity (kind=code-segment, tagged 'cart-chunk:<key>') and a 'derived-from' relation pointing at the ASM artifact's entity (or its artifact). The cart medium UI surfaces the linked ASM source under the chunk inspector. Identify the chunk by (bank, slot, offset_in_bank, length) or by (lut, idx).",
    {
      lut_path: z.string().describe("Path to runtime_luts/all_luts.json (relative or absolute)."),
      project_dir: z.string().optional().describe("Override project dir; defaults to env C64RE_PROJECT_DIR."),
      bank: z.number().int().nonnegative().optional(),
      slot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH"]).optional(),
      offset_in_bank: z.number().int().nonnegative().optional(),
      length: z.number().int().positive().optional(),
      lut: z.string().optional(),
      idx: z.number().int().nonnegative().optional(),
      asm_artifact_id: z.string().describe("ID of the ArtifactRecord for the .asm/.tass output."),
      summary: z.string().optional().describe("Optional human-readable note shown on the relation."),
    },
    safeHandler("link_cart_chunk_to_asm", async ({ lut_path, project_dir, bank, slot, offset_in_bank, length, lut, idx, asm_artifact_id, summary }) => {
      try {
        const pd = context.projectDir(project_dir ?? lut_path, true);
        const lutAbs = resolve(pd, lut_path);
        if (!existsSync(lutAbs)) {
          throw new Error(`runtime_luts file not found at ${lutAbs}`);
        }

        let resolvedBank = bank;
        let resolvedSlot = slot;
        let resolvedOffset = offset_in_bank;
        let resolvedLength = length;

        if (lut !== undefined && idx !== undefined) {
          const lutData = JSON.parse(readFileSync(lutAbs, "utf8")) as Record<string, { entries?: Array<Record<string, unknown>> }>;
          const namedLut = lutData[lut];
          if (!namedLut || !Array.isArray(namedLut.entries)) {
            throw new Error(`LUT '${lut}' not found in ${lutAbs}`);
          }
          const entry = namedLut.entries.find((candidate) => candidate.idx === idx);
          if (!entry) {
            throw new Error(`Entry idx=${idx} not found in LUT '${lut}'`);
          }
          const entryBank = typeof entry.ef_bank === "number" ? entry.ef_bank : undefined;
          const entryLength = typeof entry.length === "number" ? entry.length : undefined;
          const entrySrc = typeof entry.src_addr === "string"
            ? Number.parseInt(entry.src_addr.replace(/^[$#]/, ""), 16)
            : typeof entry.src_addr === "number" ? entry.src_addr : undefined;
          if (entryBank === undefined || entryLength === undefined || entrySrc === undefined) {
            throw new Error(`Entry ${lut}.${idx} missing ef_bank / length / src_addr fields`);
          }
          let entrySlot: "ROML" | "ROMH" | "ULTIMAX_ROMH" = "ROML";
          let entryOffset = entrySrc - 0x8000;
          if (entrySrc >= 0xa000 && entrySrc < 0xc000) {
            entrySlot = "ROMH";
            entryOffset = entrySrc - 0xa000;
          } else if (entrySrc >= 0xe000) {
            entrySlot = "ULTIMAX_ROMH";
            entryOffset = entrySrc - 0xe000;
          }
          resolvedBank = entryBank;
          resolvedSlot = entrySlot;
          resolvedOffset = entryOffset;
          resolvedLength = entryLength;
        }

        if (resolvedBank === undefined || resolvedSlot === undefined || resolvedOffset === undefined || resolvedLength === undefined) {
          throw new Error("Provide either (bank, slot, offset_in_bank, length) or (lut, idx).");
        }

        const chunkKey = `${resolvedBank}:${resolvedSlot}:${resolvedOffset}:${resolvedLength}`;
        const chunkTag = `cart-chunk:${chunkKey}`;

        const service = new (await import("../project-knowledge/service.js")).ProjectKnowledgeService(pd);
        const existingChunkEntity = service
          .listEntities({ kind: "code-segment" })
          .find((entity) => entity.tags.includes(chunkTag));
        const chunkEntity = service.saveEntity({
          id: existingChunkEntity?.id,
          kind: "code-segment",
          name: `cart chunk ${chunkKey}`,
          summary: summary ?? `Cart LUT chunk at bank ${resolvedBank} ${resolvedSlot} off $${resolvedOffset.toString(16).toUpperCase().padStart(4, "0")} (${resolvedLength} B)`,
          mediumSpans: [{
            kind: "slot",
            bank: resolvedBank,
            slot: resolvedSlot,
            offsetInBank: resolvedOffset,
            length: resolvedLength,
          }],
          mediumRole: "code",
          tags: [chunkTag, "cart-chunk"],
          artifactIds: [asm_artifact_id],
        });

        const asmEntities = service.listEntities({}).filter((entity) => entity.artifactIds.includes(asm_artifact_id));
        const asmEntity = asmEntities[0];
        let relation;
        if (asmEntity) {
          relation = service.linkEntities({
            kind: "derived-from",
            title: `cart chunk ${chunkKey} → ${asmEntity.name}`,
            sourceEntityId: chunkEntity.id,
            targetEntityId: asmEntity.id,
            summary,
            artifactIds: [asm_artifact_id],
          });
        }

        const relationLine = relation
          ? `Linked entity ${chunkEntity.id} → ${asmEntity!.id} (relation ${relation.id}).`
          : `Created/updated chunk entity ${chunkEntity.id}; no entity exists yet for asm artifact ${asm_artifact_id}, so the relation was skipped.`;
        return { content: [{ type: "text" as const, text: relationLine }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));

  server.tool(
    "record_cart_chunk_packer",
    "Persist packer / format / notes metadata for a cartridge LUT chunk. Cart chunks are derived from runtime_luts/all_luts.json (analyzer output, regenerated on re-run), so this tool writes a sidecar file 'chunk_packers.json' next to it. The view-builder layers the sidecar on top of the analyzer chunks. Identify the chunk by (bank, slot, offsetInBank, length) — the dedup key the view uses — or by a single (lut, idx) pair if you prefer to look it up by reference.",
    {
      lut_path: z.string().describe("Path to the runtime_luts/all_luts.json (relative to project dir or absolute). The sidecar is written to chunk_packers.json next to it."),
      bank: z.number().int().nonnegative().optional().describe("Cart bank index. Required when identifying by physical placement."),
      slot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH"]).optional().describe("Cart slot. Required when identifying by physical placement."),
      offset_in_bank: z.number().int().nonnegative().optional().describe("Byte offset within the bank/slot. Required when identifying by physical placement."),
      length: z.number().int().positive().optional().describe("Chunk length in bytes. Required when identifying by physical placement."),
      lut: z.string().optional().describe("LUT name, e.g. 'tracks'. When set together with idx the tool resolves the chunk's physical key by reading lut_path."),
      idx: z.number().int().nonnegative().optional().describe("Index within the named LUT."),
      packer: z.string().describe("Packer identifier. Conventions: rle, byteboozer, byteboozer-lykia, exomizer_raw, exomizer_sfx, custom-lz77, plain."),
      format: z.string().optional().describe("Optional format / dialect (e.g. 'prg', 'raw', 'sfx-loader')."),
      notes: z.array(z.string()).optional().describe("Optional notes appended to the chunk's notes array."),
    },
    safeHandler("record_cart_chunk_packer", async ({ lut_path, bank, slot, offset_in_bank, length, lut, idx, packer, format, notes }) => {
      try {
        const pd = context.projectDir(lut_path, true);
        const lutAbs = resolve(pd, lut_path);
        if (!existsSync(lutAbs)) {
          throw new Error(`runtime_luts file not found at ${lutAbs}`);
        }

        // Resolve to physical key (bank:slot:offset:length).
        let resolvedBank = bank;
        let resolvedSlot = slot;
        let resolvedOffset = offset_in_bank;
        let resolvedLength = length;

        if (lut !== undefined && idx !== undefined) {
          const lutData = JSON.parse(readFileSync(lutAbs, "utf8")) as Record<string, { entries?: Array<Record<string, unknown>> }>;
          const namedLut = lutData[lut];
          if (!namedLut || !Array.isArray(namedLut.entries)) {
            throw new Error(`LUT '${lut}' not found in ${lutAbs}`);
          }
          const entry = namedLut.entries.find((candidate) => candidate.idx === idx);
          if (!entry) {
            throw new Error(`Entry idx=${idx} not found in LUT '${lut}'`);
          }
          const entryBank = typeof entry.ef_bank === "number" ? entry.ef_bank : undefined;
          const entryLength = typeof entry.length === "number" ? entry.length : undefined;
          const entrySrc = typeof entry.src_addr === "string"
            ? Number.parseInt(entry.src_addr.replace(/^[$#]/, ""), 16)
            : typeof entry.src_addr === "number" ? entry.src_addr : undefined;
          if (entryBank === undefined || entryLength === undefined || entrySrc === undefined) {
            throw new Error(`Entry ${lut}.${idx} missing ef_bank / length / src_addr fields`);
          }
          let entrySlot: "ROML" | "ROMH" | "ULTIMAX_ROMH" = "ROML";
          let entryOffset = entrySrc - 0x8000;
          if (entrySrc >= 0xa000 && entrySrc < 0xc000) {
            entrySlot = "ROMH";
            entryOffset = entrySrc - 0xa000;
          } else if (entrySrc >= 0xe000) {
            entrySlot = "ULTIMAX_ROMH";
            entryOffset = entrySrc - 0xe000;
          }
          resolvedBank = entryBank;
          resolvedSlot = entrySlot;
          resolvedOffset = entryOffset;
          resolvedLength = entryLength;
        }

        if (resolvedBank === undefined || resolvedSlot === undefined || resolvedOffset === undefined || resolvedLength === undefined) {
          throw new Error("Provide either (bank, slot, offset_in_bank, length) or (lut, idx).");
        }

        const sidecarAbs = resolve(lutAbs, "..", "chunk_packers.json");
        let sidecar: Record<string, { packer: string; format?: string; notes?: string[] }> = {};
        if (existsSync(sidecarAbs)) {
          try {
            sidecar = JSON.parse(readFileSync(sidecarAbs, "utf8"));
          } catch {
            sidecar = {};
          }
        }
        const key = `${resolvedBank}:${resolvedSlot}:${resolvedOffset}:${resolvedLength}`;
        const existing = sidecar[key] ?? { packer: "" };
        existing.packer = packer;
        if (format !== undefined) existing.format = format;
        if (notes && notes.length > 0) {
          const prior = Array.isArray(existing.notes) ? existing.notes : [];
          existing.notes = [...prior, ...notes];
        }
        sidecar[key] = existing;
        writeFileSync(sidecarAbs, `${JSON.stringify(sidecar, null, 2)}\n`);
        return {
          content: [{
            type: "text" as const,
            text: `Recorded packer=${packer}${format ? ` format=${format}` : ""} for cart chunk ${key} in ${sidecarAbs}.`,
          }],
        };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));
}
