#!/usr/bin/env node
// Spec 611 phase 611.7f.17 — drive zp compare at $F98A entry.
//
// vice1541 vs LEGACY1541 same scenario (LOAD"$",8 + blank.d64).
// Captures full drive zp $00-$7F snapshot at the moment drive PC
// hits $F98A (= seek-step routine start). Compare to find input
// state divergence.

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
if (!existsSync(diskPath)) { console.error("missing", diskPath); process.exit(1); }

async function capture(drive1541) {
  const { session } = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    ...(drive1541 === "vice" ? { drive1541: "vice" } : {}),
  });

  await mountMedia(session, 8, diskPath);

  // Get drive cpu + mem refs (different paths legacy vs vice).
  let cpu, readMem;
  if (drive1541 === "vice") {
    const v = session.kernel.drive1541;
    cpu = v.driveCpu.cpu;
    readMem = (addr) => v.driveCpu.mem.read(addr) & 0xff;
  } else {
    cpu = session.drive.cpu;
    const ram = session.drive.ram;
    readMem = (addr) => ram[addr & 0x7ff] & 0xff;  // legacy: 2KB drive RAM, mirror via mask
  }

  const snaps = [];
  const origExec = cpu.executeCycle?.bind(cpu);
  if (!origExec) return null;
  cpu.executeCycle = function () {
    const r = origExec();
    const pc = cpu.reg_pc & 0xffff;
    if ((pc === 0xf98a || pc === 0xfa78 || pc === 0xfa63)
        && snaps.length < 10
        && (snaps.length === 0 || snaps[snaps.length - 1].pc !== pc
            || cpu.clk - snaps[snaps.length - 1].clk > 100)) {
      const zp = new Uint8Array(128);
      for (let i = 0; i < 128; i++) zp[i] = readMem(i);
      snaps.push({ t: session.c64Cpu.cycles, clk: cpu.clk, pc, zp });
    }
    return r;
  };

  session.resetCold("pal-default");
  session.runFor(2_000_000);
  session.typeText('LOAD"$",8\r', 80_000, 80_000);
  const PAL_HZ = 985_248;
  const target = session.c64Cpu.cycles + 14 * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(200_000);
  return snaps;
}

console.log("Capturing vice1541 zp snapshots at $F98A/$FA63/$FA78 entry...");
const viceSnaps = await capture("vice");
console.log(`vice1541 captured ${viceSnaps?.length ?? 0} snaps`);

console.log("Capturing LEGACY zp snapshots at $F98A/$FA63/$FA78 entry...");
const legSnaps = await capture("legacy");
console.log(`legacy captured ${legSnaps?.length ?? 0} snaps`);

console.log("");
console.log("=== VICE snapshots ===");
for (const s of viceSnaps ?? []) {
  console.log(`t=${s.t} drvClk=${s.clk} PC=$${s.pc.toString(16)}`);
  console.log(`  $00-$1F: ${[...s.zp.slice(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  console.log(`  $20-$3F: ${[...s.zp.slice(0x20, 0x40)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  console.log(`  $40-$5F: ${[...s.zp.slice(0x40, 0x60)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  console.log(`  $60-$7F: ${[...s.zp.slice(0x60, 0x80)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
}

console.log("");
console.log("=== LEGACY snapshots ===");
for (const s of legSnaps ?? []) {
  console.log(`t=${s.t} drvClk=${s.clk} PC=$${s.pc.toString(16)}`);
  console.log(`  $00-$1F: ${[...s.zp.slice(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  console.log(`  $20-$3F: ${[...s.zp.slice(0x20, 0x40)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  console.log(`  $40-$5F: ${[...s.zp.slice(0x40, 0x60)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  console.log(`  $60-$7F: ${[...s.zp.slice(0x60, 0x80)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
}

console.log("");
console.log("=== DIFFS at matching PCs (first per PC) ===");
const seenPcs = new Set();
for (const v of viceSnaps ?? []) {
  if (seenPcs.has(v.pc)) continue;
  seenPcs.add(v.pc);
  const l = (legSnaps ?? []).find((s) => s.pc === v.pc);
  if (!l) {
    console.log(`PC=$${v.pc.toString(16)}: NO LEGACY MATCH`);
    continue;
  }
  console.log(`PC=$${v.pc.toString(16)}: vice@t=${v.t} legacy@t=${l.t}`);
  for (let i = 0; i < 128; i++) {
    if (v.zp[i] !== l.zp[i]) {
      console.log(`  zp $${i.toString(16).padStart(2,"0")}: vice=$${v.zp[i].toString(16).padStart(2,"0")} legacy=$${l.zp[i].toString(16).padStart(2,"0")}`);
    }
  }
}
