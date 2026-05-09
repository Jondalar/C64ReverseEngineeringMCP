#!/usr/bin/env node
// Spec 297m smoke — frame orchestration: raster_y advance + frame wrap.
//
// Per VICE viciisc/vicii-cycle.c: raster_y wraps from screen_height-1
// → 0 at end of frame; raster IRQ fires at programmed compare line.
// Cycle pump runs the same scheduler ticks as snapshot path = no
// new orchestration code needed; this smoke is the formal proof.

import { startIntegratedSession } from
  "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/integrated-session-manager.js";
import { installCyclePumpedRenderer } from
  "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/vic/cycle-pumped-renderer.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-297m-frame-orchestration");

// Test 1: 1 PAL frame = 63 × 312 = 19,656 cycles
{
  const { session: s } = startIntegratedSession({
    diskPath: "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/synthetic/1block.g64",
  });
  s.resetCold("pal-default");
  installCyclePumpedRenderer(s);
  // Park raster at start of line 0
  s.vic.raster_y = 0;
  s.vic.raster_cycle = 0;
  // Count onCycle invocations across 1 PAL frame
  let calls = 0;
  const orig = s.vic.onCycle;
  s.vic.onCycle = (y, c, clk) => { calls++; orig(y, c, clk); };
  s.vic.tick(63 * 312);
  ok("1 PAL frame = 63 × 312 = 19,656 cycle dispatches",
     calls === 19_656, `got ${calls}`);
  ok("after 1 frame: raster_y wraps to 0", s.vic.raster_y === 0,
     `got raster_y=${s.vic.raster_y}`);
}

// Test 2: raster_y monotonically advances 0..311 then wraps
{
  const { session: s } = startIntegratedSession({
    diskPath: "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/synthetic/1block.g64",
  });
  s.resetCold("pal-default");
  installCyclePumpedRenderer(s);
  s.vic.raster_y = 0;
  s.vic.raster_cycle = 0;
  const linesSeen = new Set();
  const orig = s.vic.onCycle;
  s.vic.onCycle = (y, c, clk) => { linesSeen.add(y); orig(y, c, clk); };
  s.vic.tick(63 * 312);
  ok("all 312 PAL lines visited in one frame",
     linesSeen.size === 312, `got ${linesSeen.size}`);
  // Verify range 0..311
  let ok312 = true;
  for (let i = 0; i < 312; i++) if (!linesSeen.has(i)) { ok312 = false; break; }
  ok("raster_y range covers 0..311 contiguously", ok312);
}

// Test 3: 2 frames = 2 wraps
{
  const { session: s } = startIntegratedSession({
    diskPath: "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/synthetic/1block.g64",
  });
  s.resetCold("pal-default");
  installCyclePumpedRenderer(s);
  s.vic.raster_y = 0;
  s.vic.raster_cycle = 0;
  let wrapCount = 0;
  let prevY = 0;
  const orig = s.vic.onCycle;
  s.vic.onCycle = (y, c, clk) => {
    if (y < prevY) wrapCount++;
    prevY = y;
    orig(y, c, clk);
  };
  // Tick 2 frames + 1 to ensure both wraps manifest in onCycle calls
  s.vic.tick(63 * 312 * 2 + 1);
  ok("2 frames + 1 cycle = 2 wraps from 311 → 0", wrapCount === 2,
     `got ${wrapCount}`);
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
