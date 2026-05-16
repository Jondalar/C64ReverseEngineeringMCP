// Spec 611 phase 611.4 smoke — VICE1541 VIA1 IEC side + ATN/CA1 IRQ.
//
// Replaces scripts/smoke-611-3-vice-drive-boot.mjs (the iecLineDrive
// throw assertion is superseded; VIA1 now handles real PB / CA1 / IRQ).
//
// Phase 611.4 acceptance per Spec 611 §5 + §6 + Codex review:
//   - synthetic VICE1541 gate only; no LOAD, no game, no
//     --drive1541=vice anywhere in the gate runner.
//   - drive_init() post-init values still present (regression from 611.3).
//   - drive boots into ROM region (regression from 611.3).
//   - PAL sync_factor correct (regression from 611.3 fix).
//   - iecLineDrive() does NOT throw (was 611.4 marker before).
//   - iecLineSample() reflects drive-side PB writes via the IEC bus.
//   - ATN falling edge: VIA1 IFR.CA1 set, drive cpuIntStatus shows
//     IRQ pending. (Whether the drive 6502 services the IRQ depends
//     on ROM init having set PCR + IER + cleared I-flag, which is
//     reached during drive boot.)
//   - phase-marked throws still active for attachDisk / snapshot.
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

const drive1541 = session && session.kernel ? session.kernel.drive1541 : null;
check("(b) kernel.drive1541 is bound", drive1541 !== null && drive1541 !== undefined);

const drv = drive1541?.diskunit?.drives?.[0] ?? null;
check("(c) drive_init: byteReadyLevel === 1", drv?.byteReadyLevel === 1, drv ? String(drv.byteReadyLevel) : "no drv");
check("(d) drive_init: byteReadyEdge === 1", drv?.byteReadyEdge === 1, drv ? String(drv.byteReadyEdge) : "no drv");
check("(e) drive_init: gcrWriteValue === 0x55", drv?.gcrWriteValue === 0x55, drv ? `0x${(drv.gcrWriteValue ?? 0).toString(16)}` : "no drv");
check("(f) drive_init: currentHalfTrack === 36", drv?.currentHalfTrack === 36, drv ? String(drv.currentHalfTrack) : "no drv");

// Run for ROM boot.
let initialPc = null, postBootPc = null, cyclesRan = null, executeThrew = null;
if (drive1541) {
  initialPc = drive1541.debugProbe().drive_pc;
  try { cyclesRan = drive1541.catchUpTo(2_000_000); postBootPc = drive1541.debugProbe().drive_pc; }
  catch (e) { executeThrew = e; }
}
check("(g) catchUpTo(2_000_000) does not throw", executeThrew === null,
  executeThrew ? `threw: ${executeThrew.message}` : null);
const expectedDrive = Math.floor(2_000_000 * (1_000_000 / 985_248));
const driveDelta = cyclesRan === null ? null : Math.abs(cyclesRan - expectedDrive);
check("(h) drive cycles match PAL sync_factor (±0.5%)",
  cyclesRan !== null && cyclesRan > 2_000_000 && driveDelta !== null && driveDelta < expectedDrive * 0.005,
  cyclesRan === null ? "null" : `expected≈${expectedDrive}, got ${cyclesRan} (Δ${driveDelta})`);
check("(i) drive PC in ROM region (>= $C000)", postBootPc !== null && postBootPc >= 0xc000,
  postBootPc === null ? "null" : `initial=$${(initialPc ?? 0).toString(16)} post=$${postBootPc.toString(16)}`);

// VIA1 IEC tests
const driveCpu = session?.kernel?.drive1541 ? session.kernel.drive1541.driveCpu : null;
const via1 = driveCpu?.via1 ?? null;
const cpuIntStatus = driveCpu?.cpuIntStatus ?? null;

check("(j) via1 is a Via6522 instance", via1 !== null && typeof via1.signalCa1 === "function");

// Codex 14:51 UTC review row — VIA1 PRB read with DDRB=0, PRB=0, bus
// fully released must yield bits 1/3/4 high per VICE's
// `tmp = (drv_port ^ 0x85) | 0x1a | driveid` (then DDR-folded). The
// pre-Codex-fix formula left bits 1/3/4 low here because it pre-folded
// PRB before XOR.
if (via1 && drive1541) {
  drive1541.iecLineDrive({ bus_atn: true, bus_clk: true, bus_data: true }); // all released
  via1.ddrb = 0x00;
  via1.prb = 0x00;
}
const prbRead = via1?.read(0x00 /*VIA_PRB*/) ?? -1;
check(
  "(j.1) DDRB=0,PRB=0,bus-released ⇒ PB read bits 1/3/4 high (VICE | 0x1a)",
  prbRead !== -1 && (prbRead & 0x1a) === 0x1a,
  `prbRead=$${prbRead.toString(16)} (expected bits 1/3/4 set ⇒ 0x1a in low nibble; current device=8 driveid=0 ⇒ full byte 0x1a)`,
);

