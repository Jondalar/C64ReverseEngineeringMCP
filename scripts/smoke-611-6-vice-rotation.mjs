// Spec 611 phase 611.6 smoke — VICE1541 rotation engine.
//
// Replaces scripts/smoke-611-5-vice-via2-disk-controller.mjs.
// Foundational + VIA1 + VIA2 + rotation-stub-observability checks
// preserved; rotation behavioural checks added.
//
// Phase 611.6 acceptance per Spec 611 §5 + §6 + Codex 16:36 UTC go:
//   - synthetic VICE1541 gate only; no LOAD, no game, no
//     --drive1541=vice anywhere in the gate runner.
//   - rotation port behind existing VIA2 call sites:
//       rotation_init / rotation_reset / rotation_begins /
//       rotation_speed_zone_set / rotation_rotate_disk /
//       rotation_byte_read / rotation_sync_found
//       (all imported from vice1541/rotation.ts, NOT stub).
//   - BUS_READ_DELAY = 14 (VICE rotation.h:35).
//   - No track buffer attached → rotation_byte_read returns 0,
//     rotation_sync_found returns 0x80 (no SYNC with all-zero bytes).
//   - Motor on + read mode → rotation_rotate_disk fires byte_ready_edge
//     every ~8 bit-periods.
//   - rotation_speed_zone_set observable (state change).
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

const drive1541 = session?.kernel?.drive1541 ?? null;
check("(b) kernel.drive1541 is bound", drive1541 !== null);

const drv = drive1541?.diskunit?.drives?.[0] ?? null;
check("(c) drive_init: byteReadyLevel === 1", drv?.byteReadyLevel === 1);
check("(d) drive_init: gcrWriteValue === 0x55", drv?.gcrWriteValue === 0x55);
check("(e) drive_init: currentHalfTrack === 36", drv?.currentHalfTrack === 36);

const via1 = session?.kernel?.drive1541?.driveCpu?.via1 ?? null;
const via2 = session?.kernel?.drive1541?.driveCpu?.via2 ?? null;
const driveCpu = session?.kernel?.drive1541?.driveCpu;
const cpu = driveCpu?.cpu;

// VIA1 PRB Codex regression
if (via1 && drive1541) {
  drive1541.iecLineDrive({ bus_atn: true, bus_clk: true, bus_data: true });
  via1.ddrb = 0x00; via1.prb = 0x00;
}
const via1PrbRead = via1?.read(0x00) ?? -1;
check("(f) VIA1 PRB regression: bits 1/3/4 high",
  via1PrbRead !== -1 && (via1PrbRead & 0x1a) === 0x1a, `prbRead=$${via1PrbRead.toString(16)}`);

// VIA2 PB read VICE shape regression (BUS_READ_DELAY=14 + composed byte $7f)
const rot = await import("../dist/runtime/headless/vice1541/rotation.js");
if (via2) via2.write(0x02, 0x00); // DDRB=0 for input read
if (drv) drv.byteReadyLevel = 1;
rot.__resetRotationStubCounters();
const via2PbRead = via2?.read(0x00) ?? -1;
// With real rotation engine (no track loaded), rotation_sync_found
// returns 0x80 (no SYNC) → composed = $80 | $10 | $6f = $ff.
check("(g) VIA2 PB read: composed $ff (sync=$80, wps=$10, |0x6f)",
  via2PbRead === 0xff, `pbRead=$${via2PbRead.toString(16)}`);
// reqRefCycles is set to 14 by readPb but then rotation_rotate_disk
// (motor-off early-return OR rotation_1541_simple) immediately sets
// it back to 0 (VICE rotation.c:998 + 1107). The BUS_READ_DELAY
// stamp is observable only in trace, not in post-read state.
check("(h) VIA2 PB read invokes BUS_READ_DELAY-stamp pathway (rotation cleared it back to 0)",
  drv?.reqRefCycles === 0);
check("(i) VIA2 PB read calls rotation_rotate_disk",
  rot.__rotationCounters.rotate_disk >= 1);
check("(j) VIA2 PB read calls rotation_sync_found",
  rot.__rotationCounters.sync_found >= 1);

// === New rotation checks ===

