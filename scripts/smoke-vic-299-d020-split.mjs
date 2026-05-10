#!/usr/bin/env node
// Spec 299 PRG-1 smoke — $D020 raster border-color split (polling).
//
// Polling PRG: at line $80 set D020 = black, at line $0 set D020 =
// light blue. Sample first y where left border is black + report.
// per-cycle interleave should land split AT line $80 = canvas y=112.

import { mkdirSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);

// $c000: 78          sei
// $c001: ad 12 d0    lda $d012
// $c004: c9 80       cmp #$80
// $c006: d0 f9       bne $c001
// $c008: a9 00       lda #$00     (black)
// $c00a: 8d 20 d0    sta $d020
// $c00d: ad 12 d0    lda $d012
// $c010: c9 00       cmp #$00
// $c012: d0 f9       bne $c00d
// $c014: a9 0e       lda #$0e     (light blue)
// $c016: 8d 20 d0    sta $d020
// $c019: 4c 01 c0    jmp $c001
const PRG = new Uint8Array([
  0x78,
  0xad, 0x12, 0xd0,
  0xc9, 0x80,
  0xd0, 0xf9,
  0xa9, 0x00,
  0x8d, 0x20, 0xd0,
  0xad, 0x12, 0xd0,
  0xc9, 0x00,
  0xd0, 0xf9,
  0xa9, 0x0e,
  0x8d, 0x20, 0xd0,
  0x4c, 0x01, 0xc0,
]);
const ENTRY = 0xc000;

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
  for (let i = 0; i < PRG.length; i++) s.c64Bus.ram[ENTRY + i] = PRG[i];
  s.c64Cpu.pc = ENTRY;
  s.runFor(3_000_000, { cycleBudget: 5_000_000 });
  const outDir = `${REPO}/samples/screenshots/literal-port`;
  mkdirSync(outDir, { recursive: true });
  const path = `${outDir}/d020-split-${label}.png`;
  const r = s.renderToPng(path, { renderer: "literal-port", frameAligned: false });
  // Sample left border (x=80 in dbuf) at every line; find transition
  // (= first y where pixel = black AND previous y = light blue)
  const fb = s.literalPortFb;
  const FB_W = 520;
  let split = -1;
  for (let y = 1; y < 312; y++) {
    const prev = fb[(y - 1) * FB_W + 80];
    const cur = fb[y * FB_W + 80];
    if (prev === 0x0e && cur === 0x00) { split = y; break; }
  }
  console.log(`[${label}] PNG ${r.bytes}b → split at y=${split} (raster=${split + 16})`);
  stopIntegratedSession(sessionId);
  return split;
}

console.log("smoke-vic-299-d020-split");
const off = await runScenario(false, "percycle-off");
const on = await runScenario(true, "percycle-on");
console.log(`\npercycle off: split y=${off}`);
console.log(`percycle on:  split y=${on}`);
console.log(`expected: raster line $80 (= 128) → canvas y = 128 - 16 = 112`);
console.log(`diff: ${Math.abs(off - on)} px between modes`);
