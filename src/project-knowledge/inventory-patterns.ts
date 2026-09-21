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
//
// This module is the ONE reader of that file, and it is deliberately dependency-free:
// `scanRegistrationDelta` (the shared scan behind agent_record_step, agent_onboard, the
// workspace banner and the audit) imports it too. It used to be imported by
// `inventory-sync.ts` and nowhere else, so `project_inventory_sync` knew what the
// project had declared and every other door did not — one project, two answers
// (840 files "NOT registered" against 831 "declared intentional and not counted").
//
// The declaration is also VALIDATED here. It used to be read with `typeof` checks that
// silently dropped anything malformed: a project that wrote `kind: "annotations"` got a
// file that looked accepted and changed nothing, and the only error text it ever saw
// came from a different door (`register_existing_files`' Zod schema, which dumps its
// whole enum). A declaration's own mistakes are now named here, with the entry index,
// the value given and what is allowed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const INVENTORY_PATTERNS_FILE = "knowledge/inventory-patterns.json";

// The artifact kind / scope vocabularies. They live in this leaf module rather than in
// `server-tools/registration.ts` so both the declaration reader and the registration
// tool can share one list without a cycle (registration → registration-delta →
// inventory-patterns).
export const INVENTORY_KIND_VALUES = [
  "prg", "crt", "d64", "g64", "raw",
  "analysis-run", "report", "generated-source",
  "manifest", "extract", "preview", "listing",
  "trace", "view-model", "checkpoint", "other",
] as const;

export const INVENTORY_SCOPE_VALUES = [
  "input", "generated", "analysis", "knowledge", "view", "session",
] as const;

export type InventoryKind = typeof INVENTORY_KIND_VALUES[number];
export type InventoryScope = typeof INVENTORY_SCOPE_VALUES[number];

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
  /** Set when the file exists but could not be read/parsed — reported, never swallowed. */
  error?: string;
  /**
   * One line per entry the file got wrong, naming where and what is allowed. An entry
   * with a problem is DROPPED (it cannot be applied) but it is never dropped silently.
   */
  problems: string[];
}

const EMPTY: ProjectInventoryDeclaration = { patterns: [], intentional: [], problems: [] };

const KIND_SET = new Set<string>(INVENTORY_KIND_VALUES);
const SCOPE_SET = new Set<string>(INVENTORY_SCOPE_VALUES);

// A near-miss the reader can name instead of only listing the whole vocabulary.
// These are the words a project actually reached for, taken from what the run wrote.
const KIND_ALIASES: Record<string, InventoryKind> = {
  annotations: "report",
  annotation: "report",
  json: "report",
  analysis: "analysis-run",
  "analysis-json": "analysis-run",
  asm: "generated-source",
  source: "generated-source",
  tass: "generated-source",
  disasm: "listing",
  symbols: "other",
  sym: "other",
  doc: "other",
  docs: "other",
  md: "other",
  markdown: "other",
  payload: "prg",
  binary: "raw",
  bin: "raw",
  sector: "raw",
  image: "preview",
  png: "preview",
};

function kindHint(given: string): string {
  const alias = KIND_ALIASES[given.toLowerCase()];
  if (alias) return ` Did you mean "${alias}"?`;
  return "";
}

function describeAllowed(values: readonly string[]): string {
  return values.join(", ");
}

/**
 * Read (and validate) the project's own inventory declaration.
 *
 * Never throws: an unreadable file lands in `error`, a malformed entry in `problems`,
 * and the caller reports both. Both `project_inventory_sync` and the shared
 * registration scan go through here, so the two always answer with the same facts.
 */
