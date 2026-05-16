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

/** Catch up rotation state to the drive's current clock. 611.6 will
 *  port the real bit-accumulator + GCR head walk. */
export function rotation_rotate_disk(_diskunit: DiskUnitContext): void {
  // intentionally empty — 611.6
}

/** Begin a new rotation sample window (e.g. after motor-on). */
export function rotation_begins(_diskunit: DiskUnitContext): void {
  // intentionally empty — 611.6
}

/** Set the active speed zone (0..3) — driven by VIA2 PB density bits. */
export function rotation_speed_zone_set(
  _zone: number,
  _diskunit: DiskUnitContext,
): void {
  // intentionally empty — 611.6
}

/** Read the most-recently-decoded GCR byte from the rotation buffer.
 *  611.5 returns 0 so PA read in via2d sees a defined zero byte. */
export function rotation_byte_read(_diskunit: DiskUnitContext): number {
  return 0;
}

/** True if a SYNC mark was crossed since the last call. */
export function rotation_sync_found(_diskunit: DiskUnitContext): boolean {
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
