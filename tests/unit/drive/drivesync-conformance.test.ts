// Spec 446 — drivesync.c conformance unit tests.
//
// Pins literal-VICE drivesync.c behaviour:
//   - drive_set_machine_parameter formula (sync_factor =
//     floor(65536 * 1_000_000 / cycles_per_sec)) per VICE drivesync.c:57
//   - PAL sync_factor (985248 Hz) = 0x103D6 = 66518
//   - NTSC sync_factor (1022730 Hz) = 0xFA4F = 64079
//   - drivesync_factor: clock_frequency * sync_factor applied
//   - drivesync_clock_frequency(type) dispatch table per drivesync.c:86-117
//   - setPalNtsc switch helper (TS-EXTRA convenience)
//
// Run via:
//   npx tsx tests/unit/drive/drivesync-conformance.test.ts

import { strict as assert } from "node:assert";
import {
  DriveCpu,
  C64_PAL_CYCLES_PER_SEC,
  C64_NTSC_CYCLES_PER_SEC,
  SYNC_FACTOR_1541_PAL,
  SYNC_FACTOR_1541_NTSC,
  DRIVE_NOMINAL_HZ,
} from "../../../src/runtime/headless/drive/drive-cpu.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ---------------------------------------------------------------------------
// Constants pin (literal VICE values from c64.h + drivesync.c)
// ---------------------------------------------------------------------------
test("C64_PAL_CYCLES_PER_SEC = 985248 (VICE c64.h:35)", () => {
  assert.equal(C64_PAL_CYCLES_PER_SEC, 985248);
});

test("C64_NTSC_CYCLES_PER_SEC = 1022730 (VICE c64.h:42)", () => {
  assert.equal(C64_NTSC_CYCLES_PER_SEC, 1022730);
});

test("DRIVE_NOMINAL_HZ = 1_000_000 (VICE drivesync.c:57 literal)", () => {
  assert.equal(DRIVE_NOMINAL_HZ, 1_000_000);
});

// VICE formula: sync_factor = floor(65536 * (1_000_000 / cycles_per_sec))
// PAL  985_248 Hz: 65_536 * 1_000_000 / 985_248 = 66_517.946... → floor = 66_517 = 0x103D5
// NTSC 1_022_730 Hz: 65_536 * 1_000_000 / 1_022_730 = 64_079.something → floor = 64_079 = 0xFA4F
test("SYNC_FACTOR_1541_PAL = 66517 (hand-computed: floor(65536e6 / 985248))", () => {
  assert.equal(SYNC_FACTOR_1541_PAL, 66517);
});

test("SYNC_FACTOR_1541_NTSC = 64079 (hand-computed from VICE formula)", () => {
  assert.equal(SYNC_FACTOR_1541_NTSC, 64079);
});

// ---------------------------------------------------------------------------
// driveSetMachineParameter literal port (VICE drivesync.c:53-62)
// ---------------------------------------------------------------------------
test("driveSetMachineParameter(985248) applies PAL sync_factor", () => {
  const d = new DriveCpu({ deviceId: 8, useMicrocodedCpu: true });
  d.driveSetMachineParameter(C64_PAL_CYCLES_PER_SEC);
  assert.equal(d.getSyncFactor16dot16(), SYNC_FACTOR_1541_PAL);
});

test("driveSetMachineParameter(1022730) applies NTSC sync_factor", () => {
  const d = new DriveCpu({ deviceId: 8, useMicrocodedCpu: true });
  d.driveSetMachineParameter(C64_NTSC_CYCLES_PER_SEC);
  assert.equal(d.getSyncFactor16dot16(), SYNC_FACTOR_1541_NTSC);
});

