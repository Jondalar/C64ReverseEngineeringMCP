#!/usr/bin/env node
// Spec 268 — Scenario registry smoke test.
//
// Acceptance: ≥4 cases (list, save, load, delete) pass.

import { resolve as resolvePath } from "node:path";
import { existsSync, rmSync } from "node:fs";

const repoRoot = resolvePath(import.meta.dirname, "..");

let listScenarios, saveScenario, loadScenario, deleteScenario;
try {
  ({ listScenarios, saveScenario, loadScenario, deleteScenario } = await import(
    `${repoRoot}/dist/runtime/headless/v2/scenario-registry.js`
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(() => {
        pass++;
        console.log(`  PASS  ${name}`);
      }).catch(e => {
        fail++;
        failures.push({ name, error: e?.message ?? String(e) });
        console.log(`  FAIL  ${name}: ${e?.message ?? e}`);
      });
      return r;
    }
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e?.message ?? String(e) });
    console.log(`  FAIL  ${name}: ${e?.message ?? e}`);
  }
}

const TEST_ID = `smoke-scenario-${Date.now()}`;
const TEST_SCENARIO = {
  id: TEST_ID,
  diskPath: "samples/synthetic/1block.g64",
  mode: "fast-trap",
  cycleBudget: 100_000,
  inputs: [
    { atCycle: 50_000, kind: "keyboard", payload: "HELLO\r" },
    { atCycle: 80_000, kind: "joystick2", payload: { fire: true } },
  ],
  startSnapshot: "",
};

console.log("=== Spec 268 — Scenario registry smoke ===\n");

// 1. Save
test("1. saveScenario writes file", () => {
  const { filePath } = saveScenario(TEST_SCENARIO);
  if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  if (!filePath.endsWith(".json")) throw new Error(`expected .json, got ${filePath}`);
  console.log(`     -> ${filePath}`);
});

// 2. Load
test("2. loadScenario reads back saved scenario", () => {
  const s = loadScenario(TEST_ID);
  if (!s) throw new Error("loadScenario returned null");
  if (s.id !== TEST_ID) throw new Error(`id mismatch: ${s.id}`);
  if (s.mode !== "fast-trap") throw new Error(`mode mismatch: ${s.mode}`);
  if (s.cycleBudget !== 100_000) throw new Error(`cycleBudget mismatch: ${s.cycleBudget}`);
  if (!Array.isArray(s.inputs)) throw new Error("inputs not array");
  if (s.inputs.length !== 2) throw new Error(`inputs length ${s.inputs.length}`);
  if (!s.savedAt) throw new Error("savedAt missing");
});

// 3. List includes new scenario
test("3. listScenarios includes saved scenario", () => {
  const list = listScenarios();
  if (!Array.isArray(list)) throw new Error("listScenarios did not return array");
  const found = list.find(s => s.id === TEST_ID);
  if (!found) throw new Error(`${TEST_ID} not in list (${list.length} items)`);
  if (found.inputCount !== 2) throw new Error(`inputCount ${found.inputCount}`);
  if (!["samples", "project"].includes(found.source)) throw new Error(`bad source: ${found.source}`);
});

// 4. Delete
test("4. deleteScenario removes file", () => {
  const ok = deleteScenario(TEST_ID);
  if (!ok) throw new Error("deleteScenario returned false");
  const after = loadScenario(TEST_ID);
  if (after !== null) throw new Error("scenario still loadable after delete");
});

// 5. Delete non-existent returns false
test("5. deleteScenario non-existent returns false", () => {
  const ok = deleteScenario(`nonexistent-${Date.now()}`);
  if (ok !== false) throw new Error(`expected false, got ${ok}`);
});

// 6. List with no project dir returns array
test("6. listScenarios always returns array", () => {
  const list = listScenarios();
  if (!Array.isArray(list)) throw new Error("not an array");
});

// 7. Save + load with multiple inputs including joystick
test("7. roundtrip joystick payload preserved", () => {
  const id = `smoke-joy-${Date.now()}`;
  const sc = {
    id,
    diskPath: "samples/synthetic/1block.g64",
    mode: "true-drive",
    cycleBudget: 5_000_000,
    inputs: [
      { atCycle: 1_500_000, kind: "keyboard", payload: 'LOAD"*",8,1\r' },
      { atCycle: 2_500_000, kind: "keyboard", payload: "RUN\r" },
      { atCycle: 4_000_000, kind: "joystick2", payload: { fire: true, north: false } },
    ],
    startSnapshot: "",
  };
  saveScenario(sc);
  const loaded = loadScenario(id);
  if (!loaded) throw new Error("not found after save");
  if (loaded.inputs.length !== 3) throw new Error(`inputs ${loaded.inputs.length}`);
  deleteScenario(id);
});

// Wait for any async tests to settle then report.
await new Promise(r => setTimeout(r, 50));

console.log();
console.log(`Results: ${pass} pass, ${fail} fail`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`);
}
process.exit(fail > 0 ? 1 : 0);
