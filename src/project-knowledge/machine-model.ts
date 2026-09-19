// Spec 863 C1 — a project remembers which C64 it is.
//
// `knowledge/project.json` → `machine.model`: a row of the runtime's model table
// (`c64-pal`, `c64-ntsc`, …). `project_init` stamps `c64-pal` into a project it CREATES
// and leaves an existing project's value alone; a project older than this has none, and
// the runtime then starts on its own default (PAL). Every place that starts a runtime for
// the project — the workspace launcher, the MCP's auto-start, a sandbox run — starts it as
// this model, so an NTSC release boots as NTSC without anyone remembering to switch.
//
// The value is NOT checked against a list here: C64RE keeps no list of models. The runtime
// resolves the name when it starts and refuses one it does not know, or cannot run, by name.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** What `project_init` stamps into a project it creates. */
export const DEFAULT_PROJECT_MODEL = "c64-pal";

/** A row name as the runtime spells them: letters, digits, dashes. */
export function isModelName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(name.trim());
}

/** The project's model, or undefined when the project predates the field (or has none). */
export function projectMachineModel(projectDir: string | undefined): string | undefined {
  if (!projectDir) return undefined;
  const path = join(projectDir, "knowledge", "project.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { machine?: { model?: unknown } };
    const m = raw.machine?.model;
    return typeof m === "string" && isModelName(m) ? m.trim() : undefined;
  } catch {
    return undefined;
  }
}
