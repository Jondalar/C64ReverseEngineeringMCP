// Spec 150 — VIC-II sprite DMA cycle-counting unit tests.
//
// VICE source:
//   - vicii-fetch.c check_sprite_dma (line 267-309) — picks sprites
//     whose Y matches current line and that are in visible_msk.
//   - vicii-fetch.c handle_check_sprite_dma (line 311) — schedules
//     pointer-fetch + 1 s-access slot per active sprite.
//   - vicii-fetch.c handle_fetch_sprite (line 371) — charges
//     `num_cycles = sf->num` per slot; sprite-fetch table allocates
//     2 cycles per sprite.
//
// Run:
//   npx tsx tests/unit/vic/vic-sprite-dma.test.ts

import { strict as assert } from "node:assert";
import { makeTestVic } from "./vic-test-helpers.js";
import {
  VICII_PAL_CYCLES_PER_LINE,
  VICII_R_CTRL1,
  VICII_R_SP_ENABLE,
  VICII_R_SP_Y_BASE,
  VICII_SPRITE_DMA_FIXED_CYCLES,
  VICII_SPRITE_DMA_PER_SPRITE_CYCLES,
} from "../../../src/runtime/headless/vic/vic-ii-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function setSpriteY(vic: ReturnType<typeof makeTestVic>["vic"], idx: number, y: number): void {
  vic.write(VICII_R_SP_Y_BASE + idx * 2, y);
}

function tickToLine(vic: ReturnType<typeof makeTestVic>["vic"], clk: { v: number }, target: number): void {
  while (vic.raster_y !== target) {
    vic.tick(VICII_PAL_CYCLES_PER_LINE);
    clk.v += VICII_PAL_CYCLES_PER_LINE;
  }
}

// VICE: check_sprite_dma line 274 — early-out when no sprite enabled.
// No fixed pointer-fetch cycles when zero active sprites.
test("no sprite enabled → 0 sprite-DMA stolen", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_SP_ENABLE, 0); // all off
  // Skip badline contamination: keep DEN=0 so no badline fires.
  vic.write(VICII_R_CTRL1, 0); // DEN=0
  for (let i = 0; i < 50; i++) {
    vic.tick(VICII_PAL_CYCLES_PER_LINE);
    clk.v += VICII_PAL_CYCLES_PER_LINE;
  }
  // Filter to non-43-cycle steals (badline). All steals here are
  // sprite-only.
  const spriteSteals = events.steals.filter((s) => s.count !== 0);
  assert.equal(spriteSteals.length, 0);
});

// VICE: 1 active sprite → fixed-3 + 2 = 5 cycles stolen on the line
// the sprite Y matches.
test("1 active sprite at Y=50 → 5 stolen cycles on line 50", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0); // DEN=0 to avoid badline noise
  vic.write(VICII_R_SP_ENABLE, 0x01);
  setSpriteY(vic, 0, 50);
  tickToLine(vic, clk, 50);
  events.steals.length = 0;
  vic.tick(VICII_PAL_CYCLES_PER_LINE);
  clk.v += VICII_PAL_CYCLES_PER_LINE;
  // Now raster_y === 51, the line entry triggered the line-50 steal
  // computation. Wait — line steal is computed when entering the NEW
  // line, so the steal we see on this tick is for line 51, not 50.
  // Let's instead set up to enter line 50 fresh.
  // Reset & redo:
  const setup = makeTestVic();
  setup.vic.write(VICII_R_CTRL1, 0);
  setup.vic.write(VICII_R_SP_ENABLE, 0x01);
  setSpriteY(setup.vic, 0, 50);
  tickToLine(setup.vic, setup.clk, 49); // before crossing into 50
  setup.events.steals.length = 0;
  // Cross into line 50: tick 1 full line.
  setup.vic.tick(VICII_PAL_CYCLES_PER_LINE);
  setup.clk.v += VICII_PAL_CYCLES_PER_LINE;
  // raster_y is now 50; entry triggered line-50 steal computation.
  const expected = VICII_SPRITE_DMA_FIXED_CYCLES + VICII_SPRITE_DMA_PER_SPRITE_CYCLES;
  assert.equal(setup.events.steals.length, 1);
  assert.equal(setup.events.steals[0]!.count, expected, `expected ${expected}, got ${setup.events.steals[0]!.count}`);
});

