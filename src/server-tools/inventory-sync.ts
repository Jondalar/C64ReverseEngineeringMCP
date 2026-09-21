// Spec 730.3 — project_inventory_sync: the single DEFAULT product facade over
// the internal registration / manifest-import / view-rebuild helpers.
//
// It is the callable action a normal LLM runs when media/files are present but
// not registered, manifests exist but were never imported, or views are stale.
// It NEVER tells the LLM to call an internal helper (register_existing_files /
// scan_registration_delta / import_manifest_artifact) — those are wrapped here.
//
// Guarantees:
//   - idempotent: a second run registers nothing new, imports nothing twice,
//     creates no duplicate artifacts, and never fails for being a repeat.
//   - never moves/copies/renames/deletes files (file movement belongs to
//     project_init). It may report a suggestedMove but never acts on it.
//   - path-portable: operates on the resolved project root, never repo samples/.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { DEFAULT_PATTERNS, registerProjectFiles } from "./registration.js";
import { scanRegistrationDelta, findUnimportedAnalysisArtifacts } from "../lib/registration-delta.js";
import { diagnoseEmptyPattern, howToDeclare, howToSilenceToolOutput, INVENTORY_PATTERNS_FILE, readInventoryDeclaration } from "../project-knowledge/inventory-patterns.js";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export interface ProjectInventorySyncResult {
  status: "done" | "blocked" | "failed";
  registered: number;
  importedManifests: number;
  /** Analysis-run artifacts back-filled into the knowledge layer this pass. */
  importedAnalysisRuns: number;
  rebuiltViews: string[];
  // Spec 730 §7.3 — artifact version-group reconciliation counts.
  versionGroupsCreated: number;
  versionGroupsUpdated: number;
  /** Ties that survived the rules and still owe a human answer. */
  versionGroupsNeedDecision: number;
  /** Ties settled by rule — identical bytes, or purely generated output. */
  versionTiesAutoResolved: number;
  /** A few of those, spelled out: which subject, which rule, which file won. */
  versionTiesAutoResolvedSample: string[];
  /** Open questions the reconciliation filed: one per subject, or one for the class. */
  versionQuestionsFiled: number;
  skipped: Array<{ path: string; reason: string }>;
  /** How many files were skipped IN ALL. `skipped` carries a sample of them. */
  skippedTotal: number;
  remainingProblems: string[];
  /** Tool-produced files on disk that no pattern registered — reported, not silent. */
  unregisteredToolOutput: number;
  unregisteredToolOutputByDir: Record<string, number>;
  /** What registering that bulk would add to the coverage denominator (BUG-060 defect 1). */
  unregisteredToolOutputBytes: number;
  nextStepHint: string;
}

