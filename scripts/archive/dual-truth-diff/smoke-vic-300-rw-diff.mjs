#!/usr/bin/env node
// Spec 300 diff harness: compare $D000-$D3F register READ RESULTS
// from VicIIVice vs literal vicii_read every line boundary, log first
// divergence with cycle, raster, PC.
//
// regs[] is shared by reference (integrated-session.ts:1254). The diff
// that matters is what code reading $D0xx sees through each chip's
// public read API: VicIIVice.read() vs LIT_MEM.vicii_read(). They
// apply OR-masks, raster latch, IRQ status, collision read-clear,
// etc — these are independent state.
//
// Pass = zero divergence over N frames on BASIC-ready scenario.

import { mkdirSync, writeFileSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_MEM = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-mem.js`);

const FRAMES = parseInt(process.env.FRAMES ?? "60", 10);
// PAL: 312 lines × 63 cycles = 19656 cycles/frame. 60 frames ≈ 1.18M.
const CYCLE_BUDGET = FRAMES * 19656 + 50_000;

console.log(`Spec 300 diff harness — ${FRAMES} frames, budget ${CYCLE_BUDGET} cyc`);

const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
  useLiteralPortRenderer: true,
  useLiteralPortVicPerCycle: true,
  useLiteralPortVicReads: false,  // diff harness reads via VicIIVice path; we sample LIT_MEM directly for compare
});

s.resetCold("pal-default");
s.runFor(2_000_000, { cycleBudget: 3_000_000 });

// Now sample at line boundaries. Run small slices, compare reg reads.
// Reg list: skip read-clear regs ($D019/$D01E/$D01F) from passive
// sampling — calling vicii_read on them clears collision latches.
// Skip $D013/$D014 (light pen — literal/vicii diverge by design;
// VicIIVice has no light pen state).
const SKIP_READ = new Set([0x13, 0x14, 0x19, 0x1e, 0x1f]);

const divergences = [];
let totalSamples = 0;

const SLICE_INSTR = 5000;
const SLICE_CYC = 20_000;
let elapsedCyc = 0;

while (elapsedCyc < CYCLE_BUDGET) {
  const before = s.c64Cpu.cycles;
  s.runFor(SLICE_INSTR, { cycleBudget: SLICE_CYC });
  const after = s.c64Cpu.cycles;
  elapsedCyc += (after - before);

  // Sample
  for (let reg = 0; reg < 0x40; reg++) {
    if (SKIP_READ.has(reg)) continue;
    const viceVal = s.vic.read(reg);
    const litVal = LIT_MEM.vicii_read(reg);
    totalSamples++;
    if (viceVal !== litVal) {
      divergences.push({
        cycle: after,
        reg,
        vice: viceVal,
        lit: litVal,
        pc: s.c64Cpu.pc,
      });
      if (divergences.length >= 50) break;
    }
  }
  if (divergences.length >= 50) break;
}

stopIntegratedSession(sessionId);

mkdirSync(`${REPO}/samples/screenshots/literal-port`, { recursive: true });
const reportPath = `${REPO}/samples/screenshots/literal-port/spec-300-rw-diff.json`;
writeFileSync(reportPath, JSON.stringify({
  frames: FRAMES,
  totalSamples,
  divergences: divergences.length,
  first: divergences.slice(0, 10),
}, null, 2));

console.log(`samples=${totalSamples} divergences=${divergences.length}`);
if (divergences.length === 0) {
  console.log("PASS: zero divergence");
  process.exit(0);
} else {
  console.log("FAIL: first 10 divergences:");
  for (const d of divergences.slice(0, 10)) {
    console.log(`  cyc=${d.cycle} reg=$${d.reg.toString(16).padStart(2, "0")} vice=$${d.vice.toString(16).padStart(2, "0")} lit=$${d.lit.toString(16).padStart(2, "0")} pc=$${d.pc.toString(16).padStart(4, "0")}`);
  }
  process.exit(1);
}
