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
import { scanRegistrationDelta } from "../lib/registration-delta.js";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export interface ProjectInventorySyncResult {
  status: "done" | "blocked" | "failed";
  registered: number;
  importedManifests: number;
  rebuiltViews: string[];
  // Spec 730 §7.3 — artifact version-group reconciliation counts.
  versionGroupsCreated: number;
  versionGroupsUpdated: number;
  versionGroupsNeedDecision: number;
  skipped: Array<{ path: string; reason: string }>;
  remainingProblems: string[];
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

  // 1+2. Register currently-unregistered project files (input media, extracted
  // payloads + raw sectors, analysis sidecars, generated source, AND
  // semantic/hand-curated source — the §7 patterns make BUG-019 files visible).
  const reg = registerProjectFiles(service, projectRoot, DEFAULT_PATTERNS, {
    producedByTool: "project_inventory_sync",
  });
  for (const err of reg.errors) {
    skipped.push({ path: err.relativePath, reason: `could not register: ${err.error}` });
  }
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
      skipped.push({
        path: m.relativePath,
        reason: `manifest not imported: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    // Yield between manifests — a single import is ~0.5s on a large manifest, so
    // importing several back-to-back would block the event loop (Spec 730.3 fix).
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
  try {
    const vg = await service.reconcileArtifactVersionGroups();
    versionGroupsCreated = vg.created;
    versionGroupsUpdated = vg.updated;
    versionGroupsNeedDecision = vg.needsDecision;
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
  const delta = scanRegistrationDelta(projectRoot, 25);
  if (delta.unregisteredCount > 0) {
    remainingProblems.push(
      `${delta.unregisteredCount} file(s) on disk still match no registration pattern (e.g. ${delta.unregistered.slice(0, 3).join(", ")}).`,
    );
    for (const u of delta.unregistered.slice(0, 10)) {
      skipped.push({ path: u, reason: "no inventory pattern covers this file type" });
    }
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
    rebuiltViews,
    versionGroupsCreated,
    versionGroupsUpdated,
    versionGroupsNeedDecision,
    skipped,
    remainingProblems,
    nextStepHint,
  };
}

function renderResult(projectRoot: string, r: ProjectInventorySyncResult): string {
  const lines: string[] = [];
  lines.push(`Project inventory sync — ${r.status}.`);
  lines.push(`Project: ${projectRoot}`);
  lines.push(`Files registered: ${r.registered}`);
  lines.push(`Manifests imported: ${r.importedManifests}`);
  lines.push(`Views rebuilt: ${r.rebuiltViews.length}`);
  for (const v of r.rebuiltViews) lines.push(`  ${v}`);
  lines.push(`Version groups: ${r.versionGroupsCreated} created, ${r.versionGroupsUpdated} updated${r.versionGroupsNeedDecision > 0 ? `, ${r.versionGroupsNeedDecision} need a decision` : ""}.`);
  if (r.versionGroupsNeedDecision > 0) {
    lines.push(`  ${r.versionGroupsNeedDecision} subject(s) have two equally-ranked sources — pick the current version in the Inspector (an open question was raised for each).`);
  }
  if (r.skipped.length > 0) {
    lines.push(``);
    lines.push(`Skipped (${r.skipped.length}):`);
    for (const s of r.skipped.slice(0, 15)) lines.push(`  ${s.path} — ${s.reason}`);
    if (r.skipped.length > 15) lines.push(`  … and ${r.skipped.length - 15} more`);
  }
  if (r.remainingProblems.length > 0) {
    lines.push(``);
    lines.push(`Remaining problems:`);
    for (const p of r.remainingProblems) lines.push(`  ${p}`);
  }
  lines.push(``);
  lines.push(`Next: ${r.nextStepHint}`);
  return lines.join("\n");
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
      return textContent(renderResult(projectRoot, result));
    }),
  );
}
