// Spec 250 — Regression vs known-good baselines.
//
// Two entry-points:
//   regressionCaptureBaseline(scenarioId, registry) — run scenario, persist
//     trace + artifacts to samples/regression-baselines/<scenarioId>/,
//     prune oldest if > N=10 baselines.
//   regressionCompare(scenarioId, registry) — run scenario, open baseline.duckdb,
//     join events by (family, cycle), emit RegressionResult.
//
// OQ1 resolved: DuckDB inline in samples/regression-baselines/.
// OQ2 resolved: LLM-explicit only — CI reads; agents write via this API.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// DivergenceRecord (Spec 236 shape — local stub until 236 merges)
// ---------------------------------------------------------------------------

export type DivergenceClassification =
  | "cpu_register"
  | "memory_io"
  | "interrupt_timing"
  | "iec_line"
  | "cia_register"
  | "via_register"
  | "vic_register"
  | "drive_pc"
  | "unknown";

export interface DivergenceRecord {
  scenarioId: string;
  firstDivergeCycle: number;
  /** Which event-family diverged first. */
  divergenceFamily: string;
  /** Baseline side row at divergence point. */
  baseline: Record<string, unknown>;
  /** Current-run side row at divergence point. */
  current: Record<string, unknown>;
  context: {
    baselineWindow: Record<string, unknown>[];
    currentWindow: Record<string, unknown>[];
    /** Number of cycle-equal events before first mismatch. */
    sharedPrefix: number;
  };
  classification: DivergenceClassification;
}

// ---------------------------------------------------------------------------
// RegressionResult
// ---------------------------------------------------------------------------

export type RegressionClassification =
  | "no_drift"
  | "minor_drift"
  | "structural_change"
  | "broken";

export interface RegressionResult {
  scenarioId: string;
  /** git short-sha of the stored baseline. */
  baselineCommit: string;
  /** git short-sha of the current HEAD. */
  currentCommit: string;
  /** true iff all hashes match exactly. */
  identical: boolean;
  divergence?: DivergenceRecord;
  classification: RegressionClassification;
  /** 1-line agent-friendly narrative. */
  narrative: string;
}

export interface Hashes {
  ramHash: string;
  screenshotHash: string;
  traceHash: string;
  eventCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BASELINES = 10;
const BASELINE_ROOT = join(process.cwd(), "samples", "regression-baselines");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _sha256(data: Uint8Array | string): string {
  const h = createHash("sha256");
  if (typeof data === "string") h.update(data, "utf8");
  else h.update(data);
  return h.digest("hex");
}

function scenarioBaseDir(scenarioId: string): string {
  return join(BASELINE_ROOT, scenarioId);
}

function baselineDbPath(scenarioId: string): string {
  return join(scenarioBaseDir(scenarioId), "baseline.duckdb");
}

function artifactDir(scenarioId: string, commitSha: string): string {
  return join(scenarioBaseDir(scenarioId), "artifacts", commitSha);
}

function latestJsonPath(scenarioId: string): string {
  return join(scenarioBaseDir(scenarioId), "latest.json");
}

function gitCommitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "dev-" + Date.now().toString(16);
  }
}

// ---------------------------------------------------------------------------
// Scenario run output shape
// ---------------------------------------------------------------------------

export interface ScenarioRunOutput {
  ramHash: string;
  screenshotHash: string;
  traceHash: string;
  /** Ordered (cycle, family, payload-hash) tuples for event-level comparison. */
  events: Array<{ cycle: number; family: string; payloadHash: string }>;
  cyclesRan: number;
}

/**
 * Run a named scenario via the compiled runScenario module.
 * Throws if the scenario is not in registry or the module is unavailable.
 */
export async function runScenarioById(
  scenarioId: string,
  scenarioRegistry: Map<string, unknown>,
): Promise<ScenarioRunOutput> {
  const scenario = scenarioRegistry.get(scenarioId);
  if (!scenario) {
    throw new Error(`Scenario '${scenarioId}' not found in registry`);
  }

  let runScenario: (s: unknown) => unknown;
  try {
    // Dynamic path avoids static TS module resolution — scenario.js ships in
    // Spec 231 (agent-workflows branch); this worktree stub degrades gracefully.
    const scenarioPath = new URL("./scenario.js", import.meta.url).href;
    const mod = await import(scenarioPath) as { runScenario: (s: unknown) => unknown };
    runScenario = mod.runScenario;
  } catch {
    throw new Error(`runScenario module unavailable (build missing for scenario.js)`);
  }

  const result = runScenario(scenario) as {
    ramHash: string;
    screenshotHash: string;
    traceHash: string;
    cyclesRan: number;
  };

  return {
    ramHash: result.ramHash,
    screenshotHash: result.screenshotHash,
    traceHash: result.traceHash,
    events: [],
    cyclesRan: result.cyclesRan,
  };
}

