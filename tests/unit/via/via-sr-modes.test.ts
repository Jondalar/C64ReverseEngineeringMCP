// Spec 147 — VIA Shift Register modes unit tests (Phase 1).
//
// VICE source: src/core/viacore.c
//   - lines 575-632  setup_shifting (mode dispatch on ACR bits 2-4)
//   - lines 928-966  ACR write — SR mode change & alarm
//                    set/unset
//   - lines 1697-1805 do_shiftregister (CB1/CB2 toggling)
//   - lines 1808-1827 viacore_phi2_sr_alarm
//
// Run via:
//   npx tsx tests/unit/via/via-sr-modes.test.ts

import { strict as assert } from "node:assert";
import {
  alarm_context_dispatch,
  alarm_context_new,
  alarm_context_next_pending_clk,
  CLOCK_MAX,
} from "../../../src/runtime/headless/alarm/alarm-context.js";
import {
  Via6522Vice,
  VIA_ACR,
  VIA_ACR_SR_DISABLED,
  VIA_ACR_SR_OUT_PHI2,
  VIA_ACR_SR_OUT_T2,
  VIA_IM_SR,
  VIA_SR,
  type ViaBackend,
} from "../../../src/runtime/headless/via/via6522-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function harness() {
  const ctx = alarm_context_new("test");
  let clk = 100;
  const cb1: number[] = [];
  const cb2: number[] = [];
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
    setCa2: () => undefined,
    setCb1: (s) => cb1.push(s),
    setCb2: (s) => cb2.push(s),
    reset: () => undefined,
  };
  const via = new Via6522Vice({
    alarmContext: ctx,
    backend,
    clkRef: () => clk,
    myname: "SR",
    writeOffset: 0,
  });
  function dispatchAll(): void {
    while (clk >= alarm_context_next_pending_clk(ctx) &&
           alarm_context_next_pending_clk(ctx) !== CLOCK_MAX) {
      alarm_context_dispatch(ctx, clk);
    }
  }
  return {
    via, ctx, cb1, cb2,
    advance: (n: number) => { clk += n; dispatchAll(); },
    getClk: () => clk,
    dispatchAll,
  };
}

// VICE viacore.c lines 580-589 — SR_DISABLED is the default; setup_shifting
// no-ops; SR write/read still latches.
test("SR mode 0 (DISABLED): SR write latches without firing IFR_SR", () => {
  const h = harness();
  h.via.store(VIA_ACR, VIA_ACR_SR_DISABLED);
  h.via.store(VIA_SR, 0xa5);
  assert.equal(h.via.via[VIA_SR], 0xa5);
  assert.equal(h.via.ifr & VIA_IM_SR, 0);
});

// VICE viacore.c lines 613-624 — IN_PHI2 / OUT_PHI2 enables phi2_sr_alarm.
// Spec 147: 8 bits → IFR_SR set after FINISHED_SHIFTING.
test("SR mode 6 (OUT_PHI2): completes 8 bits and sets IFR_SR", () => {
  const h = harness();
  h.via.store(VIA_ACR, VIA_ACR_SR_OUT_PHI2);
  h.via.store(VIA_SR, 0xff);
  // phi2_sr_alarm fires every cycle. 16 half-cycles needed for 8 bits.
  // Initial alarm scheduled at SR_PHI2_FIRST_OFFSET=3 cycles after store.
  h.advance(20);
  assert.notEqual(h.via.ifr & VIA_IM_SR, 0);
});

// VICE viacore.c lines 941-956 — switching SR mode away from PHI2
// unsets phi2_sr_alarm.
test("Switch ACR from PHI2 → DISABLED unsets phi2_sr_alarm", () => {
  const h = harness();
  h.via.store(VIA_ACR, VIA_ACR_SR_OUT_PHI2);
  h.via.store(VIA_SR, 0xff);
  h.via.store(VIA_ACR, VIA_ACR_SR_DISABLED);
  // After disable, no further SR alarm firings; advance many cycles.
  h.via.ifr &= ~VIA_IM_SR;
  h.advance(100);
  assert.equal(h.via.ifr & VIA_IM_SR, 0);
});

// VICE viacore.c lines 727-737 — SR write clears IFR_SR.
test("SR write clears IFR_SR", () => {
  const h = harness();
  h.via.ifr |= VIA_IM_SR;
  h.via.store(VIA_SR, 0x33);
  assert.equal(h.via.ifr & VIA_IM_SR, 0);
});

// VICE viacore.c lines 1184-1188 — SR read clears IFR_SR.
test("SR read clears IFR_SR", () => {
  const h = harness();
  h.via.via[VIA_SR] = 0x42;
  h.via.ifr |= VIA_IM_SR;
  const v = h.via.read(VIA_SR);
  assert.equal(v, 0x42);
  assert.equal(h.via.ifr & VIA_IM_SR, 0);
});

// VICE viacore.c lines 591-612 — IN_T2 / OUT_T2 / OUT_FREE_T2 / IN_CB1 /
// OUT_CB1 transition shift_state to START_SHIFTING when previously
// FINISHED.
test("SR mode 5 (OUT_T2): SR write transitions shift_state to start", () => {
  const h = harness();
  h.via.shift_state = 16; // FINISHED
  h.via.store(VIA_ACR, VIA_ACR_SR_OUT_T2);
  h.via.store(VIA_SR, 0xa5);
  assert.equal(h.via.shift_state, 0);
});

// ---- runner --------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nvia-sr-modes: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
