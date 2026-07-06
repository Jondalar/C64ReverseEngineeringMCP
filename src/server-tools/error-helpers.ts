// Spec 045: self-documenting errors. Every refusal / no-op response
// should end with a "Recommended next action: ..." line so the agent
// never has to guess. Used by the agent_* tool family and the
// orchestration-critical tools (load_context, loader_entrypoint,
// patch_recipe).

export function nextStepError(toolName: string, message: string, recommended: string): { content: Array<{ type: "text"; text: string }>; [key: string]: unknown } {
  const lines: string[] = [];
  lines.push(`# c64re error — ${toolName}`);
  lines.push("");
  lines.push(message);
  lines.push("");
  lines.push(`Recommended next action: ${recommended}`);
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export function isProjectInitialised(projectDir: string): boolean {
  // Delegate to the ONE canonical marker predicate (project-root.hasProjectMarker
  // = knowledge/phase-plan.json OR knowledge/workflow-state.json — the SAME check
  // resolveProjectDir / agent_onboard use). Previously this checked phase-plan.json
  // ONLY, so it drifted STRICTER than the resolver: a workflow-state-only project
  // resolved + onboarded fine but c64re_whats_next refused it as "not initialised".
  try {
    // Lazy require avoids pulling project-root (and its fs import) into this leaf
    // module's load-critical path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { hasProjectMarker } = require("../project-root.js") as typeof import("../project-root.js");
    return hasProjectMarker(projectDir);
  } catch {
    return false;
  }
}
