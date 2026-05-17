#!/usr/bin/env node
// Spec 611 phase 611.7f.15 — LEGACY1541 stepper trace for compare.
//
// Same LOAD"$",8 scenario but drive1541=legacy. Capture HT progression
// vs the vice1541 7f14 trace. Per Codex 06:32 condition: now allowed
// because IEC protocol confirmed OK on both paths; divergence on
// drive-side proven.
//
// Read-only.

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

// LEGACY path (drive1541="legacy" = default).
const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  // drive1541 omitted → legacy default
});

await mountMedia(session, 8, diskPath);

// Legacy drive object is at session.drive (not drive1541).
const drive = session.drive;
const driveCpu = drive; // legacy: drive object IS the cpu wrapper
const cpu = drive.cpu;
const headPos = session.headPosition;

console.log(`=== LEGACY initial state ===`);
console.log(`headPosition.currentHalfTrack: ${headPos.currentHalfTrack}`);
console.log(`headPosition.maxHalfTracks:    ${headPos.maxHalfTracks}`);
console.log("");

// Spy via cpu.executeCycle to detect HT changes.
const htChanges = [];
let prevHt = headPos.currentHalfTrack;
const origExec = cpu.executeCycle?.bind(cpu) ?? null;
if (origExec) {
  cpu.executeCycle = function () {
    const r = origExec();
    if (headPos.currentHalfTrack !== prevHt) {
      if (htChanges.length < 50) {
        htChanges.push({
          t: session.c64Cpu.cycles,
          drvClk: cpu.clk,
          drvPc: cpu.reg_pc & 0xffff,
          oldHt: prevHt,
          newHt: headPos.currentHalfTrack,
        });
      }
      prevHt = headPos.currentHalfTrack;
    }
    return r;
  };
} else {
  console.log("WARN: legacy drive cpu.executeCycle hook not available");
}

session.resetCold("pal-default");
session.runFor(2_000_000);
console.log(`=== POST-BOOT (2M c64 cyc) LEGACY HT = ${headPos.currentHalfTrack} ===`);

session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 14 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

console.log("");
console.log(`=== LEGACY FINAL HT = ${headPos.currentHalfTrack} ===`);
console.log("");
console.log(`=== LEGACY HT change events (max 50) ===`);
console.log("t           drvClk    drvPc   HT change");
for (const c of htChanges) {
  console.log(`${c.t.toString().padStart(10)}  ${c.drvClk.toString().padStart(10)} $${c.drvPc.toString(16).padStart(4,"0")}  ${c.oldHt} → ${c.newHt}`);
}
console.log(`Total HT changes: ${htChanges.length}`);

console.log("");
console.log("=== COMPARISON ===");
console.log(`vice1541 final HT (7f14): 38 (= track 19, WRONG)`);
console.log(`legacy   final HT:        ${headPos.currentHalfTrack}`);
console.log(`Target HT for track 18:   36`);
const equal = headPos.currentHalfTrack === 36;
console.log(`Legacy reaches track 18:  ${equal ? "YES (= GREEN gate proves it)" : "NO ("+headPos.currentHalfTrack+")"}`);
