import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { runCli } from "../run-cli.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { registerToolKnowledge } from "../project-knowledge/integration.js";

export type WorkflowMode = "quick" | "full";

export interface PrgReverseWorkflowOptions {
  projectRoot: string;
  prgPath: string;
  mode?: WorkflowMode;
  outputDir?: string;
  rebuildViews?: boolean;
  entryPoints?: string[];
}

export type WorkflowPhaseStatus = "done" | "skipped" | "blocked";

export interface PrgReverseWorkflowPhase {
  phase: string;
  status: WorkflowPhaseStatus;
  output?: string;
  artifact?: string;
  reason?: string;
  log?: string;
}

export interface PrgReverseWorkflowResult {
  projectRoot: string;
  prgPath: string;
  mode: WorkflowMode;
  startedAt: string;
  status: "done" | "incomplete" | "blocked";
  phases: PrgReverseWorkflowPhase[];
  importedCounts: {
    entities: number;
    findings: number;
    relations: number;
    flows: number;
    openQuestions: number;
  };
  artifactsWritten: string[];
  viewsBuilt: string[];
  nextRequiredAction: string;
  analysisPath: string;
  asmPath: string;
  tassPath: string;
  ramReportPath?: string;
  pointerReportPath?: string;
}

interface RegistrationOutcome {
  outputArtifactIds: string[];
  message?: string;
  runPath?: string;
}

function tryRegister(
  projectRoot: string,
  toolName: string,
  title: string,
  parameters: Record<string, string | number | boolean | null | string[]>,
  inputs: Array<{ path: string; kind: string; scope: string; role?: string; format?: string }>,
  outputs: Array<{ path: string; kind: string; scope: string; role?: string; format?: string }>,
): RegistrationOutcome {
  const registration = registerToolKnowledge(projectRoot, {
    toolName,
    title,
    parameters,
    inputs: inputs.map((entry) => ({ ...entry, producedByTool: toolName })) as never,
    outputs: outputs.map((entry) => ({ ...entry, producedByTool: toolName })) as never,
  });
  return {
    outputArtifactIds: registration.outputArtifacts ?? [],
    runPath: registration.runPath,
  };
}

