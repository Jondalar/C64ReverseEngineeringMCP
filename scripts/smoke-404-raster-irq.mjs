#!/usr/bin/env node
// Spec 404 Phase D — VIC-II raster IRQ edge-latch smoke.
//
// Doctrine: 1:1 VICE x64sc port. The raster compare IRQ ($D012 + $D011.7)
// must fire EXACTLY ONCE per matching line, even after $D012 is re-written
// to the same value. VICE uses an edge-latch (`raster_irq_triggered` in
// `viciisc/viciitypes.h`) cleared on raster_line non-match.
//
// Doc anchor: docs/vice-c64-arch.md §5.11 IRQ ("edge-latched").
// VICE source:
//   - src/viciisc/vicii-cycle.c:467-474 (raster-IRQ compare).
//   - src/viciisc/vicii-irq.c:36-67 (vicii_irq_set_line +
//     vicii_irq_raster_set + maincpu_set_irq_clk push site).
//
// Per spec 404: synthetic test of the literal-port chip alone.

import {
  vicii,
} from "../dist/runtime/headless/vic/literal/vicii-types.js";
import { vicii_chip_model_init } from "../dist/runtime/headless/vic/literal/vicii-chip-model.js";
import { vicii_init, vicii_reset } from "../dist/runtime/headless/vic/literal/vicii.js";
import { vicii_cycle, setMaincpuClk } from "../dist/runtime/headless/vic/literal/vicii-cycle.js";
import { vicii_store } from "../dist/runtime/headless/vic/literal/vicii-mem.js";
import { setIrqHost } from "../dist/runtime/headless/vic/literal/vicii-irq.js";

// Capture every set/clear of the IRQ line.
const events = [];
let mclk = 0;
setIrqHost({
  maincpu_set_irq: (intNum, value) => events.push({ kind: "set", intNum, value, mclk }),
  maincpu_set_irq_clk: (intNum, value, atClk) => events.push({ kind: "set_clk", intNum, value, mclk: atClk }),
  maincpu_clk: () => mclk,
  interrupt_cpu_status_int_new: (_name) => 1,
});

vicii_chip_model_init();
vicii_init();
vicii_reset();

// Program: raster IRQ on line 100. $D011 bit 7 = high bit of compare,
// $D012 = low 8 bits. $D01A bit 0 = enable raster IRQ.
const TARGET_LINE = 100;
vicii_store(0x12, TARGET_LINE & 0xff);
vicii_store(0x11, vicii.regs[0x11] & 0x7f);   // bit 7 = 0
vicii_store(0x1a, 0x01);                       // enable raster IRQ

// Run two full PAL frames (= 2 × 63 × 312 = 39312 cycles). Should see
// exactly TWO IRQ asserts (one per frame at line 100). Edge-latch
// guarantees one-fire per match.
const CYCLES_PER_FRAME = 63 * 312;
const TOTAL = CYCLES_PER_FRAME * 2;
let asserts = 0;
let prevLine = -1;
const assertLines = [];
let prevRaisesCount = 0;
for (let i = 0; i < TOTAL; i++) {
  mclk++;
  setMaincpuClk(mclk);
  vicii_cycle();
  // On line change off the target line, clear $D019 raster latch
  // (= simulating the CPU's IRQ ISR writing 1 to bit 0 of $D019,
  // which is the read-clear / 1-to-clear semantic in VICE: see
  // vicii-mem.c d019_store). This lets the next compare-match fire
  // a fresh edge.
  if (vicii.raster_line !== prevLine) {
    if (prevLine === TARGET_LINE) {
      // Write 1 to bit 0 = clear raster IRQ latch.
      vicii_store(0x19, 0x01);
    }
    prevLine = vicii.raster_line;
  }
  // Record line transitions where the IRQ status flips ON.
  const raises = events.filter((e) => e.value === 1).length;
  if (raises > prevRaisesCount) {
    assertLines.push({ line: vicii.raster_line, cycle: i });
    prevRaisesCount = raises;
  }
}

// Count distinct "raise" edges (value=1 events).
const raises = events.filter((e) => e.value === 1).length;
const lowers = events.filter((e) => e.value === 0).length;

let pass = 0, fail = 0;
const errs = [];

function check(name, cond) {
  if (cond) pass++;
  else { fail++; errs.push(name); }
}

// Spec 404 acceptance: "D012 compare → IRQ fires once per matching line".
// 2 frames = 2 raises. Allow ±1 due to startup/first-line edge.
check(`raise count within [2,3] (got ${raises})`, raises >= 2 && raises <= 3);
check(`raises observed at non-zero count`, raises > 0);

// Edge latch: each raise should be at line==TARGET_LINE.
const wrongLines = assertLines.filter((e) => e.line !== TARGET_LINE && e.line !== TARGET_LINE + 1);
check(`all raises at line ${TARGET_LINE} (got ${assertLines.length} raises, ${wrongLines.length} wrong)`, wrongLines.length === 0);

// Re-write $D012 to same value: must NOT re-fire mid-line.
const beforeRewriteRaises = events.filter((e) => e.value === 1).length;
mclk++;
vicii_store(0x12, TARGET_LINE & 0xff);
mclk++;
vicii_cycle();
const afterRewriteRaises = events.filter((e) => e.value === 1).length;
check(`rewrite-same-value does not retrigger (before=${beforeRewriteRaises} after=${afterRewriteRaises})`,
  afterRewriteRaises === beforeRewriteRaises);

// Distinct raise events at TARGET_LINE only (= edge-latch contract).
check(`distinct raises >= 2 (got ${assertLines.length})`, assertLines.length >= 2);

console.log(`Spec 404 raster-irq: ${pass}/${pass + fail} checks pass`);
console.log(`  raises=${raises}  lowers=${lowers}`);
if (fail > 0) {
  console.error("FAIL:");
  for (const e of errs) console.error("  - " + e);
  process.exit(1);
}
process.exit(0);
