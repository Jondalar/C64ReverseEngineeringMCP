#!/usr/bin/env node
// Spec 407 — 1541 Phase A: per-drive context struct shape smoke.
//
// Doctrine: 1:1 VICE TDE 1541 port. This smoke asserts that the TS
// `DriveCpu` exposes the `Drive1541Unit` (= `diskunit_context_t`)
// shape per docs/vice-1541-arch.md §2.1 + §13 Phase A:
//
//   clk_ptr        → `clk`            (per-unit CLOCK; reads cpu.cycles)
//   drives[2]      → `drives`         (tuple; 1541 uses [0] only)
//   cpu (+ cpud)   → `cpu`            (collapsed in TS — OQ-407-2)
//   via1d1541      → `via1`
//   via2           → `via2`
//   cia1571        → null             (1541 only — §13 step 2)
//   rom            → `rom`            (16 KB)
//   drive_ram      → `ram`            (2 KB stock 1541 — §14 invariant 8)
//   alarm_context  → `alarmContext`
//   clock_frequency→ `clockFrequency` (= 1 for 1541 — §13 step 2)
//   type           → `type`           (= DRIVE_TYPE_1541)
//   mynumber       → `mynumber`       (device 8..11)
//   reset()        → reset stub       (§13-H step 33)
//   shutdown()     → shutdown stub    (drive.c:298 drive_shutdown)
//
// VICE source cites:
//   src/drive/drivetypes.h:166 `diskunit_context_t`
//   src/drive/drive.h:236      `drive_t`
//   src/drive/drive.c:162      `drive_init()`
//   src/drive/drive.c:298      `drive_shutdown()`
//
// Tiered gate (PLAN.md): spec 407 = core/structural → smokes only +
// this new struct-shape smoke. No MM / Scramble game test.

import { DriveCpu } from "../dist/runtime/headless/drive/drive-cpu.js";
import {
  DRIVE_TYPE_1541,
} from "../dist/runtime/headless/drive/drive-types.js";
import {
  DRIVE_ROM_SIZE,
} from "../dist/runtime/headless/drive/drive-rom.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

// ──────────────────────────────────────────────────────────────────
// Test 1: Construct a DriveCpu with synthetic ROM (no IEC, no GCR).
//   This exercises the no-image-attached path — slot 0 may be null
//   per Drive1541Unit interface contract, but unit-level fields must
//   all be present.
// ──────────────────────────────────────────────────────────────────
{
  const romBytes = new Uint8Array(DRIVE_ROM_SIZE);
  // Reset vector → $E000 sentinel.
  romBytes[0xfffc - 0xc000] = 0x00;
  romBytes[0xfffd - 0xc000] = 0xe0;
  const drive = new DriveCpu({ deviceId: 8, romBytes, useMicrocodedCpu: true });

  // §2.1 nested fields per Drive1541Unit interface.
  check("mynumber == deviceId (8)", drive.mynumber === 8,
    `mynumber=${drive.mynumber}`);
  check("type === DRIVE_TYPE_1541", drive.type === DRIVE_TYPE_1541,
    `type=${drive.type}`);
  check("clockFrequency === 1 (§13 step 2)",
    drive.clockFrequency === 1, `clockFrequency=${drive.clockFrequency}`);
  check("cia1571 === null (1541 only — §13 step 2)",
    drive.cia1571 === null, `cia1571=${drive.cia1571}`);

  check("clk is a number (per-unit CLOCK)", typeof drive.clk === "number",
    `clk=${drive.clk} typeof=${typeof drive.clk}`);
  check("clk reads cpu.cycles live",
    drive.clk === drive.cpu.cycles,
    `clk=${drive.clk} cpu.cycles=${drive.cpu.cycles}`);

  check("drives is a 2-element tuple",
    Array.isArray(drive.drives) && drive.drives.length === 2,
    `drives.length=${drive.drives?.length}`);
  check("drives[1] === null (1541 unused — OQ-407-1)",
    drive.drives[1] === null, `drives[1]=${drive.drives[1]}`);
  check("drives[0] === null without GCR pipeline (no-image)",
    drive.drives[0] === null,
    `drives[0]=${drive.drives[0] === null ? "null" : "<DriveSlot>"}`);

  check("cpu present", drive.cpu != null, `cpu=${drive.cpu?.constructor?.name}`);
  check("via1 present (= bus.via1)",
    drive.via1 != null && drive.via1 === drive.bus.via1,
    `via1=${drive.via1?.constructor?.name}`);
  check("via2 present (= bus.via2)",
    drive.via2 != null && drive.via2 === drive.bus.via2,
    `via2=${drive.via2?.constructor?.name}`);

  check("rom is Uint8Array of DRIVE_ROM_SIZE (= 0x4000 for 1541)",
    drive.rom instanceof Uint8Array && drive.rom.length === DRIVE_ROM_SIZE,
    `rom.length=${drive.rom?.length}`);
  check("ram is Uint8Array of 0x800 (stock 1541 — §14 invariant 8)",
    drive.ram instanceof Uint8Array && drive.ram.length === 0x0800,
    `ram.length=${drive.ram?.length}`);

  check("alarmContext present",
    drive.alarmContext != null
    && typeof drive.alarmContext === "object",
    `alarmContext=${drive.alarmContext?.constructor?.name ?? typeof drive.alarmContext}`);

  // §13-H step 33 + drive.c:298 — reset / shutdown stubs.
  check("reset() callable", typeof drive.reset === "function");
  check("shutdown() callable", typeof drive.shutdown === "function");

  // Shutdown idempotency (= safe to call twice).
  let threw = false;
  try {
    drive.shutdown();
    drive.shutdown();
  } catch (e) {
    threw = true;
  }
  check("shutdown() idempotent (callable twice without throw)", !threw);
}

// ──────────────────────────────────────────────────────────────────
// Test 2: Drive1541Unit shape exposed even on a different deviceId.
// ──────────────────────────────────────────────────────────────────
{
  const romBytes = new Uint8Array(DRIVE_ROM_SIZE);
  const drive = new DriveCpu({ deviceId: 9, romBytes, useMicrocodedCpu: true });
  check("mynumber tracks deviceId=9",
    drive.mynumber === 9, `mynumber=${drive.mynumber}`);
}

// ──────────────────────────────────────────────────────────────────
// Test 3: clk advances when cpu.cycles advances.
//   (= confirms `clk` is a live view, not a snapshot.)
// ──────────────────────────────────────────────────────────────────
{
  const romBytes = new Uint8Array(DRIVE_ROM_SIZE);
  // Reset vector → $C000; fill ROM with NOPs (= 0xEA) starting at $C000.
  for (let i = 0; i < 0x100; i++) romBytes[i] = 0xea;
  romBytes[0xfffc - 0xc000] = 0x00;
  romBytes[0xfffd - 0xc000] = 0xc0;
  const drive = new DriveCpu({ deviceId: 8, romBytes, useMicrocodedCpu: true });
  drive.reset();
  const clkBefore = drive.clk;
  // Advance one drive cycle via the microcoded CPU.
  drive.cpu.executeCycle();
  const clkAfter = drive.clk;
  check("clk advances with cpu.cycles",
    clkAfter > clkBefore,
    `clkBefore=${clkBefore} clkAfter=${clkAfter}`);
}

// ──────────────────────────────────────────────────────────────────
// Report.
// ──────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 407 drive-struct smoke — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
