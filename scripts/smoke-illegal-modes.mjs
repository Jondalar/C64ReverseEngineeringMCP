#!/usr/bin/env node
// Spec 284 Phase 284c — illegal video modes 5/6/7 smoke.
//
// Per OQ4 = (a) + (c): synthetic per-mode verification + regression
// safety net.
//
// Synthetic test: programmatically set $D011/$D016 in the live VIC
// reg file to force modes 5/6/7, render frame, verify gfx region
// pixels are palette[0] (= absolute black, RGB 0,0,0).
//
// mc-mask-table: standalone unit test (= bit pattern correctness).

import { resolve as resolvePath } from "node:path";
const REPO = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`
);
const { mcMask, MC_MASK_TABLE } = await import(
  `${REPO}/dist/runtime/headless/vic/mc-mask-table.js`
);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 284 illegal modes smoke ===\n");

// 1. mc-mask-table correctness.
// Formula: mcmsktable[i] = (i & 0xaa) | ((i & 0xaa) >> 1)
// For i=0xff (all bits set): (0xff & 0xaa) | ((0xff & 0xaa) >> 1)
//                          = 0xaa | 0x55 = 0xff
check("mcMask(0x00) = 0", mcMask(0x00) === 0x00);
check("mcMask(0xff) = 0xff", mcMask(0xff) === 0xff);
check("mcMask(0xaa) = 0xff (10101010 → 11111111)",
  mcMask(0xaa) === 0xff, `got=${mcMask(0xaa).toString(16)}`);
check("mcMask(0x55) = 0 (01010101 → 00000000, no even bits set)",
  mcMask(0x55) === 0x00);
check("MC_MASK_TABLE has 256 entries", MC_MASK_TABLE.length === 256);

// 2. Synthetic mode 5 (illegal text): set $D011 ECM=1, $D016 MCM=1.
// Render → verify visible pixels = (0,0,0).
async function renderInMode(modeBits) {
  const { session } = startIntegratedSession({
    diskPath: resolvePath(REPO, "samples/motm.g64"),
    mode: "true-drive", useMicrocodedCpu: true,
    vicRenderer: "vice-rasterized",
  });
  session.resetCold("pal-default");
  session.runFor(5_000_000, { cycleBudget: 5_000_000 });
  // Force the VIC into the illegal mode by patching regs directly.
  // mode bits: bit2=ECM bit1=BMM bit0=MCM.
  // $D011: bit 6=ECM, bit 5=BMM, bit 4=DEN (keep on).
  const ecm = (modeBits & 4) ? 1 : 0;
  const bmm = (modeBits & 2) ? 1 : 0;
  const mcm = (modeBits & 1) ? 1 : 0;
  const d011 = (session.vic.regs[0x11] & 0x9f) | (ecm << 6) | (bmm << 5);
  const d016 = (session.vic.regs[0x16] & 0xef) | (mcm << 4);
  session.vic.regs[0x11] = d011;
  session.vic.regs[0x16] = d016;
  session.renderFrame();
  return session.framebuffer;
}

function pixelAt(fb, x, y) {
  const off = (y * fb.width + x) * 4;
  return [fb.pixels[off], fb.pixels[off + 1], fb.pixels[off + 2]];
}

for (const mode of [5, 6, 7]) {
  const fb = await renderInMode(mode);
  // Sample 4 random gfx pixels (display zone, not border).
  const points = [[40, 100], [180, 150], [340, 200], [200, 180]];
  let allBlack = true;
  let firstNonBlack = null;
  for (const [x, y] of points) {
    const p = pixelAt(fb, x, y);
    if (p[0] !== 0 || p[1] !== 0 || p[2] !== 0) {
      allBlack = false;
      if (!firstNonBlack) firstNonBlack = `(${x},${y})=rgb(${p.join(",")})`;
    }
  }
  check(`mode ${mode} gfx pixels = palette[0] (black)`, allBlack,
    firstNonBlack ?? "all sampled pixels black");
}

// 3. Regression: legal modes (0..4) still render normally.
// Mode 0 standard text — BASIC ready should look colored, NOT all black.
const fbLegal = await renderInMode(0);
let legalHasColor = false;
for (let y = 60; y < 180; y += 10) {
  for (let x = 40; x < 360; x += 30) {
    const p = pixelAt(fbLegal, x, y);
    if (p[0] !== 0 || p[1] !== 0 || p[2] !== 0) { legalHasColor = true; break; }
  }
  if (legalHasColor) break;
}
check("mode 0 (legal text) NOT all black (= legal modes unaffected)",
  legalHasColor);

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
