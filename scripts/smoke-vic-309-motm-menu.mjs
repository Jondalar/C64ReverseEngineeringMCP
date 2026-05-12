#!/usr/bin/env node
// Spec 309 — drive motm to title menu screen via natural boot,
// capture frame at intervals + inspect D016/D018 + IRQ state.
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

// Run + dump screenshots at intervals; auto-press space if menu may need advance.
const stages = [
  { cycles: 60_000_000, name: "060M" },
  { cycles: 60_000_000, name: "120M" },
  { cycles: 60_000_000, name: "180M" },
  { cycles: 60_000_000, name: "240M" },
  { cycles: 60_000_000, name: "300M" },
  { cycles: 60_000_000, name: "360M" },
];
let total = 0;
for (const stage of stages) {
  s.runFor(stage.cycles / 10, { cycleBudget: stage.cycles });
  total += stage.cycles;
  const path = `${OUT_DIR}/motm-stage-${stage.name}.png`;
  s.renderToPng(path);
  const r = s.vic.regs;
  console.log(`[${stage.name}] PC=$${s.c64Cpu.pc.toString(16)}  D011=$${r[0x11].toString(16)} D012=$${r[0x12].toString(16)} D016=$${r[0x16].toString(16)} D018=$${r[0x18].toString(16)} D019=$${r[0x19].toString(16)} D01A=$${r[0x1a].toString(16)} CIA2_PA=$${(s.cia2.pra & s.cia2.ddra & 0xff).toString(16)} bank=${(~(s.cia2.pra & s.cia2.ddra)) & 3}  -> ${path}`);
}

// Sample D016/D018 mid-frame after settling.
console.log("\nMid-frame D016/D018 sweep over 1 frame...");
let lastD16 = s.vic.regs[0x16];
let lastD18 = s.vic.regs[0x18];
const writes = [];
for (let i = 0; i < 600; i++) {
  s.runFor(1, { cycleBudget: 35 });
  const d16 = s.vic.regs[0x16];
  const d18 = s.vic.regs[0x18];
  if (d16 !== lastD16 || d18 !== lastD18) {
    writes.push({ raster: LIT_TYPES.vicii.raster_line, d16_old: lastD16, d16_new: d16, d18_old: lastD18, d18_new: d18, pc: s.c64Cpu.pc });
    lastD16 = d16; lastD18 = d18;
  }
}
console.log(`writes seen: ${writes.length}`);
for (const w of writes.slice(0, 30)) {
  console.log(`  raster=${w.raster} D016 ${w.d16_old.toString(16)}->${w.d16_new.toString(16)} D018 ${w.d18_old.toString(16)}->${w.d18_new.toString(16)} pc=$${w.pc.toString(16)}`);
}

stopIntegratedSession(sessionId);
