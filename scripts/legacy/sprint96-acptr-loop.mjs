#!/usr/bin/env node
// Sprint 96 — diagnose KERNAL ACPTR retry loop. Sample c64 PC + RAM
// $A5 (EOI counter) + $90 (status) + stack pointer at fine intervals
// during the post-LOAD hang to identify the actual loop driver.

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
session.runFor(20_000_000);

// Now sample at fine intervals
const ram = session.c64Bus.ram;
const cpu = session.c64Cpu;
const samples = [];
const W = (n) => "$" + (n & 0xff).toString(16).padStart(2, "0");
const W4 = (n) => "$" + (n & 0xffff).toString(16).padStart(4, "0");
for (let i = 0; i < 1000; i++) {
  session.runFor(200);
  samples.push({
    cyc: cpu.cycles, pc: cpu.pc, sp: cpu.sp,
    a5: ram[0xa5], a90: ram[0x90], a4: ram[0xa4],
    stackTop: [ram[0x100 + cpu.sp + 1], ram[0x100 + cpu.sp + 2], ram[0x100 + cpu.sp + 3]],
  });
}

console.log("Sample (every 200 cyc):");
let prev = null;
for (const s of samples.slice(0, 50)) {
  const delta = prev ? `Δa5=${s.a5-prev.a5} Δ90=${s.a90-prev.a90}` : "";
  console.log(`  cyc=${s.cyc} pc=${W4(s.pc)} sp=${W(s.sp)} $A5=${W(s.a5)} $90=${W(s.a90)} $A4=${W(s.a4)} top3=${s.stackTop.map(W).join(",")} ${delta}`);
  prev = s;
}

// PC histogram
const pcCount = new Map();
for (const s of samples) pcCount.set(s.pc, (pcCount.get(s.pc) ?? 0) + 1);
const top = [...pcCount.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 12);
console.log(`\nTop PC hits over 1000 samples:`);
for (const [pc, c] of top) console.log(`  ${W4(pc)}: ${c}`);

// $A5 + $90 evolution
const a5Vals = new Set(samples.map(s => s.a5));
const a90Vals = new Set(samples.map(s => s.a90));
console.log(`\n$A5 distinct values: ${[...a5Vals].map(W).join(",")}`);
console.log(`$90 distinct values: ${[...a90Vals].map(W).join(",")}`);
