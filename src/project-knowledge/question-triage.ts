// Spec 748.2 (BUG-032) — open-question triage helpers.
//
// The analyze_prg import auto-generates one "Validate: …" open question per
// low-confidence RAM hypothesis. These flood the Questions surface (one project
// had 127 of them burying the 1 real question). They are heuristic noise until a
// human/agent confirms or invalidates them, so the default surfaces hide them
// behind a count and the orchestrator reconcile-teeth ignore them.

import type { OpenQuestionRecord } from "./types.js";

/**
 * True for the auto-generated heuristic validation prompts (analyze_prg import).
 * New records carry `source: "heuristic-phase1"`; legacy untagged ones are
 * recognised by their `kind: "validation"` (the only producer of that kind).
 */
export function isHeuristicQuestion(
  q: Pick<OpenQuestionRecord, "source" | "kind">,
): boolean {
  return q.source === "heuristic-phase1" || q.kind === "validation";
}

/** Split a question list into the real (human-relevant) ones and the heuristic noise. */
export function partitionQuestions<T extends Pick<OpenQuestionRecord, "source" | "kind">>(
  questions: T[],
): { real: T[]; heuristic: T[] } {
  const real: T[] = [];
  const heuristic: T[] = [];
  for (const q of questions) (isHeuristicQuestion(q) ? heuristic : real).push(q);
  return { real, heuristic };
}
