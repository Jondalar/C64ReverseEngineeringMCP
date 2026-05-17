// PORT OF: vice/src/drive/rotation.c (full file)
// Header:  vice/src/drive/rotation.h
// VICE rev: tracked via repo working copy at /Users/alex/Development/C64/Tools/vice
//
// Spec 612 — 1541 Port Fidelity Rules
//   §1 NL-1 (one C file → one TS file, same basename)
//   §1 NL-2 (one C function → one TS function, snake_case names verbatim)
//   §1 NL-3 (one C struct field → one TS interface field, snake_case verbatim)
//   §1 NL-4 (#define → exported TS const, same name)
//   §1 NL-5 (one C module-level global → one TS module-level let/const)
//   §2 PL-1 (no TS class wrapping VICE struct)
//   §2 PL-3 (no invented helper / facade / builder)
//   §2 PL-5 (no NOT-IN-VICE helpers; delete __rotationCounters,
//            rotation_get_state/_set_state — snapshot uses
//            rotation_table_get/_set per VICE)
//   §2 PL-7 (no silent fallbacks; no `rpm || 30000` zero-guard)
//   §5 FM-block on every export
//
// Layer 5 of Spec 612 §4 LO. Depends on drivetypes.ts (layer 1) only.
//
// P64 dispatch is a Spec 612 §10 OoS stub — see PORT-STUB exports
// (rotation_1541_p64, rotation_1541_p64_cycle, rotation_p64_get_delta)
// and the throwing branch inside rotation_rotate_disk.
//
// drive_writeprotect_sense (VICE drive.c) is intentionally NOT defined
// here — it belongs in drive.ts (Spec 612 §3 FM table, layer 13).
//
// SALVAGED from _quarantine_vice1541_v4/rotation.ts. Compared to the
// quarantine source, this port:
//   * renames `RotationT` interface fields to snake_case verbatim VICE
//     (rotation.c:48-83 `rotation_s`);
//   * deletes invented `rotation_get_state` / `rotation_set_state`
//     accessors (T1.4 acceptance);
//   * deletes `__rotationCounters` / `__resetRotationStubCounters`
//     (NOT-IN-VICE observability, PL-5);
//   * uses snake_case drive_t field names per drivetypes.ts;
//   * matches VICE signatures verbatim: `rotation_rotate_disk(dptr: drive_t)`,
//     `rotation_sync_found(dptr: drive_t)`, `rotation_byte_read(dptr: drive_t)`,
//     `rotation_reset(drive: drive_t)`, `rotation_begins(dptr: drive_t)`;
//   * exports `write_next_bit` / `read_next_bit` / `RANDOM_nextInt` /
//     `RANDOM_nextUInt` (C `static` → TS export per gcr.ts precedent
//     for grep parity NL-2);
//   * imports `BRA_BYTE_READY`, `BRA_MOTOR_ON`, `DRIVE_ATTACH_DELAY`,
//     `DRIVE_ATTACH_DETACH_DELAY`, `NUM_DISK_UNITS` from drivetypes.ts
//     instead of redeclaring;
//   * drops the `rpm || 30_000` zero-guard (PL-7 — VICE divides
//     unconditionally);
//   * drops defensive `if (!drive) return` early returns (PL-5).
//
// Arithmetic fidelity:
//   * C `uint32_t` ops are masked with `>>> 0` where wrap matters
//     (accum, fr_randcount, xorShift32, etc).
//   * C `int32_t` truncation via `| 0` where signed wrap is observed
//     (RANDOM_nextInt return).
//   * `cyc_sum_frv * todo` ≤ ~64000 * ~3M = ~2e11 < 2^53 — safe in JS.
//   * `count_new_bitcell = cyc_act_frv * clk_ref_per_rev` ≤ ~3.3M — safe.

import type {
  diskunit_context_t,
  drive_t,
} from "./drivetypes.js";
import {
  BRA_BYTE_READY,
  BRA_MOTOR_ON,
  DRIVE_ATTACH_DELAY,
  DRIVE_ATTACH_DETACH_DELAY,
  NUM_DISK_UNITS,
} from "./drivetypes.js";

// =============================================================================
// SECTION 1 — header constants (NL-4)
// =============================================================================

