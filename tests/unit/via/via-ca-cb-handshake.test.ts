// Spec 147 — VIA CA2 / CB2 handshake / pulse output unit tests.
//
// VICE source: src/core/viacore.c
//   - lines 671-680  PRA write — handshake / pulse output on CA2
//   - lines 703-711  PRB write — handshake / pulse output on CB2
//   - lines 1083-1091 PRA read — handshake / pulse output on CA2
//   - lines 996-1019 PCR write — CA2 high/low/toggle
//   - lines 1350-1377 set_cb2_output_state — CB2 mode dispatch
//   - lines 1503-1518 viacore_set_cb2 — CB2 input edge handling
//
// Run via:
//   npx tsx tests/unit/via/via-ca-cb-handshake.test.ts

import { strict as assert } from "node:assert";
import {
  alarmContextNew,
} from "../../../src/runtime/headless/alarm/alarm-context.js";
import {
  Via6522Vice,
  VIA_DDRA,
  VIA_DDRB,
  VIA_IM_CA2,
  VIA_PCR,
  VIA_PCR_CA2_HANDSHAKE_OUTPUT,
  VIA_PCR_CA2_HIGH_OUTPUT,
  VIA_PCR_CA2_LOW_OUTPUT,
  VIA_PCR_CA2_PULSE_OUTPUT,
  VIA_PCR_CB2_HANDSHAKE_OUTPUT,
  VIA_PCR_CB2_HIGH_OUTPUT,
  VIA_PCR_CB2_INPUT_POS_ACTIVE_EDGE,
  VIA_PCR_CB2_PULSE_OUTPUT,
  VIA_PRA,
  VIA_PRB,
  type ViaBackend,
} from "../../../src/runtime/headless/via/via6522-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function harness() {
  const ctx = alarmContextNew("test");
  let clk = 100;
  const ca2: number[] = [];
  const cb2: Array<{ s: number; offset: number }> = [];
  const backend: ViaBackend = {
    readPa: () => 0xff,
    readPb: () => 0xff,
    storePa: () => undefined,
    storePb: () => undefined,
    storeSr: () => undefined,
    storeT2L: () => undefined,
    storeAcr: () => undefined,
    storePcr: (v) => v,
    setInt: () => undefined,
    setCa2: (s) => ca2.push(s),
    setCb2: (s, offset) => cb2.push({ s, offset }),
    reset: () => undefined,
  };
  const via = new Via6522Vice({
    alarmContext: ctx,
    backend,
    clkRef: () => clk,
    myname: "Hs",
    writeOffset: 1,
  });
  return { via, ca2, cb2, getClk: () => clk };
}

// VICE viacore.c lines 996-1003 — PCR low-output forces ca2_out_state = false.
test("PCR CA2_LOW_OUTPUT drives CA2 line low", () => {
  const h = harness();
  h.via.store(VIA_PCR, VIA_PCR_CA2_LOW_OUTPUT);
  // Last setCa2 should be 0.
  assert.equal(h.ca2.at(-1), 0);
  assert.equal(h.via.ca2_out_state, false);
});

// VICE viacore.c lines 1000-1003 — PCR high-output drives CA2 high.
test("PCR CA2_HIGH_OUTPUT drives CA2 line high", () => {
  const h = harness();
  h.via.store(VIA_PCR, VIA_PCR_CA2_HIGH_OUTPUT);
  assert.equal(h.ca2.at(-1), 1);
  assert.equal(h.via.ca2_out_state, true);
});

// VICE viacore.c lines 671-680 — PRA write under CA2 handshake mode:
// pulls CA2 low (handshake start) until next CA1 edge, OR for one
// cycle in pulse mode.
test("PRA write under CA2_HANDSHAKE_OUTPUT pulls CA2 low", () => {
  const h = harness();
  h.via.store(VIA_PCR, VIA_PCR_CA2_HANDSHAKE_OUTPUT);
  h.via.store(VIA_DDRA, 0xff);
  h.ca2.length = 0;
  h.via.store(VIA_PRA, 0x55);
  // Last setCa2 call drove low (handshake start).
  assert.equal(h.ca2.at(-1), 0);
});

