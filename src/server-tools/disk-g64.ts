import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDiskParser, G64Parser } from "../disk/index.js";
import type { G64LutReference } from "../disk/g64-parser.js";
import { runCli } from "../run-cli.js";
import type { ServerToolContext } from "./types.js";

function g64SectorDefaultOutputDir(context: ServerToolContext, imagePath: string, track: number): string {
  return join(
    context.projectDir(imagePath, true),
    "analysis",
    "g64",
    basename(imagePath, extname(imagePath)),
    `track-${String(track).replace(".", "_")}`,
  );
}

function loadG64Parser(context: ServerToolContext, imagePath: string): G64Parser {
  const imageAbs = resolve(context.projectDir(imagePath, true), imagePath);
  const parser = createDiskParser(new Uint8Array(readFileSync(imageAbs)));
  if (!(parser instanceof G64Parser)) {
    throw new Error(`Image is not a G64: ${imageAbs}`);
  }
  return parser;
}

function parseLutReferences(text: string): G64LutReference[] {
  const refs: G64LutReference[] = [];
  const lines = text.split(/\r?\n/);
  const pattern = /T(\d+(?:\.\d+)?):S(\d+)(?:\+(\d+))?/gi;
  for (const line of lines) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      refs.push({
        track: Number(match[1]),
        sector: match[2] === undefined ? undefined : Number(match[2]),
        offset: match[3] === undefined ? undefined : Number(match[3]),
        sourceLine: line.trim(),
      });
    }
  }
  return refs;
}

