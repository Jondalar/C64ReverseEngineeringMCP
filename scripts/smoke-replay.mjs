#!/usr/bin/env node
// Spec 231 smoke — deterministic replay.
//
// Runs two scenarios (c64-ready, motm-dir-load) each twice.
// All four hashes (endSnapshot, ram, screenshot, trace) must be
// byte-equal across both runs of the same scenario.

import { resolve as resolvePath } from "node:path";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const repoRoot = resolvePath(import.meta.dirname, "..");
const tmpDir = "/tmp/c64re-replay-smoke";
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

// Load compiled modules.
const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);
const { saveSessionVsf, loadSessionVsf } = await import(
  `${repoRoot}/dist/runtime/headless/vsf/session-vsf.js`
);
const { runScenario } = await import(
  `${repoRoot}/dist/runtime/headless/v2/scenario.js`
);

const results = [];
function pass(name) { results.push({ name, pass: true }); console.log(`  PASS  ${name}`); }
function fail(name, msg) { results.push({ name, pass: false, err: msg }); console.log(`  FAIL  ${name}: ${msg}`); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Boot a session to a deterministic state, save a VSF snapshot, and
 * return the path + bytes.
 */
function buildStartSnapshot(label, opts, runFn) {
  const snapshotPath = `${tmpDir}/${label}-start.vsf`;
  if (existsSync(snapshotPath)) {
    // Reuse if already built this process run.
    return snapshotPath;
  }
  const { session } = startIntegratedSession(opts);
  session.resetCold("pal-default");
  runFn(session);
  saveSessionVsf(session, snapshotPath);
  return snapshotPath;
}

function resultsEqual(r1, r2, label) {
  const fields = ["endSnapshotHash", "ramHash", "screenshotHash", "traceHash"];
  for (const f of fields) {
    if (r1[f] !== r2[f]) {
      fail(label, `hash mismatch on '${f}': run1=${r1[f].slice(0,16)}… run2=${r2[f].slice(0,16)}…`);
      return false;
    }
  }
  pass(label);
  return true;
}

// ---------------------------------------------------------------------------
// Scenario 1: c64-ready (fast-trap, boot to BASIC READY, ~1.5M cycles)
// ---------------------------------------------------------------------------

console.log("\n=== Spec 231 — deterministic replay smoke ===\n");
console.log("Building c64-ready start snapshot...");

const dummyDisk = resolvePath(repoRoot, "samples/synthetic/1byte.g64");
const motmDisk = resolvePath(repoRoot, "samples/motm.g64");

// c64-ready scenario: use fast-trap for speed; boot for 500k cycles.
// This scenario tests determinism from a fresh cold reset.
const c64ReadySnapshot = buildStartSnapshot(
  "c64-ready",
  { diskPath: dummyDisk, mode: "fast-trap" },
  (session) => {
    // Run 500k cycles — enough to pass power-on ROM init.
    session.runFor(500_000);
  }
);

const scenarioC64Ready = {
  id: "c64-ready",
  startSnapshot: c64ReadySnapshot,
  inputs: [],
  cycleBudget: 200_000,
  diskPath: dummyDisk,
  mode: "fast-trap",
};

console.log("Running c64-ready scenario (run 1)...");
const c64ReadyRun1 = runScenario(scenarioC64Ready);
console.log(`  cycles=${c64ReadyRun1.cyclesRan} ram=${c64ReadyRun1.ramHash.slice(0,16)}… snap=${c64ReadyRun1.endSnapshotHash.slice(0,16)}…`);

console.log("Running c64-ready scenario (run 2)...");
const c64ReadyRun2 = runScenario(scenarioC64Ready);
console.log(`  cycles=${c64ReadyRun2.cyclesRan} ram=${c64ReadyRun2.ramHash.slice(0,16)}… snap=${c64ReadyRun2.endSnapshotHash.slice(0,16)}…`);

resultsEqual(c64ReadyRun1, c64ReadyRun2, "c64-ready: run1 vs run2 byte-equal");

// ---------------------------------------------------------------------------
// Scenario 2: motm-dir-load (fast-trap, directory listing typed, ~5M cycles)
// ---------------------------------------------------------------------------

console.log("\nBuilding motm-dir-load start snapshot...");

// motm: boot to READY then type LOAD"$",8 — saves snapshot after boot only.
const motmDirSnapshot = buildStartSnapshot(
  "motm-dir",
  { diskPath: motmDisk, mode: "fast-trap" },
  (session) => {
    // Boot to BASIC READY.
    session.runFor(1_500_000);
  }
);

// Replay: inject the directory load command at cycle 0 of replay window.
const scenarioMotmDir = {
  id: "motm-dir-load",
  startSnapshot: motmDirSnapshot,
  inputs: [
    {
      atCycle: 0,
      kind: "keyboard",
      payload: 'LOAD"$",8\r',
    },
  ],
  // 3M cycles — enough for the KERNAL to start the directory load.
  cycleBudget: 3_000_000,
  diskPath: motmDisk,
  mode: "fast-trap",
};

console.log("Running motm-dir-load scenario (run 1)...");
const motmRun1 = runScenario(scenarioMotmDir);
console.log(`  cycles=${motmRun1.cyclesRan} ram=${motmRun1.ramHash.slice(0,16)}… snap=${motmRun1.endSnapshotHash.slice(0,16)}…`);

console.log("Running motm-dir-load scenario (run 2)...");
const motmRun2 = runScenario(scenarioMotmDir);
console.log(`  cycles=${motmRun2.cyclesRan} ram=${motmRun2.ramHash.slice(0,16)}… snap=${motmRun2.endSnapshotHash.slice(0,16)}…`);

resultsEqual(motmRun1, motmRun2, "motm-dir-load: run1 vs run2 byte-equal");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passCount = results.filter((r) => r.pass).length;
const failCount = results.length - passCount;

console.log(`\nSpec 231 replay smoke: ${passCount}/${results.length} pass, ${failCount} fail`);
for (const r of results.filter((r) => !r.pass)) {
  console.log(`  FAIL  ${r.name}: ${r.err}`);
}
process.exit(failCount > 0 ? 1 : 0);
