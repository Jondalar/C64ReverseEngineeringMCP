#!/usr/bin/env node
// Spec 611 phase 611.7f.25 — IRQ source spy. Count all IRQ assertions
// up to drvClk 1.5M. Identify which IRQ source differs vice vs legacy.

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

  let cpuIntStatus;
  if (drive1541 === "vice") {
    cpuIntStatus = session.kernel.drive1541.driveCpu.cpu.cpuIntStatus;
  } else {
    cpuIntStatus = session.drive.cpu.cpuIntStatus;
  }

  const irqEvents = [];
  const origSetIrq = cpuIntStatus.setIrq.bind(cpuIntStatus);
  cpuIntStatus.setIrq = (intNum, asserted, clk) => {
    if (irqEvents.length < 200) {
      irqEvents.push({ intNum, asserted, clk, hostClk: session.c64Cpu.cycles });
    }
    return origSetIrq(intNum, asserted, clk);
  };

  session.resetCold("pal-default");
  session.runFor(2_000_000);
  return irqEvents;
}

console.log("Capturing IRQ events on vice...");
const vice = await capture("vice");
console.log(`vice: ${vice.length} IRQ events (cap=200)`);

console.log("Capturing IRQ events on legacy...");
const leg = await capture("legacy");
console.log(`legacy: ${leg.length} IRQ events`);

// Filter to events with clk < 1.1M (= around divergence window).
function fmt(arr) {
  return arr.filter((e) => e.clk < 1_200_000).map((e) =>
    `clk=${e.clk.toString().padStart(10)} int#${e.intNum} ${e.asserted ? "ON " : "off"}`,
  );
}
const viceF = fmt(vice);
const legF = fmt(leg);
console.log("");
console.log(`vice events at clk<1.2M: ${viceF.length}`);
console.log(`legacy events at clk<1.2M: ${legF.length}`);

console.log("");
console.log("=== Side-by-side (max 40) ===");
const n = Math.max(viceF.length, legF.length);
for (let i = 0; i < Math.min(n, 40); i++) {
  const v = viceF[i] ?? "—";
  const l = legF[i] ?? "—";
  const match = v === l;
  console.log(`${i.toString().padStart(3)} | ${v.padEnd(45)} | ${l.padEnd(45)} | ${match ? "✓" : "✗"}`);
}

// First divergence
let div = -1;
for (let i = 0; i < Math.min(viceF.length, legF.length); i++) {
  if (viceF[i] !== legF[i]) { div = i; break; }
}
console.log("");
if (div >= 0) console.log(`FIRST DIVERGENCE at IRQ event #${div}`);
else console.log("No divergence in first IRQ events.");