// Run the full inventory sync against an already-resolved project root.
// Pure orchestration over service methods — returns the Spec 730.3 result
// shape. Safe to call repeatedly.
//
// ASYNC + cooperatively scheduled (Spec 730.3 fix): the phases (register /
// import / reconcile / view-rebuild) are each CPU-bound and, run back-to-back
// synchronously, block the node event loop for several seconds on a large
// project. When this runs inside an MCP tool that talks stdio JSON-RPC, the
// blocked loop can't service the transport and the client drops the connection
// as unresponsive. Yielding (`breathe()`) between phases keeps the loop alive.
export async function runProjectInventorySync(
  service: ProjectKnowledgeService,
  projectRoot: string,
): Promise<ProjectInventorySyncResult> {
  const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));
  const skipped: Array<{ path: string; reason: string }> = [];
  const remainingProblems: string[] = [];
  let skippedTotal = 0;

  // 1+2. Register currently-unregistered project files (input media, extracted
  // payloads + raw sectors, analysis sidecars, generated source, AND
  // semantic/hand-curated source — the §7 patterns make BUG-019 files visible).
  // The project's own declared patterns come FIRST: registration is first-match-wins,
  // and a project saying what its own directory holds outranks a shipped default.
  const declared = readInventoryDeclaration(projectRoot);
  if (declared.error) remainingProblems.push(declared.error);
  const emptyPatternNotes: string[] = [];
  // A declaration entry that could not be applied is named, with the entry index and
  // what is allowed. It used to be dropped by a `typeof` filter without a word, so a
  // project that wrote `kind: "annotations"` saw a file that looked accepted and
  // changed nothing — and the only enum it was ever shown came from a different door.
  for (const p of declared.problems) remainingProblems.push(p);
  const reg = registerProjectFiles(
    service,
    projectRoot,
    [...declared.patterns as unknown as typeof DEFAULT_PATTERNS, ...DEFAULT_PATTERNS],
    { producedByTool: "project_inventory_sync" },
  );
  for (const err of reg.errors) {
    skippedTotal += 1;
    if (skipped.length < SKIPPED_SAMPLE) skipped.push({ path: err.relativePath, reason: `could not register: ${err.error}` });
  }
  // A declared pattern that matched nothing is named, with what IS in that
  // directory and a pattern that would cover it. Shipped defaults are not
  // reported: most of them match nothing in most projects, and that is normal.
  for (const pattern of declared.patterns) {
    if ((reg.matchesByGlob[pattern.glob] ?? 0) === 0) {
      emptyPatternNotes.push(...diagnoseEmptyPattern(projectRoot, pattern.glob, reg.candidates));
    }
  }
  remainingProblems.push(...emptyPatternNotes);
  await breathe();

  // 3. Import disk/CRT/PRG manifests when present. importManifestArtifact uses
  // stable ids + a purge-then-resave, so re-importing the same manifest is a
  // no-op on the record set (idempotent). Non-manifest "manifest"-kind files
  // that don't parse are reported as skipped, not failures.
  let importedManifests = 0;
  const manifests = service.listArtifacts().filter((a) => a.kind === "manifest");
  for (const m of manifests) {
    try {
      service.importManifestArtifact(m.id);
      importedManifests += 1;
    } catch (e) {
      skippedTotal += 1;
      if (skipped.length < SKIPPED_SAMPLE) {
        skipped.push({
          path: m.relativePath,
          reason: `manifest not imported: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    // Yield between manifests — a single import is ~0.5s on a large manifest, so
    // importing several back-to-back would block the event loop (Spec 730.3 fix).
    await breathe();
  }

  // 3a. Back-fill analysis-run artifacts whose entities were never imported.
  //
  // The audit used to say "Run `bulk_import_analysis_reports` to back-fill the
  // knowledge layer" — a tool that is ADVANCED tier and therefore not on the default
  // surface at all, so the session it was addressed to could not call it and
  // ToolSearch found nothing by that name. The facade exists to be the door for
  // exactly this; it was simply missing this phase.
  let importedAnalysisRuns = 0;
  for (const a of findUnimportedAnalysisArtifacts(service)) {
    try {
      service.importAnalysisArtifact(a.id);
      importedAnalysisRuns += 1;
    } catch (e) {
      skippedTotal += 1;
      if (skipped.length < SKIPPED_SAMPLE) skipped.push({ path: a.relativePath, reason: `analysis not imported: ${e instanceof Error ? e.message : String(e)}` });
    }
    await breathe();
  }

  // 3b. Spec 730 §7.3 — reconcile artifact version groups so the "current best
  // version" model reflects what is now on disk. Conservative: auto-current only
  // on an unambiguous rank, never overwrites a manual choice, opens an open
  // question (needsDecision) on a genuine rank tie. Closes BUG-019 Part B —
  // a hand-made/semantic source becomes the default over a stale generated dump.
  let versionGroupsCreated = 0;
  let versionGroupsUpdated = 0;
  let versionGroupsNeedDecision = 0;
  let versionTiesAutoResolved = 0;
  let versionTiesAutoResolvedSample: string[] = [];
  let versionQuestionsFiled = 0;
  try {
    const vg = await service.reconcileArtifactVersionGroups();
    versionGroupsCreated = vg.created;
    versionGroupsUpdated = vg.updated;
    versionGroupsNeedDecision = vg.needsDecision;
    versionTiesAutoResolved = vg.autoResolved;
    versionTiesAutoResolvedSample = vg.autoResolvedSample;
    versionQuestionsFiled = vg.questionsFiled;
  } catch (e) {
    remainingProblems.push(`Version reconciliation issue: ${e instanceof Error ? e.message : String(e)}`);
  }
  await breathe();

  // 4. Full rebuild of project views (MVP: always full, correctness over
  // incremental invalidation — §9). Cooperative variant yields between views so
  // the MCP stdio transport stays serviced during the rebuild (Spec 730.3 fix).
  const rebuiltViews: string[] = [];
  let status: ProjectInventorySyncResult["status"] = "done";
  try {
    const views = await service.buildAllViewsCooperative();
    rebuiltViews.push(
      views.projectDashboard.path,
      views.memoryMap.path,
      views.diskLayout.path,
      views.cartridgeLayout.path,
      views.loadSequence.path,
      views.flowGraph.path,
      views.annotatedListing.path,
    );
  } catch (e) {
    status = "failed";
    remainingProblems.push(`View rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 5. Report what remains. After registration, anything still unregistered is a
  // pattern gap the operator should know about (reported, never silently moved).
  //
  // The skipped list used to be hard-capped at ten AND counted from the capped list, so
  // the header said "Skipped (10)" for 616 files — a number that is always 10 is not a
  // number. The sample stays a sample; the count is the truth.
  //
  // The split between "debt" and "the project said so" is made by the SHARED scan, not
  // here: that is the whole of defect 3. `agent_record_step` and this facade read the
  // same two numbers out of the same call, so they can no longer contradict each other
  // about the same files.
  const delta = scanRegistrationDelta(projectRoot, 100000, declared);
  const unexplained = delta.unregistered;
  if (unexplained.length > 0) {
    remainingProblems.push(
      `${unexplained.length} file(s) on disk match no registration pattern (e.g. ${unexplained.slice(0, 3).join(", ")}).`,
      ...howToDeclare(unexplained),
    );
  }
  if (delta.declaredIntentionalCount > 0) {
    remainingProblems.push(`${delta.declaredIntentionalCount} further file(s) are declared intentional in ${INVENTORY_PATTERNS_FILE} and are not counted.`);
  }
  skippedTotal += unexplained.length;
  for (const u of unexplained) {
    if (skipped.length >= SKIPPED_SAMPLE) break;
    skipped.push({ path: u, reason: "no inventory pattern covers this file type" });
  }
  // Tool-produced files nothing registered used to be invisible here: only the
  // HUMAN debt list was reported, so a project whose own outputs matched no
  // pattern saw a clean sync and 207 unregistered files. The count and the
  // directories are the report; the full list is in the report file.
  //
  // BUG-060 defect 1: the count used to be ALL this said, and "registered by nothing"
  // reads as debt. One caller registered 2732 per-sector dumps on the strength of it
  // and cost the project two thirds of its coverage. The line now says what they are,
  // what registering them costs, and which key settles it — `howToSilenceToolOutput`
  // is the one place that answers for a tool's bulk.
  if (delta.toolOutputCount > 0) {
    const dirs = Object.entries(delta.toolOutputByDir).sort((a, b) => b[1] - a[1]);
    remainingProblems.push(
      `${delta.toolOutputCount} tool-produced file(s) are on disk and registered by nothing`
      + ` — ${dirs.slice(0, 4).map(([dir, n]) => `${n} in ${dir || "."}/`).join(", ")}${dirs.length > 4 ? `, …` : ""}.`,
      ...howToSilenceToolOutput(delta.toolOutputByDir, delta.toolOutputBytesByDir, delta.toolOutputBytes),
    );
  }

  // 6. Next-step hint — product concepts only, never internal helper names.
  let nextStepHint: string;
  if (status === "failed") {
    nextStepHint = "Inventory sync hit a view-rebuild error. Re-run project_inventory_sync; if it persists, inspect the project knowledge store for a corrupt record.";
  } else if (remainingProblems.length > 0) {
    nextStepHint = "Some files on disk are not covered by any inventory pattern. Confirm they belong in the project, then continue with analysis (analyze_prg) or disassembly (disasm_prg) of the registered payloads.";
  } else if (reg.registered === 0 && importedManifests === 0) {
    nextStepHint = "Inventory is already in sync. Continue with the next analysis step (inspect_disk / analyze_prg / disasm_prg) or check agent_propose_next.";
  } else {
    nextStepHint = "Inventory synced. Continue with media inspection / analysis (inspect_disk, analyze_prg) of the newly registered payloads.";
  }

  return {
    status,
    registered: reg.registered,
    importedManifests,
    importedAnalysisRuns,
    unregisteredToolOutput: delta.toolOutputCount,
    unregisteredToolOutputByDir: delta.toolOutputByDir,
    unregisteredToolOutputBytes: delta.toolOutputBytes,
    rebuiltViews,
    versionGroupsCreated,
    versionGroupsUpdated,
    versionGroupsNeedDecision,
    versionTiesAutoResolved,
    versionTiesAutoResolvedSample,
    versionQuestionsFiled,
    skipped,
    skippedTotal,
    remainingProblems,
    nextStepHint,
  };
}

/** How many skipped files the report names before it starts counting instead. */
const SKIPPED_SAMPLE = 15;

/**
 * What a tool result may cost the reader.
 *
 * One `project_inventory_sync` came back at 146 728 characters over 5 833 lines
 * and blew the client's tool-result limit, so the ONE fact the caller needed —
 * what is still not registered and why — was in a wall nobody could read. A
 * result that cannot be read is worse than a short one that names where the
 * detail is. Everything elided here is written to the report file, in full, and
 * the answer names it.
 */
const MAX_RESULT_CHARS = 8000;
const MAX_PROBLEM_LINES = 24;
const MAX_LINE_CHARS = 400;
const REPORT_FILE = "knowledge/inventory-sync-report.md";

function clip(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

/** Everything, unclipped. Written to disk, never returned as the tool result. */
function renderFullReport(projectRoot: string, r: ProjectInventorySyncResult): string {
  const lines: string[] = [
    `# Inventory sync — ${r.status}`,
    "",
    `Project: ${projectRoot}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "This is the full detail behind the `project_inventory_sync` answer. The tool",
    "result carries the counts and a sample; everything else is here.",
    "",
    `## Counts`,
    "",
    `- files registered: ${r.registered}`,
    `- manifests imported: ${r.importedManifests}`,
    `- analysis runs back-filled: ${r.importedAnalysisRuns}`,
    `- views rebuilt: ${r.rebuiltViews.length}`,
    `- version groups: ${r.versionGroupsCreated} created, ${r.versionGroupsUpdated} updated, ${r.versionGroupsNeedDecision} needing a decision`,
    `- skipped: ${r.skippedTotal}`,
    `- tool-produced files nothing registered: ${r.unregisteredToolOutput} (${r.unregisteredToolOutputBytes} bytes — what registering them would add to the coverage denominator)`,
    "",
    "## Views rebuilt",
    "",
    ...r.rebuiltViews.map((v) => `- ${v}`),
  ];
  if (r.skipped.length > 0) {
    lines.push("", `## Skipped (sample of ${r.skippedTotal})`, "");
    for (const sk of r.skipped) lines.push(`- ${sk.path} — ${sk.reason}`);
  }
  if (r.unregisteredToolOutput > 0) {
    lines.push("", `## Tool-produced files nothing registered (${r.unregisteredToolOutput}, ${r.unregisteredToolOutputBytes} bytes), by directory`, "");
    for (const [dir, n] of Object.entries(r.unregisteredToolOutputByDir).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${n}  ${dir || "."}/`);
    }
    lines.push(
      "",
      "Machine output — the run's manifest is the artifact that stands for them. Registering",
      "them adds those bytes to the COVERAGE denominator and nothing to what is understood;",
      "declare them `intentional` (the declaration is under Remaining problems below), and",
      "unregister_files(glob=…) takes a bulk back out if one was registered by mistake.",
    );
  }
  if (r.remainingProblems.length > 0) {
    lines.push("", "## Remaining problems", "");
    for (const problem of r.remainingProblems) lines.push(problem.startsWith("  ") ? problem : `- ${problem}`);
  }
  lines.push("", `Next: ${r.nextStepHint}`, "");
  return lines.join("\n");
}

function renderResult(projectRoot: string, r: ProjectInventorySyncResult, reportPath?: string): string {
  const lines: string[] = [];
  lines.push(`Project inventory sync — ${r.status}.`);
  lines.push(`Project: ${projectRoot}`);
  lines.push(`Files registered: ${r.registered}`);
  lines.push(`Manifests imported: ${r.importedManifests}`);
  lines.push(`Analysis runs back-filled into the knowledge layer: ${r.importedAnalysisRuns}`);
  lines.push(`Views rebuilt: ${r.rebuiltViews.length}`);
  for (const v of r.rebuiltViews) lines.push(`  ${v}`);
  lines.push(`Version groups: ${r.versionGroupsCreated} created, ${r.versionGroupsUpdated} updated${r.versionGroupsNeedDecision > 0 ? `, ${r.versionGroupsNeedDecision} need a decision` : ""}.`);
  // Ties the rules settled are reported, never asked. Same bytes at two paths is one
  // listing; two generated dumps are one deterministic run. Saying WHICH file won is
  // the whole difference between a rule and a guess.
  if (r.versionTiesAutoResolved > 0) {
    lines.push(`  ${r.versionTiesAutoResolved} rank tie(s) settled by rule (identical bytes, or generated output only) — no decision needed:`);
    for (const s of r.versionTiesAutoResolvedSample) lines.push(`    ${s}`);
    if (r.versionTiesAutoResolved > r.versionTiesAutoResolvedSample.length) {
      lines.push(`    … and ${r.versionTiesAutoResolved - r.versionTiesAutoResolvedSample.length} more, same rules. list_artifact_versions(subject_id=…) shows any of them.`);
    }
  }
  if (r.versionGroupsNeedDecision > 0) {
    lines.push(`  ${r.versionGroupsNeedDecision} subject(s) have two equally-ranked HAND-AUTHORED sources — settle one with set_current_artifact_version(subject_id=…, artifact_id=…).`);
    lines.push(r.versionQuestionsFiled === 1 && r.versionGroupsNeedDecision > 1
      ? `  One open question covers all ${r.versionGroupsNeedDecision} (too many to ask one by one); it names the subjects.`
      : `  ${r.versionQuestionsFiled} open question(s) were raised — one per subject.`);
  }
  if (r.skippedTotal > 0) {
    lines.push(``);
    lines.push(`Skipped (${r.skippedTotal}${r.skipped.length < r.skippedTotal ? `, showing ${r.skipped.length}` : ""}):`);
    for (const s of r.skipped) lines.push(clip(`  ${s.path} — ${s.reason}`));
    if (r.skippedTotal > r.skipped.length) lines.push(`  … and ${r.skippedTotal - r.skipped.length} more — the full list is in the report file named below`);
  }
  if (r.unregisteredToolOutput > 0) {
    lines.push(``);
    // The warning rides in the always-shown section, never behind the problem-line
    // cap: it is the one a caller acted on wrongly. The paste-able declaration is a
    // remaining problem like the others, and the report file always holds it.
    lines.push(`Tool-produced files nothing registered: ${r.unregisteredToolOutput} (${r.unregisteredToolOutputBytes} bytes)`);
    lines.push(`  Machine output — the run's manifest is the artifact that stands for them. Registering them adds those bytes to the COVERAGE denominator and nothing to what is understood; declare them \`intentional\` instead (see Remaining problems), and unregister_files(glob=…) takes a bulk back out if one was registered by mistake.`);
  }
  if (r.remainingProblems.length > 0) {
    lines.push(``);
    lines.push(`Remaining problems:`);
    for (const p of r.remainingProblems.slice(0, MAX_PROBLEM_LINES)) lines.push(clip(`  ${p}`));
    if (r.remainingProblems.length > MAX_PROBLEM_LINES) {
      lines.push(`  … and ${r.remainingProblems.length - MAX_PROBLEM_LINES} more, in the report file named below`);
    }
  }
  if (reportPath) {
    lines.push(``);
    lines.push(`Full detail: ${reportPath}`);
  }
  lines.push(``);
  lines.push(`Next: ${r.nextStepHint}`);
  const text = lines.join("\n");
  // The last resort. Nothing above should be able to run away, but a tool result
  // that cannot be read is the failure this is guarding against, so it is capped
  // rather than trusted.
  if (text.length <= MAX_RESULT_CHARS) return text;
  const head = text.slice(0, MAX_RESULT_CHARS - 200);
  return `${head.slice(0, head.lastIndexOf("\n"))}\n\n… cut at ${MAX_RESULT_CHARS} characters${reportPath ? ` — the whole answer is in ${reportPath}` : ""}.\nNext: ${r.nextStepHint}`;
}

export function registerInventorySyncTool(server: McpServer, ctx: ServerToolContext): void {
  server.tool(
    "project_inventory_sync",
    "Bring the project knowledge store in sync with what is on disk: register project files that are present but not yet tracked (input media, extracted payloads + raw sectors, analysis sidecars, generated AND hand-written/semantic source under analysis folders), import any disk/CRT/PRG manifests, and rebuild every project view so the UI and dashboard reflect the current state. Use after extraction / disassembly / import, or whenever onboarding or a project audit reports unregistered files, unimported manifests, or stale views. Idempotent — safe to run repeatedly; a second run changes nothing. It reads/writes the project knowledge store and project views only; it never moves, copies, renames, or deletes files (organizing media into input/ folders is project_init's job). Not for creating a project (use project_init) or extracting bytes from media (use extract_disk / extract_crt). Inputs: optional project dir (absolute or project-relative). Returns: counts registered/imported, the rebuilt views, any skipped files with reasons, and the suggested next step.",
    {
      project_dir: z.string().optional().describe("Project root directory. Absolute or project-relative; defaults to C64RE_PROJECT_DIR or the active project."),
    },
    safeHandler("project_inventory_sync", async ({ project_dir }: { project_dir?: string }) => {
      const projectRoot = ctx.projectDir(project_dir);
      const service = new ProjectKnowledgeService(projectRoot);
      const result = await runProjectInventorySync(service, projectRoot);
      // The full detail goes to a file, always, so the short answer can name it
      // rather than carrying it. Best-effort: a project whose knowledge/ cannot
      // be written still gets its answer.
      let reportPath: string | undefined;
      try {
        const abs = join(projectRoot, REPORT_FILE);
        mkdirSync(join(projectRoot, "knowledge"), { recursive: true });
        writeFileSync(abs, renderFullReport(projectRoot, result), "utf8");
        reportPath = relative(projectRoot, abs).replace(/\\/g, "/");
      } catch { /* the answer stands without it */ }
      return textContent(renderResult(projectRoot, result, reportPath));
    }),
  );
}
