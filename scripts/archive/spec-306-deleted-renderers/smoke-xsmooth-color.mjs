#!/usr/bin/env node
// Spec 285 — xsmooth-color border band smoke.
// Programmatically set xsmooth in $D016 and verify L-edge of gfx
// window picks up xsmooth_color (= bg in std text) instead of
// border color.

import { resolve as resolvePath } from "node:path";
const REPO = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`
);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 285 xsmooth-color band smoke ===\n");

const { session } = startIntegratedSession({
  diskPath: resolvePath(REPO, "samples/motm.g64"),
  mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "vice-rasterized",
});
session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });

// Force $D016 xsmooth = 4. Note: high bits include CSEL=1 + MCM=0.
session.vic.regs[0x16] = (session.vic.regs[0x16] & 0xf8) | 4;
session.renderFrame();

const fb = session.framebuffer;
function pixelAt(x, y) {
  const off = (y * fb.width + x) * 4;
  return [fb.pixels[off], fb.pixels[off + 1], fb.pixels[off + 2]];
}

// Line 91 = first display line in row 5. Border band ends at pixel 31.
// xsmooth=4 → pixels 28..31 should be xsmooth_color (= bg = $06 = blue
// = colodore (46,44,155)). Pixels 0..27 = border = $0E = light blue
// (colodore (112,109,235)).
const borderPx = pixelAt(20, 91);
const xsmoothPx = pixelAt(30, 91);

const COLODORE_BLUE = [46, 44, 155];        // $06 bg
const COLODORE_LIGHTBLUE = [112, 109, 235]; // $0E border

check("border zone (x=20) = light blue (border color)",
  borderPx[0] === COLODORE_LIGHTBLUE[0]
  && borderPx[1] === COLODORE_LIGHTBLUE[1]
  && borderPx[2] === COLODORE_LIGHTBLUE[2],
  `got=(${borderPx.join(",")})`);

check("xsmooth band (x=30, xsmooth=4) = blue (= bg color $06)",
  xsmoothPx[0] === COLODORE_BLUE[0]
  && xsmoothPx[1] === COLODORE_BLUE[1]
  && xsmoothPx[2] === COLODORE_BLUE[2],
  `got=(${xsmoothPx.join(",")})`);

// xsmooth=0 → border extends to 31, no xsmooth band
session.vic.regs[0x16] = (session.vic.regs[0x16] & 0xf8) | 0;
session.renderFrame();
const noXsmooth = pixelAt(31, 91);
check("xsmooth=0: x=31 = border color (no xsmooth band)",
  noXsmooth[0] === COLODORE_LIGHTBLUE[0]
  && noXsmooth[1] === COLODORE_LIGHTBLUE[1]
  && noXsmooth[2] === COLODORE_LIGHTBLUE[2],
  `got=(${noXsmooth.join(",")})`);

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
