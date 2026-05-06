// Spec 147 — VIA ILA / ILB input-latching unit tests (Phase 1).
//
// VICE source: src/core/viacore.c
//   - lines 117-118  IS_PA_INPUT_LATCH / IS_PB_INPUT_LATCH macros
//   - lines 452-456  CA1 active edge: latch ILA when ACR PA_LATCH set
//   - lines 1494-1498 CB1 active edge: latch ILB when ACR PB_LATCH set
//   - lines 1106-1120 PRA read returns ILA when latch enabled & IFR_CA1 set
//   - lines 1140-1148 PRB read returns ILB when latch enabled & IFR_CB1 set
//
// Note: VICE wraps these latch paths under #ifdef MYVIA_NEED_LATCHING in
// the .c file. Our port enables them unconditionally — spec 147 makes
// latching mandatory for fastloader fidelity.
//
// Run via:
//   npx tsx tests/unit/via/via-ila-ilb-latch.test.ts

import { strict as assert } from "node:assert";
import {
  alarmContextNew,
} from "../../../src/runtime/headless/alarm/alarm-context.js";
import {
  Via6522Vice,
  VIA_ACR,
  VIA_ACR_PA_LATCH,
  VIA_ACR_PB_LATCH,
  VIA_DDRA,
  VIA_DDRB,
  VIA_IM_CA1,
  VIA_IM_CB1,
  VIA_PCR,
  VIA_PCR_CA1_POS_ACTIVE_EDGE,
  VIA_PCR_CB1_POS_ACTIVE_EDGE,
  VIA_PRA,
  VIA_PRB,
  type ViaBackend,
} from "../../../src/runtime/headless/via/via6522-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function makeHarness() {
  const ctx = alarmContextNew("test");
  let clk = 100;
  const state = { paPin: 0xff, pbPin: 0xff };
  const backend: ViaBackend = {
    readPa: () => state.paPin,
    readPb: () => state.pbPin,
    storePa: () => undefined,
    storePb: () => undefined,
    storeSr: () => undefined,
    storeT2L: () => undefined,
    storeAcr: () => undefined,
    storePcr: (v) => v,
    setInt: () => undefined,
    setCa2: () => undefined,
    setCb2: () => undefined,
    reset: () => undefined,
  };
  const via = new Via6522Vice({
    alarmContext: ctx,
    backend,
    clkRef: () => clk,
    myname: "Latch",
    writeOffset: 0,
  });
  return { via, state, advance: (n: number) => { clk += n; } };
}

// VICE viacore.c lines 452-456 — when ACR_PA_LATCH set, CA1 active edge
// captures live PA pin into ILA.
test("CA1 active edge captures PA pin into ILA when PA_LATCH enabled", () => {
  const h = makeHarness();
  h.via.store(VIA_PCR, VIA_PCR_CA1_POS_ACTIVE_EDGE);
  h.via.store(VIA_ACR, VIA_ACR_PA_LATCH);
  h.via.store(VIA_DDRA, 0);  // input
  h.state.paPin = 0xa5;
  h.via.signal("ca1", "rise");
  assert.equal(h.via.ila, 0xa5);
});

// VICE viacore.c lines 1106-1120 — PRA read returns ILA when
// PA_LATCH enabled & IFR_CA1 still set.
test("PRA read returns ILA when latching enabled and CA1 IFR pending", () => {
  const h = makeHarness();
  h.via.store(VIA_PCR, VIA_PCR_CA1_POS_ACTIVE_EDGE);
  h.via.store(VIA_ACR, VIA_ACR_PA_LATCH);
  h.via.store(VIA_DDRA, 0);
  h.state.paPin = 0x77;
  h.via.signal("ca1", "rise");
  assert.equal(h.via.ifr & VIA_IM_CA1, VIA_IM_CA1);
  // Now change live pin AFTER the latched edge.
  h.state.paPin = 0x11;
  // First read: still latched 0x77 (IFR_CA1 still set when entering read).
  const r = h.via.read(VIA_PRA);
  assert.equal(r, 0x77);
  // VICE: PRA read CLEARS IFR_CA1; subsequent read returns live pin.
  h.state.paPin = 0x22;
  const r2 = h.via.read(VIA_PRA);
  assert.equal(r2, 0x22);
});

// VICE viacore.c lines 1494-1498 — CB1 active edge captures PB pin
// into ILB when PB_LATCH set.
test("CB1 active edge captures PB pin into ILB when PB_LATCH enabled", () => {
  const h = makeHarness();
  h.via.store(VIA_PCR, VIA_PCR_CB1_POS_ACTIVE_EDGE);
  h.via.store(VIA_ACR, VIA_ACR_PB_LATCH);
  h.via.store(VIA_DDRB, 0);
  h.state.pbPin = 0x99;
  h.via.signal("cb1", "rise");
  assert.equal(h.via.ilb, 0x99);
});

// VICE viacore.c lines 1140-1148 — PRB read returns ILB+ORB merge when
// PB_LATCH enabled & IFR_CB1 pending.
test("PRB read returns ILB-merged when latching enabled and CB1 IFR pending", () => {
  const h = makeHarness();
  h.via.store(VIA_PCR, VIA_PCR_CB1_POS_ACTIVE_EDGE);
  h.via.store(VIA_ACR, VIA_ACR_PB_LATCH);
  h.via.store(VIA_DDRB, 0);  // all input
  h.state.pbPin = 0x55;
  h.via.signal("cb1", "rise");
  assert.equal(h.via.ifr & VIA_IM_CB1, VIA_IM_CB1);
  h.state.pbPin = 0x99;
  const r = h.via.read(VIA_PRB);
  assert.equal(r, 0x55);  // latched, not live
});

// VICE viacore.c lines 1080-1094 — PRA read with latch DISABLED returns
// live pin always.
test("PRA read returns live pin when PA_LATCH disabled", () => {
  const h = makeHarness();
  h.via.store(VIA_ACR, 0);  // no PA latch
  h.via.store(VIA_DDRA, 0);
  h.state.paPin = 0x10;
  assert.equal(h.via.read(VIA_PRA), 0x10);
  h.state.paPin = 0x20;
  assert.equal(h.via.read(VIA_PRA), 0x20);
});

// ---- runner --------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nvia-ila-ilb-latch: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
