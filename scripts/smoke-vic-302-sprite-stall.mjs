#!/usr/bin/env node
// Spec 302 synthetic sprite DMA stall test.
//
// Enable sprite 0 ($D015 bit 0), set sprite 0 Y to current raster line,
// run a few cycles. Confirm literal port sees sprite_dma bit 0 set in
// its state, indicating the sprite DMA cycle path is being entered.
//
// Goal: prove literal port produces the BA-low signal for sprite DMA
// when wired through the per-cycle hook.

import { mkdirSync, writeFileSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);

console.log("Spec 302 synthetic sprite stall test");

const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
  useLiteralPortRenderer: true,
  useLiteralPortVicPerCycle: true,
  useLiteralPortVicReads: false,
  useLiteralPortVicIrq: false,
  useLiteralPortVicStall: true,
  usePerCycleBusStealing: true,
  useCycleLockstep: true,
});
s.resetCold("pal-default");
s.runFor(2_000_000, { cycleBudget: 3_000_000 });

// Enable sprite 0 with Y=80 (= within visible range, far enough into
// frame to settle).
s.c64Bus.write(0xd001, 80);  // sprite 0 Y
s.c64Bus.write(0xd000, 100); // sprite 0 X
s.c64Bus.write(0xd015, 0x01); // enable sprite 0

// Run multiple frames; sample sprite_dma bit each slice.
let spriteDmaSeen = 0;
const SLICES = 1000;
for (let i = 0; i < SLICES; i++) {
  s.runFor(50, { cycleBudget: 200 });
  if (LIT_TYPES.vicii.sprite_dma & 0x01) spriteDmaSeen++;
}

stopIntegratedSession(sessionId);

const out = { spriteDmaSeen, samples: SLICES };
mkdirSync(`${REPO}/samples/screenshots/literal-port`, { recursive: true });
writeFileSync(
  `${REPO}/samples/screenshots/literal-port/spec-302-sprite-stall.json`,
  JSON.stringify(out, null, 2),
);
console.log(`sprite_dma sample hits: ${spriteDmaSeen}/${SLICES}`);

// Sprite DMA only active for ~1 line per frame per sprite when Y matches.
// Over 1000 slices spanning many frames, expect at least handful of hits.
const ok = spriteDmaSeen > 2;
console.log(`  ${ok ? "PASS" : "FAIL"}: sprite_dma observed (>2 samples)`);
process.exit(ok ? 0 : 1);
