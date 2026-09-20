// A project may declare which of ITS OWN directories are intentional.
//
// `project_inventory_sync` reports every file that matches no registration pattern as
// a "remaining problem", and the shipped pattern list only knows the directories THIS
// repo's tools compose. A project that follows the documented relocated-block workflow
// writes `analysis/reloc/*.prg`; a project that keeps rebuild receipts writes
// `analysis/rebuild/verify-*.json`. Neither is a mistake, both were reported on every
// single run, and there was no way to say so — advice nobody can act on, which is the
// same failure Spec 832 D5 fixed for tool output.
//
// So a project can declare them, in `knowledge/inventory-patterns.json`:
//
//   {
//     "patterns": [
//       { "glob": "analysis/reloc/**/*.prg", "kind": "prg", "scope": "analysis",
//         "role": "relocated-block", "format": "prg" }
//     ],
//     "intentional": ["analysis/rebuild/verify-*.json"]
//   }
//
// `patterns` REGISTER the files (they join the shipped list, and win, because they are
// more specific by being the project's own statement). `intentional` merely stops them
// being reported — for output nobody needs as an artifact.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const INVENTORY_PATTERNS_FILE = "knowledge/inventory-patterns.json";

export interface ProjectInventoryPattern {
  glob: string;
  kind: string;
  scope: string;
  role?: string;
  format?: string;
  tags?: string[];
}

export interface ProjectInventoryDeclaration {
  patterns: ProjectInventoryPattern[];
  intentional: string[];
  /** Set when the file exists but could not be read — reported, never swallowed. */
  error?: string;
}

const EMPTY: ProjectInventoryDeclaration = { patterns: [], intentional: [] };

export function readInventoryDeclaration(projectRoot: string): ProjectInventoryDeclaration {
  const path = join(projectRoot, INVENTORY_PATTERNS_FILE);
  if (!existsSync(path)) return EMPTY;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectInventoryDeclaration>;
    const patterns = (Array.isArray(raw.patterns) ? raw.patterns : [])
      .filter((p): p is ProjectInventoryPattern =>
        !!p && typeof p.glob === "string" && typeof p.kind === "string" && typeof p.scope === "string");
    const intentional = (Array.isArray(raw.intentional) ? raw.intentional : [])
      .filter((g): g is string => typeof g === "string");
    return { patterns, intentional };
  } catch (e) {
    return { ...EMPTY, error: `${INVENTORY_PATTERNS_FILE} could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The text a report prints when files match nothing — it must say how to settle it. */
export function howToDeclare(examples: string[]): string[] {
  const sample = examples[0] ?? "analysis/mine/thing.prg";
  const dir = sample.includes("/") ? sample.slice(0, sample.lastIndexOf("/")) : "analysis";
  const ext = /\.([A-Za-z0-9]+)$/.exec(sample)?.[1] ?? "prg";
  return [
    `Declare them in ${INVENTORY_PATTERNS_FILE} and they stop being reported:`,
    `  { "patterns": [ { "glob": "${dir}/**/*.${ext}", "kind": "${ext === "json" || ext === "md" ? "report" : "prg"}", "scope": "analysis", "role": "my-output" } ],`,
    `    "intentional": [] }`,
    `  \`patterns\` registers the files as artifacts; \`intentional\` is a glob list that only silences them.`,
  ];
}
