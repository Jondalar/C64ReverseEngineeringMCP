import { basename, dirname, resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCli } from "../run-cli.js";
import { assembleSource } from "../assemble-source.js";
import { suggestDepackers } from "../compression-tools.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { runAndFormatClosedLoopSweep } from "./closed-loop-sweep.js";
import { runPayloadReverseWorkflow, runPrgReverseWorkflow, renderPrgReverseWorkflowResult } from "../lib/prg-workflow.js";
import { safeHandler } from "./safe-handler.js";
import { startAnalysisJob, waitForJob, getAnalysisJob } from "./analysis-jobs.js";
import type { ServerToolContext } from "./types.js";

/** BUG-039 — grace window before analyze_prg switches to job mode. Small PRGs
 *  finish well inside it (identical UX); large ones return a job_id instead of
 *  tripping the MCP host's ~180s stall limit (which drops the connection).
 *  Env override C64RE_ANALYZE_GRACE_MS for tests / tighter host limits. */
const ANALYZE_JOB_GRACE_MS = Number(process.env["C64RE_ANALYZE_GRACE_MS"]) > 0
  ? Number(process.env["C64RE_ANALYZE_GRACE_MS"])
  : 100_000;

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

/**
 * Spec 833 D3 — the listing's own verdict on the annotations, read back from
 * the listing.
 *
 * The renderer writes exactly one header line saying what happened to them:
 * applied and how many, found-and-not-applied with the reason, or none found.
 * This wrapper does not render, so it does not get to say — it quotes. That is
 * the whole fix: a caller now reads a rendering result from the renderer and a
 * graph result from the graph, instead of taking one line for both.
 */
