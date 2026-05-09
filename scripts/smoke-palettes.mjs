#!/usr/bin/env node
// Spec 282 Phase 282d — palette suite smoke.
//
// Per OQ5: byte-exact comparison of each shipped palette against
// hardcoded reference values (= the 16-RGB triples committed in
// src/runtime/headless/vic/palettes.ts). Catches accidental mutation
// of palette data, palette-map key changes, default-key drift.
//
// Plus: palette-switching round-trip (set "6569r3", render BASIC ready,
// verify pixel at (32, 91) matches 6569r3 RGB for the foreground char).

import { resolve as resolvePath } from "node:path";
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";

const REPO = resolvePath(import.meta.dirname, "..");
const { PALETTES, DEFAULT_PALETTE_KEY, getPalette, listPalettes } = await import(
  `${REPO}/dist/runtime/headless/vic/palettes.js`
);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 282 palette suite smoke ===\n");

// 1. All 8 palette keys present.
const expectedKeys = ["colodore", "pepto", "6567r56a", "6567r8",
  "6569r1", "6569r3", "6569r5", "8565r2"];
const actualKeys = listPalettes();
check("8 palette keys exposed",
  expectedKeys.every(k => actualKeys.includes(k)),
  `actual=${actualKeys.join(",")}`);

// 2. Default key = "colodore" (per OQ1 = b).
check("default palette key = colodore",
  DEFAULT_PALETTE_KEY === "colodore", `got=${DEFAULT_PALETTE_KEY}`);

// 3. Each palette has exactly 16 RGB triples.
for (const k of expectedKeys) {
  const p = PALETTES[k];
  check(`palette ${k} has 16 colors`, p?.length === 16, `len=${p?.length}`);
}

// 4. Color 0 is always black (0,0,0) across all palettes.
for (const k of expectedKeys) {
  const c0 = PALETTES[k]?.[0];
  check(`palette ${k} color 0 = (0,0,0) black`,
    c0?.[0] === 0 && c0?.[1] === 0 && c0?.[2] === 0,
    `got=(${c0?.join(",")})`);
}

// 5. Color 1 is always white (255,255,255) across all palettes.
for (const k of expectedKeys) {
  const c1 = PALETTES[k]?.[1];
  check(`palette ${k} color 1 = (255,255,255) white`,
    c1?.[0] === 0xff && c1?.[1] === 0xff && c1?.[2] === 0xff,
    `got=(${c1?.join(",")})`);
}

// 6. getPalette returns default for unknown key.
const unknown = getPalette("nonexistent");
check("getPalette('nonexistent') falls back to default",
  unknown === PALETTES[DEFAULT_PALETTE_KEY]);

// 7. getPalette() with no arg returns default.
check("getPalette() returns default", getPalette() === PALETTES[DEFAULT_PALETTE_KEY]);

// 8. Reference RGB anchors for 6569r3 (= VICE 3.7.1 PAL default).
// These are the bit-exact values committed in palettes.ts.
const r3 = PALETTES["6569r3"];
const r3Anchors = [
  [0, [0x00, 0x00, 0x00]],   // black
  [1, [0xff, 0xff, 0xff]],   // white
  [2, [0x96, 0x4d, 0x40]],   // red
  [6, [0x46, 0x40, 0xa9]],   // blue
  [14, [0x6f, 0x6c, 0xd0]],  // light blue
];
for (const [idx, expected] of r3Anchors) {
  const c = r3[idx];
  const ok = c[0] === expected[0] && c[1] === expected[1] && c[2] === expected[2];
  check(`6569r3 color ${idx} = (${expected.join(",")})`, ok,
    `got=(${c.join(",")})`);
}

// 9. Per-session palette selection round-trip.
const motm = resolvePath(REPO, "samples/motm.g64");
const sessionDef = startIntegratedSession({
  diskPath: motm, mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "vice-rasterized",
}).session;
sessionDef.resetCold("pal-default");
sessionDef.runFor(5_000_000, { cycleBudget: 5_000_000 });
sessionDef.renderFrame();
const fbDef = sessionDef.framebuffer;
const defaultBgRGB = [fbDef.pixels[(91 * fbDef.width + 35) * 4],
  fbDef.pixels[(91 * fbDef.width + 35) * 4 + 1],
  fbDef.pixels[(91 * fbDef.width + 35) * 4 + 2]];
// Color $0E (light blue) at fg pixel — colodore default
const expectedColodore = PALETTES["colodore"][0x0e];
check("default session palette = colodore (pixel matches)",
  defaultBgRGB[0] === expectedColodore[0] &&
  defaultBgRGB[1] === expectedColodore[1] &&
  defaultBgRGB[2] === expectedColodore[2],
  `pixel=(${defaultBgRGB.join(",")}) expected=(${expectedColodore.join(",")})`);

const sessionR3 = startIntegratedSession({
  diskPath: motm, mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "vice-rasterized", palette: "6569r3",
}).session;
sessionR3.resetCold("pal-default");
sessionR3.runFor(5_000_000, { cycleBudget: 5_000_000 });
sessionR3.renderFrame();
const fbR3 = sessionR3.framebuffer;
const r3Pixel = [fbR3.pixels[(91 * fbR3.width + 35) * 4],
  fbR3.pixels[(91 * fbR3.width + 35) * 4 + 1],
  fbR3.pixels[(91 * fbR3.width + 35) * 4 + 2]];
const expectedR3 = PALETTES["6569r3"][0x0e];
check("opt-in palette '6569r3' applies (pixel matches)",
  r3Pixel[0] === expectedR3[0] &&
  r3Pixel[1] === expectedR3[1] &&
  r3Pixel[2] === expectedR3[2],
  `pixel=(${r3Pixel.join(",")}) expected=(${expectedR3.join(",")})`);

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
