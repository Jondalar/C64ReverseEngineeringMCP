#!/usr/bin/env node
// Spec 309c — intercept D018/D011/D016 writes during motm title menu.
// Confirms whether IRQ handler issues split writes at all.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);
const LIT_MEM = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-mem.js`);

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

const r = s.vic.regs;
let totalC = 0;
while (totalC < 400_000_000) {
  s.runFor(500_000, { cycleBudget: 5_000_000 });
  totalC += 5_000_000;
  if (r[0x1a] === 0x01 && r[0x12] === 0x08) {
    console.log(`menu reached at ${(totalC/1e6).toFixed(0)}M cyc.`);
    break;
  }
}

const writes = [];
const MAX = 10000;
let intercepting = false;
const wrap = (reg) => ({
  read: () => LIT_MEM.vicii_read(reg),
  write: (_addr, val) => {
    if (intercepting && writes.length < MAX) {
      writes.push({
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
for (const reg of [0x11, 0x16, 0x18, 0x19, 0x1a, 0x20, 0x21, 0x22]) {
  s.c64Bus.registerIoHandler(0xd000 + reg, wrap(reg));
}

intercepting = true;
console.log("\nIntercepting VIC writes for ~3 frames (60K cyc)...");
const startCyc = s.c64Cpu.cycles;
s.runFor(20_000, { cycleBudget: 60_000 });
console.log(`elapsed=${s.c64Cpu.cycles - startCyc} cyc  writes=${writes.length}`);
intercepting = false;

const byReg = {};
for (const w of writes) {
  byReg[w.reg] = (byReg[w.reg] || 0) + 1;
}
console.log("writes per reg:");
for (const [k, v] of Object.entries(byReg)) {
  console.log(`  $D0${parseInt(k).toString(16).padStart(2,"0")}: ${v}`);
}
console.log("\nFirst 30 writes:");
for (const w of writes.slice(0, 30)) {
  console.log(`  cyc=${w.cyc} raster=${w.raster.toString().padStart(3)} rcyc=${w.rcyc.toString().padStart(2)} pc=$${w.pc.toString(16).padStart(4,"0")} D0${w.reg.toString(16).padStart(2,"0")}=$${w.val.toString(16).padStart(2,"0")}`);
}

writeFileSync(`${OUT_DIR}/spec-309c-writes.json`, JSON.stringify({ totalWrites: writes.length, byReg, writes: writes.slice(0, 200) }, null, 2));
stopIntegratedSession(sessionId);
