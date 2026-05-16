// Spec 611 phase 611.3 smoke — VICE1541 drive bring-up + ROM-region
// early-init only.
//
// Replaces scripts/smoke-611-2-vice-idle.mjs (which asserted
// catchUpTo() throws — that behaviour was specific to 611.2 and is
// superseded once 611.3 lands drivecpu push-mode).
//
// **Scope narrowing (per Codex review 14:35 UTC):** this smoke asserts
// ROM-region / early-init reach only. Reaching the canonical idle-poll
// loop requires VIA1 CA1 (ATN edge) handling, which is the 611.4
// responsibility. 611.3 establishes that drive_init() + Vice1541DriveCpu
// boot the 6502 from the reset vector and execute into the ROM region
// without throwing.
//
// Phase 611.3 gate per Spec 611 §5 + §6 (revised scope):
//   - synthetic VICE1541 gate only; no LOAD, no game, no
//     --drive1541=vice anywhere.
//   - drive_init() post-init values written (byte_ready_level=1,
//     byte_ready_edge=1, GCR_write_value=0x55, read_write_mode=1,
//     drive_set_half_track(36, 0)).
//   - drive ROM loaded (bundled).
//   - catchUpTo(N) runs without throwing.
//   - sync_factor matches VICE drivesync.c:57 — drive cycles > host
//     cycles on PAL (host slower than 1 MHz drive).
//   - drive PC reaches the ROM region (>= $C000) after enough cycles.
//     (Canonical idle-poll PC oracle is a 611.4 follow-up.)
//   - iecLineSample() still returns idle bus (VIA1 wiring is 611.4).
//   - phase-marked throws still active for iecLineDrive / attachDisk /
//     snapshot.
//
// Exit 0 = PASS, 1 = FAIL.

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

let session = null;
let ctorThrew = null;
try {
  ({ session } = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: "vice",
  }));
} catch (e) {
  ctorThrew = e;
}
check(
  "(a) startIntegratedSession({drive1541:'vice'}) does not throw",
  ctorThrew === null,
  ctorThrew ? `threw: ${ctorThrew.message}` : null,
);

const drive1541 = session && session.kernel ? session.kernel.drive1541 : null;
check("(b) kernel.drive1541 is bound", drive1541 !== null && drive1541 !== undefined);

// drive_init() post-init values
const drv = drive1541 && drive1541.diskunit && drive1541.diskunit.drives
  ? drive1541.diskunit.drives[0]
  : null;
check("(c) drive_init: byteReadyLevel === 1", drv && drv.byteReadyLevel === 1, drv ? String(drv.byteReadyLevel) : "no drv");
check("(d) drive_init: byteReadyEdge === 1", drv && drv.byteReadyEdge === 1, drv ? String(drv.byteReadyEdge) : "no drv");
check("(e) drive_init: gcrWriteValue === 0x55", drv && drv.gcrWriteValue === 0x55, drv ? `0x${(drv.gcrWriteValue ?? 0).toString(16)}` : "no drv");
check("(f) drive_init: readWriteMode === 1", drv && drv.readWriteMode === 1, drv ? String(drv.readWriteMode) : "no drv");
check("(g) drive_init: currentHalfTrack === 36", drv && drv.currentHalfTrack === 36, drv ? String(drv.currentHalfTrack) : "no drv");

// Idle bus sample
let sample = null;
try { sample = drive1541 ? drive1541.iecLineSample() : null; } catch (e) { sample = { error: String(e) }; }
const idle = sample && sample.drv_data_pull === false && sample.drv_clk_pull === false && sample.drv_atna_pull === false;
check("(h) iecLineSample() returns idle bus", idle, sample ? JSON.stringify(sample) : "null");

// Push-mode catch-up — run a few million host cycles and verify drive PC moves into ROM region.
let initialPc = null;
let postPc = null;
let cyclesRan = null;
let executeThrew = null;
if (drive1541) {
  initialPc = drive1541.debugProbe().drive_pc;
  try {
    cyclesRan = drive1541.catchUpTo(2_000_000);
    postPc = drive1541.debugProbe().drive_pc;
  } catch (e) { executeThrew = e; }
}
check("(i) catchUpTo(2_000_000) does not throw", executeThrew === null, executeThrew ? `threw: ${executeThrew.message}` : null);
check("(j) catchUpTo returned a positive cycle count", cyclesRan !== null && cyclesRan > 0, cyclesRan === null ? "null" : `${cyclesRan} drive cycles`);
// PAL sync_factor: drive > host (host PAL = 985_248 Hz, drive = 1_000_000 Hz).
// 2_000_000 host cycles ⇒ ≈ 2_029_952 drive cycles. Accept ±0.5% jitter.
const expectedDrive = Math.floor(2_000_000 * (1_000_000 / 985_248));
const driveDelta = cyclesRan === null ? null : Math.abs(cyclesRan - expectedDrive);
check(
  "(j.1) drive cycles > host cycles per PAL sync_factor (±0.5%)",
  cyclesRan !== null && cyclesRan > 2_000_000 && driveDelta !== null && driveDelta < expectedDrive * 0.005,
  cyclesRan === null ? "null" : `expected≈${expectedDrive}, got ${cyclesRan} (delta ${driveDelta})`,
);
check("(k) drive PC reached ROM region (>= $C000)", postPc !== null && postPc >= 0xc000, postPc === null ? "null" : `initial=$${(initialPc ?? 0).toString(16)} post=$${postPc.toString(16)}`);

// debugProbe shape
let probe = null;
try { probe = drive1541 ? drive1541.debugProbe() : null; } catch (e) { probe = { error: String(e) }; }
check(
  "(l) debugProbe() returns {drive_pc, head_halftrack, led}",
  probe && typeof probe.drive_pc === "number" && probe.head_halftrack === 36 && typeof probe.led === "number",
  probe ? JSON.stringify(probe) : "null",
);

// Throws that must persist (phase markers for later phases)
function expectThrow(method, phaseMarker, args = []) {
  let err = null;
  try { drive1541 && drive1541[method](...args); } catch (e) { err = e; }
  const matched = err !== null && new RegExp(phaseMarker).test(String(err.message));
  return { err, matched };
}
const tDrive = expectThrow("iecLineDrive", "611\\.4", [{ bus_atn: true, bus_clk: true, bus_data: true }]);
check("(m) iecLineDrive throws with 611.4 marker", tDrive.matched, tDrive.err ? tDrive.err.message : "no throw");
const tAttach = expectThrow("attachDisk", "611\\.7", [{ kind: "d64", bytes: new Uint8Array(174848), readOnly: false }]);
check("(n) attachDisk throws with 611.7 marker", tAttach.matched, tAttach.err ? tAttach.err.message : "no throw");
const tSnap = expectThrow("snapshot", "611\\.8");
check("(o) snapshot throws with 611.8 marker", tSnap.matched, tSnap.err ? tSnap.err.message : "no throw");

console.log("");
const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.error(`FAIL: ${failed}/${results.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${results.length}/${results.length} checks passed.`);
process.exit(0);
