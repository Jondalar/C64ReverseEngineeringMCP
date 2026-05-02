import { basename, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCli } from "../run-cli.js";
import { assembleSource } from "../assemble-source.js";
import { suggestDepackers } from "../compression-tools.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { runPayloadReverseWorkflow, runPrgReverseWorkflow, renderPrgReverseWorkflowResult } from "../lib/prg-workflow.js";
import { safeHandler } from "./safe-handler.js";
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
  sourceArtifactId?: string;
}): Promise<string> {
  const tempPrg = args.asmPath.replace(/\.asm$/i, "_rebuild_check.prg");
  let summaryLine: string;
  let assemblyOk = false;
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
      assemblyOk = true;
      const offset = result.firstDiffOffset !== undefined ? `0x${result.firstDiffOffset.toString(16).toUpperCase()}` : "?";
      summaryLine = `// WARNING: rebuild diverges from ${basename(args.prgPath)} at body offset ${offset}; disassembly is not byte-identical`;
    } else if (result.compareMatches) {
      assemblyOk = true;
      summaryLine = `// rebuild verified byte-identical against ${basename(args.prgPath)} (${result.comparedBytes ?? "?"} bytes)`;
    } else {
      summaryLine = `// rebuild verification skipped (no compare result)`;
    }
  } catch (error) {
    summaryLine = `// WARNING: rebuild verification failed to run: ${error instanceof Error ? error.message : String(error)}`;
  }

  // Bug 14: classify the rebuild-check PRG as a verification report rather
  // than letting blanket *.prg globs file it as a regular source PRG.
  if (assemblyOk && existsSync(tempPrg)) {
    try {
      const service = new ProjectKnowledgeService(args.projectDir);
      service.saveArtifact({
        kind: "report",
        scope: "analysis",
        title: `Rebuild check: ${basename(tempPrg)}`,
        path: tempPrg,
        format: "prg",
        role: "rebuild-check",
        producedByTool: "disasm_prg",
        sourceArtifactIds: args.sourceArtifactId ? [args.sourceArtifactId] : undefined,
        tags: ["rebuild-check", "auto"],
      });
    } catch {
      // best effort; don't fail the disasm flow over a registration hiccup
    }
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
    safeHandler("analyze_prg", async ({ project_dir, prg_path, output_json, entry_points }) => {
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
        // Spec 038: emit auto-suggested NEXT-step task.
        try {
          const knowledgeService = new ProjectKnowledgeService(pd);
          const expectedAsm = prgAbs.replace(/\.prg$/i, "_disasm.asm");
          knowledgeService.emitNextStepTask({
            producedByTool: "analyze_prg",
            artifactIds: [knowledgeRegistration.outputArtifacts?.[0] ?? basename(prgAbs)],
            title: `Run disasm_prg on ${basename(prgAbs)}`,
            description: `Disassemble using ${basename(outAbs)} and verify rebuild.`,
            autoCloseHint: { kind: "file-exists", path: expectedAsm },
            priority: "medium",
          });
        } catch {
          // best effort
        }
        const packerSummary = summarizePackerHints(packerHints);
        if (packerSummary.length > 0) {
          result.stdout += `\n${packerSummary.join("\n")}`;
        }
      }
      return context.cliResultToContent(result);
    }),
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
      platform: z.enum(["c64", "c1541"]).optional().describe("Spec 048: target platform for ZP / IO / ROM symbol tables. Default c64. Use c1541 for drive-side disassembly."),
    },
    safeHandler("disasm_prg", async ({ project_dir, prg_path, output_asm, entry_points, analysis_json, platform }) => {
      const pd = context.projectDir(project_dir ?? prg_path, true);
      const prgAbs = resolve(pd, prg_path);
      const outAbs = output_asm
        ? resolve(pd, output_asm)
        : prgAbs.replace(/\.prg$/i, "_disasm.asm");
      const entries = entry_points?.join(",") ?? "";
      // Spec 048: resolve platform — explicit arg wins, else read
      // from the artifact tag if registered, else default c64.
      let resolvedPlatform: "c64" | "c1541" = platform ?? "c64";
      if (!platform) {
        try {
          const knowledgeService = new ProjectKnowledgeService(pd);
          const a = knowledgeService.listArtifacts().find((art) => art.path === prgAbs);
          if (a?.platform === "c1541") resolvedPlatform = "c1541";
        } catch {
          // best effort
        }
      }
      const args: string[] = [];
      if (resolvedPlatform !== "c64") args.push("--platform", resolvedPlatform);
      args.push(prgAbs, outAbs);
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
          // Spec 038: track NEXT-hint as auto-suggested task.
          try {
            const knowledgeService = new ProjectKnowledgeService(pd);
            const subjectId = knowledgeRegistration.runPath ? `analysis-run:${basename(prgAbs)}` : basename(prgAbs);
            knowledgeService.emitNextStepTask({
              producedByTool: "disasm_prg",
              artifactIds: [subjectId],
              title: `Write ${basename(annotationsPath)}`,
              description: `Write semantic annotations file then re-run disasm_prg with annotations.`,
              autoCloseHint: { kind: "file-exists", path: annotationsPath },
              priority: "medium",
            });
          } catch {
            // best effort
          }
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
    }),
  );

  server.tool(
    "ram_report",
    "Generate a RAM state facts report (markdown) from an analysis JSON.",
    {
      analysis_json: z.string().describe("Path to the analysis JSON"),
      output_md: z.string().optional().describe("Output path for the markdown report"),
    },
    safeHandler("ram_report", async ({ analysis_json, output_md }) => {
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
    }),
  );

  server.tool(
    "pointer_report",
    "Generate a pointer table facts report (markdown) from an analysis JSON.",
    {
      analysis_json: z.string().describe("Path to the analysis JSON"),
      output_md: z.string().optional().describe("Output path for the markdown report"),
    },
    safeHandler("pointer_report", async ({ analysis_json, output_md }) => {
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
    }),
  );

  registerPrgReverseWorkflow(server, context);
}

