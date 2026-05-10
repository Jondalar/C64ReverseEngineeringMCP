#!/usr/bin/env node
// Spec V1/V2/V3/V5 — Scramble Infinity stages probe.
//   stage 0: loader bar (= V2 raster bar tearing target)
//   stage 1: title screen (= V1 sprites in border + V2 split tearing)
//   stage 2: menu (= V1 + V2)
//   stage 3: in-game (= V1 + V3 + V5)
//
// Each stage: capture PNG + VIC reg write trace (per raster, listing
// every D011/D015/D016/D018/D01A/D019/D020/D021 write with PC).

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);
const LIT_MEM = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-mem.js`);

const OUT_DIR = `${REPO}/samples/screenshots/vic-bugs`;
mkdirSync(OUT_DIR, { recursive: true });

// Match UI session: start with NO disk, boot to BASIC, then mount via API.
const { sessionId, session: s } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
});
s.resetCold("pal-default");
console.log("KERNAL boot to BASIC ready...");
s.runFor(5_000_000, { cycleBudget: 5_000_000 });
console.log("Mount Scramble disk via API (= same path as UI)...");
const { mountMedia } = await import(`${REPO}/dist/runtime/headless/media/mount.js`);
await mountMedia(s, 8, resolve(`${REPO}/samples/scramble_infinity.d64`));
s.runFor(2_000_000, { cycleBudget: 2_000_000 });
console.log("LOAD'*',8,1...");
s.typeText('LOAD"*",8,1\r');
console.log("LOAD wait (60M cyc)...");
s.runFor(60_000_000, { cycleBudget: 60_000_000 });
s.typeText("RUN\r");
console.log("RUN issued.");

// Trace harness state
const traceWrites = [];
let intercepting = false;
const wrap = (reg) => ({
  read: () => LIT_MEM.vicii_read(reg),
  write: (_addr, val) => {
    if (intercepting && traceWrites.length < 2000) {
      traceWrites.push({
        cyc: s.c64Cpu.cycles,
        raster: LIT_TYPES.vicii.raster_line,
        rcyc: LIT_TYPES.vicii.raster_cycle,
        pc: s.c64Cpu.pc,
        reg,
        val,
      });
    }
    LIT_MEM.vicii_store(reg, val);
    s.vic.write(reg, val);
  },
});
for (const reg of [0x11, 0x15, 0x16, 0x18, 0x19, 0x1a, 0x20, 0x21]) {
  s.c64Bus.registerIoHandler(0xd000 + reg, wrap(reg));
}

const captureStage = async (label, settleCycles) => {
  console.log(`\n=== ${label} ===`);
  s.runFor(settleCycles / 10, { cycleBudget: settleCycles });
  // Reset trace + run 1 frame
  traceWrites.length = 0;
  intercepting = true;
  s.runFor(20_000, { cycleBudget: 20_000 });
  intercepting = false;

  const pngPath = `${OUT_DIR}/scramble-${label}.png`;
  const r = s.vic.regs;
  const pre = `r=${LIT_TYPES.vicii.raster_line} pc=$${s.c64Cpu.pc.toString(16)} D011=$${r[0x11].toString(16)} D015=$${r[0x15].toString(16)} D016=$${r[0x16].toString(16)} D018=$${r[0x18].toString(16)} D01A=$${r[0x1a].toString(16)} bank=${(~(s.cia2.pra & s.cia2.ddra)) & 3}`;
  console.log(`  state: ${pre}`);
  s.renderToPng(pngPath);
  console.log(`  -> ${pngPath}`);

  // Group writes by raster line for compact display
  const byRaster = new Map();
  for (const w of traceWrites) {
    if (!byRaster.has(w.raster)) byRaster.set(w.raster, []);
    byRaster.get(w.raster).push(`D0${w.reg.toString(16).padStart(2,"0")}=${w.val.toString(16).padStart(2,"0")}`);
  }
  const lines = [...byRaster.keys()].sort((a, b) => a - b);
  console.log(`  ${traceWrites.length} writes across ${lines.length} raster lines:`);
  for (const ln of lines.slice(0, 20)) {
    console.log(`    raster ${ln.toString().padStart(3)}: ${byRaster.get(ln).join(" ")}`);
  }
  if (lines.length > 20) console.log(`    ... +${lines.length - 20} more raster lines with writes`);

  writeFileSync(`${OUT_DIR}/scramble-${label}-trace.json`,
    JSON.stringify({ state: pre, writeCount: traceWrites.length, byRaster: Object.fromEntries(lines.map(ln => [ln, byRaster.get(ln)])) }, null, 2));
};

// Stage progression: loader bar → "Ready Joy 2" loader credits screen
// → press FIRE → title screen (= where V1+V2 are most visible) →
// → press FIRE → in-game (= V3 scroll bug).
await captureStage("01-loaderbar-30M", 30_000_000);
await captureStage("02-credits-180M", 150_000_000); // wait until ready joy 2 visible

console.log("→ pressing JOY 2 FIRE...");
s.setJoystick2({ fire: true });
s.runFor(500_000, { cycleBudget: 500_000 });
s.setJoystick2({ fire: false });
await captureStage("03-after-fire1", 30_000_000);
await captureStage("04-title-60M", 60_000_000);

console.log("→ pressing JOY 2 FIRE again...");
s.setJoystick2({ fire: true });
s.runFor(500_000, { cycleBudget: 500_000 });
s.setJoystick2({ fire: false });
await captureStage("05-after-fire2", 30_000_000);
await captureStage("06-game-60M", 60_000_000);

console.log("→ pressing JOY 2 FIRE again (start game)...");
s.setJoystick2({ fire: true });
s.runFor(500_000, { cycleBudget: 500_000 });
s.setJoystick2({ fire: false });
await captureStage("07-game-active", 60_000_000);
await captureStage("08-game-active2", 60_000_000);

stopIntegratedSession(sessionId);
console.log("\nDONE. Snapshots in samples/screenshots/vic-bugs/scramble-*.png");
