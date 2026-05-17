#!/usr/bin/env node
// Spec 611 phase 611.7f.23 — find where vice's drive cpu.clk first
// diverges from legacy's. 7f22 showed vice 4 cycles ahead at #2121.
// Trace from boot to find first instruction with skew.

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

async function capture(drive1541) {
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

  // Use 32-bit typed arrays for memory efficiency, sample every PC change up to large cap.
  const MAX = 600_000;
  const clks = new Uint32Array(MAX);
  const pcs = new Uint16Array(MAX);
  let idx = 0;
  let prevPc = cpu.reg_pc & 0xffff;
  const origExec = cpu.executeCycle.bind(cpu);
  cpu.executeCycle = function () {
    const r = origExec();
    const pc = cpu.reg_pc & 0xffff;
    if (pc !== prevPc && idx < MAX) {
      clks[idx] = cpu.clk;
      pcs[idx] = pc;
      idx++;
    }
    prevPc = pc;
    return r;
  };

  session.resetCold("pal-default");
  session.runFor(2_000_000);
  return { clks, pcs, count: idx };
}

console.log("Capturing instruction-boundary samples on vice + legacy (up to 600K each)...");
const vice = await capture("vice");
const leg = await capture("legacy");
console.log(`vice: ${vice.count} samples; legacy: ${leg.count} samples`);

const n = Math.min(vice.count, leg.count);
let firstClkDiff = -1;
let firstPcDiff = -1;
for (let i = 0; i < n; i++) {
  if (vice.clks[i] !== leg.clks[i] && firstClkDiff < 0) firstClkDiff = i;
  if (vice.pcs[i] !== leg.pcs[i] && firstPcDiff < 0) firstPcDiff = i;
}
console.log("");
console.log(`First clk divergence at sample #${firstClkDiff}`);
console.log(`First PC divergence at sample #${firstPcDiff}`);

const first = firstClkDiff >= 0 ? firstClkDiff : firstPcDiff;
if (first >= 0) {
  console.log("");
  console.log("Context (5 before + 10 after):");
  for (let i = Math.max(0, first - 5); i < Math.min(n, first + 10); i++) {
    const mark = i === first ? " ← FIRST DIFF" : "";
    console.log(`  #${i}  vice clk=${vice.clks[i]} pc=$${vice.pcs[i].toString(16)}  |  legacy clk=${leg.clks[i]} pc=$${leg.pcs[i].toString(16)}${mark}`);
  }
}
