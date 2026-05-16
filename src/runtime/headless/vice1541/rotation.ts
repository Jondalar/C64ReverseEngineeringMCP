// Spec 611 phase 611.6 — VICE 1541 rotation engine.
//
// Replaces vice1541/rotation-stub.ts.
//
// VICE source: src/drive/rotation.c (lines 989-1170 cover the simple
// engine + the public boundary functions; rotation_1541_gcr_cycle and
// p64 engine are deliberately NOT ported in 611.6 — they require disk
// image data which lands with 611.7).
// VICE header: src/drive/rotation.h
// Doc anchor:  docs/vice-1541-arch.md §13 F + §8 rotation overview.
//
// What 611.6 lands:
//   - rotation_t per drive (accum / frequency / speed_zone /
//     last_read_data / last_write_data / bit_counter / zero_count /
//     rotation_last_clk).
//   - rot_speed_bps[2][4] table verbatim from VICE rotation.c:89.
//   - rotation_init, rotation_reset, rotation_begins,
//     rotation_speed_zone_set, rotation_rotate_disk,
//     rotation_byte_read, rotation_sync_found.
//   - rotation_1541_simple bit-accumulator engine per VICE
//     rotation.c:989-1106. With no track buffer attached this still
//     runs the bit accumulator correctly, fires BYTE-READY edges on
//     8-bit boundaries when motor on + read mode, and stays
//     deterministic. SYNC stays low because last_read_data never
//     reaches 0x3ff with all-zero bytes.
//   - BUS_READ_DELAY = 14 (VICE rotation.h:35).
//
// NOT ported in 611.6 (real disk-image side):
//   - rotation_1541_gcr_cycle (rotation.c:572) — needs complex_image_loaded.
//   - rotation_1541_p64 / p64_cycle (rotation.c:635+, 944+) — P64 stub.
//   - rotation_do_wobble (rotation.c:308) — wobble_factor = 0 so the
//     simple engine's rpmscale uses 1_000_000 exactly. Real wobble
//     comes with 611.7's disk-attach.

import type { DiskUnitContext } from "./diskunit.js";
import type { DriveContext } from "./drive-context.js";

/** VICE rotation.h:35 — 875 ns delay (14 × 62.5 ns) for data-bus read. */
export const BUS_READ_DELAY = 14;

/** VICE rotation.c:89 — bps table. Index by [frequency][speed_zone].
 *  frequency 0 = 1x speed (1541 default), 1 = 2x (1571 mode).
 *  speed_zone 0..3 = inner..outer tracks. */
export const rot_speed_bps: readonly (readonly number[])[] = [
  [250_000, 266_667, 285_714, 307_692],
  [125_000, 133_333, 142_857, 153_846],
];

/** VICE BRA_BYTE_READY mask (drive.h:283). */
const BRA_BYTE_READY = 0x02;
/** VICE BRA_MOTOR_ON mask (drive.h:284). */
const BRA_MOTOR_ON = 0x04;

/** Per-drive rotation state — matches VICE `rotation_t` (rotation.c:50-76). */
export interface RotationT {
  accum: number;
  frequency: 0 | 1;
  speed_zone: number; // 0..3
  last_read_data: number;
  last_write_data: number;
  bit_counter: number;
  zero_count: number;
  rotation_last_clk: number;
  // RNG fields used by gcr / p64 engines, kept as 0 in 611.6.
  seed: number;
  xorShift32: number;
}

/** Observable counters — kept for parity with 611.5's rotation-stub.ts
 *  so the existing smoke rows survive the swap. Real `rotation.ts`
 *  would normally not export them, but they cost nothing and help
 *  debug 611.7+ regressions. */
export const __rotationCounters = {
  rotate_disk: 0,
  begins: 0,
  speed_zone_set: 0,
  byte_read: 0,
  sync_found: 0,
};
export function __resetRotationStubCounters(): void {
  __rotationCounters.rotate_disk = 0;
  __rotationCounters.begins = 0;
  __rotationCounters.speed_zone_set = 0;
  __rotationCounters.byte_read = 0;
  __rotationCounters.sync_found = 0;
}

/** Per-diskunit rotation slot. Single-drive 1541 = unit 0 only. */
const rotation: RotationT[] = [];

/** VICE rotation_init() — initialise the rotation slot for `dnr`. */
export function rotation_init(freq: 0 | 1, dnr: number): void {
  rotation[dnr] = {
    accum: 0,
    frequency: freq,
    speed_zone: 0,
    last_read_data: 0,
    last_write_data: 0,
    bit_counter: 0,
    zero_count: 0,
    rotation_last_clk: 0,
    seed: 0,
    xorShift32: 0,
  };
}

