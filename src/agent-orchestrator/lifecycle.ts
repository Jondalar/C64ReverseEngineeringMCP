// Spec 773 — the 5-phase RE PROJECT LIFECYCLE and its crosswalk onto the existing
// (unchanged) engines. This is a THIN top axis, not a new engine: it maps the
// project-level workflow-state phases (Model D, service.ts defaultWorkflowPhases), the
// per-artifact 7-phase analysis pipeline (Model A, phase-tools.ts), and the deterministic
// step orchestrator steps (Model C, workflow-model.ts) onto the human/project lifecycle.
//
// Doctrine: docs/product-vision-and-workbench-contract.md §2A. Do NOT rebuild the engines;
// per-artifact phase gating (Model A) stays the RE-internal discipline. The lifecycle is
// navigation, not a hard gate.

export type LifecyclePhase = "onboarding" | "discovery" | "re" | "build" | "release";

/** Ordered for the UI phase-strip + back/next navigation. */
export const LIFECYCLE_ORDER: readonly LifecyclePhase[] = [
  "onboarding",
  "discovery",
  "re",
  "build",
  "release",
] as const;

export const LIFECYCLE_TITLES: Record<LifecyclePhase, string> = {
  onboarding: "Onboarding",
  discovery: "Discovery",
  re: "Reverse Engineering",
  build: "Build",
  release: "Release",
};

/** Model D — project workflow-state phase id (service.ts defaultWorkflowPhases) → lifecycle. */
export const WORKFLOW_PHASE_TO_LIFECYCLE: Record<string, LifecyclePhase> = {
  "workspace-init": "onboarding",
  "input-registration": "discovery",
  "deterministic-extraction": "discovery",
  "structural-enrichment": "re",
  "semantic-enrichment": "re",
  "semantic-feedback-refinement": "re",
  "runtime-capture": "re",
  "runtime-aggregation": "re",
  "view-build": "re",
};

/** Model C — deterministic step id (workflow-model.ts C64RE_WORKFLOW_STEPS) → lifecycle. */
export const STEP_TO_LIFECYCLE: Record<string, LifecyclePhase> = {
  "project-init": "onboarding",
  "inventory-sync": "discovery",
  "media-inspect": "discovery",
  "media-extract": "discovery",
  "disk-raw-inspect": "discovery",
  "cart-chunk-inspect": "discovery",
  "static-analyze": "re",
  "static-disassemble": "re",
  "semantic-annotate": "re",
  "runtime-trace": "re",
  "trace-query": "re",
  "visual-inspect": "re",
  "record-knowledge": "re",
  "change-validate": "build",
  // "ask-human" is cross-phase — intentionally unmapped (falls back to caller's context).
};

/** Model D phase id → lifecycle (undefined when the id is unknown). */
export function lifecycleForWorkflowPhaseId(phaseId: string | undefined | null): LifecyclePhase | undefined {
  if (!phaseId) return undefined;
  return WORKFLOW_PHASE_TO_LIFECYCLE[phaseId];
}

/** Model A per-artifact phase 1..7 → lifecycle: extraction+loader = Discovery, the rest = RE. */
export function lifecycleForPerArtifactPhase(phase: number | undefined | null): LifecyclePhase | undefined {
  if (phase == null || !Number.isFinite(phase)) return undefined;
  if (phase <= 2) return "discovery";
  if (phase <= 7) return "re";
  return undefined;
}

/** Model C step id → lifecycle (undefined for cross-phase/unknown steps). */
export function lifecycleForStep(stepId: string | undefined | null): LifecyclePhase | undefined {
  if (!stepId) return undefined;
  return STEP_TO_LIFECYCLE[stepId];
}

/** The recommended/current lifecycle phase from the persisted workflow state's currentPhaseId. */
export function recommendedLifecyclePhase(currentPhaseId: string | undefined | null): LifecyclePhase {
  return lifecycleForWorkflowPhaseId(currentPhaseId) ?? "onboarding";
}
