#!/usr/bin/env node
// Spec 297k smoke — mid-cycle register write bridge.
//
// In the cycle-pumped renderer, VIC regs are read per cycle directly
// from session.vic.regs[]. CPU writes to $D000-$D02E mutate this
// array via the memory bus handler. Cycle pump therefore picks up
// new values at the EXACT cycle the write lands — no snapshot lane
// required.
//
// This smoke proves: an external write to vic.regs[] between cycles
// is visible to the cycle pump on the next onCycle invocation.

import { startIntegratedSession } from
  "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/integrated-session-manager.js";
import { installCyclePumpedRenderer } from
  "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/vic/cycle-pumped-renderer.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-297k-reg-write-bridge");

// -----------------------------------------------------------------------
// Test 1: regs[] write between cycles is visible on next onCycle
// -----------------------------------------------------------------------
{
  const { session: s } = startIntegratedSession({
    diskPath: "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/synthetic/1block.g64",
  });
  s.resetCold("pal-default");
  s.runFor(5_000_000);

  installCyclePumpedRenderer(s);

  // Track D016 values as seen by cycle pump
  const valuesSeen = [];
  const orig = s.vic.onCycle;
  let injectAtCycle = -1;
  let injected = false;
  s.vic.onCycle = (y, c, clk) => {
    valuesSeen.push({ y, c, d016: s.vic.regs[0x16] });
    orig(y, c, clk);
    // Inject mid-line write at cycle 25 of line 50
    if (!injected && y === 50 && c === 25) {
      s.vic.regs[0x16] = 0x07;  // xsmooth=7
      injectAtCycle = valuesSeen.length;
      injected = true;
    }
  };

  s.runFor(50_000, { cycleBudget: 19_656 * 2 });

  // Find values seen at line 50 cycles 25 and 26
  const before = valuesSeen.filter(v => v.y === 50 && v.c === 25)[0];
  const after = valuesSeen.filter(v => v.y === 50 && v.c === 26)[0];

  ok("cycle 25 of line 50: d016 = pre-write value", before && before.d016 !== 0x07,
     `before=${before?.d016?.toString(16)}`);
  ok("cycle 26 of line 50: d016 = post-write value (0x07)",
     after && after.d016 === 0x07,
     `after=${after?.d016?.toString(16)}`);
  ok("write applied between consecutive cycles (= cycle-exact bridge)",
     injectAtCycle > 0);
}

// -----------------------------------------------------------------------
// Test 2: write to regs[0x21] is visible immediately
// -----------------------------------------------------------------------
{
  const { session: s } = startIntegratedSession({
    diskPath: "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/synthetic/1block.g64",
  });
  s.resetCold("pal-default");
  s.runFor(5_000_000);

  installCyclePumpedRenderer(s);
  let lastD021 = -1;
  const orig = s.vic.onCycle;
  let writeFiredAt = -1;
  s.vic.onCycle = (y, c, clk) => {
    lastD021 = s.vic.regs[0x21];
    orig(y, c, clk);
    if (writeFiredAt < 0 && y === 100 && c === 30) {
      s.vic.regs[0x21] = 0x0a;  // light red
      writeFiredAt = c;
    }
  };
  s.runFor(50_000, { cycleBudget: 19_656 });
  ok("post-write d021 picked up", lastD021 === 0x0a,
     `lastD021=${lastD021?.toString(16)}`);
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