test("driveSetMachineParameter applies clock_frequency multiplier (drivesync.c:49)", () => {
  // 1541 clockFrequency = 1, so factor equals raw sync_factor. The
  // multiplier line: drv->cpud->sync_factor = drv->clock_frequency * sync_factor.
  const d = new DriveCpu({ deviceId: 8, useMicrocodedCpu: true });
  d.driveSetMachineParameter(C64_PAL_CYCLES_PER_SEC);
  assert.equal(d.getSyncFactor16dot16(), 1 * SYNC_FACTOR_1541_PAL);
});

test("driveSetMachineParameter rejects zero/negative cyclesPerSec", () => {
  const d = new DriveCpu({ deviceId: 8, useMicrocodedCpu: true });
  assert.throws(() => d.driveSetMachineParameter(0));
  assert.throws(() => d.driveSetMachineParameter(-1));
});

// ---------------------------------------------------------------------------
// setPalNtsc convenience helper (Spec 446)
// ---------------------------------------------------------------------------
test("setPalNtsc('pal') sets PAL sync_factor", () => {
  const d = new DriveCpu({ deviceId: 8, useMicrocodedCpu: true });
  d.setPalNtsc("pal");
  assert.equal(d.getSyncFactor16dot16(), SYNC_FACTOR_1541_PAL);
});

test("setPalNtsc('ntsc') sets NTSC sync_factor", () => {
  const d = new DriveCpu({ deviceId: 8, useMicrocodedCpu: true });
  d.setPalNtsc("ntsc");
  assert.equal(d.getSyncFactor16dot16(), SYNC_FACTOR_1541_NTSC);
});

test("setPalNtsc PAL→NTSC switch mid-session changes sync_factor", () => {
  const d = new DriveCpu({ deviceId: 8, useMicrocodedCpu: true });
  d.setPalNtsc("pal");
  assert.equal(d.getSyncFactor16dot16(), SYNC_FACTOR_1541_PAL);
  d.setPalNtsc("ntsc");
  assert.equal(d.getSyncFactor16dot16(), SYNC_FACTOR_1541_NTSC);
});

// ---------------------------------------------------------------------------
// drivesync_clock_frequency dispatch (VICE drivesync.c:86-117)
// ---------------------------------------------------------------------------
test("drivesync_clock_frequency: 1541 family returns 1", () => {
  // DRIVE_TYPE_1541 = 1541 in VICE numbering.
  assert.equal(DriveCpu.drivesync_clock_frequency(1541), 1);
  assert.equal(DriveCpu.drivesync_clock_frequency(1540), 1);
  assert.equal(DriveCpu.drivesync_clock_frequency(1570), 1);
  assert.equal(DriveCpu.drivesync_clock_frequency(1571), 1);
});

test("drivesync_clock_frequency: 1551/1581/4000-family returns 2", () => {
  assert.equal(DriveCpu.drivesync_clock_frequency(1551), 2);
  assert.equal(DriveCpu.drivesync_clock_frequency(1581), 2);
  assert.equal(DriveCpu.drivesync_clock_frequency(2000), 2);
  assert.equal(DriveCpu.drivesync_clock_frequency(4000), 2);
});

test("drivesync_clock_frequency: IEEE drives return 1", () => {
  // 2031, 2040, 3040, 4040, 1001, 8050, 8250, 9000.
  assert.equal(DriveCpu.drivesync_clock_frequency(2031), 1);
  assert.equal(DriveCpu.drivesync_clock_frequency(8050), 1);
  assert.equal(DriveCpu.drivesync_clock_frequency(9000), 1);
});

test("drivesync_clock_frequency: unknown type defaults to 1", () => {
  assert.equal(DriveCpu.drivesync_clock_frequency(9999), 1);
});

// ---------------------------------------------------------------------------
// DriveCpu.clockFrequency for 1541 = 1 (literal const)
// ---------------------------------------------------------------------------
test("DriveCpu (1541) has clockFrequency = 1 (VICE drivesync.c:95)", () => {
  const d = new DriveCpu({ deviceId: 8, useMicrocodedCpu: true });
  assert.equal(d.clockFrequency, 1);
});

// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ndrivesync-conformance: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
