#!/usr/bin/env node
// Spec 297b smoke — cycle-pumped renderer, mode 0 (standard text).
//
// Boot a session, install cycle-pumped renderer, run a frame, verify
// that the framebuffer contains rendered pixels in the visible band
// (= READY screen has bg + fg pixels, not all bg).

import { startIntegratedSession } from
  "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/integrated-session-manager.js";
import { installCyclePumpedRenderer } from
  "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/vic/cycle-pumped-renderer.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-297b-cycle-pump-mode0");

const { session: s } = startIntegratedSession({
  diskPath: "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/synthetic/1block.g64",
});
s.resetCold("pal-default");
// Boot KERNAL to READY.
s.runFor(5_000_000, { cycleBudget: 5_000_000 });

// Capture snapshot framebuffer pixels for comparison
const beforeInstall = new Uint8Array(s.framebuffer.pixels);
let nonBgBefore = 0;
const bgRgb = s.framebuffer.palette[6]; // d021 = blue 6
for (let i = 0; i < beforeInstall.length; i += 4) {
  if (!(beforeInstall[i] === bgRgb[0] && beforeInstall[i+1] === bgRgb[1] && beforeInstall[i+2] === bgRgb[2])) {
    nonBgBefore++;
  }
}
ok("snapshot path: framebuffer NOT all-zero (= snapshot renderer left something)",
   nonBgBefore > 0 || beforeInstall.some(v => v !== 0),
   `nonBgBefore=${nonBgBefore}`);

// Install cycle-pumped renderer
const handle = installCyclePumpedRenderer(s);
ok("installCyclePumpedRenderer returns handle", typeof handle.uninstall === "function");
ok("vic.onCycle is set", typeof s.vic.onCycle === "function");

// Run 1 frame = 19,656 cycles. Will fire onCycle ~19,656 times.
let cycleCount = 0;
const origOnCycle = s.vic.onCycle;
s.vic.onCycle = (y, c, clk) => {
  cycleCount++;
  origOnCycle(y, c, clk);
};
// Clear framebuffer first so we can see if cycle-pumped writes any pixels
s.framebuffer.pixels.fill(0);

// 1 PAL frame = ~19,656 cycles. Run a generous chunk to cover full frame
// crossings.
s.runFor(50_000, { cycleBudget: 19_656 * 2 });

ok("onCycle fired at expected rate (~19656 per frame)", cycleCount > 30_000,
   `got ${cycleCount} for 2-frame run`);

// Check that cycle-pumped renderer wrote SOMETHING to framebuffer in the
// visible band (= rows 51..250, cols 32..351 inset from VISIBLE_X/Y).
let writtenPixels = 0;
const fb = s.framebuffer.pixels;
for (let y = 51; y < 250; y++) {
  for (let x = 32; x < 352; x++) {
    const off = (y * 504 + x) * 4;
    if (fb[off] !== 0 || fb[off+1] !== 0 || fb[off+2] !== 0) writtenPixels++;
  }
}
ok("cycle-pumped wrote pixels in visible band (mode 0 std text)",
   writtenPixels > 1000,
   `wrote ${writtenPixels} non-zero pixels in visible band (out of ~64000)`);

// Verify uninstall reverts hook
handle.uninstall();
ok("after uninstall: vic.onCycle reverts to previous state",
   s.vic.onCycle === undefined);

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
