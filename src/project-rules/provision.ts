// Spec 849 — provisioning the harness rules into a project.
//
// `.claude/rules/*.md` with a `paths:` glob is the one steering layer that fires because
// a file was touched rather than because the model judged its own task correctly. That
// makes it the only place that can speak DURING the work: Specs 844-848 put pressure at
// session start (the onboarding handover) and at delivery (the slot gates, the critic),
// and the middle of a run was silent.
//
// The rules live in this repo under `assets/project-rules/` — versioned, smoke-tested,
// and written once — and are copied into each project, because the harness reads
// `.claude/rules/` relative to the SESSION's working directory, which for RE work is the
// project and not this repo.
//
// Two moments provision: `project_init` creates them, and `agent_onboard` re-syncs them.
// Init alone would freeze a project's rules at the day it was created, and a rule
// corrected here would never reach the projects that already exist. `agent_onboard` is
// the call every session makes first, including an unattended one that never starts a UI.
//
// A file the owner edited is never overwritten. The provisioner keeps the hash of what it
// SHIPPED, not of what is on disk; a file that still matches its shipped hash is
// untouched and may be replaced, and anything else is a hand-edit and is left alone.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `.claude/rules/<name>` relative to the project root. */
export const RULES_DIR = join(".claude", "rules");
const LEDGER = ".provisioned.json";

export interface ProjectRulesResult {
  /** rule files newly written */
  created: string[];
  /** rule files replaced with a newer shipped version */
  updated: string[];
  /** rule files left alone because they were edited by hand */
  handEdited: string[];
  /** already current */
  unchanged: string[];
  /** why nothing happened, when nothing did */
  skipped?: string;
}

interface Ledger {
  /** file name → sha256 of the content this repo shipped */
  shipped: Record<string, string>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Where the shipped rules live.
 *
 * Walked up from this module rather than taken from a caller, because the two call sites
 * sit in different subsystems and only one of them already carries `repoDir`. Works from
 * `src/` under tsx and from `dist/` after a build, since both are inside the repo.
 */
export function shippedRulesDir(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "assets", "project-rules");
    if (existsSync(candidate)) return candidate;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** The rule files this repo ships, in name order. README.md documents them; it is not one. */
export function shippedRules(assetsDir: string): string[] {
  return readdirSync(assetsDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();
}

function readLedger(rulesDir: string): Ledger {
  try {
    const raw = JSON.parse(readFileSync(join(rulesDir, LEDGER), "utf8")) as Partial<Ledger>;
    if (raw && typeof raw.shipped === "object" && raw.shipped) {
      return { shipped: Object.fromEntries(Object.entries(raw.shipped).map(([k, v]) => [k, String(v)])) };
    }
  } catch { /* absent or unreadable: everything counts as not yet shipped */ }
  return { shipped: {} };
}

/**
 * Write the shipped rules into `<projectDir>/.claude/rules/`, leaving hand-edits alone.
 *
 * Best-effort by construction: provisioning is a side errand of `project_init` and
 * `agent_onboard`, and neither may fail because a rule file could not be written.
 */
export function ensureProjectRules(projectDir: string): ProjectRulesResult {
  const result: ProjectRulesResult = { created: [], updated: [], handEdited: [], unchanged: [] };
  const assets = shippedRulesDir();
  if (!assets) return { ...result, skipped: "shipped rules not found next to the server" };

  const rulesDir = join(projectDir, RULES_DIR);
  try {
    mkdirSync(rulesDir, { recursive: true });
  } catch {
    return { ...result, skipped: `cannot create ${rulesDir}` };
  }

  const ledger = readLedger(rulesDir);
  for (const name of shippedRules(assets)) {
    let body: string;
    try {
      body = readFileSync(join(assets, name), "utf8");
    } catch { continue; }
    const want = sha256(body);
    const target = join(rulesDir, name);

    try {
      if (!existsSync(target)) {
        writeFileSync(target, body);
        ledger.shipped[name] = want;
        result.created.push(name);
        continue;
      }
      const have = sha256(readFileSync(target, "utf8"));
      if (have === want) {
        // Identical; record the hash in case this project predates the ledger.
        ledger.shipped[name] = want;
        result.unchanged.push(name);
      } else if (ledger.shipped[name] === have) {
        // Untouched since we shipped it, and we now ship something else.
        writeFileSync(target, body);
        ledger.shipped[name] = want;
        result.updated.push(name);
      } else {
        result.handEdited.push(name);
      }
    } catch {
      result.handEdited.push(name); // unreadable or unwritable: never clobber blindly
    }
  }

  try {
    writeFileSync(join(rulesDir, LEDGER), JSON.stringify(ledger, null, 2) + "\n");
  } catch { /* the ledger is an optimisation; without it a hand-edit is simply kept */ }

  return result;
}

/** One line for a tool report, or undefined when there is nothing worth saying. */
export function summariseProjectRules(r: ProjectRulesResult): string | undefined {
  if (r.skipped) return `Project rules: not provisioned (${r.skipped}).`;
  const parts: string[] = [];
  if (r.created.length) parts.push(`${r.created.length} written`);
  if (r.updated.length) parts.push(`${r.updated.length} updated`);
  if (r.handEdited.length) parts.push(`${r.handEdited.length} kept as hand-edited (${r.handEdited.join(", ")})`);
  if (parts.length === 0) return undefined;
  return `Project rules (.claude/rules): ${parts.join(", ")}.`;
}
