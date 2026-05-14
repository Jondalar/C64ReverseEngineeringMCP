// Spec 441 (Epic 440) — TS literal port of VICE `src/drive/rotation.c` (1349 LoC).
//
// VICE function map (line ranges from VICE 3.7.1 rotation.c):
//
//   VICE function                Lines        TS export
//   ----------------------------- -----------  ----------------------------
//   rotation_init                  93-109      rotation_init
//   rotation_reset                 111-137     rotation_reset
//   rotation_speed_zone_set        139-143     rotation_speed_zone_set
//   rotation_table_get             145-182     rotation_table_get
//   rotation_table_set             184-220     rotation_table_set
//   rotation_overflow_callback     222-225     rotation_overflow_callback
//   rotation_change_mode           (decl only) rotation_change_mode (no-op)
//   write_next_bit  (static)       227-254     _write_next_bit
//   read_next_bit   (static)       256-278     _read_next_bit
//   RANDOM_nextInt  (static)       280-286     _RANDOM_nextInt
//   RANDOM_nextUInt (static)       288-293     _RANDOM_nextUInt
//   rotation_begins                295-306     rotation_begins
//   rotation_do_wobble  (static)   308-337     _rotation_do_wobble
//   rotation_1541_gcr   (static)   339-570     _rotation_1541_gcr
//   rotation_1541_gcr_cycle (static) 572-610   _rotation_1541_gcr_cycle
//   rotation_p64_get_delta (static) 618-633    _rotation_p64_get_delta
//   rotation_1541_p64   (static)   635-942     _rotation_1541_p64
//   rotation_1541_p64_cycle (static) 944-987   _rotation_1541_p64_cycle
//   rotation_1541_simple (static)  989-1104    _rotation_1541_simple
//   rotation_rotate_disk           1106-1132   rotation_rotate_disk
//   rotation_sync_found            1134-1143   rotation_sync_found
//   rotation_byte_read             1145-1167   rotation_byte_read
//
// `rotation_t` is internal to rotation.c (static array). TS mirrors
// via `_rotation: Rotation_t[]` module-level array (also internal).
//
// `drive_t` (= drive.h:236-365) is exposed via `./drive-t.ts`.
//
// Doctrine: Epic 440 + feedback_vice_no_alternatives + Spec 440
// 7-step workflow. All functions ported, no subset. P64 helper
// stubs OK per feedback_p64_stubs_ok (P64 disk images not available
// for verification today).

import {
  P64PulseSamplesPerRotation,
  type PP64PulseStream,
} from "../../../disk/p64-types.js";
import {
  P64PulseStreamFreePulse,
  P64PulseStreamAddPulse,
} from "../../../disk/p64.js";
import {
  BRA_BYTE_READY,
  BRA_MOTOR_ON,
  DRIVE_ATTACH_DELAY,
  DRIVE_ATTACH_DETACH_DELAY,
  NUM_DISK_UNITS,
  type CLOCK,
  type Drive_t,
} from "./drive-t.js";

// ----------------------------------------------------------------------------
// VICE rotation.c lines 42-44 constants.
// ----------------------------------------------------------------------------
export const ACCUM_MAX = 0x10000;
export const ROTATION_TABLE_SIZE = 0x1000;

// ----------------------------------------------------------------------------
// VICE rotation.c lines 48-83 struct.
// ----------------------------------------------------------------------------
export interface Rotation_t {
  accum: number;                  // uint32_t
  rotation_last_clk: CLOCK;
  last_read_data: number;         // unsigned int (10-bit window typically)
  last_write_data: number;        // uint8_t
  bit_counter: number;
  zero_count: number;
  frequency: number;              // 0 = 1× (1541), 1 = 2× (1571 HS)
  speed_zone: number;             // 0..3
  ue7_dcba: number;               // UE7 b1/b0 input (= zone & 3)
  ue7_counter: number;            // 4-bit
  uf4_counter: number;            // 4-bit
  fr_randcount: number;           // uint32_t
  filter_counter: number;
  filter_state: number;
  filter_last_state: number;
  write_flux: number;
  so_delay: number;
  cycle_index: number;            // uint32_t
  ref_advance: CLOCK;
  PulseHeadPosition: number;      // uint32_t (P64)
  seed: number;                   // uint32_t (RANDOM_nextInt)
  xorShift32: number;             // uint32_t (RANDOM_nextUInt)
}

function makeRotation_t(): Rotation_t {
  return {
    accum: 0,
    rotation_last_clk: 0n,
    last_read_data: 0,
    last_write_data: 0,
    bit_counter: 0,
    zero_count: 0,
    frequency: 0,
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
    ref_advance: 0n,
    PulseHeadPosition: 0,
    seed: 0,
    xorShift32: 0,
  };
}

// VICE: static rotation_t rotation[NUM_DISK_UNITS]; (rotation.c:86)
const _rotation: Rotation_t[] = Array.from({ length: NUM_DISK_UNITS }, makeRotation_t);

// VICE: static const unsigned int rot_speed_bps[2][4]; (rotation.c:89)
export const rot_speed_bps: readonly (readonly number[])[] = [
  [250000, 266667, 285714, 307692],   // freq=0: 1541 1×
  [125000, 133333, 142857, 153846],   // freq=1: 1571 HS
];

