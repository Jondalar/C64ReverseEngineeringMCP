#!/usr/bin/env node
// Spec 309 — VICE VSF state inject for motm menu.
//
// Parses VICE x64sc snapshot, injects:
//   - 64KB C64 RAM
//   - VIC-II regs[$D000-$D03F] + color RAM
//   - CIA1/CIA2 PA + DDRA
//   - CPU PC/A/X/Y/SP/P
//
// Then renders 1 frame via literal port + dumps state diagnostics.

import { mkdirSync, readFileSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const VSF = `${REPO}/samples/motm_menu_vice.vsf`;
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);

const OUT_DIR = `${REPO}/samples/screenshots/motm-spec-309`;
mkdirSync(OUT_DIR, { recursive: true });

// VSF parser — modules: name(16) + major(1) + minor(1) + size(u32 LE).
// size INCLUDES header (= 22-byte header).
const buf = readFileSync(VSF);
const findModule = (name) => {
  for (let i = 0x3a; i + 16 <= buf.length; i++) {
    let m = true;
    for (let k = 0; k < name.length; k++) {
      if (buf[i + k] !== name.charCodeAt(k)) { m = false; break; }
    }
    if (m && buf[i + name.length] === 0) return { offset: i, dataStart: i + 22, size: buf.readUInt32LE(i + 18) };
  }
  return null;
};

const cpuMod = findModule("MAINCPU");
const memMod = findModule("C64MEM");
const vicMod = findModule("VIC-II");
const cia1Mod = findModule("CIA1");
const cia2Mod = findModule("CIA2");
console.log(`MAINCPU @ 0x${cpuMod.offset.toString(16)} size=${cpuMod.size}`);
console.log(`C64MEM  @ 0x${memMod.offset.toString(16)} size=${memMod.size}`);
console.log(`VIC-II  @ 0x${vicMod.offset.toString(16)} size=${vicMod.size}`);
console.log(`CIA1    @ 0x${cia1Mod.offset.toString(16)} size=${cia1Mod.size}`);
console.log(`CIA2    @ 0x${cia2Mod.offset.toString(16)} size=${cia2Mod.size}`);

const cpu = cpuMod.dataStart;
const cpuClk = Number(buf.readBigUInt64LE(cpu));
const cpuA = buf[cpu + 8], cpuX = buf[cpu + 9], cpuY = buf[cpu + 10], cpuSP = buf[cpu + 11];
const cpuPC = buf.readUInt16LE(cpu + 12), cpuP = buf[cpu + 14];

const mem = memMod.dataStart;
const ramOff = mem + 4; // skip pport.data, pport.dir, EXROM, GAME

const vic = vicMod.dataStart;
const vicRegs = buf.subarray(vic + 1, vic + 1 + 64);
// Color RAM is at END of VIC-II module per VICE source. 1024 bytes.
const colorRam = buf.subarray(vicMod.offset + vicMod.size - 1024, vicMod.offset + vicMod.size);

const cia2 = cia2Mod.dataStart;
const cia2Pra = buf[cia2], cia2Prb = buf[cia2 + 1], cia2DdrA = buf[cia2 + 2], cia2DdrB = buf[cia2 + 3];

const cia1 = cia1Mod.dataStart;
const cia1Pra = buf[cia1], cia1Prb = buf[cia1 + 1], cia1DdrA = buf[cia1 + 2], cia1DdrB = buf[cia1 + 3];

console.log(`\nExtracted state:`);
console.log(`  CPU: PC=$${cpuPC.toString(16)} A=$${cpuA.toString(16)} X=$${cpuX.toString(16)} Y=$${cpuY.toString(16)} SP=$${cpuSP.toString(16)} P=$${cpuP.toString(16)}`);
console.log(`  VIC regs (0..0x3F): D011=$${vicRegs[0x11].toString(16)} D012=$${vicRegs[0x12].toString(16)} D016=$${vicRegs[0x16].toString(16)} D018=$${vicRegs[0x18].toString(16)} D01A=$${vicRegs[0x1a].toString(16)} D020=$${vicRegs[0x20].toString(16)} D021=$${vicRegs[0x21].toString(16)}`);
console.log(`  CIA2 PA=$${cia2Pra.toString(16)} DDRA=$${cia2DdrA.toString(16)} bank=${(~(cia2Pra & cia2DdrA)) & 3}`);

