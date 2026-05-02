import { basename, extname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCli } from "../run-cli.js";
import { extractDiskImage, readDiskDirectory } from "../disk-extractor.js";
import { diskSectorAllocation, extractDiskCustomLut, suggestDiskLutSector } from "../disk-custom-lut.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

function diskDefaultOutputDir(projectDir: string, imagePath: string): string {
  return join(projectDir, "analysis", "disk", basename(imagePath, extname(imagePath)));
}

export function registerMediaTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "extract_crt",
    "Parse an EasyFlash CRT image, extract per-bank binaries and manifest.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from crt_path to knowledge/phase-plan.json."),
      crt_path: z.string().describe("Path to the .crt file"),
      output_dir: z.string().optional().describe("Output directory (default: analysis/extracted)"),
    },
    async ({ project_dir, crt_path, output_dir }) => {
      const pd = context.projectDir(project_dir ?? crt_path, true);
      const crtAbs = resolve(pd, crt_path);
      const outAbs = output_dir ? resolve(pd, output_dir) : resolve(pd, "analysis", "extracted");
      const args = [crtAbs];
      if (output_dir) args.push(outAbs);
      const result = await runCli("extract-crt", args, { projectDir: pd });
      if (result.exitCode === 0) {
        const knowledgeRegistration = context.tryRegisterKnowledgeArtifacts(pd, {
          toolName: "extract_crt",
          title: `Extract CRT: ${basename(crtAbs)}`,
          parameters: {
            crt_path,
            output_dir: outAbs,
          },
          inputs: [{
            path: crtAbs,
            kind: "crt",
            scope: "input",
            role: "cartridge-image",
            producedByTool: "extract_crt",
          }],
          outputs: [{
            path: join(outAbs, "manifest.json"),
            kind: "manifest",
            scope: "generated",
            role: "crt-manifest",
            format: "json",
            producedByTool: "extract_crt",
          }],
        });
        if (knowledgeRegistration.outputArtifacts?.[0]) {
          try {
            const knowledgeService = new ProjectKnowledgeService(pd);
            const imported = knowledgeService.importManifestArtifact(knowledgeRegistration.outputArtifacts[0]);
            result.stdout = (result.stdout || "CRT extraction complete.") + `\nImported manifest knowledge: ${imported.importedEntityCount} entities, ${imported.importedFindingCount} findings, ${imported.importedRelationCount} relations`;
          } catch (error) {
            result.stdout = (result.stdout || "CRT extraction complete.") + `\nManifest import skipped: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        if (knowledgeRegistration.runPath) {
          result.stdout = (result.stdout || "CRT extraction complete.") + `\nKnowledge run: ${knowledgeRegistration.runPath}`;
        } else if (knowledgeRegistration.message) {
          result.stdout = (result.stdout || "CRT extraction complete.") + `\n${knowledgeRegistration.message}`;
        }
      }
      return context.cliResultToContent(result);
    },
  );

  server.tool(
    "inspect_disk",
    "Read a D64 or G64 directory and list the contained files without extracting them.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from image_path to knowledge/phase-plan.json."),
      image_path: z.string().describe("Path to the .d64 or .g64 image"),
    },
    async ({ project_dir, image_path }) => {
      try {
        const pd = context.projectDir(project_dir ?? image_path, true);
        const imageAbs = resolve(pd, image_path);
        const manifest = readDiskDirectory(imageAbs);
        const lines = [
          `Image: ${imageAbs}`,
          `Format: ${manifest.format.toUpperCase()}`,
          `Disk: ${manifest.diskName} [${manifest.diskId}]`,
          "",
          ...manifest.files.map((file) =>
            `${String(file.index + 1).padStart(2, "0")}. ${file.name} (${file.type}) - ${file.sizeSectors} blocks @ ${file.track}/${file.sector}`,
          ),
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
    "extract_disk",
    "Extract files from a D64 or G64 image into a project directory and write a manifest.json.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from image_path to knowledge/phase-plan.json."),
      image_path: z.string().describe("Path to the .d64 or .g64 image"),
      output_dir: z.string().optional().describe("Output directory (default: analysis/disk/<image-name>)"),
    },
    async ({ project_dir, image_path, output_dir }) => {
      try {
        const pd = context.projectDir(project_dir ?? image_path, true);
        const imageAbs = resolve(pd, image_path);
        const outAbs = output_dir
          ? resolve(pd, output_dir)
          : diskDefaultOutputDir(pd, imageAbs);
        const manifest = extractDiskImage(imageAbs, outAbs);
        const knowledgeRegistration = context.tryRegisterKnowledgeArtifacts(pd, {
          toolName: "extract_disk",
          title: `Extract disk: ${basename(imageAbs)}`,
          parameters: {
            image_path,
            output_dir: outAbs,
            format: manifest.format,
          },
          inputs: [{
            path: imageAbs,
            kind: manifest.format,
            scope: "input",
            role: "disk-image",
            producedByTool: "extract_disk",
          }],
          outputs: [{
            path: manifest.manifestPath,
            kind: "manifest",
            scope: "generated",
            role: "disk-manifest",
            format: "json",
            producedByTool: "extract_disk",
          }],
        });
        const lines = [
          `Extraction complete.`,
          `Image: ${imageAbs}`,
          `Format: ${manifest.format.toUpperCase()}`,
          `Disk: ${manifest.diskName} [${manifest.diskId}]`,
          `Output: ${manifest.outputDir}`,
          `Manifest: ${manifest.manifestPath}`,
          `Knowledge written to: ${join(pd, "knowledge")}`,
          "",
          ...manifest.files.map((file) => {
            const loadAddress = file.loadAddress === undefined
              ? ""
              : ` load=$${file.loadAddress.toString(16).toUpperCase().padStart(4, "0")}`;
            return `${String(file.index + 1).padStart(2, "0")}. ${file.relativePath} (${file.type}) - ${file.sizeBytes} bytes${loadAddress}`;
          }),
        ];
        if (knowledgeRegistration.outputArtifacts?.[0]) {
          try {
            const knowledgeService = new ProjectKnowledgeService(pd);
            const imported = knowledgeService.importManifestArtifact(knowledgeRegistration.outputArtifacts[0]);
            lines.push("", `Imported manifest knowledge: ${imported.importedEntityCount} entities, ${imported.importedFindingCount} findings, ${imported.importedRelationCount} relations`);
          } catch (error) {
            lines.push("", `Manifest import skipped: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (knowledgeRegistration.runPath) {
          lines.push("", `Knowledge run: ${knowledgeRegistration.runPath}`);
        } else if (knowledgeRegistration.message) {
          lines.push("", knowledgeRegistration.message);
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
    "extract_disk_custom_lut",
    "Extract files indexed by a custom (non-DOS) LUT sector. Use when a disk parks its real payloads in a fixed-stride table (Lykia disk1 T18S18, BWC variants, etc.) rather than the standard 1541 directory. Each entry produces a payload file with origin=\"custom\" merged into manifest.json.",
    {
      project_dir: z.string().optional(),
      image_path: z.string(),
      lut_track: z.number().int().min(1).max(40),
      lut_sector: z.number().int().min(0).max(40),
      entry_offset: z.number().int().min(0).optional(),
      entry_stride: z.number().int().min(2).optional(),
      entry_count: z.number().int().min(1).max(256).optional(),
      payload_format: z.enum(["ts_size_load", "ts_load_size", "chained", "raw"]),
      sentinel_payload: z.string().optional().describe("Hex of the empty/deleted slot marker (e.g. \"fefc0000\")."),
      output_dir: z.string().optional(),
      raw_default_size: z.number().int().min(1).optional(),
    },
    safeHandler("extract_disk_custom_lut", async (args) => {
      const pd = context.projectDir(args.project_dir ?? args.image_path, true);
      const imageAbs = resolve(pd, args.image_path);
      const outAbs = args.output_dir ? resolve(pd, args.output_dir) : diskDefaultOutputDir(pd, imageAbs);
      const result = extractDiskCustomLut({
        imagePath: imageAbs,
        lutTrack: args.lut_track,
        lutSector: args.lut_sector,
        entryOffset: args.entry_offset,
        entryStride: args.entry_stride,
        entryCount: args.entry_count,
        payloadFormat: args.payload_format,
        sentinelPayload: args.sentinel_payload,
        outputDir: outAbs,
        rawDefaultSize: args.raw_default_size,
      });
      const lines: string[] = [];
      lines.push(`Custom-LUT extraction complete.`);
      lines.push(`Image: ${imageAbs}`);
      lines.push(`LUT: T${result.lutTrack}/S${result.lutSector} format=${result.payloadFormat}`);
      lines.push(`Output: ${outAbs}`);
      lines.push(`Manifest: ${result.manifestPath}`);
      lines.push(`Entries scanned: ${result.entries.length}`);
      lines.push(`Files added (origin=custom): ${result.filesAdded.length}`);
      for (const file of result.filesAdded.slice(0, 20)) {
        lines.push(`- ${file.relativePath} (${file.sizeBytes} B)${file.loadAddress !== undefined ? ` load=$${file.loadAddress.toString(16).toUpperCase().padStart(4, "0")}` : ""}`);
      }
      const reg = context.tryRegisterKnowledgeArtifacts(pd, {
        toolName: "extract_disk_custom_lut",
        title: `Custom-LUT extract: ${basename(imageAbs)} T${result.lutTrack}S${result.lutSector}`,
        parameters: {
          image_path: args.image_path,
          lut_track: args.lut_track,
          lut_sector: args.lut_sector,
          payload_format: args.payload_format,
        },
        inputs: [{ path: imageAbs, kind: "d64", scope: "input", role: "disk-image", producedByTool: "extract_disk_custom_lut" } as never],
        outputs: [{ path: result.manifestPath, kind: "manifest", scope: "generated", role: "disk-manifest", format: "json", producedByTool: "extract_disk_custom_lut" } as never],
      });
      if (reg.runPath) lines.push(`Knowledge run: ${reg.runPath}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "disk_sector_allocation",
    "Walk an extracted disk manifest and report sector ownership per T/S: system (BAM/dir), kernal_file, custom_file, unclaimed_padding, orphan_data. Surfaces overlaps explicitly.",
    {
      project_dir: z.string().optional(),
      image_path: z.string(),
      manifest_path: z.string().optional().describe("Manifest path (defaults to <output_dir>/manifest.json under the standard analysis/disk/<image-name> location)."),
    },
    safeHandler("disk_sector_allocation", async (args) => {
      const pd = context.projectDir(args.project_dir ?? args.image_path, false);
      const imageAbs = resolve(pd, args.image_path);
      const manifestAbs = args.manifest_path
        ? resolve(pd, args.manifest_path)
        : join(diskDefaultOutputDir(pd, imageAbs), "manifest.json");
      const result = diskSectorAllocation(imageAbs, manifestAbs);
      const lines: string[] = [];
      lines.push(`Sector allocation for ${result.imagePath}`);
      lines.push(`Disk: ${result.diskName ?? "(unknown)"} [${result.diskId ?? "??"}]`);
      lines.push(`Total sectors: ${result.totalSectors}`);
      lines.push(`Unclaimed: ${result.unclaimedCount}`);
      lines.push(`Overlaps: ${result.overlapsCount}`);
      lines.push(``);
      const overlaps = result.ownership.filter((slot) => slot.overlaps && slot.overlaps.length > 0);
      if (overlaps.length > 0) {
        lines.push(`## Overlaps`);
        for (const slot of overlaps.slice(0, 32)) {
          lines.push(`- T${slot.track}/S${slot.sector} owner=${slot.owner} role=${slot.role} overlaps=${slot.overlaps?.join(", ")}`);
        }
        lines.push(``);
      }
      lines.push("```json");
      lines.push(JSON.stringify({ totals: { totalSectors: result.totalSectors, unclaimedCount: result.unclaimedCount, overlapsCount: result.overlapsCount } }, null, 2));
      lines.push("```");
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  server.tool(
    "suggest_disk_lut_sector",
    "Heuristic scan: look at every sector for plausible fixed-stride LUT entry tables and rank by confidence. Use before extract_disk_custom_lut when you do not yet know which sector the loader reads from.",
    {
      project_dir: z.string().optional(),
      image_path: z.string(),
    },
    safeHandler("suggest_disk_lut_sector", async (args) => {
      const pd = context.projectDir(args.project_dir ?? args.image_path, false);
      const imageAbs = resolve(pd, args.image_path);
      const candidates = suggestDiskLutSector(imageAbs);
      const lines: string[] = [];
      lines.push(`LUT sector candidates for ${imageAbs} (top ${candidates.length}):`);
      for (const candidate of candidates) {
        lines.push(`- T${candidate.track}/S${candidate.sector} stride=${candidate.stride} count=${candidate.count} confidence=${candidate.confidence.toFixed(2)}`);
        for (const reason of candidate.reasons) lines.push(`  · ${reason}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );
}