// PORT OF: vice/src/drive/rotation.h:35
//   `#define BUS_READ_DELAY 14`
// 875 ns delay (14 × 62.5 ns) for data-bus read access.
export const BUS_READ_DELAY = 14;

// =============================================================================
// SECTION 2 — file-private constants (rotation.c:43,45)
// =============================================================================

// PORT OF: vice/src/drive/rotation.c:43 (ACCUM_MAX)
const ACCUM_MAX = 0x10000;
// PORT OF: vice/src/drive/rotation.c:45 (ROTATION_TABLE_SIZE)
const ROTATION_TABLE_SIZE = 0x1000;
// Suppress unused-symbol lint for parity constants.
void ACCUM_MAX;
void ROTATION_TABLE_SIZE;

// =============================================================================
// SECTION 3 — rotation_t struct (rotation.c:48-83)
// =============================================================================

// PORT OF: vice/src/drive/rotation.c:48-83 (rotation_s / rotation_t)
// NL-3: snake_case field names verbatim from C.
export interface rotation_t {
  // rotation.c:49 — uint32_t accum;
  accum: number;
  // rotation.c:50 — CLOCK rotation_last_clk;
  rotation_last_clk: number;
  // rotation.c:52 — unsigned int last_read_data;
  last_read_data: number;
  // rotation.c:53 — uint8_t last_write_data;
  last_write_data: number;
  // rotation.c:54 — int bit_counter;
  bit_counter: number;
  // rotation.c:55 — int zero_count;
  zero_count: number;
  // rotation.c:57 — int frequency; (1x/2x speed toggle)
  frequency: number;
  // rotation.c:58 — int speed_zone;
  speed_zone: number;
  // rotation.c:60 — int ue7_dcba; (UE7 BA counter input)
  ue7_dcba: number;
  // rotation.c:61 — int ue7_counter;
  ue7_counter: number;
  // rotation.c:62 — int uf4_counter;
  uf4_counter: number;
  // rotation.c:63 — uint32_t fr_randcount;
  fr_randcount: number;
  // rotation.c:65 — int filter_counter;
  filter_counter: number;
  // rotation.c:66 — int filter_state;
  filter_state: number;
  // rotation.c:67 — int filter_last_state;
  filter_last_state: number;
  // rotation.c:69 — int write_flux;
  write_flux: number;
  // rotation.c:71 — int so_delay;
  so_delay: number;
  // rotation.c:73 — uint32_t cycle_index;
  cycle_index: number;
  // rotation.c:75 — CLOCK ref_advance;
  ref_advance: number;
  // rotation.c:77 — uint32_t PulseHeadPosition;
  PulseHeadPosition: number;
  // rotation.c:79 — uint32_t seed;
  seed: number;
  // rotation.c:81 — uint32_t xorShift32;
  xorShift32: number;
}

// =============================================================================
// SECTION 4 — module-level state (NL-5)
// =============================================================================

// PORT OF: vice/src/drive/rotation.c:86
//   `static rotation_t rotation[NUM_DISK_UNITS];`
// VICE statically zero-initialises the array at program load. In TS we
// allocate the slots eagerly so the index expressions in rotation_init
// etc. resolve to a live object without null checks (matching VICE's
// "the slot always exists" assumption).
const rotation: rotation_t[] = (() => {
  const arr: rotation_t[] = [];
  for (let i = 0; i < NUM_DISK_UNITS; i++) {
    arr.push(zero_rotation_slot());
  }
  return arr;
})();

// VICE static zero-init of `rotation[NUM_DISK_UNITS]` at program load.
// Not a VICE function — purely the TS equivalent of C's
// "static = all zero", which the language gives for free. Kept local
// (not exported) so it does not register as a port surface.
function zero_rotation_slot(): rotation_t {
  return {
    accum: 0,
    rotation_last_clk: 0,
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
    ref_advance: 0,
    PulseHeadPosition: 0,
    seed: 0,
    xorShift32: 0,
  };
}

// PORT OF: vice/src/drive/rotation.c:89-90
//   `static const unsigned int rot_speed_bps[2][4] =
//        { { 250000, 266667, 285714, 307692 },
//          { 125000, 133333, 142857, 153846 } };`
// Speed (in bps) of the disk in the 4 disk areas, indexed by
// [frequency][speed_zone].
export const rot_speed_bps: readonly (readonly number[])[] = [
  [250_000, 266_667, 285_714, 307_692],
  [125_000, 133_333, 142_857, 153_846],
];

