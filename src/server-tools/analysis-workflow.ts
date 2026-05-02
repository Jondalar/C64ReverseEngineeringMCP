import { basename, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCli } from "../run-cli.js";
import { assembleSource } from "../assemble-source.js";
import { suggestDepackers } from "../compression-tools.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import type { ServerToolContext } from "./types.js";

const PACKER_DETECTION_THRESHOLD = 0.7;

interface PackerHintRecord {
  format: string;
  confidence: number;
  offset: number;
  length: number;
  unpackedSize?: number;
  reason: string;
  notes?: string[];
}

async function detectPackerHints(args: { projectDir: string; prgPath: string }): Promise<PackerHintRecord[]> {
  try {
    const suggestions = await suggestDepackers({
      projectDir: args.projectDir,
      inputPath: args.prgPath,
    });
    return suggestions
      .filter((entry) => entry.confidence >= PACKER_DETECTION_THRESHOLD && entry.format !== "unknown")
      .map((entry) => ({
        format: entry.format,
        confidence: entry.confidence,
        offset: entry.offset,
        length: entry.length,
        unpackedSize: entry.unpackedSize,
        reason: entry.reason,
        notes: entry.notes,
      }));
  } catch {
    return [];
  }
}

function attachPackerHintsToAnalysis(analysisPath: string, hints: PackerHintRecord[]): void {
  try {
    const raw = readFileSync(analysisPath, "utf8");
    const report = JSON.parse(raw) as Record<string, unknown>;
    report.packerHints = hints;
    writeFileSync(analysisPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {
    // best-effort; the analysis JSON is still valid without hints
  }
}

function summarizePackerHints(hints: PackerHintRecord[]): string[] {
  if (hints.length === 0) return [];
  const lines = ["", "Packer detection:"];
  for (const hint of hints) {
    lines.push(`- ${hint.format} (conf=${hint.confidence.toFixed(2)}) at $${hint.offset.toString(16).toUpperCase()}+$${hint.length.toString(16).toUpperCase()}${hint.unpackedSize !== undefined ? `, unpacked ≈ ${hint.unpackedSize} bytes` : ""}`);
  }
  const top = hints[0]!;
  if (top.format.startsWith("exomizer")) {
    lines.push(`NEXT: this PRG is likely Exomizer-packed. Run depack_exomizer_${top.format === "exomizer_sfx" ? "sfx" : "raw"} on it before treating the analysis output as semantic ground truth.`);
  } else if (top.format === "rle") {
    lines.push("NEXT: this PRG looks RLE-encoded. Run depack_rle, then re-analyze the unpacked output.");
  } else if (top.format === "byteboozer2") {
    lines.push("NEXT: this PRG looks ByteBoozer2-packed. Run depack_byteboozer, then re-analyze the unpacked output.");
  } else {
    lines.push("NEXT: try the matching depacker tool, then re-analyze the unpacked output.");
  }
  return lines;
}

async function rebuildVerification(args: {
  projectDir: string;
  asmPath: string;
  prgPath: string;
}): Promise<string> {
  const tempPrg = args.asmPath.replace(/\.asm$/i, "_rebuild_check.prg");
  let summaryLine: string;
  try {
    const result = await assembleSource({
      projectDir: args.projectDir,
      sourcePath: args.asmPath,
      assembler: "kickassembler",
      outputPath: tempPrg,
      compareToPath: args.prgPath,
    });
    if (result.exitCode !== 0) {
      summaryLine = `// WARNING: rebuild assembler exited ${result.exitCode}; this listing is not byte-identical with ${basename(args.prgPath)}`;
    } else if (result.compareMatches === false) {
      const offset = result.firstDiffOffset !== undefined ? `0x${result.firstDiffOffset.toString(16).toUpperCase()}` : "?";
      summaryLine = `// WARNING: rebuild diverges from ${basename(args.prgPath)} at body offset ${offset}; disassembly is not byte-identical`;
    } else if (result.compareMatches) {
      summaryLine = `// rebuild verified byte-identical against ${basename(args.prgPath)} (${result.comparedBytes ?? "?"} bytes)`;
    } else {
      summaryLine = `// rebuild verification skipped (no compare result)`;
    }
  } catch (error) {
    summaryLine = `// WARNING: rebuild verification failed to run: ${error instanceof Error ? error.message : String(error)}`;
  }

  // Bake the verdict into the head of the ASM so a human reading the file
  // sees it immediately without having to consult the tool stdout.
  try {
    const asm = readFileSync(args.asmPath, "utf8");
    const lines = asm.split("\n");
    const header = lines.findIndex((line) => line.startsWith("//****************"));
    if (header >= 0) {
      // insert before the closing banner
      const closing = lines.findIndex((line, index) => index > header && line.startsWith("//****************"));
      const insertAt = closing >= 0 ? closing : Math.min(lines.length, header + 1);
      // Drop any prior verification line so re-runs don't accumulate.
      const filtered = lines.filter((line) => !line.startsWith("// rebuild verified") && !line.startsWith("// WARNING: rebuild "));
      filtered.splice(insertAt, 0, summaryLine);
      writeFileSync(args.asmPath, filtered.join("\n"), "utf8");
    } else {
      writeFileSync(args.asmPath, `${summaryLine}\n${asm}`, "utf8");
    }
  } catch {
    // best-effort header injection; don't fail the disasm flow over it
  }

  return summaryLine;
}

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
        const packerHints = await detectPackerHints({ projectDir: pd, prgPath: prgAbs });
        if (packerHints.length > 0) {
          attachPackerHintsToAnalysis(outAbs, packerHints);
        }
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
        const packerSummary = summarizePackerHints(packerHints);
        if (packerSummary.length > 0) {
          result.stdout += `\n${packerSummary.join("\n")}`;
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
        const verificationSummary = await rebuildVerification({
          projectDir: pd,
          asmPath: outAbs,
          prgPath: prgAbs,
        });
        result.stdout = (result.stdout || "Disassembly complete.") + `\nOutput: ${outAbs}\nKnowledge written to: ${resolve(pd, "knowledge")}\n${verificationSummary}`;
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

  registerPrgReverseWorkflow(server, context);
}

interface PhaseResult {
  phase: string;
  status: "done" | "skipped" | "blocked";
  output?: string;
  artifact?: string;
  reason?: string;
  log?: string;
}

interface RegistrationOutcome {
  outputArtifactIds: string[];
  message?: string;
  runPath?: string;
}

function tryRegister(
  context: ServerToolContext,
  projectRoot: string,
  toolName: string,
  title: string,
  parameters: Record<string, string | number | boolean | null | string[]>,
  inputs: Array<{ path: string; kind: string; scope: string; role?: string; format?: string }>,
  outputs: Array<{ path: string; kind: string; scope: string; role?: string; format?: string }>,
): RegistrationOutcome {
  const registration = context.tryRegisterKnowledgeArtifacts(projectRoot, {
    toolName,
    title,
    parameters,
    inputs: inputs.map((entry) => ({ ...entry, producedByTool: toolName })) as never,
    outputs: outputs.map((entry) => ({ ...entry, producedByTool: toolName })) as never,
  });
  return {
    outputArtifactIds: registration.outputArtifacts ?? [],
    message: registration.message,
    runPath: registration.runPath,
  };
}

function registerPrgReverseWorkflow(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "run_prg_reverse_workflow",
    "Run the full first-pass PRG reverse-engineering workflow: register input, analyze, disassemble, generate RAM and pointer reports, import knowledge, and rebuild views. Returns done/incomplete/blocked plus the next required semantic action.",
    {
      project_dir: z.string().optional().describe("Project root directory. Defaults to C64RE_PROJECT_DIR or process.cwd()."),
      prg_path: z.string().describe("Path to the .prg file (absolute or relative to project_dir)."),
      mode: z.enum(["quick", "full"]).optional().describe("quick = analyze + disasm only. full = also ram_report + pointer_report. Default full."),
      output_dir: z.string().optional().describe("Override output directory. Default places outputs next to the PRG."),
      rebuild_views: z.boolean().optional().describe("Run build_all_views after the workflow. Default true."),
      entry_points: z.array(z.string()).optional().describe("Optional hex entry-point overrides (e.g. [\"0827\"])."),
    },
    async ({ project_dir, prg_path, mode, output_dir, rebuild_views, entry_points }) => {
      const startedAt = new Date().toISOString();
      const pd = context.projectDir(project_dir ?? prg_path, true);
      const prgAbs = resolve(pd, prg_path);
      const phases: PhaseResult[] = [];
      const importedCounts = { entities: 0, findings: 0, relations: 0, flows: 0, openQuestions: 0 };
      const writtenArtifacts: string[] = [];
      let viewsBuilt: string[] = [];
      let blocked = false;

      if (!existsSync(prgAbs)) {
        return context.cliResultToContent({
          stdout: "",
          stderr: `PRG not found at ${prgAbs}`,
          exitCode: 1,
        });
      }

      const baseAbs = output_dir
        ? resolve(pd, output_dir, basename(prgAbs).replace(/\.prg$/i, ""))
        : prgAbs.replace(/\.prg$/i, "");
      const analysisAbs = `${baseAbs}_analysis.json`;
      const asmAbs = `${baseAbs}_disasm.asm`;
      const tassAbs = `${baseAbs}_disasm.tass`;
      const ramReportAbs = `${baseAbs}_RAM_STATE_FACTS.md`;
      const pointerReportAbs = `${baseAbs}_POINTER_TABLE_FACTS.md`;
      const effectiveMode = mode ?? "full";
      const wantRebuildViews = rebuild_views ?? true;
      const entries = entry_points?.join(",") ?? "";

      const inputRegistration = tryRegister(
        context,
        pd,
        "run_prg_reverse_workflow",
        `Register input PRG: ${basename(prgAbs)}`,
        { prg_path },
        [],
        [{ path: prgAbs, kind: "prg", scope: "input", role: "analysis-target" }],
      );
      phases.push({
        phase: "register-input",
        status: "done",
        output: prgAbs,
        artifact: inputRegistration.outputArtifactIds[0],
      });

      const analysisArgs = [prgAbs, analysisAbs];
      if (entries) analysisArgs.push(entries);
      const analysisRun = await runCli("analyze-prg", analysisArgs, { projectDir: pd });
      if (analysisRun.exitCode !== 0) {
        phases.push({ phase: "analyze", status: "blocked", reason: analysisRun.stderr || "analyze-prg failed", log: analysisRun.stdout });
        blocked = true;
      } else {
        const analysisRegistration = tryRegister(
          context,
          pd,
          "analyze_prg",
          `Analyze PRG: ${basename(prgAbs)}`,
          { prg_path, output_json: analysisAbs, entry_points: entry_points ?? [] },
          [{ path: prgAbs, kind: "prg", scope: "input", role: "analysis-target" }],
          [{ path: analysisAbs, kind: "other", scope: "analysis", role: "analysis-json", format: "json" }],
        );
        writtenArtifacts.push(analysisAbs);
        phases.push({
          phase: "analyze",
          status: "done",
          output: analysisAbs,
          artifact: analysisRegistration.outputArtifactIds[0],
        });

        if (analysisRegistration.outputArtifactIds[0]) {
          try {
            const knowledgeService = new ProjectKnowledgeService(pd);
            const imported = knowledgeService.importAnalysisArtifact(analysisRegistration.outputArtifactIds[0]);
            importedCounts.entities += imported.importedEntityCount;
            importedCounts.findings += imported.importedFindingCount;
            importedCounts.relations += imported.importedRelationCount;
            importedCounts.flows += imported.importedFlowCount;
            importedCounts.openQuestions += imported.importedOpenQuestionCount;
            phases.push({
              phase: "import-analysis",
              status: "done",
              artifact: analysisRegistration.outputArtifactIds[0],
              reason: `entities=${imported.importedEntityCount} findings=${imported.importedFindingCount} relations=${imported.importedRelationCount} flows=${imported.importedFlowCount} questions=${imported.importedOpenQuestionCount}`,
            });
          } catch (error) {
            phases.push({
              phase: "import-analysis",
              status: "blocked",
              reason: error instanceof Error ? error.message : String(error),
            });
            blocked = true;
          }
        }
      }

      if (!blocked) {
        const disasmArgs = [prgAbs, asmAbs];
        if (entries) disasmArgs.push(entries);
        if (existsSync(analysisAbs)) disasmArgs.push(analysisAbs);
        const disasmRun = await runCli("disasm-prg", disasmArgs, { projectDir: pd });
        if (disasmRun.exitCode !== 0) {
          phases.push({ phase: "disasm", status: "blocked", reason: disasmRun.stderr || "disasm-prg failed", log: disasmRun.stdout });
          blocked = true;
        } else {
          tryRegister(
            context,
            pd,
            "disasm_prg",
            `Disassemble PRG: ${basename(prgAbs)}`,
            { prg_path, output_asm: asmAbs, analysis_json: analysisAbs },
            [
              { path: prgAbs, kind: "prg", scope: "input", role: "disasm-target" },
              { path: analysisAbs, kind: "other", scope: "analysis", role: "analysis-json", format: "json" },
            ],
            [
              { path: asmAbs, kind: "generated-source", scope: "generated", role: "kickassembler-source", format: "asm" },
              { path: tassAbs, kind: "generated-source", scope: "generated", role: "64tass-source", format: "tass" },
            ],
          );
          writtenArtifacts.push(asmAbs);
          if (existsSync(tassAbs)) writtenArtifacts.push(tassAbs);
          phases.push({ phase: "disasm", status: "done", output: asmAbs });
        }
      }

      if (!blocked && effectiveMode === "full" && existsSync(analysisAbs)) {
        const ramRun = await runCli("ram-report", [analysisAbs, ramReportAbs], { projectDir: pd });
        if (ramRun.exitCode === 0) {
          tryRegister(
            context,
            pd,
            "ram_report",
            `RAM report: ${basename(analysisAbs)}`,
            { analysis_json: analysisAbs, output_md: ramReportAbs },
            [{ path: analysisAbs, kind: "other", scope: "analysis", role: "analysis-json", format: "json" }],
            [{ path: ramReportAbs, kind: "report", scope: "generated", role: "ram-report", format: "markdown" }],
          );
          writtenArtifacts.push(ramReportAbs);
          phases.push({ phase: "ram-report", status: "done", output: ramReportAbs });
        } else {
          phases.push({ phase: "ram-report", status: "blocked", reason: ramRun.stderr || "ram-report failed" });
        }

        const pointerRun = await runCli("pointer-report", [analysisAbs, pointerReportAbs], { projectDir: pd });
        if (pointerRun.exitCode === 0) {
          tryRegister(
            context,
            pd,
            "pointer_report",
            `Pointer report: ${basename(analysisAbs)}`,
            { analysis_json: analysisAbs, output_md: pointerReportAbs },
            [{ path: analysisAbs, kind: "other", scope: "analysis", role: "analysis-json", format: "json" }],
            [{ path: pointerReportAbs, kind: "report", scope: "generated", role: "pointer-report", format: "markdown" }],
          );
          writtenArtifacts.push(pointerReportAbs);
          phases.push({ phase: "pointer-report", status: "done", output: pointerReportAbs });
        } else {
          phases.push({ phase: "pointer-report", status: "blocked", reason: pointerRun.stderr || "pointer-report failed" });
        }
      } else if (effectiveMode === "quick") {
        phases.push({ phase: "ram-report", status: "skipped", reason: "mode=quick" });
        phases.push({ phase: "pointer-report", status: "skipped", reason: "mode=quick" });
      }

      if (wantRebuildViews && !blocked) {
        try {
          const service = new ProjectKnowledgeService(pd);
          const built = service.buildAllViews();
          viewsBuilt = [
            built.projectDashboard.path,
            built.memoryMap.path,
            built.diskLayout.path,
            built.cartridgeLayout.path,
            built.loadSequence.path,
            built.flowGraph.path,
            built.annotatedListing.path,
          ];
          phases.push({ phase: "build-views", status: "done", reason: `${viewsBuilt.length} views` });
        } catch (error) {
          phases.push({
            phase: "build-views",
            status: "blocked",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (!wantRebuildViews) {
        phases.push({ phase: "build-views", status: "skipped", reason: "rebuild_views=false" });
      }

      const overall = phases.some((p) => p.status === "blocked") ? "blocked"
        : phases.some((p) => p.status === "skipped") ? "incomplete"
          : "done";

      const annotationsPath = `${baseAbs}_disasm_annotations.json`;
      const nextRequiredAction = overall === "blocked"
        ? "Resolve the blocked phase before continuing."
        : existsSync(annotationsPath)
          ? "Re-run disasm_prg to render the annotated listing."
          : `Read ${asmAbs} and write ${annotationsPath} with segment reclassifications, semantic labels, and routine documentation. Then re-run disasm_prg.`;

      const lines: string[] = [];
      lines.push(`# run_prg_reverse_workflow`);
      lines.push(``);
      lines.push(`Project root: ${pd}`);
      lines.push(`Knowledge written to: ${resolve(pd, "knowledge")}`);
      lines.push(`Started at: ${startedAt}`);
      lines.push(`Mode: ${effectiveMode}`);
      lines.push(`Status: ${overall}`);
      lines.push(``);
      lines.push(`## Phases`);
      for (const p of phases) {
        const tail = [p.output ? `output=${p.output}` : null, p.artifact ? `artifactId=${p.artifact}` : null, p.reason ? `note=${p.reason}` : null]
          .filter(Boolean)
          .join(" | ");
        lines.push(`- [${p.status}] ${p.phase}${tail ? ` — ${tail}` : ""}`);
      }
      lines.push(``);
      lines.push(`## Imported knowledge`);
      lines.push(`entities=${importedCounts.entities} findings=${importedCounts.findings} relations=${importedCounts.relations} flows=${importedCounts.flows} openQuestions=${importedCounts.openQuestions}`);
      lines.push(``);
      lines.push(`## Artifacts written`);
      if (writtenArtifacts.length === 0) {
        lines.push(`(none)`);
      } else {
        for (const path of writtenArtifacts) lines.push(`- ${path}`);
      }
      lines.push(``);
      lines.push(`## Views rebuilt`);
      if (viewsBuilt.length === 0) {
        lines.push(`(none)`);
      } else {
        for (const path of viewsBuilt) lines.push(`- ${path}`);
      }
      lines.push(``);
      lines.push(`## Next required step`);
      lines.push(nextRequiredAction);
      return context.cliResultToContent({
        stdout: lines.join("\n"),
        stderr: "",
        exitCode: overall === "blocked" ? 1 : 0,
      });
    },
  );
}
