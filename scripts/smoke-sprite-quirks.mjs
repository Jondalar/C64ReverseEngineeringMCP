#!/usr/bin/env node
// Spec 291 — sprite quirks smoke (Y-crunch + self-collision + DMA bytes).

import { resolve as resolvePath } from "node:path";
const REPO = resolvePath(import.meta.dirname, "..");
const m = await import(`${REPO}/dist/runtime/headless/vic/sprite-quirks.js`);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 291 sprite quirks smoke ===\n");

// 1. Y-expansion flop init.
const s = m.createSpriteYCrunchState();
check("expandYFlop init all false",
  s.expandYFlop.every(b => b === false));
check("crunched init all false",
  s.crunched.every(b => b === false));

// 2. updateSpriteYExpansionFlops toggles for expanded sprites.
m.updateSpriteYExpansionFlops(s, 0xff);  // all expanded
check("after toggle line 1: flops all true",
  s.expandYFlop.every(b => b === true));

m.updateSpriteYExpansionFlops(s, 0xff);
check("after toggle line 2: flops all false (= toggled twice)",
  s.expandYFlop.every(b => b === false));

m.updateSpriteYExpansionFlops(s, 0x00); // none expanded
check("non-expanded sprites: flops reset to false",
  s.expandYFlop.every(b => b === false));

// 3. Y-crunch detection: disable-while-skipping at cycle 15.
const s2 = m.createSpriteYCrunchState();
m.updateSpriteYExpansionFlops(s2, 0x01); // sprite 0 expanded
// Now flop[0] = true (= skipping next row)
check("sprite 0 flop = true after expand", s2.expandYFlop[0]);

m.checkYCrunch(s2, 0x01, 0x00, 15); // disable at cycle 15
check("disable while flop=true at cyc 15 → crunched[0] = true",
  s2.crunched[0] === true);

const s3 = m.createSpriteYCrunchState();
m.updateSpriteYExpansionFlops(s3, 0x01);
m.checkYCrunch(s3, 0x01, 0x00, 14); // wrong cycle
check("disable at non-cyc-15 → no crunch",
  s3.crunched[0] === false);

const s4 = m.createSpriteYCrunchState();
// flop[0] = false; disabling shouldn't crunch
m.checkYCrunch(s4, 0x01, 0x00, 15);
check("disable while flop=false → no crunch",
  s4.crunched[0] === false);

// 4. Self-collision helper exists.
const sc = m.detectSelfCollision(0x04);
check("detectSelfCollision returns hitMask (= bit 2 for sprite 2)",
  sc === 0x04);

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
