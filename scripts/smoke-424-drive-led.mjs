#!/usr/bin/env node
// Spec 424 — Drive LED behavior smoke.
//
// Synthetic test PRG flips VIA2 PB3 (LED bit) directly via $1C00 writes.
// Verifies:
//   1. Cold reset: LED off (no PB3 transitions yet).
//   2. PRG sets PB3 = 1 → ledMonitor.currentLedOn() === true
//   3. PRG clears PB3 = 0 → currentLedOn() === false
//   4. PRG toggles PB3 ≥3 times → ledMonitor.isFlashing() === true
//
// Bypasses GCR write path entirely (= per OQ-424-4 resolution).

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);

const checks = [];
function check(name, ok, msg = "") {
  checks.push({ name, ok, msg });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${msg ? " — " + msg : ""}`);
}

// Drive ROM contains the actual writes; we can't easily inject a 6502 PRG
// into the drive. Instead, drive the VIA2 PB3 latch directly through the
// chip API (same effect — chip latch transitions are what we observe).
const { session } = startIntegratedSession({ sessionId: "smoke-424", videoStandard: "pal" });

// 1. Initial state
const drv = session.drive;
const led = drv.bus.ledMonitor;
check("initial led off", led.currentLedOn() === false);
check("initial not flashing", led.isFlashing(drv.cpu.cycles) === false);

// Force the PRB DDR to output for PB3 then write 1 then 0 several times.
// Simulates what 1541 DOS does at $EBE7..$EC15 (LED toggle loop).
const via2 = drv.bus.via2.via;
// VIA registers: VIA_DDRB=2, VIA_PRB=0
via2.store(2, 0x08);   // DDRB: PB3 as output
via2.store(0, 0x08);   // PRB: PB3 = 1
let cyc = drv.cpu.cycles;
check("led on after PB3=1", led.currentLedOn() === true);

via2.store(0, 0x00);   // PRB: PB3 = 0
check("led off after PB3=0", led.currentLedOn() === false);

// Toggle 4 more times to exceed FLASH_EDGE_THRESHOLD (3 edges within 2M).
via2.store(0, 0x08);
via2.store(0, 0x00);
via2.store(0, 0x08);
via2.store(0, 0x00);
check("flashing after ≥3 edges", led.isFlashing(drv.cpu.cycles) === true);

// Quiet period > 2M cycles → flashing should clear.
// (We can't easily fast-forward 2M drive cycles in a unit smoke without
// running the CPU. Skip the decay assertion; covered by integration smokes
// later. Document as smoke limitation.)

// Summary
const fails = checks.filter(c => !c.ok).length;
console.log(`---\nsummary: ${checks.length - fails}/${checks.length} pass, ${fails} fail`);
process.exit(fails > 0 ? 1 : 0);