// =============================================================================
// SECTION 5 — public entry points (NL-2, snake_case verbatim VICE)
// =============================================================================

// PORT OF: vice/src/drive/rotation.c:93-109 (rotation_init)
export function rotation_init(freq: number, dnr: number): void {
  rotation[dnr]!.frequency = freq;
  rotation[dnr]!.accum = 0;
  rotation[dnr]!.ue7_counter = 0;
  rotation[dnr]!.uf4_counter = 0;
  rotation[dnr]!.fr_randcount = 0;
  rotation[dnr]!.xorShift32 = 0x1234abcd;
  rotation[dnr]!.filter_counter = 0;
  rotation[dnr]!.filter_state = 0;
  rotation[dnr]!.filter_last_state = 0;
  rotation[dnr]!.write_flux = 0;
  rotation[dnr]!.PulseHeadPosition = 0;
  rotation[dnr]!.so_delay = 0;
  rotation[dnr]!.cycle_index = 0;
  rotation[dnr]!.ref_advance = 0;
}

// PORT OF: vice/src/drive/rotation.c:111-137 (rotation_reset)
export function rotation_reset(drive: drive_t): void {
  const dnr = drive.diskunit!.mynumber;

  rotation[dnr]!.last_read_data = 0;
  rotation[dnr]!.last_write_data = 0;
  rotation[dnr]!.bit_counter = 0;
  rotation[dnr]!.accum = 0;
  rotation[dnr]!.seed = 0;
  rotation[dnr]!.xorShift32 = 0x1234abcd;
  rotation[dnr]!.rotation_last_clk = drive.diskunit!.clk_ptr.value;
  rotation[dnr]!.ue7_counter = 0;
  rotation[dnr]!.uf4_counter = 0;
  rotation[dnr]!.fr_randcount = 0;
  rotation[dnr]!.filter_counter = 0;
  rotation[dnr]!.filter_state = 0;
  rotation[dnr]!.filter_last_state = 0;
  rotation[dnr]!.write_flux = 0;
  rotation[dnr]!.PulseHeadPosition = 0;
  rotation[dnr]!.so_delay = 0;
  rotation[dnr]!.cycle_index = 0;
  rotation[dnr]!.ref_advance = 0;

  drive.req_ref_cycles = 0;
}

// PORT OF: vice/src/drive/rotation.c:139-143 (rotation_speed_zone_set)
export function rotation_speed_zone_set(zone: number, dnr: number): void {
  rotation[dnr]!.speed_zone = zone;
  rotation[dnr]!.ue7_dcba = zone & 3;
}

// VICE signature: `void rotation_table_get(uint32_t *rotation_table_ptr)`.
// Iterates `dnr = 0..NUM_DISK_UNITS-1` and writes
// `drive->snap_*` fields from `rotation[dnr]`. Reads `diskunit_context`
// (declared `extern` in drive.h, defined in drive.c). In this layered
// port `diskunit_context` is owned by drivesync.ts until drive.ts lands
// (Spec 612 §4 LO layer 13); rotation.ts depends only on drivetypes.ts
// (layer 1) per the layer order, so callers pass the diskunit array in
// here directly. Same field set + iteration order as VICE.
//
// PORT OF: vice/src/drive/rotation.c:145-182 (rotation_table_get)
export function rotation_table_get(
  rotation_table_ptr: Uint32Array | number[],
  diskunit_context: readonly (diskunit_context_t | null)[],
): void {
  for (let dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    rotation_table_ptr[dnr] = rotation[dnr]!.speed_zone;

    // VICE rotation.c:154 — "Only 1 drive is really supported..."
    for (let j = 0; j < 1; j++) {
      const drive = diskunit_context[dnr]?.drives[j];
      if (!drive) continue;

      drive.snap_accum = rotation[dnr]!.accum >>> 0;
      drive.snap_rotation_last_clk = rotation[dnr]!.rotation_last_clk;
      drive.snap_last_read_data = rotation[dnr]!.last_read_data;
      drive.snap_last_write_data = rotation[dnr]!.last_write_data;
      drive.snap_bit_counter = rotation[dnr]!.bit_counter;
      drive.snap_zero_count = rotation[dnr]!.zero_count;
      drive.snap_seed = rotation[dnr]!.seed;
      drive.snap_speed_zone = rotation[dnr]!.speed_zone;
      drive.snap_ue7_dcba = rotation[dnr]!.ue7_dcba;
      drive.snap_ue7_counter = rotation[dnr]!.ue7_counter;
      drive.snap_uf4_counter = rotation[dnr]!.uf4_counter;
      drive.snap_fr_randcount = rotation[dnr]!.fr_randcount;
      drive.snap_filter_counter = rotation[dnr]!.filter_counter;
      drive.snap_filter_state = rotation[dnr]!.filter_state;
      drive.snap_filter_last_state = rotation[dnr]!.filter_last_state;
      drive.snap_write_flux = rotation[dnr]!.write_flux;
      drive.snap_PulseHeadPosition = rotation[dnr]!.PulseHeadPosition;
      drive.snap_xorShift32 = rotation[dnr]!.xorShift32;
      drive.snap_so_delay = rotation[dnr]!.so_delay;
      drive.snap_cycle_index = rotation[dnr]!.cycle_index;
      drive.snap_ref_advance = rotation[dnr]!.ref_advance;
      drive.snap_req_ref_cycles = drive.req_ref_cycles;
    }
  }
}

