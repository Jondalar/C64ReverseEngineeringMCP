#!/usr/bin/env node
// Find the c64-cycle window where drive clock jumps >> 1.015× c64.
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);

const vice = session.kernel.drive1541;
const drv = vice.unit;
function drvClk() { return (drv.clk_ptr.value >>> 0); }

// Sample c64 vs drive clock every 100K c64 cycles during LOAD window.
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 12 * PAL_HZ;
const samples = [];
let lastDrv = drvClk();
let lastC64 = session.c64Cpu.cycles;
while (session.c64Cpu.cycles < target) {
  session.runFor(50_000);
  const c64 = session.c64Cpu.cycles;
  const dr = drvClk();
  const dc64 = c64 - lastC64;
  const ddr = (dr - lastDrv) >>> 0;
  // Also check if dr wrapped (huge jump or negative).
  samples.push({ c64, dr, dc64, ddr, ratio: dc64 > 0 ? (ddr / dc64).toFixed(4) : "?" });
  lastDrv = dr;
  lastC64 = c64;
  // If ratio explodes, stop sampling early so output isn't flooded.
  if (samples.length > 5 && Number(samples[samples.length - 1].ratio) > 2) break;
}

console.log(`c64=${session.c64Cpu.cycles.toString().padStart(10)} | drv_clk=${drvClk().toString().padStart(11)}`);
console.log("");
console.log("idx | c64_cycles | drv_clk     | dc64    | d_drv      | ratio");
console.log("----+------------+-------------+---------+------------+-------");
for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  console.log(`${String(i).padStart(3)} | ${String(s.c64).padStart(10)} | ${String(s.dr).padStart(11)} | ${String(s.dc64).padStart(7)} | ${String(s.ddr).padStart(10)} | ${s.ratio}`);
}
