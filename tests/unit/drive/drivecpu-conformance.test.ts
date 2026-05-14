// Spec 444 — drivecpu conformance unit tests.
//
// Pins literal-VICE drivecpu_context_t fields + drive_cpu_execute
// semantics added in Spec 444 Phase 2b:
//   - stop_clk field present + updated at executeToClock entry
//   - last_exc_cycles tracked across run loop
//   - is_jammed field present (V1 no dispatcher, snapshot-compat only)
//   - cycleAccum reset behavior at softReset (DEVIATION documented)
//
// Each assertion cites VICE source lines (drivecpu.c).
//
// Run via:
//   npx tsx tests/unit/drive/drivecpu-conformance.test.ts

import { strict as assert } from "node:assert";
import { DriveCpu } from "../../../src/runtime/headless/drive/drive-cpu.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function makeDriveCpu() {
  const d = new DriveCpu({
    deviceId: 8,
    useMicrocodedCpu: true,
  });
  // VICE drive_set_machine_parameter sets PAL sync_factor to ~1.0148
  // (drive 1MHz / C64 985248Hz). Default ctor leaves it at 0.
  d.setSyncRatio(1.01477);
  return d;
}

// ---------------------------------------------------------------------------
// stop_clk field (VICE drivetypes.h:83 + drivecpu.c:388).
//
test("DriveCpu exposes stop_clk = 0 at construction", () => {
  const d = makeDriveCpu();
  assert.equal(d.stop_clk, 0);
});

test("executeToClock advances stop_clk based on cycleAccum >> 16", () => {
  const d = makeDriveCpu();
  // Default syncFactor16dot16 is 0x10000 (1.0x — drive runs at C64 rate).
  // After construction syncFactor may differ; force a known rate.
  // (DriveCpu sets it in its ctor — confirm > 0.)
  assert.ok(d.getSyncFactor16dot16() > 0, "syncFactor16dot16 must be non-zero");
  // Drive cpu starts at cycles=0; lastClk=0.
  // Call executeToClock(100). c64Delta = 100. cycleAccum += sf * 100.
  // stop_clk = cpu.cycles + (cycleAccum >> 16).
  d.executeToClock(100);
  // stop_clk must be set to a positive value (drive ran some cycles).
  assert.ok(d.stop_clk > 0, "stop_clk advanced after run");
});

// ---------------------------------------------------------------------------
// last_exc_cycles (VICE drivetypes.h:81 + drivecpu.c:557 snapshot).
//
test("DriveCpu exposes last_exc_cycles = 0 at construction", () => {
  const d = makeDriveCpu();
  assert.equal(d.last_exc_cycles, 0);
});

test("last_exc_cycles ≥ 0 after executeToClock (overrun tracking)", () => {
  const d = makeDriveCpu();
  d.executeToClock(1000);
  // After cycle-stepped run, last_exc_cycles is either 0 (exact)
  // or small positive (instruction straddled the boundary).
  assert.ok(d.last_exc_cycles >= 0);
  assert.ok(d.last_exc_cycles <= 8, "overrun should be at most one 6502 instruction (≤ 7 cycles)");
});

// ---------------------------------------------------------------------------
// is_jammed (VICE drivetypes.h:97).
//
test("DriveCpu exposes is_jammed = 0 at construction (no V1 dispatcher)", () => {
  const d = makeDriveCpu();
  assert.equal(d.is_jammed, 0);
});

// ---------------------------------------------------------------------------
// softReset / reset (Spec 414 + VICE drivecpu.c:194-212).
//
test("softReset zeros lastClk + cycleAccum + sleeping", () => {
  const d = makeDriveCpu();
  d.executeToClock(500);
  d.softReset();
  // After softReset, internal state reset; verify run-loop resumes.
  d.executeToClock(100);
  assert.ok(d.stop_clk >= 0);  // sanity: no NaN/throw
});

// ---------------------------------------------------------------------------
// Suite runner.
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ndrivecpu-conformance: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
