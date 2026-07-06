// Spec 730.4 — the step orchestrator: agent_next_step + minimal agent_run_step.
//
// agent_next_step is the MCP-owned "what do I do now" tool for a normal external
// LLM. It reads the machine-readable workflow model (workflow-model.ts) for all
// step ids / phase ids / tool names / branch ids / completion checks, and
// computes ONLY the explanation, counts, concrete paths, and human prompts from
// real project state. Every suggested tool is a DEFAULT-surface tool. Internal
// maintenance tools appear ONLY in `doNotCall`, never as a suggested action.
//
// agent_run_step runs a selected step. For 730.4 it implements the
// inventory/media-sync step in-process (delegating to runProjectInventorySync,
// the 730.3 facade). Steps it does not implement yet return a clean
// "blocked"/"failed" with one concrete next action — never a crash.

import { existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { hasProjectMarker } from "../project-root.js";

// Knowledge / view file sets used for the orchestrator's own stale-view signal.
// We compute staleness with a grace window because project_inventory_sync's view
// rebuild is immediately followed by a workflow-state.json self-touch (same sync
// transaction), which would otherwise mark every just-rebuilt view "stale" by a
// few ms and loop agent_next_step on inventory-sync forever (§11 step-loop guard).
const KNOWLEDGE_FILES_FOR_STALE = [
  "knowledge/entities.json", "knowledge/findings.json", "knowledge/relations.json",
  "knowledge/flows.json", "knowledge/tasks.json", "knowledge/open-questions.json",
  "knowledge/artifacts.json",
];
const VIEW_FILES_FOR_STALE = [
  "views/project-dashboard.json", "views/memory-map.json", "views/cartridge-layout.json",
  "views/disk-layout.json", "views/load-sequence.json", "views/flow-graph.json",
  "views/annotated-listing.json",
];
// A view counts as stale only when it is missing, or older than the newest
// knowledge file by more than this many ms (real edits, not same-transaction
// write-ordering jitter).
const STALE_VIEW_GRACE_MS = 2000;

function countStaleViews(projectRoot: string): number {
  let newestKnowledge = 0;
  for (const rel of KNOWLEDGE_FILES_FOR_STALE) {
    const full = join(projectRoot, rel);
    if (!existsSync(full)) continue;
    newestKnowledge = Math.max(newestKnowledge, statSync(full).mtimeMs);
  }
  if (newestKnowledge === 0) return 0;
  let stale = 0;
  for (const rel of VIEW_FILES_FOR_STALE) {
    const full = join(projectRoot, rel);
    if (!existsSync(full)) { stale += 1; continue; }
    if (statSync(full).mtimeMs < newestKnowledge - STALE_VIEW_GRACE_MS) stale += 1;
  }
  return stale;
}
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { auditProject } from "../project-knowledge/audit.js";
import { matchesGlob, scanRegistrationDelta } from "../lib/registration-delta.js";
import { DEFAULT_PATTERNS } from "./registration.js";
import {
  C64RE_WORKFLOW_STEPS,
  FORBIDDEN_PRODUCT_TOOLS,
  workflowStep,
  type WorkflowStep,
} from "../agent-orchestrator/workflow-model.js";
import { runProjectInventorySync } from "./inventory-sync.js";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

// ESM-safe project-initialized check. (The shared error-helpers.isProjectInitialised
// uses require() and silently returns false under ESM, so it cannot be used
// here.) The agreed marker is knowledge/phase-plan.json (see src/project-root.ts
// hasProjectMarker; workflow-state.json is the secondary marker).
function projectInitialized(projectRoot: string): boolean {
  // Canonical marker predicate (phase-plan.json OR workflow-state.json), shared
  // with the resolver + c64re_whats_next so no init-check drifts stricter.
  return hasProjectMarker(projectRoot);
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// The orchestrator MUST run against an UNINITIALIZED directory so it can
// recommend project-init. The strict ctx.projectDir resolver requires the
// knowledge marker and throws on a fresh dir — wrong for this tool. Resolve the
// raw path the same path-portable way project_init does (absolute hint, else
// C64RE_PROJECT_DIR, else cwd), keeping only the "/" and existence guards. No
// repo-samples fallback (§9).
function resolveOrchestratorRoot(hintPath?: string): string {
  const env = process.env.C64RE_PROJECT_DIR?.trim();
  const root = hintPath?.trim()
    ? resolve(process.cwd(), hintPath)
    : env
      ? resolve(env)
      : resolve(process.cwd());
  if (root === "/") {
    throw new Error("Refusing to use '/' as a project root. Pass project_dir or set C64RE_PROJECT_DIR.");
  }
  if (!existsSync(root)) {
    throw new Error(`Project directory does not exist: ${root}. Create it (or pass an existing project_dir) before asking for the next step.`);
  }
  if (!statSync(root).isDirectory()) {
    throw new Error(`Resolved project path is not a directory: ${root}.`);
  }
  return root;
}

// ---------------------------------------------------------------------------
// §5.3 result shapes
// ---------------------------------------------------------------------------

export interface AgentStepSuggestion {
  stepId: string;
  phase: string;
  tool?: string;
  args?: Record<string, unknown>;
  label: string;
  why: string;
  completionChecks: string[];
}

export interface AgentNextStepResult {
  project: { name: string; dir: string };
  primary: AgentStepSuggestion;
  branches: AgentStepSuggestion[];
  blockedBy: Array<{ id: string; prompt: string; choices?: string[] }>;
  doNotCall: string[];
}

// ---------------------------------------------------------------------------
// Real project-state signals (§5.2 priority ladder inputs)
// ---------------------------------------------------------------------------

interface ProjectSignals {
  initialized: boolean;
  // inventory dirty
  unregisteredFiles: number;
  unregisteredExamples: string[];
  unimportedManifests: number;
  staleViews: number;
  // media / payloads / analysis / source
  mediaArtifacts: number;            // input .d64/.g64/.crt/.prg present as artifacts
  hasG64: boolean;
  hasCrt: boolean;
  extractedPayloads: number;         // raw/extract/payload artifacts produced by extraction
  analysisArtifacts: number;         // *_analysis.json
  sourceArtifacts: number;           // disasm / semantic source
  annotationArtifacts: number;       // *_annotations.json
  traceArtifacts: number;            // captured trace artifacts
  openQuestions: number;
  unsavedHint: boolean;              // analysis exists but no findings recorded yet
  findings: number;
  ungroundedFindings: number;        // Spec 752 L1 — findings tagged `ungrounded`
}

function gatherSignals(service: ProjectKnowledgeService, projectRoot: string, initialized: boolean): ProjectSignals {
  if (!initialized) {
    return {
      initialized: false,
      unregisteredFiles: 0, unregisteredExamples: [], unimportedManifests: 0, staleViews: 0,
      mediaArtifacts: 0, hasG64: false, hasCrt: false, extractedPayloads: 0,
      analysisArtifacts: 0, sourceArtifacts: 0, annotationArtifacts: 0, traceArtifacts: 0,
      openQuestions: 0, unsavedHint: false, findings: 0, ungroundedFindings: 0,
    };
  }

  const audit = auditProject(projectRoot, { includeFileScan: true, registrationSampleLimit: 5 });
  // "Inventory dirty" must mean there is sync work the facade can DO. A file on
  // disk that matches NO registration pattern is a reported pattern-gap, not an
  // actionable re-sync trigger — counting it would loop agent_next_step forever
  // on inventory-sync (the §11 e2e-mcp-step-loop guard). So scan the unregistered
  // delta and keep only files a DEFAULT_PATTERNS glob would actually register.
  const delta = audit.counts.unregisteredFiles > 0 ? scanRegistrationDelta(projectRoot, 500) : null;
  const actionableUnregistered = delta
    ? delta.unregistered.filter((rel) => DEFAULT_PATTERNS.some((p) => matchesGlob(rel, p.glob)))
    : [];

  const artifacts = service.listArtifacts();
  const isMedia = (a: { kind?: string; role?: string }) =>
    a.kind === "d64" || a.kind === "g64" || a.kind === "crt" || a.kind === "prg" || a.role === "source-prg";
  const mediaArtifacts = artifacts.filter(isMedia).length;
  const hasG64 = artifacts.some((a) => a.kind === "g64");
  const hasCrt = artifacts.some((a) => a.kind === "crt");
  // Extracted payloads: bytes pulled off media (raw sectors / extracted files /
  // payload entities). A standalone input .prg already IS a payload to analyze.
  const extractedPayloads = artifacts.filter((a) =>
    a.kind === "raw" || a.kind === "extract" || a.role === "raw-sector" || a.role?.startsWith("payload"),
  ).length;
  const inputPrgs = artifacts.filter((a) => a.kind === "prg" || a.role === "source-prg").length;
  const analysisArtifacts = artifacts.filter((a) =>
    a.kind === "analysis-run" || a.role === "prg-analysis",
  ).length;
  const sourceArtifacts = artifacts.filter((a) =>
    a.kind === "listing" || a.kind === "generated-source"
    || a.role === "disasm" || a.role === "disasm-tass"
    || a.role === "semantic-source",
  ).length;
  const annotationArtifacts = artifacts.filter((a) =>
    a.role === "annotations" || a.role === "semantic-annotations",
  ).length;
  const traceArtifacts = artifacts.filter((a) =>
    a.kind === "trace" || a.role?.startsWith("trace") || a.role === "runtime-trace",
  ).length;

  const allFindings = service.listFindings();
  const findings = allFindings.length;
  const ungroundedFindings = allFindings.filter((f) => (f.tags ?? []).includes("ungrounded")).length;
  const openQuestions = service.listOpenQuestions({ status: "open" }).length;

  return {
    initialized: true,
    unregisteredFiles: actionableUnregistered.length,
    unregisteredExamples: actionableUnregistered.slice(0, 3),
    unimportedManifests: audit.counts.unimportedManifestArtifacts,
    staleViews: countStaleViews(projectRoot),
    mediaArtifacts: mediaArtifacts + (inputPrgs === 0 ? 0 : 0), // mediaArtifacts already counts prg
    hasG64, hasCrt,
    extractedPayloads: extractedPayloads + inputPrgs, // an input PRG is directly analyzable
    analysisArtifacts,
    sourceArtifacts,
    annotationArtifacts,
    traceArtifacts,
    openQuestions,
    findings,
    ungroundedFindings,
    // unsaved facts: structural analysis exists but nothing has been recorded.
    unsavedHint: analysisArtifacts > 0 && findings === 0,
  };
}

// ---------------------------------------------------------------------------
// §5.2 deterministic priority ladder → primary + branches
// ---------------------------------------------------------------------------

function mkSuggestion(step: WorkflowStep, why: string, args?: Record<string, unknown>): AgentStepSuggestion {
  return {
    stepId: step.id,
    phase: step.phase,
    tool: step.defaultTool, // always a default tool or undefined (ask-human/change-validate)
    args,
    label: step.title,
    why,
    completionChecks: [...step.completionChecks],
  };
}

// Map a step id (chosen by the ladder) to a suggestion with a dynamic `why`.
function suggestStep(id: string, why: string, args?: Record<string, unknown>): AgentStepSuggestion {
  const step = workflowStep(id);
  if (!step) throw new Error(`workflow-model has no step '${id}'`);
  return mkSuggestion(step, why, args);
}

interface LadderOutcome {
  primary: AgentStepSuggestion;
  blockedBy: Array<{ id: string; prompt: string; choices?: string[] }>;
}

function pickPrimary(signals: ProjectSignals, projectDir: string): LadderOutcome {
  const blockedBy: Array<{ id: string; prompt: string; choices?: string[] }> = [];

  // 1. Project missing → project-init.
  if (!signals.initialized) {
    return {
      primary: suggestStep(
        "project-init",
        `No initialized C64RE project at ${projectDir}. Initialize it before any knowledge write — the knowledge tools reject calls against an uninitialized directory.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 2. Inventory dirty → inventory-sync (outranks almost everything).
  if (signals.unregisteredFiles > 0 || signals.unimportedManifests > 0 || signals.staleViews > 0) {
    const bits: string[] = [];
    if (signals.unregisteredFiles > 0) {
      const ex = signals.unregisteredExamples.length ? ` (e.g. ${signals.unregisteredExamples.join(", ")})` : "";
      bits.push(`${signals.unregisteredFiles} file(s) on disk are not yet tracked${ex}`);
    }
    if (signals.unimportedManifests > 0) bits.push(`${signals.unimportedManifests} manifest(s) not imported`);
    if (signals.staleViews > 0) bits.push(`${signals.staleViews} project view(s) stale`);
    return {
      primary: suggestStep(
        "inventory-sync",
        `Inventory is out of sync: ${bits.join("; ")}. Sync first — do not run analysis against stale views or untracked files.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 3. Media present but not extracted → media-inspect / media-extract.
  if (signals.mediaArtifacts > 0 && signals.extractedPayloads === 0) {
    return {
      primary: suggestStep(
        "media-inspect",
        `${signals.mediaArtifacts} media artifact(s) are present but nothing has been extracted yet. Inspect the directory/layout before pulling bytes off.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 4. G64 / protection signs → branch disk-raw-inspect (only as a branch in
  //    §5; the primary stays on the linear path, but when a G64 is present and
  //    no source exists yet, surfacing raw inspection as primary is the most
  //    useful next move per §5.2 item 4).
  if (signals.hasG64 && signals.sourceArtifacts === 0 && signals.extractedPayloads > 0 && signals.analysisArtifacts === 0) {
    return {
      primary: suggestStep(
        "disk-raw-inspect",
        `A G64 image is present. Directory listing is not enough for G64 — inspect raw slots/tracks/sync/header structure for copy-protection, custom loaders, and orphan sectors.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 5. CRT with bank/chunk data and no payloads yet → cart-chunk-inspect.
  if (signals.hasCrt && signals.extractedPayloads === 0) {
    return {
      primary: suggestStep(
        "cart-chunk-inspect",
        `A cartridge is present. Inspect / promote its bank chunks into payloads so they can be analyzed.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 6. Payloads without analysis → static-analyze.
  if (signals.extractedPayloads > 0 && signals.analysisArtifacts === 0) {
    return {
      primary: suggestStep(
        "static-analyze",
        `${signals.extractedPayloads} payload(s) are available but none has structural analysis yet. Run the heuristic analyzer pass to find code/data/assets.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 7. Analysis without source → static-disassemble.
  if (signals.analysisArtifacts > 0 && signals.sourceArtifacts === 0) {
    return {
      primary: suggestStep(
        "static-disassemble",
        `${signals.analysisArtifacts} analysis result(s) exist but no ASM/TASS source has been produced. Disassemble to source.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 7b. Spec 752 L1 — ungrounded findings outrank annotate / runtime-trace /
  // record-knowledge. A file/payload finding must cite a backing extract before
  // we move on; do not let the agent reach for tracing/stats as grounding.
  if (signals.ungroundedFindings > 0) {
    return {
      primary: suggestStep(
        "static-analyze",
        `${signals.ungroundedFindings} finding(s) cite no backing extract (tagged \`ungrounded\` — L1). Extract the source payload (extract_disk / extract_crt auto-runs disasm + analyse), then re-save each finding with artifact_ids pointing at its _analysis.json / _disasm.asm. A trace runId+cycle or a heuristic is NOT grounding.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 8. Source without semantic annotations → semantic-annotate.
  if (signals.sourceArtifacts > 0 && signals.annotationArtifacts === 0) {
    return {
      primary: suggestStep(
        "semantic-annotate",
        `Source exists but has no semantic annotations. Draft labels/comments/segment knowledge for review.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 9. Runtime questions / unknown loader behavior → runtime-trace.
  if (signals.openQuestions > 0 && signals.traceArtifacts === 0) {
    return {
      primary: suggestStep(
        "runtime-trace",
        `${signals.openQuestions} open question(s) remain and no runtime trace has been captured. Run Headless and capture a trace to gather evidence.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 10. Trace exists but not mined → trace-query.
  if (signals.traceArtifacts > 0 && signals.findings === 0) {
    return {
      primary: suggestStep(
        "trace-query",
        `A runtime trace was captured but no findings have been mined from it. Query the trace for executed code/data/loader facts.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 12. Unsaved facts → record-knowledge.
  if (signals.unsavedHint) {
    return {
      primary: suggestStep(
        "record-knowledge",
        `Structural analysis exists but no findings are recorded. Persist the durable conclusions so they survive the session.`,
        { project_dir: projectDir },
      ),
      blockedBy,
    };
  }

  // 13. Human decision (only when there is literally nothing else to advance).
  //     This is the safe terminal state — a real human decision, surfaced via
  //     blockedBy (§5.3: blockedBy is only for real human decisions).
  const askStep = workflowStep("ask-human")!;
  blockedBy.push({
    id: "next-objective",
    prompt: signals.findings > 0 || signals.sourceArtifacts > 0
      ? "The linear pipeline has no obvious next product step. Decide the next objective (deeper disassembly, a runtime trace, a visual check, or a change/validate task once Spec 711 lands)."
      : "No media, payloads, or analysis to advance. Add input media (.d64/.g64/.crt/.prg) under the project, or state the objective.",
  });
  return {
    primary: mkSuggestion(askStep, blockedBy[0]!.prompt),
    blockedBy,
  };
}

// Build the explicit branch list from the primary step's model branches,
// resolving each to a suggestion with a generic (state-aware) why. ask-human and
// change-validate branches carry no tool (change-validate is blocked).
function buildBranches(primary: AgentStepSuggestion, signals: ProjectSignals, projectDir: string): AgentStepSuggestion[] {
  const step = workflowStep(primary.stepId);
  if (!step) return [];
  const out: AgentStepSuggestion[] = [];
  for (const branchId of step.branches) {
    const b = workflowStep(branchId);
    if (!b) continue;
    let why: string;
    if (b.blockedUntil) {
      why = `Iterative alternative — blocked until ${b.blockedUntil} (patch/validate loop not yet available from the product surface).`;
    } else if (b.id === "ask-human") {
      why = `Iterative alternative — escalate to the operator for a decision.`;
    } else {
      why = `Iterative alternative after ${primary.label.toLowerCase()}.`;
    }
    out.push(mkSuggestion(b, why, b.defaultTool ? { project_dir: projectDir } : undefined));
  }
  void signals;
  return out;
}

export function computeNextStep(projectRoot: string): AgentNextStepResult {
  const initialized = projectInitialized(projectRoot);
  // Only construct the service (which would otherwise be harmless) for an
  // initialized project; gatherSignals short-circuits when not initialized.
  const service = new ProjectKnowledgeService(projectRoot);
  let projectName = relative(process.cwd(), projectRoot) || projectRoot;
  if (initialized) {
    try { projectName = service.getProjectStatus().project.name; } catch { /* keep dir-based name */ }
  }

  const signals = gatherSignals(service, projectRoot, initialized);
  const { primary, blockedBy } = pickPrimary(signals, projectRoot);
  const branches = buildBranches(primary, signals, projectRoot);

  return {
    project: { name: projectName, dir: projectRoot },
    primary,
    branches,
    blockedBy,
    doNotCall: [...FORBIDDEN_PRODUCT_TOOLS],
  };
}

// Spec 730 §5.3 / BUG-005 — the machine-readable projection of the next step.
// An LLM parses this fenced JSON instead of scraping prose; every `tool` is a
// callable default-surface tool. Field names follow the product contract:
// phase, step, reason, primary_action, secondary_actions, blocked_by,
// human_question?, ui_hint?, do_not_call.
const UI_HINT_BY_STEP: Record<string, string> = {
  "inventory-sync": "After sync, confirm the new media/payloads appear in the workbench Disk Inspector + Payloads, and check the Inspector 'Source / Versions' for the current best artifact.",
  "media-inspect": "Check the Disk geometry / track heatmap in the workbench after inspecting.",
  "disk-raw-inspect": "Check the raw track/sector heatmap + disk hints in the workbench.",
  "cart-chunk-inspect": "Check the Cartridge layout (banks/chunks) in the workbench.",
  "static-disassemble": "Review the Annotated Listing / ASM overlay in the workbench.",
  "semantic-annotate": "Review the proposed labels/comments in the Annotated Listing before accepting.",
  "runtime-trace": "Watch the Live tab while the trace runs.",
  "visual-inspect": "Compare the resolved VIC evidence against the Live frame in the workbench.",
};

interface AgentStepActionShape {
  tool: string | null;
  args: Record<string, unknown>;
  label: string;
  step: string;
  phase: string;
  why: string;
}

export interface AgentNextStepMachineShape {
  phase: string;
  step: string;
  reason: string;
  primary_action: AgentStepActionShape;
  secondary_actions: AgentStepActionShape[];
  blocked_by: Array<{ id: string; prompt: string; choices?: string[] }>;
  human_question?: string;
  ui_hint?: string;
  do_not_call: string[];
}

export function nextStepMachineShape(r: AgentNextStepResult): AgentNextStepMachineShape {
  const toAction = (s: AgentStepSuggestion): AgentStepActionShape => ({
    tool: s.tool ?? null,
    args: s.args ?? {},
    label: s.label,
    step: s.stepId,
    phase: s.phase,
    why: s.why,
  });
  // human_question is set when the primary step has no callable tool (a human
  // decision) or when a real human decision blocks progress (§5.3 blockedBy).
  const humanQuestion = !r.primary.tool || r.blockedBy.length > 0
    ? (r.blockedBy[0]?.prompt ?? r.primary.why)
    : undefined;
  return {
    phase: r.primary.phase,
    step: r.primary.stepId,
    reason: r.primary.why,
    primary_action: toAction(r.primary),
    secondary_actions: r.branches.map(toAction),
    blocked_by: r.blockedBy,
    ...(humanQuestion ? { human_question: humanQuestion } : {}),
    ...(UI_HINT_BY_STEP[r.primary.stepId] ? { ui_hint: UI_HINT_BY_STEP[r.primary.stepId] } : {}),
    do_not_call: r.doNotCall,
  };
}

function renderNextStep(r: AgentNextStepResult): string {
  const lines: string[] = [];
  lines.push(`# Next step — ${r.project.name}`);
  lines.push(`Project: ${r.project.dir}`);
  lines.push(``);
  lines.push(`## Primary`);
  lines.push(`Step: ${r.primary.stepId}  (phase: ${r.primary.phase})`);
  lines.push(`Action: ${r.primary.label}`);
  if (r.primary.tool) {
    lines.push(`Run: ${r.primary.tool}`);
  } else {
    lines.push(`Run: (human action — no tool)`);
  }
  lines.push(`Why: ${r.primary.why}`);
  lines.push(`Completion checks: ${r.primary.completionChecks.join(", ")}`);
  if (r.branches.length > 0) {
    lines.push(``);
    lines.push(`## Branches (valid iterative alternatives)`);
    for (const b of r.branches) {
      const tool = b.tool ? `run ${b.tool}` : "human action";
      lines.push(`- ${b.stepId} (${b.phase}) — ${b.label}: ${tool}`);
    }
  }
  if (r.blockedBy.length > 0) {
    lines.push(``);
    lines.push(`## Needs a human decision`);
    for (const blk of r.blockedBy) {
      lines.push(`- [${blk.id}] ${blk.prompt}`);
      if (blk.choices && blk.choices.length) lines.push(`  choices: ${blk.choices.join(" | ")}`);
    }
  }
  lines.push(``);
  lines.push(`## Do NOT call (internal — wrapped behind product facades)`);
  lines.push(r.doNotCall.join(", "));
  // Machine-readable projection (BUG-005 / §5.3): parse THIS, do not scrape the
  // prose above. Every primary/secondary `tool` is a callable default tool.
  lines.push(``);
  lines.push(`## Machine-readable`);
  lines.push("```json");
  lines.push(JSON.stringify(nextStepMachineShape(r), null, 2));
  lines.push("```");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// agent_run_step (§4.2)
// ---------------------------------------------------------------------------

export interface AgentRunStepResult {
  stepId: string;
  status: "done" | "blocked" | "failed";
  actions: Array<{ label: string; result: string }>;
  createdArtifacts: string[];
  updatedViews: string[];
  findingsToReview: string[];
  nextStepHint: string;
}

async function runInventorySyncStep(service: ProjectKnowledgeService, projectRoot: string): Promise<AgentRunStepResult> {
  const before = new Set(service.listArtifacts().map((a) => a.relativePath));
  const sync = await runProjectInventorySync(service, projectRoot);
  const afterArtifacts = service.listArtifacts();
  const created = afterArtifacts.filter((a) => !before.has(a.relativePath)).map((a) => a.relativePath);

  const status: AgentRunStepResult["status"] = sync.status === "done" ? "done" : sync.status;
  return {
    stepId: "inventory-sync",
    status,
    actions: [
      { label: "Track project files", result: `${sync.registered} file(s) newly tracked` },
      { label: "Import manifests", result: `${sync.importedManifests} manifest(s) imported` },
      { label: "Rebuild project views", result: `${sync.rebuiltViews.length} view(s) rebuilt` },
    ],
    createdArtifacts: created,
    updatedViews: sync.rebuiltViews,
    findingsToReview: [],
    nextStepHint: sync.nextStepHint,
  };
}

function blockedRun(stepId: string, status: "blocked" | "failed", message: string, nextAction: string): AgentRunStepResult {
  return {
    stepId,
    status,
    actions: [{ label: "Could not run from the orchestrator", result: message }],
    createdArtifacts: [],
    updatedViews: [],
    findingsToReview: [],
    nextStepHint: nextAction,
  };
}

export async function runStep(service: ProjectKnowledgeService, projectRoot: string, stepId: string): Promise<AgentRunStepResult> {
  const step = workflowStep(stepId);
  if (!step) {
    return blockedRun(
      stepId, "failed",
      `Unknown step '${stepId}'. Valid step ids: ${C64RE_WORKFLOW_STEPS.map((s) => s.id).join(", ")}.`,
      `Call agent_next_step to get the current recommended step id.`,
    );
  }

  // Implemented: the inventory / media-sync step.
  if (stepId === "inventory-sync") {
    return await runInventorySyncStep(service, projectRoot);
  }

  // project-init is owned by the project_init tool (it creates the project
  // layout + metadata). The orchestrator does not duplicate it.
  if (stepId === "project-init") {
    return blockedRun(
      "project-init", "blocked",
      `Project initialization is performed by the project_init tool, not the step runner.`,
      `Run project_init(project_dir="${projectRoot}", name="<project name>"), then call agent_next_step again.`,
    );
  }

  if (step.blockedUntil) {
    return blockedRun(
      stepId, "blocked",
      `This step is blocked until ${step.blockedUntil} (the patch/change/validate loop is not yet available from the product surface).`,
      `Pick an available step from agent_next_step (e.g. runtime-trace or record-knowledge).`,
    );
  }

  if (!step.defaultTool) {
    return blockedRun(
      stepId, "blocked",
      `'${stepId}' is a human-decision step with no callable tool.`,
      `Surface the decision to the operator, capture the answer with save_open_question / save_finding, then call agent_next_step.`,
    );
  }

  // Every other step maps to a single default tool the LLM should call directly.
  return blockedRun(
    stepId, "blocked",
    `The step runner only executes the inventory/media-sync step in-process. '${step.title}' is performed by calling its product tool directly.`,
    `Run ${step.defaultTool}(project_dir="${projectRoot}", ...) for this step, then call agent_next_step to continue.`,
  );
}

function renderRunStep(r: AgentRunStepResult): string {
  const lines: string[] = [];
  lines.push(`# Run step — ${r.stepId} — ${r.status}`);
  lines.push(``);
  lines.push(`## Actions`);
  for (const a of r.actions) lines.push(`- ${a.label}: ${a.result}`);
  if (r.createdArtifacts.length > 0) {
    lines.push(``);
    lines.push(`## Newly tracked (${r.createdArtifacts.length})`);
    for (const c of r.createdArtifacts.slice(0, 15)) lines.push(`- ${c}`);
    if (r.createdArtifacts.length > 15) lines.push(`- … and ${r.createdArtifacts.length - 15} more`);
  }
  if (r.updatedViews.length > 0) {
    lines.push(``);
    lines.push(`## Views refreshed (${r.updatedViews.length})`);
    for (const v of r.updatedViews) lines.push(`- ${v}`);
  }
  if (r.findingsToReview.length > 0) {
    lines.push(``);
    lines.push(`## Findings to review`);
    for (const f of r.findingsToReview) lines.push(`- ${f}`);
  }
  lines.push(``);
  lines.push(`Next: ${r.nextStepHint}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MCP registration
// ---------------------------------------------------------------------------

export function registerAgentStepTools(server: McpServer, ctx: ServerToolContext): void {
  server.tool(
    "agent_next_step",
    "Get the single MCP-chosen next step for the project, plus valid iterative branches — the product way to answer \"what do I do now?\". Use when you are unsure where to continue, after finishing a step, or after onboarding; it derives the step from real project state (is the project initialized? are files untracked / manifests unimported / views stale? is media extracted? is there analysis, source, annotations, a trace, open questions, recorded findings?). Every recommended action is a callable product tool; internal maintenance tools are listed only under \"do not call\". Not for executing the step (use agent_run_step or call the named tool) or recording progress (use agent_record_step). Inputs: optional project dir, optional free-text context. Returns: a primary suggestion (step id, phase, tool, why, completion checks), branch alternatives, any human decisions that block progress, and the forbidden-internal-tool list — plus a machine-readable JSON block (phase, step, reason, primary_action{tool,args,label}, secondary_actions[], blocked_by[], human_question?, ui_hint?) you can parse directly instead of scraping the prose.",
    {
      project_dir: z.string().optional().describe("Project root directory. Absolute or project-relative; defaults to C64RE_PROJECT_DIR or the active project."),
      context: z.string().optional().describe("Optional free-text context from the human/LLM to bias the recommendation."),
    },
    safeHandler("agent_next_step", async ({ project_dir }: { project_dir?: string; context?: string }) => {
      const projectRoot = resolveOrchestratorRoot(project_dir);
      const result = computeNextStep(projectRoot);
      return textContent(renderNextStep(result));
    }),
  );

  server.tool(
    "agent_run_step",
    "Run a workflow step chosen by agent_next_step. Use to execute the inventory/media-sync step in-process (it tracks present-but-untracked files, imports manifests, and rebuilds project views behind one product action). For every other step, it returns the one product tool to call next — it never crashes on an unimplemented step. Not for choosing the step (use agent_next_step) or for the underlying maintenance helpers (those are wrapped, never called directly). Inputs: step id (e.g. inventory-sync), optional project dir, optional step-specific args. Returns: the step status, the product-level actions performed, newly tracked artifacts, refreshed views, findings to review, and the next-step hint.",
    {
      project_dir: z.string().optional().describe("Project root directory. Absolute or project-relative; defaults to C64RE_PROJECT_DIR or the active project."),
      step_id: z.string().describe("The workflow step id to run (e.g. 'inventory-sync'). Get it from agent_next_step."),
      args: z.record(z.unknown()).optional().describe("Optional step-specific arguments."),
    },
    safeHandler("agent_run_step", async ({ project_dir, step_id }: { project_dir?: string; step_id: string; args?: Record<string, unknown> }) => {
      const projectRoot = resolveOrchestratorRoot(project_dir);
      // Steps other than project-init operate on an initialized project. If the
      // dir is not a project yet, point at project_init rather than crashing.
      if (!projectInitialized(projectRoot) && step_id !== "project-init") {
        const result = blockedRun(
          step_id, "blocked",
          `'${projectRoot}' is not an initialized C64RE project yet.`,
          `Run project_init(project_dir="${projectRoot}", name="<project name>") first, then call agent_next_step.`,
        );
        return textContent(renderRunStep(result));
      }
      const service = new ProjectKnowledgeService(projectRoot);
      const result = await runStep(service, projectRoot, step_id);
      return textContent(renderRunStep(result));
    }),
  );

  // The orchestrator resolves its own (marker-tolerant) project root, so it does
  // not use ctx.projectDir; ctx is kept for registrar-signature consistency.
  void ctx;
}
