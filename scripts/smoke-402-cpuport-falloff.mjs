#!/usr/bin/env node
// Spec 402 — CPU port bit-6/7 fall-off smoke.
//
// Doctrine: 1:1 VICE x64sc port. Doc anchors:
//   docs/vice-c64-arch.md §4.3 (processor port `$01` and `$00`),
//                       §12 Phase B step 7,
//                       §13 invariant 11 (fall-off semantics).
//
// VICE cite: src/c64/c64.h:79 (C64_CPU6510_DATA_PORT_FALL_OFF_CYCLES = 350000),
//            src/c64/c64mem.c:295-336 (pport.data_set_bitN discharge),
//            src/c64/c64mem.c:421-471 (DDR transition output→input snapshot).
//
// OQ-402-2 (RESOLVED): fall-off = 350000 cycles (≈ 355 ms @ PAL).
//
// Test plan:
//   1. Reset bus. Write $00 = $FF (all bits OUTPUT) and $01 = $C0
//      (bits 6,7 latched HIGH).
//   2. Flip $00 = $3F (bits 6,7 → INPUT). The DDR transition snapshots
//      the latched data bit into the capacitor; reads at $01 return
//      the snapshot bits while the falloff timer is alive.
//   3. Verify read returns bits 6,7 = 1.
//   4. Advance clock by 350000-1 cycles. Verify read still returns 1.
//   5. Advance one more cycle (= 350000 total). Verify read falls to 0.
//
// The smoke uses HeadlessMemoryBus directly with setCpuPortClock() to
// inject a controllable clock — no full CPU needed.

import { HeadlessMemoryBus } from "../dist/runtime/headless/memory-bus.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

const FALLOFF_CYCLES = 350000;

// --- Test 1: bit 7 fall-off ---
{
  const bus = new HeadlessMemoryBus();
  bus.reset();
  let clk = 0;
  bus.setCpuPortClock(() => clk);

  // Drive bit 7 HIGH as output.
  bus.write(0x0000, 0xff);            // DDR all output
  bus.write(0x0001, 0xc0);            // data: bits 6,7 = 1, rest = 0
  // Confirm initial read with all-output: bit 7 returns 1 directly.
  const r0 = bus.read(0x0001);
  check(
    "initial output-mode read bit 7 = 1",
    (r0 & 0x80) !== 0,
    `byte=$${r0.toString(16)}`,
  );

  // Flip bits 6,7 to INPUT. Capacitor snapshots latched value (= 1).
  bus.write(0x0000, 0x3f);            // DDR bits 6,7 = 0 (input)
  const r1 = bus.read(0x0001);
  check(
    "after DDR→input, read bit 7 = 1 (capacitor holds latched value)",
    (r1 & 0x80) !== 0,
    `byte=$${r1.toString(16)}`,
  );
  check(
    "after DDR→input, read bit 6 = 1 (capacitor holds latched value)",
    (r1 & 0x40) !== 0,
    `byte=$${r1.toString(16)}`,
  );

  // Advance clock to FALLOFF_CYCLES - 1 — must still read 1.
  clk = FALLOFF_CYCLES - 1;
  const r2 = bus.read(0x0001);
  check(
    `at clk=${FALLOFF_CYCLES - 1} bit 7 still = 1 (just under falloff)`,
    (r2 & 0x80) !== 0,
    `byte=$${r2.toString(16)}`,
  );
  check(
    `at clk=${FALLOFF_CYCLES - 1} bit 6 still = 1 (just under falloff)`,
    (r2 & 0x40) !== 0,
    `byte=$${r2.toString(16)}`,
  );

  // Advance one more cycle = FALLOFF_CYCLES + 1 → past discharge.
  // VICE compares `data_set_clk_bitN < maincpu_clk` (c64mem.c:299),
  // so the discharge condition fires when clk > set_clk. set_clk was
  // (snapshot_clk + FALLOFF_CYCLES). The latest snapshot was at clk=0,
  // so set_clk = FALLOFF_CYCLES. We need clk > FALLOFF_CYCLES.
  clk = FALLOFF_CYCLES + 1;
  const r3 = bus.read(0x0001);
  check(
    `at clk=${FALLOFF_CYCLES + 1} bit 7 fell to 0 (capacitor discharged)`,
    (r3 & 0x80) === 0,
    `byte=$${r3.toString(16)}`,
  );
  check(
    `at clk=${FALLOFF_CYCLES + 1} bit 6 fell to 0 (capacitor discharged)`,
    (r3 & 0x40) === 0,
    `byte=$${r3.toString(16)}`,
  );
}

// --- Test 2: re-driving a bit recharges the capacitor ---
{
  const bus = new HeadlessMemoryBus();
  bus.reset();
  let clk = 0;
  bus.setCpuPortClock(() => clk);

  // Drive bit 7 high as output, flip to input, advance past falloff.
  bus.write(0x0000, 0xff);
  bus.write(0x0001, 0x80);
  bus.write(0x0000, 0x7f);            // bit 7 → input
  clk = FALLOFF_CYCLES + 100;
  const fallen = bus.read(0x0001);
  check(
    "bit 7 fell to 0 after long discharge",
    (fallen & 0x80) === 0,
    `byte=$${fallen.toString(16)}`,
  );

  // Now flip bit 7 back to output, write 1, then back to input.
  // The new latched output should recharge the capacitor.
  bus.write(0x0000, 0xff);
  bus.write(0x0001, 0x80);
  bus.write(0x0000, 0x7f);
  const recharged = bus.read(0x0001);
  check(
    "after re-drive output→input, bit 7 = 1 again",
    (recharged & 0x80) !== 0,
    `byte=$${recharged.toString(16)}`,
  );

  // And it falls again after another FALLOFF_CYCLES.
  const snapClk = clk;
  clk = snapClk + FALLOFF_CYCLES + 1;
  const fallenAgain = bus.read(0x0001);
  check(
    "after second FALLOFF_CYCLES window, bit 7 fell to 0 again",
    (fallenAgain & 0x80) === 0,
    `byte=$${fallenAgain.toString(16)}`,
  );
}

// --- Test 3: writes while bit is OUTPUT keep the capacitor charged ---
{
  const bus = new HeadlessMemoryBus();
  bus.reset();
  let clk = 0;
  bus.setCpuPortClock(() => clk);
  bus.write(0x0000, 0xff);
  bus.write(0x0001, 0x80);            // bit 7 = 1
  // Repeatedly write while output — every write while DDR bit=1 resets
  // data_set_clk_bitN (c64mem.c:461-471).
  for (let i = 0; i < 5; i++) {
    clk += 100000;
    bus.write(0x0001, 0x80);
  }
  // Flip to input. The most-recent write was clk; falloff lands at clk+FALLOFF.
  bus.write(0x0000, 0x7f);
  const baseClk = clk;
  clk = baseClk + FALLOFF_CYCLES - 1;
  const r = bus.read(0x0001);
  check(
    "writes while output reset falloff clock; bit 7 = 1 just under fall window",
    (r & 0x80) !== 0,
    `byte=$${r.toString(16)} baseClk=${baseClk} clk=${clk}`,
  );
}

// ------- Report -------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 402 CPU-port fall-off smoke — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
console.log(`note: FALLOFF_CYCLES=${FALLOFF_CYCLES} (c64.h:79, OQ-402-2)`);
process.exit(failed > 0 ? 1 : 0);
