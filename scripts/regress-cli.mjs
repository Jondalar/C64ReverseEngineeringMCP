#!/usr/bin/env node
// Spec 250 — regression CLI.
//
// Subcommands:
//   capture <scenarioId>    — run scenario, write baseline
//   compare <scenarioId>    — compare against latest baseline, exit 0 if no_drift
//   report                  — all scenarios, summary table (≤30 lines)
//
// Usage:
//   npm run regress:capture -- <scenarioId>
//   npm run regress:compare -- <scenarioId>
//   npm run regress:report

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const repoRoot = resolvePath(import.meta.dirname, "..");

// Load the compiled regression module.
let regression;
try {
  regression = await import(
    `${repoRoot}/dist/runtime/headless/v2/regression.js`
  );
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const {
  regressionCaptureBaseline,
  regressionCompare,
  regressionReport,
  listBaselineScenarios,
} = regression;

// ---------------------------------------------------------------------------
// Scenario registry
//
// In production this would be populated from a scenarios/ directory or a
// config file. For now we define a minimal set that the smoke tests use.
// Add scenarios here as the test corpus grows.
// ---------------------------------------------------------------------------

function buildRegistry() {
  const registry = new Map();

  // Attempt to load real scenarios from the disk if samples exist.
  // Falls back to an empty registry if samples aren't present.
  const dummyDisk = resolvePath(repoRoot, "samples/synthetic/1byte.g64");
  const motmDisk = resolvePath(repoRoot, "samples/motm.g64");

  // Only register scenarios whose disk image exists.
  if (existsSync(dummyDisk)) {
    registry.set("c64-ready", {
      id: "c64-ready",
      startSnapshot: dummyDisk, // placeholder — real usage needs a .vsf
      inputs: [],
      cycleBudget: 200_000,
      diskPath: dummyDisk,
      mode: "fast-trap",
    });
  }

  if (existsSync(motmDisk)) {
    registry.set("motm-dir-load", {
      id: "motm-dir-load",
      startSnapshot: motmDisk, // placeholder
      inputs: [{ atCycle: 0, kind: "keyboard", payload: 'LOAD"$",8\r' }],
      cycleBudget: 3_000_000,
      diskPath: motmDisk,
      mode: "fast-trap",
    });
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Subcommand: capture
// ---------------------------------------------------------------------------

async function cmdCapture(scenarioId) {
  if (!scenarioId) {
    console.error("Usage: regress-cli.mjs capture <scenarioId>");
    process.exit(1);
  }
  console.log(`Capturing baseline for: ${scenarioId}`);
  const registry = buildRegistry();
  if (!registry.has(scenarioId)) {
    console.error(
      `Scenario '${scenarioId}' not registered. Known: ${[...registry.keys()].join(", ") || "(none)"}`,
    );
    process.exit(1);
  }
  try {
    const { path, hashes } = await regressionCaptureBaseline(scenarioId, registry);
    console.log(`Baseline written: ${path}`);
    console.log(`  ram:        ${hashes.ramHash.slice(0, 16)}…`);
    console.log(`  screenshot: ${hashes.screenshotHash.slice(0, 16)}…`);
    console.log(`  trace:      ${hashes.traceHash.slice(0, 16)}…`);
    console.log(`  events:     ${hashes.eventCount}`);
  } catch (e) {
    console.error(`capture failed: ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: compare
// ---------------------------------------------------------------------------

async function cmdCompare(scenarioId) {
  if (!scenarioId) {
    console.error("Usage: regress-cli.mjs compare <scenarioId>");
    process.exit(1);
  }
  const registry = buildRegistry();
  console.log(`Comparing: ${scenarioId}`);
  const result = await regressionCompare(scenarioId, registry);
  console.log(`  classification: ${result.classification}`);
  console.log(`  baseline@${result.baselineCommit} vs current@${result.currentCommit}`);
  console.log(`  ${result.narrative}`);
  if (result.divergence) {
    const d = result.divergence;
    console.log(`  first diverge at cycle ${d.firstDivergeCycle} (${d.divergenceFamily})`);
    console.log(`  shared prefix: ${d.context.sharedPrefix} events`);
  }
  if (result.classification !== "no_drift") {
    console.error(`DRIFT DETECTED: ${result.classification}`);
    process.exit(1);
  }
  console.log("OK: no drift");
}

// ---------------------------------------------------------------------------
// Subcommand: report
// ---------------------------------------------------------------------------

async function cmdReport() {
  const registry = buildRegistry();

  // Also include scenarios that have a baseline on disk (even if not in registry).
  const onDisk = listBaselineScenarios();
  for (const sid of onDisk) {
    if (!registry.has(sid)) {
      // Mark as registry-absent — compare will classify "broken".
      registry.set(sid, null);
    }
  }

  if (registry.size === 0) {
    console.log("No scenarios registered and no baselines on disk.");
    return;
  }

  console.log(`Regression report — ${registry.size} scenario(s)\n`);
  const entries = await regressionReport(registry);

  const rows = entries.map((e) => ({
    id: e.scenarioId,
    cls: e.result.classification,
    narrative: e.result.narrative,
  }));

  // Summary table (≤30 lines target).
  const colW = Math.min(
    40,
    Math.max(...rows.map((r) => r.id.length), 10) + 2,
  );
  const header = `${"SCENARIO".padEnd(colW)} ${"STATUS".padEnd(18)} NARRATIVE`;
  console.log(header);
  console.log("-".repeat(Math.min(process.stdout.columns ?? 100, 100)));
  for (const row of rows) {
    const line = `${row.id.padEnd(colW)} ${row.cls.padEnd(18)} ${row.narrative}`;
    console.log(line.slice(0, process.stdout.columns ?? 120));
  }

  const counts = {
    no_drift: 0,
    minor_drift: 0,
    structural_change: 0,
    broken: 0,
  };
  for (const r of rows) {
    const k = r.cls;
    if (k in counts) counts[k]++;
  }
  console.log();
  console.log(
    `Summary: ${counts.no_drift} ok, ${counts.minor_drift} minor, ` +
    `${counts.structural_change} structural, ${counts.broken} broken`,
  );

  if (counts.minor_drift + counts.structural_change + counts.broken > 0) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const [, , subcmd, arg] = process.argv;

switch (subcmd) {
  case "capture":
    await cmdCapture(arg);
    break;
  case "compare":
    await cmdCompare(arg);
    break;
  case "report":
    await cmdReport();
    break;
  default:
    console.error(
      "Usage: regress-cli.mjs <capture|compare|report> [scenarioId]",
    );
    process.exit(1);
}
