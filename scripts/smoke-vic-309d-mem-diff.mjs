#!/usr/bin/env node
// Spec 309d — diff motm screen RAM ($6000) + charset RAM ($5800)
// + color RAM ($D800) at menu state vs VICE VSF reference.
//
// Hypothesis: motm uses single MCM text mode with custom charset.
// Top rows = ship tiles, bottom rows = text. If our session has wrong
// charset/screen RAM contents, picture is garbled.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);

const VSF = `${REPO}/samples/motm_menu_vice.vsf`;
const OUT_DIR = `${REPO}/samples/screenshots/motm-spec-309`;
mkdirSync(OUT_DIR, { recursive: true });

// Parse VSF
const vsfBuf = readFileSync(VSF);
const findModule = (name) => {
  for (let i = 0x3a; i + 16 <= vsfBuf.length; i++) {
    let m = true;
    for (let k = 0; k < name.length; k++) if (vsfBuf[i + k] !== name.charCodeAt(k)) { m = false; break; }
    if (m && vsfBuf[i + name.length] === 0) return { offset: i, dataStart: i + 22, size: vsfBuf.readUInt32LE(i + 18) };
  }
  return null;
};
const memMod = findModule("C64MEM");
const vicMod = findModule("VIC-II");
const ramOff = memMod.dataStart + 4;
// VSF screen RAM at $6000, charset at $5800
const vsfScreen = vsfBuf.subarray(ramOff + 0x6000, ramOff + 0x6800); // 2KB
const vsfCharset = vsfBuf.subarray(ramOff + 0x5800, ramOff + 0x6000); // 2KB
// Color RAM is at end of VIC-II module (1024 bytes)
const vsfColor = vsfBuf.subarray(vicMod.offset + vicMod.size - 1024, vicMod.offset + vicMod.size);

// Boot motm
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
  if (r[0x1a] === 0x01 && r[0x12] === 0x08) break;
}
console.log(`menu reached at ${(totalC/1e6).toFixed(0)}M cyc.`);

// Wait LONGER: 100M more cycles for menu to fully draw.
console.log("Waiting +100M cyc for menu to settle...");
s.runFor(10_000_000, { cycleBudget: 100_000_000 });
console.log(`now PC=$${s.c64Cpu.pc.toString(16)} D011=$${r[0x11].toString(16)} D018=$${r[0x18].toString(16)}`);

// Dump our session's screen + charset + color RAM
const sessScreen = new Uint8Array(2048);
const sessCharset = new Uint8Array(2048);
const sessColor = new Uint8Array(1024);
for (let i = 0; i < 2048; i++) sessScreen[i] = s.c64Bus.read(0x6000 + i);
for (let i = 0; i < 2048; i++) sessCharset[i] = s.c64Bus.read(0x5800 + i);
for (let i = 0; i < 1024; i++) sessColor[i] = s.c64Bus.read(0xd800 + i);

// Diff
const diff = (a, b, label, base) => {
  let differ = 0;
  let firstDiff = -1;
  const samples = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      differ++;
      if (firstDiff < 0) firstDiff = i;
      if (samples.length < 10) samples.push({ off: i, addr: (base + i).toString(16), vsf: b[i].toString(16), sess: a[i].toString(16) });
    }
  }
  const pct = (differ * 100 / a.length).toFixed(1);
  console.log(`${label}: differ=${differ}/${a.length} (${pct}%)  firstDiff @+0x${firstDiff < 0 ? "—" : firstDiff.toString(16)}`);
  for (const s of samples) console.log(`  $${s.addr}: vsf=$${s.vsf} sess=$${s.sess}`);
  return { label, differ, total: a.length, pct: parseFloat(pct), samples };
};

const results = [
  diff(sessScreen, vsfScreen, "screen RAM $6000-$67FF", 0x6000),
  diff(sessCharset, vsfCharset, "charset RAM $5800-$5FFF", 0x5800),
  diff(sessColor, vsfColor, "color RAM $D800-$DBFF", 0xd800),
];

writeFileSync(`${OUT_DIR}/spec-309d-mem-diff.json`, JSON.stringify(results, null, 2));

// Also log VIC reg snapshot
console.log(`\nOur VIC regs:  D011=$${r[0x11].toString(16)} D012=$${r[0x12].toString(16)} D016=$${r[0x16].toString(16)} D018=$${r[0x18].toString(16)} D01A=$${r[0x1a].toString(16)} D020=$${r[0x20].toString(16)} D021=$${r[0x21].toString(16)} D022=$${r[0x22].toString(16)} D023=$${r[0x23].toString(16)} D025=$${r[0x25].toString(16)} D026=$${r[0x26].toString(16)}`);
const vicRegsVsf = vsfBuf.subarray(vicMod.dataStart + 1, vicMod.dataStart + 1 + 64);
console.log(`VSF VIC regs:  D011=$${vicRegsVsf[0x11].toString(16)} D012=$${vicRegsVsf[0x12].toString(16)} D016=$${vicRegsVsf[0x16].toString(16)} D018=$${vicRegsVsf[0x18].toString(16)} D01A=$${vicRegsVsf[0x1a].toString(16)} D020=$${vicRegsVsf[0x20].toString(16)} D021=$${vicRegsVsf[0x21].toString(16)} D022=$${vicRegsVsf[0x22].toString(16)} D023=$${vicRegsVsf[0x23].toString(16)} D025=$${vicRegsVsf[0x25].toString(16)} D026=$${vicRegsVsf[0x26].toString(16)}`);

stopIntegratedSession(sessionId);