export function registerDiskG64Tools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "list_g64_slots",
    "List all G64 half-track slots, including raw offsets, lengths, and speed-zone metadata.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
      include_empty: z.boolean().optional().describe("Include empty slots with raw offset 0"),
    },
    async ({ image_path, include_empty }) => {
      try {
        const pd = context.projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(context, image_path);
        const slots = parser.listSlots(include_empty ?? false);
        const lines = [
          `Image: ${imageAbs}`,
          `Track count: ${parser.getTrackCount()}`,
          `Half-track slots: ${parser.getHalfTrackCount()}`,
          `Listed slots: ${slots.length}`,
          "",
          "Slots:",
        ];
        for (const slot of slots) {
          const speed = slot.speedZoneValue === undefined
            ? `$${slot.speedZoneRaw.toString(16).toUpperCase()}`
            : `${slot.speedZoneValue} (raw=$${slot.speedZoneRaw.toString(16).toUpperCase()}${slot.speedZoneTableOffset === undefined ? "" : ` table@$${slot.speedZoneTableOffset.toString(16).toUpperCase()}`})`;
          lines.push(`- track ${slot.track}  halftrack=${slot.halfTrack}  slot=${slot.slotIndex}  data=${slot.hasData ? "yes" : "no"}  rawOffset=$${slot.rawOffset.toString(16).toUpperCase()}  rawLength=${slot.rawLength}  speed=${speed}`);
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
  );

  server.tool(
    "inspect_g64_track",
    "Decode a specific G64 track via GCR and report discovered sectors, missing IDs, duplicates, and raw track metadata.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
      track: z.number().positive().describe("Track number, supports 0.5 steps such as 18 or 18.5"),
    },
    async ({ image_path, track }) => {
      try {
        const pd = context.projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(context, image_path);
        const analysis = parser.getTrackAnalysis(track);
        if (!analysis) {
          return { content: [{ type: "text" as const, text: `No raw track data present for ${imageAbs} track ${track}.` }] };
        }
        const lines = [
          `Image: ${imageAbs}`,
          `Track: ${track}`,
          `Half-track: ${analysis.halfTrack}`,
          `Slot index: ${analysis.slotIndex}`,
          `Raw offset: ${analysis.rawOffset}`,
          `Raw length: ${analysis.rawLength} bytes`,
        ];
        if (analysis.expectedSectorCount !== undefined) {
          lines.push(`Expected sectors: ${analysis.expectedSectorCount}`);
        }
        lines.push(`Speed-zone raw: $${analysis.speedZoneRaw.toString(16).toUpperCase()}`);
        if (analysis.speedZoneValue !== undefined) {
          lines.push(`Speed-zone value: ${analysis.speedZoneValue}`);
        }
        if (analysis.speedZoneTableOffset !== undefined) {
          lines.push(`Speed-zone table offset: $${analysis.speedZoneTableOffset.toString(16).toUpperCase()}`);
        }
        lines.push(`Decoded sectors: ${analysis.sectors.length}`);
        lines.push(`Duplicate sectors: ${analysis.duplicateSectors.length ? analysis.duplicateSectors.join(", ") : "none"}`);
        lines.push(`Missing sectors: ${analysis.missingSectors.length ? analysis.missingSectors.join(", ") : "none"}`);
        lines.push(`Unexpected sectors: ${analysis.unexpectedSectors.length ? analysis.unexpectedSectors.join(", ") : "none"}`);
        lines.push(`Invalid data blocks: ${analysis.invalidDataCount}`);
        const blockInspection = parser.inspectTrackBlocks(track, 96);
        if (blockInspection) {
          const jsonSummary = {
            track: analysis.track,
            halfTrack: analysis.halfTrack,
            slotIndex: analysis.slotIndex,
            rawLength: analysis.rawLength,
            expectedSectorCount: analysis.expectedSectorCount ?? null,
            speedZoneRaw: analysis.speedZoneRaw,
            speedZoneValue: analysis.speedZoneValue ?? null,
            chosenParity: blockInspection.chosenParity,
            chosenParityScore: blockInspection.chosenParityScore,
            alternativeParityScore: blockInspection.alternativeParityScore,
            decodedSectorCount: analysis.sectors.length,
            invalidHeaderCount: analysis.invalidHeaderCount,
            invalidDataCount: analysis.invalidDataCount,
            sectors: analysis.sectors,
          };
          lines.push("");
          lines.push("JSON summary:");
          lines.push("```json");
          lines.push(JSON.stringify(jsonSummary, null, 2));
          lines.push("```");
          lines.push("");
          lines.push("ASCII ring map:");
          lines.push("Legend: S=sync H=valid header h=tolerant header D=valid data d=tolerant data x=bad data .=gap");
          lines.push(blockInspection.asciiMap);
        }
        lines.push("");
        lines.push("Decoded sectors:");
        for (const sector of analysis.sectors) {
          lines.push(`- ${sector.track}/${sector.sector}  header=${sector.headerValid ? "ok" : "bad"}  data=${sector.dataValid ? "ok" : "bad"}  bytes=${sector.dataLength}`);
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
  );

  server.tool(
    "inspect_g64_blocks",
    "Inspect a G64 track or half-track at raw GCR block level and return JSON plus an ASCII ring map.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
      track: z.number().positive().describe("Track number, supports 0.5 steps such as 18 or 18.5"),
      limit: z.number().int().positive().optional().describe("Optional limit for displayed header/data pairs"),
      ascii_width: z.number().int().positive().optional().describe("ASCII visualization width, default 96"),
    },
    async ({ image_path, track, limit, ascii_width }) => {
      try {
        const pd = context.projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(context, image_path);
        const inspection = parser.inspectTrackBlocks(track, ascii_width ?? 96);
        if (!inspection) {
          return { content: [{ type: "text" as const, text: `No raw track data present for ${imageAbs} track ${track}.` }] };
        }
        const shownPairs = inspection.pairs.slice(0, limit ?? inspection.pairs.length);
        const jsonSummary = {
          track: inspection.track,
          halfTrack: inspection.halfTrack,
          slotIndex: inspection.slotIndex,
          rawLength: inspection.rawLength,
          chosenParity: inspection.chosenParity,
          chosenParityScore: inspection.chosenParityScore,
          alternativeParityScore: inspection.alternativeParityScore,
          pairCount: inspection.pairs.length,
          pairs: shownPairs.map((pair) => ({
            pairIndex: pair.pairIndex,
            headerSync: pair.headerSync,
            dataSync: pair.dataSync,
            header: pair.header,
            data: pair.data,
          })),
        };
        const lines = [
          `Image: ${imageAbs}`,
          `Track: ${track}`,
          `Half-track: ${inspection.halfTrack}`,
          `Slot index: ${inspection.slotIndex}`,
          `Raw length: ${inspection.rawLength} bytes`,
          `Chosen parity: ${inspection.chosenParity}`,
          `Chosen parity score: ${inspection.chosenParityScore}`,
          `Alternative parity score: ${inspection.alternativeParityScore}`,
          `Pairs: ${inspection.pairs.length}`,
          "",
          "JSON summary:",
          "```json",
          JSON.stringify(jsonSummary, null, 2),
          "```",
          "",
          "ASCII ring map:",
          "Legend: S=sync H=valid header h=tolerant header D=valid data d=tolerant data x=bad data .=gap",
          inspection.asciiMap,
          "",
          "Pairs:",
        ];
        for (const pair of shownPairs) {
          lines.push(`- pair ${pair.pairIndex}: headerSync@bit ${pair.headerSync.bitIndex} dataSync@bit ${pair.dataSync.bitIndex} header=${pair.header.valid ? "ok" : pair.header.gcrValid ? "tolerant" : "bad"} ${pair.header.track}/${pair.header.sector} id=$${pair.header.headerId.toString(16).toUpperCase().padStart(2, "0")} data=${pair.data.valid ? "ok" : pair.data.gcrValid ? "tolerant" : "bad"} block=$${pair.data.blockId.toString(16).toUpperCase().padStart(2, "0")}`);
        }
        if (shownPairs.length < inspection.pairs.length) {
          lines.push(`... ${inspection.pairs.length - shownPairs.length} more pairs`);
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
  );

  server.tool(
    "extract_g64_raw_track",
    "Export the raw circular G64 half-track data for bit-level inspection.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
      track: z.number().positive().describe("Track number, supports 0.5 steps such as 18 or 18.5"),
      output_path: z.string().optional().describe("Output path for the raw half-track dump"),
    },
    async ({ image_path, track, output_path }) => {
      try {
        const pd = context.projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(context, image_path);
        const raw = parser.extractRawTrack(track);
        const slotInfo = parser.getSlotInfo(track);
        if (!raw || !slotInfo) {
          return { content: [{ type: "text" as const, text: `No raw track data present for ${imageAbs} track ${track}.` }] };
        }
        const outPath = output_path
          ? resolve(pd, output_path)
          : resolve(pd, "analysis", "g64-raw", `${basename(imageAbs, ".g64")}-track-${String(track).replace(".", "_")}.bin`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, raw);
        const lines = [
          `Image: ${imageAbs}`,
          `Track: ${track}`,
          `Half-track: ${slotInfo.halfTrack}`,
          `Slot index: ${slotInfo.slotIndex}`,
          `Raw bytes written: ${raw.length}`,
          `Output: ${outPath}`,
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
    "inspect_g64_syncs",
    "Inspect sync marks on a raw G64 half-track and report bit-aligned sync positions.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
      track: z.number().positive().describe("Track number, supports 0.5 steps such as 18 or 18.5"),
      limit: z.number().int().positive().optional().describe("Optional limit for displayed sync marks"),
    },
    async ({ image_path, track, limit }) => {
      try {
        const pd = context.projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(context, image_path);
        const info = parser.getTrackSyncInfo(track);
        if (!info) {
          return { content: [{ type: "text" as const, text: `No raw track data present for ${imageAbs} track ${track}.` }] };
        }
        const shown = info.syncs.slice(0, limit ?? info.syncs.length);
        const lines = [
          `Image: ${imageAbs}`,
          `Track: ${track}`,
          `Half-track: ${info.halfTrack}`,
          `Slot index: ${info.slotIndex}`,
          `Raw length: ${info.rawLength} bytes`,
          `Sync marks: ${info.syncCount}`,
          "",
          "Sync positions:",
        ];
        for (const sync of shown) {
          lines.push(`- bit=${sync.bitIndex}  byte=${sync.byteOffset}  bitOffset=${sync.bitOffset}`);
        }
        if (shown.length < info.syncCount) {
          lines.push(`... ${info.syncCount - shown.length} more`);
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
  );

  server.tool(
    "scan_g64_headers",
    "Scan a G64 track or half-track like VICE's 1541 sector-header search and list discovered header candidates.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
      track: z.number().positive().describe("Track number, supports 0.5 steps such as 18 or 18.5"),
      limit: z.number().int().positive().optional().describe("Optional limit for displayed header candidates"),
    },
    async ({ image_path, track, limit }) => {
      try {
        const pd = context.projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(context, image_path);
        const headers = parser.scanTrackHeadersLikeVice(track);
        const shown = headers.slice(0, limit ?? headers.length);
        const lines = [
          `Image: ${imageAbs}`,
          `Track: ${track}`,
          `Header candidates: ${headers.length}`,
          "",
          "Headers:",
        ];
        for (const candidate of shown) {
          lines.push(`- sync@bit ${candidate.sync.bitIndex}  ${candidate.header.track}/${candidate.header.sector}  id=$${candidate.header.headerId.toString(16).toUpperCase().padStart(2, "0")}  checksum=$${candidate.header.checksum.toString(16).toUpperCase().padStart(2, "0")}  header=${candidate.header.valid ? "ok" : candidate.header.gcrValid ? "tolerant" : "bad"}`);
        }
        if (shown.length < headers.length) {
          lines.push(`... ${headers.length - shown.length} more`);
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
  );

  server.tool(
    "read_g64_sector_candidate",
    "Read a sector from a G64 track or half-track using a VICE-style 1541 sync/header search.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
      track: z.number().positive().describe("Track number, supports 0.5 steps such as 18 or 18.5"),
      sector: z.number().int().nonnegative().describe("Sector number to search for on the specified track or half-track"),
    },
    async ({ image_path, track, sector }) => {
      try {
        const pd = context.projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(context, image_path);
        const readResult = parser.readTrackSectorLikeVice(track, sector);
        if (!readResult) {
          return { content: [{ type: "text" as const, text: `No raw track data present for ${imageAbs} track ${track}.` }] };
        }
        const { result } = readResult;
        const lines = [
          `Image: ${imageAbs}`,
          `Track: ${track}`,
          `Half-track: ${readResult.halfTrack}`,
          `Sector: ${sector}`,
          `Status: ${result.status}`,
        ];
        if (result.headerSync) {
          lines.push(`Header sync: bit ${result.headerSync.bitIndex}`);
        }
        if (result.dataSync) {
          lines.push(`Data sync: bit ${result.dataSync.bitIndex}`);
        }
        if (result.header) {
          lines.push(`Header: ${result.header.track}/${result.header.sector} id=$${result.header.headerId.toString(16).toUpperCase().padStart(2, "0")} header=${result.header.valid ? "ok" : result.header.gcrValid ? "tolerant" : "bad"}`);
        }
        if (result.data) {
          lines.push(`Data block: id=$${result.data.blockId.toString(16).toUpperCase().padStart(2, "0")} data=${result.data.valid ? "ok" : result.data.gcrValid ? "tolerant" : "bad"} bytes=${result.data.dataLength}`);
        }
        if (result.payload) {
          lines.push(`Preview: ${[...result.payload.slice(0, 16)].map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ")}`);
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
  );

  server.tool(
    "extract_g64_sectors",
    "Decode a G64 track via GCR and write one file per decoded sector for low-level inspection.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
      track: z.number().positive().describe("Track number, supports 0.5 steps such as 18 or 18.5"),
      sectors: z.array(z.number().int().nonnegative()).optional().describe("Optional explicit sector IDs to extract; defaults to all decoded sectors on the track"),
      output_dir: z.string().optional().describe("Output directory for extracted sector files"),
    },
    async ({ image_path, track, sectors, output_dir }) => {
      try {
        const pd = context.projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(context, image_path);
        const decoded = parser.extractTrackSectors(track, sectors);
        const outDir = output_dir ? resolve(pd, output_dir) : g64SectorDefaultOutputDir(context, imageAbs, track);
        mkdirSync(outDir, { recursive: true });

        const written: string[] = [];
        for (const sector of decoded) {
          const fileName = `t${String(sector.track).padStart(2, "0")}s${String(sector.sector).padStart(2, "0")}${sector.dataValid ? "" : ".invalid"}.bin`;
          const outputPath = join(outDir, fileName);
          writeFileSync(outputPath, sector.data);
          written.push(outputPath);
        }

        const metadataPath = join(outDir, "track-metadata.json");
        writeFileSync(metadataPath, `${JSON.stringify({
          sourceImage: imageAbs,
          track,
          requestedSectors: sectors ?? null,
          decodedCount: decoded.length,
          files: decoded.map((sector, index) => ({
            track: sector.track,
            sector: sector.sector,
            headerValid: sector.headerValid,
            dataValid: sector.dataValid,
            bytes: sector.data.length,
            path: written[index],
          })),
        }, null, 2)}\n`, "utf8");

        const lines = [
          `Image: ${imageAbs}`,
          `Track: ${track}`,
          `Output: ${outDir}`,
          `Decoded sectors written: ${decoded.length}`,
          `Metadata: ${metadataPath}`,
        ];
        for (const sector of decoded) {
          lines.push(`- ${sector.track}/${sector.sector}  ${sector.data.length} bytes  header=${sector.headerValid ? "ok" : "bad"}  data=${sector.dataValid ? "ok" : "bad"}`);
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
  );

  server.tool(
    "analyze_g64_anomalies",
    "Scan a G64 image track-by-track and report duplicate, missing, unexpected, or invalid decoded sectors.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
      lut_path: z.string().optional().describe("Optional text/markdown file containing LUT references like T37:S2+225 for coverage diagnostics"),
    },
    async ({ image_path, lut_path }) => {
      try {
        const pd = context.projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(context, image_path);
        const lutAbs = lut_path ? resolve(pd, lut_path) : undefined;
        const lutReferences = lutAbs ? parseLutReferences(context.readTextFile(lutAbs)) : undefined;
        const report = parser.analyzeAnomaliesWithOptions({ lutReferences });
        const lines = [
          `Image: ${imageAbs}`,
          `Version: ${report.version}`,
          `Track count: ${report.trackCount}`,
          `Half-track count: ${report.halfTrackCount}`,
          `Tracks with raw data: ${report.tracksWithData.map((track) => String(track)).join(", ") || "none"}`,
          `Half-tracks with raw data: ${report.slotsWithData.map((slot) => String(slot)).join(", ") || "none"}`,
          `LUT references: ${lutReferences ? lutReferences.length : 0}`,
          `Anomalies: ${report.anomalies.length}`,
        ];
        if (lutAbs) {
          lines.push(`LUT file: ${lutAbs}`);
        }
        for (const anomaly of report.anomalies) {
          lines.push(`- track ${anomaly.track}: ${anomaly.issue}${anomaly.details ? ` (${anomaly.details})` : ""}`);
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
  );

  server.tool(
    "reconstruct_lut",
    "Reconstruct boot LUT payload groups from extracted CRT data.",
    {
      analysis_dir: z.string().optional().describe("Analysis directory (default: analysis)"),
    },
    async ({ analysis_dir }) => {
      const pd = context.projectDir(analysis_dir, true);
      const args = analysis_dir ? [resolve(pd, analysis_dir)] : [];
      const result = await runCli("reconstruct-lut", args, { projectDir: pd });
      return context.cliResultToContent(result);
    },
  );

  server.tool(
    "export_menu",
    "Export menu payload binaries from extracted CRT data.",
    {
      analysis_dir: z.string().optional().describe("Analysis directory (default: analysis)"),
    },
    async ({ analysis_dir }) => {
      const pd = context.projectDir(analysis_dir, true);
      const args = analysis_dir ? [resolve(pd, analysis_dir)] : [];
      const result = await runCli("export-menu", args, { projectDir: pd });
      return context.cliResultToContent(result);
    },
  );

  server.tool(
    "disasm_menu",
    "Generate KickAssembler sources for all menu payloads.",
    {
      analysis_dir: z.string().optional().describe("Analysis directory (default: analysis)"),
      output_dir: z.string().optional().describe("Output directory for ASM sources"),
    },
    async ({ analysis_dir, output_dir }) => {
      const pd = context.projectDir(analysis_dir ?? output_dir, true);
      const args: string[] = [];
      if (analysis_dir) args.push(resolve(pd, analysis_dir));
      if (output_dir) args.push(resolve(pd, output_dir));
      const result = await runCli("disasm-menu", args, { projectDir: pd });
      return context.cliResultToContent(result);
    },
  );
}