// ============================================================================
// VICE rotation.c:93 rotation_init
// ============================================================================
export function rotation_init(freq: number, dnr: number): void {
  const r = _rotation[dnr]!;
  r.frequency = freq;
  r.accum = 0;
  r.ue7_counter = 0;
  r.uf4_counter = 0;
  r.fr_randcount = 0;
  r.xorShift32 = 0x1234abcd;
  r.filter_counter = 0;
  r.filter_state = 0;
  r.filter_last_state = 0;
  r.write_flux = 0;
  r.PulseHeadPosition = 0;
  r.so_delay = 0;
  r.cycle_index = 0;
  r.ref_advance = 0n;
}

// ============================================================================
// VICE rotation.c:111 rotation_reset
// ============================================================================
export function rotation_reset(drive: Drive_t): void {
  const dnr = drive.diskunit.mynumber;
  const r = _rotation[dnr]!;

  r.last_read_data = 0;
  r.last_write_data = 0;
  r.bit_counter = 0;
  r.accum = 0;
  r.seed = 0;
  r.xorShift32 = 0x1234abcd;
  r.rotation_last_clk = drive.diskunit.clk_ptr();
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
  r.ref_advance = 0n;

  drive.req_ref_cycles = 0;
}

// ============================================================================
// VICE rotation.c:139 rotation_speed_zone_set
// ============================================================================
export function rotation_speed_zone_set(zone: number, dnr: number): void {
  const r = _rotation[dnr]!;
  r.speed_zone = zone;
  r.ue7_dcba = zone & 3;
}

// ============================================================================
// VICE rotation.c:145 rotation_table_get
// ----------------------------------------------------------------------------
// Snapshot save: dump rotation_t into drive_t.snap_* fields + return
// the speed_zone array. VICE expects rotation_table_ptr to be a
// uint32_t[NUM_DISK_UNITS] buffer; TS uses Uint32Array.
//
// Note: VICE only iterates `j < 1` (one drive per unit) so we
// preserve that exact loop shape.
// ============================================================================
export function rotation_table_get(
  rotation_table_ptr: Uint32Array,
  diskunit_context: { drives: Drive_t[] }[],
): void {
  for (let dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    const r = _rotation[dnr]!;
    rotation_table_ptr[dnr] = r.speed_zone >>> 0;

    // Only 1 drive is really supported... (per VICE comment)
    for (let j = 0; j < 1; j++) {
      const drive = diskunit_context[dnr]!.drives[j]!;

      drive.snap_accum = r.accum >>> 0;
      drive.snap_rotation_last_clk = r.rotation_last_clk;
      drive.snap_last_read_data = r.last_read_data;
      drive.snap_last_write_data = r.last_write_data;
      drive.snap_bit_counter = r.bit_counter;
      drive.snap_zero_count = r.zero_count;
      drive.snap_seed = r.seed;
      drive.snap_speed_zone = r.speed_zone;
      drive.snap_ue7_dcba = r.ue7_dcba;
      drive.snap_ue7_counter = r.ue7_counter;
      drive.snap_uf4_counter = r.uf4_counter;
      drive.snap_fr_randcount = r.fr_randcount;
      drive.snap_filter_counter = r.filter_counter;
      drive.snap_filter_state = r.filter_state;
      drive.snap_filter_last_state = r.filter_last_state;
      drive.snap_write_flux = r.write_flux;
      drive.snap_PulseHeadPosition = r.PulseHeadPosition;
      drive.snap_xorShift32 = r.xorShift32;
      drive.snap_so_delay = r.so_delay;
      drive.snap_cycle_index = r.cycle_index;
      drive.snap_ref_advance = r.ref_advance;
      drive.snap_req_ref_cycles = drive.req_ref_cycles;
    }
  }
}

// ============================================================================
// VICE rotation.c:184 rotation_table_set
// ----------------------------------------------------------------------------
// Snapshot restore. NOTE: VICE has a subtle bug at line 213 where it
// assigns `drive->snap_filter_state` to `rotation[dnr].filter_last_state`
// (i.e. NOT snap_filter_last_state). We mirror that exactly per
// "EXACTLY as VICE" doctrine.
// ============================================================================
export function rotation_table_set(
  rotation_table_ptr: Uint32Array,
  diskunit_context: { drives: Drive_t[] }[],
): void {
  for (let dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    for (let j = 0; j < 1; j++) {
      const drive = diskunit_context[dnr]!.drives[j]!;
      const r = _rotation[dnr]!;

      r.speed_zone = rotation_table_ptr[dnr]!;

      r.accum = drive.snap_accum >>> 0;
      r.rotation_last_clk = drive.snap_rotation_last_clk;
      r.last_read_data = drive.snap_last_read_data;
      r.last_write_data = drive.snap_last_write_data;
      r.bit_counter = drive.snap_bit_counter;
      r.zero_count = drive.snap_zero_count;
      r.seed = drive.snap_seed;
      r.speed_zone = drive.snap_speed_zone;
      r.ue7_dcba = drive.snap_ue7_dcba;
      r.ue7_counter = drive.snap_ue7_counter;
      r.uf4_counter = drive.snap_uf4_counter;
      r.fr_randcount = drive.snap_fr_randcount;
      r.filter_counter = drive.snap_filter_counter;
      r.filter_state = drive.snap_filter_state;
      // VICE rotation.c:213 — assigns snap_filter_state (NOT snap_filter_last_state). Preserved.
      r.filter_last_state = drive.snap_filter_state;
      r.write_flux = drive.snap_write_flux;
      r.PulseHeadPosition = drive.snap_PulseHeadPosition;
      r.xorShift32 = drive.snap_xorShift32;
      r.so_delay = drive.snap_so_delay;
      r.cycle_index = drive.snap_cycle_index;
      r.ref_advance = drive.snap_ref_advance;
      drive.req_ref_cycles = drive.snap_req_ref_cycles;
    }
  }
}

