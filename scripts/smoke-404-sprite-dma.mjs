#!/usr/bin/env node
// Spec 404 Phase D — sprite-DMA enable smoke.
//
// Doctrine: 1:1 VICE x64sc port. Sprite DMA on/off is sampled at the
// sprite_dma cycles (Phi2(55), Phi1(56)) using ChkSprDma cycle-flag.
// At that point if (raster_y == sprite_y) and $D015 bit set, sprite
// enters DMA → fetch + display next line.
//
// Doc anchor: docs/vice-c64-arch.md §5.8 ("Sprites — state machine") +
// §13 invariant 8.
// VICE source: src/viciisc/vicii-cycle.c (sprite_check_dma in
//              vicii_cycle dispatch via ChkSprDma flag) +
//              src/viciisc/vicii-chip-model.c cycle 55-56 entries.
//
// Test pattern (synthetic): enable sprite 0 with Y == raster_y at
// cycle 55, then run a few more cycles, verify sprite_dma bit 0 latched
// AND sprite_display_bits bit 0 latched on subsequent cycle.

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

// Enable DEN so VIC actually runs the display fetch state machine.
vicii_store(0x11, 0x10);

// Run forward to line 100 (= sprite Y target). Pick that as it's
// well inside the bad-line range and a stable sprite-DMA window.
const TARGET_LINE = 100;
let mclk = 0;
let spriteSetupDone = false;
let dmaSeenAtTarget = false;
let dispSeenAfterTarget = false;

const CYCLES_PER_LINE = 63;
const MAX_CYCLES = CYCLES_PER_LINE * (TARGET_LINE + 5);

for (let i = 0; i < MAX_CYCLES; i++) {
  mclk++;
  setMaincpuClk(mclk);

  // Configure sprite 0 at Y = TARGET_LINE, enable in $D015 BEFORE
  // we reach the sprite's compare window on line (TARGET_LINE-1).
  // $D001 = sprite-0 Y. $D015 = enable mask.
  if (!spriteSetupDone && vicii.raster_line === TARGET_LINE - 2) {
    vicii_store(0x01, TARGET_LINE);     // sprite 0 Y
    vicii_store(0x00, 100);              // sprite 0 X (= some visible value)
    vicii_store(0x15, 0x01);             // enable sprite 0
    spriteSetupDone = true;
  }

  vicii_cycle();

  if (vicii.raster_line === TARGET_LINE) {
    if ((vicii.sprite_dma & 0x01) !== 0) dmaSeenAtTarget = true;
  }
  if (vicii.raster_line >= TARGET_LINE + 1) {
    if ((vicii.sprite_display_bits & 0x01) !== 0) dispSeenAfterTarget = true;
  }
}

let pass = 0, fail = 0;
const errs = [];
function check(name, cond) {
  if (cond) pass++;
  else { fail++; errs.push(name); }
}

check("setup happened", spriteSetupDone === true);
check(`sprite-0 DMA latched on raster_y=${TARGET_LINE}`, dmaSeenAtTarget === true);
check(`sprite-0 display latched on raster_y>${TARGET_LINE}`, dispSeenAfterTarget === true);

console.log(`Spec 404 sprite-dma: ${pass}/${pass + fail} checks pass`);
console.log(`  sprite_dma=$${vicii.sprite_dma.toString(16)}  display_bits=$${vicii.sprite_display_bits.toString(16)}`);
if (fail > 0) {
  console.error("FAIL:");
  for (const e of errs) console.error("  - " + e);
  process.exit(1);
}
process.exit(0);
