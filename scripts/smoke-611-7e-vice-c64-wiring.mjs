// Spec 611 phase 611.7e (final sub-step) smoke — kernel-level
// Drive1541 surface routing.
//
// Acceptance per Codex 18:39 UTC 611.7e clearance:
//   - Wire C64-side Drive1541 routing and LEGACY1541 adapter/factory
//     selection only.
//   - Default `drive1541="legacy"` keeps LEGACY1541 runtime path
//     untouched (5/7 GREEN, 2/7 RED-expected).
//   - `drive1541="vice"` exposes Vice1541 alongside legacy DriveCpu;
//     guard still refuses end-to-end LOAD gates (= 611.7f-i).
//
// 611.7e proves the WIRING — that the Drive1541 surface is reachable
// and produces correct values for both implementations. End-to-end
// IEC bus device routing through the new surface is 611.7f's job.
//
// Exit 0 = PASS, 1 = FAIL.

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

// === LEGACY1541 path: default ===
{
  const { session } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
    // no drive1541 → default "legacy"
  });
  const k = session.kernel;
  check("(a) kernel.drive1541Implementation === 'legacy' by default",
    k.drive1541Implementation === "legacy");
  check("(b) kernel.drive1541 bound to a Drive1541 surface (Legacy1541Adapter)",
    k.drive1541 !== undefined && typeof k.drive1541.iecLineSample === "function");
  check("(c) LEGACY1541 DriveCpu still constructed (this.drive non-null)",
    k.drive !== undefined && k.drive !== null);

  // Adapter iecLineSample: should derive from legacy iecBus drv_data[8].
  const sample = k.drive1541.iecLineSample();
  const hasBoolFields = sample
    && typeof sample.drv_data_pull === "boolean"
    && typeof sample.drv_clk_pull === "boolean"
    && typeof sample.drv_atna_pull === "boolean";
  check("(d) Legacy1541Adapter.iecLineSample() returns Drive1541IecSample shape",
    hasBoolFields, sample ? JSON.stringify(sample) : "null");

  // Compare adapter readback to direct legacy iecBus state — must agree.
  const core = k.iecBus.core;
  const dd8 = core.drv_data[8] ?? 0xff;
  const directDataPull = (dd8 & 0x02) === 0;
  const directClkPull = (dd8 & 0x08) === 0;
  const directAtnaPull = (dd8 & 0x10) === 0;
  check("(e) adapter sample matches direct legacy iecBus core.drv_data[8] readback",
    sample.drv_data_pull === directDataPull
    && sample.drv_clk_pull === directClkPull
    && sample.drv_atna_pull === directAtnaPull,
    `adapter=${JSON.stringify(sample)} direct={data:${directDataPull},clk:${directClkPull},atna:${directAtnaPull}}`);

  // debugProbe: drive PC + halftrack + LED present.
  const probe = k.drive1541.debugProbe();
  check("(f) Legacy1541Adapter.debugProbe() returns {drive_pc, head_halftrack, led}",
    probe
    && typeof probe.drive_pc === "number"
    && typeof probe.head_halftrack === "number"
    && typeof probe.led === "number",
    probe ? JSON.stringify(probe) : "null");

  // Other Drive1541 methods MUST throw with adapter-phase marker (no
  // silent fallback). 611.7f+ wires them when gate-lift demands it.
  function expectThrow(method, marker, args = []) {
    let err = null;
    try { k.drive1541[method](...args); } catch (e) { err = e; }
    return { err, matched: err !== null && new RegExp(marker).test(String(err.message)) };
  }
  const tCatch = expectThrow("catchUpTo", "Legacy1541Adapter|611\\.7", [0]);
  check("(g) Legacy adapter catchUpTo throws with 611.7e adapter marker", tCatch.matched);
  const tAttach = expectThrow("attachDisk", "Legacy1541Adapter|611\\.7",
    [{ kind: "d64", bytes: new Uint8Array(174848), readOnly: false }]);
  check("(h) Legacy adapter attachDisk throws with adapter marker", tAttach.matched);
}

// === VICE1541 path: drive1541="vice" ===
{
  const { session } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
    drive1541: "vice",
  });
  const k = session.kernel;
  check("(i) kernel.drive1541Implementation === 'vice' when requested",
    k.drive1541Implementation === "vice");
  check("(j) kernel.drive1541 bound to a Vice1541 instance",
    k.drive1541 !== undefined
    && typeof k.drive1541.iecLineSample === "function"
    && typeof k.drive1541.attachDisk === "function");
  check("(k) LEGACY1541 DriveCpu STILL constructed alongside vice (sidecar)",
    k.drive !== undefined && k.drive !== null);

  // Vice1541 idle bus sample (no disk attached).
  const sample = k.drive1541.iecLineSample();
  check("(l) Vice1541.iecLineSample() returns idle (no disk attached, all released → no pulls)",
    sample
    && sample.drv_data_pull === false
    && sample.drv_clk_pull === false
    && sample.drv_atna_pull === false,
    JSON.stringify(sample));
}

// === Guard: --drive1541=vice end-to-end still refused ===
import { spawnSync } from "node:child_process";
const guardRun = spawnSync("node",
  ["scripts/runtime-proof-gate.mjs", "--drive1541=vice", "--reuse-artifacts"],
  { encoding: "utf8" });
check("(m) runtime-proof-gate --drive1541=vice STILL refused (exit 2)",
  guardRun.status === 2, `exit=${guardRun.status}`);

console.log("");
const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.error(`FAIL: ${failed}/${results.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${results.length}/${results.length} checks passed.`);
process.exit(0);
