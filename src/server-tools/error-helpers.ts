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
  // The presence of knowledge/phase-plan.json is the agreed
  // initialised marker (see src/project-root.ts).
  try {
    // Lazy require to avoid pulling fs into module load critical path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    return fs.existsSync(path.join(projectDir, "knowledge", "phase-plan.json"));
  } catch {
    return false;
  }
}
