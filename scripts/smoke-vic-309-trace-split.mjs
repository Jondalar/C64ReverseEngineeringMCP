#!/usr/bin/env node
// Spec 309 — fine-cycle trace of motm title menu D011/D016/D018/D021
// over 1 PAL frame. Boot motm to 280M cycles (= menu reached), then
// sample VIC regs every 1 CPU instruction for ~20K cycles.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);

const OUT_DIR = `${REPO}/samples/screenshots/motm-spec-309`;
mkdirSync(OUT_DIR, { recursive: true });

const { sessionId, session: s } = startIntegratedSession({
  diskPath: resolve(`${REPO}/samples/motm.g64`),
  mode: "true-drive",
  useMicrocodedCpu: true,
});
s.resetCold("pal-default");
s.runFor(5_000_000, { cycleBudget: 5_000_000 });
s.typeText('LOAD"*",8,1\r');
s.runFor(60_000_000, { cycleBudget: 60_000_000 });
s.typeText("RUN\r");
console.log("Booting motm + waiting for menu state (D01A=$01 + D012=$08)...");
const r = s.vic.regs;
let totalC = 0;
const maxC = 400_000_000;
const checkEvery = 5_000_000;
while (totalC < maxC) {
  s.runFor(500_000, { cycleBudget: checkEvery });
  totalC += checkEvery;
  if (r[0x1a] === 0x01 && (r[0x12] === 0x08 || r[0x12] === 0x9a || r[0x12] === 0xa4)) {
    console.log(`menu state reached at ${(totalC/1e6).toFixed(0)}M cycles. PC=$${s.c64Cpu.pc.toString(16)} D011=$${r[0x11].toString(16)} D012=$${r[0x12].toString(16)} D018=$${r[0x18].toString(16)} D01A=$${r[0x1a].toString(16)}`);
    break;
  }
}
if (r[0x1a] !== 0x01) {
  console.log(`FAILED to reach menu — D01A=$${r[0x1a].toString(16)} after ${(totalC/1e6).toFixed(0)}M cycles`);
  stopIntegratedSession(sessionId);
  process.exit(1);
}
console.log(`At 280M: PC=$${s.c64Cpu.pc.toString(16)}  D011=$${r[0x11].toString(16)} D012=$${r[0x12].toString(16)} D016=$${r[0x16].toString(16)} D018=$${r[0x18].toString(16)} D01A=$${r[0x1a].toString(16)} bank=${(~(s.cia2.pra & s.cia2.ddra)) & 3}`);

// Wait for D018 first change (= split fully active).
console.log("\nWaiting for first D018 change...");
let prevD18 = r[0x18];
let waitC = 0;
while (waitC < 50_000_000) {
  s.runFor(2_000, { cycleBudget: 100_000 });
  waitC += 100_000;
  if (r[0x18] !== prevD18) {
    console.log(`  D018 changed at +${(waitC/1e6).toFixed(1)}M cyc: ${prevD18.toString(16)}->${r[0x18].toString(16)} PC=$${s.c64Cpu.pc.toString(16)} D011=$${r[0x11].toString(16)} raster=${LIT_TYPES.vicii.raster_line}`);
    prevD18 = r[0x18];
    break;
  }
}
if (waitC >= 50_000_000) {
  console.log(`  D018 never changed in 50M cycles — split is BROKEN`);
}

console.log("\nTracing 1 frame (cycle-granular)...");
const initial = {
  d11: r[0x11], d16: r[0x16], d18: r[0x18], d19: r[0x19], d20: r[0x20], d21: r[0x21], d15: r[0x15], d1a: r[0x1a]
};
let last = { ...initial };
const events = [];
const FRAME_CYC = 19656;
const startCyc = s.c64Cpu.cycles;
const pcSamples = [];
let iters = 0;
while (s.c64Cpu.cycles - startCyc < FRAME_CYC) {
  s.runFor(5, { cycleBudget: 60 });
  iters++;
  const cur = { d11: r[0x11], d16: r[0x16], d18: r[0x18], d19: r[0x19], d20: r[0x20], d21: r[0x21], d15: r[0x15], d1a: r[0x1a] };
  if (iters % 200 === 0) pcSamples.push({ raster: LIT_TYPES.vicii.raster_line, pc: s.c64Cpu.pc, cycles: s.c64Cpu.cycles - startCyc });
  const diffs = [];
  for (const k of Object.keys(cur)) if (cur[k] !== last[k]) diffs.push(`${k.toUpperCase()} ${last[k].toString(16)}->${cur[k].toString(16)}`);
  if (diffs.length > 0) {
    events.push({ raster: LIT_TYPES.vicii.raster_line, rcyc: LIT_TYPES.vicii.raster_cycle, cpc: s.c64Cpu.pc, diffs });
    last = { ...cur };
  }
}
console.log(`iterations=${iters}  cycles=${s.c64Cpu.cycles - startCyc}  events=${events.length}`);
console.log(`PC trail (every 200 iter):`);
for (const p of pcSamples.slice(0, 20)) console.log(`  cyc=${p.cycles.toString().padStart(5)} raster=${p.raster.toString().padStart(3)} pc=$${p.pc.toString(16)}`);
for (const e of events.slice(0, 60)) {
  console.log(`  raster=${e.raster.toString().padStart(3)} rcyc=${e.rcyc.toString().padStart(2)} pc=$${e.cpc.toString(16).padStart(4,"0")}  ${e.diffs.join("  ")}`);
}

// Render
const path = `${OUT_DIR}/motm-menu-traced.png`;
s.renderToPng(path);
console.log(`\nRendered -> ${path}`);

stopIntegratedSession(sessionId);
