#!/usr/bin/env node
// Spec 409 — 1541 Phase C (sync model) sync_factor constant smoke.
//
// Doctrine: 1:1 VICE TDE port. Doc anchors:
//   docs/vice-1541-arch.md §5.1 (16.16 fixed-point factor),
//                          §5.3 (PAL/NTSC switch),
//                          §13 Phase C step 7,
//                          §17 OQ-409-1, OQ-409-2, OQ-409-3.
//   docs/vice-iec-arc42.md §5.12 (sync_factor initialization).
//
// VICE cite: src/drive/drivesync.c:53-65 drive_set_machine_parameter():
//
//   sync_factor = (unsigned int)floor(65536.0 *
//       (1000000.0 / (double)cycles_per_sec));
//
// For x64sc / 1541 (clock_frequency = 1):
//   PAL  cycles_per_sec = 985248  → sync_factor = 0x103D5 = 66517.
//   NTSC cycles_per_sec = 1022730 → sync_factor = 0xFA4F  = 64079.
//
// This smoke checks BOTH:
//   1. The exported module constants SYNC_FACTOR_1541_PAL /
//      SYNC_FACTOR_1541_NTSC equal those values.
//   2. A live DriveCpu, after driveSetMachineParameter(cyclesPerSec),
//      returns those values via getSyncFactor16dot16().
//   3. driveSetMachineParameter() can be re-invoked (= PAL/NTSC switch
//      per VICE c64_set_model_timing) and the factor recomputes.

import {
  DriveCpu,
  SYNC_FACTOR_1541_PAL,
  SYNC_FACTOR_1541_NTSC,
  C64_PAL_CYCLES_PER_SEC,
  C64_NTSC_CYCLES_PER_SEC,
  DRIVE_NOMINAL_HZ,
} from "../dist/runtime/headless/drive/drive-cpu.js";

const PAL_EXPECTED = 0x103D5;
const NTSC_EXPECTED = 0xFA4F;

const cases = [];

function check(name, actual, expected) {
  const pass = actual === expected;
  cases.push({ name, pass, actual, expected });
  const tag = pass ? "PASS" : "FAIL";
  const hex = (n) => "0x" + (n >>> 0).toString(16).toUpperCase();
  console.log(`  [${tag}] ${name} — actual=${actual} (${hex(actual)}), expected=${expected} (${hex(expected)})`);
}

console.log("smoke-409-sync-factor:");
console.log(`  DRIVE_NOMINAL_HZ = ${DRIVE_NOMINAL_HZ}`);
console.log(`  C64_PAL_CYCLES_PER_SEC = ${C64_PAL_CYCLES_PER_SEC}`);
console.log(`  C64_NTSC_CYCLES_PER_SEC = ${C64_NTSC_CYCLES_PER_SEC}`);

// 1. Module constants.
check("SYNC_FACTOR_1541_PAL  == 0x103D5 (= floor(65536*1e6/985248))",
  SYNC_FACTOR_1541_PAL, PAL_EXPECTED);
check("SYNC_FACTOR_1541_NTSC == 0xFA4F  (= floor(65536*1e6/1022730))",
  SYNC_FACTOR_1541_NTSC, NTSC_EXPECTED);

// 2. Live DriveCpu sync_factor (PAL).
const drv = new DriveCpu({ useMicrocodedCpu: true });
drv.driveSetMachineParameter(C64_PAL_CYCLES_PER_SEC);
check("DriveCpu.getSyncFactor16dot16() PAL init",
  drv.getSyncFactor16dot16(), PAL_EXPECTED);

// 3. NTSC switch via re-init (= VICE c64_set_model_timing() →
//    drive_set_machine_parameter() in c64.c:1347).
drv.driveSetMachineParameter(C64_NTSC_CYCLES_PER_SEC);
check("DriveCpu.getSyncFactor16dot16() NTSC after switch",
  drv.getSyncFactor16dot16(), NTSC_EXPECTED);

// 4. Switch back to PAL.
drv.driveSetMachineParameter(C64_PAL_CYCLES_PER_SEC);
check("DriveCpu.getSyncFactor16dot16() PAL after switch-back",
  drv.getSyncFactor16dot16(), PAL_EXPECTED);

const passed = cases.filter((c) => c.pass).length;
const total = cases.length;
console.log(`summary: ${passed}/${total} pass, ${total - passed} fail`);
process.exit(passed === total ? 0 : 1);