// === inject ===
const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/motm.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
});
s.resetCold("pal-default");

// 1. RAM (64K)
const c64Ram = s.c64Bus.getRam ? s.c64Bus.getRam() : null;
if (!c64Ram) {
  // Direct write via bus
  for (let i = 0; i < 0x10000; i++) s.c64Bus.write(i, buf[ramOff + i]);
} else {
  for (let i = 0; i < 0x10000; i++) c64Ram[i] = buf[ramOff + i];
}

// 2. VIC regs — direct array assignment via shared regs[]
for (let i = 0; i < 64; i++) {
  s.vic.regs[i] = vicRegs[i];
  LIT_TYPES.vicii.regs[i] = vicRegs[i];
}

// 3. Color RAM (1KB at $D800)
for (let i = 0; i < 0x400; i++) s.c64Bus.write(0xd800 + i, colorRam[i]);

// 4. CIA1+CIA2 PA/DDRA
s.cia1.pra = cia1Pra; s.cia1.ddra = cia1DdrA;
s.cia1.prb = cia1Prb; s.cia1.ddrb = cia1DdrB;
s.cia2.pra = cia2Pra; s.cia2.ddra = cia2DdrA;
s.cia2.prb = cia2Prb; s.cia2.ddrb = cia2DdrB;

// 5. CPU
s.c64Cpu.pc = cpuPC;
s.c64Cpu.a = cpuA;
s.c64Cpu.x = cpuX;
s.c64Cpu.y = cpuY;
s.c64Cpu.sp = cpuSP;
s.c64Cpu.p = cpuP;

console.log(`\nInjected. Running 5 frames to settle literal port...`);

// Run a handful of frames so literal port catches up + IRQ handler runs.
for (let f = 0; f < 5; f++) {
  s.runFor(50_000, { cycleBudget: 50_000 });
  console.log(`  frame ${f}: PC=$${s.c64Cpu.pc.toString(16)} D018=$${s.vic.regs[0x18].toString(16)} D011=$${s.vic.regs[0x11].toString(16)} lit.raster=${LIT_TYPES.vicii.raster_line}`);
}

const path = `${OUT_DIR}/motm-menu-injected.png`;
const r = s.renderToPng(path);
console.log(`\nRendered: ${r.width}x${r.height} ${r.bytes} bytes -> ${path}`);

// Track D018/D016 changes during 1 frame
console.log(`\nMid-frame D018/D016 trace (1 PAL frame, sample every 50 cyc):`);
let lastD18 = s.vic.regs[0x18];
let lastD16 = s.vic.regs[0x16];
const writes = [];
for (let i = 0; i < 400; i++) {
  s.runFor(2, { cycleBudget: 50 });
  const d18 = s.vic.regs[0x18];
  const d16 = s.vic.regs[0x16];
  if (d18 !== lastD18 || d16 !== lastD16) {
    writes.push({ raster: LIT_TYPES.vicii.raster_line, cyc: s.c64Cpu.cycles, d18_old: lastD18, d18_new: d18, d16_old: lastD16, d16_new: d16, pc: s.c64Cpu.pc });
    lastD18 = d18; lastD16 = d16;
  }
}
console.log(`writes seen: ${writes.length}`);
for (const w of writes.slice(0, 30)) {
  console.log(`  raster=${w.raster} cyc=${w.cyc}  D018 ${w.d18_old.toString(16)}->${w.d18_new.toString(16)}  D016 ${w.d16_old.toString(16)}->${w.d16_new.toString(16)}  pc=$${w.pc.toString(16)}`);
}

stopIntegratedSession(sessionId);
