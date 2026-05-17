// Spec 611 phase 611.6 + 611.7g — VICE 1541 rotation engine.
//
// VICE source: src/drive/rotation.c
// VICE header: src/drive/rotation.h
// Doc anchor:  docs/vice-1541-arch.md §13 F + §8 rotation overview.
//
// PORT_NOTES
// ----------
// VICE source line ranges ported (verbatim, with TS-mechanical
// translation only — no algorithmic edits):
//
//   * rotation.c:43-45  — ACCUM_MAX / ROTATION_TABLE_SIZE (constants).
//   * rotation.c:48-83  — rotation_t struct → RotationT interface.
//   * rotation.c:86     — static rotation[NUM_DISK_UNITS] → const rotation[].
//   * rotation.c:89-90  — rot_speed_bps[2][4] table verbatim.
//   * rotation.c:93-109 — rotation_init().
//   * rotation.c:111-137 — rotation_reset().
//   * rotation.c:139-143 — rotation_speed_zone_set() (includes ue7_dcba).
//   * rotation.c:222-225 — rotation_overflow_callback().
//   * rotation.c:227-254 — write_next_bit().
//   * rotation.c:256-278 — read_next_bit().
//   * rotation.c:280-286 — RANDOM_nextInt().
//   * rotation.c:288-293 — RANDOM_nextUInt().
//   * rotation.c:295-305 — rotation_begins().
//   * rotation.c:308-333 — rotation_do_wobble() (active #else branch
//                          326-332; #if 0 block 315-325 NOT ported,
//                          per VICE FIXME).
//   * rotation.c:339-570 — rotation_1541_gcr() — full GCR engine,
//                          both read and write paths.
//   * rotation.c:572-610 — rotation_1541_gcr_cycle() — top-level GCR
//                          dispatcher.
//   * rotation.c:989-1100 — rotation_1541_simple() — already in 611.6.
//   * rotation.c:1106-1125 — rotation_rotate_disk() — now dispatches
//                            to gcr_cycle when complicated_image_loaded.
//   * rotation.c:1134-1143 — rotation_sync_found().
//   * rotation.c:1145-1165 — rotation_byte_read().
//
// Genuinely deferred / not-applicable for 1541 LOAD:
//
//   * rotation_1541_p64 / rotation_1541_p64_cycle (rotation.c:635-983)
//     — P64 image format. Per Spec 611 §2 P64 throwing-stub policy
//     (memory: feedback_p64_stubs_ok), P64 images are not supported by
//     this MCP runtime since no .p64 oracle exists. The dispatch in
//     rotation_rotate_disk throws if p64ImageLoaded is set; GCR-only
//     paths never reach it. Per policy: P64 stub MUST throw with spec
//     marker, never silent.
//   * rotation.c:308-333 #if 0 branch (lib_unsigned_rand wobble random
//     deviation) — disabled in VICE source, not ported here either.
//     The active #else branch IS ported.
//   * rotation_table_get / rotation_table_set (rotation.c:145-220) —
//     snapshot save/restore. Per drive-context.ts comment, snap_*
//     fields are reserved for phase 611.8. Not exercised by 1541 LOAD.
//   * rotation_change_mode header decl (rotation.h:43) — no
//     implementation in rotation.c (header-only stub in VICE). Not
//     ported.
//
// Added RotationT fields (with VICE source justification):
//
//   * ue7_dcba         (rotation.c:60) — UE7 BA counter input.
//   * ue7_counter      (rotation.c:61) — UE7 4-bit counter state.
//   * uf4_counter      (rotation.c:62) — UF4 4-bit counter state.
//   * fr_randcount     (rotation.c:63) — flux-reversal random distance.
//   * filter_counter   (rotation.c:65) — 2.5µs filter ignore count.
//   * filter_state     (rotation.c:66) — filter state bit.
//   * filter_last_state(rotation.c:67) — last filter state bit.
//   * write_flux       (rotation.c:69) — write flux bit state.
//   * so_delay         (rotation.c:71) — SO signal delay.
//   * cycle_index      (rotation.c:73) — running cycle counter.
//   * ref_advance      (rotation.c:75) — pre-simulated ref cycles.
//   * PulseHeadPosition(rotation.c:77) — P64 head position (struct
//                                         parity; unused for GCR).
//
// Added DriveContext field (in drive-context.ts):
//
//   * wobbleSinCount (drive.h:366 wobble_sin_count, float) — radians
//     accumulator for rotation_do_wobble.
//
// Arithmetic fidelity:
//
//   * C `uint32_t` ops are masked with `>>> 0` where wrap matters
//     (accum, fr_randcount, xorShift32, etc).
//   * C `int32_t` truncation via `| 0` where signed wrap is observed
//     (RANDOM_nextInt return).
//   * `cyc_sum_frv * todo` ≤ ~64000 * ~3M = ~2e11 < 2^53 — safe in JS.
//   * `count_new_bitcell = cyc_act_frv * clk_ref_per_rev` ≤ ~3.3M — safe.

