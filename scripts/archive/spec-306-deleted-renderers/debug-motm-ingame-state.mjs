#!/usr/bin/env node
// Debug script: boot motm to ingame, dump vic state + scanlineSnapshots
// to see what renderer SHOULD have access to.

import { resolve as resolvePath } from "node:path";
const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);

const diskPath = resolvePath(repoRoot, "samples/motm.g64");
const { session } = startIntegratedSession({
  diskPath, mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "per-pixel",
});
session.resetCold("pal-default");

const PAL_HZ = 985248;

console.log("Boot...");
session.runFor(800_000);
session.typeText('LOAD"*",8,1\r', 80_000, 80_000);
for (let i = 0; i < 20; i++) session.runFor(50_000);

// Advance to ingame state — try 90 seconds (motm needs longer than title)
const targetSec = parseInt(process.argv[2] ?? "90", 10);
console.log(`Advancing ${targetSec}s...`);
const target = session.c64Cpu.cycles + targetSec * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(50_000);
console.log(`cycle=${session.c64Cpu.cycles} pc=$${session.c64Cpu.pc.toString(16)}`);

// Dump VIC state
const vic = session.vic;
console.log("\n=== VIC current regs ===");
console.log(`d011: $${vic.regs[0x11].toString(16).padStart(2,"0")}  (DEN=${(vic.regs[0x11]&0x10)!==0} BMM=${(vic.regs[0x11]&0x20)!==0} ECM=${(vic.regs[0x11]&0x40)!==0})`);
console.log(`d016: $${vic.regs[0x16].toString(16).padStart(2,"0")}  (MCM=${(vic.regs[0x16]&0x10)!==0} CSEL=${(vic.regs[0x16]&0x08)!==0})`);
console.log(`d018: $${vic.regs[0x18].toString(16).padStart(2,"0")}  (screen base bits 4-7, char base bits 1-3)`);
console.log(`d020 border: $${vic.regs[0x20].toString(16)} d021 bg: $${vic.regs[0x21].toString(16)}`);
console.log(`d015 sprite enable: $${vic.regs[0x15].toString(16).padStart(2,"0")}`);
console.log(`raster_y: ${vic.raster_y}`);

console.log("\n=== scanlineSnapshots ===");
console.log(`count: ${vic.scanlineSnapshots.length}`);
const snapsByLine = new Map();
for (const s of vic.scanlineSnapshots) snapsByLine.set(s.rasterLine, s);
const linesOfInterest = [0, 50, 51, 100, 150, 200, 250, 300];
for (const ln of linesOfInterest) {
  const s = snapsByLine.get(ln);
  if (s) {
    console.log(`  line ${ln.toString().padStart(3)}: d011=$${s.d011.toString(16)} d016=$${s.d016.toString(16)} d018=$${s.d018.toString(16)} d020=$${s.d020.toString(16)}`);
  } else {
    console.log(`  line ${ln.toString().padStart(3)}: (no snap)`);
  }
}

// Find d018 changes
console.log("\n=== d018 changes through frame ===");
let lastD018 = null;
for (const s of vic.scanlineSnapshots) {
  if (s.d018 !== lastD018) {
    console.log(`  line ${s.rasterLine.toString().padStart(3)}: d018=$${s.d018.toString(16)}`);
    lastD018 = s.d018;
  }
}

// Find d011 changes
console.log("\n=== d011 changes through frame ===");
let lastD011 = null;
for (const s of vic.scanlineSnapshots) {
  if (s.d011 !== lastD011) {
    console.log(`  line ${s.rasterLine.toString().padStart(3)}: d011=$${s.d011.toString(16)} (BMM=${(s.d011&0x20)!==0})`);
    lastD011 = s.d011;
  }
}

// CIA2 PA + frame log
console.log("\n=== CIA2 PA ===");
console.log(`current pra=$${session.cia2.pra.toString(16)} ddra=$${session.cia2.ddra.toString(16)} effective=$${(session.cia2.pra & session.cia2.ddra & 0xff).toString(16)}`);

const logs = vic.frameLineLogs;
if (logs) {
  console.log(`frameLineLogs count: ${logs.length}`);
  let bankChanges = 0;
  for (const l of logs) {
    for (const w of (l.writes ?? [])) {
      if (w.reg === 0x80) bankChanges++;
    }
  }
  console.log(`CIA2 PA bank changes in frame: ${bankChanges}`);
}

// Render
console.log("\n=== render ===");
const outPath = `/tmp/motm-debug-pixel.png`;
session.renderToPng(outPath);
console.log(`PNG: ${outPath}`);

// Also try per-char-row for comparison
const sessionPath = `/tmp/motm-debug-charrow.png`;
session.renderToPng(sessionPath, { renderer: "per-char-row" });
console.log(`PNG: ${sessionPath}`);
