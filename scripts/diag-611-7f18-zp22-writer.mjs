#!/usr/bin/env node
// Spec 611 phase 611.7f.18 — find writer of drive zp $22 (current_track).
// Compare vice vs legacy: who writes $22, when, what value.

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

  let cpu, readMem, ram;
  if (drive1541 === "vice") {
    const v = session.kernel.drive1541;
    cpu = v.driveCpu.cpu;
    readMem = (a) => v.driveCpu.mem.read(a) & 0xff;
    ram = null; // vice path uses mem.read; we can't easily intercept writes
  } else {
    cpu = session.drive.cpu;
    ram = session.drive.ram;
    readMem = (a) => ram[a & 0x7ff] & 0xff;
  }

  const writes22 = [];
  let prev22 = readMem(0x22);
  const origExec = cpu.executeCycle.bind(cpu);
  cpu.executeCycle = function () {
    const r = origExec();
    const v22 = readMem(0x22);
    if (v22 !== prev22 && writes22.length < 300) {
      writes22.push({
        t: session.c64Cpu.cycles,
        drvClk: cpu.clk,
        drvPc: cpu.reg_pc & 0xffff,
        oldVal: prev22,
        newVal: v22,
      });
      prev22 = v22;
    }
    return r;
  };

  session.resetCold("pal-default");
  session.runFor(2_000_000);
  session.typeText('LOAD"$",8\r', 80_000, 80_000);
  const PAL_HZ = 985_248;
  const tgt = session.c64Cpu.cycles + 14 * PAL_HZ;
  while (session.c64Cpu.cycles < tgt) session.runFor(200_000);
  return { writes22, finalVal: readMem(0x22) };
}

console.log("Capturing zp $22 writes on vice1541...");
const vice = await capture("vice");
console.log(`vice: ${vice.writes22.length} writes to $22; final = $${vice.finalVal.toString(16)}`);
console.log(`LAST 25 vice writes to $22:`);
for (const w of vice.writes22.slice(-25)) {
  console.log(`  t=${w.t} drvClk=${w.drvClk} drvPc=$${w.drvPc.toString(16)}  $22: $${w.oldVal.toString(16)} → $${w.newVal.toString(16)}`);
}

console.log("");
console.log("Capturing zp $22 writes on legacy...");
const leg = await capture("legacy");
console.log(`legacy: ${leg.writes22.length} writes to $22; final = $${leg.finalVal.toString(16)}`);
console.log(`LAST 25 legacy writes to $22:`);
for (const w of leg.writes22.slice(-25)) {
  console.log(`  t=${w.t} drvClk=${w.drvClk} drvPc=$${w.drvPc.toString(16)}  $22: $${w.oldVal.toString(16)} → $${w.newVal.toString(16)}`);
}
