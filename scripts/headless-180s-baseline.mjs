#!/usr/bin/env node
// V2 1541-silicon prep — headless equivalent of vice-180s-baseline.mjs.
// Captures same shape of trace per game so they can be diff'd 1:1.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { startIntegratedSession } from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/integrated-session-manager.js";

const SAMPLES_ROOT = resolvePath("samples/traces/v2-baseline");

const games = [
  { id: "mm-s1",  disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64" },
  { id: "im2",    disk: "samples/impossible_mission_ii[epyx_1987](!).g64" },
  { id: "lnr-s1", disk: "samples/last_ninja_remix_s1[system3_1991].g64" },
  { id: "motm",   disk: "samples/motm.g64" },
  { id: "polarbear", disk: "samples/POLARBEAR.d64" },
];

const RUN_SEC_EMULATED = Number(process.env.RUN_SEC ?? 180);
const CYCLES_PER_SAMPLE = 200_000;
const PAL_CYCLES_PER_SEC = 985_248;
const TARGET_CYCLES = RUN_SEC_EMULATED * PAL_CYCLES_PER_SEC;

async function runGame(g) {
  const outDir = resolvePath(SAMPLES_ROOT, g.id);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  const { session } = startIntegratedSession({
    diskPath: resolvePath(g.disk),
    mode: "true-drive",
  });
  session.resetCold("pal-default");
  // Boot sequence: standard LOAD"*",8,1<RET> for all (mm-s1 uses BOOT
  // but also responds to *).
  session.runFor(800_000);
  session.typeText('LOAD"*",8,1\r', 80_000, 80_000);

  const samples = [];
  const driveRamSnaps = []; // [{ ts, bytes(hex of $0370-$0380) }]
  const ram = session.c64Bus.ram;
  const drvRam = session.drive.bus.ram;
  const c64Cpu = session.c64Cpu;
  const drvCpu = session.drive.cpu;
  let firstEoiAt = -1;
  let nextSampleCyc = CYCLES_PER_SAMPLE;
  const SNAP_EVERY = 1_000_000;
  let nextSnapCyc = SNAP_EVERY;
  while (c64Cpu.cycles < TARGET_CYCLES) {
    session.runFor(50_000);  // batch run
    if (c64Cpu.cycles >= nextSampleCyc) {
      const z90 = ram[0x90];
      const dd00 = ram[0xdd00] ?? 0;
      const drvPb = drvRam[0x1800 - 0x1800 + 0x00] ?? 0; // mirrored at $1800
      // VIA1 PB at drive bus is via1.read(1) — actual register state.
      const drvPbActual = session.drive.bus.via1.read(1);
      samples.push({
        ts: c64Cpu.cycles,
        c64Pc: c64Cpu.pc,
        drvPc: drvCpu.pc,
        c64A: c64Cpu.a,
        drvA: drvCpu.a,
        z90, dd00,
        drvPb: drvPbActual,
      });
      if (firstEoiAt < 0 && (z90 & 0x40) !== 0) firstEoiAt = c64Cpu.cycles;
      nextSampleCyc += CYCLES_PER_SAMPLE;
    }
    if (c64Cpu.cycles >= nextSnapCyc) {
      const drvSlice = Array.from(drvRam.subarray(0x0370, 0x0380));
      const c64Slice = Array.from(ram.subarray(0x4200, 0x4400));
      driveRamSnaps.push({
        ts: c64Cpu.cycles,
        c64Pc: c64Cpu.pc,
        drvPc: drvCpu.pc,
        drv_0370: drvSlice.map((b) => b.toString(16).padStart(2, "0")).join(" "),
        c64_4200_hash: c64Slice.reduce((a, b) => (a * 31 + b) >>> 0, 0).toString(16),
      });
      nextSnapCyc += SNAP_EVERY;
    }
  }
  const dtMs = Date.now() - t0;

  writeFileSync(resolvePath(outDir, "headless-trace.jsonl"),
    samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(resolvePath(outDir, "headless-drive-ram-snaps.jsonl"),
    driveRamSnaps.map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(resolvePath(outDir, "headless-drive-ram.bin"), drvRam.subarray(0, 0x800));
  writeFileSync(resolvePath(outDir, "headless-summary.json"), JSON.stringify({
    game: g.id, disk: g.disk, runSecEmulated: RUN_SEC_EMULATED,
    samples: samples.length, dtMs, firstEoiAt,
    finalC64Pc: c64Cpu.pc, finalDrvPc: drvCpu.pc,
    capturedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`[${g.id}] headless: ${samples.length} samples ${dtMs}ms firstEoi=${firstEoiAt} finalC64Pc=$${c64Cpu.pc.toString(16)} finalDrvPc=$${drvCpu.pc.toString(16)}`);
}

const filter = process.argv[2];
const targets = filter ? games.filter((g) => g.id === filter) : games;
for (const g of targets) {
  await runGame(g);
}
console.log("ALL DONE");