/** VICE rotation_reset() (rotation.c:111-130). Verbatim:
 *    rotation[dnr].last_read_data = 0;
 *    rotation[dnr].last_write_data = 0;
 *    rotation[dnr].bit_counter = 0;
 *    rotation[dnr].accum = 0;
 *    rotation[dnr].seed = RANDOM_nextUInt(&rotation[dnr]);
 *    rotation[dnr].xorShift32 = 0x1234abcd;
 *    rotation[dnr].rotation_last_clk = *clk_ptr;
 *    drive->req_ref_cycles = 0;
 *  Does NOT clear drive byte_ready_level / edge / GCR_read. */
export function rotation_reset(drive: DriveContext): void {
  const dnr = drive.diskunit?.mynumber ?? 0;
  if (!rotation[dnr]) rotation_init(drive.diskunit?.clockFrequency === 2 ? 1 : 0, dnr);
  const r = rotation[dnr]!;
  r.last_read_data = 0;
  r.last_write_data = 0;
  r.bit_counter = 0;
  r.accum = 0;
  r.xorShift32 = 0x1234abcd;
  r.rotation_last_clk = drive.diskunit?.clkPtr.value ?? 0;
  drive.reqRefCycles = 0;
}

/** VICE rotation_speed_zone_set(). */
export function rotation_speed_zone_set(zone: number, dnr: number): void {
  if (!rotation[dnr]) rotation_init(0, dnr);
  rotation[dnr]!.speed_zone = zone & 3;
  __rotationCounters.speed_zone_set++;
}

/** VICE rotation_begins() — motor-on transition resets per-byte state. */
export function rotation_begins(diskunit: DiskUnitContext): void {
  const dnr = diskunit.mynumber;
  const r = rotation[dnr];
  if (!r) { rotation_init(0, dnr); return; }
  r.rotation_last_clk = diskunit.clkPtr.value;
  r.bit_counter = 0;
  __rotationCounters.begins++;
}

/**
 * VICE rotation_1541_simple() (rotation.c:989-1106) — bit-accumulator
 * engine used when no complicated image is loaded. Runs the bit clock
 * forward by the drive-clock delta, walks the bit position, fires
 * BYTE-READY edges on 8-bit boundaries when BRA_BYTE_READY is in
 * byte_ready_active.
 */
function rotation_1541_simple(drive: DriveContext): void {
  const diskunit = drive.diskunit;
  if (!diskunit) return;
  const dnr = diskunit.mynumber;
  if (!rotation[dnr]) rotation_init(0, dnr);
  const r = rotation[dnr]!;

  drive.reqRefCycles = 0;

  const clk = diskunit.clkPtr.value;
  let delta = clk - r.rotation_last_clk;
  r.rotation_last_clk = clk;

  // rpmscale per VICE rotation.c:1009-1013. wobble_factor = 0 → rpmscale = 1_000_000.
  let tmp = 1_000_000;
  tmp += Math.floor((drive.wobbleFactor * 1_000_000) / 3_200_000);
  tmp *= 30_000;
  const rpm = drive.rpm || 30_000;
  const rpmscale = Math.floor(tmp / rpm);

  let bits_moved = 0;
  while (delta > 0) {
    const tdelta = delta > 1000 ? 1000 : delta;
    delta -= tdelta;
    r.accum += rot_speed_bps[r.frequency]![r.speed_zone]! * tdelta;
    bits_moved += Math.floor(r.accum / rpmscale);
    r.accum = r.accum % rpmscale;
  }

  if (drive.readWriteMode) {
    let off = drive.gcrHeadOffset;
    let last_read_data = r.last_read_data << 7;
    let bit_counter = r.bit_counter;
    let byte: number;
    if (drive.gcrImageLoaded === 0 || drive.gcrTrackStartPtr === null) {
      byte = 0;
    } else {
      byte = (drive.gcrTrackStartPtr[off >> 3] ?? 0) << (off & 7);
    }

    while (bits_moved-- !== 0) {
      byte = (byte << 1) & 0xff;
      off++;
      if (!(off & 7)) {
        if ((off >> 3) >= drive.gcrCurrentTrackSize) {
          off = 0;
        }
        if (drive.gcrImageLoaded === 0 || drive.gcrTrackStartPtr === null) {
          byte = 0;
        } else {
          byte = drive.gcrTrackStartPtr[off >> 3] ?? 0;
        }
      }

      last_read_data = (last_read_data << 1) & 0x1ffff;
      last_read_data |= (byte & 0x80) ? 1 : 0;
      r.last_write_data = (r.last_write_data << 1) & 0xff;

      // SYNC detection: if last_read_data bits 15..7 are all 1
      // (i.e., 10 consecutive 1-bits in the >>7 window), then we're
      // in SYNC and bit_counter does not advance to byte boundary.
      if ((~last_read_data) & 0x1ff80) {
        if (++bit_counter === 8) {
          bit_counter = 0;
          drive.gcrRead = (last_read_data >> 7) & 0xff;
          r.last_write_data = drive.gcrRead;
          if ((drive.byteReadyActive & BRA_BYTE_READY) !== 0) {
            drive.byteReadyEdge = 1;
            drive.byteReadyLevel = 1;
          }
        }
      } else {
        bit_counter = 0;
      }
    }

    drive.gcrHeadOffset = off;
    r.last_read_data = (last_read_data >> 7) & 0x3ff;
    r.bit_counter = bit_counter;
    // VICE rotation.c:1072-1074 — fall-back GCR_read when the read
    // walk left it zero (can only happen on a half-track or
    // unformatted track, i.e. no data). 0x11 is "good enough"
    // (won't match SYNC, won't match any GCR header byte).
    if (!drive.gcrRead) drive.gcrRead = 0x11;
  } else {
    // Write mode — VICE writes through write_next_bit; in 611.6 no
    // image is attached so write path is a tracked no-op that still
    // advances the bit counter / fires byte_ready_edge.
    while (bits_moved-- !== 0) {
      r.last_read_data = (r.last_read_data << 1) & 0x3fe;
      if ((r.last_read_data & 0xf) === 0) r.last_read_data |= 1;
      r.last_write_data = (r.last_write_data << 1) & 0xff;
      if (++r.bit_counter === 8) {
        r.bit_counter = 0;
        r.last_write_data = drive.gcrWriteValue;
        if ((drive.byteReadyActive & BRA_BYTE_READY) !== 0) {
          drive.byteReadyEdge = 1;
          drive.byteReadyLevel = 1;
        }
      }
    }
  }
}

