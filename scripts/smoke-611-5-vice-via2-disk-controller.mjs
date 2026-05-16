// Spec 611 phase 611.5 smoke — VICE1541 VIA2 (disk controller) +
// BYTE-READY → SO wiring.
//
// Replaces scripts/smoke-611-4-vice-via1-atn.mjs (foundational checks
// preserved; VIA2 stub assertions superseded).
//
// Phase 611.5 acceptance per Spec 611 §5 + §6 + Codex 14:57 UTC go:
//   - synthetic VICE1541 gate only; no LOAD, no game, no
//     --drive1541=vice anywhere in the gate runner.
//   - VIA1 PRB formula intact (regression).
//   - VIA2 PB decode:
//       motor (PB.2)    → drive.byteReadyActive BRA_MOTOR_ON
//       LED (PB.3)      → drive.ledStatus + BRA_LED
//       WPS (PB.4) read → 1 (no disk = not protected)
//       stepper (PB.0/PB.1) phase transition → currentHalfTrack ±1
//   - BYTE-READY pulse via Vice1541DriveCpu.pulseByteReady():
//       VIA2 IFR.CA1 set (PCR-polarity adaptive).
//       drive CPU V-flag set on 1→0 SO edge.
//   - phase-marked throws still active for attachDisk / snapshot.
//   - false-green guard still rejects --drive1541=vice (gate-runner).
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
} catch (e) { ctorThrew = e; }
check("(a) startIntegratedSession({drive1541:'vice'}) does not throw", ctorThrew === null,
  ctorThrew ? `threw: ${ctorThrew.message}` : null);

const drive1541 = session?.kernel?.drive1541 ?? null;
check("(b) kernel.drive1541 is bound", drive1541 !== null);

const drv = drive1541?.diskunit?.drives?.[0] ?? null;
check("(c) drive_init: byteReadyLevel === 1", drv?.byteReadyLevel === 1);
check("(d) drive_init: gcrWriteValue === 0x55", drv?.gcrWriteValue === 0x55);
check("(e) drive_init: currentHalfTrack === 36", drv?.currentHalfTrack === 36);

// ROM boot regression
let cyclesRan = null, postPc = null, executeThrew = null;
try { cyclesRan = drive1541?.catchUpTo(2_000_000); postPc = drive1541?.debugProbe().drive_pc; }
catch (e) { executeThrew = e; }
check("(f) catchUpTo(2M) no throw", executeThrew === null,
  executeThrew ? `threw: ${executeThrew.message}` : null);
check("(g) drive PC in ROM region (>= $C000)", postPc !== null && postPc >= 0xc000,
  postPc !== null ? `$${postPc.toString(16)}` : "null");

// VIA1 PRB regression (Codex P1 row carried over from 611.4)
const via1 = session?.kernel?.drive1541?.driveCpu?.via1 ?? null;
const via2 = session?.kernel?.drive1541?.driveCpu?.via2 ?? null;
if (via1 && drive1541) {
  drive1541.iecLineDrive({ bus_atn: true, bus_clk: true, bus_data: true });
  via1.ddrb = 0x00; via1.prb = 0x00;
}
const via1PrbRead = via1?.read(0x00 /*VIA_PRB*/) ?? -1;
check("(h) VIA1 PRB DDRB=0 PRB=0 bus-released ⇒ bits 1/3/4 high",
  via1PrbRead !== -1 && (via1PrbRead & 0x1a) === 0x1a,
  `prbRead=$${via1PrbRead.toString(16)}`);

check("(i) via2 is a Via6522 instance", via2 !== null && typeof via2.signalCa1 === "function");

// VIA2 PB write — motor + LED + stepper
if (via2 && drv) {
  via2.write(0x02 /*VIA_DDRB*/, 0xff); // all PB output for the test
  // motor on (PB.2), LED on (PB.3), stepper phase 00 (PB.0/PB.1=00)
  drv.byteReadyActive = 0; drv.ledStatus = 0;
  via2.write(0x00 /*VIA_PRB*/, 0b0000_1100); // bits 2+3
}
check("(j) VIA2 PB.2 motor → drive.byteReadyActive has BRA_MOTOR_ON (0x04)",
  drv && (drv.byteReadyActive & 0x04) !== 0,
  drv ? `byteReadyActive=$${drv.byteReadyActive.toString(16)}` : "no drv");
