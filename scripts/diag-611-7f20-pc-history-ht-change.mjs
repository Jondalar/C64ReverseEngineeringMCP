#!/usr/bin/env node
// Spec 611 phase 611.7f.20 — PC history ring buffer around first HT
// change at $FA78 on both vice + legacy. Find ROM path that led to
// the STA $1C00 write that changed HT direction.

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
  let cpu, getHt, getZp;
  if (drive1541 === "vice") {
    const v = session.kernel.drive1541;
    cpu = v.driveCpu.cpu;
    getHt = () => v.diskunit.drives[0].currentHalfTrack;
    getZp = (a) => v.driveCpu.mem.read(a) & 0xff;
  } else {
    cpu = session.drive.cpu;
    getHt = () => session.headPosition.currentHalfTrack;
    getZp = (a) => session.drive.ram[a & 0x7ff] & 0xff;
  }

  // Ring buffer of (clk, pc) tuples.
  const ring = [];
  const RING_SIZE = 50;
  let captured = null;
  let prevHt = getHt();

  const origExec = cpu.executeCycle.bind(cpu);
  cpu.executeCycle = function () {
    if (captured) return origExec();
    const pc = cpu.reg_pc & 0xffff;
    ring.push({ clk: cpu.clk, pc });
    if (ring.length > RING_SIZE) ring.shift();
    const r = origExec();
    // Detect first HT change at $FA78 area during LOAD (skip boot phase).
    const ht = getHt();
    if (ht !== prevHt && session.c64Cpu.cycles > 8_000_000) {
      // capture FIRST stepper event during LOAD window
      captured = {
        clk: cpu.clk,
        pc: cpu.reg_pc & 0xffff,
        oldHt: prevHt,
        newHt: ht,
        ring: [...ring],
        zp00_30: Array.from({length: 0x30}, (_, i) => getZp(i)),
        zp40_70: Array.from({length: 0x30}, (_, i) => getZp(0x40 + i)),
      };
    }
    prevHt = ht;
    return r;
  };

  session.resetCold("pal-default");
  session.runFor(2_000_000);
  session.typeText('LOAD"$",8\r', 80_000, 80_000);
  const PAL_HZ = 985_248;
  const tgt = session.c64Cpu.cycles + 14 * PAL_HZ;
  while (session.c64Cpu.cycles < tgt && !captured) session.runFor(200_000);
  if (!captured) {
    // Run a bit more to ensure capture
    while (session.c64Cpu.cycles < tgt + 5 * PAL_HZ && !captured) session.runFor(200_000);
  }
  return captured;
}

console.log("Capturing FIRST HT change during LOAD on vice...");
const vice = await capture("vice");
console.log("Capturing FIRST HT change during LOAD on legacy...");
const leg = await capture("legacy");

function dump(label, c) {
  console.log("");
  console.log(`=== ${label} ===`);
  if (!c) { console.log("  (no capture)"); return; }
  console.log(`HT change: ${c.oldHt} → ${c.newHt} at drvClk=${c.clk} PC=$${c.pc.toString(16)}`);
  console.log(`Last 30 PCs leading to HT change:`);
  for (const r of c.ring.slice(-30)) {
    console.log(`  drvClk=${r.clk.toString().padStart(10)} PC=$${r.pc.toString(16).padStart(4,"0")}`);
  }
  console.log(`zp $00-$2F: ${c.zp00_30.map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
  console.log(`zp $40-$6F: ${c.zp40_70.map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
}

dump("VICE first-HT-change capture", vice);
dump("LEGACY first-HT-change capture", leg);

console.log("");
console.log("=== ZP DIFFS at HT-change moment ===");
if (vice && leg) {
  for (let i = 0; i < 0x30; i++) {
    if (vice.zp00_30[i] !== leg.zp00_30[i]) {
      console.log(`  zp $${i.toString(16).padStart(2,"0")}: vice=$${vice.zp00_30[i].toString(16).padStart(2,"0")} legacy=$${leg.zp00_30[i].toString(16).padStart(2,"0")}`);
    }
  }
  for (let i = 0; i < 0x30; i++) {
    if (vice.zp40_70[i] !== leg.zp40_70[i]) {
      console.log(`  zp $${(0x40+i).toString(16).padStart(2,"0")}: vice=$${vice.zp40_70[i].toString(16).padStart(2,"0")} legacy=$${leg.zp40_70[i].toString(16).padStart(2,"0")}`);
    }
  }
}
