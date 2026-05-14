// Spec 442 — viacore conformance unit tests.
//
// Pins the literal-VICE behaviour for the audit findings of Spec 442.
// Each assertion cites a VICE viacore.c line number.
//
// Coverage:
//   - PEEK never clears IFR flags (viacore_peek vs viacore_read distinction)
//   - PEEK returns raw IFR (no bit-7 synthesis) — Phase 7 patch
//   - READ synthesizes IFR bit 7 from (ifr & ier)
//   - viacoreSetSr burst-mode hack semantics (viacore.c:1523-1534)
//   - MYVIA_NEED_LATCHING gate: ila/ilb stay 0 after CA1/CB1 edges
//   - T2_irq_allowed: each T2CH write re-enables one IRQ
//   - IER bit-7 store distinguishes set/clear
//   - viacore_signal CA2 polarity edge-match
//
// Run via:
//   npx tsx tests/unit/via/viacore-conformance.test.ts

import { strict as assert } from "node:assert";
import {
  alarmContextNew,
} from "../../../src/runtime/headless/alarm/alarm-context.js";
import {
  Via6522Vice,
  VIA_ACR,
  VIA_ACR_PA_LATCH,
  VIA_ACR_SR_OUT_PHI2,
  VIA_IER,
  VIA_IFR,
  VIA_IM_CA1,
  VIA_IM_IRQ,
  VIA_IM_SR,
  VIA_IM_T1,
  VIA_IM_T2,
  VIA_PCR,
  VIA_PCR_CA1_POS_ACTIVE_EDGE,
  VIA_PCR_CA2_INPUT_POS_ACTIVE_EDGE,
  VIA_PRA,
  VIA_SR,
  VIA_T1CH,
  VIA_T2CH,
  VIA_T2LL,
  type ViaBackend,
} from "../../../src/runtime/headless/via/via6522-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function makeHarness() {
  const ctx = alarmContextNew("test");
  let clk = 100;
  const state = { paPin: 0x55, pbPin: 0xaa, irq: 0 };
  const backend: ViaBackend = {
    readPa: () => state.paPin,
    readPb: () => state.pbPin,
    storePa: () => undefined,
    storePb: () => undefined,
    storeSr: () => undefined,
    storeT2L: () => undefined,
    storeAcr: () => undefined,
    storePcr: (v) => v,
    setInt: (v) => { state.irq = v; },
    setCa2: () => undefined,
    setCb2: () => undefined,
    reset: () => undefined,
  };
  const via = new Via6522Vice({
    alarmContext: ctx,
    backend,
    clkRef: () => clk,
    myname: "Conf",
    writeOffset: 1,
  });
  return { via, state, advance: (n: number) => { clk += n; } };
}

// ----------------------------------------------------------------------------
// viacore.c:1218-1297 — viacore_peek must NOT clear flags.
//
test("PEEK PRA does NOT clear CA1 IFR flag (viacore.c:1224-1241)", () => {
  const h = makeHarness();
  h.via.store(VIA_PCR, VIA_PCR_CA1_POS_ACTIVE_EDGE);
  h.via.signal("ca1", "rise");
  assert.equal(h.via.ifr & VIA_IM_CA1, VIA_IM_CA1);
  h.via.peek(VIA_PRA);
  assert.equal(h.via.ifr & VIA_IM_CA1, VIA_IM_CA1, "CA1 must still be set after peek");
});

test("READ PRA clears CA1 IFR flag (viacore.c:1077)", () => {
  const h = makeHarness();
  h.via.store(VIA_PCR, VIA_PCR_CA1_POS_ACTIVE_EDGE);
  h.via.signal("ca1", "rise");
  assert.equal(h.via.ifr & VIA_IM_CA1, VIA_IM_CA1);
  h.via.read(VIA_PRA);
  assert.equal(h.via.ifr & VIA_IM_CA1, 0, "CA1 must clear after read");
});

// ----------------------------------------------------------------------------
// Spec 442 Phase 7 — PEEK IFR returns raw ifr (viacore.c:1284-1285).
//
test("PEEK IFR returns raw ifr (no bit-7 synthesis) — Phase 7", () => {
  const h = makeHarness();
  h.via.ifr = 0x42;          // CA1 + T2 set
  h.via.ier = 0x42 | VIA_IM_IRQ;  // both enabled
  // viacore_read would synthesize bit 7 = 1 here; viacore_peek returns raw.
  assert.equal(h.via.peek(VIA_IFR), 0x42);
});

test("READ IFR synthesizes bit 7 from (ifr & ier) (viacore.c:1196-1200)", () => {
  const h = makeHarness();
  h.via.ifr = 0x42;
  h.via.ier = 0x42 | VIA_IM_IRQ;
  assert.equal(h.via.read(VIA_IFR), 0xc2);  // bit 7 set because (ifr & ier) != 0
});

test("READ IFR with no enabled flag does NOT set bit 7", () => {
  const h = makeHarness();
  h.via.ifr = 0x42;
  h.via.ier = 0;             // nothing enabled
  // TS masks lower bits via & 0x7f; (ifr & ier) = 0 → bit 7 = 0.
  assert.equal(h.via.read(VIA_IFR) & 0x80, 0);
});

