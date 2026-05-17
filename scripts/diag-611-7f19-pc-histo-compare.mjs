#!/usr/bin/env node
// Spec 611 phase 611.7f.19 — PC histogram compare vice vs legacy in
// the window around legacy's $F3EA fire (drvClk ~9.49M).
// Find first divergent PC = DOS dispatch branch where vice takes
// different path.

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

async function capture(drive1541, lo, hi) {
  const { session } = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    ...(drive1541 === "vice" ? { drive1541: "vice" } : {}),
  });
  await mountMedia(session, 8, diskPath);
  const cpu = drive1541 === "vice"
    ? session.kernel.drive1541.driveCpu.cpu
    : session.drive.cpu;

  const pcHisto = new Map();
  const origExec = cpu.executeCycle.bind(cpu);
  cpu.executeCycle = function () {
    const r = origExec();
    if (cpu.clk >= lo && cpu.clk <= hi) {
      const pc = cpu.reg_pc & 0xffff;
      if (pc >= 0xc000) pcHisto.set(pc, (pcHisto.get(pc) ?? 0) + 1);
    }
    return r;
  };

  session.resetCold("pal-default");
  session.runFor(2_000_000);
  session.typeText('LOAD"$",8\r', 80_000, 80_000);
  const PAL_HZ = 985_248;
  const tgt = session.c64Cpu.cycles + 14 * PAL_HZ;
  while (session.c64Cpu.cycles < tgt) session.runFor(200_000);
  return pcHisto;
}

// Capture window: 8.5M..9.5M drvClk (covers LOAD's first DOS dispatch).
const LO = 8_500_000;
const HI = 9_500_000;

console.log("Capturing vice PC histogram (drvClk 8.5M..9.5M)...");
const vice = await capture("vice", LO, HI);
console.log(`vice: ${[...vice.values()].reduce((a,b)=>a+b,0)} samples, ${vice.size} unique PCs`);

console.log("Capturing legacy PC histogram (same window)...");
const leg = await capture("legacy", LO, HI);
console.log(`legacy: ${[...leg.values()].reduce((a,b)=>a+b,0)} samples, ${leg.size} unique PCs`);

// Find PCs UNIQUE TO LEGACY (= legacy visits, vice doesn't).
const legacyOnly = [];
for (const [pc, n] of leg) {
  if (!vice.has(pc)) legacyOnly.push({ pc, n });
}
legacyOnly.sort((a,b) => b.n - a.n);
console.log(`\nPCs in LEGACY but NOT in VICE (top 30):`);
for (const e of legacyOnly.slice(0, 30)) {
  console.log(`  $${e.pc.toString(16).padStart(4,"0")}: ${e.n}`);
}

// Find PCs UNIQUE TO VICE.
const viceOnly = [];
for (const [pc, n] of vice) {
  if (!leg.has(pc)) viceOnly.push({ pc, n });
}
viceOnly.sort((a,b) => b.n - a.n);
console.log(`\nPCs in VICE but NOT in LEGACY (top 30):`);
for (const e of viceOnly.slice(0, 30)) {
  console.log(`  $${e.pc.toString(16).padStart(4,"0")}: ${e.n}`);
}

// Find COMMON PCs with biggest ratio (vice / legacy) — = vice spins
// where legacy moves through fast.
const ratios = [];
for (const [pc, vn] of vice) {
  const ln = leg.get(pc) ?? 0;
  if (vn > 100 && vn > 5 * ln) {
    ratios.push({ pc, vn, ln, ratio: ln === 0 ? Infinity : vn / ln });
  }
}
ratios.sort((a, b) => b.vn - a.vn);
console.log(`\nPCs where vice spins LONGER than legacy (top 30; vice/legacy ratio >= 5):`);
for (const e of ratios.slice(0, 30)) {
  console.log(`  $${e.pc.toString(16).padStart(4,"0")}: vice=${e.vn} legacy=${e.ln} ratio=${e.ratio.toFixed(1)}x`);
}
