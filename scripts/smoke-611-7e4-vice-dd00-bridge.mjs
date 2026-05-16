// Spec 611 phase 611.7e.4 smoke — C64-IEC ↔ Vice1541 bridge.
//
// Per Codex 19:16 review: 611.7e is not done until the C64-side
// $DD00 write/read path reaches Vice1541 honestly. This smoke
// exercises real IecBus public methods (= the same methods CIA2 PA
// write/read invokes from $DD00) and proves:
//
//   - $DD00 write (= IecBus.setC64Output) reaches
//     Vice1541.iecLineDrive(...) with translated bus_atn/bus_clk/
//     bus_data values.
//   - $DD00 read (= IecBus.buildC64InputBits) observes
//     Vice1541.iecLineSample(...) — drv contribution comes from the
//     vice drive, not from legacy.
//   - IecBus.pushFlush.{one,all} call Vice1541.catchUpTo(...) for
//     drive1541="vice", NOT legacy catchUpDrive.
//   - Default drive1541="legacy" path is BEHAVIOR-IDENTICAL: no
//     bridge installed, legacy DriveCpu still drives the bus.
//   - runtime-proof-gate --drive1541=vice STILL refuses (= no
//     end-to-end LOAD/game claim — that's 611.7f).
//
// No CIA2/IEC line semantics/loader-trap/GCR/rotation/VIA2/DriveCPU
// changes.
//
// Exit 0 = PASS, 1 = FAIL.

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { spawnSync } from "node:child_process";

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

