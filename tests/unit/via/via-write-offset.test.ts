// Spec 147 — VIA write_offset 1-cycle store delay unit tests.
//
// VICE source: src/core/viacore.c
//   - lines 648-650  rclk = clk - write_offset (store path)
//   - lines 660-662  run_pending_alarms(rclk, write_offset, ...) gate
//   - lines 504-530  run_pending_alarms (only fires alarms with clk
//                    strictly less than the current clk)
//
// VICE convention: when CPU does CLK++ before the store, write_offset
// = 1 — the actual hardware-visible store time is `clk - 1`. Alarms
// scheduled for that cycle should not have fired yet at store time.
//
// Run via:
//   npx tsx tests/unit/via/via-write-offset.test.ts

import { strict as assert } from "node:assert";
import {
  alarmContextNew,
  alarmContextNextPendingClk,
} from "../../../src/runtime/headless/alarm/alarm-context.js";
import {
  Via6522Vice,
  VIA_T1CH,
  VIA_T1LL,
  type ViaBackend,
} from "../../../src/runtime/headless/via/via6522-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function harness(writeOffset: number) {
  const ctx = alarmContextNew("test");
  let clk = 100;
  const backend: ViaBackend = {
    readPa: () => 0xff, readPb: () => 0xff,
    storePa: () => undefined, storePb: () => undefined,
    storeSr: () => undefined, storeT2L: () => undefined,
    storeAcr: () => undefined, storePcr: (v) => v,
    setInt: () => undefined,
    setCa2: () => undefined, setCb2: () => undefined,
    reset: () => undefined,
  };
  const via = new Via6522Vice({
    alarmContext: ctx,
    backend,
    clkRef: () => clk,
    myname: "WO",
    writeOffset,
  });
  return { via, ctx, advance: (n: number) => { clk += n; }, getClk: () => clk };
}

// VICE viacore.c lines 648-650 + 760 — T1CH stores using rclk = clk -
// write_offset, then schedules t1_zero_alarm at t1zero = rclk+1+tal.
// With clk=100, write_offset=1, tal=4: alarm fires at
// 99 + 1 + 4 = 104.
test("T1CH alarm scheduled at (rclk + 1 + tal) where rclk = clk - write_offset", () => {
  const h = harness(1);
  h.via.store(VIA_T1LL, 0x04);
  h.via.store(VIA_T1CH, 0x00);   // tal=4
  assert.equal(alarmContextNextPendingClk(h.ctx), 104);
});

// With write_offset = 0 and same params, alarm should land 1 cycle
// later (107).
test("write_offset=0 vs write_offset=1 — alarm scheduling differs by 1", () => {
  const h0 = harness(0);
  h0.via.store(VIA_T1LL, 0x04);
  h0.via.store(VIA_T1CH, 0x00);
  const a0 = alarmContextNextPendingClk(h0.ctx);
  const h1 = harness(1);
  h1.via.store(VIA_T1LL, 0x04);
  h1.via.store(VIA_T1CH, 0x00);
  const a1 = alarmContextNextPendingClk(h1.ctx);
  assert.equal(a0 - a1, 1);
});

// VICE viacore.c line 758 — t1zero = rclk + 1 + tal. With our values
// that's also 99 + 1 + 4 = 104.
test("T1CH sets t1zero = rclk + 1 + tal", () => {
  const h = harness(1);
  h.via.store(VIA_T1LL, 0x04);
  h.via.store(VIA_T1CH, 0x00);
  assert.equal(h.via.t1zero, 104);
});

// VICE viacore.c line 757 — t1reload = rclk + 1 + tal + FULL_CYCLE_2.
test("T1CH sets t1reload = rclk + 1 + tal + 2", () => {
  const h = harness(1);
  h.via.store(VIA_T1LL, 0x04);
  h.via.store(VIA_T1CH, 0x00);
  assert.equal(h.via.t1reload, 106);
});

// ---- runner --------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nvia-write-offset: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