export async function runPrgReverseWorkflow(opts: PrgReverseWorkflowOptions): Promise<PrgReverseWorkflowResult> {
  const startedAt = new Date().toISOString();
  const projectRoot = resolve(opts.projectRoot);
  const prgAbs = resolve(projectRoot, opts.prgPath);
  if (!existsSync(prgAbs)) {
    throw new Error(`PRG not found at ${prgAbs}`);
  }

  const baseAbs = opts.outputDir
    ? resolve(projectRoot, opts.outputDir, basename(prgAbs).replace(/\.prg$/i, ""))
    : prgAbs.replace(/\.prg$/i, "");
  mkdirSync(dirname(baseAbs), { recursive: true });
  const analysisPath = `${baseAbs}_analysis.json`;
  const asmPath = `${baseAbs}_disasm.asm`;
  const tassPath = `${baseAbs}_disasm.tass`;
  const ramReportPath = `${baseAbs}_RAM_STATE_FACTS.md`;
  const pointerReportPath = `${baseAbs}_POINTER_TABLE_FACTS.md`;
  const mode: WorkflowMode = opts.mode ?? "full";
  const rebuildViews = opts.rebuildViews ?? true;
  const entries = opts.entryPoints?.join(",") ?? "";

  const phases: PrgReverseWorkflowPhase[] = [];
  const importedCounts = { entities: 0, findings: 0, relations: 0, flows: 0, openQuestions: 0 };
  const artifactsWritten: string[] = [];
  let viewsBuilt: string[] = [];
  let blocked = false;

  const inputReg = tryRegister(
    projectRoot,
    "run_prg_reverse_workflow",
    `Register input PRG: ${basename(prgAbs)}`,
    { prg_path: opts.prgPath },
    [],
    [{ path: prgAbs, kind: "prg", scope: "input", role: "analysis-target" }],
  );
  phases.push({ phase: "register-input", status: "done", output: prgAbs, artifact: inputReg.outputArtifactIds[0] });

  const analysisArgs = [prgAbs, analysisPath];
  if (entries) analysisArgs.push(entries);
  const analysisRun = await runCli("analyze-prg", analysisArgs, { projectDir: projectRoot });
  if (analysisRun.exitCode !== 0) {
    phases.push({ phase: "analyze", status: "blocked", reason: analysisRun.stderr || "analyze-prg failed", log: analysisRun.stdout });
    blocked = true;
  } else {
    const reg = tryRegister(
      projectRoot,
      "analyze_prg",
      `Analyze PRG: ${basename(prgAbs)}`,
      { prg_path: opts.prgPath, output_json: analysisPath, entry_points: opts.entryPoints ?? [] },
      [{ path: prgAbs, kind: "prg", scope: "input", role: "analysis-target" }],
      [{ path: analysisPath, kind: "other", scope: "analysis", role: "analysis-json", format: "json" }],
    );
    artifactsWritten.push(analysisPath);
    phases.push({ phase: "analyze", status: "done", output: analysisPath, artifact: reg.outputArtifactIds[0] });

    if (reg.outputArtifactIds[0]) {
      try {
        const service = new ProjectKnowledgeService(projectRoot);
        const imported = service.importAnalysisArtifact(reg.outputArtifactIds[0]);
        importedCounts.entities += imported.importedEntityCount;
        importedCounts.findings += imported.importedFindingCount;
        importedCounts.relations += imported.importedRelationCount;
        importedCounts.flows += imported.importedFlowCount;
        importedCounts.openQuestions += imported.importedOpenQuestionCount;
        phases.push({
          phase: "import-analysis",
          status: "done",
          artifact: reg.outputArtifactIds[0],
          reason: `entities=${imported.importedEntityCount} findings=${imported.importedFindingCount} relations=${imported.importedRelationCount} flows=${imported.importedFlowCount} questions=${imported.importedOpenQuestionCount}`,
        });
      } catch (error) {
        phases.push({ phase: "import-analysis", status: "blocked", reason: error instanceof Error ? error.message : String(error) });
        blocked = true;
      }
    }
  }

  if (!blocked) {
    const disasmArgs = [prgAbs, asmPath];
    if (entries) disasmArgs.push(entries);
    if (existsSync(analysisPath)) disasmArgs.push(analysisPath);
    const disasmRun = await runCli("disasm-prg", disasmArgs, { projectDir: projectRoot });
    if (disasmRun.exitCode !== 0) {
      phases.push({ phase: "disasm", status: "blocked", reason: disasmRun.stderr || "disasm-prg failed", log: disasmRun.stdout });
      blocked = true;
    } else {
      tryRegister(
        projectRoot,
        "disasm_prg",
        `Disassemble PRG: ${basename(prgAbs)}`,
        { prg_path: opts.prgPath, output_asm: asmPath, analysis_json: analysisPath },
        [
          { path: prgAbs, kind: "prg", scope: "input", role: "disasm-target" },
          { path: analysisPath, kind: "other", scope: "analysis", role: "analysis-json", format: "json" },
        ],
        [
          { path: asmPath, kind: "generated-source", scope: "generated", role: "kickassembler-source", format: "asm" },
          { path: tassPath, kind: "generated-source", scope: "generated", role: "64tass-source", format: "tass" },
        ],
      );
      artifactsWritten.push(asmPath);
      if (existsSync(tassPath)) artifactsWritten.push(tassPath);
      phases.push({ phase: "disasm", status: "done", output: asmPath });
    }
  }

  if (!blocked && mode === "full" && existsSync(analysisPath)) {
    const ramRun = await runCli("ram-report", [analysisPath, ramReportPath], { projectDir: projectRoot });
    if (ramRun.exitCode === 0) {
      tryRegister(
        projectRoot,
        "ram_report",
        `RAM report: ${basename(analysisPath)}`,
        { analysis_json: analysisPath, output_md: ramReportPath },
        [{ path: analysisPath, kind: "other", scope: "analysis", role: "analysis-json", format: "json" }],
        [{ path: ramReportPath, kind: "report", scope: "generated", role: "ram-report", format: "markdown" }],
      );
      artifactsWritten.push(ramReportPath);
      phases.push({ phase: "ram-report", status: "done", output: ramReportPath });
    } else {
      phases.push({ phase: "ram-report", status: "blocked", reason: ramRun.stderr || "ram-report failed" });
    }

    const pointerRun = await runCli("pointer-report", [analysisPath, pointerReportPath], { projectDir: projectRoot });
    if (pointerRun.exitCode === 0) {
      tryRegister(
        projectRoot,
        "pointer_report",
        `Pointer report: ${basename(analysisPath)}`,
        { analysis_json: analysisPath, output_md: pointerReportPath },
        [{ path: analysisPath, kind: "other", scope: "analysis", role: "analysis-json", format: "json" }],
        [{ path: pointerReportPath, kind: "report", scope: "generated", role: "pointer-report", format: "markdown" }],
      );
      artifactsWritten.push(pointerReportPath);
      phases.push({ phase: "pointer-report", status: "done", output: pointerReportPath });
    } else {
      phases.push({ phase: "pointer-report", status: "blocked", reason: pointerRun.stderr || "pointer-report failed" });
    }
  } else if (mode === "quick") {
    phases.push({ phase: "ram-report", status: "skipped", reason: "mode=quick" });
    phases.push({ phase: "pointer-report", status: "skipped", reason: "mode=quick" });
  }

  if (rebuildViews && !blocked) {
    try {
      const service = new ProjectKnowledgeService(projectRoot);
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
      phases.push({ phase: "build-views", status: "blocked", reason: error instanceof Error ? error.message : String(error) });
    }
  } else if (!rebuildViews) {
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
      : `Read ${asmPath} and write ${annotationsPath} with segment reclassifications, semantic labels, and routine documentation. Then re-run disasm_prg.`;

  return {
    projectRoot,
    prgPath: opts.prgPath,
    mode,
    startedAt,
    status: overall,
    phases,
    importedCounts,
    artifactsWritten,
    viewsBuilt,
    nextRequiredAction,
    analysisPath,
    asmPath,
    tassPath,
    ramReportPath: mode === "full" ? ramReportPath : undefined,
    pointerReportPath: mode === "full" ? pointerReportPath : undefined,
  };
}

export function renderPrgReverseWorkflowResult(result: PrgReverseWorkflowResult): string {
  const lines: string[] = [];
  lines.push(`# run_prg_reverse_workflow`);
  lines.push(``);
  lines.push(`Project root: ${result.projectRoot}`);
  lines.push(`Knowledge written to: ${resolve(result.projectRoot, "knowledge")}`);
  lines.push(`Started at: ${result.startedAt}`);
  lines.push(`Mode: ${result.mode}`);
  lines.push(`Status: ${result.status}`);
  lines.push(``);
  lines.push(`## Phases`);
  for (const p of result.phases) {
    const tail = [p.output ? `output=${p.output}` : null, p.artifact ? `artifactId=${p.artifact}` : null, p.reason ? `note=${p.reason}` : null]
      .filter(Boolean)
      .join(" | ");
    lines.push(`- [${p.status}] ${p.phase}${tail ? ` — ${tail}` : ""}`);
  }
  lines.push(``);
  lines.push(`## Imported knowledge`);
  lines.push(`entities=${result.importedCounts.entities} findings=${result.importedCounts.findings} relations=${result.importedCounts.relations} flows=${result.importedCounts.flows} openQuestions=${result.importedCounts.openQuestions}`);
  lines.push(``);
  lines.push(`## Artifacts written`);
  if (result.artifactsWritten.length === 0) lines.push(`(none)`);
  else for (const path of result.artifactsWritten) lines.push(`- ${path}`);
  lines.push(``);
  lines.push(`## Views rebuilt`);
  if (result.viewsBuilt.length === 0) lines.push(`(none)`);
  else for (const path of result.viewsBuilt) lines.push(`- ${path}`);
  lines.push(``);
  lines.push(`## Next required step`);
  lines.push(result.nextRequiredAction);
  return lines.join("\n");
}
