// Spec 150 — VIC-II raster IRQ unit tests.
//
// VICE source:
//   - vicii-irq.c vicii_irq_set_line (line 42).
//   - vicii-irq.c vicii_irq_raster_set (line 64).
//   - vicii-irq.c vicii_irq_set_raster_line (line 112) — alarm scheduling.
//   - vicii-irq.c vicii_irq_check_state (line 165) — $D011 / $D012 write.
//   - vicii-mem.c d019_read (line 1599).
//
// Run:
//   npx tsx tests/unit/vic/vic-raster-irq.test.ts

import { strict as assert } from "node:assert";
import { makeTestVic } from "./vic-test-helpers.js";
import {
  VICII_IRQ_RASTER,
  VICII_PAL_CYCLES_PER_LINE,
  VICII_R_CTRL1,
  VICII_R_IRQ_MASK,
  VICII_R_IRQ_STATUS,
  VICII_R_RASTER,
} from "../../../src/runtime/headless/vic/vic-ii-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function tickToLine(vic: ReturnType<typeof makeTestVic>["vic"], clk: { v: number }, target: number): void {
  while (vic.raster_y !== target) {
    vic.tick(VICII_PAL_CYCLES_PER_LINE);
    clk.v += VICII_PAL_CYCLES_PER_LINE;
  }
}

// VICE: vicii_irq_raster_set + vicii_irq_set_line — when masked source
// pending, irq_status bit 7 is summary, backend.setIrqLine(true).
test("raster IRQ enabled + raster match → irq_status bit 0 set", () => {
  const { vic, clk } = makeTestVic();
  vic.write(VICII_R_IRQ_MASK, 0x01); // enable raster IRQ
  vic.write(VICII_R_RASTER, 100);
  vic.write(VICII_R_CTRL1, 0); // bit 8 of compare = 0
  tickToLine(vic, clk, 100);
  assert.ok(vic.irq_status & VICII_IRQ_RASTER, "raster IRQ flag set");
  assert.ok(vic.irq_status & 0x80, "summary bit set when masked source pending");
  assert.ok(vic.irqAsserted(), "irqAsserted true when masked source pending");
});

// VICE: irq_status bit 0 set even when mask=0 — VICE sets the source
// flag, but bit 7 / IRQ line stays low.
test("raster match with mask=0 sets bit 0 but not bit 7", () => {
  const { vic, clk } = makeTestVic();
  vic.write(VICII_R_IRQ_MASK, 0x00); // disabled
  vic.write(VICII_R_RASTER, 50);
  tickToLine(vic, clk, 50);
  assert.ok(vic.irq_status & VICII_IRQ_RASTER, "source flag set");
  assert.equal(vic.irq_status & 0x80, 0, "summary bit clear when masked off");
  assert.ok(!vic.irqAsserted(), "irqAsserted false");
});

// VICE: backend.setIrqLine pulses on both raise + clear via $D019 write.
test("backend.setIrqLine asserted on raster match, deasserted on $D019 ack", () => {
  const { vic, events, clk } = makeTestVic();
  vic.write(VICII_R_IRQ_MASK, 0x01);
  vic.write(VICII_R_RASTER, 60);
  tickToLine(vic, clk, 60);
  // Most recent setIrqLine should be asserted=true.
  const last = events.irqLine[events.irqLine.length - 1]!;
  assert.equal(last.asserted, true);
  // Ack via $D019 write.
  vic.write(VICII_R_IRQ_STATUS, 0x01);
  const after = events.irqLine[events.irqLine.length - 1]!;
  assert.equal(after.asserted, false);
});

// VICE: $D019 read returns irq_status with bit 7 summary + bits 4..6
// open (0x70 OR pattern in d019_read line 1612).
test("$D019 read returns source bits + 0x70 + bit 7 summary", () => {
  const { vic, clk } = makeTestVic();
  vic.write(VICII_R_IRQ_MASK, 0x01);
  vic.write(VICII_R_RASTER, 80);
  tickToLine(vic, clk, 80);
  const v = vic.read(VICII_R_IRQ_STATUS);
  // Expected: bit 0 set + bit 4-6 set + bit 7 set = 0xf1.
  assert.equal(v, 0xf1, `expected 0xf1, got 0x${v.toString(16)}`);
});

