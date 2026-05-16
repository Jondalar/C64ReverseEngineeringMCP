// SPEC 611.6 placeholder — replace, do not extend.
//
// Exposes the VICE-shaped rotation API surface that VIA2 (611.5)
// calls into. All bodies are no-op / minimal stubs; real rotation
// lands in `vice1541/rotation.ts` at phase 611.6.
//
// The function names and signatures mirror VICE's `src/drive/rotation.c`
// so the 611.5 VIA2 call sites can stay verbatim across the 611.6
// swap (no caller-side rename).
//
// References:
//   VICE rotation.c — rotation_rotate_disk(), rotation_begins(),
//                     rotation_speed_zone_set(), rotation_byte_read(),
//                     rotation_sync_found()
//   VICE drive.c    — drive_writeprotect_sense()

import type { DiskUnitContext } from "./diskunit.js";
import type { DriveContext } from "./drive-context.js";

/**
 * VICE `rotation.h:35` `#define BUS_READ_DELAY 14`. Used by VIA2
 * `read_pra` and `read_prb` to set `drive.req_ref_cycles` so the
 * drive 6502 stalls long enough for the rotation engine to pick up
 * the read.
 */
export const BUS_READ_DELAY = 14;

/** Observable counter so 611.5 smoke can verify `rotation_rotate_disk`
 *  is actually called from VIA2 read/write side effects. Resets via
 *  `__resetRotationStubCounters()` in tests. Real `rotation.ts` in
 *  611.6 will not export this; it exists only on the stub. */
export const __rotationCounters = {
  rotate_disk: 0,
  begins: 0,
  speed_zone_set: 0,
  byte_read: 0,
  sync_found: 0,
};

/** Test helper — zero the rotation-stub call counters. */
export function __resetRotationStubCounters(): void {
  __rotationCounters.rotate_disk = 0;
  __rotationCounters.begins = 0;
  __rotationCounters.speed_zone_set = 0;
  __rotationCounters.byte_read = 0;
  __rotationCounters.sync_found = 0;
}

/** Catch up rotation state to the drive's current clock. 611.6 will
 *  port the real bit-accumulator + GCR head walk. */
export function rotation_rotate_disk(_diskunit: DiskUnitContext): void {
  __rotationCounters.rotate_disk++;
}

/** Begin a new rotation sample window (e.g. after motor-on). */
export function rotation_begins(_diskunit: DiskUnitContext): void {
  __rotationCounters.begins++;
}

/** Set the active speed zone (0..3) — driven by VIA2 PB density bits. */
export function rotation_speed_zone_set(
  _zone: number,
  _diskunit: DiskUnitContext,
): void {
  __rotationCounters.speed_zone_set++;
}

/** Read the most-recently-decoded GCR byte from the rotation buffer.
 *  611.5 returns 0 so PA read in via2d sees a defined zero byte. */
export function rotation_byte_read(_diskunit: DiskUnitContext): number {
  __rotationCounters.byte_read++;
  return 0;
}

/** True if a SYNC mark was crossed since the last call. */
export function rotation_sync_found(_diskunit: DiskUnitContext): boolean {
  __rotationCounters.sync_found++;
  return false;
}

/**
 * VICE `drive_writeprotect_sense()` (drive.c). Returns the WPS
 * boolean per VICE convention: `true` means "not write protected"
 * (line high). With no disk in 1541, the WPS sensor is high.
 */
export function drive_writeprotect_sense(drive: DriveContext | null): boolean {
  if (!drive) return true;
  return drive.readOnly === 0;
}
