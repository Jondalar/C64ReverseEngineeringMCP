// Spec 445 Phase 3 — runtime write-back coupling smoke.
//
// End-to-end verification that the GCR write path mutates the active
// track buffer when:
//   - drive motor is on (byte_ready_active & BRA_MOTOR_ON)
//   - read_write_mode = 0 (= write mode per VICE via2d.c:174 PCR bit 5 = 0)
//   - drive.GCR_write_value is set (= DOS writes byte to VIA2 PA)
//   - rotation_rotate_disk advances cycles
//
// Expected end state:
//   - drive.GCR_track_start_ptr bytes mutated
//   - drive.GCR_dirty_track = 1 (set by _write_next_bit per VICE
//     rotation.c:227)
//
// Run via:
//   npx tsx tests/unit/drive/gcr-write-back-runtime.test.ts

import { strict as assert } from "node:assert";
import {
  makeDrive_t,
  setDriveMotor,
  BRA_MOTOR_ON,
  type Drive_t,
} from "../../../src/runtime/headless/drive/drive-t.js";
import {
  rotation_init,
  rotation_reset,
  rotation_rotate_disk,
  rotation_begins,
  rotation_speed_zone_set,
} from "../../../src/runtime/headless/drive/rotation.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function makeWriteableDrive(): { drive: Drive_t; track: Uint8Array; advance: (n: bigint) => void } {
  let clk = 0n;
  const drive = makeDrive_t({ drive: 0, mynumber: 0, clk_ptr: () => clk });
  // Bind a fresh 7500-byte track (zone-3 standard size).
  const track = new Uint8Array(7500);
  drive.GCR_track_start_ptr = track;
  drive.GCR_current_track_size = track.length;
  drive.GCR_image_loaded = 1;
  drive.read_only = 0;
  drive.current_half_track = 36;  // track 18
  drive.attach_clk = 0n;
  drive.detach_clk = 0n;
  drive.attach_detach_clk = 0n;
  drive.GCR_head_offset = 0;
  drive.GCR_dirty_track = 0;
  rotation_init(0, 0);
  rotation_reset(drive);
  rotation_speed_zone_set(3, 0);  // zone 3 (innermost, fastest)
  return {
    drive,
    track,
    advance: (n: bigint) => { clk += n; },
  };
}

// ---------------------------------------------------------------------------
test("smoke: drive motor on + write mode + GCR_write_value advances bit through track", () => {
  const h = makeWriteableDrive();
  setDriveMotor(h.drive, true);
  h.drive.byte_ready_active |= BRA_MOTOR_ON;
  h.drive.read_write_mode = 0;  // 0 = WRITE mode per VICE
  rotation_begins(h.drive);

  // Push a known byte via the simulated DOS path (= VIA2 PA store).
  h.drive.GCR_write_value = 0xff;

  // Capture initial track state. Should be all zeros.
  const trackStart = new Uint8Array(h.track);

  // Advance enough drive cycles to clock several GCR bytes onto the track.
  // ~30 cyc/byte × 16 = 480 cycles for ~16 bytes worth.
  h.advance(1000n);
  rotation_rotate_disk(h.drive);

  // GCR_dirty_track must be set after any successful write_next_bit.
  // If still 0, the write-back path didn't fire.
  assert.equal(h.drive.GCR_dirty_track, 1, "GCR_dirty_track not set — write path silent");

  // Track must have CHANGED somewhere.
  let mutatedCount = 0;
  for (let i = 0; i < h.track.length; i++) {
    if (h.track[i] !== trackStart[i]) mutatedCount++;
  }
  assert.ok(mutatedCount > 0, "track buffer did not mutate after rotation cycles");
});

test("smoke: write-mode + motor-off → NO track mutation (motor gate)", () => {
  const h = makeWriteableDrive();
  // Motor OFF.
  setDriveMotor(h.drive, false);
  h.drive.byte_ready_active &= ~BRA_MOTOR_ON;
  h.drive.read_write_mode = 0;  // write mode
  h.drive.GCR_write_value = 0xff;

  const trackStart = new Uint8Array(h.track);
  h.advance(1000n);
  rotation_rotate_disk(h.drive);

  // Motor gate: rotation_rotate_disk early-return when motor off.
  // No write_next_bit calls → track unchanged.
  let mutatedCount = 0;
  for (let i = 0; i < h.track.length; i++) {
    if (h.track[i] !== trackStart[i]) mutatedCount++;
  }
  assert.equal(mutatedCount, 0, "track mutated with motor off — gate broken");
  assert.equal(h.drive.GCR_dirty_track, 0, "GCR_dirty_track set with motor off");
});

// Spec 445 Phase 3 — read mode must NOT mutate the track.
// VICE rotation.c read-mode branch sets rptr->write_flux = last_write_data
// & 0x80 (records flux but does NOT call write_next_bit). Write-mode
// branch is the only path that mutates raw track bytes via write_next_bit.
test("smoke: read mode (read_write_mode != 0) + motor on → track NOT mutated", () => {
  const h = makeWriteableDrive();
  setDriveMotor(h.drive, true);
  h.drive.byte_ready_active |= BRA_MOTOR_ON;
  h.drive.read_write_mode = 0x20;  // READ MODE (= PCR bit 5 = 1 per VICE)
  h.drive.GCR_write_value = 0xff;  // would corrupt track if leak happens
  rotation_begins(h.drive);

  const trackStart = new Uint8Array(h.track);
  h.advance(1000n);
  rotation_rotate_disk(h.drive);

  let mutatedCount = 0;
  for (let i = 0; i < h.track.length; i++) {
    if (h.track[i] !== trackStart[i]) mutatedCount++;
  }
  assert.equal(mutatedCount, 0,
    `track mutated in READ mode (${mutatedCount} bytes) — write-flux leaking into write_next_bit. ` +
    "TS rotation_1541_gcr read branch may be calling _write_next_bit; VICE only sets write_flux. " +
    "Bug surfaces with image loaded + motor on + GCR_write_value set during read operation.");
  assert.equal(h.drive.GCR_dirty_track, 0, "dirty flag set during read");
});

test("smoke: GCR_dirty_track stays 0 if no image loaded", () => {
  // _write_next_bit gates on GCR_image_loaded per VICE rotation.c:230.
  let clk = 0n;
  const drive = makeDrive_t({ drive: 0, mynumber: 0, clk_ptr: () => clk });
  drive.GCR_track_start_ptr = new Uint8Array(7500);
  drive.GCR_current_track_size = 7500;
  drive.GCR_image_loaded = 0;  // explicit: no image
  drive.read_only = 0;
  drive.current_half_track = 36;
  rotation_init(0, 0);
  rotation_reset(drive);
  rotation_speed_zone_set(3, 0);
  setDriveMotor(drive, true);
  drive.byte_ready_active |= BRA_MOTOR_ON;
  drive.read_write_mode = 0;
  rotation_begins(drive);
  drive.GCR_write_value = 0xff;
  clk += 1000n;
  rotation_rotate_disk(drive);
  assert.equal(drive.GCR_dirty_track, 0, "dirty flag set despite GCR_image_loaded=0");
});

// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ngcr-write-back-runtime: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
