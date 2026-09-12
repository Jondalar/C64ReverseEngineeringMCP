import { hasProjectMarker } from "../project-root.js";
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
  //
  // 2026-09-12 — and the fix for that reintroduced the bug through the back door. It
  // used `require()`, which does not exist at runtime in this ESM bundle: the call threw
  // on every invocation, the catch below returned false, and c64re_whats_next therefore
  // refused EVERY project, always, with "Project not initialised".
  //
  // An unattended session reported the tool as unusable for its whole run and blamed a
  // local hook that had blocked its agent_onboard call. That was a plausible diagnosis
  // and the wrong one — the guard would have refused with or without the hook. Measured
  // side by side on a real project: isProjectInitialised() false, hasProjectMarker() true.
  //
  // A static import is correct here. The comment below argued for a lazy one to keep
  // project-root off this leaf module's load path; project-root imports only node:fs and
  // node:path, so there is nothing to keep off it.
  return hasProjectMarker(projectDir);
}