// ----------------------------------------------------------------------------
// IER store bit-7 (viacore.c:842-848).
//
test("IER store with bit 7 = 1 sets enable mask (viacore.c:842-844)", () => {
  const h = makeHarness();
  h.via.store(VIA_IER, VIA_IM_IRQ | VIA_IM_CA1);
  assert.equal(h.via.ier & VIA_IM_CA1, VIA_IM_CA1);
});

test("IER store with bit 7 = 0 clears enable mask (viacore.c:846-848)", () => {
  const h = makeHarness();
  h.via.store(VIA_IER, VIA_IM_IRQ | VIA_IM_CA1);   // enable CA1
  h.via.store(VIA_IER, VIA_IM_CA1);                 // disable CA1 (no bit 7)
  assert.equal(h.via.ier & VIA_IM_CA1, 0);
});

// ----------------------------------------------------------------------------
// viacore_set_sr burst-mode hack (viacore.c:1523-1534).
//
test("viacoreSetSr: burst hack fires only in shift-in modes with SR ACR bits", () => {
  const h = makeHarness();
  // ACR 0x00 (SR disabled): no effect.
  h.via.store(VIA_ACR, 0);
  h.via.viacoreSetSr(0xab);
  assert.equal(h.via.via[VIA_SR], 0);
  // ACR shift-in T2 (0x04): byte written, IFR_SR set, shift_state reset.
  h.via.store(VIA_ACR, 0x04);
  h.via.viacoreSetSr(0xcd);
  assert.equal(h.via.via[VIA_SR], 0xcd);
  assert.equal(h.via.ifr & VIA_IM_SR, VIA_IM_SR);
});

// ----------------------------------------------------------------------------
// Spec 442 Phase 4 — MYVIA_NEED_LATCHING = false: ila/ilb stay 0.
//
test("MYVIA gate: ila stays 0 after CA1 edge with PA_LATCH set", () => {
  const h = makeHarness();
  h.via.store(VIA_PCR, VIA_PCR_CA1_POS_ACTIVE_EDGE);
  h.via.store(VIA_ACR, VIA_ACR_PA_LATCH);
  h.state.paPin = 0xa5;
  h.via.signal("ca1", "rise");
  assert.equal(h.via.ila, 0);
});

// ----------------------------------------------------------------------------
// T2_irq_allowed (viacore.c:826 + 1066-1069 — each T2CH write re-arms one IRQ).
//
test("T2CH write sets t2_irq_allowed = true (viacore.c:826)", () => {
  const h = makeHarness();
  h.via.store(VIA_T2LL, 0x10);
  h.via.store(VIA_T2CH, 0x00);
  assert.equal(h.via.t2_irq_allowed, true);
});

// ----------------------------------------------------------------------------
// viacore_signal CA2 polarity edge-match (viacore.c:459-466).
//
test("CA2 INPUT mode: rising edge fires IM_CA2 only with matching PCR polarity", () => {
  const h = makeHarness();
  // PCR CA2 = INPUT + POS_ACTIVE_EDGE (bit 2 = 1).
  h.via.store(VIA_PCR, VIA_PCR_CA2_INPUT_POS_ACTIVE_EDGE);
  h.via.signal("ca2", "fall");
  assert.equal(h.via.ifr & 0x01, 0, "falling edge with pos-polarity must NOT fire");
  h.via.signal("ca2", "rise");
  assert.equal(h.via.ifr & 0x01, 0x01, "rising edge with pos-polarity MUST fire");
});

// ----------------------------------------------------------------------------
// PEEK IER returns ier | 0x80 (viacore.c:1287-1288, no side effect).
//
test("PEEK IER returns ier | 0x80 (viacore.c:1287)", () => {
  const h = makeHarness();
  h.via.store(VIA_IER, VIA_IM_IRQ | VIA_IM_CA1);
  assert.equal(h.via.peek(VIA_IER) & 0x80, 0x80);
  // IER state unchanged.
  assert.equal(h.via.ier & VIA_IM_CA1, VIA_IM_CA1);
});

// ----------------------------------------------------------------------------
// viacore_store IFR: writing clears flags via mask (viacore.c:832).
//
test("IFR write clears flags via mask (viacore.c:832)", () => {
  const h = makeHarness();
  h.via.ifr = 0x7f;
  h.via.store(VIA_IFR, VIA_IM_T1 | VIA_IM_T2);
  assert.equal(h.via.ifr & (VIA_IM_T1 | VIA_IM_T2), 0);
  assert.equal(h.via.ifr & VIA_IM_CA1, VIA_IM_CA1, "untouched flags persist");
});

// ----------------------------------------------------------------------------
// Spec 444 — viacore_disable / enabled (viacore.c:364-372).
//
test("disable() sets enabled = false (viacore.c:371)", () => {
  const h = makeHarness();
  assert.equal(h.via.enabled, true, "enabled defaults true");
  h.via.disable();
  assert.equal(h.via.enabled, false);
});

test("reset() restores enabled = true (viacore.c:438)", () => {
  const h = makeHarness();
  h.via.disable();
  assert.equal(h.via.enabled, false);
  h.via.reset();
  assert.equal(h.via.enabled, true);
});

// ----------------------------------------------------------------------------
// Suite runner.
// ----------------------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nviacore-conformance: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