check("(k) VIA2 PB.3 LED → drive.ledStatus === 1",
  drv?.ledStatus === 1, drv ? String(drv.ledStatus) : "no drv");

// VIA2 PB.4 WPS read = 1 (no disk = not protected); drive.readOnly = 0
if (via2) {
  via2.write(0x02 /*VIA_DDRB*/, 0x00); // all PB input for WPS read
  via2.write(0x00 /*VIA_PRB*/, 0x00);
}
const via2PbRead = via2?.read(0x00 /*VIA_PRB*/) ?? -1;
check("(l) VIA2 PB.4 (WPS) reads 1 when drive.readOnly = 0",
  via2PbRead !== -1 && (via2PbRead & 0x10) !== 0,
  `pbRead=$${via2PbRead.toString(16)}`);

// VIA2 stepper PB.0/PB.1 phase transition → currentHalfTrack changes.
// Set DDRB output, drive phase 00 → 01 (Gray-code +1 = step inward).
const ht0 = drv?.currentHalfTrack ?? -1;
if (via2 && drv) {
  via2.write(0x02 /*VIA_DDRB*/, 0xff);
  via2.write(0x00 /*VIA_PRB*/, 0x00); // phase 00 baseline
  via2.write(0x00 /*VIA_PRB*/, 0x01); // phase 01 → +1 half-track
}
const htAfter1 = drv?.currentHalfTrack ?? -1;
check("(m) stepper 00→01 increments currentHalfTrack by 1",
  htAfter1 === ht0 + 1, `before=${ht0} after=${htAfter1}`);

// Reverse step 01 → 00 → step outward (-1).
if (via2 && drv) via2.write(0x00 /*VIA_PRB*/, 0x00);
const htAfter2 = drv?.currentHalfTrack ?? -1;
check("(n) stepper 01→00 decrements currentHalfTrack by 1",
  htAfter2 === htAfter1 - 1, `before=${htAfter1} after=${htAfter2}`);

// BYTE-READY pulse → VIA2 IFR.CA1 sets (PCR-adaptive) AND drive CPU V flag.
const driveCpu = session?.kernel?.drive1541?.driveCpu;
const cpu = driveCpu?.cpu;
if (via2 && cpu) {
  // PCR polarity for CA1.
  const pcrPos = (via2.pcr & 0x01) !== 0;
  // Reset CA1 IFR + V flag.
  via2.write(0x0d /*VIA_IFR*/, 0x02);
  cpu.reg_p &= ~0x40; // clear V
  // Drive the matching edge directly.
  if (pcrPos) via2.signalCa1(1); else via2.signalCa1(0);
}
const via2IfrCa1 = (via2?.ifr ?? 0) & 0x02;
check("(o) VIA2 BYTE-READY edge matching PCR sets IFR.CA1",
  via2IfrCa1 !== 0, `pcr=$${(via2?.pcr ?? 0).toString(16)} ifr=$${(via2?.ifr ?? 0).toString(16)}`);

// SO line pulse via Vice1541DriveCpu.pulseByteReady() → V flag set.
if (cpu) cpu.reg_p &= ~0x40;
driveCpu?.pulseByteReady();
cpu?.executeCycle(); // SO 1→0 edge detected at next executeCycle's start
const vFlag = (cpu?.reg_p ?? 0) & 0x40;
check("(p) pulseByteReady() raises SO edge → drive V flag set",
  vFlag !== 0, `reg_p=$${(cpu?.reg_p ?? 0).toString(16)} (V=${vFlag !== 0})`);

// Throws that must persist
function expectThrow(method, phaseMarker, args = []) {
  let err = null;
  try { drive1541?.[method](...args); } catch (e) { err = e; }
  return { err, matched: err !== null && new RegExp(phaseMarker).test(String(err.message)) };
}
const tAttach = expectThrow("attachDisk", "611\\.7", [{ kind: "d64", bytes: new Uint8Array(174848), readOnly: false }]);
check("(q) attachDisk throws with 611.7 marker", tAttach.matched);
const tSnap = expectThrow("snapshot", "611\\.8");
check("(r) snapshot throws with 611.8 marker", tSnap.matched);

console.log("");
const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.error(`FAIL: ${failed}/${results.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${results.length}/${results.length} checks passed.`);
process.exit(0);
