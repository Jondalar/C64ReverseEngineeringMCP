#!/usr/bin/env node
// Spec 302 stall diff harness.
//
// Per CPU bus cycle, compare:
//   vice_stall = s.vic.getBusStallForCycle()
//   lit_stall  = literal port ba_low (sampled via direct vicii.bad_line +
//                cycle_flags computation — but easier to read public state
//                snapshot after each step).
//
// Aggregate per raster line: count of stalled cycles. Compare per-line
// totals; allow ±5 cycle delta tolerance to absorb pulse-edge alignment
// drift between block-priming (VicIIVice) vs per-cycle-decode (literal).
//
// Pass = max per-line aggregate delta ≤ 5 over 60 frames on BASIC ready.

import { mkdirSync, writeFileSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);
const LIT_CHIP = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-chip-model.js`);
const FETCH_BA_M = LIT_CHIP.FETCH_BA_M;
const SPRITE_BA_MASK_M = LIT_CHIP.SPRITE_BA_MASK_M;

const FRAMES = parseInt(process.env.FRAMES ?? "60", 10);
const TOTAL_CYC = FRAMES * 19656 + 50_000;

console.log(`Spec 302 stall diff — ${FRAMES} frames`);

// Run with literal stall OFF — diff harness reads VicIIVice via API,
// samples literal ba_low directly. Both run in parallel since
// per-cycle hook drives literal regardless.
const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
  useLiteralPortRenderer: true,
  useLiteralPortVicPerCycle: true,
  useLiteralPortVicReads: false,
  useLiteralPortVicIrq: false,
  useLiteralPortVicStall: false,
  usePerCycleBusStealing: true,
  useCycleLockstep: true,
});

s.resetCold("pal-default");
s.runFor(2_000_000, { cycleBudget: 3_000_000 });

// Per-line aggregate buckets for current frame.
const perLineVice = new Int32Array(312);
const perLineLit  = new Int32Array(312);

// Track worst per-line delta across all lines sampled.
const worstDeltas = []; // { line, vice, lit, delta }
let cumulativeVice = 0;
let cumulativeLit = 0;

// 1-instruction slice = closer to per-cycle sampling. ~5x slower but
// catches actual stall windows (badline matrix fetch is cycles 11..53).
const SLICE_INSTR = 1;
const SLICE_CYC = 8;
let elapsedCyc = 0;
let totalSlices = 0;

let lastSampleRasterY = -1;

// Cap by frames not raw cycles; finer sampling = many more slices.
const FRAME_CAP = FRAMES;
let frameCount = 0;
let lastRy = s.vic.raster_y & 0xff;

while (frameCount < FRAME_CAP) {
  const before = s.c64Cpu.cycles;
  s.runFor(SLICE_INSTR, { cycleBudget: SLICE_CYC });
  const after = s.c64Cpu.cycles;
  elapsedCyc += (after - before);
  totalSlices++;

  const ry = s.vic.raster_y & 0xff;
  if (ry === 0 && lastRy !== 0) frameCount++;
  lastRy = ry;

  const viceStall = s.vic.getBusStallForCycle();
  // Literal ba_low semantic = (bad_line && cycle_is_fetch_ba) ||
  //                          (sprite_dma & sprite_ba_mask).
  // Same predicate VicIIVice's bus-owner-table consults.
  const cf = LIT_TYPES.vicii.cycle_flags;
  const litStall =
    (LIT_TYPES.vicii.bad_line === 1 && (cf & FETCH_BA_M) !== 0) ||
    ((LIT_TYPES.vicii.sprite_dma & (cf & SPRITE_BA_MASK_M)) !== 0);

  if (ry !== lastSampleRasterY) {
    // Crossed line boundary — record + reset
    if (lastSampleRasterY >= 0 && lastSampleRasterY < 312) {
      const v = perLineVice[lastSampleRasterY];
      const l = perLineLit[lastSampleRasterY];
      const d = Math.abs(v - l);
      if (d > 5) worstDeltas.push({ line: lastSampleRasterY, vice: v, lit: l, delta: d });
      perLineVice[lastSampleRasterY] = 0;
      perLineLit[lastSampleRasterY]  = 0;
    }
    lastSampleRasterY = ry;
  }
  if (viceStall) { perLineVice[ry]++; cumulativeVice++; }
  if (litStall)  { perLineLit[ry]++;  cumulativeLit++; }
}

stopIntegratedSession(sessionId);

const totalVice = cumulativeVice;
const totalLit  = cumulativeLit;

mkdirSync(`${REPO}/samples/screenshots/literal-port`, { recursive: true });
writeFileSync(
  `${REPO}/samples/screenshots/literal-port/spec-302-stall-diff.json`,
  JSON.stringify({
    frames: FRAMES,
    totalSamplesVice: totalVice,
    totalSamplesLit: totalLit,
    worstDeltaCount: worstDeltas.length,
    worstFirst10: worstDeltas.slice(0, 10),
  }, null, 2),
);

console.log(`slices=${totalSlices} stall-hits vice=${totalVice} lit=${totalLit}`);
console.log(`per-line aggregate deltas > 5: ${worstDeltas.length}`);
if (worstDeltas.length > 0) {
  console.log("first 10 worst lines:");
  for (const w of worstDeltas.slice(0, 10)) {
    console.log(`  line=${w.line} vice=${w.vice} lit=${w.lit} delta=${w.delta}`);
  }
}

// Pass criterion: zero per-line deltas exceeding ±5 cycles.
// (Coarse sampling means we compare same-direction trends, not exact
// pulse counts; large deltas reveal disagreement on whether the line
// is stalling at all.)
if (worstDeltas.length === 0) {
  console.log("PASS: per-line aggregates within ±5");
  process.exit(0);
} else {
  console.log(`FAIL: ${worstDeltas.length} lines exceed ±5 delta`);
  process.exit(1);
}
