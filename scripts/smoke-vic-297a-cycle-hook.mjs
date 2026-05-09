#!/usr/bin/env node
// Spec 297a smoke — VicIIVice.onCycle per-cycle hook.
//
// Verifies:
//   1. Without onCycle: tick(N) advances cycles in batched line wraps
//      (= legacy fast path, no per-cycle invocation, behavior unchanged)
//   2. With onCycle installed: tick(N) fires onCycle exactly N times
//      with monotonically advancing (raster_y, raster_cycle) per VICE
//      vicii-cycle.c dispatch shape
//   3. After PAL line wrap: raster_y increments, raster_cycle resets to 0
//   4. Frame wrap: raster_y wraps to 0 after screen_height-1

import { startIntegratedSession } from
  "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/integrated-session-manager.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-297a-cycle-hook");

// --- Test 1: legacy path (no hook) — tick advances batched ---
{
  const { session: s } = startIntegratedSession({
    diskPath: "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/synthetic/1block.g64",
  });
  s.resetCold("pal-default");
  // No onCycle hook → legacy batched advance
  const before = s.vic.raster_cycle;
  const beforeY = s.vic.raster_y;
  s.vic.tick(63); // 1 PAL line worth
  ok("no hook: raster_cycle wraps 63 → 0", s.vic.raster_cycle === before);
  ok("no hook: raster_y advances 1", s.vic.raster_y === ((beforeY + 1) % 312));
}

// --- Test 2: hook installed → fires N times with correct sequence ---
{
  const { session: s } = startIntegratedSession({
    diskPath: "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/synthetic/1block.g64",
  });
  s.resetCold("pal-default");
  const calls = [];
  s.vic.onCycle = (y, c, _clk) => { calls.push({ y, c }); };
  const startY = s.vic.raster_y;
  const startC = s.vic.raster_cycle;
  s.vic.tick(63);
  ok("hook: fired 63 times", calls.length === 63, `got ${calls.length}`);
  // First call: at (startY, startC)
  ok("hook: first call matches raster state at tick start",
     calls[0].y === startY && calls[0].c === startC,
     `got y=${calls[0].y} c=${calls[0].c} expected y=${startY} c=${startC}`);
  // Sequence monotonic within line
  let seqOk = true;
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1];
    const cur = calls[i];
    if (cur.y === prev.y) {
      if (cur.c !== prev.c + 1) { seqOk = false; break; }
    } else {
      // Line wrap
      if (cur.c !== 0) { seqOk = false; break; }
      if (cur.y !== (prev.y + 1) % 312) { seqOk = false; break; }
    }
  }
  ok("hook: cycles advance monotonically per cycle, wrap to next line at 63", seqOk);
}

// --- Test 3: hook fires across line wrap ---
{
  const { session: s } = startIntegratedSession({
    diskPath: "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/synthetic/1block.g64",
  });
  s.resetCold("pal-default");
  // Park at end of line 0
  s.vic.raster_cycle = 60;
  s.vic.raster_y = 0;
  const calls = [];
  s.vic.onCycle = (y, c) => calls.push({ y, c });
  s.vic.tick(6); // Cross line boundary: cycles 60, 61, 62 (line 0), 0, 1, 2 (line 1)
  ok("hook: 6 cycles crossed line boundary", calls.length === 6, `got ${calls.length}`);
  ok("hook: line 0 cycles 60..62", calls.slice(0, 3).every((c, i) => c.y === 0 && c.c === 60 + i));
  ok("hook: line 1 cycles 0..2", calls.slice(3, 6).every((c, i) => c.y === 1 && c.c === i));
}

// --- Test 4: hook fires across frame wrap ---
{
  const { session: s } = startIntegratedSession({
    diskPath: "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/synthetic/1block.g64",
  });
  s.resetCold("pal-default");
  // Park near end of frame
  s.vic.raster_cycle = 62;
  s.vic.raster_y = 311;
  const calls = [];
  s.vic.onCycle = (y, c) => calls.push({ y, c });
  s.vic.tick(2); // 1 cycle on line 311, then wrap to line 0
  ok("hook: 2 cycles around frame wrap", calls.length === 2, `got ${calls.length}`);
  ok("hook: cycle 62 on line 311", calls[0].y === 311 && calls[0].c === 62);
  ok("hook: cycle 0 on line 0 after wrap", calls[1].y === 0 && calls[1].c === 0);
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
