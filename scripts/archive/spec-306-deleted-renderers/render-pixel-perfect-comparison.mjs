#!/usr/bin/env node
// Spec 262 Phase B-E — render game title screens with both renderers
// for visual comparison.
//
// Output: samples/screenshots/pixel-perfect/<game>-{charrow,pixel}.png

import { resolve as resolvePath, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);

const GAMES = [
  { name: "motm", disk: "samples/motm.g64", waitSec: 45 },
  { name: "mm-s1", disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64", waitSec: 60 },
  { name: "im2", disk: "samples/impossible_mission_ii[epyx_1987](!).g64", waitSec: 60 },
  { name: "lnr-s1", disk: "samples/last_ninja_remix_s1[system3_1991].g64", waitSec: 60 },
];

const OUT_DIR = resolvePath(repoRoot, "samples/screenshots/pixel-perfect");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const PAL_HZ = 985248;

for (const game of GAMES) {
  const diskPath = resolvePath(repoRoot, game.disk);
  if (!existsSync(diskPath)) {
    console.log(`SKIP ${game.name}: ${diskPath} missing`);
    continue;
  }
  console.log(`\n=== ${game.name} ===`);

  for (const renderer of ["per-char-row", "per-pixel"]) {
    const { session } = startIntegratedSession({
      diskPath,
      mode: "true-drive",
      useMicrocodedCpu: true,
      vicRenderer: renderer,
    });
    session.resetCold("pal-default");

    // Boot + LOAD"*",8,1 + RUN
    session.runFor(800_000);
    session.typeText('LOAD"*",8,1\r', 80_000, 80_000);
    for (let i = 0; i < 20; i++) session.runFor(50_000);

    // Wait for game title to appear
    const target = session.c64Cpu.cycles + game.waitSec * PAL_HZ;
    while (session.c64Cpu.cycles < target) session.runFor(50_000);

    const outPath = join(OUT_DIR, `${game.name}-${renderer.replace("per-", "")}.png`);
    session.renderToPng(outPath);
    console.log(`  ${renderer.padEnd(13)} → ${outPath}`);
  }
}

console.log(`\nDone. Compare side-by-side:`);
console.log(`  open ${OUT_DIR}`);
