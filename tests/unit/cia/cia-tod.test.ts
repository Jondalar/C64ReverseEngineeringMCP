// Spec 145 — CIA TOD (Time Of Day) tests.
//
// Covers VICE 3.7.1 ciacore.c:
//   - check_ciatodalarm (lines 236-242)
//   - TOD store path (lines 860-912)
//   - TOD read path / latch on HR / release on TEN (lines 1260-1276)
//   - ciacore_inttod (lines 1854-2003) — BCD increment, 50/60Hz divider
//
// Run via:
//   npx tsx tests/unit/cia/cia-tod.test.ts

import { strict as assert } from "node:assert";
import {
  CIA_TOD_TEN, CIA_TOD_SEC, CIA_TOD_MIN, CIA_TOD_HR,
  checkCiaTodAlarm, makeTodState, todRead, todStore, todTickCallback,
  CIA_CRA_TODIN_50HZ, CIA_CRB_ALARM_ALARM,
} from "../../../src/runtime/headless/cia/cia-tod.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ---- Read path ------------------------------------------------------------

// VICE: ciacore_read TOD (lines 1264-1276). Reading HR latches all 4;
// reading TEN releases.
test("read HR latches all 4 TOD bytes", () => {
  const tod = makeTodState();
  const cCia = new Uint8Array(16);
  cCia[CIA_TOD_TEN] = 0x05;
  cCia[CIA_TOD_SEC] = 0x30;
  cCia[CIA_TOD_MIN] = 0x45;
  cCia[CIA_TOD_HR] = 0x12;
  // First read of HR latches.
  assert.equal(todRead(tod, cCia, CIA_TOD_HR), 0x12);
  assert.equal(tod.todlatched, 1);
  // Now mutate registers; reads of MIN/SEC return latched values.
  cCia[CIA_TOD_MIN] = 0x99;
  assert.equal(todRead(tod, cCia, CIA_TOD_MIN), 0x45, "MIN returns latched 0x45");
  assert.equal(todRead(tod, cCia, CIA_TOD_SEC), 0x30, "SEC returns latched 0x30");
  // Reading TEN releases.
  assert.equal(todRead(tod, cCia, CIA_TOD_TEN), 0x05);
  assert.equal(tod.todlatched, 0);
});

// VICE: line 1271-1272 — reading HR sets latched=1.
test("reading non-HR/non-TEN does not change latched flag if already latched", () => {
  const tod = makeTodState();
  const cCia = new Uint8Array(16);
  cCia[CIA_TOD_HR] = 0x05;
  todRead(tod, cCia, CIA_TOD_HR); // latch
  todRead(tod, cCia, CIA_TOD_MIN);
  assert.equal(tod.todlatched, 1);
});

// ---- Store path -----------------------------------------------------------

// VICE: line 860-912 — CRB bit 7 selects time vs alarm target.
test("TOD store with CRB bit 7 = 0 writes time", () => {
  const tod = makeTodState();
  const cCia = new Uint8Array(16);
  // Per todReset, hr defaults to 1 — but here we don't call reset.
  todStore(tod, cCia, CIA_TOD_MIN, 0x45, 0x00);
  assert.equal(cCia[CIA_TOD_MIN], 0x45);
  assert.equal(tod.todalarm[2], 0, "alarm slot untouched");
});

test("TOD store with CRB bit 7 = 1 writes alarm", () => {
  const tod = makeTodState();
  const cCia = new Uint8Array(16);
  todStore(tod, cCia, CIA_TOD_MIN, 0x45, CIA_CRB_ALARM_ALARM);
  assert.equal(tod.todalarm[2], 0x45);
  assert.equal(cCia[CIA_TOD_MIN], 0, "time slot untouched");
});

// VICE: line 864-872 — HR write masks 0x9f, flips AM/PM on hour 12 only
// when writing time (not alarm).
test("HR write masks 0x9f and flips PM bit when writing 12 to time", () => {
  const tod = makeTodState();
  const cCia = new Uint8Array(16);
  // Write 0x12 to HR with CRB=0 (writing time).
  todStore(tod, cCia, CIA_TOD_HR, 0x12, 0x00);
  // Per VICE: when (byte & 0x1f) == 0x12 AND CRB_ALARM == TOD (=0),
  // byte ^= 0x80. Result: 0x92.
  assert.equal(cCia[CIA_TOD_HR], 0x92, "AM/PM flipped on hour 12");
});

test("HR write does NOT flip PM when writing alarm", () => {
  const tod = makeTodState();
  const cCia = new Uint8Array(16);
  todStore(tod, cCia, CIA_TOD_HR, 0x12, CIA_CRB_ALARM_ALARM);
  assert.equal(tod.todalarm[3], 0x12, "alarm HR stored verbatim, no PM flip");
});

