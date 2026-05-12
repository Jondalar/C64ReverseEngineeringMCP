#!/usr/bin/env node
// Spec 140 v2 — diagnose drive $1800 read divergence between live
// mode and VICE-cache formula. Runs motm in LIVE mode (drive boots
// normally), but inspects every drive $1800 read and logs first N
// divergences between live result and vice formula.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[key] = true; }
      else { out[key] = v; i++; }
    }
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const id = args.id ?? "motm";
const cycleBudget = Number(args["cycle-budget"] ?? 10_000_000);
const maxDivergences = Number(args["max"] ?? 30);
const startCycle = Number(args["start-cycle"] ?? 0);  // skip diverged events before this

const manifest = JSON.parse(readFileSync(join(repoRoot, "samples/test-manifest.json"), "utf-8"));
const entry = manifest.entries.find((e) => e.id === id);
if (!entry) { console.error(`unknown id: ${id}`); process.exit(2); }
const diskPath = join(repoRoot, "samples", entry.file);
if (!existsSync(diskPath)) { console.error(`disk missing: ${diskPath}`); process.exit(2); }

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");

const { session } = startIntegratedSession({
  diskPath,
  useCycleLockstep: true,
  useMicrocodedCpu: true,
  iecMode: "live",  // drive boots via live mode; vice formula computed in parallel
});

const divergences = [];
session.iecBus.diagnoseReadDivergence = (info) => {
  if (divergences.length >= maxDivergences) return;
  if (session.scheduler.c64Cycle() < startCycle) return;
  divergences.push({
    cycle_c64: session.scheduler.c64Cycle(),
    cycle_drive: session.scheduler.driveCycle(),
    drivePc: session.drive.cpu.pc,
    prb: info.prb,
    ddrb: info.ddrb,
    liveByte: info.liveByte,
    viceByte: info.viceByte,
    drv_port: info.drv_port,
    cpu_bus: info.cpu_bus,
    drv_data_8: session.iecBus.core.drv_data[8],
    drv_bus_8: session.iecBus.core.drv_bus[8],
    cpu_port: session.iecBus.core.cpu_port,
  });
};

session.resetCold();

// Autoboot
if (session.scheduler) session.scheduler.runCycles(2_500_000);
session.typeText('LOAD"*",8,1\n');
if (session.scheduler) session.scheduler.runCycles(2_000_000);
session.typeText("RUN\n");

// Run cycles until budget or maxDivergences
let stepped = 0;
const chunk = 50_000;
while (stepped < cycleBudget && divergences.length < maxDivergences) {
  if (session.scheduler) session.scheduler.runCycles(chunk);
  stepped += chunk;
}

console.log(`Spec 140 v2 diagnostic — ${id}`);
console.log(`Total cycles run: ${session.scheduler.c64Cycle().toLocaleString()}`);
console.log(`Divergences: ${divergences.length}`);
console.log(``);
console.log(`First ${divergences.length} drive $1800 read divergences (live vs vice formula):`);
console.log(`cycle_c64    cycle_drv  drvPC orb  ddr  | live  vice  | drv_port cpu_bus drv_data8 drv_bus8 cpu_port`);
console.log(`-----------  ---------  ----- ---- ---- | ----  ----  | -------- ------- --------- -------- --------`);
for (const d of divergences) {
  const fmt = (n, w = 2) => "$" + (n & 0xff).toString(16).padStart(w, "0");
  console.log(
    `${d.cycle_c64.toString().padStart(11)}  ` +
    `${d.cycle_drive.toString().padStart(9)}  ` +
    `$${d.drivePc.toString(16).padStart(4, "0")} ` +
    `${fmt(d.prb)} ` +
    `${fmt(d.ddrb)} | ` +
    `${fmt(d.liveByte)}  ${fmt(d.viceByte)}  | ` +
    `${fmt(d.drv_port)}    ` +
    `${fmt(d.cpu_bus)}   ` +
    `${fmt(d.drv_data_8)}      ` +
    `${fmt(d.drv_bus_8)}     ` +
    `${fmt(d.cpu_port)}`
  );
}
