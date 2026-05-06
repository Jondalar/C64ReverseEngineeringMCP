// Spec 145 — CIA ICR + IRQ + IFR delay-line tests.
//
// Covers VICE ciacore.c IRQ-related machinery:
//   - cia_set_irq_flag (lines 592-600) — flag set with bookkeeping
//   - cia_run_ifr_cycle (lines 374-435) — 4-stage delay-line shift
//   - cia_ifr_catchup (lines 522-534) — multi-cycle catchup
//   - ICR read clear-on-read (lines 1289-1366)
//   - ICR mask set/clear semantics (lines 938-1009)
//
// Run via:
//   npx tsx tests/unit/cia/cia-icr-irq.test.ts

import { strict as assert } from "node:assert";
import {
  CIA_ICR, CIA_IM_SET, CIA_IM_TA, CIA_IM_TB, CIA_IM_FLG, CIA_IM_SDR,
  CIA_IRQ_RAISE0, CIA_IRQ_RAISE1, CIA_IRQ_D7SET0, CIA_IRQ_ACK1,
  CIA_IRQ_READ0, CIA_IRQ_CLEAR,
  CIA_MODEL_6526, CIA_MODEL_6526A,
} from "../../../src/runtime/headless/cia/cia6526-vice.js";
import { makeTestCia } from "./cia-test-helpers.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ---- ICR mask manipulation -----------------------------------------------

// VICE: ciacore_store_internal CIA_ICR set-bit-7 sets mask bits;
// clear-bit-7 clears mask bits (ciacore.c lines 955-959).
test("ICR mask: bit 7 = 1 enables; bit 7 = 0 disables", () => {
  const { cia } = makeTestCia();
  cia.write(CIA_ICR, CIA_IM_SET | 0x1f); // enable all 5 sources
  assert.equal(cia.c_cia[CIA_ICR], 0x1f);
  cia.write(CIA_ICR, 0x05); // clear TA + TOD
  assert.equal(cia.c_cia[CIA_ICR], 0x1f & ~0x05);
});

// ---- Manual flag setting via setFlag --------------------------------------

// VICE: ciacore_set_flag (ciacore.c lines 1621-1625) → async_interrupt
// → cia_set_irq_flag(rclk, CIA_IM_FLG). irqflags should pick up the bit
// even with mask=0 (mask only gates the CPU IRQ pulse, not the flag).
test("setFlag latches CIA_IM_FLG into irqflags even with mask=0", () => {
  const { cia } = makeTestCia();
  cia.setFlag();
  assert.equal(cia.irqflags & CIA_IM_FLG, CIA_IM_FLG);
});

// ---- ICR read clear-on-read (old CIA) -------------------------------------

// VICE: old-CIA ICR read (ciacore.c lines 1342-1349). After read,
// irqflags &= CIA_IM_SET — i.e. only bit 7 (IM_SET) survives.
test("old CIA: ICR read clears low flag bits, preserves IM_SET", () => {
  const { cia } = makeTestCia({ model: CIA_MODEL_6526 });
  cia.irqflags = CIA_IM_SET | CIA_IM_TA | CIA_IM_TB;
  cia.read(CIA_ICR);
  // Old CIA: only IM_SET preserved.
  assert.equal(cia.irqflags & 0x1f, 0, "low flag bits cleared");
  assert.equal(cia.irqflags & CIA_IM_SET, CIA_IM_SET, "IM_SET preserved");
});

// VICE: ICR read sets CIA_IRQ_ACK1 in the delay-line + clears RAISE0
// (ciacore.c lines 1338-1340 + 1343).
test("old CIA: ICR read sets ACK1 and READ0 in ifr_delay", () => {
  const { cia } = makeTestCia({ model: CIA_MODEL_6526 });
  cia.read(CIA_ICR);
  assert.equal(cia.ifr_delay & CIA_IRQ_ACK1, CIA_IRQ_ACK1, "ACK1 latched");
  assert.equal(cia.ifr_delay & CIA_IRQ_READ0, CIA_IRQ_READ0, "READ0 latched");
});

// ---- ICR read clear-on-read (new CIA) -------------------------------------

// VICE: new-CIA ICR read (ciacore.c lines 1327-1341). irqflags is NOT
// masked to IM_SET; instead ack_irqflags accumulates bits to clear later.
test("new CIA: ICR read populates ack_irqflags for delayed clear", () => {
  const { cia } = makeTestCia({ model: CIA_MODEL_6526A });
  cia.irqflags = CIA_IM_TA | CIA_IM_TB;
  cia.read(CIA_ICR);
  // VICE ciacore.c line 1336: ack_irqflags |= ((irqflags & 0x9f) | 0x80).
  // For irqflags = 0x03, expected = 0x03 | 0x80 = 0x83.
  const expected = ((CIA_IM_TA | CIA_IM_TB) & 0x9f) | 0x80;
  assert.equal(cia.ack_irqflags, expected, "ack_irqflags carries TA+TB+IM_SET");
});

// ---- ICR read drops the IRQ line ------------------------------------------

