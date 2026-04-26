import { basename, extname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCli } from "../run-cli.js";
import { extractDiskImage, readDiskDirectory } from "../disk-extractor.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
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
}