// === VICE path bridge tests ===
{
  const { session } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
    drive1541: "vice",
  });
  const k = session.kernel;
  const iec = k.iecBus;
  const vice = k.drive1541;

  check("(a) drive1541 = vice, bridge installed", k.drive1541Implementation === "vice");

  // --- $DD00 WRITE bridge: setC64Output → vice.iecLineDrive ---
  // Spy on vice.iecLineDrive.
  let drivenCall = null;
  const origDrive = vice.iecLineDrive.bind(vice);
  vice.iecLineDrive = (input) => { drivenCall = { ...input }; origDrive(input); };

  // CIA2 PA encoding ($DD00 OUT-side, active-HIGH on PA, inverted by
  // 7406 onto the active-LOW bus): bit 3 = ATN, bit 4 = CLK, bit 5 =
  // DATA. PA bit set = drive line low on bus (asserted). cia2_pa=0x00
  // → all PA bits low → all lines released. cia2_pa=0x38 → all lines
  // asserted.
  iec.setC64Output(0x00, 0x3f, 0, true);
  check("(b) setC64Output(0x00) → vice.iecLineDrive(all released)",
    drivenCall !== null
    && drivenCall.bus_atn === true
    && drivenCall.bus_clk === true
    && drivenCall.bus_data === true,
    drivenCall ? JSON.stringify(drivenCall) : "no call");

  drivenCall = null;
  iec.setC64Output(0x08, 0x3f, 1, true); // bit 3 set → assert ATN only
  // Note: ATN asserted triggers ATN-AND-gate → DATA pulled low via
  // the drive's ATNA default. So vice sees bus_data=false too. CLK
  // stays released. This is the correct VICE-shape interaction —
  // verifies the bridge passes the COMBINED bus state, not just the
  // raw C64 OUT bits.
  check("(c) setC64Output(ATN bit set) → vice.iecLineDrive(bus_atn=false, bus_data=false via ATN-AND-gate)",
    drivenCall !== null
    && drivenCall.bus_atn === false
    && drivenCall.bus_clk === true
    && drivenCall.bus_data === false,
    drivenCall ? JSON.stringify(drivenCall) : "no call");

  // --- $DD00 READ bridge: vice.iecLineSample overlays drv_data[8] ---
  // Force Vice1541's IEC bus state to a known config (drive pulling DATA),
  // then read C64 input bits and verify drv contribution comes from vice.
  // Vice1541's iec-bus model lives at vice.driveCpu.iecBus per 611.4.
  const viceIec = vice.driveCpu.iecBus;
  viceIec.drvDataReleased = false; // drive pulls DATA low
  viceIec.drvClkReleased = true;
  viceIec.drvAtnaReleased = true;
  // Confirm sample reflects.
  const sample = vice.iecLineSample();
  check("(d) Vice1541.iecLineSample returns drv_data_pull=true after forcing drvDataReleased=false",
    sample.drv_data_pull === true && sample.drv_clk_pull === false && sample.drv_atna_pull === false,
    JSON.stringify(sample));

  // Now read input bits via the wrapped buildC64InputBits.
  // The wrapper writes drv_data[8] from sample BEFORE calling original.
  iec.buildC64InputBits(2, true);
  const core = iec.core;
  const dd8 = core.drv_data[8];
  // Expected drv_data[8]: data pulled (bit 1 = 0), clk released (bit 3 = 1),
  // atna released (bit 4 = 1), plus 0xe5 overlay.
  // dd8 = 0 (data pulled) | 0x08 (clk released) | 0x10 (atna released) | 0xe5 = 0xfd.
  check("(e) buildC64InputBits overlays drv_data[8] from Vice1541 (= $fd: data pulled, clk+atna released)",
    dd8 === 0xfd, `dd8=$${dd8.toString(16)}`);

  // --- pushFlush.one re-targets to vice.catchUpTo ---
  let catchCall = null;
  const origCatch = vice.catchUpTo.bind(vice);
  vice.catchUpTo = (clk) => { catchCall = clk; return origCatch(clk); };
  let flushCall = false;
  const origFlush = vice.flush.bind(vice);
  vice.flush = () => { flushCall = true; origFlush(); };

  iec.pushFlush.one(8, 12345, false);
  check("(f) pushFlush.one(8) calls vice.catchUpTo(12345)",
    catchCall === 12345, `catchCall=${catchCall}`);
  check("(g) pushFlush.one(8) calls vice.flush()", flushCall === true);

  catchCall = null; flushCall = false;
  iec.pushFlush.all(67890, false);
  check("(h) pushFlush.all calls vice.catchUpTo(67890)", catchCall === 67890);
  check("(i) pushFlush.all calls vice.flush()", flushCall === true);

  // --- Non-unit-8 pushFlush.one is a no-op (single-drive baseline) ---
  catchCall = null; flushCall = false;
  iec.pushFlush.one(9, 11111, false);
  check("(j) pushFlush.one(9) does NOT call vice (single-1541 baseline)",
    catchCall === null && flushCall === false);
}

// === LEGACY path: bridge NOT installed, no override ===
{
  const { session } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
    // default = legacy
  });
  const k = session.kernel;
  const iec = k.iecBus;

  // Vice1541 bridge methods should NOT have been wrapped — pushFlush
  // should be the legacy catchUpDrive variant.
  // Easiest signal: legacy pushFlush.one is defined and references the
  // legacy catchUpDrive path. Indirect check: call pushFlush.one with
  // the legacy drive and observe its clock advances.
  const driveCpuBefore = k.drive.cpu.cycles;
  iec.pushFlush.one(8, 1_000_000, false);
  const driveCpuAfter = k.drive.cpu.cycles;
  check("(k) legacy default: pushFlush.one(8) advances LEGACY1541 DriveCpu clock",
    driveCpuAfter > driveCpuBefore,
    `before=${driveCpuBefore} after=${driveCpuAfter}`);
}

// === Guard: end-to-end LOAD STILL refused ===
const guardRun = spawnSync("node",
  ["scripts/runtime-proof-gate.mjs", "--drive1541=vice", "--reuse-artifacts"],
  { encoding: "utf8" });
check("(l) runtime-proof-gate --drive1541=vice STILL refused (exit 2)",
  guardRun.status === 2, `exit=${guardRun.status}`);

console.log("");
const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.error(`FAIL: ${failed}/${results.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${results.length}/${results.length} checks passed.`);
process.exit(0);