// ---------------------------------------------------------------------------
// Baseline DuckDB schema (regression-specific tables only)
// ---------------------------------------------------------------------------

// Statements split on double-newline to avoid splitting on semicolons inside
// INDEX statements. We use explicit array instead.
const BASELINE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS regression_runs (
    run_id           TEXT NOT NULL,
    scenario_id      TEXT NOT NULL,
    commit_sha       TEXT NOT NULL,
    captured_at      TEXT NOT NULL,
    cycles_ran       INTEGER NOT NULL,
    ram_hash         TEXT NOT NULL,
    screenshot_hash  TEXT NOT NULL,
    trace_hash       TEXT NOT NULL,
    event_count      INTEGER NOT NULL,
    classification   TEXT NOT NULL,
    PRIMARY KEY (run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS regression_events (
    run_id       TEXT NOT NULL,
    cycle        BIGINT NOT NULL,
    family       TEXT NOT NULL,
    payload_hash TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_revents_run_cycle
    ON regression_events (run_id, cycle)`,
];

// ---------------------------------------------------------------------------
// Open / close baseline store
// ---------------------------------------------------------------------------

interface BaselineStore {
  conn: any; // duckdb connection
  inst: any; // duckdb instance
}

async function openBaselineStore(dbPath: string): Promise<BaselineStore> {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const { DuckDBInstance } = (await import("@duckdb/node-api")) as any;
  const inst = await DuckDBInstance.create(dbPath);
  const conn = await inst.connect();
  for (const stmt of BASELINE_DDL) {
    await conn.run(stmt);
  }
  return { conn, inst };
}

async function closeBaselineStore(store: BaselineStore): Promise<void> {
  if (store.inst?.closeSync) store.inst.closeSync();
}

// ---------------------------------------------------------------------------
// Pruning — keep newest MAX_BASELINES run_ids per scenario
// ---------------------------------------------------------------------------

async function pruneOldBaselines(
  conn: any,
  scenarioId: string,
): Promise<void> {
  const safeId = scenarioId.replace(/'/g, "''");
  const rows = await conn.runAndReadAll(
    `SELECT run_id FROM regression_runs
     WHERE scenario_id = '${safeId}'
     ORDER BY captured_at DESC`,
  );
  const all: string[] = rows.getRowObjects().map((r: any) => String(r.run_id));
  if (all.length <= MAX_BASELINES) return;

  const toDelete = all.slice(MAX_BASELINES);
  for (const rid of toDelete) {
    const safe = rid.replace(/'/g, "''");
    await conn.run(`DELETE FROM regression_runs WHERE run_id = '${safe}'`);
    await conn.run(`DELETE FROM regression_events WHERE run_id = '${safe}'`);
  }
}

// ---------------------------------------------------------------------------
// Insert a baseline run
// ---------------------------------------------------------------------------

async function insertBaselineRun(
  conn: any,
  scenarioId: string,
  commitSha: string,
  output: ScenarioRunOutput,
  classification: RegressionClassification,
): Promise<string> {
  const runId = `${scenarioId}-${commitSha}-${Date.now()}`;
  const capturedAt = new Date().toISOString();

  const safeRunId    = runId.replace(/'/g, "''");
  const safeScenario = scenarioId.replace(/'/g, "''");
  const safeCommit   = commitSha.replace(/'/g, "''");
  const safeCls      = classification.replace(/'/g, "''");
  const safeRam      = output.ramHash.replace(/'/g, "''");
  const safeSS       = output.screenshotHash.replace(/'/g, "''");
  const safeTr       = output.traceHash.replace(/'/g, "''");

  await conn.run(
    `INSERT INTO regression_runs
       (run_id, scenario_id, commit_sha, captured_at, cycles_ran,
        ram_hash, screenshot_hash, trace_hash, event_count, classification)
     VALUES (
       '${safeRunId}', '${safeScenario}', '${safeCommit}',
       '${capturedAt}', ${output.cyclesRan},
       '${safeRam}', '${safeSS}', '${safeTr}',
       ${output.events.length}, '${safeCls}'
     )`,
  );

  if (output.events.length > 0) {
    const batchSize = 500;
    for (let i = 0; i < output.events.length; i += batchSize) {
      const batch = output.events.slice(i, i + batchSize);
      const values = batch
        .map(
          (e) =>
            `('${safeRunId}', ${e.cycle}, '${e.family.replace(/'/g, "''")}', '${e.payloadHash}')`,
        )
        .join(", ");
      await conn.run(
        `INSERT INTO regression_events (run_id, cycle, family, payload_hash) VALUES ${values}`,
      );
    }
  }

  return runId;
}

