#!/usr/bin/env node
// Sprint 96 — instrument every drive $1800 read at PC=$EA0B during the
// LISTEN $28 byte receive. Log raw $1800 byte + c64 cycle + IEC line
// state to understand WHY drive reads bits 2,3,4 wrong.

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) { process.exit(2); }

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
  traceIec: true, traceIecCapacity: 8192,
});
session.resetCold();
session.runFor(800_000);
session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);

// Patch drive bus to log every $1800 read at $EA0B.
const W = (n) => "$" + n.toString(16).toUpperCase().padStart(4, "0");
const reads = [];
const origRead = session.drive.bus.via1.constructor.prototype && null;
// Simpler: snapshot via post-step probe. Run cycle-by-cycle.
let lastBitCount = -1;
let inBitLoop = false;
for (let i = 0; i < 5_000_000; i++) {
  session.runFor(1);
  const dpc = session.drive.cpu.pc;
  if (dpc === 0xea0b && !inBitLoop) {
    inBitLoop = true;
  }
  if (dpc === 0xea0b && inBitLoop) {
    // About to read $1800. Snapshot state.
    const iec = session.iecBus.snapshot();
    const bc = session.drive.bus.ram[0x98];
    if (bc !== lastBitCount) {
      reads.push({
        bitCount: bc,
        c64Cyc: session.c64Cpu.cycles,
        drvCyc: session.drive.cpu.cycles,
        iecLine: { ...iec.line },
        c64Atn: iec.c64.atnReleased ? 1 : 0,
        c64Clk: iec.c64.clkReleased ? 1 : 0,
        c64Data: iec.c64.dataReleased ? 1 : 0,
      });
      lastBitCount = bc;
      if (reads.length > 12) break;
    }
  }
}

console.log(`Drive $1800 reads at PC=$EA0B during byte receive:`);
for (const r of reads) {
  console.log(`  bitCount=${r.bitCount} c64Cyc=${r.c64Cyc} drvCyc=${r.drvCyc} ATN=${r.iecLine.atn?1:0} CLK=${r.iecLine.clk?1:0} DATA=${r.iecLine.data?1:0}  c64=${r.c64Atn}/${r.c64Clk}/${r.c64Data}`);
}

console.log(`\nPost-byte: $85=${session.drive.bus.ram[0x85].toString(16)} $79=${session.drive.bus.ram[0x79]} drvPC=${W(session.drive.cpu.pc)}`);