export function readInventoryDeclaration(projectRoot: string): ProjectInventoryDeclaration {
  const path = join(projectRoot, INVENTORY_PATTERNS_FILE);
  if (!existsSync(path)) return EMPTY;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return {
      patterns: [],
      intentional: [],
      problems: [],
      error: `${INVENTORY_PATTERNS_FILE} could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      patterns: [],
      intentional: [],
      problems: [],
      error: `${INVENTORY_PATTERNS_FILE} must be a JSON object with "patterns" and/or "intentional"; found ${Array.isArray(raw) ? "an array" : typeof raw}.`,
    };
  }

  const problems: string[] = [];
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "patterns" && key !== "intentional") {
      problems.push(`${INVENTORY_PATTERNS_FILE}: unknown top-level key "${key}" — only "patterns" and "intentional" are read.`);
    }
  }

  const patterns: ProjectInventoryPattern[] = [];
  if (obj.patterns !== undefined) {
    if (!Array.isArray(obj.patterns)) {
      problems.push(`${INVENTORY_PATTERNS_FILE}: "patterns" must be an array; found ${typeof obj.patterns}.`);
    } else {
      obj.patterns.forEach((entry, i) => {
        const where = `${INVENTORY_PATTERNS_FILE}: patterns[${i}]`;
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          problems.push(`${where} must be an object with glob/kind/scope; found ${Array.isArray(entry) ? "an array" : typeof entry}.`);
          return;
        }
        const p = entry as Record<string, unknown>;
        const entryProblems: string[] = [];
        if (typeof p.glob !== "string" || p.glob.trim() === "") {
          entryProblems.push(`${where}.glob is required and must be a non-empty string (e.g. "analysis/payloads/**/*.prg").`);
        }
        if (typeof p.kind !== "string") {
          entryProblems.push(`${where}.kind is required. Allowed: ${describeAllowed(INVENTORY_KIND_VALUES)}.`);
        } else if (!KIND_SET.has(p.kind)) {
          entryProblems.push(`${where}.kind = ${JSON.stringify(p.kind)} is not a known artifact kind.${kindHint(p.kind)} Allowed: ${describeAllowed(INVENTORY_KIND_VALUES)}.`);
        }
        if (typeof p.scope !== "string") {
          entryProblems.push(`${where}.scope is required. Allowed: ${describeAllowed(INVENTORY_SCOPE_VALUES)}.`);
        } else if (!SCOPE_SET.has(p.scope)) {
          entryProblems.push(`${where}.scope = ${JSON.stringify(p.scope)} is not a known scope. Allowed: ${describeAllowed(INVENTORY_SCOPE_VALUES)}.`);
        }
        for (const opt of ["role", "format"] as const) {
          if (p[opt] !== undefined && typeof p[opt] !== "string") {
            entryProblems.push(`${where}.${opt} must be a string when present.`);
          }
        }
        if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== "string"))) {
          entryProblems.push(`${where}.tags must be an array of strings when present.`);
        }
        for (const key of Object.keys(p)) {
          if (!["glob", "kind", "scope", "role", "format", "tags"].includes(key)) {
            problems.push(`${where}: unknown key "${key}" — read keys are glob, kind, scope, role, format, tags.`);
          }
        }
        if (entryProblems.length > 0) {
          problems.push(...entryProblems, `${where} was NOT applied.`);
          return;
        }
        patterns.push({
          glob: p.glob as string,
          kind: p.kind as string,
          scope: p.scope as string,
          role: p.role as string | undefined,
          format: p.format as string | undefined,
          tags: p.tags as string[] | undefined,
        });
      });
    }
  }

  const intentional: string[] = [];
  if (obj.intentional !== undefined) {
    if (!Array.isArray(obj.intentional)) {
      problems.push(`${INVENTORY_PATTERNS_FILE}: "intentional" must be an array of globs; found ${typeof obj.intentional}.`);
    } else {
      obj.intentional.forEach((g, i) => {
        if (typeof g !== "string" || g.trim() === "") {
          problems.push(`${INVENTORY_PATTERNS_FILE}: intentional[${i}] must be a non-empty glob string; it was NOT applied.`);
          return;
        }
        intentional.push(g);
      });
    }
  }

  return { patterns, intentional, problems };
}

// ─────────────────────────────────────────────────────────── suggesting a declaration

// What kind an extension usually means in a c64re project. The suggestion has to be
// one a project can paste: `howToDeclare` used to answer "report" for anything ending
// in .json or .md and "prg" for literally everything else, so a directory of .sym or
// .bin files got a declaration that named the wrong kind, and the door that finally
// read it said nothing about why.
const KIND_BY_EXT: Record<string, InventoryKind> = {
  prg: "prg",
  crt: "crt",
  d64: "d64",
  g64: "g64",
  bin: "raw",
  asm: "generated-source",
  tas: "generated-source",
  tass: "generated-source",
  sym: "other",
  md: "other",
  html: "other",
  png: "preview",
  jsonl: "trace",
  json: "report",
};

const ROLE_BY_EXT: Record<string, string> = {
  prg: "payload",
  bin: "raw-block",
  asm: "source",
  tas: "source",
  tass: "source",
  sym: "symbols",
  md: "notes",
  html: "report",
  png: "preview",
  jsonl: "trace",
  json: "report",
};

const FORMAT_BY_EXT: Record<string, string> = {
  asm: "asm", tas: "tass", tass: "tass", json: "json", jsonl: "jsonl",
  md: "md", png: "png", html: "html", sym: "sym", bin: "bin", prg: "prg",
};

function extOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m?.[1] ?? "").toLowerCase();
}

/** The kind that fits THIS file, filename specials first, then the extension. */
export function suggestedKindFor(relPath: string): InventoryKind {
  const file = relPath.split("/").pop() ?? relPath;
  if (/_analysis\.json$/i.test(file)) return "analysis-run";
  if (/^manifest[.-].*\.json$|^manifest\.json$/i.test(file)) return "manifest";
  if (/_disasm\.(asm|tas|tass)$/i.test(file)) return "listing";
  return KIND_BY_EXT[extOf(relPath)] ?? "other";
}

/** The scope that fits the directory the file sits in. */
export function suggestedScopeFor(relPath: string): InventoryScope {
  const top = relPath.split("/")[0] ?? "";
  if (top === "input") return "input";
  if (top === "views") return "view";
  if (top === "docs") return "knowledge";
  if (top === "build" || top === "generated") return "generated";
  if (top === "session") return "session";
  return "analysis";
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function commonDirPrefix(dirs: string[]): string {
  if (dirs.length === 0) return "";
  const split = dirs.map((d) => d.split("/").filter(Boolean));
  const first = split[0]!;
  let n = 0;
  while (n < first.length && split.every((parts) => parts[n] === first[n])) n += 1;
  return first.slice(0, n).join("/");
}

/** A pattern entry that would cover exactly this group of files. */
export function suggestPatternFor(examples: string[]): ProjectInventoryPattern {
  const ext = extOf(examples[0] ?? "") || "prg";
  const dirs = [...new Set(examples.map(dirOf))];
  const prefix = commonDirPrefix(dirs) || "analysis";
  const flat = dirs.every((d) => d === prefix);
  const glob = `${prefix}/${flat ? "" : "**/"}*.${ext}`;
  const kind = suggestedKindFor(examples[0] ?? `x.${ext}`);
  const pattern: ProjectInventoryPattern = {
    glob,
    kind,
    scope: suggestedScopeFor(examples[0] ?? ""),
  };
  const role = ROLE_BY_EXT[ext];
  if (role) pattern.role = role;
  const format = FORMAT_BY_EXT[ext];
  if (format) pattern.format = format;
  return pattern;
}

/** The text a report prints when files match nothing — it must say how to settle it. */
export function howToDeclare(examples: string[]): string[] {
  // Group by extension: one paste-able entry per file type actually present, rather
  // than one guess derived from whichever file happened to sort first.
  const byExt = new Map<string, string[]>();
  for (const e of examples) {
    const ext = extOf(e) || "other";
    const list = byExt.get(ext) ?? [];
    list.push(e);
    byExt.set(ext, list);
  }
  const groups = [...byExt.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4);
  const entries = groups.map(([, files]) => suggestPatternFor(files));
  const body = entries.length > 0
    ? entries.map((p) => `    ${JSON.stringify(p)}`).join(",\n")
    : `    ${JSON.stringify(suggestPatternFor(["analysis/mine/thing.prg"]))}`;
  const lines = [
    `Declare them in ${INVENTORY_PATTERNS_FILE} and they stop being reported:`,
    `  { "patterns": [`,
    body,
    `  ], "intentional": [] }`,
    `  \`patterns\` registers the files as artifacts; \`intentional\` is a glob list that only silences them.`,
    `  Allowed kind: ${describeAllowed(INVENTORY_KIND_VALUES)}.`,
    `  Allowed scope: ${describeAllowed(INVENTORY_SCOPE_VALUES)}.`,
  ];
  if (groups.length < byExt.size) {
    lines.push(`  (${byExt.size - groups.length} further file type(s) present — same shape, one entry each.)`);
  }
  return lines;
}

