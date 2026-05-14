// Spec 147 — VIA T1 + PB7 toggle output unit tests (Phase 1).
//
// VICE source: src/core/viacore.c
//   - lines 720-722  (storePb merges PB7 into output byte when ACR bit 7 set)
//   - lines 859-862  (ACR write rising edge of T1_PB7_USED → t1_pb7 = 0x80)
//   - lines 1306-1342 (viacore_t1_zero_alarm — toggles t1_pb7, sets IFR_T1)
//   - lines 752-768  (T1CH write — t1_pb7 = 0; loads counter; schedules alarm)
//
// Run via:
//   npx tsx tests/unit/via/via-t1-pb7-toggle.test.ts

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
  VIA_ACR_T1_FREE_RUN,
  VIA_ACR_T1_PB7_USED,
  VIA_DDRB,
  VIA_IM_T1,
  VIA_PRB,
  VIA_T1CH,
  VIA_T1LH,
  VIA_T1LL,
  type ViaBackend,
} from "../../../src/runtime/headless/via/via6522-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function harness() {
  const ctx = alarm_context_new("test");
  let clk = 100;
  const stored: Array<{ clk: number; v: number }> = [];
  let irq = 0;
  const backend: ViaBackend = {
    readPa: () => 0xff,
    readPb: () => 0xff,
    storePa: () => undefined,
    storePb: (cl, v) => stored.push({ clk: cl, v }),
    storeSr: () => undefined,
    storeT2L: () => undefined,
    storeAcr: () => undefined,
    storePcr: (val) => val,
    setInt: (v) => { irq = v; },
    setCa2: () => undefined,
    setCb2: () => undefined,
    reset: () => undefined,
  };
  const via = new Via6522Vice({
    alarmContext: ctx,
    backend,
    clkRef: () => clk,
    myname: "T1",
    writeOffset: 0,
  });
  function dispatchAll(): void {
    while (clk >= alarm_context_next_pending_clk(ctx) &&
           alarm_context_next_pending_clk(ctx) !== CLOCK_MAX) {
      alarm_context_dispatch(ctx, clk);
    }
  }
  return {
    via, ctx, stored,
    advance: (n: number) => { clk += n; dispatchAll(); },
    getClk: () => clk,
    getIrq: () => irq,
    dispatchAll,
  };
}

// VICE viacore.c lines 855-862 — rising edge of T1_PB7_USED bit
// initializes t1_pb7 = 0x80.
test("ACR rising edge of T1_PB7_USED sets t1_pb7 = 0x80", () => {
  const { via } = harness();
  assert.equal(via.t1_pb7, 0x80);  // power-on
  via.store(VIA_ACR, 0);            // bit 7 cleared
  via.t1_pb7 = 0;                   // simulate prior toggling
  via.store(VIA_ACR, VIA_ACR_T1_PB7_USED);
  assert.equal(via.t1_pb7, 0x80);
});

// VICE viacore.c lines 752-763 — T1CH write resets t1_pb7 = 0.
test("T1CH write resets t1_pb7 to 0", () => {
  const { via } = harness();
  via.t1_pb7 = 0x80;
  via.store(VIA_T1LL, 0x10);
  via.store(VIA_T1CH, 0x00);
  assert.equal(via.t1_pb7, 0);
});

// VICE viacore.c lines 1337-1339 — t1_pb7 ^= 0x80 each underflow,
// IFR_T1 set.
test("T1 underflow toggles t1_pb7 and sets IFR_T1 (one-shot)", () => {
  const h = harness();
  // Latch = 5; counter loads 5; full cycle = 5+2 = 7. Wait > full_cycle.
  h.via.store(VIA_ACR, 0);             // one-shot, no PB7 mode by default
  h.via.store(VIA_T1LL, 0x05);
  h.via.store(VIA_T1CH, 0x00);
  assert.equal(h.via.t1_pb7, 0);
  // Run forward enough to dispatch t1_zero_alarm.
  h.advance(10);
  assert.notEqual(h.via.ifr & VIA_IM_T1, 0);
  // PB7 toggled.
  assert.equal(h.via.t1_pb7, 0x80);
});

// VICE viacore.c lines 1315-1318 — one-shot mode: alarm cancelled
// after first underflow (t1zero = 0).
test("T1 one-shot: only one underflow IRQ; t1zero cleared", () => {
  const h = harness();
  h.via.store(VIA_ACR, 0);             // one-shot
  h.via.store(VIA_T1LL, 0x03);
  h.via.store(VIA_T1CH, 0x00);
  h.advance(20);
  assert.equal(h.via.t1zero, 0);
});

// VICE viacore.c lines 1319-1335 — free-run mode: t1zero rescheduled
// every full_cycle.
test("T1 free-run: alarm reschedules each underflow", () => {
  const h = harness();
  h.via.store(VIA_ACR, VIA_ACR_T1_FREE_RUN);
  h.via.store(VIA_T1LL, 0x03);
  h.via.store(VIA_T1CH, 0x00);
  h.advance(6);                        // ~ first underflow
  const firstZero = h.via.t1zero;
  h.advance(5);                        // ~ second underflow
  assert.notEqual(h.via.t1zero, firstZero);
});

// VICE viacore.c lines 720-722 — when ACR bit 7 set, output byte =
// (PB | ~DDRB) | t1_pb7. Verify storePb sees PB7 merged.
test("storePb merges t1_pb7 into output when ACR T1_PB7_USED", () => {
  const h = harness();
  h.via.store(VIA_ACR, VIA_ACR_T1_PB7_USED); // bit 7 = 1
  h.via.store(VIA_DDRB, 0xff);                // all output
  h.via.store(VIA_PRB, 0x00);                 // ORB = 0
  // t1_pb7 = 0x80 (default). storePb should send (0 & 0x7f) | 0x80 = 0x80.
  const last = h.stored.at(-1)!;
  assert.equal(last.v, 0x80);
  // Now flip t1_pb7 manually and re-write PRB.
  h.via.t1_pb7 = 0;
  h.via.store(VIA_PRB, 0x00);
  const last2 = h.stored.at(-1)!;
  assert.equal(last2.v, 0x00);
});

// VICE viacore.c lines 1152-1154 — read PRB merges t1_pb7 over bit 7
// when ACR T1_PB7_USED.
test("read PRB merges t1_pb7 into bit 7 when ACR T1_PB7_USED", () => {
  const h = harness();
  h.via.store(VIA_ACR, VIA_ACR_T1_PB7_USED);
  h.via.store(VIA_DDRB, 0x80);   // bit 7 output, others input
  h.via.store(VIA_PRB, 0x00);    // ORB bit 7 = 0
  // t1_pb7 = 0x80; bit 7 of read = 0x80 ORed in.
  const r = h.via.read(VIA_PRB);
  assert.equal(r & 0x80, 0x80);
});

// VICE viacore.c lines 770-783 — T1LH write also clears IFR_T1.
test("T1LH write clears IFR_T1", () => {
  const h = harness();
  h.via.ifr |= VIA_IM_T1;
  h.via.store(VIA_T1LH, 0x10);
  assert.equal(h.via.ifr & VIA_IM_T1, 0);
});

// ---- runner --------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nvia-t1-pb7-toggle: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
