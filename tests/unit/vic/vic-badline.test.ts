// Spec 150 — VIC-II badline detection unit tests.
//
// VICE source: vicii-fetch.c do_matrix_fetch line 145..167; vicii-
// badline.c vicii_badline_check_state line 185.
//
// Run:
//   npx tsx tests/unit/vic/vic-badline.test.ts

import { strict as assert } from "node:assert";
import { makeTestVic } from "./vic-test-helpers.js";
import {
  VICII_BADLINE_TOTAL_CYCLES,
  VICII_FIRST_DMA_LINE,
  VICII_LAST_DMA_LINE,
  VICII_PAL_CYCLES_PER_LINE,
  VICII_R_CTRL1,
} from "../../../src/runtime/headless/vic/vic-ii-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

/** Tick the VIC for N full lines, advancing clk in lockstep. */
function advanceLines(vic: ReturnType<typeof makeTestVic>["vic"], clk: { v: number }, lines: number): void {
  for (let i = 0; i < lines; i++) {
    vic.tick(VICII_PAL_CYCLES_PER_LINE);
    clk.v += VICII_PAL_CYCLES_PER_LINE;
  }
}

// VICE: do_matrix_fetch — badline iff allow_bad_lines (DEN seen at
// first_dma_line) && (current_line & 7) == ysmooth && in
// [first_dma_line..last_dma_line]. Charge VICII_SCREEN_TEXTCOLS + 3
// stolen cycles.
test("DEN=1 + ysmooth=0 → badline at line 0x30 charges 43 stolen cycles", () => {
  const { vic, events, clk } = makeTestVic();
  // Set DEN=1, ysmooth=0.
  vic.write(VICII_R_CTRL1, 0x10);
  // Advance to line 0x30. Total stolen seen across the run will only
  // include the badlines we hit — 0x30, 0x38, 0x40, ...
  advanceLines(vic, clk, VICII_FIRST_DMA_LINE + 1); // step past 0x30

  // events.steals should contain at least one entry of size 43.
  const has43 = events.steals.some((s) => s.count === VICII_BADLINE_TOTAL_CYCLES);
  assert.ok(has43, `expected a steal of ${VICII_BADLINE_TOTAL_CYCLES} cycles, got ${JSON.stringify(events.steals)}`);
});

// VICE: DEN=0 → allow_bad_lines stays 0 → no badline ever.
test("DEN=0 → no badline regardless of raster line", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0x00); // DEN=0.
  advanceLines(vic, clk, VICII_FIRST_DMA_LINE + 16);
  const has43 = events.steals.some((s) => s.count === VICII_BADLINE_TOTAL_CYCLES);
  assert.ok(!has43, "no 43-cycle steal expected when DEN=0");
});

// VICE: badline cadence: every 8 lines while ysmooth fixed.
test("ysmooth=0 → badline every 8 lines starting 0x30", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0x10);
  // Run from line 0 to line 0x40 (covers 0x30 + 0x38).
  advanceLines(vic, clk, 0x41);
  const badLineSteals = events.steals.filter((s) => s.count === VICII_BADLINE_TOTAL_CYCLES);
  assert.ok(badLineSteals.length >= 2, `expected ≥2 badlines (0x30, 0x38), got ${badLineSteals.length}`);
});

// VICE: badline only on lines [first_dma_line..last_dma_line]. Line
// 0x28 (40) is outside.
test("ysmooth=0 → no badline on line 0x28 (below first_dma_line)", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0x10);
  // Run lines 0..0x2f only (raster_y ends at 0x2f, just BEFORE the
  // first_dma_line check would set allow_bad_lines).
  advanceLines(vic, clk, 0x2f);
  const has43 = events.steals.some((s) => s.count === VICII_BADLINE_TOTAL_CYCLES);
  assert.ok(!has43, "no 43-cycle steal expected before first_dma_line");
});

// VICE: badline stops past last_dma_line (0xf7 = 247).
test("no badline past last_dma_line (line 0xf8)", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0x10);
  // Run 248 lines, then capture next line's steal events to compare.
  advanceLines(vic, clk, VICII_LAST_DMA_LINE + 1);
  events.steals.length = 0; // reset capture.
  // Advance one more line: 0xf8.
  advanceLines(vic, clk, 1);
  // raster_y now 0xf8 — must NOT be a badline.
  const has43 = events.steals.some((s) => s.count === VICII_BADLINE_TOTAL_CYCLES);
  assert.ok(!has43, "no badline at raster_y=0xf8");
});

// VICE: ysmooth=3 → badline cadence shifts by 3.
test("ysmooth=3 → badline at line 0x33 (0x30 + 3)", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0x10 | 0x03); // DEN=1, ysmooth=3.
  advanceLines(vic, clk, 0x34); // through line 0x33.
  const has43 = events.steals.some((s) => s.count === VICII_BADLINE_TOTAL_CYCLES);
  assert.ok(has43, "expected badline at line 0x33 with ysmooth=3");
});

// VICE: bad_line flag exposed for cycle-stealing internal state.
test("bad_line flag becomes 1 on badline tick, 0 otherwise", () => {
  const { vic, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0x10); // DEN=1, ysmooth=0.
  // Walk to line 0x30.
  advanceLines(vic, clk, VICII_FIRST_DMA_LINE);
  // Now raster_y === 0x30. tick one more line worth, mid-line we have
  // bad_line=1 because line 0x30 with ysmooth=0 IS a badline.
  // We need to capture the flag BEFORE the wrap clears it. Step a partial
  // line and check.
  vic.tick(1);
  clk.v += 1;
  // bad_line is set during computeLineSteal at line entry — at this
  // moment we're inside line 0x30 and the flag holds 1.
  assert.equal(vic.bad_line, 1);
  // Step to line 0x31 (not a badline).
  vic.tick(VICII_PAL_CYCLES_PER_LINE);
  clk.v += VICII_PAL_CYCLES_PER_LINE;
  assert.equal(vic.bad_line, 0);
});

// VICE: writing $D011 with new ysmooth recomputes future badlines.
test("$D011 write changing ysmooth changes future badline cadence", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_CTRL1, 0x10); // DEN=1, ysmooth=0.
  advanceLines(vic, clk, 0x30); // up to line 0x30 boundary.
  events.steals.length = 0;
  vic.write(VICII_R_CTRL1, 0x10 | 0x05); // change ysmooth=5.
  // Walk lines: 0x35 should now be a badline.
  advanceLines(vic, clk, 6);
  const has43 = events.steals.some((s) => s.count === VICII_BADLINE_TOTAL_CYCLES);
  assert.ok(has43, "expected badline at new ysmooth cadence");
});

// ---- runner ----
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nvic-badline: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