import type { DiskUnitContext } from "./diskunit.js";
import type { DriveContext } from "./drive-context.js";

/** VICE rotation.h:35 — 875 ns delay (14 × 62.5 ns) for data-bus read. */
export const BUS_READ_DELAY = 14;

/** VICE rotation.c:43 — ACCUM_MAX (struct-parity constant). */
const ACCUM_MAX = 0x10000;
/** VICE rotation.c:45 — ROTATION_TABLE_SIZE (struct-parity constant). */
const ROTATION_TABLE_SIZE = 0x1000;
// Suppress unused-symbol lint for parity constants.
void ACCUM_MAX;
void ROTATION_TABLE_SIZE;

/** VICE rotation.c:89 — bps table. Index by [frequency][speed_zone]. */
export const rot_speed_bps: readonly (readonly number[])[] = [
  [250_000, 266_667, 285_714, 307_692],
  [125_000, 133_333, 142_857, 153_846],
];

/** VICE BRA_BYTE_READY mask (drive.h:283). */
const BRA_BYTE_READY = 0x02;
/** VICE BRA_MOTOR_ON mask (drive.h:284). */
const BRA_MOTOR_ON = 0x04;

/** Per-drive rotation state — matches VICE `rotation_t` (rotation.c:48-83). */
export interface RotationT {
  // VICE rotation.c:49
  accum: number;
  // VICE rotation.c:50
  rotation_last_clk: number;
  // VICE rotation.c:52
  last_read_data: number;
  // VICE rotation.c:53
  last_write_data: number;
  // VICE rotation.c:54
  bit_counter: number;
  // VICE rotation.c:55
  zero_count: number;
  // VICE rotation.c:57
  frequency: 0 | 1;
  // VICE rotation.c:58
  speed_zone: number;
  // VICE rotation.c:60
  ue7_dcba: number;
  // VICE rotation.c:61
  ue7_counter: number;
  // VICE rotation.c:62
  uf4_counter: number;
  // VICE rotation.c:63
  fr_randcount: number;
  // VICE rotation.c:65
  filter_counter: number;
  // VICE rotation.c:66
  filter_state: number;
  // VICE rotation.c:67
  filter_last_state: number;
  // VICE rotation.c:69
  write_flux: number;
  // VICE rotation.c:71
  so_delay: number;
  // VICE rotation.c:73
  cycle_index: number;
  // VICE rotation.c:75
  ref_advance: number;
  // VICE rotation.c:77
  PulseHeadPosition: number;
  // VICE rotation.c:79
  seed: number;
  // VICE rotation.c:81
  xorShift32: number;
}

/** Observable counters — kept for 611.5/611.6 smoke parity. */
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

function freshRotationT(freq: 0 | 1): RotationT {
  return {
    accum: 0,
    rotation_last_clk: 0,
    last_read_data: 0,
    last_write_data: 0,
    bit_counter: 0,
    zero_count: 0,
    frequency: freq,
    speed_zone: 0,
    ue7_dcba: 0,
    ue7_counter: 0,
    uf4_counter: 0,
    fr_randcount: 0,
    filter_counter: 0,
    filter_state: 0,
    filter_last_state: 0,
    write_flux: 0,
    so_delay: 0,
    cycle_index: 0,
    ref_advance: 0,
    PulseHeadPosition: 0,
    seed: 0,
    xorShift32: 0x1234abcd,
  };
}

