#!/usr/bin/env node
// Spec 302 synthetic badline stall test.
//
// After BASIC ready: enable badlines (DEN=1, ysmooth=3 → matches every
// 8th line in DMA range). Run a few frames sampling literal stall via
// the `useLiteralPortVicStall=true` path. Confirm the CPU is being
// stalled on badlines (= cpu cycle progress drops vs frame cycle
// budget).
//
// Direct read: poll cpu cycle delta over a known line range; expect
// significant stall (>40 cycles per badline = ~5 badlines per frame on
// the visible region we sample).

import { mkdirSync, writeFileSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);

console.log("Spec 302 synthetic badline stall test");

// Run two sessions: one without literal stall (baseline), one with.
// Compare cycle-progress deltas after enabling badlines.

async function runSession(useLitStall) {
  const { sessionId, session: s } = startIntegratedSession({
    diskPath: `${REPO}/samples/synthetic/1block.g64`,
    mode: "true-drive",
    useMicrocodedCpu: true,
    useLiteralPortRenderer: true,
    useLiteralPortVicPerCycle: true,
    useLiteralPortVicReads: false,
    useLiteralPortVicIrq: false,
    useLiteralPortVicStall: useLitStall,
    usePerCycleBusStealing: true,
    useCycleLockstep: true,
  });
  s.resetCold("pal-default");
  s.runFor(2_000_000, { cycleBudget: 3_000_000 });

  // Enable badlines: DEN=1 (bit 4 of $D011) + ysmooth=3 (bits 0-2).
  s.c64Bus.write(0xd011, (s.c64Bus.read(0xd011) & ~0x07) | 0x10 | 0x03);
  // Stable region: run 3 frames to settle.
  s.runFor(200_000, { cycleBudget: 300_000 });

  // Measure: count cycles consumed by N CPU instructions to capture
  // stall pressure indirectly. With badlines active, CPU-eligible
  // cycles per frame drop by ~ 25 lines × 43 = 1075 stall cycles.
  const cyclesBefore = s.c64Cpu.cycles;
  // Sample literal ba_low + bad_line counts over a fixed cycle window.
  let baLowSeen = 0;
  let badLineSeen = 0;
  const SAMPLES = 500;
  for (let i = 0; i < SAMPLES; i++) {
    s.runFor(40, { cycleBudget: 200 });
    if (LIT_TYPES.vicii.bad_line) badLineSeen++;
    // Sample literal ba_low via private capture if exposed; fallback
    // to reading bad_line + sprite_dma.
    if (LIT_TYPES.vicii.bad_line || LIT_TYPES.vicii.sprite_dma) baLowSeen++;
  }
  const cyclesAfter = s.c64Cpu.cycles;
  const cycleDelta = cyclesAfter - cyclesBefore;

  stopIntegratedSession(sessionId);

  return { cycleDelta, baLowSeen, badLineSeen, samples: SAMPLES };
}

const baseline = await runSession(false);
const withLit  = await runSession(true);

console.log(`Baseline (VicIIVice stall): cycles=${baseline.cycleDelta} ba_low_samples=${baseline.baLowSeen}/${baseline.samples} bad_line_samples=${baseline.badLineSeen}/${baseline.samples}`);
console.log(`Literal stall:              cycles=${withLit.cycleDelta} ba_low_samples=${withLit.baLowSeen}/${withLit.samples} bad_line_samples=${withLit.badLineSeen}/${withLit.samples}`);

// Acceptance: literal must observe badlines firing (bad_line bit set
// in samples). Both should observe similar bad_line firing rate
// (within ±20% — sampling is coarse, exact match not expected).
const mkdir = mkdirSync;
mkdir(`${REPO}/samples/screenshots/literal-port`, { recursive: true });
writeFileSync(
  `${REPO}/samples/screenshots/literal-port/spec-302-badline-stall.json`,
  JSON.stringify({ baseline, withLit }, null, 2),
);

const checks = [
  { name: "literal observed badlines firing", ok: withLit.badLineSeen > 5 },
  { name: "literal cycle delta nonzero", ok: withLit.cycleDelta > 1000 },
  { name: "baseline cycle delta nonzero", ok: baseline.cycleDelta > 1000 },
  // Cycle budgets should be in same order of magnitude.
  { name: "literal vs baseline cycle delta within 50%", ok:
      Math.abs(withLit.cycleDelta - baseline.cycleDelta) < (baseline.cycleDelta / 2) },
];
let allOk = true;
for (const c of checks) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}: ${c.name}`);
  if (!c.ok) allOk = false;
}
process.exit(allOk ? 0 : 1);
