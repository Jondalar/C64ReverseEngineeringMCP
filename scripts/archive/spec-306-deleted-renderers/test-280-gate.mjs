#!/usr/bin/env node
// Spec 280 gate test — render LNR + MotM + MM ingame with vice-rasterized.
// Expected: visible game graphics matching VICE reference.

import { resolve as resolvePath, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);

const OUT_DIR = resolvePath(repoRoot, "samples/screenshots/spec-280-gate");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const PAL_HZ = 985248;

const TESTS = [
  { name: "motm-ingame-90s",  disk: "samples/motm.g64", waitSec: 90 },
  { name: "mm-character-60s",  disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64", waitSec: 60 },
  { name: "lnr-s1-90s",        disk: "samples/last_ninja_remix_s1[system3_1991].g64", waitSec: 90 },
];

for (const t of TESTS) {
  const diskPath = resolvePath(repoRoot, t.disk);
  if (!existsSync(diskPath)) {
    console.log(`SKIP ${t.name}: ${diskPath} missing`);
    continue;
  }
  console.log(`\n=== ${t.name} ===`);

  for (const renderer of ["per-char-row", "vice-rasterized"]) {
    const { session } = startIntegratedSession({
      diskPath, mode: "true-drive", useMicrocodedCpu: true,
      vicRenderer: renderer,
    });
    session.resetCold("pal-default");
    session.runFor(800_000);
    session.typeText('LOAD"*",8,1\r', 80_000, 80_000);
    for (let i = 0; i < 20; i++) session.runFor(50_000);

    const target = session.c64Cpu.cycles + t.waitSec * PAL_HZ;
    while (session.c64Cpu.cycles < target) session.runFor(50_000);

    const outPath = join(OUT_DIR, `${t.name}-${renderer}.png`);
    try {
      session.renderToPng(outPath);
      console.log(`  ${renderer.padEnd(15)} → ${outPath}`);
    } catch (e) {
      console.log(`  ${renderer.padEnd(15)} → ERROR: ${e.message}`);
    }
  }
}

console.log(`\nDone. Compare:`);
console.log(`  open ${OUT_DIR}`);
