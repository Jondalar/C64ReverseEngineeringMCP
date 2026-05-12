// Spec 268 — Scenario registry.
//
// Lists, saves, and deletes scenario JSON files from:
//   1. <repo>/samples/scenarios/*.json  (built-in samples)
//   2. <C64RE_PROJECT_DIR>/scenarios/*.json  (project-local)
//
// Each file is one Scenario object (Spec 231) with an added `savedAt` ISO timestamp.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario } from "./scenario.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Repo-relative samples/scenarios directory (four levels up from v2/).
const REPO_ROOT = resolve(__dirname, "../../../../..");
const SAMPLES_DIR = join(REPO_ROOT, "samples", "scenarios");

export interface SavedScenario extends Scenario {
  savedAt: string;
}

export interface ScenarioSummary {
  id: string;
  diskPath: string;
  mode: string;
  cycleBudget: number;
  inputCount: number;
  savedAt: string;
  /** Absolute file path for this scenario. */
  filePath: string;
  /** "samples" | "project" */
  source: "samples" | "project";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectScenariosDir(): string | null {
  const projectDir = process.env.C64RE_PROJECT_DIR;
  if (!projectDir) return null;
  return join(projectDir, "scenarios");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readScenarioFile(filePath: string): SavedScenario | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const obj = JSON.parse(raw) as SavedScenario;
    if (!obj.id || !obj.diskPath) return null;
    return obj;
  } catch {
    return null;
  }
}

function summarise(s: SavedScenario, filePath: string, source: "samples" | "project"): ScenarioSummary {
  return {
    id: s.id,
    diskPath: s.diskPath,
    mode: s.mode,
    cycleBudget: s.cycleBudget,
    inputCount: Array.isArray(s.inputs) ? s.inputs.length : 0,
    savedAt: s.savedAt ?? "",
    filePath,
    source,
  };
}

function scanDir(dir: string, source: "samples" | "project"): ScenarioSummary[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).filter(f => f.endsWith(".json"));
  const results: ScenarioSummary[] = [];
  for (const name of entries) {
    const fp = join(dir, name);
    const obj = readScenarioFile(fp);
    if (obj) results.push(summarise(obj, fp, source));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all scenarios from samples dir + project dir. */
export function listScenarios(): ScenarioSummary[] {
  const samplesResults = scanDir(SAMPLES_DIR, "samples");
  const projectDir = projectScenariosDir();
  const projectResults = projectDir ? scanDir(projectDir, "project") : [];
  // Merge; project overrides samples if same id.
  const byId = new Map<string, ScenarioSummary>();
  for (const s of samplesResults) byId.set(s.id, s);
  for (const s of projectResults) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Load full scenario by id. Checks project dir first, then samples. */
export function loadScenario(id: string): SavedScenario | null {
  const projectDir = projectScenariosDir();
  if (projectDir) {
    const fp = join(projectDir, `${id}.json`);
    if (existsSync(fp)) return readScenarioFile(fp);
  }
  const fp = join(SAMPLES_DIR, `${id}.json`);
  if (existsSync(fp)) return readScenarioFile(fp);
  return null;
}

/** Save scenario JSON to project dir (creates if absent). */
export function saveScenario(scenario: Scenario): { filePath: string } {
  const projectDir = projectScenariosDir();
  const dir = projectDir ?? SAMPLES_DIR;
  ensureDir(dir);
  const saved: SavedScenario = {
    ...scenario,
    // startSnapshot as bytes → base64 if needed; keep string paths as-is.
    startSnapshot: scenario.startSnapshot instanceof Uint8Array
      ? Buffer.from(scenario.startSnapshot).toString("base64")
      : scenario.startSnapshot,
    savedAt: new Date().toISOString(),
  } as unknown as SavedScenario;
  const fp = join(dir, `${scenario.id}.json`);
  writeFileSync(fp, JSON.stringify(saved, null, 2), "utf8");
  return { filePath: fp };
}

/** Delete scenario by id. Returns true if file was removed. */
export function deleteScenario(id: string): boolean {
  const projectDir = projectScenariosDir();
  if (projectDir) {
    const fp = join(projectDir, `${id}.json`);
    if (existsSync(fp)) { unlinkSync(fp); return true; }
  }
  const fp = join(SAMPLES_DIR, `${id}.json`);
  if (existsSync(fp)) { unlinkSync(fp); return true; }
  return false;
}