// PORT OF: vice/src/drive/rotation.c:184-220 (rotation_table_set)
//
// VICE rotation.c:210 has a known bug — `filter_last_state` is loaded
// from `snap_filter_state` (NOT `snap_filter_last_state`). Reproduced
// verbatim per "MACH es GENAU so wie VICE" doctrine (memory:
// feedback_vice_no_alternatives). Do NOT "fix" this divergence.
export function rotation_table_set(
  rotation_table_ptr: Uint32Array | number[],
  diskunit_context: readonly (diskunit_context_t | null)[],
): void {
  for (let dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    // VICE rotation.c:191 — "Only 1 drive is really supported..."
    for (let j = 0; j < 1; j++) {
      const drive = diskunit_context[dnr]?.drives[j];
      if (!drive) continue;

      rotation[dnr]!.speed_zone = rotation_table_ptr[dnr]!;

      rotation[dnr]!.accum = drive.snap_accum >>> 0;
      rotation[dnr]!.rotation_last_clk = drive.snap_rotation_last_clk;
      rotation[dnr]!.last_read_data = drive.snap_last_read_data;
      rotation[dnr]!.last_write_data = drive.snap_last_write_data;
      rotation[dnr]!.bit_counter = drive.snap_bit_counter;
      rotation[dnr]!.zero_count = drive.snap_zero_count;
      rotation[dnr]!.seed = drive.snap_seed;
      rotation[dnr]!.speed_zone = drive.snap_speed_zone;
      rotation[dnr]!.ue7_dcba = drive.snap_ue7_dcba;
      rotation[dnr]!.ue7_counter = drive.snap_ue7_counter;
      rotation[dnr]!.uf4_counter = drive.snap_uf4_counter;
      rotation[dnr]!.fr_randcount = drive.snap_fr_randcount;
      rotation[dnr]!.filter_counter = drive.snap_filter_counter;
      rotation[dnr]!.filter_state = drive.snap_filter_state;
      // VICE rotation.c:210 BUG (verbatim): snap_filter_state, NOT
      // snap_filter_last_state. DO NOT FIX.
      rotation[dnr]!.filter_last_state = drive.snap_filter_state;
      rotation[dnr]!.write_flux = drive.snap_write_flux;
      rotation[dnr]!.PulseHeadPosition = drive.snap_PulseHeadPosition;
      rotation[dnr]!.xorShift32 = drive.snap_xorShift32;
      rotation[dnr]!.so_delay = drive.snap_so_delay;
      rotation[dnr]!.cycle_index = drive.snap_cycle_index;
      rotation[dnr]!.ref_advance = drive.snap_ref_advance;
      drive.req_ref_cycles = drive.snap_req_ref_cycles;
    }
  }
}

// PORT OF: vice/src/drive/rotation.c:222-225 (rotation_overflow_callback)
export function rotation_overflow_callback(sub: number, dnr: number): void {
  rotation[dnr]!.rotation_last_clk -= sub;
}