/** VICE rotation_init() (rotation.c:93-109). */
export function rotation_init(freq: 0 | 1, dnr: number): void {
  rotation[dnr] = freshRotationT(freq);
}

/**
 * Spec 611 phase 611.8 — snapshot/restore accessors for the per-drive
 * rotation_t slot. VICE drive-snapshot.c serialises every snap_* field
 * (drive-snapshot.c:241-260) — drive-snapshot.ts ferries the whole
 * RotationT object via these helpers rather than reaching into module
 * privates.
 */
export function rotation_get_state(dnr: number): RotationT | undefined {
  return rotation[dnr];
}

/** Spec 611 phase 611.8 — replace per-drive rotation_t slot during restore. */
export function rotation_set_state(dnr: number, state: RotationT): void {
  rotation[dnr] = state;
}

/** VICE rotation_reset() (rotation.c:111-137). */
export function rotation_reset(drive: DriveContext): void {
  const dnr = drive.diskunit?.mynumber ?? 0;
  if (!rotation[dnr]) rotation_init(drive.diskunit?.clockFrequency === 2 ? 1 : 0, dnr);
  const r = rotation[dnr]!;
  // VICE rotation.c:117-134
  r.last_read_data = 0;
  r.last_write_data = 0;
  r.bit_counter = 0;
  r.accum = 0;
  r.seed = 0;
  r.xorShift32 = 0x1234abcd;
  r.rotation_last_clk = drive.diskunit?.clkPtr.value ?? 0;
  r.ue7_counter = 0;
  r.uf4_counter = 0;
  r.fr_randcount = 0;
  r.filter_counter = 0;
  r.filter_state = 0;
  r.filter_last_state = 0;
  r.write_flux = 0;
  r.PulseHeadPosition = 0;
  r.so_delay = 0;
  r.cycle_index = 0;
  r.ref_advance = 0;
  drive.reqRefCycles = 0;
}

/** VICE rotation_speed_zone_set() (rotation.c:139-143). */
export function rotation_speed_zone_set(zone: number, dnr: number): void {
  if (!rotation[dnr]) rotation_init(0, dnr);
  const r = rotation[dnr]!;
  r.speed_zone = zone;
  r.ue7_dcba = zone & 3;
  __rotationCounters.speed_zone_set++;
}

/** VICE rotation_overflow_callback() (rotation.c:222-225). */
export function rotation_overflow_callback(sub: number, dnr: number): void {
  const r = rotation[dnr];
  if (r) r.rotation_last_clk -= sub;
}

/** VICE rotation_begins() (rotation.c:295-305). */
export function rotation_begins(diskunit: DiskUnitContext): void {
  const dnr = diskunit.mynumber;
  if (!rotation[dnr]) rotation_init(0, dnr);
  const r = rotation[dnr]!;
  r.rotation_last_clk = diskunit.clkPtr.value;
  r.cycle_index = 0;
  __rotationCounters.begins++;
}

/* ===========================================================================
 * VICE rotation.c:227-254 — write_next_bit() (inline static).
 * =========================================================================*/
function write_next_bit(dptr: DriveContext, value: number): void {
  let off = dptr.gcrHeadOffset;
  const byte_offset = off >> 3;
  const bit = (~off) & 7;

  // if no image is attached, writes do nothing
  if (dptr.gcrImageLoaded === 0) {
    return;
  }

  off++;
  if (off >= (dptr.gcrCurrentTrackSize << 3)) {
    off = 0;
  }
  dptr.gcrHeadOffset = off;

  // track does not exist
  if (dptr.gcrTrackStartPtr === null) {
    return;
  }
  dptr.gcrDirtyTrack = 1;
  if (value) {
    dptr.gcrTrackStartPtr[byte_offset] = (dptr.gcrTrackStartPtr[byte_offset]! | (1 << bit)) & 0xff;
  } else {
    dptr.gcrTrackStartPtr[byte_offset] = (dptr.gcrTrackStartPtr[byte_offset]! & ~(1 << bit)) & 0xff;
  }
}