// ============================================================================
// VICE rotation.c:222 rotation_overflow_callback
// ============================================================================
export function rotation_overflow_callback(sub: CLOCK, dnr: number): void {
  _rotation[dnr]!.rotation_last_clk -= sub;
}

// ============================================================================
// VICE rotation.h:43 rotation_change_mode (decl only; no body in VICE)
// ----------------------------------------------------------------------------
// VICE declares this in rotation.h but rotation.c has no definition.
// Other VICE drives (1571, 1581, ...) might have their own; for the
// 1541-only milestone this is a deliberate no-op so call sites
// compile.
// ============================================================================
export function rotation_change_mode(_dnr: number): void {
  /* VICE rotation.c has no impl. */
}

// ============================================================================
// Internal helpers (VICE inline static)
// ============================================================================

// VICE rotation.c:227 write_next_bit
export function _write_next_bit(dptr: Drive_t, value: number): void {
  let off = dptr.GCR_head_offset;
  const byte_offset = off >> 3;
  const bit = (~off) & 7;

  // if no image is attached, writes do nothing
  if (dptr.GCR_image_loaded === 0) return;

  off++;
  if (off >= (dptr.GCR_current_track_size << 3)) {
    off = 0;
  }
  dptr.GCR_head_offset = off;

  // track does not exist
  if (dptr.GCR_track_start_ptr === null) return;
  dptr.GCR_dirty_track = 1;
  if (value) {
    dptr.GCR_track_start_ptr[byte_offset]! |= 1 << bit;
  } else {
    dptr.GCR_track_start_ptr[byte_offset]! &= ~(1 << bit) & 0xff;
  }
}

// VICE rotation.c:256 read_next_bit
export function _read_next_bit(dptr: Drive_t): number {
  let off = dptr.GCR_head_offset;
  const byte_offset = off >> 3;
  const bit = (~off) & 7;

  if (dptr.GCR_image_loaded === 0) return 0;

  off++;
  if (off >= (dptr.GCR_current_track_size << 3)) {
    off = 0;
  }
  dptr.GCR_head_offset = off;

  if (dptr.GCR_track_start_ptr === null) return 0;
  return (dptr.GCR_track_start_ptr[byte_offset]! >> bit) & 1;
}

// VICE rotation.c:280 RANDOM_nextInt — returns int32_t (may be negative)
export function _RANDOM_nextInt(rptr: Rotation_t): number {
  const bits = rptr.seed >>> 15;
  rptr.seed = (rptr.seed ^ rptr.accum) >>> 0;
  rptr.seed = ((rptr.seed << 17) | bits) >>> 0;
  // Reinterpret as signed int32:
  return rptr.seed | 0;
}

// VICE rotation.c:288 RANDOM_nextUInt
export function _RANDOM_nextUInt(rptr: Rotation_t): number {
  rptr.xorShift32 = (rptr.xorShift32 ^ (rptr.xorShift32 << 13)) >>> 0;
  rptr.xorShift32 = (rptr.xorShift32 ^ (rptr.xorShift32 >>> 17)) >>> 0;
  rptr.xorShift32 = (rptr.xorShift32 ^ (rptr.xorShift32 << 5)) >>> 0;
  return rptr.xorShift32;
}

// ============================================================================
// VICE rotation.c:295 rotation_begins
// ============================================================================
export function rotation_begins(dptr: Drive_t): void {
  const dnr = dptr.diskunit.mynumber;
  _rotation[dnr]!.rotation_last_clk = dptr.diskunit.clk_ptr();
  _rotation[dnr]!.cycle_index = 0;
}

// ============================================================================
// VICE rotation.c:308 rotation_do_wobble (static)
// ----------------------------------------------------------------------------
// VICE has two branches inside #if 0 / #else. We port the active
// branch (the simpler one without random deviation) verbatim.
// ============================================================================
const TWO_PI = 2 * Math.PI;
function _rotation_do_wobble(dptr: Drive_t): void {
  const cpu_cycles = dptr.diskunit.clk_ptr() -
                     _rotation[dptr.diskunit.mynumber]!.rotation_last_clk;

  // VICE active branch (#if 0 ... #else ...):
  //   dptr->wobble_sin_count += wobble_frequency * ((cpu_cycles * 2π) / 1e9)
  //   if (>2π) -= 2π
  //   wobble_factor = (int)(0.5 + (sinf(...) * (wobble_amplitude * 32)) / 3)
  const cycles = Number(cpu_cycles);
  dptr.wobble_sin_count += dptr.wobble_frequency *
                           ((cycles * TWO_PI) / 1_000_000_000);
  if (dptr.wobble_sin_count > TWO_PI) {
    dptr.wobble_sin_count -= TWO_PI;
  }
  dptr.wobble_factor =
    Math.trunc(0.5 + (Math.sin(dptr.wobble_sin_count) *
                      (dptr.wobble_amplitude * 32)) / 3);
}

