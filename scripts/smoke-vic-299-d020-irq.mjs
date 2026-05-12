#!/usr/bin/env node
// Spec 299 PRG-1B — D020 split via raster IRQ (alternating compare).
//
// Init: raster IRQ enabled at line $80.
// IRQ handler: toggle border ($0e ↔ $00) + toggle compare ($80 ↔ $0).
// Result: top half border = $0e, bottom half = $00.
//
// IRQ handler entry latency: 7 cycles for IRQ acknowledge + 6502
// pushes A/X/Y/PC. Then KERNAL IRQ entry at $FF48 saves more, jumps
// to $0314 vector. Total ~30 cycles before our handler runs.
//
// In batch mode: 30 cycles into the trigger line, the WHOLE line gets
// the new D020 value when VIC catches up after handler returns
// (= line $80 already drawn with NEW color = entire line black).
//
// In per-cycle mode: VIC raster advances WITH CPU. Handler write lands
// at exact cycle = line $80 is partially old + partially new color.
//
// Sample at LEFT edge of line $80 (= early cycle): batch shows new,
// per-cycle shows old.
// Sample at RIGHT edge of line $80 (= late cycle): both show new.

import { mkdirSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);

// $c000 init:
//   78          sei
//   a9 7f       lda #$7f       disable CIA IRQs
//   8d 0d dc    sta $dc0d
//   8d 0d dd    sta $dd0d
//   ad 0d dc    lda $dc0d      ack
//   ad 0d dd    lda $dd0d
//   a9 80       lda #$80
//   8d 12 d0    sta $d012      compare = $80
//   ad 11 d0    lda $d011
//   29 7f       and #$7f       clear MSB
//   8d 11 d0    sta $d011
//   a9 01       lda #$01
//   8d 1a d0    sta $d01a      enable raster IRQ
//   a9 50       lda #$50
//   8d 14 03    sta $0314
//   a9 c0       lda #$c0
//   8d 15 03    sta $0315
//   58          cli
// $c024 loop:
//   4c 24 c0    jmp $c024
//
// $c050 irq:
//   ad 20 d0    lda $d020
//   49 0e       eor #$0e       toggle low nibble
//   8d 20 d0    sta $d020
//   ad 12 d0    lda $d012
//   49 80       eor #$80       toggle compare
//   8d 12 d0    sta $d012
//   a9 ff       lda #$ff
//   8d 19 d0    sta $d019
//   4c 31 ea    jmp $ea31
const PRG_INIT = new Uint8Array([
  0x78, 0xa9, 0x7f, 0x8d, 0x0d, 0xdc, 0x8d, 0x0d, 0xdd,
  0xad, 0x0d, 0xdc, 0xad, 0x0d, 0xdd,
  0xa9, 0x80, 0x8d, 0x12, 0xd0,
  0xad, 0x11, 0xd0, 0x29, 0x7f, 0x8d, 0x11, 0xd0,
  0xa9, 0x01, 0x8d, 0x1a, 0xd0,
  0xa9, 0x50, 0x8d, 0x14, 0x03,
  0xa9, 0xc0, 0x8d, 0x15, 0x03,
  0x58,
  0x4c, 0x24, 0xc0,
]);
const PRG_IRQ = new Uint8Array([
  0xad, 0x20, 0xd0, 0x49, 0x0e, 0x8d, 0x20, 0xd0,
  0xad, 0x12, 0xd0, 0x49, 0x80, 0x8d, 0x12, 0xd0,
  0xa9, 0xff, 0x8d, 0x19, 0xd0,
  0x4c, 0x31, 0xea,
]);

async function runScenario(percycle, label) {
  const { sessionId, session: s } = startIntegratedSession({
    diskPath: `${REPO}/samples/synthetic/1block.g64`,
    mode: "true-drive",
    useMicrocodedCpu: true,
    useLiteralPortRenderer: true,
    useLiteralPortVicPerCycle: percycle,
  });
  s.resetCold("pal-default");
  s.runFor(3_000_000, { cycleBudget: 5_000_000 });
  for (let i = 0; i < PRG_INIT.length; i++) s.c64Bus.ram[0xc000 + i] = PRG_INIT[i];
  for (let i = 0; i < PRG_IRQ.length; i++) s.c64Bus.ram[0xc050 + i] = PRG_IRQ[i];
  s.c64Cpu.pc = 0xc000;
  s.runFor(3_000_000, { cycleBudget: 5_000_000 });
  const path = `${REPO}/samples/screenshots/literal-port/d020-irq-${label}.png`;
  mkdirSync(`${REPO}/samples/screenshots/literal-port`, { recursive: true });
  s.renderToPng(path, { renderer: "literal-port", frameAligned: false });
  // Sample at line $80 (= raster 128, canvas y=112) at LEFT edge x=40 and RIGHT edge x=480
  const fb = s.literalPortFb;
  const FB_W = 520;
  const ySplit = 112; // canvas y for raster 128
  console.log(`[${label}] line $80 (canvas y=${ySplit}):`);
  for (const x of [16, 40, 80, 120, 200, 280, 360, 440, 480, 500]) {
    console.log(`  x=${x}: $${fb[ySplit * FB_W + x].toString(16)}`);
  }
  stopIntegratedSession(sessionId);
}

console.log("smoke-vic-299-d020-irq (alternating raster compare)");
await runScenario(false, "off");
await runScenario(true, "on");