/* ===========================================================================
 * VICE rotation.c:256-278 — read_next_bit() (inline static).
 * =========================================================================*/
function read_next_bit(dptr: DriveContext): number {
  let off = dptr.gcrHeadOffset;
  const byte_offset = off >> 3;
  const bit = (~off) & 7;

  // if no image is attached, read 0
  if (dptr.gcrImageLoaded === 0) {
    return 0;
  }

  off++;
  if (off >= (dptr.gcrCurrentTrackSize << 3)) {
    off = 0;
  }
  dptr.gcrHeadOffset = off;

  // track does not exist
  if (dptr.gcrTrackStartPtr === null) {
    return 0;
  }
  return ((dptr.gcrTrackStartPtr[byte_offset] ?? 0) >> bit) & 1;
}

/* ===========================================================================
 * VICE rotation.c:280-286 — RANDOM_nextInt() (inline static).
 *
 *   uint32_t bits = rptr->seed >> 15;
 *   rptr->seed ^= rptr->accum;
 *   rptr->seed = rptr->seed << 17 | bits;
 *   return (int32_t) rptr->seed;
 *
 * Used only by the P64 weak-pulse path (rotation.c:800). Kept for
 * struct/API parity even though P64 dispatch throws in this port.
 * =========================================================================*/
function RANDOM_nextInt(rptr: RotationT): number {
  const bits = (rptr.seed >>> 15) >>> 0;
  rptr.seed = ((rptr.seed ^ rptr.accum) >>> 0);
  rptr.seed = (((rptr.seed << 17) >>> 0) | bits) >>> 0;
  // Cast uint32_t → int32_t for VICE comparison semantics.
  return rptr.seed | 0;
}
void RANDOM_nextInt;

/* ===========================================================================
 * VICE rotation.c:288-293 — RANDOM_nextUInt() (inline static).
 *
 *   rptr->xorShift32 ^= (rptr->xorShift32 << 13);
 *   rptr->xorShift32 ^= (rptr->xorShift32 >> 17);
 *   return rptr->xorShift32 ^= (rptr->xorShift32 << 5);
 * =========================================================================*/
function RANDOM_nextUInt(rptr: RotationT): number {
  rptr.xorShift32 = (rptr.xorShift32 ^ ((rptr.xorShift32 << 13) >>> 0)) >>> 0;
  rptr.xorShift32 = (rptr.xorShift32 ^ (rptr.xorShift32 >>> 17)) >>> 0;
  rptr.xorShift32 = (rptr.xorShift32 ^ ((rptr.xorShift32 << 5) >>> 0)) >>> 0;
  return rptr.xorShift32;
}

/* ===========================================================================
 * VICE rotation.c:308-333 — rotation_do_wobble().
 *
 * Active branch (#else, lines 326-332):
 *   dptr->wobble_sin_count += dptr->wobble_frequency *
 *       ((((uint64_t)cpu_cycles) * (2.0f * M_PI)) / 1000000000.0f);
 *   if (dptr->wobble_sin_count > (2 * M_PI))
 *       dptr->wobble_sin_count -= (2 * M_PI);
 *   dptr->wobble_factor = (int)(0.5f + (
 *       (sinf(dptr->wobble_sin_count) * ((float)dptr->wobble_amplitude * 32.0f))
 *       / 3.0f));
 *
 * Note: rotation_do_wobble does NOT update rotation_last_clk; that
 * update happens later inside rotation_1541_*_cycle / rotation_1541_simple.
 * =========================================================================*/
