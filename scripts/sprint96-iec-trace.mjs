#!/usr/bin/env node
// Sprint 96 — capture full IEC edge trace during LOAD"*",8,1 to count
// how many bytes KERNAL actually transmitted to the drive (LISTEN +
// SECOND + filename + UNLISTEN).

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) process.exit(2);

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
  traceIec: true, traceIecCapacity: 200_000,
});
session.resetCold();
session.runFor(800_000);

// Mark cycle baseline before LOAD typed.
const cycBeforeLoad = session.c64Cpu.cycles;
session.iecBus.clearTrace();

session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);
session.runFor(8_000_000);

const trace = session.iecBus.getTrace();
console.log(`IEC edges captured: ${trace.length}, baseline cyc=${cycBeforeLoad}`);

// Count ATN transitions and CLK falling-edges (= bit-clock pulses).
let atnLowCount = 0, atnHighCount = 0;
let clkFallCountByPhase = { atnLow: 0, atnHigh: 0 };
let prevAtn = -1, prevClk = -1, prevData = -1;
let atnLowAtCyc = -1;
const atnEvents = [];
for (const e of trace) {
  if (prevAtn !== -1) {
    if (prevAtn === 1 && e.atn === 0) { atnLowCount++; atnLowAtCyc = e.cycle; atnEvents.push({ cyc: e.cycle, evt: "ATN↓" }); }
    if (prevAtn === 0 && e.atn === 1) { atnHighCount++; atnEvents.push({ cyc: e.cycle, evt: "ATN↑" }); }
  }
  if (prevClk === 1 && e.clk === 0 && e.side === "c64") {
    if (e.atn === 0) clkFallCountByPhase.atnLow++; else clkFallCountByPhase.atnHigh++;
  }
  prevAtn = e.atn; prevClk = e.clk; prevData = e.data;
}

console.log(`\nATN transitions: ↓${atnLowCount} ↑${atnHighCount}`);
console.log(`C64 CLK falling edges (= bit-pulses):`);
console.log(`  during ATN low (commands LISTEN/SECOND/UNLISTEN/etc): ${clkFallCountByPhase.atnLow}`);
console.log(`  during ATN high (data bytes incl filename): ${clkFallCountByPhase.atnHigh}`);
console.log(`  expected for LOAD"*",8,1:`);
console.log(`    ATN low: 8 (LISTEN $28) + 8 (SECOND $F0) + 8 (UNLISTEN $3F) = 24`);
console.log(`    ATN high: 8 (filename "*")`);

console.log(`\nATN events:`);
for (const e of atnEvents.slice(0, 20)) {
  console.log(`  c64Cyc=${e.cyc} ${e.evt}`);
}

// First 30 edges
console.log(`\nFirst 30 IEC edges:`);
for (const e of trace.slice(0, 30)) {
  console.log(`  cyc=${e.cycle} side=${e.side} ATN=${e.atn} CLK=${e.clk} DATA=${e.data}`);
}