// PORT OF: vice/src/drive/rotation.c:227-254 (write_next_bit)
//
// C `inline static` → TS exported (C-static has no TS analogue that
// preserves grep parity NL-2; export consistent with gcr.ts precedent).
export function write_next_bit(dptr: drive_t, value: number): void {
  let off = dptr.GCR_head_offset;
  const byte_offset = off >> 3;
  const bit = (~off) & 7;

  // if no image is attached, writes do nothing
  if (dptr.GCR_image_loaded === 0) {
    return;
  }

  off++;
  if (off >= (dptr.GCR_current_track_size << 3)) {
    off = 0;
  }
  dptr.GCR_head_offset = off;

  // track does not exists
  if (dptr.GCR_track_start_ptr === null) {
    return;
  }
  dptr.GCR_dirty_track = 1;
  if (value) {
    dptr.GCR_track_start_ptr[byte_offset] =
      (dptr.GCR_track_start_ptr[byte_offset]! | (1 << bit)) & 0xff;
  } else {
    dptr.GCR_track_start_ptr[byte_offset] =
      (dptr.GCR_track_start_ptr[byte_offset]! & ~(1 << bit)) & 0xff;
  }
}

// PORT OF: vice/src/drive/rotation.c:256-278 (read_next_bit)
//
// C `inline static` → TS exported per NL-2 grep parity (see write_next_bit).
export function read_next_bit(dptr: drive_t): number {
  let off = dptr.GCR_head_offset;
  const byte_offset = off >> 3;
  const bit = (~off) & 7;

  // if no image is attached, read 0
  if (dptr.GCR_image_loaded === 0) {
    return 0;
  }

  off++;
  if (off >= (dptr.GCR_current_track_size << 3)) {
    off = 0;
  }
  dptr.GCR_head_offset = off;

  // track does not exists
  if (dptr.GCR_track_start_ptr === null) {
    return 0;
  }
  return ((dptr.GCR_track_start_ptr[byte_offset] ?? 0) >> bit) & 1;
}

// PORT OF: vice/src/drive/rotation.c:280-286 (RANDOM_nextInt)
//
// C `inline static` → TS exported per NL-2 grep parity. Used by the
// P64 weak-pulse path (rotation.c:800). Returns int32_t — JS bitwise
// `| 0` reproduces the C signed cast.
export function RANDOM_nextInt(rptr: rotation_t): number {
  const bits = (rptr.seed >>> 15) >>> 0;
  rptr.seed = (rptr.seed ^ rptr.accum) >>> 0;
  rptr.seed = (((rptr.seed << 17) >>> 0) | bits) >>> 0;
  return rptr.seed | 0;
}

// PORT OF: vice/src/drive/rotation.c:288-293 (RANDOM_nextUInt)
//
// C `inline static` → TS exported per NL-2 grep parity.
export function RANDOM_nextUInt(rptr: rotation_t): number {
  rptr.xorShift32 = (rptr.xorShift32 ^ ((rptr.xorShift32 << 13) >>> 0)) >>> 0;
  rptr.xorShift32 = (rptr.xorShift32 ^ (rptr.xorShift32 >>> 17)) >>> 0;
  rptr.xorShift32 = (rptr.xorShift32 ^ ((rptr.xorShift32 << 5) >>> 0)) >>> 0;
  return rptr.xorShift32;
}

// PORT OF: vice/src/drive/rotation.c:295-305 (rotation_begins)
export function rotation_begins(dptr: drive_t): void {
  const dnr = dptr.diskunit!.mynumber;
  rotation[dnr]!.rotation_last_clk = dptr.diskunit!.clk_ptr.value;
  rotation[dnr]!.cycle_index = 0;
}

