#!/usr/bin/env node
// Spec 297j smoke — border state machine.

import {
  newBorderState, resetBorderState,
  vertBorderRange, onLineStartBorder, applyMainBorderCheck, isInBorder,
} from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/vic/border-state.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-297j-border-state");

// vertBorderRange
ok("RSEL=1 → top=51 bottom=250",
   vertBorderRange(true).top === 51 && vertBorderRange(true).bottom === 250);
ok("RSEL=0 → top=55 bottom=246",
   vertBorderRange(false).top === 55 && vertBorderRange(false).bottom === 246);

// init
{
  const s = newBorderState();
  ok("init: vertical+main border both true", s.verticalBorder && s.mainBorder);
}

// vertical border: top edge with DEN=1 → opens
{
  const s = newBorderState();
  // RSEL=1 (D011 bit 3) + DEN=1 (bit 4)
  onLineStartBorder(s, 51, 0x18);
  ok("y=51 + RSEL=1 + DEN=1 → vertical opens", s.verticalBorder === false);
}

// vertical border: top edge with DEN=0 → stays closed
{
  const s = newBorderState();
  onLineStartBorder(s, 51, 0x08); // RSEL=1, DEN=0
  ok("y=51 + DEN=0 → vertical stays closed", s.verticalBorder === true);
}

// vertical border: bottom edge → closes again
{
  const s = newBorderState();
  s.verticalBorder = false;
  onLineStartBorder(s, 250, 0x18);
  ok("y=250 + RSEL=1 → vertical closes", s.verticalBorder === true);
}

// main border: cycle 17 phi2 + CSEL=1 → opens
{
  const s = newBorderState();
  s.verticalBorder = false; s.mainBorder = true;
  applyMainBorderCheck(s, 17, "phi2", 0x08); // CSEL=1
  ok("cycle 17 Φ2 + CSEL=1 → main opens", s.mainBorder === false);
}

// main border: cycle 18 phi2 + CSEL=0 → opens
{
  const s = newBorderState();
  s.verticalBorder = false; s.mainBorder = true;
  applyMainBorderCheck(s, 18, "phi2", 0x00); // CSEL=0
  ok("cycle 18 Φ2 + CSEL=0 → main opens", s.mainBorder === false);
}

// main border: cycle 56 phi2 + CSEL=0 → closes
{
  const s = newBorderState();
  s.verticalBorder = false; s.mainBorder = false;
  applyMainBorderCheck(s, 56, "phi2", 0x00);
  ok("cycle 56 Φ2 + CSEL=0 → main closes", s.mainBorder === true);
}

// main border: cycle 57 phi2 + CSEL=1 → closes
{
  const s = newBorderState();
  s.verticalBorder = false; s.mainBorder = false;
  applyMainBorderCheck(s, 57, "phi2", 0x08);
  ok("cycle 57 Φ2 + CSEL=1 → main closes", s.mainBorder === true);
}

// vertical lock: when verticalBorder=true, main can't open
{
  const s = newBorderState();
  s.verticalBorder = true; s.mainBorder = false;
  applyMainBorderCheck(s, 17, "phi2", 0x08);
  ok("vertical lock: main forced true even with cycle 17 + CSEL=1",
     s.mainBorder === true);
}

// isInBorder: any flag → in border
{
  const s = newBorderState();
  s.verticalBorder = false; s.mainBorder = false;
  ok("both clear → not in border", isInBorder(s) === false);
  s.mainBorder = true;
  ok("main set → in border", isInBorder(s) === true);
  s.mainBorder = false; s.verticalBorder = true;
  ok("vertical set → in border", isInBorder(s) === true);
}

// reset
{
  const s = newBorderState();
  s.verticalBorder = false; s.mainBorder = false;
  resetBorderState(s);
  ok("reset → both true", s.verticalBorder && s.mainBorder);
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