function rotation_do_wobble(dptr: DriveContext): void {
  const diskunit = dptr.diskunit;
  if (!diskunit) return;
  const dnr = diskunit.mynumber;
  const r = rotation[dnr];
  if (!r) return;

  const cpu_cycles = diskunit.clkPtr.value - r.rotation_last_clk;
  const TWO_PI = 2 * Math.PI;

  dptr.wobbleSinCount += dptr.wobbleFrequency * ((cpu_cycles * TWO_PI) / 1_000_000_000.0);
  if (dptr.wobbleSinCount > TWO_PI) {
    dptr.wobbleSinCount -= TWO_PI;
  }
  // (int) cast in C truncates toward zero.
  dptr.wobbleFactor = Math.trunc(
    0.5 + ((Math.sin(dptr.wobbleSinCount) * (dptr.wobbleAmplitude * 32.0)) / 3.0),
  );
}

/* ===========================================================================
 * VICE rotation.c:339-570 — rotation_1541_gcr().
 *
 * 1541 circuit simulation for GCR-based images (.g64).
 * =========================================================================*/
function rotation_1541_gcr(dptr: DriveContext, ref_cycles_in: number): void {
  const diskunit = dptr.diskunit;
  if (!diskunit) return;
  const dnr = diskunit.mynumber;
  const rptr = rotation[dnr];
  if (!rptr) return;

  let ref_cycles = ref_cycles_in;

  // VICE rotation.c:347 — uint64_t tmp = 30000UL;
  let tmp = 30000;
  // VICE rotation.c:354 — clk_ref_per_rev = 16000000 / (300 / 60);
  let clk_ref_per_rev = (16_000_000 / (300 / 60)) | 0;
  // VICE rotation.c:365-367
  tmp = tmp * clk_ref_per_rev;
  tmp = Math.floor(tmp / dptr.rpm);
  clk_ref_per_rev = ((tmp | 0) + dptr.wobbleFactor) | 0;

  // VICE rotation.c:370 — cyc_act_frv = 1
  const cyc_act_frv = 1;

  // VICE rotation.c:373
  const count_new_bitcell = cyc_act_frv * clk_ref_per_rev;

  // VICE rotation.c:376-377
  let cyc_sum_frv = 8 * dptr.gcrCurrentTrackSize;
  cyc_sum_frv = cyc_sum_frv ? cyc_sum_frv : 1;

  if (dptr.readWriteMode) {
    // VICE rotation.c:379-494 — READ path.
    while (ref_cycles > 0) {
      // VICE rotation.c:383
      let todo = 1;
      const delta = (count_new_bitcell - rptr.accum) | 0;
      if ((delta > 0) && ((cyc_sum_frv << 1) <= (delta >>> 0))) {
        todo = Math.floor(delta / cyc_sum_frv);
        if (ref_cycles < todo) todo = ref_cycles;
        if ((rptr.ue7_counter < 16) && ((16 - rptr.ue7_counter) < todo)) {
          todo = 16 - rptr.ue7_counter;
        }
        if ((rptr.filter_counter < 40) && ((40 - rptr.filter_counter) < todo)) {
          todo = 40 - rptr.filter_counter;
        }
        if ((rptr.fr_randcount > 0) && (rptr.fr_randcount < todo)) {
          todo = rptr.fr_randcount;
        }
        if ((rptr.so_delay > 0) && (rptr.so_delay < todo)) {
          todo = rptr.so_delay;
        }
      }

      // so signal handling — VICE rotation.c:405-411
      if (rptr.so_delay) {
        rptr.so_delay -= todo;
        if (!rptr.so_delay) {
          dptr.byteReadyEdge = 1;
          dptr.byteReadyLevel = 1;
        }
      }

      // 2.5µs flux filter — VICE rotation.c:413-432
      rptr.filter_counter += todo;
      if ((rptr.filter_counter >= 40) && (rptr.filter_last_state !== rptr.filter_state)) {
        rptr.filter_last_state = rptr.filter_state;
        rptr.ue7_counter = rptr.ue7_dcba;
        rptr.uf4_counter = 0;
        rptr.fr_randcount = (((RANDOM_nextUInt(rptr) >>> 16) % 31) + 289) >>> 0;
      } else {
        rptr.fr_randcount = (rptr.fr_randcount - todo) >>> 0;
        if (!rptr.fr_randcount) {
          rptr.ue7_counter = rptr.ue7_dcba;
          rptr.uf4_counter = 0;
          rptr.fr_randcount = (((RANDOM_nextUInt(rptr) >>> 16) % 367) + 33) >>> 0;
        }
      }

      // UE7 divider — VICE rotation.c:434-475
      rptr.ue7_counter += todo;
      if (rptr.ue7_counter === 16) {
        rptr.ue7_counter = rptr.ue7_dcba;
        rptr.uf4_counter = (rptr.uf4_counter + 1) & 0xf;

        if ((rptr.uf4_counter & 0x3) === 2) {
          rptr.last_read_data =
            (((rptr.last_read_data << 1) & 0x3fe) |
              (((rptr.uf4_counter + 0x1c) >> 4) & 0x01)) & 0x3ff;

          rptr.write_flux = rptr.last_write_data & 0x80;
          rptr.last_write_data = (rptr.last_write_data << 1) & 0xff;

          if (rptr.last_read_data === 0x3ff) {
            rptr.bit_counter = 0;
            // FIXME (VICE): latched BYTE READY unmodeled — kept identical.
          } else {
            if (++rptr.bit_counter === 8) {
              rptr.bit_counter = 0;
              dptr.gcrRead = rptr.last_read_data & 0xff;
              rptr.last_write_data = dptr.gcrRead;

              if ((dptr.byteReadyActive & BRA_BYTE_READY) !== 0) {
                rptr.so_delay = 16 - ((rptr.cycle_index + (todo - 1)) & 15);
                if (rptr.so_delay < 10) rptr.so_delay += 16;
              }
            }
          }
        }
      }

      // advance the count until the next bitcell — VICE rotation.c:478
      rptr.accum = (rptr.accum + cyc_sum_frv * todo) >>> 0;

      // read the new bitcell — VICE rotation.c:481-490
      if (rptr.accum >= count_new_bitcell) {
        rptr.accum = (rptr.accum - count_new_bitcell) >>> 0;
        if (read_next_bit(dptr)) {
          rptr.filter_counter = 39;
          rptr.filter_state = rptr.filter_state ^ 1;
        }
      }

      rptr.cycle_index += todo;
      ref_cycles -= todo;
    }
  } else {
    // VICE rotation.c:495-569 — WRITE path.
    while (ref_cycles > 0) {
      let todo = 1;
      const delta = (count_new_bitcell - rptr.accum) | 0;
      if ((delta > 0) && ((cyc_sum_frv << 1) <= (delta >>> 0))) {
        todo = Math.floor(delta / cyc_sum_frv);
        if (ref_cycles < todo) todo = ref_cycles;
        if ((rptr.ue7_counter < 16) && ((16 - rptr.ue7_counter) < todo)) {
          todo = 16 - rptr.ue7_counter;
        }
        if ((rptr.so_delay > 0) && (rptr.so_delay < todo)) {
          todo = rptr.so_delay;
        }
      }

      if (rptr.so_delay) {
        rptr.so_delay -= todo;
        if (!rptr.so_delay) {
          dptr.byteReadyEdge = 1;
          dptr.byteReadyLevel = 1;
        }
      }

      // VICE rotation.c:523-527
      rptr.accum = (rptr.accum + cyc_sum_frv * todo) >>> 0;
      if (rptr.accum >= count_new_bitcell) {
        rptr.accum = (rptr.accum - count_new_bitcell) >>> 0;
      }

      // VICE rotation.c:529-563
      rptr.ue7_counter += todo;
      if (rptr.ue7_counter === 16) {
        rptr.ue7_counter = rptr.ue7_dcba;
        rptr.uf4_counter = (rptr.uf4_counter + 1) & 0xf;

        if ((rptr.uf4_counter & 0x3) === 2) {
          rptr.last_read_data =
            (((rptr.last_read_data << 1) & 0x3fe) |
              (((rptr.uf4_counter + 0x1c) >> 4) & 0x01)) & 0x3ff;

          write_next_bit(dptr, rptr.last_write_data & 0x80);

          rptr.last_write_data = (rptr.last_write_data << 1) & 0xff;

          rptr.accum = (cyc_sum_frv * 2) >>> 0;

          if (++rptr.bit_counter === 8) {
            rptr.bit_counter = 0;
            rptr.last_write_data = dptr.gcrWriteValue;

            if ((dptr.byteReadyActive & BRA_BYTE_READY) !== 0) {
              rptr.so_delay = 16 - ((rptr.cycle_index + (todo - 1)) & 15);
              if (rptr.so_delay < 10) rptr.so_delay += 16;
            }
          }
        }
      }

      rptr.cycle_index += todo;
      ref_cycles -= todo;
    }
  }
}

