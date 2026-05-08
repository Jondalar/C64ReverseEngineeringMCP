#!/usr/bin/env node
// Render boot + idle screenshots for all sample game disks.
// Captures: cold reset, ready, post-LOAD typed, mid-load checkpoints,
// final/idle frame.

import { existsSync, mkdirSync } from "node:fs";
import { resolve as resolvePath, join, basename } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

const GAMES = [
  { name: "motm", disk: "samples/motm.g64", maxSec: 180 },
  { name: "mm-s1", disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64", maxSec: 180 },
  { name: "im2", disk: "samples/impossible_mission_ii[epyx_1987](!).g64", maxSec: 180 },
  { name: "lnr-s1", disk: "samples/last_ninja_remix_s1[system3_1991].g64", maxSec: 180 },
];

const OUT_BASE = resolvePath(repoRoot, "samples/screenshots");
const PAL_HZ = 985248;

for (const game of GAMES) {
  const outDir = join(OUT_BASE, game.name);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  console.log(`\n=== ${game.name} ===`);
  const diskPath = resolvePath(repoRoot, game.disk);

  const { session } = startIntegratedSession({
    diskPath,
    mode: "true-drive",
    useMicrocodedCpu: true,
  });
  session.resetCold("pal-default");

  // Frame 0: cold
  session.renderToPng(join(outDir, "00-cold.png"));
  console.log(`  00-cold.png`);

  // Boot KERNAL ~0.8s → BASIC ready
  session.runFor(800_000);
  session.renderToPng(join(outDir, "01-ready.png"));
  console.log(`  01-ready.png  pc=$${session.c64Cpu.pc.toString(16)}`);

  // Type LOAD"*",8,1
  session.typeText('LOAD"*",8,1\r', 80_000, 80_000);
  // Wait for keystrokes to flush
  for (let i = 0; i < 20; i++) session.runFor(50_000);
  session.renderToPng(join(outDir, "02-load-typed.png"));
  console.log(`  02-load-typed.png  pc=$${session.c64Cpu.pc.toString(16)}`);

  // Periodic frames during boot
  let nextSec = 5;
  while (nextSec <= game.maxSec) {
    const target = session.c64Cpu.cycles + 5 * PAL_HZ;
    while (session.c64Cpu.cycles < target) session.runFor(50_000);
    const fname = `${nextSec.toString().padStart(3, "0")}s.png`;
    const path = join(outDir, fname);
    session.renderToPng(path);
    console.log(`  ${fname}  c64pc=$${session.c64Cpu.pc.toString(16)} drvpc=$${session.drive.cpu.pc.toString(16)} track=${session.headPosition.currentTrack}`);
    nextSec += 5;
  }

  // Final idle frame
  const finalPath = join(outDir, "FINAL-idle.png");
  session.renderToPng(finalPath);
  console.log(`  FINAL-idle.png`);
}

console.log(`\nDone. Output: ${OUT_BASE}/`);
