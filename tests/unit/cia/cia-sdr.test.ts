// Spec 145 — CIA SDR (serial port shift register) tests.
//
// Covers VICE 3.7.1 ciacore.c:
//   - sdr_delay mercury delay-line bit layout (lines 79-123)
//   - ciacore_intsdr (lines 1723-1830) — per-cycle alarm callback
//   - schedule_sdr_alarm (lines 1709-1713)
//   - strange_extra_sdr_flags (lines 690-737)
//   - ciacore_set_cnt (lines 1649-1695)
//
// Run via:
//   npx tsx tests/unit/cia/cia-sdr.test.ts

import { strict as assert } from "node:assert";
import {
  CIA_SDR_CNT0, CIA_SDR_CNT1, CIA_SDR_CNT2, CIA_SDR_CNT3,
  CIA_SDR_TOGGLE_CNT0, CIA_SDR_SET0, CIA_SDR_SET1, CIA_SDR_SET2, CIA_SDR_SET3,
  CIA_SDR_SET_SDR_IRQ0, CIA_SDR_SET_SDR_IRQ2,
  CIA_SDR_LEFTMOST, CIA_SDR_CLEAR, CIA_SDR_ACTIVE,
  ALL_SDR_CNT,
  makeSdrState, sdrTickCallback, scheduleSdrFeed,
  setSdrExternal, setCntExternal, strangeExtraSdrFlags,
} from "../../../src/runtime/headless/cia/cia-sdr.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ---- Initial state --------------------------------------------------------

// VICE: ciacore_reset (line 643) — sdr_delay seeds CNT history all-1s.
test("makeSdrState seeds CNT history bits = ALL_SDR_CNT", () => {
  const sdr = makeSdrState();
  assert.equal(sdr.sdr_delay & ALL_SDR_CNT, ALL_SDR_CNT);
});

test("makeSdrState: sr_bits=0, sdr_valid=false, shifter=0, cnt_out_state=true", () => {
  const sdr = makeSdrState();
  assert.equal(sdr.sr_bits, 0);
  assert.equal(sdr.sdr_valid, false);
  assert.equal(sdr.shifter, 0);
  assert.equal(sdr.cnt_out_state, true);
});

// ---- scheduleSdrFeed ------------------------------------------------------

// VICE: schedule_sdr_alarm (lines 1709-1713) — OR feed bits into delay.
test("scheduleSdrFeed ORs feed bits into sdr_delay", () => {
  const sdr = makeSdrState();
  const before = sdr.sdr_delay;
  scheduleSdrFeed(sdr, CIA_SDR_SET2);
  assert.equal(sdr.sdr_delay, (before | CIA_SDR_SET2) >>> 0);
});

// ---- sdrTickCallback shift mechanics --------------------------------------

// VICE: line 1810-1814 — sdr_delay <<= 1; &= ~CIA_SDR_CLEAR; |= CNT0
// when cnt_out_state.
test("sdrTickCallback: shifts sdr_delay LEFT and clears fence bits", () => {
  const sdr = makeSdrState();
  const cCia = new Uint8Array(16);
  // Set SET3 (highest of SET ladder) — after one tick, becomes SET2.
  sdr.sdr_delay = CIA_SDR_SET3;
  sdrTickCallback(sdr, cCia, 12);
  // SET3 (0x10000) << 1 = 0x20000 = SET2.
  assert.equal(sdr.sdr_delay & CIA_SDR_SET2, CIA_SDR_SET2);
  // SET3 itself should be cleared (CIA_SDR_CLEAR includes SET3).
  assert.equal(sdr.sdr_delay & CIA_SDR_SET3, 0);
});

// VICE: line 1804-1807 — SET_SDR_IRQ0 → return.setSdrIrq = true.
test("sdrTickCallback: SET_SDR_IRQ0 in delay raises setSdrIrq", () => {
  const sdr = makeSdrState();
  const cCia = new Uint8Array(16);
  sdr.sdr_delay = CIA_SDR_SET_SDR_IRQ0;
  const r = sdrTickCallback(sdr, cCia, 12);
  assert.equal(r.setSdrIrq, true);
});

// VICE: line 1736-1750 — SET0 with sr_bits=0 loads shifter from SDR.
test("sdrTickCallback: SET0 with sr_bits=0 loads shifter (<<1) from c_cia[SDR]", () => {
  const sdr = makeSdrState();
  const cCia = new Uint8Array(16);
  cCia[12] = 0xa5;
  sdr.sdr_delay = CIA_SDR_SET0;
  sdr.sr_bits = 0;
  sdrTickCallback(sdr, cCia, 12);
  assert.equal(sdr.sr_bits, 16);
  assert.equal(sdr.shifter, (0xa5 << 1) & 0xffff);
});

