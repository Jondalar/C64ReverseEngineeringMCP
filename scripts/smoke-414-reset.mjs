#!/usr/bin/env node
// Spec 414 — 1541 Phase H reset semantics smoke.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §13 Phase H step 33:
//         "Reset: hard-reset clears RAM, restarts CPU at reset vector.
//          Soft reset = pulse RESET line (or `JMP ($FFFC)` from
//          monitor)."
//
// VICE: src/drive/drive.c:162  drive_init() — RAM allocated via
//         lib_calloc (= zero-fill). Hard reset = re-init.
//       src/drive/drivecpu.c:194 drivecpu_reset() — soft reset: clears
//         clk + interrupts + jump to reset vector. RAM is NOT touched.
//       src/core/viacore.c:378-439 viacore_reset — preserves SR
//         (register 10); registers 11..15 cleared.
//
// Acceptance per spec 414:
//   - hard reset clears drive RAM (sentinel byte gone),
//   - soft reset preserves drive RAM (sentinel byte still there).
//
// Tier (PLAN.md): 414 = core/structural — smokes only.

import { existsSync } from "node:fs";

let DriveCpu;
let loadDriveRom;
try {
  ({ DriveCpu } = await import("../dist/runtime/headless/drive/drive-cpu.js"));
  ({ loadDriveRom } = await import("../dist/runtime/headless/drive/drive-rom.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

// Construct a standalone drive — microcoded for 1:1 VICE shape
// (spec 414 lifecycle test does not need IEC/GCR coupling).
const rom = loadDriveRom();
const drive = new DriveCpu({ rom, useMicrocodedCpu: true });

// ---------- Sentinel patterns ----------
const SENTINEL_RAM_OFFSET = 0x0123;
const SENTINEL_RAM_VALUE = 0x5a;
const SENTINEL_VIA1_T1L = 0xab;
const SENTINEL_VIA1_T1H = 0xcd;

function seedSentinels() {
  drive.bus.ram[SENTINEL_RAM_OFFSET] = SENTINEL_RAM_VALUE;
  // Stamp T1 latch via direct register writes ($1804/$1805).
  drive.bus.via1.write(0x04, SENTINEL_VIA1_T1L);
  drive.bus.via1.write(0x05, SENTINEL_VIA1_T1H);
}

// ===========================================================
// Test 1 — HARD RESET clears RAM (= drive_init / power-on).
// ===========================================================
seedSentinels();
check(
  "pre-hard-reset: sentinel byte present in RAM",
  drive.bus.ram[SENTINEL_RAM_OFFSET] === SENTINEL_RAM_VALUE,
  `ram[$${SENTINEL_RAM_OFFSET.toString(16)}]=$${drive.bus.ram[SENTINEL_RAM_OFFSET].toString(16)}`,
);

drive.reset();

check(
  "hard reset cleared sentinel byte (RAM zeroed per drive_init §13-H step 33)",
  drive.bus.ram[SENTINEL_RAM_OFFSET] === 0x00,
  `ram[$${SENTINEL_RAM_OFFSET.toString(16)}]=$${drive.bus.ram[SENTINEL_RAM_OFFSET].toString(16)} (expected 0)`,
);

check(
  "hard reset cleared all 2 KB of drive RAM",
  drive.bus.ram.every((b) => b === 0),
  `nonZeroCount=${[...drive.bus.ram].filter((b) => b !== 0).length}`,
);

// ===========================================================
// Test 2 — SOFT RESET preserves RAM (= RESET line pulse).
// ===========================================================
seedSentinels();
check(
  "pre-soft-reset: sentinel byte present in RAM",
  drive.bus.ram[SENTINEL_RAM_OFFSET] === SENTINEL_RAM_VALUE,
);

drive.softReset(0);

check(
  "soft reset PRESERVED sentinel byte (RAM survives §13-H step 33)",
  drive.bus.ram[SENTINEL_RAM_OFFSET] === SENTINEL_RAM_VALUE,
  `ram[$${SENTINEL_RAM_OFFSET.toString(16)}]=$${drive.bus.ram[SENTINEL_RAM_OFFSET].toString(16)} (expected $${SENTINEL_RAM_VALUE.toString(16)})`,
);

// CPU was reset to vector (drivecpu_reset → interrupt_trigger_reset).
// Reset vector lives at $FFFC/$FFFD in ROM. With ROM loaded the
// drive's PC should land in ROM space (>= $C000) after the reset
// kicks off the next instruction.
check(
  "soft reset cleared drive clock (drivecpu_reset:197 *(drv->clk_ptr) = 0)",
  drive.cpu.cycles === 0,
  `cycles=${drive.cpu.cycles}`,
);

// VIA reset preserves SR (register 10) per viacore.c:357. Check by
// writing a sentinel SR pre-reset and asserting it persists. Note:
// our soft-reset calls bus.via1.reset() which uses viacore semantics.
drive.bus.ram[SENTINEL_RAM_OFFSET] = SENTINEL_RAM_VALUE;
drive.bus.via1.write(0x0a, 0x77);  // SR
const srBefore = drive.bus.via1.sr;
drive.softReset(0);
check(
  "soft reset preserved VIA1 SR (viacore_reset preserves register 10)",
  drive.bus.via1.sr === srBefore,
  `srBefore=$${srBefore.toString(16)} srAfter=$${drive.bus.via1.sr.toString(16)}`,
);
check(
  "soft reset preserved RAM after VIA register write sequence",
  drive.bus.ram[SENTINEL_RAM_OFFSET] === SENTINEL_RAM_VALUE,
);

// ===========================================================
// Test 3 — enable / disable lifecycle (Phase H step 32).
// ===========================================================
// After softReset(), drive should be enabled (default = true).
check(
  "post-softReset: drive.enabled is true (default)",
  drive.enabled === true,
);

drive.disable();
check(
  "drive.disable(): enabled flag = false",
  drive.enabled === false,
);

// executeToClock on a disabled drive must early-return (no progress).
const cyclesBeforeDisabledRun = drive.cpu.cycles;
drive.executeToClock(100_000);
check(
  "disabled drive executeToClock: CPU cycles did NOT advance",
  drive.cpu.cycles === cyclesBeforeDisabledRun,
  `cyclesBefore=${cyclesBeforeDisabledRun} cyclesAfter=${drive.cpu.cycles}`,
);

drive.enable(0);
check(
  "drive.enable(): enabled flag back to true",
  drive.enabled === true,
);

// ===========================================================
// Report
// ===========================================================
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 414 reset+enable smoke — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
