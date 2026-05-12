// Spec 046: workflow templates. The active workflow filters which
// phases are required in the per-artifact status checklist + which
// phases agent_propose_next surfaces in the per-artifact action
// section. PHASE_TOOLS allow-lists from Spec 034 are unchanged.

import type { PhaseNumber } from "./phase-tools.js";

export type WorkflowKind =
  | "full-re"
  | "cracker-only"
  | "analyst-deep"
  | "targeted-routine"
  | "bugfix";

export const WORKFLOW_TITLES: Record<WorkflowKind, string> = {
  "full-re": "Full Reverse Engineering",
  "cracker-only": "Cracker / Port Focus",
  "analyst-deep": "Analyst Deep Dive",
  "targeted-routine": "Targeted Routine Fix",
  "bugfix": "Bug Reproduction + Patch",
};

export const WORKFLOW_DESCRIPTIONS: Record<WorkflowKind, string> = {
  "full-re": "Default. Reverse a multi-PRG title from scratch through all 7 phases per artifact.",
  "cracker-only": "Crack/port focus. Asset PRGs auto-frozen at phase 3; loader / protection / save / kernal go full 1..7.",
  "analyst-deep": "Single-PRG deep analysis. Extra emphasis on phase 4-5 iteration.",
  "targeted-routine": "Fix one routine in one PRG. Only phases 3-5 on the target artifact, no project-wide audit pressure.",
  "bugfix": "Reproduce a known bug, patch, verify. Phases 1, 5, 7 only.",
};

// Required phases per workflow + role. Roles other than analyst /
// cracker fall back to analyst.
export function requiredPhasesFor(workflow: WorkflowKind, role: "analyst" | "cracker", relevance?: string): PhaseNumber[] {
  const isAsset = relevance === "asset";
  switch (workflow) {
    case "full-re":
      if (role === "cracker" && isAsset) return [1, 2, 3];
      return [1, 2, 3, 4, 5, 6, 7];
    case "cracker-only":
      if (isAsset) return [1, 2, 3];
      return [1, 2, 3, 4, 5, 6, 7];
    case "analyst-deep":
      return [1, 2, 3, 4, 5, 6, 7];
    case "targeted-routine":
      return [3, 4, 5];
    case "bugfix":
      return [1, 5, 7];
  }
}

// Used by agent_propose_next to filter which per-artifact phase
// rows to surface.
export function visiblePhasesFor(workflow: WorkflowKind | undefined): Set<PhaseNumber> {
  const wf = workflow ?? "full-re";
  switch (wf) {
    case "bugfix": return new Set<PhaseNumber>([1, 5, 7]);
    case "targeted-routine": return new Set<PhaseNumber>([3, 4, 5]);
    default: return new Set<PhaseNumber>([1, 2, 3, 4, 5, 6, 7]);
  }
}
