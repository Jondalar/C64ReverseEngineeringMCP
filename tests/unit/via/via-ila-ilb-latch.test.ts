// Spec 442 — VIA ILA / ILB input-latching unit tests (revised).
//
// VICE source: src/core/viacore.c
//   - line  76    `/* #define MYVIA_NEED_LATCHING */` — commented out
//                 by default for drive VIAs.
//   - lines 452-456  CA1 active edge: latch ILA when ACR PA_LATCH set
//                    (UNREACHABLE in drive build)
//   - lines 1494-1498 CB1 active edge: latch ILB when ACR PB_LATCH set
//                    (UNREACHABLE in drive build)
//   - lines 1106-1120 PRA read returns ILA when latch enabled
//                    (UNREACHABLE in drive build)
//   - lines 1140-1148 PRB read returns ILB when latch enabled
//                    (UNREACHABLE in drive build)
//
// Per Epic 440 doctrine + Spec 442 Phase 4 patch, TS mirrors the VICE
// drive build exactly: `const MYVIA_NEED_LATCHING = false` gates all
// 7 latch sites. Behaviour: ila/ilb stay 0; reads always return the
// live pin via backend.readPa/readPb regardless of ACR PA/PB-LATCH bits.
//
// These tests assert the literal-VICE-drive behaviour. The earlier
// Spec 147 tests asserted unconditional latching (silicon-correct but
// not VICE-faithful); they are now updated to the VICE-faithful path.
//
// Run via:
//   npx tsx tests/unit/via/via-ila-ilb-latch.test.ts

import { strict as assert } from "node:assert";
import {
  alarm_context_new,
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
  const ctx = alarm_context_new("test");
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

// Spec 442 — MYVIA=false means CA1 edge does NOT write ILA even when
// ACR PA_LATCH set. ILA stays 0.
test("CA1 active edge does NOT capture PA into ILA (MYVIA=false)", () => {
  const h = makeHarness();
  h.via.store(VIA_PCR, VIA_PCR_CA1_POS_ACTIVE_EDGE);
  h.via.store(VIA_ACR, VIA_ACR_PA_LATCH);
  h.via.store(VIA_DDRA, 0);  // input
  h.state.paPin = 0xa5;
  h.via.signal("ca1", "rise");
  assert.equal(h.via.ila, 0);  // ILA never written
});

// Spec 442 — PRA read returns LIVE pin regardless of ACR PA_LATCH +
// CA1 IFR state (MYVIA=false).
test("PRA read returns live pin even with PA_LATCH set + CA1 pending", () => {
  const h = makeHarness();
  h.via.store(VIA_PCR, VIA_PCR_CA1_POS_ACTIVE_EDGE);
  h.via.store(VIA_ACR, VIA_ACR_PA_LATCH);
  h.via.store(VIA_DDRA, 0);
  h.state.paPin = 0x77;
  h.via.signal("ca1", "rise");
  assert.equal(h.via.ifr & VIA_IM_CA1, VIA_IM_CA1);
  // Pin change AFTER the edge — read must show live value.
  h.state.paPin = 0x11;
  assert.equal(h.via.read(VIA_PRA), 0x11);
  h.state.paPin = 0x22;
  assert.equal(h.via.read(VIA_PRA), 0x22);
});

// Spec 442 — CB1 edge does NOT write ILB (MYVIA=false).
test("CB1 active edge does NOT capture PB into ILB (MYVIA=false)", () => {
  const h = makeHarness();
  h.via.store(VIA_PCR, VIA_PCR_CB1_POS_ACTIVE_EDGE);
  h.via.store(VIA_ACR, VIA_ACR_PB_LATCH);
  h.via.store(VIA_DDRB, 0);
  h.state.pbPin = 0x99;
  h.via.signal("cb1", "rise");
  assert.equal(h.via.ilb, 0);
});

// Spec 442 — PRB read returns live-pin mux regardless of ACR PB_LATCH
// + CB1 IFR (MYVIA=false). All inputs → read = live pin.
test("PRB read returns live pin even with PB_LATCH set + CB1 pending", () => {
  const h = makeHarness();
  h.via.store(VIA_PCR, VIA_PCR_CB1_POS_ACTIVE_EDGE);
  h.via.store(VIA_ACR, VIA_ACR_PB_LATCH);
  h.via.store(VIA_DDRB, 0);  // all input
  h.state.pbPin = 0x55;
  h.via.signal("cb1", "rise");
  assert.equal(h.via.ifr & VIA_IM_CB1, VIA_IM_CB1);
  h.state.pbPin = 0x99;
  assert.equal(h.via.read(VIA_PRB), 0x99);
});

// Spec 442 — PRA read with no ACR PA_LATCH still returns live pin
// (control case — also matches MYVIA-on behaviour).
test("PRA read returns live pin when PA_LATCH disabled", () => {
  const h = makeHarness();
  h.via.store(VIA_ACR, 0);
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
