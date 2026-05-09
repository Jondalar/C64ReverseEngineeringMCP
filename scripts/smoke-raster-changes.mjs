#!/usr/bin/env node
// Spec 280a+b smoke — raster_changes lane infra + cycle→pixel mapping.

import { resolve } from "node:path";
const repoRoot = resolve(import.meta.dirname, "..");
const m = await import(`${repoRoot}/dist/runtime/headless/vic/raster-changes.js`);

const results = [];
function test(name, ok, detail = "") {
  results.push({ name, pass: ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
}

console.log("=== Spec 280a+b smoke ===\n");

// Cycle → pixel mapping (VICII_RASTER_X(cycle) = (cycle-17)*8 + 32)
test("cycleToPixelX(17) = 32 (start of 40-col display)",
  m.cycleToPixelX(17) === 32, `got ${m.cycleToPixelX(17)}`);
test("cycleToPixelX(18) = 40", m.cycleToPixelX(18) === 40);
test("cycleToPixelX(56) = 344 (= near end of 40-col display)",
  m.cycleToPixelX(56) === 344, `got ${m.cycleToPixelX(56)}`);
test("cycleToCharX(15) = 0 (first text col)",
  m.cycleToCharX(15) === 0);
test("cycleToCharX(54) = 39 (last text col)",
  m.cycleToCharX(54) === 39);

// Lane add — immediate vs queued vs next_line
const lane = m.emptyLaneSet();
const r1 = m.addBackgroundChange(lane, 0, "background_color", 5);
test("addBackground at cycle 0 → immediate (where ≤ 0)", r1 === "immediate");

const lane2 = m.emptyLaneSet();
const r2 = m.addBackgroundChange(lane2, 30, "background_color", 5);
test("addBackground at cycle 30 → queued",
  r2 === "queued" && lane2.background.length === 1 && lane2.background[0].where === m.cycleToPixelX(30));
test("addBackground sets haveOnThisLine", lane2.haveOnThisLine === true);

const lane3 = m.emptyLaneSet();
// cycle 76 → pixel = (76-17)*8+32 = 504 → past PAL line width
const r3 = m.addBackgroundChange(lane3, 76, "background_color", 5);
test("addBackground at cycle 76 → next_line (past 504 pixels)",
  r3 === "next_line" && lane3.nextLine.length === 1, `r=${r3}`);

// Foreground (char-x semantics)
const lane4 = m.emptyLaneSet();
const r4 = m.addForegroundChange(lane4, 25, "video_mode", 1);
test("addForeground at cycle 25 → queued at char 10",
  r4 === "queued" && lane4.foreground[0].where === 10);

// Sprite with index
const lane5 = m.emptyLaneSet();
m.addSpriteChange(lane5, 30, "sprite_x_n", 100, 3);
test("addSprite preserves spriteIndex",
  lane5.sprites[0].spriteIndex === 3 && lane5.sprites[0].value === 100);

// next_line direct
const lane6 = m.emptyLaneSet();
m.addNextLineChange(lane6, "screen_base_ptr", 0x2000);
test("addNextLineChange queues at where=0", lane6.nextLine[0].where === 0);

// Sort
const lane7 = m.emptyLaneSet();
m.addBackgroundChange(lane7, 50, "background_color", 1);
m.addBackgroundChange(lane7, 30, "background_color", 2);
m.addBackgroundChange(lane7, 40, "background_color", 3);
m.sortLaneByWhere(lane7.background);
test("sortLaneByWhere ascending",
  lane7.background[0].where < lane7.background[1].where &&
  lane7.background[1].where < lane7.background[2].where);

// REG_MAPPING coverage
test("REG_MAPPING d020 → border lane",
  m.REG_MAPPING[0x20]?.lane === "border");
test("REG_MAPPING d011 → next_line lane",
  m.REG_MAPPING[0x11]?.lane === "next_line");
test("REG_MAPPING d018 → next_line",
  m.REG_MAPPING[0x18]?.lane === "next_line");
test("REG_MAPPING d016 → next_line",
  m.REG_MAPPING[0x16]?.lane === "next_line");
test("REG_MAPPING d000 → sprites + sprite 0",
  m.REG_MAPPING[0x00]?.lane === "sprites" && m.REG_MAPPING[0x00]?.spriteIndex === 0);
test("REG_MAPPING d00e → sprites + sprite 7",
  m.REG_MAPPING[0x0e]?.spriteIndex === 7);
test("REG_MAPPING d027 → sprite_color_n + sprite 0",
  m.REG_MAPPING[0x27]?.field === "sprite_color_n" && m.REG_MAPPING[0x27]?.spriteIndex === 0);
test("REG_MAPPING d02e → sprite_color_n + sprite 7",
  m.REG_MAPPING[0x2e]?.spriteIndex === 7);

// Frame container
const fr = m.newFrameRasterChanges(312);
test("newFrameRasterChanges has 312 line entries",
  fr.perLine.length === 312);
test("frame carryToNextFrame starts empty",
  fr.carryToNextFrame.length === 0);

// clearLane resets per-line lanes but NOT nextLine
const lane8 = m.emptyLaneSet();
m.addBackgroundChange(lane8, 30, "background_color", 1);
m.addNextLineChange(lane8, "screen_base_ptr", 0x2000);
m.clearLane(lane8);
test("clearLane wipes background but keeps nextLine",
  lane8.background.length === 0 && lane8.nextLine.length === 1);

const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log(`\nSpec 280a+b foundation: ${pass}/${results.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
