#!/usr/bin/env node
// Spec 611 phase 611.7f.22 — find first cycle where drive 6502 SP
// diverges vice vs legacy. Per 7f21: SP-diff is root cause; need to
// locate WHICH instruction first leaves stack imbalanced.

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

async function captureSP(drive1541) {
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

  // Sample SP every drive cycle into a sparse log: only when SP changes
  // or when PC crosses certain landmark addresses.
  const samples = [];
  let prevSp = cpu.reg_sp & 0xff;
  let prevPc = cpu.reg_pc & 0xffff;
  const origExec = cpu.executeCycle.bind(cpu);
  cpu.executeCycle = function () {
    const r = origExec();
    const sp = cpu.reg_sp & 0xff;
    const pc = cpu.reg_pc & 0xffff;
    // Record on SP change OR every 1000 cycles for sampling.
    if (sp !== prevSp) {
      if (samples.length < 5000) {
        samples.push({ clk: cpu.clk, pc, sp, prevSp, prevPc });
      }
      prevSp = sp;
    }
    prevPc = pc;
    return r;
  };

  session.resetCold("pal-default");
  // Just boot + run a bit past the first divergence cycle (~drvClk 8.58M).
  session.runFor(2_000_000);
  session.typeText('LOAD"$",8\r', 80_000, 80_000);
  const PAL_HZ = 985_248;
  const tgt = session.c64Cpu.cycles + 10 * PAL_HZ;
  while (session.c64Cpu.cycles < tgt) session.runFor(200_000);
  return samples;
}

console.log("Capturing drive SP samples on vice...");
const vice = await captureSP("vice");
console.log(`vice: ${vice.length} SP-change events captured`);

console.log("Capturing drive SP samples on legacy...");
const leg = await captureSP("legacy");
console.log(`legacy: ${leg.length} SP-change events captured`);

// Find first cycle where SP traces diverge.
console.log("");
console.log("=== SP divergence detection ===");
const n = Math.min(vice.length, leg.length);
let divergeAt = -1;
for (let i = 0; i < n; i++) {
  if (vice[i].sp !== leg[i].sp || vice[i].pc !== leg[i].pc) {
    divergeAt = i;
    break;
  }
}
console.log(`Total SP events compared: vice=${vice.length} legacy=${leg.length}`);

if (divergeAt >= 0) {
  console.log(`First divergent SP event = index ${divergeAt}`);
  console.log(`Context (5 before + 10 after):`);
  for (let i = Math.max(0, divergeAt - 5); i < Math.min(n, divergeAt + 10); i++) {
    const v = vice[i];
    const l = leg[i];
    const mark = i === divergeAt ? " ← FIRST DIFF" : "";
    console.log(`  #${i}  vice: clk=${v.clk} pc=$${v.pc.toString(16)} sp=$${v.sp.toString(16)} (was $${v.prevSp.toString(16)})  |  legacy: clk=${l.clk} pc=$${l.pc.toString(16)} sp=$${l.sp.toString(16)} (was $${l.prevSp.toString(16)})${mark}`);
  }
} else {
  console.log("No divergence in SP-change events.");
}
