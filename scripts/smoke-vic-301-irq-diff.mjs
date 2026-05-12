#!/usr/bin/env node
// Spec 301 IRQ diff harness: per-line compare VicIIVice.irqAsserted
// vs literal vicii.irq_status & regs[0x1a] & 0x0f.
//
// Both chips maintain own irq_status (regs[0x1a] is shared by ref).
// Pass = zero divergence over N frames on BASIC-ready scenario.

import { mkdirSync, writeFileSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);

const FRAMES = parseInt(process.env.FRAMES ?? "60", 10);
const CYCLE_BUDGET = FRAMES * 19656 + 50_000;

console.log(`Spec 301 IRQ diff harness — ${FRAMES} frames`);

const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
  useLiteralPortRenderer: true,
  useLiteralPortVicPerCycle: true,
  useLiteralPortVicReads: false,
  useLiteralPortVicIrq: false,  // diff harness reads VicIIVice via API; samples literal directly
});

s.resetCold("pal-default");
s.runFor(2_000_000, { cycleBudget: 3_000_000 });

const divergences = [];
let totalSamples = 0;

const SLICE_INSTR = 2000;
const SLICE_CYC = 8_000;
let elapsedCyc = 0;

while (elapsedCyc < CYCLE_BUDGET) {
  const before = s.c64Cpu.cycles;
  s.runFor(SLICE_INSTR, { cycleBudget: SLICE_CYC });
  const after = s.c64Cpu.cycles;
  elapsedCyc += (after - before);

  const mask = s.vic.regs[0x1a] & 0x0f;
  const viceAsserted = s.vic.irqAsserted();
  const litAsserted = (LIT_TYPES.vicii.irq_status & mask & 0x0f) !== 0;
  totalSamples++;
  if (viceAsserted !== litAsserted) {
    divergences.push({
      cycle: after,
      raster: s.vic.raster_y,
      vice_asserted: viceAsserted,
      lit_asserted: litAsserted,
      vice_irq_status: s.vic.irq_status & 0xff,
      lit_irq_status: LIT_TYPES.vicii.irq_status & 0xff,
      mask,
      pc: s.c64Cpu.pc,
    });
    if (divergences.length >= 50) break;
  }
}

stopIntegratedSession(sessionId);

mkdirSync(`${REPO}/samples/screenshots/literal-port`, { recursive: true });
writeFileSync(
  `${REPO}/samples/screenshots/literal-port/spec-301-irq-diff.json`,
  JSON.stringify({ frames: FRAMES, totalSamples, divergences: divergences.length, first: divergences.slice(0, 10) }, null, 2),
);

console.log(`samples=${totalSamples} divergences=${divergences.length}`);
if (divergences.length === 0) {
  console.log("PASS: zero IRQ divergence");
  process.exit(0);
} else {
  console.log("FAIL: first 10 divergences:");
  for (const d of divergences.slice(0, 10)) {
    const fmtHex = (n) => "$" + (n & 0xff).toString(16).padStart(2, "0");
    console.log(`  cyc=${d.cycle} raster=${d.raster} vice=${d.vice_asserted ? "1" : "0"}/${fmtHex(d.vice_irq_status)} lit=${d.lit_asserted ? "1" : "0"}/${fmtHex(d.lit_irq_status)} mask=${fmtHex(d.mask)} pc=$${d.pc.toString(16).padStart(4, "0")}`);
  }
  process.exit(1);
}
