#!/usr/bin/env node
// Spec 611 phase 611.7f.21 — find writer of drive zp $49.
// Per 7f20: $49 = $33 (vice) vs $35 (legacy) at first HT change.
// Trace writers on both paths to find divergence point.

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
  let cpu, readMem;
  if (drive1541 === "vice") {
    const v = session.kernel.drive1541;
    cpu = v.driveCpu.cpu;
    readMem = (a) => v.driveCpu.mem.read(a) & 0xff;
  } else {
    cpu = session.drive.cpu;
    const ram = session.drive.ram;
    readMem = (a) => ram[a & 0x7ff] & 0xff;
  }

  const writes = [];
  let prev49 = readMem(0x49);
  const origExec = cpu.executeCycle.bind(cpu);
  cpu.executeCycle = function () {
    const r = origExec();
    const v49 = readMem(0x49);
    if (v49 !== prev49 && writes.length < 600) {
      writes.push({
        t: session.c64Cpu.cycles,
        drvClk: cpu.clk,
        drvPc: cpu.reg_pc & 0xffff,
        oldVal: prev49,
        newVal: v49,
      });
      prev49 = v49;
    }
    return r;
  };

  session.resetCold("pal-default");
  session.runFor(2_000_000);
  session.typeText('LOAD"$",8\r', 80_000, 80_000);
  const PAL_HZ = 985_248;
  const tgt = session.c64Cpu.cycles + 14 * PAL_HZ;
  while (session.c64Cpu.cycles < tgt) session.runFor(200_000);
  return { writes, finalVal: readMem(0x49) };
}

console.log("Capturing zp $49 writes on vice...");
const vice = await capture("vice");
console.log(`vice: ${vice.writes.length} writes; final=$${vice.finalVal.toString(16)}`);

console.log("Capturing zp $49 writes on legacy...");
const leg = await capture("legacy");
console.log(`legacy: ${leg.writes.length} writes; final=$${leg.finalVal.toString(16)}`);

// Filter to writes outside the init loop (drvClk > 220000) - skip init phase.
function activeWrites(arr) { return arr.filter((w) => w.drvClk > 220000); }
const va = activeWrites(vice.writes);
const la = activeWrites(leg.writes);
console.log(`vice active writes (post-init): ${va.length}`);
console.log(`legacy active writes (post-init): ${la.length}`);

console.log("");
console.log("=== POST-INIT writes compare ===");
const n = Math.max(va.length, la.length);
for (let i = 0; i < Math.min(n, 80); i++) {
  const v = va[i];
  const l = la[i];
  const vs = v ? `${v.drvClk.toString().padStart(10)} $${v.drvPc.toString(16)} $${v.newVal.toString(16).padStart(2,"0")}` : "—";
  const ls = l ? `${l.drvClk.toString().padStart(10)} $${l.drvPc.toString(16)} $${l.newVal.toString(16).padStart(2,"0")}` : "—";
  const match = v && l && v.drvPc === l.drvPc && v.newVal === l.newVal;
  console.log(`${i.toString().padStart(3)} | ${vs.padEnd(25)} | ${ls.padEnd(25)} | ${match ? "✓" : "✗"}`);
}

// Find divergence in active writes
let divergeAt = -1;
for (let i = 0; i < Math.min(va.length, la.length); i++) {
  if (va[i].drvPc !== la[i].drvPc || va[i].newVal !== la[i].newVal) {
    divergeAt = i;
    break;
  }
}
console.log("");
if (divergeAt >= 0) {
  console.log(`FIRST POST-INIT DIVERGENCE at active write #${divergeAt}:`);
  console.log(`  vice:   drvClk=${va[divergeAt].drvClk} PC=$${va[divergeAt].drvPc.toString(16)} $49 ← $${va[divergeAt].newVal.toString(16)}`);
  console.log(`  legacy: drvClk=${la[divergeAt].drvClk} PC=$${la[divergeAt].drvPc.toString(16)} $49 ← $${la[divergeAt].newVal.toString(16)}`);
} else {
  console.log("No divergence in active writes.");
}