// VICE: 8 active sprites all matching → fixed-3 + 16 = 19 cycles stolen.
test("8 active sprites all at Y=70 → 19 stolen cycles", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0);
  vic.write(VICII_R_SP_ENABLE, 0xff);
  for (let s = 0; s < 8; s++) setSpriteY(vic, s, 70);
  tickToLine(vic, clk, 69);
  events.steals.length = 0;
  vic.tick(VICII_PAL_CYCLES_PER_LINE);
  clk.v += VICII_PAL_CYCLES_PER_LINE;
  const expected = VICII_SPRITE_DMA_FIXED_CYCLES + VICII_SPRITE_DMA_PER_SPRITE_CYCLES * 8;
  assert.equal(expected, 19);
  assert.equal(events.steals[0]!.count, expected, `expected ${expected}, got ${events.steals[0]?.count}`);
});

// VICE: sprite DMA ONLY on Y-match line — adjacent line not stolen.
test("sprite DMA only on Y-match line, not adjacent", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0);
  vic.write(VICII_R_SP_ENABLE, 0x01);
  setSpriteY(vic, 0, 80);
  tickToLine(vic, clk, 81); // raster_y now 81, past the match.
  events.steals.length = 0;
  vic.tick(VICII_PAL_CYCLES_PER_LINE);
  clk.v += VICII_PAL_CYCLES_PER_LINE;
  // raster_y now 82 — no sprite Y match, no steal.
  assert.equal(events.steals.length, 0);
});

// VICE: disabled sprite ignored even if Y matches.
test("disabled sprite ignored on Y-match", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0);
  vic.write(VICII_R_SP_ENABLE, 0x00); // all off
  for (let s = 0; s < 8; s++) setSpriteY(vic, s, 100);
  tickToLine(vic, clk, 99);
  events.steals.length = 0;
  vic.tick(VICII_PAL_CYCLES_PER_LINE);
  clk.v += VICII_PAL_CYCLES_PER_LINE;
  assert.equal(events.steals.length, 0);
});

// VICE: sprite_fetch_msk reflects active sprites for the current line.
test("sprite_fetch_msk reflects active sprites on Y-match line", () => {
  const { vic, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0);
  vic.write(VICII_R_SP_ENABLE, 0x05); // sprites 0+2
  setSpriteY(vic, 0, 60);
  setSpriteY(vic, 2, 60);
  tickToLine(vic, clk, 60);
  // raster_y=60 — fetch mask should be 0x05.
  assert.equal(vic.sprite_fetch_msk, 0x05);
  // Step to line 61: no Y-match → mask cleared.
  vic.tick(VICII_PAL_CYCLES_PER_LINE);
  clk.v += VICII_PAL_CYCLES_PER_LINE;
  assert.equal(vic.sprite_fetch_msk, 0);
});

// VICE: badline + sprite-DMA combine — total stolen = 43 + 5 for one
// sprite at the same line.
test("badline + 1 sprite DMA on same line → 48 stolen cycles", () => {
  const { vic, events, clk } = makeTestVic();
  // Set DEN=1 ysmooth=0 → badlines at 0x30, 0x38, ...
  vic.write(VICII_R_CTRL1, 0x10);
  vic.write(VICII_R_SP_ENABLE, 0x01);
  setSpriteY(vic, 0, 0x30);
  tickToLine(vic, clk, 0x2f);
  events.steals.length = 0;
  vic.tick(VICII_PAL_CYCLES_PER_LINE);
  clk.v += VICII_PAL_CYCLES_PER_LINE;
  // Total = 43 + 3 + 2 = 48.
  assert.equal(events.steals.length, 1);
  assert.equal(events.steals[0]!.count, 48);
});

// ---- runner ----
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nvic-sprite-dma: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