// ---------------------------------------------------------------------------
// Fetch latest baseline run for a scenario
// ---------------------------------------------------------------------------

interface StoredBaseline {
  runId: string;
  commitSha: string;
  ramHash: string;
  screenshotHash: string;
  traceHash: string;
  eventCount: number;
  events: Array<{ cycle: number; family: string; payloadHash: string }>;
}

async function fetchLatestBaselineRun(
  conn: any,
  scenarioId: string,
): Promise<StoredBaseline | null> {
  const safeId = scenarioId.replace(/'/g, "''");
  const meta = await conn.runAndReadAll(
    `SELECT * FROM regression_runs
     WHERE scenario_id = '${safeId}'
     ORDER BY captured_at DESC LIMIT 1`,
  );
  const metaRows = meta.getRowObjects();
  if (metaRows.length === 0) return null;

  const m = metaRows[0] as any;
  const runId = String(m.run_id);
  const safeRunId = runId.replace(/'/g, "''");

  const evts = await conn.runAndReadAll(
    `SELECT cycle, family, payload_hash FROM regression_events
     WHERE run_id = '${safeRunId}'
     ORDER BY cycle LIMIT 100000`,
  );
  const events = evts.getRowObjects().map((r: any) => ({
    cycle: Number(r.cycle),
    family: String(r.family),
    payloadHash: String(r.payload_hash),
  }));

  return {
    runId,
    commitSha: String(m.commit_sha),
    ramHash: String(m.ram_hash),
    screenshotHash: String(m.screenshot_hash),
    traceHash: String(m.trace_hash),
    eventCount: Number(m.event_count),
    events,
  };
}

// ---------------------------------------------------------------------------
// List all run_ids for a scenario (for pruning smoke test)
// ---------------------------------------------------------------------------

export async function listBaselineRunIds(
  scenarioId: string,
): Promise<{ runId: string; capturedAt: string; commitSha: string }[]> {
  const dbPath = baselineDbPath(scenarioId);
  if (!existsSync(dbPath)) return [];
  const store = await openBaselineStore(dbPath);
  try {
    const safeId = scenarioId.replace(/'/g, "''");
    const rows = await store.conn.runAndReadAll(
      `SELECT run_id, captured_at, commit_sha FROM regression_runs
       WHERE scenario_id = '${safeId}'
       ORDER BY captured_at DESC`,
    );
    return rows.getRowObjects().map((r: any) => ({
      runId: String(r.run_id),
      capturedAt: String(r.captured_at),
      commitSha: String(r.commit_sha),
    }));
  } finally {
    await closeBaselineStore(store);
  }
}

// ---------------------------------------------------------------------------
// Divergence analysis
// ---------------------------------------------------------------------------

function analyzeEvents(
  scenarioId: string,
  baselineEvents: Array<{ cycle: number; family: string; payloadHash: string }>,
  currentEvents: Array<{ cycle: number; family: string; payloadHash: string }>,
): DivergenceRecord | null {
  const len = Math.min(baselineEvents.length, currentEvents.length);
  let sharedPrefix = 0;
  let firstDiverge: {
    cycle: number;
    family: string;
    baseline: Record<string, unknown>;
    current: Record<string, unknown>;
  } | undefined;

  for (let i = 0; i < len; i++) {
    const b = baselineEvents[i]!;
    const c = currentEvents[i]!;
    if (
      b.cycle === c.cycle &&
      b.family === c.family &&
      b.payloadHash === c.payloadHash
    ) {
      sharedPrefix++;
    } else {
      firstDiverge = {
        cycle: Math.min(b.cycle, c.cycle),
        family: b.family,
        baseline: { cycle: b.cycle, family: b.family, payloadHash: b.payloadHash },
        current: { cycle: c.cycle, family: c.family, payloadHash: c.payloadHash },
      };
      break;
    }
  }

  if (!firstDiverge) return null;

  const idx = sharedPrefix;
  const baselineWindow = baselineEvents.slice(
    Math.max(0, idx - 10),
    idx + 10,
  ) as Record<string, unknown>[];
  const currentWindow = currentEvents.slice(
    Math.max(0, idx - 10),
    idx + 10,
  ) as Record<string, unknown>[];

  return {
    scenarioId,
    firstDivergeCycle: firstDiverge.cycle,
    divergenceFamily: firstDiverge.family,
    baseline: firstDiverge.baseline,
    current: firstDiverge.current,
    context: { baselineWindow, currentWindow, sharedPrefix },
    classification: classifyDivergence(firstDiverge.family),
  };
}

function classifyDivergence(family: string): DivergenceClassification {
  if (family.startsWith("cpu_")) return "cpu_register";
  if (family.startsWith("mem_")) return "memory_io";
  if (family.startsWith("irq_") || family.startsWith("nmi_")) return "interrupt_timing";
  if (
    family.startsWith("drive_atn") ||
    family.startsWith("drive_clk") ||
    family.startsWith("drive_data")
  )
    return "iec_line";
  if (family.startsWith("cia_")) return "cia_register";
  if (family.startsWith("via_")) return "via_register";
  if (family.startsWith("vic_")) return "vic_register";
  return "unknown";
}

function classifyRegression(
  traceIdentical: boolean,
  ramIdentical: boolean,
  divergence: DivergenceRecord | null,
): RegressionClassification {
  if (traceIdentical && ramIdentical) return "no_drift";
  if (!divergence) return "minor_drift";
  return divergence.context.sharedPrefix < 100 ? "structural_change" : "minor_drift";
}

function buildNarrative(
  scenarioId: string,
  classification: RegressionClassification,
  divergence: DivergenceRecord | null,
  baselineCommit: string,
  currentCommit: string,
): string {
  switch (classification) {
    case "no_drift":
      return `${scenarioId}: identical to baseline@${baselineCommit} (current=${currentCommit})`;
    case "minor_drift":
      return divergence
        ? `${scenarioId}: minor drift at cycle ${divergence.firstDivergeCycle} (${divergence.divergenceFamily}), baseline@${baselineCommit}`
        : `${scenarioId}: hash mismatch vs baseline@${baselineCommit} but no event divergence found`;
    case "structural_change":
      return `${scenarioId}: structural change at cycle ${divergence!.firstDivergeCycle} (${divergence!.divergenceFamily}), sharedPrefix=${divergence!.context.sharedPrefix}`;
    case "broken":
      return `${scenarioId}: broken — no baseline or execution error`;
  }
}

// ---------------------------------------------------------------------------
// Public API: regressionCaptureBaseline
// ---------------------------------------------------------------------------

/**
 * Run the scenario identified by `scenarioId` and persist the results as a
 * new baseline entry in `samples/regression-baselines/<scenarioId>/baseline.duckdb`.
 * Also writes `artifacts/<commit-sha>/meta.json` and `latest.json`.
 * Prunes to keep at most N=10 baselines per scenario.
 */
export async function regressionCaptureBaseline(
  scenarioId: string,
  scenarioRegistry: Map<string, unknown>,
): Promise<{ path: string; hashes: Hashes }> {
  const commitSha = gitCommitSha();
  const baseDir = scenarioBaseDir(scenarioId);
  const dbPath = baselineDbPath(scenarioId);

  mkdirSync(baseDir, { recursive: true });

  let output: ScenarioRunOutput;
  try {
    output = await runScenarioById(scenarioId, scenarioRegistry);
  } catch (err) {
    throw new Error(
      `regressionCaptureBaseline: failed to run scenario '${scenarioId}': ${
        (err as Error).message
      }`,
    );
  }

  const store = await openBaselineStore(dbPath);
  try {
    const classification: RegressionClassification = "no_drift";
    const runId = await insertBaselineRun(
      store.conn,
      scenarioId,
      commitSha,
      output,
      classification,
    );
    await pruneOldBaselines(store.conn, scenarioId);

    // Write artifact files.
    const artDir = artifactDir(scenarioId, commitSha);
    mkdirSync(artDir, { recursive: true });

    const meta = {
      runId,
      date: new Date().toISOString(),
      headlessVersion: commitSha,
      eventCount: output.events.length,
      classification,
      cyclesRan: output.cyclesRan,
      ramHash: output.ramHash,
      screenshotHash: output.screenshotHash,
      traceHash: output.traceHash,
    };
    writeFileSync(join(artDir, "meta.json"), JSON.stringify(meta, null, 2));

    // Update latest.json.
    writeFileSync(
      latestJsonPath(scenarioId),
      JSON.stringify({ commitSha, runId, capturedAt: meta.date }, null, 2),
    );

    return {
      path: dbPath,
      hashes: {
        ramHash: output.ramHash,
        screenshotHash: output.screenshotHash,
        traceHash: output.traceHash,
        eventCount: output.events.length,
      },
    };
  } finally {
    await closeBaselineStore(store);
  }
}

// ---------------------------------------------------------------------------
// Public API: regressionCompare
// ---------------------------------------------------------------------------

/**
 * Run `scenarioId` and compare against the latest stored baseline.
 * Returns a `RegressionResult` describing any drift.
 * If no baseline exists, classification = "broken".
 */
export async function regressionCompare(
  scenarioId: string,
  scenarioRegistry: Map<string, unknown>,
): Promise<RegressionResult> {
  const commitSha = gitCommitSha();
  const dbPath = baselineDbPath(scenarioId);

  if (!existsSync(dbPath)) {
    return {
      scenarioId,
      baselineCommit: "none",
      currentCommit: commitSha,
      identical: false,
      classification: "broken",
      narrative: `${scenarioId}: no baseline found at ${dbPath} — run regress:capture first`,
    };
  }

  // Run current scenario.
  let currentOutput: ScenarioRunOutput;
  try {
    currentOutput = await runScenarioById(scenarioId, scenarioRegistry);
  } catch (err) {
    return {
      scenarioId,
      baselineCommit: "unknown",
      currentCommit: commitSha,
      identical: false,
      classification: "broken",
      narrative: `${scenarioId}: scenario run failed — ${(err as Error).message}`,
    };
  }

  // Open baseline and fetch latest run.
  const store = await openBaselineStore(dbPath);
  try {
    const baseline = await fetchLatestBaselineRun(store.conn, scenarioId);
    if (!baseline) {
      return {
        scenarioId,
        baselineCommit: "none",
        currentCommit: commitSha,
        identical: false,
        classification: "broken",
        narrative: `${scenarioId}: baseline DB exists but contains no runs`,
      };
    }

    const traceIdentical =
      baseline.traceHash === currentOutput.traceHash &&
      baseline.ramHash === currentOutput.ramHash;
    const ramIdentical = baseline.ramHash === currentOutput.ramHash;

    const divergence = traceIdentical
      ? null
      : analyzeEvents(scenarioId, baseline.events, currentOutput.events);

    const classification = classifyRegression(traceIdentical, ramIdentical, divergence);
    const narrative = buildNarrative(
      scenarioId,
      classification,
      divergence,
      baseline.commitSha,
      commitSha,
    );

    return {
      scenarioId,
      baselineCommit: baseline.commitSha,
      currentCommit: commitSha,
      identical: classification === "no_drift",
      divergence: divergence ?? undefined,
      classification,
      narrative,
    };
  } finally {
    await closeBaselineStore(store);
  }
}

// ---------------------------------------------------------------------------
// Public API: regressionReport
// ---------------------------------------------------------------------------

export interface ScenarioReportEntry {
  scenarioId: string;
  result: RegressionResult | { classification: "broken"; narrative: string };
}

/**
 * Compare all scenarios in the registry. Returns one entry per scenario.
 */
export async function regressionReport(
  scenarioRegistry: Map<string, unknown>,
): Promise<ScenarioReportEntry[]> {
  const entries: ScenarioReportEntry[] = [];
  for (const scenarioId of scenarioRegistry.keys()) {
    try {
      const result = await regressionCompare(scenarioId, scenarioRegistry);
      entries.push({ scenarioId, result });
    } catch (err) {
      entries.push({
        scenarioId,
        result: {
          classification: "broken",
          narrative: `${scenarioId}: unexpected error — ${(err as Error).message}`,
        },
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Utilities for tests / CLI
// ---------------------------------------------------------------------------

/**
 * List all scenario IDs that have a baseline.duckdb on disk.
 */
export function listBaselineScenarios(): string[] {
  if (!existsSync(BASELINE_ROOT)) return [];
  return readdirSync(BASELINE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) =>
      existsSync(join(BASELINE_ROOT, d.name, "baseline.duckdb")),
    )
    .map((d) => d.name);
}

/**
 * Delete all baseline data for a scenario (for test cleanup).
 */
export function deleteBaseline(scenarioId: string): void {
  const dir = scenarioBaseDir(scenarioId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
