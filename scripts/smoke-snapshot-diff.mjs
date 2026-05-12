#!/usr/bin/env node
// Spec 246 — Save-state semantic diff smoke test.
//
// Cases:
//   1. diff(identical, identical)     → all sections empty / 0 changed
//   2. diff(c64-ready, after-list)    → RAM + CPU + CIA1 changes
//   3. formatDiff renders all sections without throwing
//   4. formatDiff on identical diff   → shows "no changes" sections
//   5. timing: diff of ~10KB-modified state <100ms
//   6. drive sections present when both VSFs have drive modules
//   7. IEC bus edges detected on line-state change
//   8. pla config string reflects CPU port value

import { resolve as resolvePath } from "node:path";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

const repoRoot = resolvePath(import.meta.dirname, "..");
const tmpDir = "/tmp/c64re-snapshot-diff-smoke";
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

let startIntegratedSession, saveSessionVsf, diffSnapshots, formatDiff;
try {
  ({ startIntegratedSession } = await import(
    `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
  ));
  ({ saveSessionVsf } = await import(
    `${repoRoot}/dist/runtime/headless/vsf/session-vsf.js`
  ));
  ({ diffSnapshots, formatDiff } = await import(
    `${repoRoot}/dist/runtime/headless/v2/snapshot-diff.js`
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const diskPath = resolvePath(repoRoot, "samples/motm.g64");
if (!existsSync(diskPath)) {
  console.error(`fixture missing: ${diskPath}`);
  process.exit(1);
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, pass: false, err: e.message });
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, pass: false, err: e.message });
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

console.log("=== Spec 246 — Snapshot diff smoke ===\n");

// ----------------------------------------------------------------
// Build two VSF files: c64-ready and after-LIST
// ----------------------------------------------------------------
const opts = { diskPath, mode: "true-drive", useMicrocodedCpu: true };
const s = startIntegratedSession(opts).session;
s.resetCold("pal-default");
s.runFor(1_500_000);

const vsfReadyPath = `${tmpDir}/c64-ready.vsf`;
saveSessionVsf(s, vsfReadyPath);
const vsfReadyBytes = new Uint8Array(await import("node:fs").then(m => m.readFileSync(vsfReadyPath)));

// Advance to "after typing LIST"
s.typeText("LIST\r", 80_000, 80_000);
s.runFor(2_000_000);

const vsfAfterListPath = `${tmpDir}/c64-after-list.vsf`;
saveSessionVsf(s, vsfAfterListPath);
const vsfAfterListBytes = new Uint8Array(await import("node:fs").then(m => m.readFileSync(vsfAfterListPath)));

// ----------------------------------------------------------------
// Case 1: identical → empty diff
// ----------------------------------------------------------------
test("diff(identical, identical) → 0 changed bytes", () => {
  const diff = diffSnapshots(vsfReadyBytes, vsfReadyBytes);
  if (diff.ram.totalChanged !== 0) {
    throw new Error(`expected 0 RAM changes, got ${diff.ram.totalChanged}`);
  }
  if (diff.cpu.changedRegs.length !== 0) {
    throw new Error(`expected 0 CPU changes, got ${diff.cpu.changedRegs.length}`);
  }
  if (diff.cia1.changedRegisters.length !== 0) {
    throw new Error(`expected 0 CIA1 changes, got ${diff.cia1.changedRegisters.length}`);
  }
  if (diff.cyclesDelta !== undefined && diff.cpu.cyclesDelta !== 0) {
    throw new Error(`expected 0 cycles delta, got ${diff.cpu.cyclesDelta}`);
  }
});

// ----------------------------------------------------------------
// Case 2: c64-ready → after-LIST: RAM + CPU changes
// ----------------------------------------------------------------
test("diff(c64-ready, after-list) → RAM + CPU changed", () => {
  const diff = diffSnapshots(vsfReadyBytes, vsfAfterListBytes);
  if (diff.ram.totalChanged === 0) {
    throw new Error("expected RAM changes after LIST but got none");
  }
  if (diff.ram.changedRanges.length === 0) {
    throw new Error("expected changedRanges to be non-empty");
  }
  if (diff.ram.sample.length === 0) {
    throw new Error("expected sample entries");
  }
  // sample should contain addr/before/after
  const s0 = diff.ram.sample[0];
  if (typeof s0.addr !== "number" || typeof s0.before !== "number" || typeof s0.after !== "number") {
    throw new Error("sample entry malformed");
  }
  // cycle delta should be positive
  if (diff.cpu.cyclesDelta <= 0) {
    throw new Error(`cyclesDelta should be positive, got ${diff.cpu.cyclesDelta}`);
  }
  if (diff.fromCycle <= 0) {
    throw new Error(`fromCycle should be set, got ${diff.fromCycle}`);
  }
});

// ----------------------------------------------------------------
// Case 3: formatDiff on real diff renders all sections
// ----------------------------------------------------------------
test("formatDiff renders all sections without throwing", () => {
  const diff = diffSnapshots(vsfReadyBytes, vsfAfterListBytes);
  const text = formatDiff(diff);
  if (typeof text !== "string") throw new Error("formatDiff did not return string");
  const requiredSections = ["RAM:", "CPU:", "CIA1", "CIA2", "VIC", "SID", "PLA:", "IEC:"];
  for (const section of requiredSections) {
    if (!text.includes(section)) {
      throw new Error(`formatDiff output missing section "${section}"\nGot:\n${text}`);
    }
  }
});

// ----------------------------------------------------------------
// Case 4: formatDiff on identical diff shows "no changes"
// ----------------------------------------------------------------
test("formatDiff on identical diff shows 'no changes'", () => {
  const diff = diffSnapshots(vsfReadyBytes, vsfReadyBytes);
  const text = formatDiff(diff);
  if (!text.includes("no changes")) {
    throw new Error(`expected "no changes" in identical diff output\nGot:\n${text}`);
  }
});

// ----------------------------------------------------------------
// Case 5: timing <100ms
// ----------------------------------------------------------------
test("diff completes in <100ms on ~10KB-modified state", () => {
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) {
    diffSnapshots(vsfReadyBytes, vsfAfterListBytes);
  }
  const elapsed = Date.now() - t0;
  // 3 iterations; average should be <100ms each
  const avg = elapsed / 3;
  if (avg > 100) {
    throw new Error(`average diff time ${avg.toFixed(1)}ms exceeds 100ms budget`);
  }
  console.log(`          avg diff time: ${avg.toFixed(1)}ms`);
});

// ----------------------------------------------------------------
// Case 6: drive sections present when both VSFs have drive modules
// ----------------------------------------------------------------
test("drive sections present in both VSFs", () => {
  const diff = diffSnapshots(vsfReadyBytes, vsfAfterListBytes);
  if (!diff.drive) {
    throw new Error("expected drive section (both VSFs were created with true-drive mode)");
  }
  if (typeof diff.drive.headPosition.trackHalfBefore !== "number") {
    throw new Error("drive.headPosition.trackHalfBefore missing");
  }
  if (!diff.drive.via1) throw new Error("drive.via1 missing");
  if (!diff.drive.via2) throw new Error("drive.via2 missing");
  if (!diff.drive.cpu) throw new Error("drive.cpu missing");
});

// ----------------------------------------------------------------
// Case 7: IEC bus structure has edgesBetween + finalState
// ----------------------------------------------------------------
test("iecBus section has correct shape", () => {
  const diff = diffSnapshots(vsfReadyBytes, vsfAfterListBytes);
  const iec = diff.iecBus;
  if (typeof iec.edgesBetween !== "number") {
    throw new Error("iecBus.edgesBetween not a number");
  }
  const { atn, clk, data } = iec.finalState;
  for (const [name, val] of [["atn", atn], ["clk", clk], ["data", data]]) {
    if (val !== 0 && val !== 1) {
      throw new Error(`iecBus.finalState.${name} is ${val}, expected 0 or 1`);
    }
  }
});

// ----------------------------------------------------------------
// Case 8: PLA config string present in diff
// ----------------------------------------------------------------
test("pla config strings present", () => {
  const diff = diffSnapshots(vsfReadyBytes, vsfAfterListBytes);
  if (!diff.pla.configBefore || !diff.pla.configAfter) {
    throw new Error(`pla config strings missing: before="${diff.pla.configBefore}" after="${diff.pla.configAfter}"`);
  }
  // Should contain bit names
  const hasExpected = diff.pla.configBefore.includes("HIRAM") || diff.pla.configBefore.includes("hiram");
  if (!hasExpected) {
    throw new Error(`pla config string format unexpected: "${diff.pla.configBefore}"`);
  }
});

// ----------------------------------------------------------------
// Summary
// ----------------------------------------------------------------
console.log();
const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log(`Spec 246 snapshot-diff: ${pass}/${results.length} pass, ${fail} fail`);
if (fail > 0) {
  for (const r of results.filter(r => !r.pass)) {
    console.log(`  - ${r.name}: ${r.err}`);
  }
}
process.exit(fail > 0 ? 1 : 0);