// ──────────────────────────────────────────────── a pattern that matched nothing

/** The literal part of a glob, up to the first wildcard. `analysis/overlays/*.prg` → `analysis/overlays`. */
function globDirPrefix(glob: string): string {
  const cut = glob.search(/[*?[]/);
  const literal = cut < 0 ? glob : glob.slice(0, cut);
  const slash = literal.lastIndexOf("/");
  return slash < 0 ? "" : literal.slice(0, slash);
}

/** The extension a glob asks for, when it ends in one. */
function globExt(glob: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(glob);
  return (m?.[1] ?? "").toLowerCase();
}

/**
 * Why a well-formed declared pattern matched nothing.
 *
 * The previous round taught this file to explain a MALFORMED entry — a bad
 * `kind`, a missing `glob`, an unknown key. A well-formed entry that simply
 * matches nothing was accepted in silence: a project declared
 * `analysis/overlays/*.prg`, saw no complaint, and 207 outputs stayed
 * unregistered with nothing anywhere saying why. Advice nobody can act on and
 * silence are the same failure; this is the sentence that was missing.
 *
 * `candidates` are the project-relative paths the registration walk saw, so the
 * diagnosis is made of what is actually on disk rather than of guesses.
 */
export function diagnoseEmptyPattern(projectRoot: string, glob: string, candidates: readonly string[]): string[] {
  const dir = globDirPrefix(glob);
  const ext = globExt(glob);
  const out: string[] = [`${INVENTORY_PATTERNS_FILE}: "${glob}" matched no file.`];

  const dirExists = dir === "" || existsSync(join(projectRoot, dir));
  if (!dirExists) {
    // Name the nearest directory that DOES exist, so "I mistyped the path" is
    // one glance rather than a hunt.
    const parts = dir.split("/");
    let nearest = "";
    for (let i = parts.length - 1; i > 0; i -= 1) {
      const candidate = parts.slice(0, i).join("/");
      if (existsSync(join(projectRoot, candidate))) { nearest = candidate; break; }
    }
    out.push(`  ${dir}/ does not exist${nearest ? ` — the deepest part of that path that does is ${nearest}/` : " in this project"}.`);
    return out;
  }

  const under = candidates.filter((c) => dir === "" || c === dir || c.startsWith(`${dir}/`));
  if (under.length === 0) {
    out.push(`  ${dir}/ exists but the walk found no registerable file under it (empty, or nothing with a known extension).`);
    return out;
  }
  const byExt = new Map<string, number>();
  for (const c of under) {
    const e = (/\.([A-Za-z0-9]+)$/.exec(c)?.[1] ?? "").toLowerCase();
    byExt.set(e, (byExt.get(e) ?? 0) + 1);
  }
  const have = [...byExt.entries()].sort((a, b) => b[1] - a[1]);
  out.push(`  ${dir}/ holds ${under.length} file(s): ${have.map(([e, n]) => `${n} .${e || "(no extension)"}`).join(", ")}.`);
  if (ext && !byExt.has(ext)) {
    out.push(`  The pattern asks for .${ext}, which is not among them.`);
  }
  // Is it only the depth? `dir/*.ext` does not cross a directory boundary.
  if (!glob.includes("**")) {
    const deeper = under.filter((c) => c.slice(dir.length + 1).includes("/"));
    if (deeper.length > 0) {
      out.push(`  ${deeper.length} of them sit in SUBdirectories; \`*\` stops at a path separator. Try "${dir}/**/*.${ext || "prg"}".`);
    }
  }
  const sample = under.slice(0, 3);
  const suggestion = suggestPatternFor(sample);
  out.push(`  A pattern that would cover what is there: ${JSON.stringify(suggestion)}`);
  out.push(`  (e.g. ${sample.join(", ")})`);
  return out;
}
