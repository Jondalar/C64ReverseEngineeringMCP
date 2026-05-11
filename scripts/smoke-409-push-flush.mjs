#!/usr/bin/env node
// Spec 409 — 1541 Phase C (sync model) push-flush smoke.
//
// Doctrine: 1:1 VICE TDE port. Doc anchors:
//   docs/vice-1541-arch.md §5.2 (per-call fixed-point step),
//                          §13 Phase C step 8-10 (push-mode entry).
//   docs/vice-iec-arc42.md §5.11 (C64-side push-flush call sites),
//                          §6.1  (C64 stores $DD00 sequence).
//
// VICE cites:
//   src/drive/drivecpu.c:356        drivecpu_execute(drv, clk_value).
//   src/drive/drive.c:991           drive_cpu_execute_one(drv, clk).
//   src/drive/drive.c:1001          drive_cpu_execute_all(clk).
//   src/iecbus/iecbus.c:241         iecbus_cpu_write_conf1 calls
//                                   drive_cpu_execute_one BEFORE the bus
//                                   mutation (= §5.11 row 1, conf1 write).
//
// Push-flush invariant (arc42 §5.11):
//   "at every one of these sites, `drive_cpu_execute_all` runs **before**
//    any state mutation. The invariant 'drive is at instruction boundary
//    at every observable C64 IEC event' is maintained by this discipline."
//
// Test pattern (core/structural tier — smokes only):
//   1. Boot a true-drive IntegratedSession (no disk needed).
//   2. Bump session.c64Cpu.cycles forward to a known T1 without ticking
//      anything else (= simulate host running ahead while drive is idle).
//   3. Issue a $DD00 write through the kernel bus (= conf1 write path).
//   4. Assert drive.lastSyncC64Clk reached T1 (= drive caught up to host
//      before the bus mutation took effect).
//   5. Repeat for a $DD00 read (= conf1 read path).
//   6. Verify the drive cycles physically advanced (using the 16.16
//      sync_factor → drive_cycles = floor(c64_delta * sync_factor / 65536)
//      modulo VICE's instruction-boundary overrun).

import { existsSync } from "node:fs";

let startIntegratedSession;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const fixturePath = "samples/synthetic/1block.g64";
if (!existsSync(fixturePath)) {
  console.error(`fixture missing: ${fixturePath} — run \`npm run smoke:gen\``);
  process.exit(1);
}

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

const { session } = startIntegratedSession({
  diskPath: fixturePath,
  mode: "true-drive",
});
const drive = session.drive;
const kernel = session.kernel;
const c64Cpu = session.c64Cpu;

// Boot a few cycles so the drive's normal instruction execution catches
// up beyond the cold-start zero baseline. We only care about the
// **per-write delta** below, not the absolute clock.
session.runFor(20, { cycleBudget: 500 });

// Read sync_factor for invariant check (must be PAL = 0x103D5).
const syncFactor = drive.getSyncFactor16dot16();
check("sync_factor pinned to PAL 0x103D5",
  syncFactor === 0x103D5,
  `sync_factor=0x${syncFactor.toString(16).toUpperCase()}`);

// Capture pre-write baseline.
const drivePre = drive.clk;
const c64Pre = c64Cpu.cycles;

// Advance the C64 cycle counter forward by a known delta WITHOUT
// stepping a CPU instruction. This emulates "the host has wandered
// ahead between IEC accesses" — same shape as the gap that builds up
// between two real $DD00 transactions. The drive must not have moved.
// (Catch-up is push-only; nothing else ticks the drive.)
const C64_DELTA = 10000;
c64Cpu.cycles = c64Pre + C64_DELTA;

// Sanity: drive clock still where it was (no implicit catch-up).
// NOTE: this is best-effort — alarm dispatch or other side effects
// during `runFor` above might have left tiny inflight cycles. We assert
// no catch-up *due to the c64Cpu.cycles bump itself*.
const driveBeforeWrite = drive.clk;

// ──────────────────────────────────────────────────────────────────────
// Test 1: $DD00 WRITE goes through HeadlessKernelBus.c64Write, which
// calls catchUpDriveIfReady() BEFORE the bus mutation. This is the TS
// analog of `iecbus_cpu_write_conf1` (= §5.11 row 1).
// ──────────────────────────────────────────────────────────────────────
kernel.bus.c64Write(0xdd00, 0x17, {
  clock: c64Cpu.cycles,
  pc: c64Cpu.pc,
  // CIA2 PA DDR — for the smoke we only need _some_ ddrMask; the
  // catchUpDriveIfReady contract doesn't depend on the value.
  ddrMask: 0x3f,
});

