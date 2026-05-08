#!/usr/bin/env node
// Hook drive bus writes to capture every write to drive ZP[$01] during
// stage-1. Logs PC/value/clock for first 100 writes.

import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

const { session } = startIntegratedSession({
  diskPath: resolvePath(repoRoot, "samples/motm.g64"),
  mode: "true-drive",
  useMicrocodedCpu: true,
});
session.resetCold("pal-default");

// Patch drive bus.write to log $0001 writes ONLY during stage-1 window
// (drive clock 100k..23.5M = AFTER ROM boot init, BEFORE motm stage-1
// finishes).
const driveBus = session.drive.bus;
const origWrite = driveBus.write.bind(driveBus);
const writeLog = [];
const STAGE1_START = 100000;     // drive cycles
const STAGE1_END = 23500000;
driveBus.write = function(addr, value) {
  if ((addr & 0xffff) === 0x0001) {
    const driveClk = session.drive.cpu.cycles;
    const pc = session.drive.cpu.pc;
    // Skip ROM init loop $EAB9 (= 60089). Capture everything else
    // during stage-1 window.
    if (driveClk >= STAGE1_START && driveClk <= STAGE1_END && pc !== 0xeab9 && writeLog.length < 500) {
      writeLog.push({
        tick: session.c64Cpu.cycles,
        driveClk,
        pc,
        value: value & 0xff,
        a: session.drive.cpu.a,
        x: session.drive.cpu.x,
        y: session.drive.cpu.y,
        sp: session.drive.cpu.sp,
        flags: session.drive.cpu.flags,
      });
    }
  }
  return origWrite(addr, value);
};

session.runFor(800_000);
session.typeText('LOAD"*",8,1\r', 80_000, 80_000);

const PAL_HZ = 985248;
const target = session.c64Cpu.cycles + 25 * PAL_HZ;
while (session.c64Cpu.cycles < target) {
  session.runFor(50_000);
}

console.log(`Total $0001 writes captured: ${writeLog.length}`);
console.log(`First 30:`);
for (const w of writeLog.slice(0, 30)) {
  console.log(`  c64=${w.tick} drive=${w.driveClk} PC=$${w.pc.toString(16).padStart(4,"0")} A=$${w.a.toString(16).padStart(2,"0")} X=$${w.x.toString(16).padStart(2,"0")} Y=$${w.y.toString(16).padStart(2,"0")} SP=$${w.sp.toString(16).padStart(2,"0")} -> $01=$${w.value.toString(16).padStart(2,"0")}`);
}
console.log(`\nLast 10:`);
for (const w of writeLog.slice(-10)) {
  console.log(`  c64=${w.tick} drive=${w.driveClk} PC=$${w.pc.toString(16).padStart(4,"0")} A=$${w.a.toString(16).padStart(2,"0")} X=$${w.x.toString(16).padStart(2,"0")} Y=$${w.y.toString(16).padStart(2,"0")} SP=$${w.sp.toString(16).padStart(2,"0")} -> $01=$${w.value.toString(16).padStart(2,"0")}`);
}
console.log(`\nALL writes with value=$03:`);
for (const w of writeLog.filter(w => w.value === 0x03)) {
  console.log(`  c64=${w.tick} drive=${w.driveClk} PC=$${w.pc.toString(16).padStart(4,"0")} A=$${w.a.toString(16).padStart(2,"0")} X=$${w.x.toString(16).padStart(2,"0")} Y=$${w.y.toString(16).padStart(2,"0")} SP=$${w.sp.toString(16).padStart(2,"0")}`);
}
console.log(`\nALL writes with value=$01:`);
for (const w of writeLog.filter(w => w.value === 0x01).slice(0, 10)) {
  console.log(`  c64=${w.tick} drive=${w.driveClk} PC=$${w.pc.toString(16).padStart(4,"0")} A=$${w.a.toString(16).padStart(2,"0")} X=$${w.x.toString(16).padStart(2,"0")} Y=$${w.y.toString(16).padStart(2,"0")} SP=$${w.sp.toString(16).padStart(2,"0")}`);
}

// Distribution by PC
const byPc = new Map();
for (const w of writeLog) {
  const k = w.pc;
  byPc.set(k, (byPc.get(k) ?? 0) + 1);
}
console.log(`\nWriter PC distribution:`);
for (const [pc, cnt] of [...byPc.entries()].sort((a,b)=>b[1]-a[1])) {
  console.log(`  PC=$${pc.toString(16).padStart(4,"0")}: ${cnt}`);
}

// Value distribution
const byVal = new Map();
for (const w of writeLog) {
  const k = w.value;
  byVal.set(k, (byVal.get(k) ?? 0) + 1);
}
console.log(`\nValue distribution:`);
for (const [val, cnt] of [...byVal.entries()].sort((a,b)=>b[1]-a[1])) {
  console.log(`  $01=$${val.toString(16).padStart(2,"0")}: ${cnt}`);
}
