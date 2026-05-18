#!/usr/bin/env node
// Spec 614.3 deep diag — drive PC trajectory during LOAD"$",8.
// Verifies whether per-cycle tick lets drive escape $E9C0 debpia
// (Spec 614 §1 mismatch 3 — stable-read failure mode).

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, "samples/synthetic/blank.d64");

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});

await mountMedia(session, 8, diskPath);
session.resetCold("pal-default");
session.runFor(2_000_000); // boot to READY

// Histograms keyed by drive PC bucket.
const pcHistogram = new Map();
const cpuPortHistogram = new Map();
let stableE9C0 = 0;
let trackEnabled = false;

const vice = session.kernel.drive1541;
const origTtc = vice.tickToClock.bind(vice);
let sampleEvery = 0;
vice.tickToClock = (clk) => {
  const r = origTtc(clk);
  if (trackEnabled && (++sampleEvery % 32 === 0)) {
    const probe = vice.debugProbe?.();
    if (probe) {
      const pcBucket = (probe.drive_pc >> 4) << 4;
      pcHistogram.set(pcBucket, (pcHistogram.get(pcBucket) ?? 0) + 1);
      if (probe.drive_pc >= 0xe9c0 && probe.drive_pc <= 0xe9d5) stableE9C0++;
    }
    const cpuPort = session.iecBus.core.cpu_port & 0xff;
    cpuPortHistogram.set(cpuPort, (cpuPortHistogram.get(cpuPort) ?? 0) + 1);
  }
  return r;
};

// Type LOAD"$",8.
trackEnabled = true;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 12 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);
trackEnabled = false;

const sortedPc = [...pcHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log("=== top 15 drive-PC buckets (sampled every 32 c64-cycles) ===");
for (const [pc, n] of sortedPc) {
  console.log(`  $${pc.toString(16).padStart(4, "0")} : ${n}`);
}
console.log(`stable in $E9C0-$E9D5 window: ${stableE9C0}`);
console.log(`c64 final PC: $${session.c64Cpu.pc.toString(16)}`);
console.log("=== cpu_port histogram top 5 ===");
const sortedCp = [...cpuPortHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
for (const [p, n] of sortedCp) {
  console.log(`  $${p.toString(16).padStart(2, "0")} : ${n}`);
}

const drvData8 = session.iecBus.core.drv_data[8] & 0xff;
console.log(`drv_data[8] = $${drvData8.toString(16)} (bit4 ATNA = ${(drvData8 & 0x10) ? "released/not-pulled" : "pulled/enabled"})`);