// PORT OF: vice/src/drive/rotation.c:307-333 (rotation_do_wobble)
//
// C `static` → TS module-private. Active #else branch (rotation.c:
// 326-332) is ported; the #if 0 branch (rotation.c:315-325, lib_unsigned_rand
// wobble random deviation) is disabled in VICE source and not ported here.
//
// Note: `2.0f * M_PI` promotes to `double` because `M_PI` is `double`;
// the whole RHS of the `wobble_sin_count` update is computed in double
// precision in VICE and only narrowed to float on store. Use plain JS
// number math. For the final `sinf()` we wrap in Math.fround to honour
// the single-precision call; surrounding constants stay double (no
// observable difference at these magnitudes).
function rotation_do_wobble(dptr: drive_t): void {
  // cpu cycles since last call — VICE rotation.c:311-312
  const cpu_cycles =
    dptr.diskunit!.clk_ptr.value -
    rotation[dptr.diskunit!.mynumber]!.rotation_last_clk;

  // VICE rotation.c:327
  const TWO_PI = 2 * Math.PI;
  dptr.wobble_sin_count +=
    dptr.wobble_frequency * ((cpu_cycles * TWO_PI) / 1_000_000_000.0);
  if (dptr.wobble_sin_count > TWO_PI) {
    dptr.wobble_sin_count -= TWO_PI;
  }
  // VICE rotation.c:331 — `(int)` cast in C truncates toward zero.
  const sinF = Math.fround(Math.sin(dptr.wobble_sin_count));
  dptr.wobble_factor = Math.trunc(
    0.5 + (sinF * (dptr.wobble_amplitude * 32.0)) / 3.0,
  );
}