function registerPrgReverseWorkflow(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "propose_annotations",
    "Spec 042: emit a draft *_annotations.draft.json by walking *_analysis.json + (optional) *_disasm.asm. Pattern fingerprints (pointer-table naming, text segment promotion, frequent call-target routines, large-unknown questions) feed the draft. Manual *_annotations.json is never touched. Pass persist_questions=true to also save openQuestions[] via save_open_question (source=static-analysis).",
    {
      project_dir: z.string().optional(),
      analysis_json: z.string().describe("Path to the *_analysis.json file (relative to project_dir)."),
      output_path: z.string().optional().describe("Optional draft output path; defaults to <stem>_annotations.draft.json next to the analysis."),
      listing_path: z.string().optional().describe("Optional *_disasm.asm path for label naming heuristics."),
      persist_questions: z.boolean().optional().describe("If true, also save openQuestions[] entries via save_open_question with source=static-analysis."),
    },
    safeHandler("propose_annotations", async ({ project_dir, analysis_json, output_path, listing_path, persist_questions }) => {
      const pd = context.projectDir(project_dir, true);
      const analysisAbs = resolve(pd, analysis_json);
      const draftAbs = output_path ? resolve(pd, output_path) : analysisAbs.replace(/_analysis\.json$/i, "_annotations.draft.json");
      const listingAbs = listing_path ? resolve(pd, listing_path) : undefined;
      // Pipeline runs in CommonJS; spawn the child to keep the
      // ESM/CommonJS boundary clean and reuse the existing
      // registerCliArtifact pipeline.
      const args = [analysisAbs, draftAbs];
      if (listingAbs) args.push(listingAbs);
      const result = await runCli("propose-annotations", args, { projectDir: pd });
      // Optional: walk the draft and persist openQuestions.
      if (persist_questions && result.exitCode === 0 && existsSync(draftAbs)) {
        try {
          const draft = JSON.parse(readFileSync(draftAbs, "utf8")) as { openQuestions?: Array<{ title: string; description: string; confidence: number }> };
          const service = new ProjectKnowledgeService(pd);
          let saved = 0;
          for (const q of draft.openQuestions ?? []) {
            service.saveOpenQuestion({
              kind: "static-analysis",
              title: q.title,
              description: q.description,
              confidence: q.confidence,
              source: "static-analysis",
              autoResolvable: true,
            });
            saved += 1;
          }
          result.stdout = (result.stdout ?? "") + `\nPersisted ${saved} open question(s) (source=static-analysis).`;
        } catch (error) {
          result.stdout = (result.stdout ?? "") + `\nPersist questions skipped: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      return context.cliResultToContent(result);
    }),
  );

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
    safeHandler("run_prg_reverse_workflow", async ({ project_dir, prg_path, mode, output_dir, rebuild_views, entry_points }) => {
      const pd = context.projectDir(project_dir ?? prg_path, true);
      const result = await runPrgReverseWorkflow({
        projectRoot: pd,
        prgPath: prg_path,
        mode,
        outputDir: output_dir,
        rebuildViews: rebuild_views,
        entryPoints: entry_points,
      });
      return context.cliResultToContent({
        stdout: renderPrgReverseWorkflowResult(result),
        stderr: "",
        exitCode: result.status === "blocked" ? 1 : 0,
      });
    }),
  );

  server.tool(
    "run_payload_reverse_workflow",
    "Run the reverse-engineering workflow on a payload entity. Resolves the payload's source artifact and load address, supports both PRG-header and raw blobs, stamps produced asm artifact ids back onto the payload.",
    {
      project_dir: z.string().optional().describe("Project root directory. Defaults to C64RE_PROJECT_DIR or process.cwd()."),
      payload_id: z.string().describe("Payload entity id (kind=payload)."),
      mode: z.enum(["quick", "full"]).optional().describe("quick = analyze + disasm only. full = also ram_report + pointer_report. Default full."),
      output_dir: z.string().optional().describe("Override output directory. Default artifacts/generated/payloads/<payload_id>."),
      rebuild_views: z.boolean().optional().describe("Run build_all_views after the workflow. Default true."),
      entry_points: z.array(z.string()).optional().describe("Optional hex entry-point overrides."),
    },
    safeHandler("run_payload_reverse_workflow", async ({ project_dir, payload_id, mode, output_dir, rebuild_views, entry_points }) => {
      const pd = context.projectDir(project_dir, false);
      const result = await runPayloadReverseWorkflow({
        projectRoot: pd,
        payloadId: payload_id,
        mode,
        outputDir: output_dir,
        rebuildViews: rebuild_views,
        entryPoints: entry_points,
      });
      return context.cliResultToContent({
        stdout: renderPrgReverseWorkflowResult(result),
        stderr: "",
        exitCode: result.status === "blocked" ? 1 : 0,
      });
    }),
  );
}
