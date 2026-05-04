#!/usr/bin/env node
// Sprint 96 — single-step drive PC during the LOAD ATN exchange to see
// whether drive ATN handler at $E85B runs and reads the LISTEN byte.

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) { process.exit(2); }

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
});
session.resetCold();
session.runFor(800_000);
session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);

const W = (n) => "$" + n.toString(16).toUpperCase().padStart(4, "0");
const RD = (a) => session.drive.bus.ram[a];

// Run forward until ATN goes low (C64 starts ATN sequence).
let i = 0;
while (i < 5_000_000 && session.iecBus.snapshot().line.atn) {
  session.runFor(1);
  i++;
}
console.log(`ATN went low at step ${i}, c64 cyc=${session.c64Cpu.cycles}, drv cyc=${session.drive.cpu.cycles}`);

// Single-step until drive leaves the $E87B-$E882 wait loop (PC < $E87B
// or PC > $E883). Then log next 200 drive PC transitions.
let leftLoop = false;
let stepsToLeave = 0;
for (let k = 0; k < 5_000_000; k++) {
  session.runFor(1);
  stepsToLeave++;
  const dpc = session.drive.cpu.pc;
  if (dpc < 0xe87b || dpc > 0xe883) {
    if (k > 100) { leftLoop = true; break; }
  }
}
console.log(`Steps to leave $E87B loop: ${stepsToLeave}`);
console.log(`After loop: drv PC=${W(session.drive.cpu.pc)} c64Cyc=${session.c64Cpu.cycles} drvCyc=${session.drive.cpu.cycles} ATN=${session.iecBus.snapshot().line.atn?1:0}`);

if (leftLoop) {
  const drvPcs = [];
  let lastDrvPc = session.drive.cpu.pc;
  drvPcs.push({ k: 0, dpc: lastDrvPc, c64cyc: session.c64Cpu.cycles, drvCyc: session.drive.cpu.cycles, atn: session.iecBus.snapshot().line.atn?1:0 });
  for (let k = 0; k < 500_000 && drvPcs.length < 250; k++) {
    session.runFor(1);
    const dpc = session.drive.cpu.pc;
    if (dpc !== lastDrvPc) {
      drvPcs.push({ k: k + 1, dpc, c64cyc: session.c64Cpu.cycles, drvCyc: session.drive.cpu.cycles, atn: session.iecBus.snapshot().line.atn?1:0 });
      lastDrvPc = dpc;
    }
  }
  console.log(`\nDrive PC after wait-loop:`);
  for (const e of drvPcs.slice(0, 100)) {
    console.log(`  k=${e.k} drv=${W(e.dpc)} c64cyc=${e.c64cyc} drvCyc=${e.drvCyc} ATN=${e.atn}`);
  }
}

console.log(`\nDrive RAM after sequence:`);
console.log(`  $77=${RD(0x77).toString(16)} $79=${RD(0x79).toString(16)} $7A=${RD(0x7a).toString(16)} $7C=${RD(0x7c).toString(16)} $7D=${RD(0x7d).toString(16)} $7E=${RD(0x7e).toString(16)}`);
