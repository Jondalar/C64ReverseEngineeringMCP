// Spec 057 R26: shared formatter for the closed-loop sweep footer
// appended by disasm_prg and save_finding (and any future trigger).
// One line, machine-parseable, brief.
//
// BUG-067: the artifact-scoped footer no longer runs a second, project-wide
// sweep to print `project=A/B`. What it prints about the project is what the
// graph holds — archived findings and answered questions, counted.

import type { ProjectKnowledgeService } from "../project-knowledge/service.js";

export function runAndFormatClosedLoopSweep(
  service: ProjectKnowledgeService,
  opts: { artifactId?: string },
): string {
  try {
    const result = service.runClosedLoopSweep(opts);
    if (result.error) {
      return `Auto-archive: FAILED — ${result.error}`;
    }
    const scoped = `${result.archivedScoped} findings, answered ${result.questionsAnsweredScoped} questions`;
    if (result.scope === "project") {
      return `Auto-archive: archived ${scoped} [scope=project]`;
    }
    return `Auto-archive: archived ${scoped} [scope=artifact:${result.scopeArtifactId}; project holds ${result.projectTotals.archived} archived, ${result.projectTotals.answered} answered]`;
  } catch (error) {
    return `Auto-archive: FAILED — ${error instanceof Error ? error.message : String(error)}`;
  }
}