const driveAfterWrite = drive.clk;
const c64AtWrite = c64Cpu.cycles;

// Invariant 1: drive advanced.
check("$DD00 write: drive cycles advanced (push-flush fired)",
  driveAfterWrite > driveBeforeWrite,
  `before=${driveBeforeWrite} after=${driveAfterWrite}`);

// Invariant 2: drive caught up to host clock pre-write.
//   The internal `lastSyncC64Clk` is now at c64AtWrite (= the clock we
//   handed the bus). VICE: drv->cpu->last_clk = clk_value after
//   drivecpu_execute returns.
// We can't read lastSyncC64Clk directly (private), but we can prove
// catch-up by issuing a SECOND write at the SAME c64 clock and verifying
// the drive did NOT advance further (= idempotency at boundary).
const driveBeforeSecondWrite = drive.clk;
kernel.bus.c64Write(0xdd00, 0x18, {
  clock: c64Cpu.cycles,
  pc: c64Cpu.pc,
  ddrMask: 0x3f,
});
const driveAfterSecondWrite = drive.clk;
check("second $DD00 write at same c64 clk — drive idempotent (already caught up)",
  driveAfterSecondWrite === driveBeforeSecondWrite,
  `before=${driveBeforeSecondWrite} after=${driveAfterSecondWrite}`);

// Invariant 3: drive cycle advance is in the VICE-expected ballpark —
// at PAL sync_factor 0x103D5, c64_delta of ~C64_DELTA should produce
//   driveDelta ≈ C64_DELTA * sync_factor / 65536 ≈ 10149 drive cycles.
// VICE per-instruction overrun (drivecpu_execute runs until
// drive_clk >= stop_clk) plus carry-over from any fractional accumulator
// inflight from earlier $DD00 cache flushes means observed > nominal by
// at most ~1 long instruction (7 cycles) per push-flush call that has
// occurred since the last clean baseline. Tolerance picked to cover
// settle-in noise from prior catch-ups during `session.runFor(20)`
// boot above (≈ a few hundred cycles of slack).
const driveDelta = driveAfterWrite - driveBeforeWrite;
const nominalDriveDelta = Math.floor(C64_DELTA * syncFactor / 0x10000);
const slack = 1000; // generous; the contract under test is direction + idempotency
const inRange =
  driveDelta >= nominalDriveDelta &&
  driveDelta <= nominalDriveDelta + slack;
check(
  `drive delta in VICE-expected window (nominal=${nominalDriveDelta}, observed=${driveDelta}, slack=${slack})`,
  inRange,
  `c64_delta=${C64_DELTA} sync_factor=0x${syncFactor.toString(16)}`,
);

// ──────────────────────────────────────────────────────────────────────
// Test 2: $DD00 READ also push-flushes (= §5.11 row 1, conf1 read =
// `iecbus_cpu_read_conf1` calls drive_cpu_execute_all before returning).
// ──────────────────────────────────────────────────────────────────────
c64Cpu.cycles += C64_DELTA;
const driveBeforeRead = drive.clk;
const readByte = kernel.bus.c64Read(0xdd00, {
  clock: c64Cpu.cycles,
  pc: c64Cpu.pc,
  ddrMask: 0x3f,
});
const driveAfterRead = drive.clk;

check("$DD00 read: drive cycles advanced (push-flush fired)",
  driveAfterRead > driveBeforeRead,
  `before=${driveBeforeRead} after=${driveAfterRead} readByte=0x${readByte.toString(16)}`);

// ──────────────────────────────────────────────────────────────────────
// Test 3: driveCpuExecuteOne wrapper (= VICE drive_cpu_execute_one).
// Doctrine cite: §13 Phase C step 10.
// ──────────────────────────────────────────────────────────────────────
c64Cpu.cycles += C64_DELTA;
const driveBeforeOne = drive.clk;
drive.driveCpuExecuteOne(c64Cpu.cycles);
const driveAfterOne = drive.clk;
check("driveCpuExecuteOne(host_clk) advances drive (§13 step 10 wrapper)",
  driveAfterOne > driveBeforeOne,
  `before=${driveBeforeOne} after=${driveAfterOne}`);

// ──────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────
let passed = 0;
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}` + (r.detail ? ` — ${r.detail}` : ""));
  if (r.pass) passed++;
}
console.log(`summary: ${passed}/${results.length} pass, ${results.length - passed} fail`);
process.exit(passed === results.length ? 0 : 1);