function listingAnnotationStatus(asmPath: string): string {
  try {
    // the header is the first ~10 lines; a listing can be megabytes
    const line = readFileSync(asmPath, "utf8")
      .slice(0, 4096)
      .split("\n")
      .find((l) => /^\/\/\s+(?:No s|S)emantic annotations/.test(l));
    if (line) return line.replace(/^\/\/\s+/, "");
  } catch {
    // fall through — an unreadable listing is reported as unknown, never as applied
  }
  return "annotation status unknown — the listing header could not be read";
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

/**
 * Spec 838 D3 — say at the tool surface what the analysis did about seeds. The
 * reported bug (issue #16) is half a silent tool: `entry_points` addresses that
 * did nothing, and a graph full of cross-overlay call sites that nobody fed to
 * the disassembler. Both are now in the JSON; this puts them in the answer.
 * Soft: a summary line never breaks the analysis.
 */
function describeCodeSeeds(analysisPath: string): string {
  try {
    if (!existsSync(analysisPath)) return "";
    const report = JSON.parse(readFileSync(analysisPath, "utf8")) as {
      codeSeedReport?: { status: string; owner: string; reason?: string; seeds?: Array<{ origin: string }> };
      rejectedEntryPoints?: Array<{ address: number; reason: string }>;
      strandedByDecodeConflict?: unknown[];
    };
    const lines: string[] = [];
    const seeds = report.codeSeedReport;
    if (seeds?.status === "ok" && (seeds.seeds?.length ?? 0) > 0) {
      const byOrigin = new Map<string, number>();
      for (const seed of seeds.seeds ?? []) byOrigin.set(seed.origin, (byOrigin.get(seed.origin) ?? 0) + 1);
      lines.push(`Graph code seeds: ${seeds.seeds!.length} for owner "${seeds.owner}" — ${[...byOrigin].sort().map(([o, n]) => `${o}=${n}`).join(", ")}. Addresses only another overlay reaches are disassembled instead of rendered as .byte; the listing names which seed reached each region.`);
    } else if (seeds && seeds.status !== "ok") {
      lines.push(`Graph code seeds: none — ${seeds.reason ?? seeds.status}`);
    }
    const rejected = report.rejectedEntryPoints ?? [];
    const refused = rejected.filter((r) => r.reason !== "already_code");
    if (refused.length > 0) {
      const byReason = new Map<string, number>();
      for (const r of refused) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
      lines.push(`Entry points NOT seeded: ${refused.length} (${[...byReason].sort().map(([r, n]) => `${r}=${n}`).join(", ")}) — see rejectedEntryPoints in the JSON. An entry_points list CONSTRAINS this scan; it does not simply add to it.`);
    }
    const stranded = report.strandedByDecodeConflict ?? [];
    if (stranded.length > 0) {
      lines.push(`Bytes stranded by a decode conflict: ${stranded.length} — two seeds decoded the same range at different alignments (strandedByDecodeConflict).`);
    }
    return lines.length > 0 ? `\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

export function registerAnalysisWorkflowTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "analyze_prg",
    "Run the heuristic analysis pipeline on a PRG and produce structured JSON — segments, cross-references, RAM facts, pointer tables. Use first on any new PRG to map its structure. Not for producing assembly (run disasm_prg next, passing this JSON) or for disk/cart images (extract first). Inputs: prg_path, optional project_dir. Returns: analysis JSON path + summary.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from prg_path to knowledge/phase-plan.json."),
      prg_path: z.string().describe("Path to the .prg file (absolute or relative to project dir)"),
      output_json: z.string().optional().describe("Output path for the analysis JSON (default: next to PRG)"),
      entry_points: z.array(z.string()).optional().describe("Hex entry point addresses, e.g. [\"0827\", \"3E07\"]. Usually unnecessary: when the project graph knows an address another overlay calls into, the scan seeds it by itself and reports what it used. A list does NOT simply add seeds — an address inside an instruction another seed already decoded cannot be honoured, and the analysis names the ones it refused (`rejectedEntryPoints`, also printed in the listing header)."),
    },
    safeHandler("analyze_prg", async ({ project_dir, prg_path, output_json, entry_points }) => {
      const pd = context.projectDir(project_dir ?? prg_path, true);
      const prgAbs = resolve(pd, prg_path);
      const outAbs = output_json
        ? resolve(pd, output_json)
        : prgAbs.replace(/\.prg$/i, "_analysis.json");
      // BUG-039 — run as a job: small PRGs settle inside the grace window and
      // return synchronously exactly as before; a large PRG returns a job_id
      // instead of stalling past the host's per-tool limit.
      const job = startAnalysisJob("analyze_prg", outAbs, () =>
        runAnalyzePrg({ pd, prgAbs, outAbs, prg_path, output_json, entry_points }));
      const settled = await waitForJob(job, ANALYZE_JOB_GRACE_MS);
      if (!settled) {
        return { content: [{ type: "text" as const, text: [
          `analyze_prg is still running (large PRG) — switched to background job mode.`,
          `job_id: ${job.id}`,
          `output (when done): ${outAbs}`,
          `Poll with analysis_job_status { job_id } every ~30s. Do NOT re-run analyze_prg for this PRG.`,
        ].join("\n") }] };
      }
      if (job.state === "failed") throw new Error(job.error ?? "analyze_prg failed");
      return job.result as { content: { type: "text"; text: string }[] };
    }),
  );

  server.tool(
    "analysis_job_status",
    "Use to poll a background job started by analyze_prg (PRG too large to finish synchronously) or by runtime_loader_lens (capture too large to fold synchronously) — both hand back a job_id instead of stalling the call. Not for launching the work itself (use analyze_prg / runtime_loader_lens). Returns the full original tool result once done. Inputs: job_id. Returns: running (elapsed) | done (result) | failed (error).",
    {
      job_id: z.string().describe("Job id returned by analyze_prg."),
    },
    safeHandler("analysis_job_status", async ({ job_id }) => {
      const job = getAnalysisJob(job_id);
      if (!job) {
        return { content: [{ type: "text" as const, text:
          `analysis job ${job_id} unknown — the MCP server likely restarted since it was started. ` +
          `The pipeline writes its output to disk regardless: check for the expected _analysis.json next to the PRG.` }] };
      }
      if (job.state === "running") {
        const elapsed = Math.round((Date.now() - job.startedAtMs) / 1000);
        return { content: [{ type: "text" as const, text:
          `${job.tool} job ${job.id}: still running (${elapsed}s elapsed).\noutput (when done): ${job.outputPath}\nPoll again in ~30s.` }] };
      }
      if (job.state === "failed") throw new Error(`${job.tool} job ${job.id} failed: ${job.error}`);
      return job.result as { content: { type: "text"; text: string }[] };
    }),
  );

  /** The original analyze_prg body (pipeline run + knowledge registration),
   *  extracted verbatim so it can run as a background job (BUG-039). Hoisted
   *  function declaration — the analyze_prg handler above closes over it. */
  async function runAnalyzePrg(
    a: { pd: string; prgAbs: string; outAbs: string; prg_path: string; output_json?: string; entry_points?: string[] },
  ): Promise<{ content: { type: "text"; text: string }[] }> {
    const { pd, prgAbs, outAbs, prg_path, entry_points } = a;
    {
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
        result.stdout += describeCodeSeeds(outAbs);
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
      return context.cliResultToContent(result) as { content: { type: "text"; text: string }[] };
    }
  }

  server.tool(
    "disasm_prg",
    "Disassemble a PRG to KickAssembler .asm + 64tass .tas, segment-aware when given an analysis JSON. Use after analyze_prg to get readable assembly, and again to render the final annotated version once you have an annotations file. For relocated/self-relocating loaders (code stored at one address but executed at another), pass `relocations`: each region is rendered as KickAssembler .pseudopc / 64tass .logical at its runtime PC while the stored bytes stay byte-exact — accept the relocation proposals from analyze_prg / propose_annotations (draft.relocations[]) and copy them straight in. Not for the structural scan (use analyze_prg) or for menus/multi-file containers (use disasm_menu). A `<stem>_annotations.json` next to the PRG/ASM is auto-applied: names (labels, routines, a segment's `label`) apply with or without `analysis_json`, while segment kinds and pointer/jump/immediate tables need `analysis_json` — the listing's header line says which happened, and the tool output quotes it back as `Listing:`. Exact shape: labels[{address,label,comment?}], routines[{address,name,comment}], segments[{start,end,kind,label?,comment?}], optional pointerTables/jumpTables/immediates. Hex with or without `$`. Loading is tolerant: a bad/mistyped entry (e.g. `addr` for `address`, `name` for a label's `label`) is skipped and reported as `[annotations] applied N, skipped M` in the output — it never crashes the rebuild. Full reference: docs/annotations-reference.md. Inputs: prg_path, optional analysis_json, entry_points, platform, relocations. Returns: .asm/.tas artifact paths.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from prg_path to knowledge/phase-plan.json."),
      prg_path: z.string().describe("Path to the .prg file"),
      output_asm: z.string().optional().describe("Output path for the .asm file"),
      entry_points: z.array(z.string()).optional().describe("Hex entry point addresses"),
      analysis_json: z.string().optional().describe("Path to a prior analysis JSON for segment-aware disassembly"),
      platform: z.enum(["c64", "c1541"]).optional().describe("target platform for ZP / IO / ROM symbol tables. Default c64. Use c1541 for drive-side disassembly."),
      relocations: z.array(z.object({
        fileStart: z.union([z.string(), z.number()]).describe("Stored/file address of the region's first byte (inclusive). Hex string ($FC00/0xFC00) or number."),
        fileEnd: z.union([z.string(), z.number()]).describe("Stored/file address of the region's last byte (inclusive)."),
        runtimeAddr: z.union([z.string(), z.number()]).describe("Logical execution PC that fileStart runs at."),
        label: z.string().optional().describe("Optional label/comment for the relocated region."),
        subSegments: z.array(z.object({
          start: z.union([z.string(), z.number()]),
          end: z.union([z.string(), z.number()]),
          kind: z.string(),
          label: z.string().optional(),
          comment: z.string().optional(),
        })).optional().describe("Runtime-addressed code/data kind hints inside the region (applied in a later slice; carried through for now)."),
      })).optional().describe("relocated regions, rendered as KickAssembler .pseudopc / 64tass .logical blocks at their runtime PC while the stored bytes stay byte-exact. Omit for normal disassembly."),
    },
    safeHandler("disasm_prg", async ({ project_dir, prg_path, output_asm, entry_points, analysis_json, platform, relocations }) => {
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
      // Spec 741: hand the relocation map to the pipeline via a temp JSON
      // file referenced by --relocations (kept off the positional args).
      let relocationsFile: string | undefined;
      if (relocations && relocations.length > 0) {
        relocationsFile = join(tmpdir(), `c64re-reloc-${randomUUID()}.json`);
        writeFileSync(relocationsFile, `${JSON.stringify(relocations, null, 2)}\n`, "utf8");
      }
      const args: string[] = [];
      if (resolvedPlatform !== "c64") args.push("--platform", resolvedPlatform);
      if (relocationsFile) args.push("--relocations", relocationsFile);
      args.push(prgAbs, outAbs);
      if (entries) args.push(entries);
      if (analysis_json) args.push(resolve(pd, analysis_json));
      // Spec 759 P2 — refresh the project cross-artifact address index so the
      // pipeline can resolve out-of-file calls (jsr into another artifact → its
      // api_* label). Build-on-read writes knowledge/.cache; best-effort.
      try {
        const { loadAddressIndex, loadAbiIndex } = await import("../project-knowledge/address-index.js");
        loadAddressIndex(pd);
        loadAbiIndex(pd); // Spec 759 P3 — ABI jumptable map for transitive resolution
      } catch { /* index is an enhancement; disasm proceeds without it */ }
      const result = await runCli("disasm-prg", args, { projectDir: pd });
      if (result.exitCode === 0) {
        const annotationsPath = outAbs.replace(/\.asm$/i, "_annotations.json");
        // Spec 833 §5c — this used to look ONLY beside the ASM while the
        // renderer looks in three places (beside the PRG, beside the output
        // ASM, beside the analysis JSON — `loadAnnotations` in
        // pipeline/src/lib/annotations.ts). A file in either of the other two
        // therefore produced "NEXT STEP: create an annotations file" printed
        // over a listing that had just applied them. Same resolution order as
        // the renderer, so the wrapper and the thing it wraps agree.
        const annotationCandidates = [
          annotationsPath,
          prgAbs.replace(/\.[^./]+$/, "_annotations.json"),
          ...(analysis_json ? [resolve(pd, analysis_json).replace(/\.[^./]+$/, "_annotations.json")] : []),
          join(dirname(outAbs), "annotations.json"),
          join(dirname(prgAbs), "annotations.json"),
        ];
        const foundAnnotationsPath = annotationCandidates.find((candidate) => existsSync(candidate));
        const hasAnnotations = foundAnnotationsPath !== undefined;
        const tassPath = outAbs.replace(/\.asm$/i, ".tas");
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
        // Spec 833 D3 — what the LISTING did with the annotations, read back
        // from the listing's own header, stated before and separately from what
        // the GRAPH holds. Printed in both branches: the renderer also looks for
        // an annotations file next to the PRG and next to the analysis JSON, so
        // `hasAnnotations` (which looks next to the ASM) is this wrapper's guess,
        // not the renderer's answer.
        result.stdout += `\nListing: ${listingAnnotationStatus(outAbs)}`;
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
          result.stdout += `\nAnnotations file: ${annotationsPath}`;
          // Spec 822 D6: the annotations file is a door — import it into the
          // graph's human layer (routines / labels / segments) when it changed
          // since the last import. Soft fail — disasm success stands even if the
          // import hits an error.
          try {
            const knowledgeService = new ProjectKnowledgeService(pd);
            const sourceArtifact = knowledgeService.listArtifacts().find((a) => a.path === prgAbs);
            const imported = knowledgeService.importAnnotations({ sourcePrgArtifactId: sourceArtifact?.id, annotationsPath });
            // Spec 833 D3 — this line is about the GRAPH and says so. It used to
            // read "Annotations unchanged since the last import (24 routines, 15
            // labels, 5 segments in the graph)", which a caller took for "the
            // annotations are in" — so when the listing then showed `W26D2` the
            // conclusion was that the import was broken. The import was fine; the
            // renderer was not, and the two outcomes had been sharing one line's
            // credibility. The Listing line above is the rendering result.
            result.stdout += imported.changed
              ? `\nGraph: imported ${imported.routines} routines, ${imported.labels} labels, ${imported.segments} segments into the knowledge graph (owner ${imported.owner}) — graph contents, not the listing.`
              : `\nGraph: unchanged since the last import; the graph holds ${imported.routines} routines, ${imported.labels} labels, ${imported.segments} segments — graph contents, not the listing.`;
            if (sourceArtifact) {
              // Spec 057 R26: closed-loop sweep, scoped to this PRG.
              result.stdout += `\n${runAndFormatClosedLoopSweep(knowledgeService, { artifactId: sourceArtifact.id })}`;
            }
          } catch (importError) {
            result.stdout += `\nAnnotations import: FAILED — ${importError instanceof Error ? importError.message : String(importError)}`;
          }
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
    "Generate a markdown RAM-state facts report from an analysis JSON (zero-page + RAM usage). Use after analyze_prg to summarise how the program uses memory. Not for pointer tables (use pointer_report) or raw bytes (use read_artifact). Inputs: analysis JSON path. Returns: markdown report path.",
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
    "Generate a DRAFT annotations file (labels, segment reclassifications, routine names, and relocations) from an analysis JSON + optional disasm. Use to bootstrap semantic annotation before hand-editing. The draft's relocations[] entries are in disasm_prg.relocations shape ({fileStart,fileEnd,runtimeAddr} hex) — copy accepted ones straight into disasm_prg(relocations=[...]) to render relocated loader code as .pseudopc/.logical. When hand-editing the draft, the field shape is: labels[{address,label,comment?}], routines[{address,name,comment}], segments[{start,end,kind,label?,comment?}] (hex with or without `$`) — a mistyped key (`addr`/`name`) is tolerantly skipped, not applied; disasm_prg reports the skip count. Full reference: docs/annotations-reference.md. Not for saving confirmed knowledge (use save_finding / save_entity); it never overwrites a manual annotations file. Inputs: analysis JSON, optional disasm, persist_questions. Returns: draft annotations path.",
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
    "Run the full first-pass PRG reverse-engineering chain end-to-end: register, analyze, disassemble, RAM + pointer reports, import knowledge, rebuild views. Use to bootstrap a fresh PRG in one call. Not for a single step (call analyze_prg / disasm_prg directly). Inputs: prg_path. Returns: done/incomplete/blocked + the next required semantic action.",
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

  // Spec 822.2: `import_annotations_as_findings` (Spec 055 R25) is retired — the
  // annotations file is a door into the graph's human layer (D6), imported by
  // disasm_prg when it changed and by `c64re graph annotations-import <file>`;
  // no finding is minted from it any more.
}
