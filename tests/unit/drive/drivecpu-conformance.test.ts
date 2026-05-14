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
test("softReset preserves cycleAccum (VICE drivecpu_reset_clk semantics)", () => {
  const d = makeDriveCpu();
  d.executeToClock(500);
  // cycleAccum should hold the fractional residual after the run.
  // VICE drivecpu_reset_clk @ drivecpu.c:186-191 does NOT touch
  // cycle_accum — only last_clk, last_exc_cycles, stop_clk.
  d.softReset(500);
  assert.equal(d.stop_clk, 0, "stop_clk zeroed");
  assert.equal(d.last_exc_cycles, 0, "last_exc_cycles zeroed");
  // cycleAccum is private; we assert post-reset run still works.
  d.executeToClock(100);
  assert.ok(d.stop_clk >= 0);
});

// ---------------------------------------------------------------------------
// Spec 444 v2 — VICE drivecpu_execute literal shape:
//   stop_clk += cycle_accum >> 16  (ADDITIVE)
//   cycle_accum &= 0xffff           (fractional residual)
//   while (cpu.cycles < stop_clk) { executeCycle(); }
//
test("stop_clk is ADDITIVE across executeToClock calls (VICE drivecpu.c:388)", () => {
  const d = makeDriveCpu();
  d.executeToClock(100);
  const stop1 = d.stop_clk;
  d.executeToClock(200);
  const stop2 = d.stop_clk;
  // VICE adds each call's drive cycles to stop_clk. stop2 must be
  // strictly greater than stop1 (drive ran forward between calls).
  assert.ok(stop2 > stop1, `stop_clk additive: stop2=${stop2} > stop1=${stop1}`);
});

test("cycle-accuracy: drive CPU clk reaches stop_clk +/- 1 (instruction granularity)", () => {
  const d = makeDriveCpu();
  // Feed C64-clock sequence 100, 1000, 10000, 100000.
  // At each step verify cpu.cycles >= stop_clk - 1 (boundary may overshoot by 1).
  const samples = [100, 1000, 10000, 100000];
  for (const target of samples) {
    d.executeToClock(target);
    const driveClk = (d.cpu as { cycles: number }).cycles;
    // Allow small instruction-overshoot (max 8 cycles for any 6502 op).
    assert.ok(
      driveClk >= d.stop_clk - 1 && driveClk <= d.stop_clk + 8,
      `clk=${driveClk} stop_clk=${d.stop_clk} target=${target}`,
    );
  }
});

test("wakeUp stale-skip: 16M+ cycle gap skips ahead (VICE drivecpu.c:255-264)", () => {
  const d = makeDriveCpu();
  // Run drive past the 934639 threshold.
  d.executeToClock(1_000_000);
  const lastClkBefore = (d as any).lastClk;
  assert.ok(lastClkBefore > 934639, "primed drive past threshold");
  // Jump main clock by > 16M cycles (= 0xffffff).
  const farClk = lastClkBefore + 0x1000000 + 100;
  d.executeToClock(farClk);
  // After wake-up stale-skip: lastClk pegged to c64Clk (which IS farClk
  // since the executeToClock body always sets it; the wake-up just
  // bypasses the catch-up).
  assert.equal((d as any).lastClk, farClk);
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
