// Spec 145 — CIA register R/W unit tests.
//
// Tests exercise ciacore_store / ciacore_read paths through the public
// Cia6526Vice API. Each test cites VICE 3.7.1 ciacore.c line ranges.
//
// Run via:
//   npx tsx tests/unit/cia/cia-register-rw.test.ts

import { strict as assert } from "node:assert";
import {
  CIA_PRA, CIA_PRB, CIA_DDRA, CIA_DDRB,
  CIA_TAL, CIA_TAH, CIA_TBL, CIA_TBH,
  CIA_CRA, CIA_CRB, CIA_ICR, CIA_SDR,
  CIA_CR_START,
} from "../../../src/runtime/headless/cia/cia6526-vice.js";
import { makeTestCia } from "./cia-test-helpers.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ---- Reset state ----------------------------------------------------------

// VICE: ciacore_reset (ciacore.c lines 626-685). All 16 regs zero except
// CIA_TOD_HR=1 (bug #1143). irqflags, ifr_delay, masks all zero.
test("reset: c_cia register file clear except TOD HR=1", () => {
  const { cia } = makeTestCia();
  for (let i = 0; i < 16; i++) {
    if (i === 11) {
      assert.equal(cia.c_cia[i], 1, "CIA_TOD_HR should be 1 after reset");
    } else {
      assert.equal(cia.c_cia[i], 0, `c_cia[${i}] should be 0 after reset`);
    }
  }
  assert.equal(cia.irqflags, 0);
  assert.equal(cia.ifr_delay, 0);
  assert.equal(cia.irq_enabled, 0);
});

// VICE: ciacore_reset port-flush — old_pa/old_pb start at 0xff and
// caller storePa/Pb is called once with 0xff (since regs are 0 → output
// computed = 0|~0=0xff matches old_pa, no event; we test the explicit
// post-reset backend pulse).
test("reset: backend storePa/storePb pulsed once with 0xff", () => {
  const { events } = makeTestCia();
  assert.equal(events.storePa.length, 1, "storePa should be called once at reset");
  assert.equal(events.storePb.length, 1, "storePb should be called once at reset");
  assert.equal(events.storePa[0]!.val, 0xff);
  assert.equal(events.storePb[0]!.val, 0xff);
});

// ---- Port A/B + DDR -------------------------------------------------------

// VICE: ciacore_store_internal CIA_PRA/DDRA (ciacore.c lines 807-816).
// Stored value = c_cia, output = ORA | ~DDRA forwarded to backend when changed.
test("write CIA_PRA + DDRA forwards (PRA | ~DDRA) to backend storePa", () => {
  const { cia, events } = makeTestCia();
  events.storePa.length = 0; // clear reset noise
  cia.write(CIA_DDRA, 0xff); // all output
  cia.write(CIA_PRA, 0x55);
  // Expect at least one callback with byte 0x55 (final = 0x55 | ~0xff = 0x55).
  assert.ok(events.storePa.length >= 1);
  assert.equal(events.storePa[events.storePa.length - 1]!.val, 0x55);
});

// VICE: ciacore_read CIA_PRA (ciacore.c lines 1171-1177). Returns
// backend pin voltage.
test("read CIA_PRA returns backend pin level", () => {
  const { cia, portA } = makeTestCia({ paPins: 0xa5 });
  assert.equal(cia.read(CIA_PRA), 0xa5);
  portA.pins = 0x33;
  assert.equal(cia.read(CIA_PRA), 0x33);
});

// VICE: ciacore_read CIA_PRB (ciacore.c lines 1179-1215). Returns pin
// voltage and pulses PC.
test("read CIA_PRB pulses PC backend hook", () => {
  const { cia, events } = makeTestCia({ pbPins: 0x42 });
  const before = events.pulsePc;
  cia.read(CIA_PRB);
  assert.equal(events.pulsePc, before + 1);
});

// VICE: ciacore_store CIA_PRB pulses PC (ciacore.c line 824).
test("write CIA_PRB pulses PC backend hook", () => {
  const { cia, events } = makeTestCia();
  const before = events.pulsePc;
  cia.write(CIA_PRB, 0x55);
  assert.equal(events.pulsePc, before + 1);
});

// VICE: DDR is just a register-file slot; round-trips.
test("DDRA + DDRB round-trip", () => {
  const { cia } = makeTestCia();
  cia.write(CIA_DDRA, 0xa5);
  cia.write(CIA_DDRB, 0x5a);
  assert.equal(cia.read(CIA_DDRA), 0xa5);
  assert.equal(cia.read(CIA_DDRB), 0x5a);
});

// ---- Timer latch + counter ------------------------------------------------

// VICE: ciacore_store_internal CIA_TAL/CIA_TAH (ciacore.c lines 828-851).
// Writes latch via ciat_set_latch{lo,hi}. Reads return current counter.
test("Timer A latch write + read round-trip via ciat", () => {
  const { cia } = makeTestCia();
  cia.write(CIA_TAL, 0x34);
  cia.write(CIA_TAH, 0x12);
  // Counter loaded on TAH write when stopped.
  assert.equal(cia.read(CIA_TAL), 0x34, "TAL low byte");
  assert.equal(cia.read(CIA_TAH), 0x12, "TAH high byte");
});