/* ===========================================================================
 * VICE rotation.c:572-610 — rotation_1541_gcr_cycle().
 *
 * Top-level GCR dispatcher: converts cpu_cycles → ref_cycles and calls
 * rotation_1541_gcr().
 * =========================================================================*/
function rotation_1541_gcr_cycle(dptr: DriveContext): void {
  const diskunit = dptr.diskunit;
  if (!diskunit) return;
  const dnr = diskunit.mynumber;
  const rptr = rotation[dnr];
  if (!rptr) return;

  // VICE rotation.c:577
  const one_rotation = rptr.frequency ? 400_000 : 200_000;

  // VICE rotation.c:580-582
  const clk = diskunit.clkPtr.value;
  let cpu_cycles = clk - rptr.rotation_last_clk;
  rptr.rotation_last_clk = clk;
  // VICE rotation.c:584-586
  while (cpu_cycles > one_rotation * 2) {
    cpu_cycles -= one_rotation;
  }

  // VICE rotation.c:590 — ref_cycles = cpu_cycles << (frequency ? 3 : 4)
  let ref_cycles = (cpu_cycles * (rptr.frequency ? 8 : 16)) | 0;

  // VICE rotation.c:593-596
  let ref_advance_cycles = dptr.reqRefCycles;
  dptr.reqRefCycles = 0;
  ref_advance_cycles &= 15;
  ref_cycles += ref_advance_cycles;

  // VICE rotation.c:599-609
  if (ref_cycles > 0) {
    if (ref_cycles > rptr.ref_advance) {
      ref_cycles -= rptr.ref_advance;
      rptr.ref_advance = ref_advance_cycles;
      rotation_1541_gcr(dptr, ref_cycles);
    } else {
      rptr.ref_advance -= ref_cycles;
    }
  }
}

