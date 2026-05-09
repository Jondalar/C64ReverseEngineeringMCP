#!/usr/bin/env node
// Spec 292 — VIC-II $D019 IRQ state machine smoke.

import { resolve as resolvePath } from "node:path";
const REPO = resolvePath(import.meta.dirname, "..");
const m = await import(`${REPO}/dist/runtime/headless/vic/vic-irq.js`);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 292 VIC-II IRQ smoke ===\n");

const s = m.createVicIrqState();
check("init: status=0", s.status === 0);
check("init: mask=0", s.mask === 0);
check("init: lineAsserted=false", !s.lineAsserted);

// 1. Raster IRQ flag set without mask → no line.
m.setRasterIrq(s);
check("raster IRQ set, mask=0 → status bit 0 set",
  (s.status & m.VICII_IRQ_RASTER) !== 0);
check("...summary bit 7 NOT set (= masked)",
  (s.status & m.VICII_IRQ_SUMMARY) === 0);
check("...lineAsserted=false (= masked)",
  s.lineAsserted === false);

// 2. Enable raster mask → summary + line assert.
m.setMask(s, m.VICII_IRQ_RASTER);
check("after mask=raster: summary bit 7 set",
  (s.status & m.VICII_IRQ_SUMMARY) !== 0);
check("...lineAsserted=true",
  s.lineAsserted === true);

// 3. Read $D019: returns 0x8f-masked + open-bus 0x70.
const r19 = m.readD019(s);
check("readD019 returns latched + summary + open-bus high",
  (r19 & 0x80) !== 0  // summary bit
  && (r19 & 0x01) !== 0  // raster bit
  && (r19 & 0x70) === 0x70,  // open-bus
  `got=0x${r19.toString(16)}`);

// 4. Write $D019 with bit 0 set → clears raster flag.
m.writeD019(s, 0x01);
check("writeD019(0x01) clears raster flag",
  (s.status & m.VICII_IRQ_RASTER) === 0);
check("...summary bit 7 also cleared (= no other src active)",
  (s.status & m.VICII_IRQ_SUMMARY) === 0);
check("...lineAsserted=false",
  s.lineAsserted === false);

// 5. Multiple sources independently latched.
m.setRasterIrq(s);
m.setSbCollIrq(s);
m.setSsCollIrq(s);
m.setLightPenIrq(s);
check("4 sources set: status bits 0..3 all set",
  (s.status & 0x0f) === 0x0f);

// Mask only sb-coll (bit 1) → only that drives summary
m.setMask(s, m.VICII_IRQ_SBCOLL);
check("mask=sbcoll only: summary set (sbcoll latched)",
  (s.status & m.VICII_IRQ_SUMMARY) !== 0);

// Clear sbcoll bit only
m.writeD019(s, m.VICII_IRQ_SBCOLL);
check("clear sbcoll → summary bit cleared",
  (s.status & m.VICII_IRQ_SUMMARY) === 0);
check("...other latched bits remain",
  (s.status & m.VICII_IRQ_RASTER) !== 0
  && (s.status & m.VICII_IRQ_SSCOLL) !== 0
  && (s.status & m.VICII_IRQ_LIGHTPEN) !== 0);

// 6. $D01A read returns mask | 0xf0.
const r1a = m.readD01A(s);
check("readD01A = mask | 0xf0",
  r1a === ((s.mask & 0x0f) | 0xf0),
  `got=0x${r1a.toString(16)}`);

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