// ============================================================================
// VICE rotation.c:339 rotation_1541_gcr (static)
// ----------------------------------------------------------------------------
// Full UE7/UF4 flux-filter chain. 1:1 port of VICE C body.
// ============================================================================
function _rotation_1541_gcr(dptr: Drive_t, ref_cycles_in: number): void {
  const dnr = dptr.diskunit.mynumber;
  const rptr = _rotation[dnr]!;

  let ref_cycles = ref_cycles_in;
  // drive speed 300RPM = 5rev/s; ref clock 16MHz → 16e6 / 5 = 3.2e6 per rev
  let clk_ref_per_rev = (16_000_000 / (300 / 60)) | 0;

  // Apply RPM + wobble (VICE uses uint64_t intermediate; we use float→int).
  let tmp = 30000.0;
  tmp *= clk_ref_per_rev;
  tmp /= dptr.rpm;
  clk_ref_per_rev = (tmp | 0) + dptr.wobble_factor;

  const cyc_act_frv = 1;
  const count_new_bitcell = cyc_act_frv * clk_ref_per_rev;

  let cyc_sum_frv = 8 * dptr.GCR_current_track_size;
  if (cyc_sum_frv === 0) cyc_sum_frv = 1;

  if (dptr.read_write_mode) {
    while (ref_cycles > 0) {
      // How-much-cycles-can-we-do logic
      let todo = 1;
      const delta = count_new_bitcell - rptr.accum;
      if (delta > 0 && (cyc_sum_frv << 1) <= (delta >>> 0)) {
        todo = (delta / cyc_sum_frv) | 0;
        if (ref_cycles < todo) todo = ref_cycles;
        if (rptr.ue7_counter < 16 && (16 - rptr.ue7_counter) < todo) {
          todo = 16 - rptr.ue7_counter;
        }
        if (rptr.filter_counter < 40 && (40 - rptr.filter_counter) < todo) {
          todo = 40 - rptr.filter_counter;
        }
        if (rptr.fr_randcount > 0 && rptr.fr_randcount < todo) {
          todo = rptr.fr_randcount;
        }
        if (rptr.so_delay > 0 && rptr.so_delay < todo) {
          todo = rptr.so_delay;
        }
      }

      // SO signal handling
      if (rptr.so_delay) {
        rptr.so_delay -= todo;
        if (!rptr.so_delay) {
          dptr.byte_ready_edge = 1;
          dptr.byte_ready_level = 1;
        }
      }

      // 2.5µs flux filter
      rptr.filter_counter += todo;
      if (rptr.filter_counter >= 40 && rptr.filter_last_state !== rptr.filter_state) {
        rptr.filter_last_state = rptr.filter_state;
        rptr.ue7_counter = rptr.ue7_dcba;
        rptr.uf4_counter = 0;
        rptr.fr_randcount = (((_RANDOM_nextUInt(rptr) >>> 16) % 31) + 289) >>> 0;
      } else {
        // VICE `uint32_t fr_randcount` wraps on underflow. JS subtraction
        // produces negative numbers — force u32 wrap to preserve VICE
        // semantics (the > 0 / < todo guards and the == 0 trigger).
        rptr.fr_randcount = (rptr.fr_randcount - todo) >>> 0;
        if (rptr.fr_randcount === 0) {
          rptr.ue7_counter = rptr.ue7_dcba;
          rptr.uf4_counter = 0;
          rptr.fr_randcount = (((_RANDOM_nextUInt(rptr) >>> 16) % 367) + 33) >>> 0;
        }
      }

      // UE7 divider
      rptr.ue7_counter += todo;
      if (rptr.ue7_counter === 16) {
        rptr.ue7_counter = rptr.ue7_dcba;
        rptr.uf4_counter = (rptr.uf4_counter + 1) & 0xf;

        if ((rptr.uf4_counter & 0x3) === 2) {
          // 8+2 bit shifter — UE5 NOR gate shifts in a 1 only at C2 when DC=0
          rptr.last_read_data =
            ((rptr.last_read_data << 1) & 0x3fe) |
            (((rptr.uf4_counter + 0x1c) >>> 4) & 0x01);

          rptr.write_flux = rptr.last_write_data & 0x80;
          rptr.last_write_data = (rptr.last_write_data << 1) & 0xff;

          if (rptr.last_read_data === 0x3ff) {
            rptr.bit_counter = 0;
            // FIXME (VICE comment) — keep behavior as-is.
          } else {
            if (++rptr.bit_counter === 8) {
              rptr.bit_counter = 0;
              dptr.GCR_read = rptr.last_read_data & 0xff;
              rptr.last_write_data = dptr.GCR_read;

              if ((dptr.byte_ready_active & BRA_BYTE_READY) !== 0) {
                rptr.so_delay = 16 - ((rptr.cycle_index + (todo - 1)) & 15);
                if (rptr.so_delay < 10) rptr.so_delay += 16;
              }
            }
          }
        }
      }

      // Advance count
      rptr.accum += cyc_sum_frv * todo;

      // Read new bitcell
      if (rptr.accum >= count_new_bitcell) {
        rptr.accum -= count_new_bitcell;
        if (_read_next_bit(dptr)) {
          rptr.filter_counter = 39;
          rptr.filter_state = rptr.filter_state ^ 1;
        }
      }

      rptr.cycle_index += todo;
      ref_cycles -= todo;
    }
  } else {
    // Write mode
    while (ref_cycles > 0) {
      let todo = 1;
      const delta = count_new_bitcell - rptr.accum;
      if (delta > 0 && (cyc_sum_frv << 1) <= (delta >>> 0)) {
        todo = (delta / cyc_sum_frv) | 0;
        if (ref_cycles < todo) todo = ref_cycles;
        if (rptr.ue7_counter < 16 && (16 - rptr.ue7_counter) < todo) {
          todo = 16 - rptr.ue7_counter;
        }
        if (rptr.so_delay > 0 && rptr.so_delay < todo) {
          todo = rptr.so_delay;
        }
      }

      if (rptr.so_delay) {
        rptr.so_delay -= todo;
        if (!rptr.so_delay) {
          dptr.byte_ready_edge = 1;
          dptr.byte_ready_level = 1;
        }
      }

      rptr.accum += cyc_sum_frv * todo;
      if (rptr.accum >= count_new_bitcell) {
        rptr.accum -= count_new_bitcell;
      }

      rptr.ue7_counter += todo;
      if (rptr.ue7_counter === 16) {
        rptr.ue7_counter = rptr.ue7_dcba;
        rptr.uf4_counter = (rptr.uf4_counter + 1) & 0xf;

        if ((rptr.uf4_counter & 0x3) === 2) {
          rptr.last_read_data =
            ((rptr.last_read_data << 1) & 0x3fe) |
            (((rptr.uf4_counter + 0x1c) >>> 4) & 0x01);

          _write_next_bit(dptr, rptr.last_write_data & 0x80);
          rptr.last_write_data = (rptr.last_write_data << 1) & 0xff;
          rptr.accum = cyc_sum_frv * 2;

          if (++rptr.bit_counter === 8) {
            rptr.bit_counter = 0;
            rptr.last_write_data = dptr.GCR_write_value;

            if ((dptr.byte_ready_active & BRA_BYTE_READY) !== 0) {
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

// ============================================================================
// VICE rotation.c:572 rotation_1541_gcr_cycle (static)
// ============================================================================
function _rotation_1541_gcr_cycle(dptr: Drive_t): void {
  const rptr = _rotation[dptr.diskunit.mynumber]!;
  const one_rotation = rptr.frequency ? 400_000n : 200_000n;

  const clk = dptr.diskunit.clk_ptr();
  let cpu_cycles = clk - rptr.rotation_last_clk;
  rptr.rotation_last_clk = clk;

  while (cpu_cycles > one_rotation * 2n) {
    cpu_cycles -= one_rotation;
  }

  let ref_cycles = Number(cpu_cycles) << (rptr.frequency ? 3 : 4);

  let ref_advance_cycles = dptr.req_ref_cycles;
  dptr.req_ref_cycles = 0;
  ref_advance_cycles &= 15;
  ref_cycles += ref_advance_cycles;

  if (ref_cycles > 0) {
    const refAdvNum = Number(rptr.ref_advance);
    if (ref_cycles > refAdvNum) {
      ref_cycles -= refAdvNum;
      rptr.ref_advance = BigInt(ref_advance_cycles);
      _rotation_1541_gcr(dptr, ref_cycles);
    } else {
      rptr.ref_advance = rptr.ref_advance - BigInt(ref_cycles);
    }
  }
}

// ============================================================================
// VICE rotation.c:618 rotation_p64_get_delta (static inline)
// ============================================================================
function _rotation_p64_get_delta(dptr: Drive_t): number {
  const rptr = _rotation[dptr.diskunit.mynumber]!;
  if (dptr.p64 === null) return P64PulseSamplesPerRotation - rptr.PulseHeadPosition;

  const P64PulseStream: PP64PulseStream =
    dptr.p64.PulseStreams[dptr.side]![dptr.current_half_track]!;

  if (P64PulseStream.CurrentIndex >= 0) {
    return P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Position -
           rptr.PulseHeadPosition;
  }

  // FIXME (VICE): wrap-around bug, preserved as-is.
  return P64PulseSamplesPerRotation - rptr.PulseHeadPosition;
}

// ============================================================================
// VICE rotation.c:635 rotation_1541_p64 (static)
// ----------------------------------------------------------------------------
// Calls P64PulseStream* helpers which are STUBS today. Mount of a
// .p64 disk image throws via isP64Image gate before reaching here.
// Logic body is the literal VICE port; only the helper-call sites
// will throw at runtime.
// ============================================================================
function _rotation_1541_p64(dptr: Drive_t, ref_cycles_in: number): void {
  const rptr = _rotation[dptr.diskunit.mynumber]!;
  if (dptr.p64 === null) return; // safety; mount gate should prevent this.

  const P64PulseStream: PP64PulseStream =
    dptr.p64.PulseStreams[dptr.side]![dptr.current_half_track]!;

  // Reset if out of head position bounds
  if (P64PulseStream.UsedLast >= 0 &&
      P64PulseStream.Pulses[P64PulseStream.UsedLast]!.Position <= rptr.PulseHeadPosition) {
    P64PulseStream.CurrentIndex = -1;
  } else {
    if (P64PulseStream.CurrentIndex < 0) {
      P64PulseStream.CurrentIndex = P64PulseStream.UsedFirst;
    } else {
      while (
        P64PulseStream.CurrentIndex >= 0 &&
        P64PulseStream.CurrentIndex !== P64PulseStream.UsedFirst &&
        P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Previous >= 0 &&
        P64PulseStream.Pulses[
          P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Previous
        ]!.Position > rptr.PulseHeadPosition
      ) {
        P64PulseStream.CurrentIndex =
          P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Previous;
      }
    }
    while (
      P64PulseStream.CurrentIndex >= 0 &&
      P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Position <= rptr.PulseHeadPosition
    ) {
      P64PulseStream.CurrentIndex =
        P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Next;
    }
  }

  let DeltaPositionToNextPulse = _rotation_p64_get_delta(dptr);
  let ref_cycles = ref_cycles_in;

  if (dptr.read_write_mode) {
    while (ref_cycles > 0) {
      let ToDo = DeltaPositionToNextPulse;
      if (ToDo <= 1) {
        ToDo = 1;
      } else {
        if (ref_cycles < ToDo) ToDo = ref_cycles;
        if (rptr.ue7_counter < 16 && (16 - rptr.ue7_counter) < ToDo) ToDo = 16 - rptr.ue7_counter;
        if (rptr.filter_counter < 40 && (40 - rptr.filter_counter) < ToDo) ToDo = 40 - rptr.filter_counter;
        if (rptr.fr_randcount > 0 && rptr.fr_randcount < ToDo) ToDo = rptr.fr_randcount;
        if (rptr.so_delay > 0 && rptr.so_delay < ToDo) ToDo = rptr.so_delay;
      }

      if (rptr.so_delay) {
        rptr.so_delay -= ToDo;
        if (!rptr.so_delay) {
          dptr.byte_ready_edge = 1;
          dptr.byte_ready_level = 1;
        }
      }

      rptr.ue7_counter += ToDo;
      rptr.filter_counter += (rptr.filter_counter < 40) ? ToDo : 0;
      if (rptr.filter_counter >= 40 && rptr.filter_state !== rptr.filter_last_state) {
        rptr.filter_last_state = rptr.filter_state;
        rptr.uf4_counter = 0;
        rptr.ue7_counter = rptr.ue7_dcba;
        rptr.fr_randcount = (((_RANDOM_nextUInt(rptr) >>> 16) % 31) + 289) >>> 0;
      } else {
        // VICE `uint32_t fr_randcount` wraps on underflow. Force u32.
        rptr.fr_randcount = (rptr.fr_randcount - ToDo) >>> 0;
        if (rptr.fr_randcount === 0) {
          rptr.uf4_counter = 0;
          rptr.ue7_counter = rptr.ue7_dcba;
          rptr.fr_randcount = (((_RANDOM_nextUInt(rptr) >>> 16) % 367) + 33) >>> 0;
        }
      }

      if (rptr.ue7_counter === 16) {
        rptr.ue7_counter = rptr.ue7_dcba;
        rptr.uf4_counter = (rptr.uf4_counter + 1) & 0xf;
        if ((rptr.uf4_counter & 3) === 2) {
          rptr.last_read_data =
            ((rptr.last_read_data << 1) & 0x3fe) |
            (((rptr.uf4_counter + 0x1c) >>> 4) & 1);
          rptr.last_write_data = (rptr.last_write_data << 1) & 0xff;

          if (rptr.last_read_data === 0x3ff) {
            rptr.bit_counter = 0;
          } else {
            if (++rptr.bit_counter === 8) {
              rptr.bit_counter = 0;
              dptr.GCR_read = rptr.last_read_data & 0xff;
              rptr.last_write_data = dptr.GCR_read;
              if ((dptr.byte_ready_active & BRA_BYTE_READY) !== 0) {
                rptr.so_delay = 16 - ((rptr.cycle_index + (ToDo - 1)) & 15);
                if (rptr.so_delay < 10) rptr.so_delay += 16;
              }
            }
          }
        }
      }

      // VICE `CLOCK DeltaPositionToNextPulse` (uint64) wraps on underflow.
      // The ToDo<=1 path can set ToDo=1 even when DeltaPositionToNextPulse=0
      // (pulse at head). u32 wrap via `>>> 0` keeps the `<= 1` and `!`
      // checks on subsequent iterations consistent with VICE semantics.
      DeltaPositionToNextPulse = (DeltaPositionToNextPulse - ToDo) >>> 0;
      rptr.PulseHeadPosition += ToDo;
      if (rptr.PulseHeadPosition >= P64PulseSamplesPerRotation) {
        rptr.PulseHeadPosition -= P64PulseSamplesPerRotation;
        P64PulseStream.CurrentIndex = P64PulseStream.UsedFirst;
        while (
          P64PulseStream.CurrentIndex >= 0 &&
          P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Position < rptr.PulseHeadPosition
        ) {
          P64PulseStream.CurrentIndex =
            P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Next;
        }
        DeltaPositionToNextPulse = _rotation_p64_get_delta(dptr);
      }

      if (!DeltaPositionToNextPulse) {
        if (
          P64PulseStream.CurrentIndex >= 0 &&
          P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Position === rptr.PulseHeadPosition
        ) {
          const Strength = P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Strength;
          if (
            Strength === 0xffffffff ||
            ((_RANDOM_nextInt(rptr) ^ 0x80000000) >>> 0) < Strength
          ) {
            rptr.filter_state ^= 1;
            rptr.filter_counter = 0;
          }
          P64PulseStream.CurrentIndex =
            P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Next;
        }
        DeltaPositionToNextPulse = _rotation_p64_get_delta(dptr);
      }

      rptr.cycle_index += ToDo;
      ref_cycles -= ToDo;
    }
  } else {
    // P64 write path — uses P64PulseStream Add/Free which are STUBS.
    let head_write = 0;
    while (ref_cycles > 0) {
      let ToDo = DeltaPositionToNextPulse;
      if (ToDo <= 1) {
        ToDo = 1;
      } else {
        if ((rptr.PulseHeadPosition + ToDo) >= P64PulseSamplesPerRotation) {
          ToDo = P64PulseSamplesPerRotation - rptr.PulseHeadPosition;
        }
        if (ref_cycles < ToDo) ToDo = ref_cycles;
        if (rptr.ue7_counter < 16 && (16 - rptr.ue7_counter) < ToDo) ToDo = 16 - rptr.ue7_counter;
        if (rptr.so_delay > 0 && rptr.so_delay < ToDo) ToDo = rptr.so_delay;
      }

      if (rptr.so_delay) {
        rptr.so_delay -= ToDo;
        if (!rptr.so_delay) {
          dptr.byte_ready_edge = 1;
          dptr.byte_ready_level = 1;
        }
      }

      rptr.ue7_counter += ToDo;
      if (rptr.ue7_counter === 16) {
        rptr.ue7_counter = rptr.ue7_dcba;
        rptr.uf4_counter = (rptr.uf4_counter + 1) & 0xf;
        if ((rptr.uf4_counter & 3) === 2) {
          rptr.last_read_data =
            ((rptr.last_read_data << 1) & 0x3fe) |
            (((rptr.uf4_counter + 0x1c) >>> 4) & 1);
          head_write = (rptr.last_write_data & 0x80) >> 7;
          rptr.last_write_data = (rptr.last_write_data << 1) & 0xff;

          if (++rptr.bit_counter === 8) {
            rptr.bit_counter = 0;
            rptr.last_write_data = dptr.GCR_write_value;
            if ((dptr.byte_ready_active & BRA_BYTE_READY) !== 0) {
              rptr.so_delay = 16 - ((rptr.cycle_index + (ToDo - 1)) & 15);
              if (rptr.so_delay < 10) rptr.so_delay += 16;
            }
          }
        }
      }

      rptr.PulseHeadPosition += ToDo;
      if (rptr.PulseHeadPosition >= P64PulseSamplesPerRotation) {
        rptr.PulseHeadPosition -= P64PulseSamplesPerRotation;
        P64PulseStream.CurrentIndex = P64PulseStream.UsedFirst;
        while (
          P64PulseStream.CurrentIndex >= 0 &&
          P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Position < rptr.PulseHeadPosition
        ) {
          P64PulseStream.CurrentIndex =
            P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Next;
        }
      }

      // Write head handling (uses STUB P64PulseStreamFreePulse / AddPulse)
      if (
        !head_write &&
        P64PulseStream.CurrentIndex >= 0 &&
        P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Position === rptr.PulseHeadPosition
      ) {
        P64PulseStreamFreePulse(P64PulseStream, P64PulseStream.CurrentIndex);
        dptr.P64_dirty = 1;
      } else if (head_write) {
        if (
          P64PulseStream.CurrentIndex >= 0 &&
          P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Position === rptr.PulseHeadPosition
        ) {
          if (P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Strength !== 0xffffffff) {
            P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Strength = 0xffffffff;
            dptr.P64_dirty = 1;
          }
        } else {
          P64PulseStreamAddPulse(P64PulseStream, rptr.PulseHeadPosition, 0xffffffff);
          dptr.P64_dirty = 1;
        }
        P64PulseStream.CurrentIndex =
          P64PulseStream.Pulses[P64PulseStream.CurrentIndex]!.Next;
        head_write = 0;
      }

      DeltaPositionToNextPulse = _rotation_p64_get_delta(dptr);

      rptr.cycle_index += ToDo;
      ref_cycles -= ToDo;
    }
  }
  void P64PulseStream;
}

// ============================================================================
// VICE rotation.c:944 rotation_1541_p64_cycle (static)
// ============================================================================
function _rotation_1541_p64_cycle(dptr: Drive_t): void {
  const rptr = _rotation[dptr.diskunit.mynumber]!;
  const one_rotation = rptr.frequency ? 400_000n : 200_000n;

  const clk = dptr.diskunit.clk_ptr();
  let cpu_cycles = clk - rptr.rotation_last_clk;
  rptr.rotation_last_clk = clk;
  while (cpu_cycles > one_rotation * 2n) {
    cpu_cycles -= one_rotation;
  }

  let ref_cycles = Number(cpu_cycles) << (rptr.frequency ? 3 : 4);

  let ref_advance_cycles = dptr.req_ref_cycles;
  dptr.req_ref_cycles = 0;
  ref_advance_cycles &= 15;
  ref_cycles += ref_advance_cycles;

  if (ref_cycles > 0) {
    const refAdvNum = Number(rptr.ref_advance);
    if (ref_cycles > refAdvNum) {
      ref_cycles -= refAdvNum;
      rptr.ref_advance = BigInt(ref_advance_cycles);
      _rotation_1541_p64(dptr, ref_cycles);
    } else {
      rptr.ref_advance = rptr.ref_advance - BigInt(ref_cycles);
    }
  }
}

// ============================================================================
// VICE rotation.c:989 rotation_1541_simple (static)
// ============================================================================
function _rotation_1541_simple(dptr: Drive_t): void {
  dptr.req_ref_cycles = 0;
  const rptr = _rotation[dptr.diskunit.mynumber]!;

  const clk = dptr.diskunit.clk_ptr();
  let delta = clk - rptr.rotation_last_clk;
  rptr.rotation_last_clk = clk;

  let tmp = 1_000_000;
  tmp += ((dptr.wobble_factor * 1_000_000) / 3_200_000) | 0;
  tmp *= 30000;
  tmp /= dptr.rpm;
  const rpmscale = tmp >>> 0;

  let bits_moved = 0;
  while (delta > 0n) {
    const tdelta = delta > 1000n ? 1000n : delta;
    delta -= tdelta;
    rptr.accum += rot_speed_bps[rptr.frequency]![rptr.speed_zone]! * Number(tdelta);
    bits_moved += (rptr.accum / rpmscale) | 0;
    rptr.accum = rptr.accum % rpmscale;
  }

  if (dptr.read_write_mode) {
    let off = dptr.GCR_head_offset;
    let last_read_data = rptr.last_read_data << 7;
    let bit_counter = rptr.bit_counter;

    let byte: number;
    if (dptr.GCR_image_loaded === 0 || dptr.GCR_track_start_ptr === null) {
      byte = 0;
    } else {
      byte = (dptr.GCR_track_start_ptr[off >> 3]! << (off & 7)) & 0xff;
    }

    while (bits_moved-- !== 0) {
      byte = (byte << 1) & 0xff;
      off++;
      if (!(off & 7)) {
        if ((off >> 3) >= dptr.GCR_current_track_size) {
          off = 0;
        }
        if (dptr.GCR_image_loaded === 0 || dptr.GCR_track_start_ptr === null) {
          byte = 0;
        } else {
          byte = dptr.GCR_track_start_ptr[off >> 3]!;
        }
      }

      last_read_data = (last_read_data << 1) >>> 0;
      last_read_data |= byte & 0x80;
      rptr.last_write_data = (rptr.last_write_data << 1) & 0xff;

      // SYNC? reset bit counter, don't move data
      if ((~last_read_data) & 0x1ff80) {
        if (++bit_counter === 8) {
          bit_counter = 0;
          dptr.GCR_read = (last_read_data >>> 7) & 0xff;
          rptr.last_write_data = dptr.GCR_read;
          if ((dptr.byte_ready_active & BRA_BYTE_READY) !== 0) {
            dptr.byte_ready_edge = 1;
            dptr.byte_ready_level = 1;
          }
        }
      } else {
        bit_counter = 0;
      }
    }
    rptr.last_read_data = (last_read_data >>> 7) & 0x3ff;
    rptr.bit_counter = bit_counter;
    dptr.GCR_head_offset = off;
    if (!dptr.GCR_read) {
      dptr.GCR_read = 0x11;
    }
  } else {
    // Write mode
    while (bits_moved-- !== 0) {
      rptr.last_read_data = (rptr.last_read_data << 1) & 0x3fe;
      if ((rptr.last_read_data & 0xf) === 0) {
        rptr.last_read_data |= 1;
      }
      _write_next_bit(dptr, rptr.last_write_data & 0x80);
      rptr.last_write_data = (rptr.last_write_data << 1) & 0xff;

      if (++rptr.bit_counter === 8) {
        rptr.bit_counter = 0;
        rptr.last_write_data = dptr.GCR_write_value;
        if ((dptr.byte_ready_active & BRA_BYTE_READY) !== 0) {
          dptr.byte_ready_edge = 1;
          dptr.byte_ready_level = 1;
        }
      }
    }
    // TODO (VICE comment): only if we introduced more than two 0 bits in a row
    dptr.complicated_image_loaded = 1;
  }
}

// ============================================================================
// VICE rotation.c:1106 rotation_rotate_disk
// ============================================================================
export function rotation_rotate_disk(dptr: Drive_t): void {
  if ((dptr.byte_ready_active & BRA_MOTOR_ON) === 0) {
    dptr.req_ref_cycles = 0;
    return;
  }
  _rotation_do_wobble(dptr);

  if (dptr.complicated_image_loaded) {
    if (dptr.P64_image_loaded) {
      _rotation_1541_p64_cycle(dptr);
    } else {
      _rotation_1541_gcr_cycle(dptr);
    }
  } else {
    _rotation_1541_simple(dptr);
  }
}

// ============================================================================
// VICE rotation.c:1134 rotation_sync_found
// ============================================================================
export function rotation_sync_found(dptr: Drive_t): number {
  const dnr = dptr.diskunit.mynumber;
  if (dptr.read_write_mode === 0 || dptr.attach_clk !== 0n) {
    return 0x80;
  }
  return _rotation[dnr]!.last_read_data === 0x3ff ? 0 : 0x80;
}

// ============================================================================
// VICE rotation.c:1145 rotation_byte_read
// ============================================================================
export function rotation_byte_read(dptr: Drive_t): void {
  const clk = dptr.diskunit.clk_ptr();

  if (dptr.attach_clk !== 0n) {
    if (clk - dptr.attach_clk < BigInt(DRIVE_ATTACH_DELAY)) {
      dptr.GCR_read = 0;
    } else {
      dptr.attach_clk = 0n;
    }
  } else if (dptr.attach_detach_clk !== 0n) {
    if (clk - dptr.attach_detach_clk < BigInt(DRIVE_ATTACH_DETACH_DELAY)) {
      dptr.GCR_read = 0;
    } else {
      dptr.attach_detach_clk = 0n;
    }
  } else {
    rotation_rotate_disk(dptr);
  }
  dptr.req_ref_cycles = 0;
}

// ============================================================================
// Test-only: expose internal rotation array for verification.
// Marked _ prefix; not a stable API.
// ============================================================================
export function _rotation_state_for_test(dnr: number): Rotation_t {
  return _rotation[dnr]!;
}

