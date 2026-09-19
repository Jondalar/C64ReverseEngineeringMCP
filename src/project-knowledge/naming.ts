// How long a name may be — one number, for new projects only.
//
// The owner, 2026-09-19, after the monitor's label column: "bei store eines Labels
// verweigere in Zukunft alles > 20 Zeichen … dann kommt es auch gar nicht mehr vor", and
// on which projects: "nur für neue Projekte". So `project_init` stamps
// `naming.maxLabelLength` into knowledge/project.json of a project it CREATES, and every
// door that stores a name checks against that stamp. A project without it — every project
// older than the rule — is not checked: Ultima VI holds 359 names over 20 characters, and
// its annotation files are re-imported on every disasm_prg.
//
// The monitor's label column is the same number (src/symbols/monitor-names.ts), so in a
// project that has the rule no label ever wraps.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MAX_LABEL_LENGTH = 20;

/** The project's limit, or undefined when the project predates the rule. */
export function maxLabelLength(projectDir: string): number | undefined {
  const path = join(projectDir, "knowledge", "project.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { naming?: { maxLabelLength?: unknown } };
    const n = raw.naming?.maxLabelLength;
    return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** The names longer than the limit, each once, in the order given. */
export function namesTooLong(names: Iterable<string>, max: number): string[] {
  const out: string[] = [];
  for (const n of names) if (n.length > max && !out.includes(n)) out.push(n);
  return out;
}

/** Every name an annotations file would store: labels, routine names, segment labels. */
export function annotationNames(json: unknown): string[] {
  const out: string[] = [];
  const doc = (json ?? {}) as { labels?: unknown; routines?: unknown; segments?: unknown };
  const take = (list: unknown, key: string): void => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      const v = (e as Record<string, unknown> | null)?.[key];
      if (typeof v === "string" && v.length > 0) out.push(v);
    }
  };
  take(doc.labels, "label");
  take(doc.routines, "name");
  take(doc.segments, "label");
  return out;
}

/** The refusal text — it names every offender and says how to get past it. */
export function tooLongMessage(names: string[], max: number): string {
  return [
    `${names.length} name${names.length === 1 ? "" : "s"} longer than ${max} characters — this project stores no name over ${max} (set by project_init for projects created since 2026-09-19):`,
    ...names.map((n) => `  ${n}  (${n.length})`),
    `Shorten ${names.length === 1 ? "it" : "them"} and store again. Nothing was written.`,
  ].join("\n");
}

export class NameTooLongError extends Error {
  constructor(readonly names: string[], readonly max: number) {
    super(tooLongMessage(names, max));
    this.name = "NameTooLongError";
  }
}

/** Throw when the project has a limit and a name breaks it. */
export function assertNamesFit(projectDir: string, names: Iterable<string>): void {
  const max = maxLabelLength(projectDir);
  if (max === undefined) return;
  const long = namesTooLong(names, max);
  if (long.length > 0) throw new NameTooLongError(long, max);
}
