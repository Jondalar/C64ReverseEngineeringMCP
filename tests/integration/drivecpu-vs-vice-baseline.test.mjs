// Spec 444 Phase 4 — drive CPU cycle-accuracy vs VICE baseline.
//
// Smoke test: feed VICE master_clock values into TS DriveCpu and verify
// TS drive cpu cycle counter matches VICE drive clock within tolerance.
//
// Source baseline:
//   samples/traces/v2-baseline/im2-vice-store-2026-05-12/trace.duckdb
//
// Methodology:
//   1. Load VICE trace, query first N drive8 instructions ordered by
//      master_clock. Each row gives (vice_master_clock, vice_drive_clock).
//   2. Compute clock deltas from the FIRST sample as origin (so TS starts
//      from cpu.cycles = 0 = vice_drive_clock - first_drive_clock).
//   3. For each successive sample, call ts.executeToClock(c64Delta),
//      then assert ts.cpu.cycles ≈ vice_drive_delta (within tolerance).
//
// Tolerance: ±100 cycles over the first 1000 drive instructions. The
// Krill / rotation-tick-AFTER divergence (Spec 412 PARTIAL) prevents
// 0-exact match across whole-game runs; for a short slice the cumulative
// drift stays small.
//
// Run via:
//   node tests/integration/drivecpu-vs-vice-baseline.test.mjs

import { DuckDBInstance } from "@duckdb/node-api";
import { DriveCpu } from "../../dist/runtime/headless/drive/drive-cpu.js";

const TRACE_PATH = "samples/traces/v2-baseline/im2-vice-store-2026-05-12/trace.duckdb";
const N_INSTRUCTIONS = 10000;
const TOLERANCE_CYCLES = 2;

async function main() {
  console.log(`[smoke] loading VICE baseline ${TRACE_PATH}`);
  const inst = await DuckDBInstance.create(TRACE_PATH);
  const conn = await inst.connect();
  const reader = await conn.run(
    `SELECT master_clock, clock FROM instructions
     WHERE cpu = 'drive8'
     ORDER BY master_clock
     LIMIT ${N_INSTRUCTIONS};`,
  );
  const rows = await reader.getRowObjects();
  console.log(`[smoke] loaded ${rows.length} drive8 rows from VICE trace`);

  if (rows.length === 0) {
    console.error("FAIL: no drive8 rows in baseline trace");
    process.exit(1);
  }

  // Anchor TS state to the first row.
  const firstC64 = Number(rows[0].master_clock);
  const firstDrive = Number(rows[0].clock);

  // PAL exact ratio matching VICE drivesync.c:55-65.
  const d = new DriveCpu({ deviceId: 8, useMicrocodedCpu: true });
  // VICE drive_set_machine_parameter takes C64 cycles_per_sec; the
  // drive 1541 is assumed at 1 MHz internally. PAL C64 = 985248 Hz.
  d.driveSetMachineParameter(985248);
  // Soft-reset to anchor lastClk + drive cycles = 0 at firstC64 origin.
  // TS internal: lastClk = 0 means "next executeToClock delta = c64Clk".
  // We'll feed (c64 - firstC64) deltas so TS sees them as starting fresh.

  let passCount = 0, failCount = 0;
  let maxDelta = 0;

  for (let i = 1; i < rows.length; i++) {
    const c64 = Number(rows[i].master_clock) - firstC64;
    const expectedDrive = Number(rows[i].clock) - firstDrive;

    d.executeToClock(c64);
    const actualDrive = d.cpu.cycles;

    const delta = Math.abs(actualDrive - expectedDrive);
    if (delta > maxDelta) maxDelta = delta;

    if (delta <= TOLERANCE_CYCLES) {
      passCount++;
    } else {
      if (failCount < 5) {
        console.error(
          `  FAIL row ${i}: c64=${c64} expected_drive=${expectedDrive} actual=${actualDrive} delta=${delta}`,
        );
      }
      failCount++;
    }
  }

  console.log(`\n[smoke] cycle-accuracy vs VICE im2 baseline:`);
  console.log(`  rows compared:     ${rows.length - 1}`);
  console.log(`  within ±${TOLERANCE_CYCLES} cycles: ${passCount}`);
  console.log(`  divergent:         ${failCount}`);
  console.log(`  max abs delta:     ${maxDelta} cycles`);

  if (failCount === 0) {
    console.log(`\nPASS — TS drive CPU cycle counter tracks VICE within ±${TOLERANCE_CYCLES}.`);
    process.exit(0);
  } else {
    console.log(`\nFAIL — ${failCount} rows exceeded ±${TOLERANCE_CYCLES} tolerance.`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
