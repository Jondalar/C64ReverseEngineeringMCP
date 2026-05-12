#!/usr/bin/env node
// Sprint 96 — capture KERNAL serial bit-bang in detail. Trace every C64
// instruction once PC enters $E000+ (KERNAL ROM); tag IRQs by PC. Stop
// when PC re-enters BASIC area for an extended period (timeout fired).

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

// Run until PC enters KERNAL serial code area ($ED00-$EF00).
// LOAD entry calls $F4A5/F495, then ATN at $ED0C onwards.
const RD = (a) => session.c64Bus.read(a);
const W = (n) => "$" + n.toString(16).toUpperCase().padStart(4, "0");

let entered = false;
for (let i = 0; i < 5_000_000 && !entered; i++) {
  session.runFor(1);
  const pc = session.c64Cpu.pc;
  if (pc >= 0xed00 && pc < 0xef00) entered = true;
}
console.log(`Entered serial code at cyc=${session.c64Cpu.cycles} PC=${W(session.c64Cpu.pc)}`);

// Trace every instruction in the next chunk. Categorise PCs.
const SAMPLE_INSTR = 30_000;
const log = [];
let pcLastSerial = session.c64Cpu.pc;
for (let i = 0; i < SAMPLE_INSTR; i++) {
  const pc = session.c64Cpu.pc;
  const cyc = session.c64Cpu.cycles;
  const dpc = session.drive.cpu.pc;
  const iec = session.iecBus.snapshot();
  const dc01 = RD(0xdc01);
  log.push({ pc, cyc, dpc, iec, dc01 });
  session.runFor(1);
}
console.log(`Captured ${log.length} steps. Last cyc=${session.c64Cpu.cycles}`);

// Find unique PCs visited + count.
const hist = new Map();
for (const e of log) hist.set(e.pc, (hist.get(e.pc) ?? 0) + 1);
console.log(`\nUnique C64 PCs in window: ${hist.size}`);
const top = [...hist.entries()].sort((a,b) => b[1]-a[1]).slice(0, 25);
for (const [pc, c] of top) console.log(`  ${W(pc)}: ${c}`);

// Sample IEC line transitions seen in this window.
console.log(`\nFirst 12 PCs (raw):`);
for (const e of log.slice(0, 12)) {
  console.log(`  cyc=${e.cyc} PC=${W(e.pc)} drv=${W(e.dpc)} ATN=${e.iec.line.atn?1:0} CLK=${e.iec.line.clk?1:0} DATA=${e.iec.line.data?1:0}`);
}
console.log(`\nLast 12 PCs (raw):`);
for (const e of log.slice(-12)) {
  console.log(`  cyc=${e.cyc} PC=${W(e.pc)} drv=${W(e.dpc)} ATN=${e.iec.line.atn?1:0} CLK=${e.iec.line.clk?1:0} DATA=${e.iec.line.data?1:0}`);
}

// Find the FIRST PC that loops > 1000 times consecutively.
let stuckStart = 0, stuckPc = -1;
for (let i = 1; i < log.length; i++) {
  if (log[i].pc !== log[stuckStart].pc) {
    if (i - stuckStart > 1000) {
      const dur = i - stuckStart;
      console.log(`\nStuck loop at PC=${W(log[stuckStart].pc)} from cyc=${log[stuckStart].cyc} for ${dur} samples (cyc=${log[i].cyc - log[stuckStart].cyc})`);
      console.log(`  drive PC during stuck: ${W(log[stuckStart].dpc)} → ${W(log[i-1].dpc)}`);
      console.log(`  IEC at start: ATN=${log[stuckStart].iec.line.atn?1:0} CLK=${log[stuckStart].iec.line.clk?1:0} DATA=${log[stuckStart].iec.line.data?1:0}`);
      console.log(`  IEC at end:   ATN=${log[i-1].iec.line.atn?1:0} CLK=${log[i-1].iec.line.clk?1:0} DATA=${log[i-1].iec.line.data?1:0}`);
    }
    stuckStart = i;
  }
}