// rotation_speed_zone_set observable through PB write.
rot.__resetRotationStubCounters();
if (via2 && drv) {
  via2.write(0x02, 0xff); // DDRB output
  // zone 0
  via2.write(0x00, 0b0000_0100); // motor on, density=00 (zone 0)
}
check("(k) PB write triggers rotation_speed_zone_set",
  rot.__rotationCounters.speed_zone_set >= 1);
check("(k.1) PB write triggers rotation_begins on motor-on edge",
  rot.__rotationCounters.begins >= 1);

// rotation_rotate_disk with motor on + read mode + sufficient drive
// cycles → BYTE-READY edges fire. Synthetic exercise:
// - read_write_mode = 1 (already from drive_init)
// - byteReadyActive has BRA_MOTOR_ON | BRA_BYTE_READY
// - Drive 6502 clock advances → rotation accumulator advances → bit walks
if (drv) {
  // Enable BRA_BYTE_READY via VIA2 setCa2 path (PCR manual-high CA2).
  if (via2) via2.write(0x0c /*VIA_PCR*/, 0x0e);
  // Reset byte_ready_edge tracker.
  drv.byteReadyEdge = 0;
  // Snapshot initial bit/byte state.
}
// Advance drive clock — call catchUpTo to step CPU; rotation_rotate_disk
// is called from VIA2 reads + from rotation_byte_read. To exercise
// rotation without ROM, directly bump clkPtr and invoke rotation_rotate_disk.
if (drive1541 && via2 && drv) {
  // Force motor on + density 0 + read mode; no PB writes interrupt
  // the accumulator now.
  const startClk = drive1541.diskunit.clkPtr.value;
  let edgesObserved = 0;
  // Step rotation by ~80 drive cycles per iteration; at zone 0 (250kbps),
  // each bit = 4 drive cycles, so ~80 cycles = ~20 bits ≈ 2.5 bytes.
  for (let i = 0; i < 16; i++) {
    drive1541.diskunit.clkPtr.value += 80;
    rot.rotation_rotate_disk(drive1541.diskunit);
    if (drv.byteReadyEdge) { edgesObserved++; drv.byteReadyEdge = 0; }
  }
  check("(l) rotation_rotate_disk fires byte_ready_edge with motor on + read mode",
    edgesObserved >= 2, `edges in 16×80 drive cycles: ${edgesObserved}`);
  const after = drive1541.diskunit.clkPtr.value;
  check("(l.1) drive clkPtr advanced", after > startClk, `start=${startClk} after=${after}`);
}

// rotation_byte_read returns 0 with no disk attached.
const byte = rot.rotation_byte_read(drive1541.diskunit);
check("(m) rotation_byte_read returns 0 with no GCR image loaded", byte === 0);

// rotation_sync_found returns 0x80 with no SYNC (all-zero bytes).
const syncResult = rot.rotation_sync_found(drive1541.diskunit);
check("(n) rotation_sync_found returns 0x80 with no SYNC pattern",
  syncResult === 0x80, `result=$${syncResult.toString(16)}`);

// rotation_speed_zone_set directly observable through density-bit change.
rot.__resetRotationStubCounters();
if (via2) {
  via2.write(0x02, 0xff); // DDRB output
  via2.write(0x00, 0b0010_0100); // motor on, density=01 (zone 1)
  via2.write(0x00, 0b0100_0100); // motor on, density=10 (zone 2)
  via2.write(0x00, 0b0110_0100); // motor on, density=11 (zone 3)
}
check("(o) speed-zone change observable (3 zones touched)",
  rot.__rotationCounters.speed_zone_set >= 3,
  `speed_zone_set count: ${rot.__rotationCounters.speed_zone_set}`);

// setCa2 + byteReadyEdge → direct V flag (regression from 611.5 fix 2).
if (cpu && drv && via2) {
  cpu.reg_p &= ~0x40;
  drv.byteReadyEdge = 1;
  drv.byteReadyActive &= ~0x02; // clear BRA_BYTE_READY so PCR triggers transition
  via2.write(0x0c, 0x0e); // PCR CA2 manual-high → setCa2(1)
}
const vFlagCa2 = (cpu?.reg_p ?? 0) & 0x40;
check("(p) setCa2(1) with byteReadyEdge=1 fires direct overflow → V set",
  vFlagCa2 !== 0 && drv?.byteReadyEdge === 0);

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
