import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCli } from "../run-cli.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import type { ServerToolContext } from "./types.js";

export function registerAnalysisWorkflowTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "analyze_prg",
    "STEP 1 of the C64 RE workflow. Run the heuristic analysis pipeline on a PRG file → JSON with segments, cross-references, RAM facts, pointer tables. AFTER THIS: run disasm_prg with the output JSON, then ram_report and pointer_report. Do NOT skip the semantic annotation step (Phase 2) later.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from prg_path to knowledge/phase-plan.json."),
      prg_path: z.string().describe("Path to the .prg file (absolute or relative to project dir)"),
      output_json: z.string().optional().describe("Output path for the analysis JSON (default: next to PRG)"),
      entry_points: z.array(z.string()).optional().describe("Hex entry point addresses, e.g. [\"0827\", \"3E07\"]"),
    },
    async ({ project_dir, prg_path, output_json, entry_points }) => {
      const pd = context.projectDir(project_dir ?? prg_path, true);
      const prgAbs = resolve(pd, prg_path);
      const outAbs = output_json
        ? resolve(pd, output_json)
        : prgAbs.replace(/\.prg$/i, "_analysis.json");
      const entries = entry_points?.join(",") ?? "";
      const args = [prgAbs, outAbs];
      if (entries) args.push(entries);
      const result = await runCli("analyze-prg", args, { projectDir: pd });
      if (result.exitCode === 0) {
        const knowledgeRegistration = context.tryRegisterKnowledgeArtifacts(pd, {
          toolName: "analyze_prg",
          title: `Analyze PRG: ${basename(prgAbs)}`,
          parameters: {
            prg_path,
            output_json: outAbs,
            entry_points: entry_points ?? [],
          },
          inputs: [{
            path: prgAbs,
            kind: "prg",
            scope: "input",
            role: "analysis-target",
            producedByTool: "analyze_prg",
          }],
          outputs: [{
            path: outAbs,
            kind: "other",
            scope: "analysis",
            role: "analysis-json",
            format: "json",
            producedByTool: "analyze_prg",
          }],
        });
        result.stdout = (result.stdout || "Analysis complete.") + `\nOutput: ${outAbs}\nKnowledge written to: ${resolve(pd, "knowledge")}`;
        if (knowledgeRegistration.outputArtifacts?.[0]) {
          try {
            const knowledgeService = new ProjectKnowledgeService(pd);
            const imported = knowledgeService.importAnalysisArtifact(knowledgeRegistration.outputArtifacts[0]);
            result.stdout += `\nImported analysis knowledge: ${imported.importedEntityCount} entities, ${imported.importedFindingCount} findings, ${imported.importedRelationCount} relations, ${imported.importedFlowCount} flows, ${imported.importedOpenQuestionCount} open questions`;
          } catch (error) {
            result.stdout += `\nAnalysis import skipped: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        if (knowledgeRegistration.runPath) {
          result.stdout += `\nKnowledge run: ${knowledgeRegistration.runPath}`;
        } else if (knowledgeRegistration.message) {
          result.stdout += `\n${knowledgeRegistration.message}`;
        }
      }
      return context.cliResultToContent(result);
    },
  );

  server.tool(
    "disasm_prg",
    "STEP 2 of the C64 RE workflow. Disassemble PRG → KickAssembler .asm + 64tass .tass. Pass the analysis JSON from analyze_prg. AFTER THIS: you MUST read the full ASM with read_artifact, then produce a <name>_annotations.json file that reclassifies all unknown segments with semantic labels and routine descriptions. Then run disasm_prg AGAIN to render the final annotated version. See the generate_annotations prompt for the JSON format.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from prg_path to knowledge/phase-plan.json."),
      prg_path: z.string().describe("Path to the .prg file"),
      output_asm: z.string().optional().describe("Output path for the .asm file"),
      entry_points: z.array(z.string()).optional().describe("Hex entry point addresses"),
      analysis_json: z.string().optional().describe("Path to a prior analysis JSON for segment-aware disassembly"),
    },
    async ({ project_dir, prg_path, output_asm, entry_points, analysis_json }) => {
      const pd = context.projectDir(project_dir ?? prg_path, true);
      const prgAbs = resolve(pd, prg_path);
      const outAbs = output_asm
        ? resolve(pd, output_asm)
        : prgAbs.replace(/\.prg$/i, "_disasm.asm");
      const entries = entry_points?.join(",") ?? "";
      const args = [prgAbs, outAbs];
      if (entries) args.push(entries);
      if (analysis_json) args.push(resolve(pd, analysis_json));
      const result = await runCli("disasm-prg", args, { projectDir: pd });
      if (result.exitCode === 0) {
        const annotationsPath = outAbs.replace(/\.asm$/i, "_annotations.json");
        const hasAnnotations = existsSync(annotationsPath);
        const tassPath = outAbs.replace(/\.asm$/i, ".tass");
        const knowledgeRegistration = context.tryRegisterKnowledgeArtifacts(pd, {
          toolName: "disasm_prg",
          title: `Disassemble PRG: ${basename(prgAbs)}`,
          parameters: {
            prg_path,
            output_asm: outAbs,
            analysis_json: analysis_json ?? null,
            entry_points: entry_points ?? [],
          },
          inputs: [
            {
              path: prgAbs,
              kind: "prg",
              scope: "input",
              role: "disasm-target",
              producedByTool: "disasm_prg",
            },
            ...(analysis_json ? [{
              path: resolve(pd, analysis_json),
              kind: "other" as const,
              scope: "analysis" as const,
              role: "analysis-json",
              format: "json",
              producedByTool: "disasm_prg",
            }] : []),
          ],
          outputs: [
            {
              path: outAbs,
              kind: "generated-source",
              scope: "generated",
              role: "kickassembler-source",
              format: "asm",
              producedByTool: "disasm_prg",
            },
            {
              path: tassPath,
              kind: "generated-source",
              scope: "generated",
              role: "64tass-source",
              format: "tass",
              producedByTool: "disasm_prg",
            },
          ],
        });
        result.stdout = (result.stdout || "Disassembly complete.") + `\nOutput: ${outAbs}\nKnowledge written to: ${resolve(pd, "knowledge")}`;
        if (!hasAnnotations) {
          result.stdout += `\n\nNEXT STEP: Read the full ASM with read_artifact, then create ${annotationsPath} with segment reclassifications, semantic labels, and routine documentation. Then run disasm_prg again to produce the final annotated version.`;
        } else {
          result.stdout += `\nAnnotations applied from: ${annotationsPath}`;
        }
        if (knowledgeRegistration.runPath) {
          result.stdout += `\nKnowledge run: ${knowledgeRegistration.runPath}`;
        } else if (knowledgeRegistration.message) {
          result.stdout += `\n${knowledgeRegistration.message}`;
        }
      }
      return context.cliResultToContent(result);
    },
  );

  server.tool(
    "ram_report",
    "Generate a RAM state facts report (markdown) from an analysis JSON.",
    {
      analysis_json: z.string().describe("Path to the analysis JSON"),
      output_md: z.string().optional().describe("Output path for the markdown report"),
    },
    async ({ analysis_json, output_md }) => {
      const pd = context.projectDir(analysis_json, true);
      const jsonAbs = resolve(pd, analysis_json);
      const outAbs = output_md
        ? resolve(pd, output_md)
        : jsonAbs.replace(/_analysis\.json$/i, "_RAM_STATE_FACTS.md");
      const result = await runCli("ram-report", [jsonAbs, outAbs], { projectDir: pd });
      if (result.exitCode === 0) {
        const knowledgeRegistration = context.tryRegisterKnowledgeArtifacts(pd, {
          toolName: "ram_report",
          title: `RAM report: ${basename(jsonAbs)}`,
          parameters: {
            analysis_json,
            output_md: outAbs,
          },
          inputs: [{
            path: jsonAbs,
            kind: "other",
            scope: "analysis",
            role: "analysis-json",
            format: "json",
            producedByTool: "ram_report",
          }],
          outputs: [{
            path: outAbs,
            kind: "report",
            scope: "generated",
            role: "ram-report",
            format: "markdown",
            producedByTool: "ram_report",
          }],
        });
        result.stdout = (result.stdout || "RAM report complete.") + `\nOutput: ${outAbs}`;
        if (knowledgeRegistration.runPath) {
          result.stdout += `\nKnowledge run: ${knowledgeRegistration.runPath}`;
        } else if (knowledgeRegistration.message) {
          result.stdout += `\n${knowledgeRegistration.message}`;
        }
      }
      return context.cliResultToContent(result);
    },
  );

  server.tool(
    "pointer_report",
    "Generate a pointer table facts report (markdown) from an analysis JSON.",
    {
      analysis_json: z.string().describe("Path to the analysis JSON"),
      output_md: z.string().optional().describe("Output path for the markdown report"),
    },
    async ({ analysis_json, output_md }) => {
      const pd = context.projectDir(analysis_json, true);
      const jsonAbs = resolve(pd, analysis_json);
      const outAbs = output_md
        ? resolve(pd, output_md)
        : jsonAbs.replace(/_analysis\.json$/i, "_POINTER_TABLE_FACTS.md");
      const result = await runCli("pointer-report", [jsonAbs, outAbs], { projectDir: pd });
      if (result.exitCode === 0) {
        const knowledgeRegistration = context.tryRegisterKnowledgeArtifacts(pd, {
          toolName: "pointer_report",
          title: `Pointer report: ${basename(jsonAbs)}`,
          parameters: {
            analysis_json,
            output_md: outAbs,
          },
          inputs: [{
            path: jsonAbs,
            kind: "other",
            scope: "analysis",
            role: "analysis-json",
            format: "json",
            producedByTool: "pointer_report",
          }],
          outputs: [{
            path: outAbs,
            kind: "report",
            scope: "generated",
            role: "pointer-report",
            format: "markdown",
            producedByTool: "pointer_report",
          }],
        });
        result.stdout = (result.stdout || "Pointer report complete.") + `\nOutput: ${outAbs}`;
        if (knowledgeRegistration.runPath) {
          result.stdout += `\nKnowledge run: ${knowledgeRegistration.runPath}`;
        } else if (knowledgeRegistration.message) {
          result.stdout += `\n${knowledgeRegistration.message}`;
        }
      }
      return context.cliResultToContent(result);
    },
  );
}