// VICE: $D012 write changing comparator triggers immediate match if
// raster_y already at the new value.
test("$D012 write to current raster_y triggers immediate IRQ", () => {
  const { vic, clk } = makeTestVic();
  vic.write(VICII_R_IRQ_MASK, 0x01);
  // Walk to line 30.
  tickToLine(vic, clk, 30);
  // Set comparator to 30 → should fire now (vicii_irq_check_state line 230).
  vic.write(VICII_R_RASTER, 30);
  assert.ok(vic.irq_status & VICII_IRQ_RASTER, "irq fires on $D012 write matching current line");
});

// VICE: $D011 bit 7 = compare bit 8.
test("$D011 bit 7 sets raster compare bit 8 (line 256)", () => {
  const { vic, clk } = makeTestVic();
  vic.write(VICII_R_IRQ_MASK, 0x01);
  vic.write(VICII_R_RASTER, 0);
  vic.write(VICII_R_CTRL1, 0x80); // bit 7 → compare bit 8 → line 256.
  tickToLine(vic, clk, 256);
  assert.ok(vic.irq_status & VICII_IRQ_RASTER, "raster IRQ at line 256");
});

// VICE: writing $D019 with bit 7 also clears it (irq_status &= ~0x80).
// Then bit 7 is re-asserted on next set_line if masked source still
// pending.
test("$D019 write does not re-fire while bit pending without ack", () => {
  const { vic, clk } = makeTestVic();
  vic.write(VICII_R_IRQ_MASK, 0x01);
  vic.write(VICII_R_RASTER, 100);
  tickToLine(vic, clk, 100);
  assert.ok(vic.irq_status & 0x80);
  // Write 0x00 — nothing acked. Bit 7 stays.
  vic.write(VICII_R_IRQ_STATUS, 0x00);
  assert.ok(vic.irq_status & VICII_IRQ_RASTER, "raster source still set");
  // viciiIrqSetLine recomputes summary — should remain set.
  assert.ok(vic.irqAsserted());
});

// VICE: vicii_irq_set_raster_line schedules alarm at correct clk.
// We verify by calling viciiIrqSetRasterLine directly and inspecting
// raster_irq_clk.
test("viciiIrqSetRasterLine sets raster_irq_clk for future line", () => {
  const { vic, clk } = makeTestVic();
  clk.v = 0;
  // Walk part of a line so raster_cycle != 0 to test offset math.
  vic.tick(20);
  clk.v = 20;
  vic.viciiIrqSetRasterLine(10);
  // Expected: line 10 from line 0 cycle 20: lineStartClk = 0,
  // fireClk = 0 + 2 + 63*10 = 632.
  assert.equal(vic.raster_irq_clk, 632);
});

// VICE: line 0 has +1 cycle delay (vicii_irq_set_raster_line 144-146).
test("raster compare line 0 has +1 cycle delay", () => {
  const { vic, clk } = makeTestVic();
  clk.v = 0;
  // Move past line 0 first, then change to non-0 compare so we can
  // re-target line 0 without hitting the early-out.
  tickToLine(vic, clk, 50);
  vic.viciiIrqSetRasterLine(123); // park at non-0
  const startClk = clk.v;
  vic.viciiIrqSetRasterLine(0);
  // Next line-0 is in (312-50) lines: lineStartClk + 2 + 63*262 + 1.
  const expected = startClk + 2 + 63 * 262 + 1;
  assert.equal(vic.raster_irq_clk, expected);
});

// VICE: out-of-range line → CLOCK_MAX, alarm unset.
test("raster compare line >= screen_height disables alarm", () => {
  const { vic } = makeTestVic();
  vic.viciiIrqSetRasterLine(312);
  assert.equal(vic.raster_irq_clk, 0xffffffff >>> 0);
});

// ---- runner ----
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nvic-raster-irq: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