// PORT OF: vice/src/drive/rotation.c:339-570 (rotation_1541_gcr)
//
// C `static` → TS module-private. 1541 circuit simulation for
// GCR-based images (.g64).
function rotation_1541_gcr(dptr: drive_t, ref_cycles_in: number): void {
  const dnr = dptr.diskunit!.mynumber;
  const rptr = rotation[dnr]!;

  let ref_cycles = ref_cycles_in;

  // VICE rotation.c:347 — uint64_t tmp = 30000UL;
  let tmp = 30000;
  // VICE rotation.c:354 — clk_ref_per_rev = 16000000 / (300 / 60);
  let clk_ref_per_rev = (16_000_000 / (300 / 60)) | 0;
  // VICE rotation.c:365-367
  tmp = tmp * clk_ref_per_rev;
  tmp = Math.floor(tmp / dptr.rpm);
  clk_ref_per_rev = ((tmp | 0) + dptr.wobble_factor) | 0;

  // VICE rotation.c:370 — cyc_act_frv = 1
  const cyc_act_frv = 1;

  // VICE rotation.c:373
  const count_new_bitcell = cyc_act_frv * clk_ref_per_rev;

  // VICE rotation.c:376-377
  let cyc_sum_frv = 8 * dptr.GCR_current_track_size;
  cyc_sum_frv = cyc_sum_frv ? cyc_sum_frv : 1;

  if (dptr.read_write_mode) {
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
          dptr.byte_ready_edge = 1;
          dptr.byte_ready_level = 1;
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
          dptr.byte_ready_edge = 1;
          dptr.byte_ready_level = 1;
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

// PORT OF: vice/src/drive/rotation.c:572-610 (rotation_1541_gcr_cycle)
//
// C `static` → TS module-private. Top-level GCR dispatcher.
function rotation_1541_gcr_cycle(dptr: drive_t): void {
  const dnr = dptr.diskunit!.mynumber;
  const rptr = rotation[dnr]!;

  // VICE rotation.c:577
  const one_rotation = rptr.frequency ? 400_000 : 200_000;

  // VICE rotation.c:580-582
  const clk = dptr.diskunit!.clk_ptr.value;
  let cpu_cycles = clk - rptr.rotation_last_clk;
  rptr.rotation_last_clk = clk;
  // VICE rotation.c:584-586
  while (cpu_cycles > one_rotation * 2) {
    cpu_cycles -= one_rotation;
  }

  // VICE rotation.c:590
  let ref_cycles = cpu_cycles * (rptr.frequency ? 8 : 16);

  // VICE rotation.c:593-596
  let ref_advance_cycles = dptr.req_ref_cycles;
  dptr.req_ref_cycles = 0;
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

// PORT OF: vice/src/drive/rotation.c:618-631 (rotation_p64_get_delta)
//
// P64 throwing stub per Spec 612 §10 OoS (PAL first, NTSC/P64 deferred).
// Memory: feedback_p64_stubs_ok — P64 stubs MUST throw with spec marker,
// never silent.
export function rotation_p64_get_delta(_dptr: drive_t): number {
  throw new Error(
    "PORT-STUB: P64 not implemented per Spec 612 OoS (§10 PAL first, NTSC/P64 deferred)",
  );
}

// PORT OF: vice/src/drive/rotation.c:635-942 (rotation_1541_p64)
//
// P64 throwing stub per Spec 612 §10 OoS.
export function rotation_1541_p64(_dptr: drive_t, _ref_cycles: number): void {
  throw new Error(
    "PORT-STUB: P64 not implemented per Spec 612 OoS (§10 PAL first, NTSC/P64 deferred)",
  );
}

// PORT OF: vice/src/drive/rotation.c:944-983 (rotation_1541_p64_cycle)
//
// P64 throwing stub per Spec 612 §10 OoS.
export function rotation_1541_p64_cycle(_dptr: drive_t): void {
  throw new Error(
    "PORT-STUB: P64 not implemented per Spec 612 OoS (§10 PAL first, NTSC/P64 deferred)",
  );
}

// PORT OF: vice/src/drive/rotation.c:989-1100 (rotation_1541_simple)
//
// C `static` → TS module-private. "Very simple and fast emulation for
// perfect images like those coming from dxx files." Used when
// complicated_image_loaded == 0.
function rotation_1541_simple(dptr: drive_t): void {
  const dnr = dptr.diskunit!.mynumber;
  const rptr = rotation[dnr]!;

  dptr.req_ref_cycles = 0;

  // VICE rotation.c:1004-1006
  const clk = dptr.diskunit!.clk_ptr.value;
  let delta = clk - rptr.rotation_last_clk;
  rptr.rotation_last_clk = clk;

  // VICE rotation.c:1008-1011
  let tmp = 1_000_000;
  // VICE rotation.c:1008 — `tmp += ((long)dptr->wobble_factor * 1000000L)
  //                                 / 3200000L;`
  // C `long` division truncates toward zero — `Math.trunc` matches that.
  tmp += Math.trunc((dptr.wobble_factor * 1_000_000) / 3_200_000);
  tmp *= 30_000;
  // PL-7: NO `dptr.rpm || 30_000` guard — VICE rotation.c:1010 divides
  // unconditionally. If rpm is 0, NaN/Infinity propagates as VICE would
  // signal a divide-by-zero.
  const rpmscale = Math.floor(tmp / dptr.rpm);

  let bits_moved = 0;
  while (delta > 0) {
    const tdelta = delta > 1000 ? 1000 : delta;
    delta -= tdelta;
    rptr.accum += rot_speed_bps[rptr.frequency]![rptr.speed_zone]! * tdelta;
    bits_moved += Math.floor(rptr.accum / rpmscale);
    rptr.accum = rptr.accum % rpmscale;
  }

  if (dptr.read_write_mode) {
    // VICE rotation.c:1021-1074 — READ path.
    //
    // Bit placement (D32/D33): VICE ORs `byte & 0x80` (value 0 or 0x80)
    // into `last_read_data` AFTER `last_read_data <<= 1`, so the new
    // bit lands at bit 7 of `last_read_data`. The SYNC mask `0x1ff80`
    // covers the last 10 such samples in bits 7..16, and
    // `last_read_data >> 7` extracts the most-recent assembled byte.
    let off = dptr.GCR_head_offset;
    // VICE rotation.c:1023 — `unsigned int last_read_data = rptr->last_read_data << 7;`
    let last_read_data = (rptr.last_read_data << 7) >>> 0;
    let bit_counter = rptr.bit_counter;
    let byte: number;
    // VICE rotation.c:1027-1031
    if (dptr.GCR_image_loaded === 0 || dptr.GCR_track_start_ptr === null) {
      byte = 0;
    } else {
      // VICE rotation.c:1030 — `byte = ...[off>>3] << (off & 7);` (no
      // width mask; `byte` is `unsigned int`, high bits preserved).
      byte = ((dptr.GCR_track_start_ptr[off >> 3] ?? 0) << (off & 7)) >>> 0;
    }

    while (bits_moved-- !== 0) {
      // VICE rotation.c:1034 — `byte <<= 1; off++;`
      byte = (byte << 1) >>> 0;
      off++;
      if (!(off & 7)) {
        if ((off >> 3) >= dptr.GCR_current_track_size) {
          off = 0;
        }
        if (dptr.GCR_image_loaded === 0 || dptr.GCR_track_start_ptr === null) {
          byte = 0;
        } else {
          byte = dptr.GCR_track_start_ptr[off >> 3] ?? 0;
        }
      }

      // VICE rotation.c:1047-1049
      last_read_data = (last_read_data << 1) >>> 0;
      // D32 — OR raw `byte & 0x80` (0 or 128), NOT a 0/1 LSB.
      last_read_data = (last_read_data | (byte & 0x80)) >>> 0;
      rptr.last_write_data = (rptr.last_write_data << 1) & 0xff;

      // VICE rotation.c:1052 — sync test on bits 7..16.
      if ((~last_read_data) & 0x1ff80) {
        if (++bit_counter === 8) {
          bit_counter = 0;
          // VICE rotation.c:1055 — `GCR_read = (uint8_t)(last_read_data >> 7);`
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

    // VICE rotation.c:1069-1074
    // D33 — write-back extracts bits 7..16 of the wider accumulator.
    rptr.last_read_data = (last_read_data >>> 7) & 0x3ff;
    rptr.bit_counter = bit_counter;
    dptr.GCR_head_offset = off;
    if (!dptr.GCR_read) dptr.GCR_read = 0x11;
  } else {
    // VICE rotation.c:1075-1099 — WRITE path.
    while (bits_moved-- !== 0) {
      rptr.last_read_data = (rptr.last_read_data << 1) & 0x3fe;
      if ((rptr.last_read_data & 0xf) === 0) rptr.last_read_data |= 1;
      // VICE rotation.c:1085 (D47) — emit current bit to GCR track
      // BEFORE shifting last_write_data. Without this call the
      // simple-engine WRITE path drops every bit.
      write_next_bit(dptr, rptr.last_write_data & 0x80);
      // VICE rotation.c:1086 — `rptr->last_write_data <<= 1;`
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
    // VICE rotation.c:1098 — set complicated_image_loaded unconditionally
    // after any simple-engine write, forcing future rotations onto the
    // GCR engine.
    dptr.complicated_image_loaded = 1;
  }
}

// PORT OF: vice/src/drive/rotation.c:1106-1125 (rotation_rotate_disk)
//
// VICE signature: `void rotation_rotate_disk(drive_t *dptr)` —
// param shape matches VICE verbatim (T1.4 acceptance: NOT
// `diskunit_context_t`).
export function rotation_rotate_disk(dptr: drive_t): void {
  if ((dptr.byte_ready_active & BRA_MOTOR_ON) === 0) {
    dptr.req_ref_cycles = 0;
    return;
  }

  rotation_do_wobble(dptr);

  if (dptr.complicated_image_loaded) {
    if (dptr.P64_image_loaded) {
      // P64 throwing stub — Spec 612 §10 OoS.
      throw new Error(
        "PORT-STUB: P64 not implemented per Spec 612 OoS (§10 PAL first, NTSC/P64 deferred)",
      );
    }
    rotation_1541_gcr_cycle(dptr);
  } else {
    rotation_1541_simple(dptr);
  }
}

// PORT OF: vice/src/drive/rotation.c:1134-1143 (rotation_sync_found)
//
// VICE signature: `uint8_t rotation_sync_found(drive_t *dptr)`.
export function rotation_sync_found(dptr: drive_t): number {
  const dnr = dptr.diskunit!.mynumber;
  if (dptr.read_write_mode === 0 || dptr.attach_clk !== 0) {
    return 0x80;
  }
  return rotation[dnr]!.last_read_data === 0x3ff ? 0 : 0x80;
}

// PORT OF: vice/src/drive/rotation.c:1145-1165 (rotation_byte_read)
//
// VICE signature: `void rotation_byte_read(drive_t *dptr)`. Writes to
// `dptr->GCR_read` and returns void. (The TS shim previously returned
// the assembled byte for convenience; that NOT-IN-VICE convenience is
// dropped per PL-5 — read `dptr.GCR_read` at the call site.)
export function rotation_byte_read(dptr: drive_t): void {
  const clk = dptr.diskunit!.clk_ptr.value;

  if (dptr.attach_clk !== 0) {
    if (clk - dptr.attach_clk < DRIVE_ATTACH_DELAY) {
      dptr.GCR_read = 0;
    } else {
      dptr.attach_clk = 0;
    }
  } else if (dptr.attach_detach_clk !== 0) {
    if (clk - dptr.attach_detach_clk < DRIVE_ATTACH_DETACH_DELAY) {
      dptr.GCR_read = 0;
    } else {
      dptr.attach_detach_clk = 0;
    }
  } else {
    rotation_rotate_disk(dptr);
  }
  dptr.req_ref_cycles = 0;
}
