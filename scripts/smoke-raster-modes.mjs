#!/usr/bin/env node
// Spec 289 — raster_modes_t state machine smoke.

import { resolve as resolvePath } from "node:path";
const REPO = resolvePath(import.meta.dirname, "..");
const m = await import(`${REPO}/dist/runtime/headless/vic/raster-state.js`);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 289 raster_modes_t smoke ===\n");

const state = m.createEmptyRasterState();
state.vertical_ff = true;
state.horizontal_ff = false;
state.den = true;
check("vertical_ff set → mode = border", m.deriveRasterMode(state) === "border");

state.vertical_ff = false;
state.horizontal_ff = true;
check("horizontal_ff set → mode = border", m.deriveRasterMode(state) === "border");

state.vertical_ff = false;
state.horizontal_ff = false;
state.den = true;
check("FFs off + DEN → mode = display", m.deriveRasterMode(state) === "display");

state.den = false;
check("FFs off + !DEN → mode = idle", m.deriveRasterMode(state) === "idle");

// updateVerticalFFAtLineStart sets raster_mode side-effectively.
state.den = true;
state.display_ystart = 51;
state.display_ystop = 251;
state.vertical_ff = true;
m.updateVerticalFFAtLineStart(state, 51);  // entering display
check("line 51 + DEN → vertical_ff cleared",
  state.vertical_ff === false);
check("...and raster_mode = display",
  state.raster_mode === "display");

m.updateVerticalFFAtLineStart(state, 251); // entering bottom border
check("line 251 → vertical_ff set",
  state.vertical_ff === true);
check("...and raster_mode = border",
  state.raster_mode === "border");

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
