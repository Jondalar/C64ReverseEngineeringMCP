import { basename, dirname, resolve, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCli } from "../run-cli.js";
import { assembleSource } from "../assemble-source.js";
import { rebuildVerification } from "../lib/rebuild-verify.js";
import { ADDRESS_RULE, parseAddress, parseCount } from "../shared/address-rule.js";
import { suggestDepackers } from "../compression-tools.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { listPayloadEntities } from "../project-knowledge/payload-kinds.js";
import { annotationNames, maxLabelLength, namesTooLong, tooLongMessage } from "../project-knowledge/naming.js";
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
    if (hint.reason) lines.push(`    ${hint.reason}`);
  }
  const top = hints[0]!;
  // A hint under 0.6 is a candidate, not a verdict. The SFX probe only proves that the
  // file's own code decompresses SOMETHING; naming a packer on the strength of that is
  // how a $B3-escape RLE got reported as Exomizer at 0.93.
  if (top.confidence < 0.6) {
    lines.push(`NEXT: no packer is established — the strongest hint is ${top.format} at ${top.confidence.toFixed(2)}, and its reason above says what was and was not shown. Read the depacker stub in the disassembly and identify the codec there before depacking.`);
  } else if (top.format.startsWith("exomizer")) {
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
      .split(/\r?\n/)
      .find((l) => /^\/\/\s+(?:No s|S)emantic annotations/.test(l));
    if (line) return line.replace(/^\/\/\s+/, "");
  } catch {
    // fall through — an unreadable listing is reported as unknown, never as applied
  }
  return "annotation status unknown — the listing header could not be read";
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
      codeSeedReport?: {
        status: string; owner: string; reason?: string; seeds?: Array<{ origin: string }>;
        window?: { start: number; end: number; space: string; bank: number | null; source: string; name: string };
        outOfScope?: Array<{ address: number; detail: string }>;
      };
      rejectedEntryPoints?: Array<{ address: number; reason: string }>;
      strandedByDecodeConflict?: unknown[];
    };
    const lines: string[] = [];
    const seeds = report.codeSeedReport;
    // Spec 867 D1 — the window the seeds were scoped to, said before the seeds.
    const hx = (a: number) => `$${a.toString(16).toUpperCase().padStart(4, "0")}`;
    if (seeds?.window) {
      const w = seeds.window;
      lines.push(`Payload window: ${hx(w.start)}-${hx(w.end)} in ${w.space}${w.bank !== null && w.bank !== undefined ? ` bank ${w.bank}` : ""} — ${w.source === "payload" ? "recorded on the payload record" : "the extent this image was analysed at"}. Graph seeds are scoped to it; a window that loads inside it is that payload's business, not this one's.`);
    }
    if (seeds?.status === "ok" && (seeds.seeds?.length ?? 0) > 0) {
      const byOrigin = new Map<string, number>();
      for (const seed of seeds.seeds ?? []) byOrigin.set(seed.origin, (byOrigin.get(seed.origin) ?? 0) + 1);
      lines.push(`Graph code seeds: ${seeds.seeds!.length} for owner "${seeds.owner}" — ${[...byOrigin].sort().map(([o, n]) => `${o}=${n}`).join(", ")}. Addresses only another overlay reaches are disassembled instead of rendered as .byte; the listing names which seed reached each region.`);
    } else if (seeds && seeds.status !== "ok") {
      // The reason can carry the project's entire owner list. Summarised — an old
      // analysis JSON on disk still holds the long form, so it is cut here too, not
      // only where it is written.
      lines.push(`Graph code seeds: none — ${shortenSeedOwners(seeds.reason ?? seeds.status)}`);
    }
    const outOfScope = seeds?.outOfScope ?? [];
    if (outOfScope.length > 0) {
      lines.push(`Out of scope for this window: ${outOfScope.length} cross-owner address${outOfScope.length === 1 ? "" : "es"} — outside the window, or inside a window that loads inside it. Not refusals: they were never this payload's (codeSeedReport.outOfScope).`);
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

/**
 * ONE address rule, for every address and every byte count these tools accept — and it
 * is not written here. It lives in `src/shared/address-rule.ts`, the only body of code
 * that states it, and the pipeline half compiles the same body as
 * `pipeline/src/lib/address-rule.ts` because ESM and CommonJS cannot import each other.
 * `npm run check:address-rule` proves the two agree and refuses a third copy.
 *
 * It is there rather than here because it has drifted twice. First inside one call:
 * `entry_points` read `"E800"` as hex while the relocation loader ran `parseInt(s, 10)`
 * on it, so `"E800"` became NaN and printed as `null` and `"2000"` became $07D0. That
 * was fixed by writing the rule down — in two files. Then `disasm_raw` was written
 * against the written rule instead of the function, and the pipeline kept four inline
 * `parseInt(x, 16)` sites of its own. A rule stated twice disagrees with itself.
 *
 * The names below are the ones this module has always exported; they now forward.
 */
export { ADDRESS_RULE } from "../shared/address-rule.js";
export const parseAddressStrict = parseAddress;
export const parseCountStrict = parseCount;

const hex16 = (value: number) => `$${(value & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Does this analysis JSON describe the window it is about to be rendered over?
 *
 * Returns the refusal text when it does not, undefined when it does (or when the file
 * says nothing about its own span, which is not something to refuse over).
 */
export function analysisWindowMismatch(
  analysisAbs: string,
  windowStart: number,
  windowEnd: number,
): string | undefined {
  let mapping: { startAddress?: number; endAddress?: number } | undefined;
  try {
    mapping = (JSON.parse(readFileSync(analysisAbs, "utf8")) as {
      mapping?: { startAddress?: number; endAddress?: number };
    }).mapping;
  } catch {
    return `analysis_json ${analysisAbs} could not be read as JSON.`;
  }
  const start = mapping?.startAddress;
  const end = mapping?.endAddress;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  if (start === windowStart && end === windowEnd) return undefined;
  return `analysis_json ${basename(analysisAbs)} describes ${hex16(start)}-${hex16(end)}; this window runs at `
    + `${hex16(windowStart)}-${hex16(windowEnd)}. An analysis of the whole file rendered over a window of it `
    + `produces a listing of the file's segments at the window's addresses and a rebuild that cannot match. `
    + `Run analyze_prg over these bytes (its load_address is this window's), pass no_analysis to render linearly, `
    + `or disassemble the whole file instead.`;
}

/**
 * What to do when the rebuild did not come back byte-identical.
 *
 * The verdict names the assembler's own complaint, which for a packed stream is
 * `relative address is illegal (jump distance is too far: 65471)` — a branch whose
 * target wrapped the address space, which is what a LINEAR decode of compressed bytes
 * produces and nothing else does. The message used to stop there. The remedy is not
 * guessable from it: declare the range as data, or depack first.
 */
export function rebuildRemedy(verdictLine: string, kind: "prg" | "raw"): string {
  if (!/WARNING: rebuild/i.test(verdictLine)) return "";
  const door = kind === "raw" ? "annotations_path" : "a <stem>_annotations.json beside the PRG";
  if (/jump distance is too far|relative address is illegal|branch out of range/i.test(verdictLine)) {
    return "\nWhat this is: a branch whose target wrapped the address space. A linear decode emits one only when the "
      + "bytes are not code — a compressed stream, a depacker's payload, a table. These bytes are probably packed.\n"
      + `Two ways on: declare the range as data — an annotations file with `
      + `segments: [{"start":"$XXXX","end":"$YYYY","kind":"unknown"}] passed as ${door}, after which the bytes render `
      + `as .byte and the rebuild is byte-identical — or depack first (suggest_depacker, then try_depack / `
      + `sandbox_depack) and disassemble the result.`;
  }
  if (/assembler exited/i.test(verdictLine)) {
    return "\nWhat this is: the listing did not reassemble. When the bytes are data read as code, declare the range "
      + `as data — an annotations file with segments: [{"start":"$XXXX","end":"$YYYY","kind":"unknown"}] passed as `
      + `${door} — and the rebuild comes back byte-identical.`;
  }
  return "";
}

/**
 * The seed report's reason, cut down to what a caller can act on.
 *
 * A project with 500 seeded owners printed all 500 names into every analyze_prg
 * answer, every disasm_prg answer and every listing header — by a wide margin the
 * largest single context cost of an autonomous run, and not one of the names was
 * actionable. The count is, and so are the few whose names are near the one asked for.
 * Set `C64RE_GRAPH_SEED_OWNERS=full` to get the whole list back.
 */
export function shortenSeedOwners(reason: string): string {
  const match = /\(seeded owners: ([^)]*)\)/.exec(reason);
  if (!match || process.env.C64RE_GRAPH_SEED_OWNERS === "full") return reason;
  const owners = match[1].split(", ").map((o) => o.trim()).filter(Boolean);
  if (owners.length <= 6 || match[1] === "none") return reason;
  return reason.replace(match[0], `(${owners.length} owners are seeded, e.g. ${owners.slice(0, 3).join(", ")}; C64RE_GRAPH_SEED_OWNERS=full lists them all)`);
}