/* ===========================================================================
 * VICE rotation.c:989-1100 — rotation_1541_simple() (kept from 611.6).
 *
 * "Very simple and fast emulation for perfect images like those coming
 *  from dxx files." Used when complicated_image_loaded == 0.
 * =========================================================================*/
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

  // VICE rotation.c:1008-1011
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
    if (!drive.gcrRead) drive.gcrRead = 0x11;
  } else {
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

/* ===========================================================================
 * VICE rotation.c:1106-1125 — rotation_rotate_disk().
 * =========================================================================*/
export function rotation_rotate_disk(diskunit: DiskUnitContext): void {
  __rotationCounters.rotate_disk++;
  const drive = diskunit.drives[0];
  if (!drive) return;
  if ((drive.byteReadyActive & BRA_MOTOR_ON) === 0) {
    drive.reqRefCycles = 0;
    return;
  }

  rotation_do_wobble(drive);

  if (drive.complicatedImageLoaded) {
    if (drive.p64ImageLoaded) {
      // P64 throwing stub — see PORT_NOTES.
      throw new Error(
        "[VICE1541] rotation_1541_p64_cycle: P64 image format is not " +
          "supported by this MCP runtime (Spec 611 §2 P64 throwing-stub " +
          "policy). Attach a .g64 or .d64 image instead.",
      );
    }
    rotation_1541_gcr_cycle(drive);
  } else {
    rotation_1541_simple(drive);
  }
}

/* ===========================================================================
 * VICE rotation.c:1134-1143 — rotation_sync_found().
 * =========================================================================*/
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

/* ===========================================================================
 * VICE rotation.c:1145-1165 — rotation_byte_read().
 * =========================================================================*/
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
