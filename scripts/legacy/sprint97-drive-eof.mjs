#!/usr/bin/env node
// Sprint 97 (Bug 40) — capture drive PC for the last 5000 drive
// cycles before drive enters $EC2D idle area. Identify the exact
// ROM routine returning drive to idle after sending the final byte.

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) process.exit(2);

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
});
session.resetCold();
session.runFor(800_000);
session.typeText('LOAD"MM",8,1\r', 80_000, 80_000);

// Run until drive enters $EC2D idle. Track recent PC ring buffer.
const RING_SIZE = 8000;
const ring = new Array(RING_SIZE);
let ringHead = 0;

// Watch drive PC ranges during the TALK byte-send phase. Track every
// visit to E919..E96D (FRMBYT) and surrounding routines. Stop after
// drive is silent in that range for 50000 drive cycles.
let eoiSeenCycle = -1;
let postEoiCount = 0;
let endCycle = -1;
const talkVisits = [];     // list of {drvCyc, pc} entries within E900-EA50
let lastTalkCyc = 0;
const W = (n) => "$" + (n & 0xff).toString(16).padStart(2, "0");
const W4 = (n) => "$" + (n & 0xffff).toString(16).padStart(4, "0");

for (let i = 0; i < 100_000_000; i++) {
  session.runFor(1);
  const dpc = session.drive.cpu.pc;
  ring[ringHead] = { c64Cyc: session.c64Cpu.cycles, drvCyc: session.drive.cpu.cycles, pc: dpc };
  ringHead = (ringHead + 1) % RING_SIZE;
  if (dpc >= 0xe700 && dpc <= 0xeb00) {
    talkVisits.push({ drvCyc: session.drive.cpu.cycles, c64Cyc: session.c64Cpu.cycles, pc: dpc });
    lastTalkCyc = session.drive.cpu.cycles;
  }
  if (dpc === 0xe999) {
    console.log(`*** TALK ABORT $E999 hit at drvCyc=${session.drive.cpu.cycles}, c64Cyc=${session.c64Cpu.cycles}`);
  }
  if (dpc === 0xe915) {
    console.log(`*** TALK CLEAN END $E915 (RTS) hit at drvCyc=${session.drive.cpu.cycles}, c64Cyc=${session.c64Cpu.cycles}`);
  }
  if (eoiSeenCycle < 0) {
    if ((session.c64Bus.ram[0x90] & 0x40) !== 0) {
      eoiSeenCycle = session.drive.cpu.cycles;
      console.log(`EOI flag set at drvCyc=${eoiSeenCycle}, c64Cyc=${session.c64Cpu.cycles}, drvPC=${W4(dpc)}`);
    }
  } else {
    postEoiCount++;
    if (postEoiCount >= 6000) {
      endCycle = session.drive.cpu.cycles;
      break;
    }
  }
}

if (endCycle < 0) {
  console.log("EOI never seen within budget");
  process.exit(1);
}
console.log(`Captured up to drvCyc=${endCycle} (${endCycle - eoiSeenCycle} drv cyc post-EOI)`);
console.log(`\nTotal TALK-area ($E900-$EA50) visits: ${talkVisits.length}`);
console.log(`Last TALK-area visit at drvCyc=${lastTalkCyc} (= ${eoiSeenCycle - lastTalkCyc} drv cyc BEFORE EOI)`);
// Compress and show the LAST 60 distinct TALK PCs.
const tcomp = [];
for (const v of talkVisits) {
  const last = tcomp[tcomp.length - 1];
  if (last && last.pc === v.pc) { last.count++; last.lastCyc = v.drvCyc; }
  else tcomp.push({ drvCyc: v.drvCyc, lastCyc: v.drvCyc, pc: v.pc, count: 1, c64Cyc: v.c64Cyc });
}
console.log(`\nTALK-area compressed visits (final 60):`);
for (const c of tcomp.slice(-60)) {
  console.log(`  drvCyc=${c.drvCyc}..${c.lastCyc} pc=${W4(c.pc)} (×${c.count}) c64Cyc=${c.c64Cyc}`);
}

// Walk ring forward from current head (oldest first).
const events = [];
for (let i = 0; i < RING_SIZE; i++) {
  const idx = (ringHead + i) % RING_SIZE;
  if (ring[idx]) events.push(ring[idx]);
}

// Compress consecutive identical PCs to PC + count.
const compressed = [];
for (const e of events) {
  const last = compressed[compressed.length - 1];
  if (last && last.pc === e.pc) {
    last.count++;
    last.lastDrvCyc = e.drvCyc;
  } else {
    compressed.push({ pc: e.pc, count: 1, drvCyc: e.drvCyc, lastDrvCyc: e.drvCyc });
  }
}

console.log(`\nCompressed PC trace (last ~${RING_SIZE} drive cyc, ${compressed.length} distinct visits):`);
for (const c of compressed) {
  if (c.count > 1) {
    console.log(`  drvCyc=${c.drvCyc}..${c.lastDrvCyc} pc=${W4(c.pc)} (×${c.count})`);
  } else {
    console.log(`  drvCyc=${c.drvCyc} pc=${W4(c.pc)}`);
  }
}

// Show last 100 distinct PCs with full granularity.
console.log(`\nFinal 80 distinct PC visits before idle:`);
for (const c of compressed.slice(-80)) {
  if (c.count > 1) {
    console.log(`  drvCyc=${c.drvCyc}..${c.lastDrvCyc} pc=${W4(c.pc)} (×${c.count})`);
  } else {
    console.log(`  drvCyc=${c.drvCyc} pc=${W4(c.pc)}`);
  }
}