interface NormalizedRelocation {
  fileStart: number;
  fileEnd: number;
  runtimeAddr: number;
  label?: string;
  subSegments?: Array<{ start: number; end: number; kind: string; label?: string; comment?: string }>;
}

/**
 * Read the relocation list with the one rule, then hold it against the PRG.
 *
 * A relocation outside the file used to throw out of `prg-disasm` and arrive as a node
 * stack trace in the tool result — four times in one run, once for a zero-page entry
 * ($0002-$0024) that was simply a typo for a region inside the file. An entry that
 * cannot be rendered is a validation case, not a crash.
 */
export function normalizeRelocationInput(
  relocations: ReadonlyArray<Record<string, unknown>>,
  prg: { loadAddress: number; lastAddress: number; name: string },
): NormalizedRelocation[] {
  const out: NormalizedRelocation[] = relocations.map((r, i) => ({
    fileStart: parseAddress(r.fileStart, `relocations[${i}].fileStart`),
    fileEnd: parseAddress(r.fileEnd, `relocations[${i}].fileEnd`),
    runtimeAddr: parseAddress(r.runtimeAddr, `relocations[${i}].runtimeAddr`),
    ...(typeof r.label === "string" ? { label: r.label } : {}),
    ...(Array.isArray(r.subSegments)
      ? {
        subSegments: (r.subSegments as Array<Record<string, unknown>>).map((sub, j) => ({
          start: parseAddress(sub.start, `relocations[${i}].subSegments[${j}].start`),
          end: parseAddress(sub.end, `relocations[${i}].subSegments[${j}].end`),
          kind: String(sub.kind ?? "code"),
          ...(typeof sub.label === "string" ? { label: sub.label } : {}),
          ...(typeof sub.comment === "string" ? { comment: sub.comment } : {}),
        })),
      }
      : {}),
  }));

  const hex = (n: number) => `$${(n & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
  const span = `${hex(prg.loadAddress)}-${hex(prg.lastAddress)}`;
  const sorted = [...out].sort((a, b) => a.fileStart - b.fileStart);
  let cursor = -1;
  for (const r of sorted) {
    const i = out.indexOf(r);
    if (r.fileEnd < r.fileStart) {
      throw new Error(`relocations[${i}]: fileEnd ${hex(r.fileEnd)} is before fileStart ${hex(r.fileStart)}.`);
    }
    if (r.fileStart < prg.loadAddress || r.fileEnd > prg.lastAddress) {
      throw new Error(
        `relocations[${i}]: ${hex(r.fileStart)}-${hex(r.fileEnd)} is outside ${prg.name}, which holds ${span}. `
        + `fileStart/fileEnd are STORED addresses inside this PRG; runtimeAddr is where those bytes execute. `
        + `(${ADDRESS_RULE}.)`,
      );
    }
    if (r.fileStart <= cursor) {
      throw new Error(`relocations[${i}]: ${hex(r.fileStart)} overlaps the region ending ${hex(cursor)}. Relocated regions may not overlap.`);
    }
    cursor = r.fileEnd;
  }
  return sorted;
}

/** The stored span a PRG covers, read from its 2-byte load address and its size. */
export function prgSpan(prgAbs: string): { loadAddress: number; lastAddress: number; name: string } {
  const head = readFileSync(prgAbs);
  if (head.length < 3) throw new Error(`${basename(prgAbs)} is too short to be a PRG (${head.length} bytes).`);
  const loadAddress = head[0]! | (head[1]! << 8);
  return { loadAddress, lastAddress: loadAddress + (head.length - 2) - 1, name: basename(prgAbs) };
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
      // One rule for every address in this call (see ADDRESS_RULE).
      let entries: string;
      try {
        entries = (entry_points ?? [])
          .map((e, i) => parseAddress(e, `entry_points[${i}]`).toString(16).toUpperCase().padStart(4, "0"))
          .join(",");
      } catch (e) {
        return { content: [{ type: "text" as const, text: `# disasm_prg refused\n\n${e instanceof Error ? e.message : String(e)}` }] };
      }
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
    "Disassemble a PRG to KickAssembler .asm + 64tass .tas, segment-aware when given an analysis JSON. Use after analyze_prg to get readable assembly, and again to render the final annotated version once you have an annotations file. For relocated/self-relocating loaders (code stored at one address but executed at another), pass `relocations`: each region is rendered as KickAssembler .pseudopc / 64tass .logical at its runtime PC while the stored bytes stay byte-exact — accept the relocation proposals from analyze_prg / propose_annotations (draft.relocations[]) and copy them straight in. Not for the structural scan (use analyze_prg), for menus/multi-file containers (use disasm_menu) or for bytes with no load header (use disasm_raw). An analysis_json named here is the analysis rendered — it is never swapped for the <stem>_analysis.json beside the PRG, and a path that does not exist is refused. A `<stem>_annotations.json` next to the PRG/ASM is auto-applied: names (labels, routines, a segment's `label`) apply with or without `analysis_json`, while segment kinds and pointer/jump/immediate tables need `analysis_json` — the listing's header line says which happened, and the tool output quotes it back as `Listing:`. Exact shape: labels[{address,label,comment?}], routines[{address,name,comment?}], segments[{start,end,kind,label?,comment?}], optional pointerTables/jumpTables/immediates. Hex with or without `$`. Loading is tolerant: a bad/mistyped entry (e.g. `addr` for `address`, `name` for a label's `label`) is skipped and reported as `[annotations] applied N, skipped M` in the output — it never crashes the rebuild. In a project created since 2026-09-19 (project_init stamps it) no label, routine or segment name may be longer than 20 characters: such a file is REFUSED before anything is rendered, and the refusal names every offender. Full reference: docs/annotations-reference.md. Inputs: prg_path, optional analysis_json, entry_points, platform, relocations. Returns: .asm/.tas artifact paths.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from prg_path to knowledge/phase-plan.json."),
      prg_path: z.string().describe("Path to the .prg file"),
      output_asm: z.string().optional().describe("Output path for the .asm file"),
      entry_points: z.array(z.string()).optional().describe("Hex entry point addresses"),
      analysis_json: z.string().optional().describe("Path to a prior analysis JSON for segment-aware disassembly"),
      platform: z.enum(["c64", "c1541"]).optional().describe("target platform for ZP / IO / ROM symbol tables. Default c64. Use c1541 for drive-side disassembly. Naming it RECORDS the machine for this file: its graph nodes are then indexed in the drive's address space, so a boundary asserted with space=\"drv\" over a range the C64 and the 1541 share (e.g. $0300-$07FF) actually contains them."),
      relocations: z.array(z.object({
        fileStart: z.union([z.string(), z.number()]).describe("Stored/file address of the region's first byte (inclusive). An address is HEX: \"FC00\", \"$FC00\" and \"0xFC00\" are the same; a JSON number is taken as-is. Must lie inside the PRG."),
        fileEnd: z.union([z.string(), z.number()]).describe("Stored/file address of the region's last byte (inclusive). Same hex rule as fileStart. Must lie inside the PRG."),
        runtimeAddr: z.union([z.string(), z.number()]).describe("Logical execution PC that fileStart runs at. Same hex rule; unlike fileStart/fileEnd it may be anywhere in the 64K space."),
        label: z.string().optional().describe("Optional label/comment for the relocated region."),
        subSegments: z.array(z.object({
          start: z.union([z.string(), z.number()]),
          end: z.union([z.string(), z.number()]),
          kind: z.string(),
          label: z.string().optional(),
          comment: z.string().optional(),
        })).optional().describe("Runtime-addressed code/data kind hints inside the region (applied in a later slice; carried through for now)."),
      })).optional().describe("relocated regions, rendered as KickAssembler .pseudopc / 64tass .logical blocks at their runtime PC while the stored bytes stay byte-exact. Every address here obeys the same rule as entry_points: hex, with $ or 0x optional. A region outside the PRG, a reversed range or two overlapping regions are refused by name before anything is rendered. Omit for normal disassembly."),
    },
    safeHandler("disasm_prg", async ({ project_dir, prg_path, output_asm, entry_points, analysis_json, platform, relocations }) => {
      const pd = context.projectDir(project_dir ?? prg_path, true);
      const prgAbs = resolve(pd, prg_path);
      const outAbs = output_asm
        ? resolve(pd, output_asm)
        : prgAbs.replace(/\.prg$/i, "_disasm.asm");
      // `entry_points` is the only way an analysis path can still reach the
      // pipeline's entry-point slot, and it is the one shape this door never
      // checked. The renderer's recovery branch then read the JSON as the
      // analysis and printed a note naming a CLI flag the MCP caller cannot
      // pass — advice nobody can act on, over a call that mostly worked.
      // Refused here instead, by name, because the fix is a different parameter.
      for (const [i, raw] of (entry_points ?? []).entries()) {
        const value = String(raw).trim();
        if (value === "") continue;
        try {
          parseAddress(value, `entry_points[${i}]`);
        } catch {
          const isJson = /\.json$/i.test(value);
          return { content: [{ type: "text" as const, text:
            `# disasm_prg refused\n\nentry_points[${i}] = ${JSON.stringify(value)} is not an address — ${ADDRESS_RULE}.`
            + (isJson
              ? `\n\nThat is an analysis JSON. It belongs in analysis_json, which is the parameter that renders a listing segment-aware; entry_points only ever holds addresses.`
              : ``) }] };
        }
      }
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
      // An explicitly named platform is RECORDED, not just used for this render.
      //
      // `platform: "c1541"` chose the drive's ZP/IO/ROM tables and then evaporated:
      // nothing wrote it down, so the graph seeded the owner under the default space
      // and a boundary asserted with space="drv" over $0300-$07FF — the range the C64
      // and the 1541 share, which is exactly the case `space` exists for — contained
      // nothing. The three readers that decide a node's space (`contextForOwner`) look
      // at the artifact record's `platform` and at the declared machine; this door knew
      // the answer and told neither. It reads the artifact record back a few lines up,
      // so it was already half of a loop that was never closed.
      if (platform) {
        try {
          const { declareMachine } = await import("../knowledge-graph/producers/machine.js");
          const { normStem } = await import("../knowledge-graph/migrate/classify.js");
          declareMachine(pd, normStem(basename(prgAbs)), resolvedPlatform);
        } catch { /* the render stands without the declaration; the graph line below reports the space */ }
      }
      // The names an annotations file would store are checked BEFORE rendering, so the
      // listing and the graph never disagree: a project created since 2026-09-19 stores no
      // name over its limit (src/project-knowledge/naming.ts), and a refusal writes nothing.
      const annotationsPathPre = outAbs.replace(/\.asm$/i, "_annotations.json");
      const annotationCandidates = [
        annotationsPathPre,
        prgAbs.replace(/\.[^./]+$/, "_annotations.json"),
        // …and beside the OUTPUT under the PRG's name, which is where
        // `propose_annotations` leaves its draft. Same addition as the renderer's.
        join(dirname(outAbs), basename(prgAbs).replace(/\.[^./]+$/, "") + "_annotations.json"),
        ...(analysis_json ? [resolve(pd, analysis_json).replace(/\.[^./]+$/, "_annotations.json")] : []),
        join(dirname(outAbs), "annotations.json"),
        join(dirname(prgAbs), "annotations.json"),
      ];
      {
        const limit = maxLabelLength(pd);
        const file = limit === undefined ? undefined : annotationCandidates.find((candidate) => existsSync(candidate));
        if (limit !== undefined && file) {
          let names: string[] = [];
          try { names = annotationNames(JSON.parse(readFileSync(file, "utf8"))); } catch { /* the renderer reports a broken file */ }
          const long = namesTooLong(names, limit);
          if (long.length > 0) {
            return { content: [{ type: "text" as const, text: `# disasm_prg refused\n\n${file}\n${tooLongMessage(long, limit)}` }] };
          }
        }
      }
      // Spec 741: hand the relocation map to the pipeline via a temp JSON
      // file referenced by --relocations (kept off the positional args).
      let relocationsFile: string | undefined;
      let normalizedRelocations: ReturnType<typeof normalizeRelocationInput> = [];
      if (relocations && relocations.length > 0) {
        // Parsed and held against the PRG HERE, so a bad entry is a refusal that names
        // the field and the rule — not a node stack trace out of the renderer.
        try {
          normalizedRelocations = normalizeRelocationInput(
            relocations as ReadonlyArray<Record<string, unknown>>,
            prgSpan(prgAbs),
          );
        } catch (e) {
          return { content: [{ type: "text" as const, text: `# disasm_prg refused\n\n${e instanceof Error ? e.message : String(e)}` }] };
        }
        relocationsFile = join(tmpdir(), `c64re-reloc-${randomUUID()}.json`);
        writeFileSync(relocationsFile, `${JSON.stringify(normalizedRelocations, null, 2)}\n`, "utf8");
      }
      const args: string[] = [];
      if (resolvedPlatform !== "c64") args.push("--platform", resolvedPlatform);
      if (relocationsFile) args.push("--relocations", relocationsFile);
      // The analysis JSON travels as a NAMED argument.
      //
      // It used to be pushed onto the positional tail behind the entry-point list —
      // and `entries` is only pushed when there ARE entry points, so a call with an
      // analysis and no entry points put the path in the entry-point slot. The
      // renderer read it as a list of addresses, got NaN, ended up with no analysis,
      // and fell back to the stem-matched `<prg>_analysis.json` beside the PRG. A
      // caller who named `..._analysis_ep.json` and a different output_asm got the
      // OTHER file's segments rendered, with nothing said. A named flag cannot shift.
      if (analysis_json) {
        const analysisAbs = resolve(pd, analysis_json);
        if (!existsSync(analysisAbs)) {
          return { content: [{ type: "text" as const, text: `# disasm_prg refused\n\nanalysis_json ${analysisAbs} does not exist. A named analysis is never swapped for the one beside the PRG — produce it with analyze_prg, fix the path, or leave analysis_json out.` }] };
        }
        args.push("--analysis", analysisAbs);
      }
      args.push(prgAbs, outAbs);
      if (entries) args.push(entries);
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
        // …and on the PRG's own row, which is the other half of the same loop:
        // this door RESOLVES the platform from the artifact record when the caller
        // names none, and nothing ever wrote it there. A second call therefore had
        // to be told again, and the graph's own `contextForArtifact` never saw it.
        if (platform) {
          try {
            const service = new ProjectKnowledgeService(pd);
            const row = service.listArtifacts().find((a) => a.path === prgAbs);
            if (row && row.platform !== resolvedPlatform) {
              service.saveArtifact({ ...row, path: prgAbs, platform: resolvedPlatform });
            }
          } catch { /* the listing stands without the stamp */ }
        }
        const verdictPrg = await rebuildVerification({
          projectDir: pd,
          asmPath: outAbs,
          prgPath: prgAbs,
        });
        const verificationSummary = (() => {
          const line = verdictPrg.line;
          return `${line}${rebuildRemedy(line, "prg")}`;
        })();
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
            // Spec 842 D4 — hand the import the same relocations the listing was
            // rendered with, so a relocated annotation lands in the graph at the
            // address it RUNS at, with the address it is stored at beside it. The
            // graph is what a trace hit, a checkpoint and `whowrote` are joined
            // against, and all three speak runtime.
            // The SAME list the renderer got — parsed once, by the one rule, above.
            const graphRelocations = normalizedRelocations.map((r) => ({
              fileStart: r.fileStart, fileEnd: r.fileEnd, runtimeAddr: r.runtimeAddr,
            }));
            const imported = knowledgeService.importAnnotations({
              sourcePrgArtifactId: sourceArtifact?.id,
              // The path the renderer actually FOUND, not the first candidate.
              //
              // Spec 833 §5c taught the wrapper to look in the same five places as the
              // renderer, so the two agree about whether annotations exist — and then the
              // import was still handed `annotationsPath`, candidate 1, derived from the
              // output ASM. With the file beside the PRG instead, the listing rendered
              // every name while importAnnotations() got a path that does not exist,
              // early-returned {changed:false, routines:0}, and printed "the graph holds 0
              // routines". An unattended run wrote five annotation files, saw its names in
              // the listing, and reported the graph import as broken with no idea why. It
              // was: the two halves were resolving different files.
              annotationsPath: foundAnnotationsPath ?? annotationsPath,
              relocations: graphRelocations.length > 0 ? graphRelocations : undefined,
            });
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
    "disasm_raw",
    "Disassemble raw bytes at an address you already know — a depacked chunk, a relocated overlay, a block lifted out of a track, drive code — with no PRG header and none invented. Use when you hold bytes and their runtime address: give a file path (or an artifact id), optionally a byte window, and load_address. Not for a file that already carries a 2-byte load address (use disasm_prg) and not for the running machine's memory (use runtime_monitor_disasm). Same decoder, renderer, annotations and rebuild proof as disasm_prg: it writes .asm + .tas, reassembles them and reports byte-identical or the first divergence, and registers the listing with its provenance — which file, which byte range, which address. Addresses are HEX with $ or 0x optional; a JSON number is taken as given, and offset/length follow the same rule (\"100\" = 256 bytes, 100 = 100 bytes) — every answer prints the window both ways. Pass entry_points when the block does not start with code: a seed resyncs the linear decode there and the bytes before it render as data. Pass analysis_json for segment-aware rendering; it must describe THIS window and is refused when it describes a different span, nothing is picked up beside the bytes (a <stem>_analysis.json beside a 63 KB image describes the 63 KB image, not a window out of it), and no_analysis refuses one outright. Without one the listing says it had none and reads every byte as code. Annotations it applies are imported into the knowledge graph, the same as through disasm_prg, so a block with no PRG header gets human names in the graph too. Inputs: path or artifact_id, load_address, optional offset/length/entry_points/analysis_json/no_analysis/annotations_path/cpu/bank. Returns: the .asm/.tas paths, the address span, the instruction count, what was seeded, and the rebuild verdict.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json."),
      path: z.string().describe("Path to the file holding the bytes (absolute or project-relative). Use this OR artifact_id.").optional(),
      artifact_id: z.string().optional().describe("Id of an already-registered artifact holding the bytes. Use this OR path."),
      load_address: z.union([z.string(), z.number()]).describe("Where the FIRST byte of the window runs. An address is HEX: \"C000\", \"$C000\" and \"0xC000\" are the same; a JSON number is taken as-is."),
      offset: z.union([z.string(), z.number()]).optional().describe("Byte offset into the file where the block starts. Default 0. Same rule as an address: a string is hex, a JSON number is taken as given."),
      length: z.union([z.string(), z.number()]).optional().describe("How many bytes. Default: to the end of the file. Same rule as offset."),
      entry_points: z.array(z.union([z.string(), z.number()])).optional().describe("Runtime addresses inside the window where code is known to start. Without one the first byte is the only seed. A seed that falls inside a decoded instruction breaks it: the bytes up to the seed render as data and the decode resumes at the seed — byte-exact either way."),
      analysis_json: z.string().optional().describe("Path to an analysis JSON for segment-aware rendering, produced by analyze_prg over THIS window. Nothing is picked up beside the bytes: a <stem>_analysis.json beside a 63 KB image describes the 63 KB image, not a 640-byte window out of it. Without one the listing is linear and says so."),
      no_analysis: z.boolean().optional().describe("Refuse an analysis outright for this render. Nothing is read, nothing is inherited, and the answer says the listing is linear. Use when an analysis exists beside the bytes and you know it does not describe this window."),
      annotations_path: z.string().optional().describe("Path to an annotations file (same shape disasm_prg consumes: labels/routines/segments). Without it, a <stem>_annotations.json beside the bytes or beside the output is picked up as usual. Whatever is applied is imported into the knowledge graph, the same as disasm_prg."),
      output_asm: z.string().optional().describe("Output path for the .asm. Default: analysis/raw-disasm/<stem>[_<window>]_<address>_disasm.asm, and the .tas beside it."),
      cpu: z.enum(["c64", "drive"]).optional().describe("Which 6502 these bytes run on. Default c64. `drive` renders 1541 zero page, VIA registers and drive ROM entry points instead of the C64's."),
      bank: z.number().int().nonnegative().optional().describe("Cartridge bank these bytes belong to, recorded with the listing's provenance."),
      space: z.string().optional().describe("Which memory space these bytes belong to (e.g. \"ram\", \"cart\", \"drive\"), recorded with the listing's provenance."),
    },
    safeHandler("disasm_raw", async (args) => {
      const {
        project_dir, path: rawPath, artifact_id, load_address, offset, length,
        entry_points, analysis_json, no_analysis, annotations_path, output_asm, cpu, bank, space,
      } = args;
      const pd = context.projectDir(project_dir ?? rawPath, true);
      const refuse = (text: string) => ({ content: [{ type: "text" as const, text: `# disasm_raw refused\n\n${text}` }] });

      // ── which bytes ─────────────────────────────────────────────────────────
      if (rawPath && artifact_id) {
        return refuse("path and artifact_id both given. Name the bytes once: a file path, or the id of an artifact already registered (list_artifacts / project_inventory_sync).");
      }
      const service = new ProjectKnowledgeService(pd);
      let sourceAbs: string;
      let sourceArtifactId: string | undefined;
      if (artifact_id) {
        const artifact = service.getArtifactById(artifact_id);
        if (!artifact) return refuse(`No artifact with id ${artifact_id}. List the project's artifacts with list_artifacts, or pass the file with path instead.`);
        sourceAbs = resolve(pd, artifact.path);
        sourceArtifactId = artifact.id;
      } else if (rawPath) {
        sourceAbs = resolve(pd, rawPath);
        sourceArtifactId = service.listArtifacts().find((a) => a.path === sourceAbs)?.id;
      } else {
        return refuse("Neither path nor artifact_id was given. disasm_raw needs the bytes: a file path (absolute or project-relative), or the id of a registered artifact.");
      }
      if (!existsSync(sourceAbs)) return refuse(`${sourceAbs} does not exist.`);
      const fileSize = statSync(sourceAbs).size;
      if (fileSize === 0) return refuse(`${basename(sourceAbs)} is empty — there are no bytes to disassemble.`);

      // ── the one address rule, on every number this tool takes ───────────────
      let loadAddress: number;
      let byteOffset: number;
      let byteLength: number;
      let seeds: number[];
      try {
        loadAddress = parseAddress(load_address, "load_address");
        byteOffset = offset === undefined ? 0 : parseCount(offset, "offset");
        byteLength = length === undefined ? fileSize - byteOffset : parseCount(length, "length");
        seeds = (entry_points ?? []).map((value, index) => parseAddress(value, `entry_points[${index}]`));
      } catch (e) {
        return refuse(e instanceof Error ? e.message : String(e));
      }
      const hex = (value: number) => `$${(value & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
      const both = (value: number) => `${value} ($${value.toString(16).toUpperCase()})`;
      if (byteOffset >= fileSize) {
        return refuse(`offset ${both(byteOffset)} is past the end of ${basename(sourceAbs)}, which holds ${both(fileSize)} bytes. ${ADDRESS_RULE}, and offset follows the same rule — "100" is 256, not 100.`);
      }
      if (byteLength <= 0 || byteOffset + byteLength > fileSize) {
        return refuse(`offset ${both(byteOffset)} + length ${both(byteLength)} runs past the end of ${basename(sourceAbs)}, which holds ${both(fileSize)} bytes. ${ADDRESS_RULE}, and offset/length follow the same rule — "100" is 256, not 100.`);
      }
      const lastAddress = (loadAddress + byteLength - 1) & 0xffff;
      const outside = seeds.filter((seed) => seed < loadAddress || seed > loadAddress + byteLength - 1);
      if (outside.length > 0) {
        return refuse(`entry_points ${outside.map(hex).join(", ")} lie outside ${hex(loadAddress)}-${hex(lastAddress)}, the span these bytes run at. An entry point is a RUNTIME address inside the window, not a file offset. ${ADDRESS_RULE}.`);
      }

      // ── where the listing goes ──────────────────────────────────────────────
      const stem = basename(sourceAbs).replace(/\.[^./]+$/, "");
      const window = byteOffset === 0 && byteLength === fileSize
        ? ""
        : `_${byteOffset.toString(16).toUpperCase().padStart(4, "0")}-${(byteOffset + byteLength - 1).toString(16).toUpperCase().padStart(4, "0")}`;
      const outAbs = output_asm
        ? resolve(pd, output_asm)
        : join(pd, "analysis", "raw-disasm", `${stem}${window}_${hex(loadAddress).slice(1)}_disasm.asm`);
      mkdirSync(dirname(outAbs), { recursive: true });

      // Same pre-render name check as disasm_prg: a project with a name limit refuses
      // the annotations file before anything is written, not after.
      {
        const limit = maxLabelLength(pd);
        const candidate = annotations_path
          ? resolve(pd, annotations_path)
          : [outAbs.replace(/\.asm$/i, "_annotations.json"), sourceAbs.replace(/\.[^./]+$/, "_annotations.json")].find((c) => existsSync(c));
        if (limit !== undefined && candidate && existsSync(candidate)) {
          let names: string[] = [];
          try { names = annotationNames(JSON.parse(readFileSync(candidate, "utf8"))); } catch { /* the renderer reports a broken file */ }
          const long = namesTooLong(names, limit);
          if (long.length > 0) return refuse(`${candidate}\n${tooLongMessage(long, limit)}`);
        }
      }

      // ── render, through the same pipeline verb family as disasm_prg ─────────
      // Every number crosses to the pipeline in the notation the pipeline reads: hex.
      // The two halves already agree on one address rule; handing `--length 256` to a
      // reader that takes a bare string as hex would make it $256, and that is the
      // same defect one rule away from itself.
      const asHex = (value: number) => `$${value.toString(16).toUpperCase()}`;
      const cliArgs: string[] = ["--load-address", asHex(loadAddress)];
      if (byteOffset !== 0) cliArgs.push("--offset", asHex(byteOffset));
      cliArgs.push("--length", asHex(byteLength));
      if (cpu === "drive") cliArgs.push("--platform", "c1541");
      if (annotations_path) {
        const annotationsAbs = resolve(pd, annotations_path);
        if (!existsSync(annotationsAbs)) {
          return refuse(`annotations_path ${annotationsAbs} does not exist. A named annotations file is never swapped for one found beside the bytes — write it, fix the path, or leave annotations_path out.`);
        }
        cliArgs.push("--annotations", annotationsAbs);
      }
      // ── the analysis, and the right to refuse one ───────────────────────────
      //
      // A window is not the file it came out of. Pointed at 640 bytes of a 63 KB
      // image, this tool used to pick up `<stem>_analysis.json` beside that image and
      // render the WHOLE image's segments — 929 instructions and 4082 data lines over
      // 640 bytes, then a rebuild "diverging at body offset 0x0" that was never going
      // to do anything else. Nothing is inherited now: an analysis is used only when
      // it is named, it must describe this window, and `no_analysis` refuses one
      // outright for the caller who knows the sidecar is there and does not apply.
      if (no_analysis && analysis_json) {
        return refuse("analysis_json and no_analysis were both given. Name one: the analysis to use, or none at all.");
      }
      if (no_analysis) cliArgs.push("--no-analysis");
      if (analysis_json) {
        const analysisAbs = resolve(pd, analysis_json);
        if (!existsSync(analysisAbs)) {
          return refuse(`analysis_json ${analysisAbs} does not exist. A named analysis is never swapped for the one beside the bytes — produce it with analyze_prg over this window, or leave analysis_json out.`);
        }
        const mismatch = analysisWindowMismatch(analysisAbs, loadAddress, lastAddress);
        if (mismatch) return refuse(mismatch);
        cliArgs.push("--analysis", analysisAbs);
      }
      cliArgs.push(sourceAbs, outAbs);
      cliArgs.push(seeds.map((seed) => hex(seed).slice(1)).join(","));
      try {
        const { loadAddressIndex, loadAbiIndex } = await import("../project-knowledge/address-index.js");
        loadAddressIndex(pd);
        loadAbiIndex(pd);
      } catch { /* the index is an enhancement; the render proceeds without it */ }
      const result = await runCli("disasm-raw", cliArgs, { projectDir: pd });
      if (result.exitCode !== 0) return context.cliResultToContent(result);

      const tassPath = outAbs.replace(/\.asm$/i, ".tas");
      const provenance =
        `Bytes ${byteOffset}..${byteOffset + byteLength - 1} of ${basename(sourceAbs)} `
        + `(offset ${both(byteOffset)}, length ${both(byteLength)}), running at ${hex(loadAddress)}-${hex(lastAddress)}`
        + `${cpu === "drive" ? ", on the 1541's 6502" : ""}`
        + `${bank !== undefined ? `, bank ${bank}` : ""}${space ? `, space ${space}` : ""}`
        + `. Seeded: ${seeds.length > 0 ? seeds.map(hex).join(", ") : `${hex(loadAddress)} (first byte)`}.`;

      const knowledgeRegistration = context.tryRegisterKnowledgeArtifacts(pd, {
        toolName: "disasm_raw",
        title: `Disassemble bytes: ${basename(sourceAbs)} @ ${hex(loadAddress)}`,
        parameters: {
          source: sourceAbs,
          artifact_id: sourceArtifactId ?? null,
          offset: byteOffset,
          length: byteLength,
          load_address: loadAddress,
          entry_points: seeds.map(hex),
          cpu: cpu ?? "c64",
          bank: bank ?? null,
          space: space ?? null,
          analysis_json: analysis_json ? resolve(pd, analysis_json) : null,
          annotations_path: annotations_path ? resolve(pd, annotations_path) : null,
          output_asm: outAbs,
        },
        notes: [provenance],
        inputs: [{
          path: sourceAbs,
          kind: "raw",
          scope: "input",
          role: "disasm-target",
          producedByTool: "disasm_raw",
        }],
        outputs: [
          { path: outAbs, kind: "listing", scope: "analysis", role: "disasm", format: "asm", producedByTool: "disasm_raw" },
          { path: tassPath, kind: "generated-source", scope: "generated", role: "disasm-tass", format: "tass", producedByTool: "disasm_raw" },
        ],
      });

      // The provenance belongs ON the listing's own row, not only in the run log: a
      // caller who finds the .asm months later must be able to ask what bytes it is.
      const listingArtifactId = (() => {
        try {
          const listing = service.listArtifacts().find((a) => a.path === outAbs);
          if (!listing) return undefined;
          service.saveArtifact({
            id: listing.id,
            kind: listing.kind,
            scope: listing.scope,
            title: listing.title,
            path: outAbs,
            description: provenance,
            format: "asm",
            role: "disasm",
            producedByTool: "disasm_raw",
            platform: cpu === "drive" ? "c1541" : "c64",
            sourceArtifactIds: listing.sourceArtifactIds,
            tags: [...new Set([...(listing.tags ?? []), "disasm_raw", "raw-block"])],
          });
          return listing.id;
        } catch {
          return undefined;
        }
      })();

      // ── prove it ────────────────────────────────────────────────────────────
      const verdict = await rebuildVerification({
        projectDir: pd,
        asmPath: outAbs,
        prgPath: sourceAbs,
        sourceArtifactId,
        compareRange: { offset: byteOffset, length: byteLength },
        compareLabel: `${basename(sourceAbs)} bytes ${byteOffset}..${byteOffset + byteLength - 1}`,
        toolName: "disasm_raw",
        discardCheckOnSuccess: true,
      });

      // ── and tell the payload, when these bytes are one ──────────────────────
      let payloadLine = "";
      if (listingArtifactId) {
        try {
          const payload = listPayloadEntities(service).find((entity) =>
            entity.payloadSourceArtifactId === sourceArtifactId
            || (entity.payloadSourceArtifactId !== undefined && entity.payloadSourceArtifactId === listingArtifactId));
          if (payload && !(payload.payloadAsmArtifactIds ?? []).includes(listingArtifactId)) {
            service.saveEntity({
              id: payload.id,
              kind: payload.kind,
              name: payload.name,
              payloadAsmArtifactIds: [...new Set([...(payload.payloadAsmArtifactIds ?? []), listingArtifactId])],
            });
            payloadLine = `\nPayload: linked to ${payload.name} (${payload.id}) — whichever door created it.`;
          } else if (payload) {
            payloadLine = `\nPayload: already linked to ${payload.name} (${payload.id}).`;
          }
        } catch { /* the link is an enhancement; the listing stands without it */ }
      }

      // ── the names go into the graph, the same as through the PRG door ──────
      //
      // They did not, and disasm_raw is the ONLY door for a block with no PRG header:
      // drive code, a depacked chunk, an overlay. So the listing showed the human's
      // names while the graph held none of them, and `project_critique` reported the
      // drive stage as holding routines and tables with not one human name on them.
      // The workaround an autonomous run reached for was to carve synthetic PRGs and
      // run disasm_prg on them — exactly the thing this door exists to end.
      //
      // The path is the one the RENDERER printed, never a candidate list re-derived
      // here: two halves guessing the same order is how a listing full of names came
      // to sit beside an import that was handed a path that does not exist.
      let graphLine = "";
      const usedAnnotations = /^Annotations used: (.+)$/m.exec(result.stdout)?.[1];
      if (usedAnnotations && usedAnnotations !== "none") {
        try {
          const imported = service.importAnnotations({
            sourcePrgArtifactId: sourceArtifactId ?? listingArtifactId,
            annotationsPath: usedAnnotations,
          });
          graphLine = imported.changed
            ? `\nGraph: imported ${imported.routines} routines, ${imported.labels} labels, ${imported.segments} segments into the knowledge graph (owner ${imported.owner}) — graph contents, not the listing.`
            : `\nGraph: unchanged since the last import; the graph holds ${imported.routines} routines, ${imported.labels} labels, ${imported.segments} segments — graph contents, not the listing.`;
          if (sourceArtifactId ?? listingArtifactId) {
            graphLine += `\n${runAndFormatClosedLoopSweep(service, { artifactId: (sourceArtifactId ?? listingArtifactId)! })}`;
          }
        } catch (importError) {
          graphLine = `\nAnnotations import: FAILED — ${importError instanceof Error ? importError.message : String(importError)}`;
        }
      }

      const seededText = seeds.length > 0
        ? seeds.map(hex).join(", ")
        : `${hex(loadAddress)} (the first byte — no entry point was given)`;
      const verdictLine = verdict.line.replace(/^\/\/\s*/, "");
      result.stdout = [
        result.stdout.trimEnd(),
        `Output: ${outAbs}`,
        `Provenance: ${provenance}`,
        `Seeded: ${seededText}`,
        `${verdictLine}${rebuildRemedy(verdictLine, "raw")}`,
        graphLine.trim(),
        payloadLine.trim(),
        listingArtifactId ? `Artifact: ${listingArtifactId} (re-running with the same arguments updates this row; it does not make a second one).` : "",
        knowledgeRegistration.runPath ? `Knowledge run: ${knowledgeRegistration.runPath}` : (knowledgeRegistration.message ?? ""),
      ].filter(Boolean).join("\n");
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
    "Generate a DRAFT annotations file (labels, segment reclassifications, routine names, and relocations) from an analysis JSON + optional disasm. Use to bootstrap semantic annotation before hand-editing. The draft's relocations[] entries are in disasm_prg.relocations shape ({fileStart,fileEnd,runtimeAddr} hex) — copy accepted ones straight into disasm_prg(relocations=[...]) to render relocated loader code as .pseudopc/.logical. When hand-editing the draft, the field shape is: labels[{address,label,comment?}], routines[{address,name,comment?}], segments[{start,end,kind,label?,comment?}] (hex with or without `$`) — a mistyped key (`addr`/`name`) is tolerantly skipped, not applied; disasm_prg reports the skip count. Full reference: docs/annotations-reference.md. Not for saving confirmed knowledge (use save_finding / save_entity); it never overwrites a manual annotations file. Inputs: analysis JSON, optional disasm, persist_questions. Returns: draft annotations path.",
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
      // Pipeline runs in CommonJS; spawn the child to keep the ESM/CommonJS
      // boundary clean. The child no longer registers the draft — this door does,
      // below, like every other door that produces a file.
      const args = [analysisAbs, draftAbs];
      if (listingAbs) args.push(listingAbs);
      const result = await runCli("propose-annotations", args, { projectDir: pd });
      // The draft was the last output on the MCP path that only the pipeline child
      // named. `disasm_prg` consumes the file this writes, so an unregistered draft
      // is an annotation nobody can trace back to the run that proposed it.
      if (result.exitCode === 0 && existsSync(draftAbs)) {
        const reg = context.tryRegisterKnowledgeArtifacts(pd, {
          toolName: "propose_annotations",
          title: `Annotation draft: ${basename(analysisAbs)}`,
          parameters: {
            analysis_json: analysisAbs,
            output_path: draftAbs,
            listing_path: listingAbs ?? null,
          },
          inputs: [
            { path: analysisAbs, kind: "other", scope: "analysis", role: "analysis-json", format: "json", producedByTool: "propose_annotations" },
            ...(listingAbs && existsSync(listingAbs)
              ? [{ path: listingAbs, kind: "generated-source" as const, scope: "analysis" as const, role: "disasm", format: "asm", producedByTool: "propose_annotations" }]
              : []),
          ],
          outputs: [{
            path: draftAbs,
            kind: "report",
            scope: "analysis",
            role: "annotation-draft",
            format: "json",
            producedByTool: "propose_annotations",
          }],
        });
        if (reg.runPath) result.stdout = `${result.stdout ?? ""}\nKnowledge run: ${reg.runPath}`;
        // A registration that failed leads the answer; it never trails a success.
        else if (reg.failed && reg.message) result.stdout = `${reg.message}\n\n${result.stdout ?? ""}`;
      }
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
