#!/usr/bin/env node
// Spec 404 Phase D — bad-line trace smoke.
//
// Doctrine: 1:1 VICE x64sc port. The bad-line condition fires at the
// first line where:
//   raster_y in [0x30, 0xf7]  AND
//   (raster_y & 7) == ysmooth (= $D011 bits 0..2)  AND
//   allow_bad_lines (= DEN seen at line 0x30)
//
// At the bad line, VIC steals BA-low for 40 matrix-fetch cycles
// (cycles 15..54 in the cycle table). vicii_cycle() returns ba_low=1
// on these cycles; the OR-fold into maincpu_ba_low_flags causes the
// CPU to stall on the next read.
//
// Doc anchor: docs/vice-c64-arch.md §5.3 ("Bad-line condition") +
// §5.7 ("Bad-line BA-low timing") + §13 invariant 7.
// VICE source: src/viciisc/vicii-cycle.c:51 check_badline(),
//              src/viciisc/vicii-chip-model.c:111-237 (cycle_tab_pal BA fetch flags).

import { vicii } from "../dist/runtime/headless/vic/literal/vicii-types.js";
import { vicii_chip_model_init } from "../dist/runtime/headless/vic/literal/vicii-chip-model.js";
import { vicii_init, vicii_reset } from "../dist/runtime/headless/vic/literal/vicii.js";
import { vicii_cycle, setMaincpuClk } from "../dist/runtime/headless/vic/literal/vicii-cycle.js";
import { vicii_store } from "../dist/runtime/headless/vic/literal/vicii-mem.js";
import { setIrqHost } from "../dist/runtime/headless/vic/literal/vicii-irq.js";

setIrqHost({
  maincpu_set_irq: () => {},
  maincpu_set_irq_clk: () => {},
  maincpu_clk: () => 0,
  interrupt_cpu_status_int_new: () => 0,
});

vicii_chip_model_init();
vicii_init();
vicii_reset();

// Enable DEN. Set ysmooth=3 → bad-line at raster_y where y&7==3, in
// [0x30..0xf7]. First match = 0x33 = 51.
const YSMOOTH = 3;
const TARGET_BADLINE = 0x33; // 51 — first matching line with DEN

// $D011: bit 4 = DEN, bits 0..2 = ysmooth. Bit 4 + 3 = 0x13.
vicii_store(0x11, 0x10 | YSMOOTH);

// Run until just past line TARGET_BADLINE + a few. Count cycles
// where vicii_cycle() returns ba_low=1 on TARGET_BADLINE.
const TOTAL = 63 * (TARGET_BADLINE + 5);
let baLowCyclesOnTarget = 0;
let cyclesOnTarget = 0;
let firstBaLowCycle = -1;
let lastBaLowCycle = -1;
let prevRasterLine = -1;
let cycleInLine = 0;
let mclk = 0;
let badLineFlagSeen = false;
let badLineFlagOnTarget = false;

for (let i = 0; i < TOTAL; i++) {
  mclk++;
  setMaincpuClk(mclk);
  const baLow = vicii_cycle();
  // Track line transitions.
  if (vicii.raster_line !== prevRasterLine) {
    prevRasterLine = vicii.raster_line;
    cycleInLine = 0;
  } else {
    cycleInLine++;
  }
  if (vicii.raster_line === TARGET_BADLINE) {
    cyclesOnTarget++;
    if (baLow) {
      baLowCyclesOnTarget++;
      if (firstBaLowCycle < 0) firstBaLowCycle = cycleInLine;
      lastBaLowCycle = cycleInLine;
    }
    if (vicii.bad_line) badLineFlagOnTarget = true;
  }
  if (vicii.bad_line) badLineFlagSeen = true;
}

let pass = 0, fail = 0;
const errs = [];
function check(name, cond) {
  if (cond) pass++;
  else { fail++; errs.push(name); }
}

// Per VICE: BA goes low for ~40 cycles on a bad line (matrix fetch
// window). Allow ±3 due to sprite-BA OR.
check(`bad_line flag set on line ${TARGET_BADLINE} (got ${badLineFlagOnTarget})`, badLineFlagOnTarget === true);
check(`bad_line seen at some point`, badLineFlagSeen === true);
check(`>= 35 BA-low cycles on target (got ${baLowCyclesOnTarget})`, baLowCyclesOnTarget >= 35);
check(`<= 45 BA-low cycles on target (got ${baLowCyclesOnTarget})`, baLowCyclesOnTarget <= 45);

// BA window should be in cycles ~11..54 (1-indexed; 0-indexed ~10..53).
check(`first BA-low cycle in line <= 15 (got ${firstBaLowCycle})`, firstBaLowCycle >= 0 && firstBaLowCycle <= 15);
check(`last BA-low cycle in line >= 50 (got ${lastBaLowCycle})`, lastBaLowCycle >= 50);

console.log(`Spec 404 badline-trace: ${pass}/${pass + fail} checks pass`);
console.log(`  bad-line at raster_y=${TARGET_BADLINE}: ${baLowCyclesOnTarget} BA-low cycles in window [${firstBaLowCycle}..${lastBaLowCycle}]`);
if (fail > 0) {
  console.error("FAIL:");
  for (const e of errs) console.error("  - " + e);
  process.exit(1);
}
process.exit(0);
