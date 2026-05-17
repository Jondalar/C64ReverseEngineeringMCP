#!/usr/bin/env node
// Spec 611 phase 611.7f.14 — stepper / HT trace.
//
// 7f13 isolated: drive at HT=38 (= track 19) instead of HT=36 (= track 18).
// Stepper bug. Trace VIA2 PB writes (= stepper phase commands) and
// driveSetHalfTrack calls to find divergence.
//
// VICE stepper formula (via2d.c:228-255):
//   track_number = current_half_track - 2
//   old_stepper_position = track_number & 3
//   step_count = (new_stepper_position - old_stepper_position) & 3
//   if step_count == 3 → -1
//   motor-gated on PB.2
//
// Stepper goes 0→1→2→3→0 inward, reverse outward. Each step = 1 HT.
//
// Read-only.

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, "samples/synthetic/blank.d64");
if (!existsSync(diskPath)) { console.error("missing", diskPath); process.exit(1); }

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
const vice = session.kernel.drive1541;
const drive = vice.diskunit.drives[0];
const driveCpu = vice.driveCpu;
const via2 = driveCpu.via2;

// Probe initial HT BEFORE mount.
console.log(`=== INITIAL STATE (pre-mount) ===`);
console.log(`drive.currentHalfTrack: ${drive.currentHalfTrack}`);
console.log(`drive.gcrImageLoaded:   ${drive.gcrImageLoaded}`);

await mountMedia(session, 8, diskPath);

// Spy via cpu.executeCycle to detect HT changes from any source.
const htChanges = [];
let prevHt = drive.currentHalfTrack;
const origExec = driveCpu.cpu.executeCycle.bind(driveCpu.cpu);
driveCpu.cpu.executeCycle = function() {
  const r = origExec();
  if (drive.currentHalfTrack !== prevHt) {
    if (htChanges.length < 50) {
      htChanges.push({
        t: session.c64Cpu.cycles,
        drvClk: driveCpu.cpu.clk,
        drvPc: driveCpu.cpu.reg_pc & 0xffff,
        oldHt: prevHt,
        newHt: drive.currentHalfTrack,
      });
    }
    prevHt = drive.currentHalfTrack;
  }
  return r;
};
console.log("");
console.log(`=== POST-MOUNT STATE ===`);
console.log(`drive.currentHalfTrack: ${drive.currentHalfTrack}`);
console.log(`drive.gcrImageLoaded:   ${drive.gcrImageLoaded}`);
console.log(`drive.gcrCurrentTrackSize: ${drive.gcrCurrentTrackSize}`);
console.log(`drive.gcr.tracks length: ${drive.gcr?.tracks?.length}`);

// Spy on VIA2 PB writes that include the stepper bits.
const stepperEvents = [];
const origWrite = via2.write.bind(via2);
let prevPrb = via2.prb & 0xff;
via2.write = (reg, value) => {
  const r = reg & 0x0f;
  const v = value & 0xff;
  let stepResult = null;
  if (r === 0x00) { // VIA_PRB
    // Compute what stepper would do BEFORE call.
    const oldPrb = prevPrb;
    const ddrb = via2.ddrb & 0xff;
    const driven = v & ddrb;
    const motorOn = (driven & 0x04) !== 0;
    const oldHt = drive.currentHalfTrack;
    const trackNumber = oldHt - 2;
    const oldPos = trackNumber & 3;
    const newPos = driven & 0x03;
    let step = (newPos - oldPos) & 3;
    if (step === 3) step = -1;
    stepResult = { oldHt, motorOn, oldPos, newPos, step, driven };
  }
  const result = origWrite(reg, value);
  if (r === 0x00 && stepResult) {
    const newHt = drive.currentHalfTrack;
    if (newHt !== stepResult.oldHt || stepResult.step !== 0) {
      stepperEvents.push({
        t: session.c64Cpu.cycles,
        drvClk: driveCpu.cpu.clk,
        drvPc: driveCpu.cpu.reg_pc & 0xffff,
        prb: v,
        driven: stepResult.driven,
        motorOn: stepResult.motorOn,
        oldHt: stepResult.oldHt,
        oldPos: stepResult.oldPos,
        newPos: stepResult.newPos,
        step: stepResult.step,
        newHt,
      });
    }
    prevPrb = v;
  }
  return result;
};

session.resetCold("pal-default");
session.runFor(2_000_000);
console.log("");
console.log(`=== POST-BOOT (2M c64 cyc) HT = ${drive.currentHalfTrack} ===`);

session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 14 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

console.log("");
console.log(`=== FINAL HT = ${drive.currentHalfTrack} ===`);
console.log("");
console.log(`=== HT changes detected via cpu.executeCycle spy (max 50) ===`);
for (const c of htChanges) {
  console.log(`t=${c.t} drvClk=${c.drvClk} drvPc=$${c.drvPc.toString(16).padStart(4,"0")} HT ${c.oldHt} → ${c.newHt}`);
}
console.log(`Total HT changes captured: ${htChanges.length}`);

console.log("");
console.log(`=== STEPPER EVENTS captured (${stepperEvents.length}) ===`);
console.log("t          drvClk     drvPc  PRB  driven motor oldHT oldPos→newPos step → newHT");
for (const e of stepperEvents) {
  console.log(
    `${e.t.toString().padStart(10)} ${e.drvClk.toString().padStart(10)} $${e.drvPc.toString(16).padStart(4,"0")} $${e.prb.toString(16).padStart(2,"0")}  $${e.driven.toString(16).padStart(2,"0")}    ${e.motorOn?"ON ":"off"} ${e.oldHt.toString().padStart(3)}   ${e.oldPos}→${e.newPos}        ${e.step>=0?"+":""}${e.step}   → ${e.newHt}`,
  );
}

console.log("");
console.log(`=== SUMMARY ===`);
console.log(`Total stepper events: ${stepperEvents.length}`);
const netStep = stepperEvents.reduce((a, e) => a + e.step, 0);
console.log(`Net step sum: ${netStep} (= ${netStep} HT moved from start)`);
console.log(`Initial HT (post-mount): ${stepperEvents[0]?.oldHt ?? "?"}`);
console.log(`Final HT: ${drive.currentHalfTrack}`);
console.log(`Target HT for track 18: 36`);
console.log(`Off by: ${drive.currentHalfTrack - 36} HT (= ${(drive.currentHalfTrack - 36) / 2} physical tracks)`);
