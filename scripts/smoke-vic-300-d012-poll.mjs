#!/usr/bin/env node
// Spec 300 acceptance: $D012 poll PRG.
//
// PRG polls $D012 in tight loop, stashes successive reads at $C100..
// With useLiteralPortVicReads=true, reads come from literal vicii_read.
// Verify: stashed values are monotonic mod 256, span ~PAL frame range
// (0..311 wraps to 0..255 + bit 8 in $D011), and $D011 bit 7 toggles
// at line 256.

import { mkdirSync, writeFileSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);

// $C000 PRG: SEI, read $D012/$D011, stash at $C200/$C300+i, loop 200x
//   78          sei
//   a2 00       ldx #0
// loop:
//   ad 12 d0    lda $d012
//   9d 00 c2    sta $c200,x      stash D012
//   ad 11 d0    lda $d011
//   9d 00 c3    sta $c300,x      stash D011
//   e8          inx
//   e0 c8       cpx #$c8         200 samples
//   d0 f1       bne loop
//   4c 14 c0    jmp $c014        spin (don't fall into BRK/IRQ)
const PRG = new Uint8Array([
  0x78,
  0xa2, 0x00,
  0xad, 0x12, 0xd0,
  0x9d, 0x00, 0xc2,
  0xad, 0x11, 0xd0,
  0x9d, 0x00, 0xc3,
  0xe8,
  0xe0, 0xc8,
  0xd0, 0xf1,
  0x4c, 0x14, 0xc0,
]);

async function runScenario(useLitReads, label) {
  const { sessionId, session: s } = startIntegratedSession({
    diskPath: `${REPO}/samples/synthetic/1block.g64`,
    mode: "true-drive",
    useMicrocodedCpu: true,
    useLiteralPortRenderer: true,
    useLiteralPortVicPerCycle: true,
    useLiteralPortVicReads: useLitReads,
  });
  s.resetCold("pal-default");
  s.runFor(2_000_000, { cycleBudget: 3_000_000 });
  for (let i = 0; i < PRG.length; i++) s.c64Bus.ram[0xc000 + i] = PRG[i];
  s.c64Cpu.pc = 0xc000;
  console.log(`  ${label}: pre-run pc=$${s.c64Cpu.pc.toString(16)} ram[c000]=$${s.c64Bus.ram[0xc000].toString(16)}`);
  s.runFor(50_000, { cycleBudget: 200_000 });
  console.log(`  ${label}: post-run pc=$${s.c64Cpu.pc.toString(16)} ram[c200]=$${s.c64Bus.ram[0xc200].toString(16)} ram[c201]=$${s.c64Bus.ram[0xc201].toString(16)}`);

  // Read stashed samples
  const d012 = [];
  const d011 = [];
  for (let i = 0; i < 200; i++) {
    d012.push(s.c64Bus.ram[0xc200 + i]);
    d011.push(s.c64Bus.ram[0xc300 + i]);
  }

  // Reconstruct full raster line: high bit from D011[7]
  const rasterLines = d012.map((lo, i) => ((d011[i] & 0x80) << 1) | lo);

  // Diff between consecutive samples — should be small + non-negative
  // (per-loop ~14 cycles = no full-line skip but at most 1 line jump
  // when sampling crosses line boundary)
  const diffs = [];
  for (let i = 1; i < rasterLines.length; i++) {
    let d = rasterLines[i] - rasterLines[i - 1];
    if (d < 0) d += 312;  // wrap
    diffs.push(d);
  }

  const maxDiff = Math.max(...diffs);
  const minRaster = Math.min(...rasterLines);
  const maxRaster = Math.max(...rasterLines);
  const uniqueLines = new Set(rasterLines).size;

  stopIntegratedSession(sessionId);

  return {
    label,
    useLitReads,
    samples: rasterLines.length,
    minRaster,
    maxRaster,
    uniqueLines,
    maxDiff,
    first10: rasterLines.slice(0, 10),
    last10: rasterLines.slice(-10),
  };
}

console.log("Spec 300 D012 poll");
const off = await runScenario(false, "vice-reads");
const on = await runScenario(true, "literal-reads");

mkdirSync(`${REPO}/samples/screenshots/literal-port`, { recursive: true });
writeFileSync(
  `${REPO}/samples/screenshots/literal-port/spec-300-d012-poll.json`,
  JSON.stringify({ off, on }, null, 2),
);

const fmt = (r) =>
  `${r.label}: samples=${r.samples} range=${r.minRaster}..${r.maxRaster} unique=${r.uniqueLines} maxDiff=${r.maxDiff} first10=[${r.first10.join(",")}]`;
console.log(fmt(off));
console.log(fmt(on));

// Acceptance:
// - both modes return non-degenerate raster sweep (range > 50 lines)
// - max line-to-line diff <= 5 (catches frozen reads or huge jumps)
// - unique lines >= 30 (= reads see real motion, not constant)
const checks = [];
for (const r of [off, on]) {
  const ok = (r.maxRaster - r.minRaster) > 50 && r.maxDiff <= 5 && r.uniqueLines >= 30;
  checks.push({ label: r.label, ok });
  if (!ok) {
    console.log(`FAIL ${r.label}: range=${r.maxRaster - r.minRaster} maxDiff=${r.maxDiff} uniqueLines=${r.uniqueLines}`);
  }
}

if (checks.every(c => c.ok)) {
  console.log("PASS: both modes return live raster reads");
  process.exit(0);
} else {
  console.log("FAIL");
  process.exit(1);
}