// VICE: line 1817-1829 — reschedule iff CIA_SDR_ACTIVE bit set OR mixed
// CNT history bits.
test("sdrTickCallback: reschedule=false when delay quiet", () => {
  const sdr = makeSdrState();
  const cCia = new Uint8Array(16);
  // sdr_delay starts with ALL_SDR_CNT (all 1s) — quiet steady state.
  const r = sdrTickCallback(sdr, cCia, 12);
  assert.equal(r.reschedule, false);
});

test("sdrTickCallback: reschedule=true when ACTIVE bit set", () => {
  const sdr = makeSdrState();
  const cCia = new Uint8Array(16);
  // Set SET2 (in ACTIVE mask). After tick, SET2→SET1 still ACTIVE.
  sdr.sdr_delay = CIA_SDR_SET2;
  const r = sdrTickCallback(sdr, cCia, 12);
  assert.equal(r.reschedule, true);
});

// ---- TOGGLE_CNT0 / shift-out path ----------------------------------------

// VICE: line 1762-1801 — TOGGLE_CNT0 with sr_bits even-after-decrement
// shifts shifter LEFT and raises CNT.
test("sdrTickCallback: TOGGLE_CNT0 with sr_bits=0 shifts << 1 and raises CNT", () => {
  const sdr = makeSdrState();
  const cCia = new Uint8Array(16);
  sdr.sdr_delay = CIA_SDR_TOGGLE_CNT0;
  sdr.sr_bits = 0;
  sdr.shifter = 0x55;
  sdr.cnt_out_state = false; // start low so we can detect rising edge
  const r = sdrTickCallback(sdr, cCia, 12);
  assert.equal(sdr.shifter, 0xaa, "shifter shifted left");
  assert.equal(sdr.cnt_out_state, true, "cnt_out raised");
  assert.deepEqual(r.cntChanged, { value: true });
});

// ---- setSdrExternal -------------------------------------------------------

// VICE: ciacore_set_sdr (lines 1631-1647) — only acts in SP-mode IN.
test("setSdrExternal in SP-mode IN: writes c_cia[SDR] and signals IRQ", () => {
  const sdr = makeSdrState();
  const cCia = new Uint8Array(16);
  // CRA bit 6 (SPMODE) = 0 → input.
  const r = setSdrExternal(sdr, cCia, 12, 0x00, 0x42);
  assert.equal(cCia[12], 0x42);
  assert.equal(r.signalIrq, true);
});

test("setSdrExternal in SP-mode OUT: no-op", () => {
  const sdr = makeSdrState();
  const cCia = new Uint8Array(16);
  const r = setSdrExternal(sdr, cCia, 12, 0x40, 0x42); // CRA bit 6 = 1 → output
  assert.equal(cCia[12], 0, "no write when output");
  assert.equal(r.signalIrq, false);
});

// ---- setCntExternal -------------------------------------------------------

// VICE: ciacore_set_cnt (lines 1649-1695). Falling edge with sr_bits=0
// sets sr_bits=16; rising edge shifts in 1 bit from sp_in_state.
test("setCntExternal: falling edge with sr_bits=0 latches sr_bits=16", () => {
  const sdr = makeSdrState();
  // sr_bits starts 0, cnt_in_state starts true.
  // Setting CNT to false (falling edge): VICE pre-decrements sr_bits.
  // sr_bits was 0 → set to 16, then decrement → 15.
  setCntExternal(sdr, 0x00, false);
  assert.equal(sdr.sr_bits, 15);
  assert.equal(sdr.cnt_in_state, false);
});

test("setCntExternal: rising edge in IN-mode shifts shifter << 1 + sp_in_state", () => {
  const sdr = makeSdrState();
  sdr.cnt_in_state = false; // start low
  sdr.sr_bits = 8;          // mid-byte
  sdr.sp_in_state = true;   // bit to shift in
  sdr.shifter = 0x42;
  setCntExternal(sdr, 0x00, true); // rise to high
  // sr_bits decremented to 7; shifter << 1 | 1 = 0x85.
  assert.equal(sdr.sr_bits, 7);
  assert.equal(sdr.shifter, 0x85);
  assert.equal(sdr.cnt_in_state, true);
});

// ---- strangeExtraSdrFlags -------------------------------------------------

// VICE: lines 690-737. Triggered when SP-mode bit toggles in CRA.
test("strangeExtraSdrFlags: schedule=true when sr_bits in (1,15)", () => {
  const sdr = makeSdrState();
  sdr.sr_bits = 5;
  const r = strangeExtraSdrFlags(sdr, 0x00); // changing to IN
  assert.equal(r.schedule, true);
  // SET_SDR_IRQ2 should be in delay.
  assert.equal(sdr.sdr_delay & CIA_SDR_SET_SDR_IRQ2, CIA_SDR_SET_SDR_IRQ2);
});

// ---- runner ---------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ncia-sdr: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