// VICE: line 874-879 — masks for SEC, MIN, TEN.
test("SEC/MIN write masks to 0x7f", () => {
  const tod = makeTodState();
  const cCia = new Uint8Array(16);
  todStore(tod, cCia, CIA_TOD_SEC, 0xff, 0x00);
  assert.equal(cCia[CIA_TOD_SEC], 0x7f);
});

test("TEN write masks to 0x0f", () => {
  const tod = makeTodState();
  const cCia = new Uint8Array(16);
  todStore(tod, cCia, CIA_TOD_TEN, 0xff, 0x00);
  assert.equal(cCia[CIA_TOD_TEN], 0x0f);
});

// VICE: line 889-897 — writing TEN restarts ticking; writing HR stops.
test("HR write stops the clock; TEN write restarts", () => {
  const tod = makeTodState();
  const cCia = new Uint8Array(16);
  todStore(tod, cCia, CIA_TOD_HR, 0x05, 0x00);
  assert.equal(tod.todstopped, 1);
  todStore(tod, cCia, CIA_TOD_TEN, 0x00, 0x00);
  assert.equal(tod.todstopped, 0);
});

// ---- Alarm match ----------------------------------------------------------

// VICE: check_ciatodalarm (lines 236-242).
test("checkCiaTodAlarm: equal regs vs alarm → true", () => {
  const tod = makeTodState();
  const cCia = new Uint8Array(16);
  cCia[CIA_TOD_TEN] = 0x01;
  cCia[CIA_TOD_SEC] = 0x02;
  cCia[CIA_TOD_MIN] = 0x03;
  cCia[CIA_TOD_HR] = 0x04;
  tod.todalarm[0] = 0x01;
  tod.todalarm[1] = 0x02;
  tod.todalarm[2] = 0x03;
  tod.todalarm[3] = 0x04;
  assert.equal(checkCiaTodAlarm(tod, cCia), true);
});

test("checkCiaTodAlarm: differing regs → false", () => {
  const tod = makeTodState();
  const cCia = new Uint8Array(16);
  cCia[CIA_TOD_TEN] = 0x01;
  tod.todalarm[0] = 0x02;
  assert.equal(checkCiaTodAlarm(tod, cCia), false);
});

// ---- Tick callback (BCD advance) ------------------------------------------

// VICE: ciacore_inttod (lines 1854-2003). Each tick at 50Hz divides
// down to 10Hz via the 3-bit ring counter. We test the BCD increment
// directly by stuffing todtickcounter to the trigger value.
test("BCD tick advances tenths from 0 to 1 when ring counter triggers", () => {
  const tod = makeTodState();
  tod.todstopped = 0;
  // Set ring counter to 4 (50Hz match value).
  tod.todtickcounter = 4;
  const cCia = new Uint8Array(16);
  cCia[CIA_TOD_TEN] = 0x00;
  cCia[CIA_TOD_HR] = 0x01; // VICE post-reset value
  todTickCallback(tod, cCia, CIA_CRA_TODIN_50HZ, 1000);
  assert.equal(cCia[CIA_TOD_TEN], 0x01, "tenths incremented to 1");
});

// VICE: line 1908 — todstopped=1 freezes the divider AND the counter.
test("todstopped=1 freezes BCD even at trigger value", () => {
  const tod = makeTodState();
  tod.todstopped = 1;
  tod.todtickcounter = 4;
  const cCia = new Uint8Array(16);
  cCia[CIA_TOD_TEN] = 0x00;
  cCia[CIA_TOD_HR] = 0x01;
  todTickCallback(tod, cCia, CIA_CRA_TODIN_50HZ, 1000);
  assert.equal(cCia[CIA_TOD_TEN], 0x00, "tenths frozen");
});

// VICE: line 1951-1956 — tenths overflow at 10 → seconds increment.
test("tenths 9 → 0 cascades into seconds increment", () => {
  const tod = makeTodState();
  tod.todstopped = 0;
  tod.todtickcounter = 4;
  const cCia = new Uint8Array(16);
  cCia[CIA_TOD_TEN] = 0x09;
  cCia[CIA_TOD_SEC] = 0x00;
  cCia[CIA_TOD_HR] = 0x01;
  todTickCallback(tod, cCia, CIA_CRA_TODIN_50HZ, 1000);
  assert.equal(cCia[CIA_TOD_TEN], 0x00, "tenths wrapped");
  assert.equal(cCia[CIA_TOD_SEC], 0x01, "seconds += 1");
});

// VICE: line 1879 — todticks = ticks_per_sec / power_freq. Power_freq=0
// → early-return; todclk re-armed at +100000.
test("power_freq=0 → todclk re-armed at clk + 100000", () => {
  const tod = makeTodState();
  tod.power_freq = 0;
  const cCia = new Uint8Array(16);
  todTickCallback(tod, cCia, 0, 5000);
  assert.equal(tod.todclk, 5000 + 100000);
});

// ---- runner ---------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ncia-tod: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