/** VICE rotation_rotate_disk(). */
export function rotation_rotate_disk(diskunit: DiskUnitContext): void {
  __rotationCounters.rotate_disk++;
  const drive = diskunit.drives[0];
  if (!drive) return;
  if ((drive.byteReadyActive & BRA_MOTOR_ON) === 0) {
    drive.reqRefCycles = 0;
    return;
  }
  // No wobble in 611.6. complicatedImageLoaded stays 0 until 611.7.
  // p64ImageLoaded stays 0 (stub).
  rotation_1541_simple(drive);
}

/**
 * VICE rotation_sync_found() (rotation.c:1134-1142). Returns 0x80 when
 * NO sync is found (drive sees this bit on PB.7); returns 0x00 when in
 * SYNC. During attach delay or write mode, always reports 0x80 (no sync).
 */
export function rotation_sync_found(diskunit: DiskUnitContext): number {
  __rotationCounters.sync_found++;
  const drive = diskunit.drives[0];
  if (!drive) return 0x80;
  if (drive.readWriteMode === 0 || drive.attachClk !== 0) return 0x80;
  const dnr = diskunit.mynumber;
  const r = rotation[dnr];
  if (!r) return 0x80;
  return r.last_read_data === 0x3ff ? 0 : 0x80;
}

/** VICE drive.h:190 — `#define DRIVE_ATTACH_DELAY (3 * 600000)`. */
const DRIVE_ATTACH_DELAY = 1_800_000;
/** VICE drive.h:197 — `#define DRIVE_ATTACH_DETACH_DELAY (3 * 400000)`. */
const DRIVE_ATTACH_DETACH_DELAY = 1_200_000;

/** VICE rotation_byte_read() (rotation.c:1145-1170). */
export function rotation_byte_read(diskunit: DiskUnitContext): number {
  __rotationCounters.byte_read++;
  const drive = diskunit.drives[0];
  if (!drive) return 0;
  const clk = diskunit.clkPtr.value;

  if (drive.attachClk !== 0) {
    if (clk - drive.attachClk < DRIVE_ATTACH_DELAY) {
      drive.gcrRead = 0;
    } else {
      drive.attachClk = 0;
    }
  } else if (drive.attachDetachClk !== 0) {
    if (clk - drive.attachDetachClk < DRIVE_ATTACH_DETACH_DELAY) {
      drive.gcrRead = 0;
    } else {
      drive.attachDetachClk = 0;
    }
  } else {
    rotation_rotate_disk(diskunit);
  }
  drive.reqRefCycles = 0;
  return drive.gcrRead & 0xff;
}

/**
 * VICE `drive_writeprotect_sense()` (drive.c). Returns `true` for "not
 * write protected" (line high). With no disk in a 1541, the WPS
 * sensor sits high.
 */
export function drive_writeprotect_sense(drive: DriveContext | null): boolean {
  if (!drive) return true;
  return drive.readOnly === 0;
}
