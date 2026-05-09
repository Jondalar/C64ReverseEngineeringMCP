#!/usr/bin/env node
// Spec 298 — pixel diff: literal port vs vice-rasterized at same frame.
//
// Boots a session with useLiteralPortRenderer=true, runs to a known
// state, captures BOTH renderers' output, finds first divergent pixel.

import { resolve as resolvePath } from "node:path";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession } = await import(`${REPO}/dist/runtime/headless/integrated-session-manager.js`);

const args = process.argv.slice(2);
const scenario = args[0] || "ready";
const diskArg = args[1];

const sessionOpts = {
  diskPath: diskArg ? resolvePath(diskArg) : `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
  useLiteralPortRenderer: true,
};

console.log(`pixel diff: literal-port vs vice-rasterized — scenario=${scenario}`);

const { session: s } = startIntegratedSession(sessionOpts);
s.resetCold("pal-default");
s.runFor(5_000_000, { cycleBudget: 5_000_000 });

if (scenario === "motm" || scenario === "mm") {
  s.typeText('LOAD"*",8,1\r', 80_000, 80_000);
  let total = 0;
  while (total < 200_000_000) {
    s.runFor(3_000_000, { cycleBudget: 5_000_000 });
    total += 5_000_000;
  }
}

const outDir = `${REPO}/samples/screenshots/literal-port`;
mkdirSync(outDir, { recursive: true });
const pathLit = `${outDir}/${scenario}-diff-literal.png`;
const pathRast = `${outDir}/${scenario}-diff-rasterized.png`;
const r1 = s.renderToPng(pathLit, { renderer: "literal-port", frameAligned: false });
const r2 = s.renderToPng(pathRast, { renderer: "vice-rasterized", frameAligned: false });
console.log(`literal-port: ${r1.width}×${r1.height} (${r1.bytes}b)`);
console.log(`vice-rasterized: ${r2.width}×${r2.height} (${r2.bytes}b)`);

// Decode both PNGs to compare. Easier: compare via raw frame buffer
// access. literal-port FB is s.literalPortFb (520×312 color indices).
// vice-rasterized writes into s.framebuffer.pixels (RGBA, 504×312).

// Convert literal-port FB indices → RGBA at 504×312 cropped layout
// (= same coord system as framebuffer.pixels for direct compare)
const FB_W = 504;
const FB_H = 312;
const palette = s.framebuffer.palette;
// literal port FB is 520 wide; crop 8px from right to match 504
const litRgb = new Uint8Array(FB_W * FB_H * 3);
const litFb = s.literalPortFb;
for (let y = 0; y < FB_H; y++) {
  for (let x = 0; x < FB_W; x++) {
    const cIdx = litFb[y * 520 + x] & 0x0f;
    const [r, g, b] = palette[cIdx];
    const off = (y * FB_W + x) * 3;
    litRgb[off] = r;
    litRgb[off + 1] = g;
    litRgb[off + 2] = b;
  }
}

// vice-rasterized uses framebuffer.pixels = 504×312 RGBA
const rastFb = s.framebuffer.pixels;

// Diff with coord alignment.
// literal-port dbuf[0] = cycle 1 emit pixel 0. = cycle 17 emit → dbuf[128]
// vice-rasterized canvas[32] = first display pixel
// → literal FB[x+96] aligns with vice canvas[x]
const ALIGN_OFFSET = 104; // 96 + 8 (= maybe pipe shifted 1 char)
let firstDiff = null;
let diffCount = 0;
let sampleDiffs = [];
for (let y = 0; y < FB_H; y++) {
  for (let x = 0; x < FB_W - ALIGN_OFFSET; x++) {
    const litOff = (y * FB_W + (x + ALIGN_OFFSET)) * 3;
    const rastOff = (y * FB_W + x) * 4;
    const lr = litRgb[litOff], lg = litRgb[litOff+1], lb = litRgb[litOff+2];
    const rr = rastFb[rastOff], rg = rastFb[rastOff+1], rb = rastFb[rastOff+2];
    if (lr !== rr || lg !== rg || lb !== rb) {
      if (!firstDiff) firstDiff = { x, y, lit: [lr,lg,lb], rast: [rr,rg,rb] };
      diffCount++;
      if (sampleDiffs.length < 10) sampleDiffs.push({ x, y, lit: [lr,lg,lb], rast: [rr,rg,rb] });
    }
  }
}
console.log(`\nDiff stats:`);
console.log(`  total differing pixels: ${diffCount} / ${FB_W * FB_H} (${(diffCount/(FB_W*FB_H)*100).toFixed(2)}%)`);
console.log(`  first diff: ${firstDiff ? `(${firstDiff.x},${firstDiff.y}) lit=[${firstDiff.lit}] rast=[${firstDiff.rast}]` : "none"}`);
console.log(`  sample diffs:`);
for (const d of sampleDiffs) {
  console.log(`    (${d.x},${d.y}) lit=[${d.lit}] rast=[${d.rast}]`);
}