test("Timer B latch write + read round-trip via ciat", () => {
  const { cia } = makeTestCia();
  cia.write(CIA_TBL, 0xcd);
  cia.write(CIA_TBH, 0xab);
  assert.equal(cia.read(CIA_TBL), 0xcd);
  assert.equal(cia.read(CIA_TBH), 0xab);
});

// ---- CRA/CRB --------------------------------------------------------------

// VICE: ciacore_store_internal CIA_CRA (ciacore.c lines 1011-1067).
// Stored value clears bit 4 (FORCE LOAD strobe). Read returns stored
// value with bit 0 forced to ciat_is_running().
test("CRA write strips FORCE_LOAD bit (0x10) when read back", () => {
  const { cia } = makeTestCia();
  cia.write(CIA_CRA, 0x10 | 0x08); // force-load + oneshot
  // Bit 0 (start) is 0 → ciat_is_running == 0 → read = stored & 0xef.
  assert.equal(cia.read(CIA_CRA) & 0x10, 0, "FORCE_LOAD bit not retained");
});

test("CRB write strips FORCE_LOAD bit (0x10) when read back", () => {
  const { cia } = makeTestCia();
  cia.write(CIA_CRB, 0x10);
  assert.equal(cia.read(CIA_CRB) & 0x10, 0, "FORCE_LOAD bit not retained");
});

// ---- TOD round-trip -------------------------------------------------------

// VICE: TOD store + read paths (ciacore.c lines 860-912 + 1260-1276).
// HR read latches; TEN read releases. CRB bit 7 selects time vs alarm.
test("TOD round-trip: write HR/MIN/SEC/TEN reads back via latch", () => {
  const { cia } = makeTestCia();
  // Time (CRB bit 7 = 0).
  cia.write(11, 0x12); // HR (BCD 12 → AM/PM-flip semantics; we just test latch path)
  cia.write(10, 0x34); // MIN
  cia.write(9, 0x56);  // SEC
  cia.write(8, 0x07);  // TEN — restarts ticking
  // First read of HR latches all 4. Subsequent reads return latch.
  const hr = cia.read(11);
  const min = cia.read(10);
  const sec = cia.read(9);
  const ten = cia.read(8); // releases latch
  assert.equal(min, 0x34);
  assert.equal(sec, 0x56);
  assert.equal(ten, 0x07);
  // HR may be flipped 0x80 by the AM/PM-on-12 rule.
  assert.equal(hr & 0x1f, 0x12, "HR low 5 bits = 0x12");
});

// ---- ICR mask + flags -----------------------------------------------------

// VICE: ciacore_store_internal CIA_ICR (ciacore.c lines 938-1009).
// Bit 7 set → enable mask bits with v=1; bit 7 clear → disable.
test("ICR mask write: set bit 7 enables, clear bit 7 disables", () => {
  const { cia } = makeTestCia();
  cia.write(CIA_ICR, 0x80 | 0x01); // enable IM_TA
  assert.equal(cia.c_cia[CIA_ICR]! & 0x01, 0x01, "IM_TA enabled");
  cia.write(CIA_ICR, 0x01); // disable IM_TA
  assert.equal(cia.c_cia[CIA_ICR]! & 0x01, 0, "IM_TA disabled");
});

// VICE: ciacore_read CIA_ICR (ciacore.c lines 1289-1366). Reading clears
// flags after returning current value.
test("ICR read clears flags (old CIA semantics)", () => {
  const { cia } = makeTestCia(); // model defaults to CIA_MODEL_6526 (old)
  cia.irqflags = 0x07; // pretend TA + TB + TOD pending
  const result = cia.read(CIA_ICR);
  assert.equal(result & 0x07, 0x07, "all 3 flags reported in read result");
  // Old CIA: irqflags is masked to CIA_IM_SET (i.e. 0x80) only.
  assert.equal(cia.irqflags & 0x07, 0, "flags cleared after ICR read");
});

// ---- SDR -----------------------------------------------------------------

// VICE: ciacore_store_internal CIA_SDR (ciacore.c lines 914-934). Writes
// always update c_cia; SP-mode-OUT additionally arms sdr_alarm via SET1.
test("SDR write round-trips into c_cia", () => {
  const { cia } = makeTestCia();
  cia.write(CIA_SDR, 0xa5);
  assert.equal(cia.c_cia[CIA_SDR], 0xa5);
});

// ---- last_read / RMW ------------------------------------------------------

// VICE: ciacore_read updates last_read (ciacore.c — every return path).
test("last_read tracks the most recent read result", () => {
  const { cia, portA } = makeTestCia({ paPins: 0x77 });
  cia.read(CIA_PRA);
  assert.equal(cia.last_read, 0x77);
  portA.pins = 0x88;
  cia.read(CIA_PRA);
  assert.equal(cia.last_read, 0x88);
});

// ---- runner ---------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ncia-register-rw: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