// VICE: ICR read calls my_set_int(false, rclk) (ciacore.c line 1353).
test("ICR read drops IRQ line via backend setIntClk(0, ...)", () => {
  const { cia, events } = makeTestCia();
  // Simulate IRQ asserted.
  cia.irq_enabled = 1;
  events.setIntClk.length = 0;
  cia.read(CIA_ICR);
  // Last setIntClk call should drop the line (val=0).
  const last = events.setIntClk[events.setIntClk.length - 1];
  assert.ok(last, "expected at least one setIntClk call after ICR read");
  assert.equal(last!.val, 0, "IRQ line dropped");
  assert.equal(cia.irq_enabled, 0);
});

// ---- IFR delay-line single-cycle shift ------------------------------------

// VICE: cia_run_ifr_cycle shift mechanics (ciacore.c lines 431-433).
// Each call shifts ifr_delay LEFT by 1, then clears CIA_IRQ_CLEAR bits.
// We pin behavior via the public IRQ-line: with mask=IM_TA enabled and
// new_irqflags=IM_TA, the pipeline must drive setIntClk(true) within
// 2 cycles per VICE old-CIA RAISE1 path.
test("ifr_delay: pending RAISE1 → drives IRQ line within 2 cycles (old CIA)", () => {
  const { cia, clk, events } = makeTestCia({ model: CIA_MODEL_6526 });
  cia.write(CIA_ICR, CIA_IM_SET | CIA_IM_TA);   // enable IM_TA in mask
  events.setIntClk.length = 0;

  // Simulate a TA underflow having set the flag right at this clock.
  cia.irqflags = CIA_IM_TA;
  cia.new_irqflags = CIA_IM_TA;
  cia.ifr_clock = clk.v;

  // Advance 2 cycles and force catchup via CRA read (which runs ifr).
  clk.v += 2;
  cia.read(0x0e);

  // Old CIA path: RAISE1 set on first cycle (because new_irqflags & ICR
  // mask), shifted to RAISE0 next cycle, fires my_set_int(true).
  const lastTrue = events.setIntClk.find((e) => e.val === 1);
  assert.ok(lastTrue, "IRQ line driven high within 2 cycles");
});

// ---- Async interrupt via setFlag → IRQ propagation ------------------------

// VICE: setFlag → cia_set_irq_flag → idle_alarm → eventually
// my_set_int(true, ...). For a unit test we just verify that the flag
// was registered and the pipeline scheduled (irqflags has FLG bit).
test("setFlag sets CIA_IM_FLG bit and schedules ifr work", () => {
  const { cia } = makeTestCia();
  cia.write(CIA_ICR, CIA_IM_SET | CIA_IM_FLG); // enable FLG
  const before = cia.irqflags;
  cia.setFlag();
  assert.equal((cia.irqflags & ~before) & CIA_IM_FLG, CIA_IM_FLG, "FLG flag set");
  // new_irqflags should contain CIA_IM_FLG too (per cia_set_irq_flag).
  assert.equal(cia.new_irqflags & CIA_IM_FLG, CIA_IM_FLG, "new_irqflags carries FLG");
});

// ---- new vs old CIA model branching ---------------------------------------

// VICE: old CIA always sets RAISE1+D7SET1 when ICR write enables a
// pending mask bit (ciacore.c line 971-972). New CIA uses RAISE0+D7SET0
// (line 967-969) unless READ1 is in the pipeline.
test("old CIA: ICR write enabling pending IRQ → ifr_delay |= RAISE1", () => {
  const { cia } = makeTestCia({ model: CIA_MODEL_6526 });
  cia.irqflags = CIA_IM_TA;          // pending
  cia.irq_enabled = 0;                // line not asserted yet
  cia.write(CIA_ICR, CIA_IM_SET | CIA_IM_TA); // enable TA → triggers
  assert.equal(cia.ifr_delay & CIA_IRQ_RAISE1, CIA_IRQ_RAISE1, "RAISE1 set");
});

test("new CIA: ICR write enabling pending IRQ → ifr_delay |= RAISE0", () => {
  const { cia } = makeTestCia({ model: CIA_MODEL_6526A });
  cia.irqflags = CIA_IM_TA;
  cia.irq_enabled = 0;
  cia.write(CIA_ICR, CIA_IM_SET | CIA_IM_TA);
  assert.equal(cia.ifr_delay & CIA_IRQ_RAISE0, CIA_IRQ_RAISE0, "RAISE0 set");
});

// ---- CIA_IRQ_CLEAR fence bits stay zeroed ---------------------------------

// VICE: each cia_run_ifr_cycle ends with `delay &= ~CIA_IRQ_CLEAR`
// (ciacore.c line 432). After a few cycles those slots must be clear.
test("CIA_IRQ_CLEAR bits zero out after a cycle of pipeline shift", () => {
  const { cia, clk } = makeTestCia();
  cia.ifr_clock = clk.v;
  // Set ALL fence bits explicitly.
  cia.ifr_delay = CIA_IRQ_CLEAR | CIA_IRQ_RAISE0;
  cia.new_irqflags = 0;
  cia.ack_irqflags = 0;
  clk.v += 1;
  cia.read(0x0e); // force catchup
  // After 1 shift: CIA_IRQ_CLEAR positions become zero (re-cleared post-shift).
  // RAISE0 → RAISE_1 which IS in CLEAR → also cleared.
  assert.equal(cia.ifr_delay & CIA_IRQ_CLEAR, 0, "CLEAR bits zeroed");
});

// ---- runner ---------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ncia-icr-irq: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