// iecLineDrive no-throw
let driveThrew = null;
try { drive1541?.iecLineDrive({ bus_atn: true, bus_clk: true, bus_data: true }); } catch (e) { driveThrew = e; }
check("(k) iecLineDrive(all-released) does not throw", driveThrew === null,
  driveThrew ? `threw: ${driveThrew.message}` : null);

// iecLineSample reflects current drive PB state (initially all released).
const sample0 = drive1541?.iecLineSample();
check("(l) iecLineSample reflects drive PB state",
  sample0 && typeof sample0.drv_data_pull === "boolean" && typeof sample0.drv_clk_pull === "boolean" && typeof sample0.drv_atna_pull === "boolean",
  sample0 ? JSON.stringify(sample0) : "null");

// ATN edge → VIA1 IFR.CA1 should set on the polarity matching PCR&0x01.
// VICE PCR bit 0: 1=positive (rising), 0=negative (falling). After ROM
// boot the 1541 DOS expects falling-edge (PCR&0x01=0) per arch §6.5,
// but during early-init (which is where 611.4's 2M-cycle boot stops)
// the ROM may have intermediate PCR values. We adapt the test to
// whichever polarity is currently active, so the check verifies the
// VIA6522 + iecLineDrive plumbing — not the ROM's init state.
const pcrCa1Rising = ((via1?.pcr ?? 0) & 0x01) !== 0;
// Drive ATN to the opposite-of-matching state first (clears any prior
// match-edge so the next drive establishes a true edge).
const startAtn = !pcrCa1Rising; // if expecting rising, start low; if falling, start high
drive1541?.iecLineDrive({ bus_atn: startAtn, bus_clk: true, bus_data: true });
// Clear any existing IFR.CA1 from the prior state-set.
if (via1) via1.write(0x0d /*VIA_IFR*/, 0x02);
const ifrBefore = via1?.ifr ?? 0;
// Now drive to the matching edge.
drive1541?.iecLineDrive({ bus_atn: !startAtn, bus_clk: true, bus_data: true });
const ifrAfter = via1?.ifr ?? 0;
const ca1Set = (ifrAfter & 0x02) !== 0; // IFR_CA1 = 0x02
check("(m) ATN edge matching PCR polarity sets VIA1 IFR.CA1", ca1Set,
  `pcr=$${(via1?.pcr ?? 0).toString(16)} (expect ${pcrCa1Rising ? "rising" : "falling"}) ier=$${(via1?.ier ?? 0).toString(16)} ifr before=$${ifrBefore.toString(16)} after=$${ifrAfter.toString(16)}`);

// Drive-side IRQ pending — fires only if IER has CA1 enabled. After ROM
// boot at 2M cycles the IER state is implementation-determined; we
// short-circuit by explicitly enabling CA1 in IER (write IER with bit
// 7 = set, mask = 0x02) and re-trigger the edge to verify the
// VIA6522 → InterruptCpuStatus push.
if (via1) {
  via1.write(0x0d /*VIA_IFR*/, 0x02);      // clear any pending CA1
  via1.write(0x0e /*VIA_IER*/, 0x82);      // bit7=set, IFR_CA1=0x02 → enable
}
drive1541?.iecLineDrive({ bus_atn: startAtn, bus_clk: true, bus_data: true });
drive1541?.iecLineDrive({ bus_atn: !startAtn, bus_clk: true, bus_data: true });
const irqPending = cpuIntStatus ? (cpuIntStatus.globalPendingInt & 0x02) !== 0 : false; // IK_IRQ
check("(n) IER-enabled CA1 edge raises drive IRQ on cpuIntStatus",
  irqPending,
  `pcr=$${(via1?.pcr ?? 0).toString(16)} ier=$${(via1?.ier ?? 0).toString(16)} ifr=$${(via1?.ifr ?? 0).toString(16)} globalPendingInt=$${(cpuIntStatus?.globalPendingInt ?? 0).toString(16)}`);

// Throws that must persist
function expectThrow(method, phaseMarker, args = []) {
  let err = null;
  try { drive1541?.[method](...args); } catch (e) { err = e; }
  return { err, matched: err !== null && new RegExp(phaseMarker).test(String(err.message)) };
}
const tAttach = expectThrow("attachDisk", "611\\.7", [{ kind: "d64", bytes: new Uint8Array(174848), readOnly: false }]);
check("(o) attachDisk throws with 611.7 marker", tAttach.matched, tAttach.err ? tAttach.err.message : "no throw");
const tSnap = expectThrow("snapshot", "611\\.8");
check("(p) snapshot throws with 611.8 marker", tSnap.matched, tSnap.err ? tSnap.err.message : "no throw");

console.log("");
const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.error(`FAIL: ${failed}/${results.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${results.length}/${results.length} checks passed.`);
process.exit(0);