// VICE viacore.c lines 674-678 — pulse mode also drives high right after.
test("PRA write under CA2_PULSE_OUTPUT pulses CA2 (low then high)", () => {
  const h = harness();
  h.via.store(VIA_PCR, VIA_PCR_CA2_PULSE_OUTPUT);
  h.via.store(VIA_DDRA, 0xff);
  h.ca2.length = 0;
  h.via.store(VIA_PRA, 0x33);
  // Two events recorded: 0 then 1.
  assert.deepEqual(h.ca2.slice(-2), [0, 1]);
});

// VICE viacore.c lines 1083-1091 — PRA read under handshake also pulls CA2.
test("PRA read under CA2_HANDSHAKE_OUTPUT pulls CA2 low", () => {
  const h = harness();
  h.via.store(VIA_PCR, VIA_PCR_CA2_HANDSHAKE_OUTPUT);
  h.ca2.length = 0;
  h.via.read(VIA_PRA);
  assert.equal(h.ca2.at(-1), 0);
});

// VICE viacore.c lines 461-464 — CA2 input edge sets IFR_CA2 when
// edge polarity matches PCR.
test("CA2 input rising edge sets IFR_CA2 when PCR=POS_ACTIVE_EDGE", () => {
  const h = harness();
  // CA2 input pos active edge = PCR bit 2 set (0x04), bit 3 = 0 (input).
  h.via.store(VIA_PCR, 0x04);
  h.via.signal("ca2", "rise");
  assert.notEqual(h.via.ifr & VIA_IM_CA2, 0);
});

// VICE viacore.c lines 1350-1377 — set_cb2_output_state via PCR write.
test("PCR CB2_HIGH_OUTPUT drives CB2 high", () => {
  const h = harness();
  h.via.store(VIA_PCR, VIA_PCR_CB2_HIGH_OUTPUT);
  assert.equal(h.cb2.at(-1)?.s, 1);
  assert.equal(h.via.cb2_out_state, true);
});

// VICE viacore.c lines 703-711 — PRB write under CB2 handshake mode
// pulls CB2 low.
test("PRB write under CB2_HANDSHAKE_OUTPUT pulls CB2 low", () => {
  const h = harness();
  h.via.store(VIA_PCR, VIA_PCR_CB2_HANDSHAKE_OUTPUT);
  h.via.store(VIA_DDRB, 0xff);
  h.cb2.length = 0;
  h.via.store(VIA_PRB, 0x77);
  assert.equal(h.cb2.at(-1)?.s, 0);
});

// VICE viacore.c lines 706-710 — pulse mode CB2 (low then high).
test("PRB write under CB2_PULSE_OUTPUT pulses CB2", () => {
  const h = harness();
  h.via.store(VIA_PCR, VIA_PCR_CB2_PULSE_OUTPUT);
  h.via.store(VIA_DDRB, 0xff);
  h.cb2.length = 0;
  h.via.store(VIA_PRB, 0xaa);
  assert.deepEqual(h.cb2.slice(-2).map((e) => e.s), [0, 1]);
});

// VICE viacore.c lines 1503-1518 — viacore_set_cb2 input edge sets IFR_CB2.
test("CB2 input rising edge sets IFR_CB2 when PCR=POS_ACTIVE_EDGE", () => {
  const h = harness();
  h.via.store(VIA_PCR, VIA_PCR_CB2_INPUT_POS_ACTIVE_EDGE);
  // Default cb2_in_state = true. Force to false first, then rise.
  h.via.cb2_in_state = false;
  h.via.signal("cb2", "rise");
  assert.notEqual(h.via.ifr & 0x08, 0);
});

// ---- runner --------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nvia-ca-cb-handshake: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
