// Spec 441 (Epic 440) — TS interface mirror of VICE `drive_t` struct.
//
// VICE source: src/drive/drive.h:236-365 (~50 fields).
//
// Doctrine: Epic 440 — every VICE struct field is exposed verbatim.
// Field names retained snake_case where VICE uses snake_case, mixed
// case where VICE uses mixed case (`GCR_*`, `PulseHeadPosition`).
//
// Many fields are NOT yet read or written by any TS code; they exist
// in this interface so subsequent ports (Spec 442 viacore, Spec 443
// via1/via2, Spec 444 drivecpu, Spec 445 gcr write, Spec 447 memiec)
// can fill in their respective slices without re-shaping the
// interface.
//
// `diskunit` and `clk_ptr` access patterns mirror VICE's
// `drive->diskunit->mynumber` and `*(drive->diskunit->clk_ptr)`
// dereferences.

import type { PP64Image } from "../../../disk/p64-types.js";

/** VICE `CLOCK` (cycles since reset / last clock-wrap) — 64-bit. */
export type CLOCK = bigint;

// ----------------------------------------------------------------------------
// VICE drive.h #defines (byte_ready_active bit fields).
// ----------------------------------------------------------------------------
export const BRA_BYTE_READY = 0x02;  // VIA2 PCR bit
export const BRA_MOTOR_ON   = 0x04;  // VIA2 PB bit
export const BRA_LED        = 0x08;

// ----------------------------------------------------------------------------
// VICE drive.h DRIVE_*_DELAY constants used by rotation_byte_read.
// ----------------------------------------------------------------------------
export const DRIVE_ATTACH_DELAY        = 3 * 600_000; // 1,800,000 drive cycles
export const DRIVE_DETACH_DELAY        = 3 * 200_000; //   600,000
export const DRIVE_ATTACH_DETACH_DELAY = 3 * 400_000; // 1,200,000

/** VICE `NUM_DISK_UNITS` — count of disk-unit contexts. */
export const NUM_DISK_UNITS = 4;

// ----------------------------------------------------------------------------
// VICE `diskunit_context_t` minimal surface.
// VICE source: src/drive/drivetypes.h (~50 fields total; this is the
// subset rotation.c references via `drive->diskunit->...`).
// Other specs expand this interface.
// ----------------------------------------------------------------------------
export interface Diskunit_context_t {
  /** VICE `mynumber` — drive index 0..NUM_DISK_UNITS-1. */
  mynumber: number;

  /** VICE `clk_ptr` — pointer to drive's CPU clock. TS: getter. */
  clk_ptr: () => CLOCK;

  /** Other fields filled in by Spec 442+ (viacore, via1d1541, drivecpu). */
}

// ----------------------------------------------------------------------------
// VICE `drive_t` — main per-drive state.
// VICE source: src/drive/drive.h:236-365
// ----------------------------------------------------------------------------
export interface Drive_t {
  /** VICE `drive` — DRIVE_NUMBER_MIN..DRIVE_NUMBER_MAX. */
  drive: number;

  /** VICE `diskunit` — pointer to containing diskunit_context. */
  diskunit: Diskunit_context_t;

  // --- LED state (used by drive_t but not by rotation.c) ----------------
  led_status: number;
  led_last_change_clk: CLOCK;
  led_last_uiupdate_clk: CLOCK;
  led_active_ticks: CLOCK;
  led_last_pwm: CLOCK;

  // --- Head position ----------------------------------------------------
  /** VICE `current_half_track` — current half-track under R/W head. */
  current_half_track: number;

  /** VICE `stepper_last_change_clk`. */
  stepper_last_change_clk: CLOCK;
  /** VICE `stepper_new_position`. */
  stepper_new_position: number;

  /** VICE `side` — disk side (0/1 for double-sided 1571 / 1581). */
  side: number;

  // --- Byte-ready signal -----------------------------------------------
  byte_ready_level: number;
  byte_ready_edge: number;

  // --- GCR track data --------------------------------------------------
  GCR_dirty_track: number;
  GCR_write_value: number;            // uint8_t
  /** VICE `GCR_track_start_ptr` — null if no track loaded. */
  GCR_track_start_ptr: Uint8Array | null;
  GCR_current_track_size: number;
  GCR_head_offset: number;
  /** VICE `read_write_mode` — 0 = write, non-zero = read. */
  read_write_mode: number;

  /** VICE `byte_ready_active` — bits BRA_BYTE_READY / BRA_MOTOR_ON / BRA_LED. */
  byte_ready_active: number;

  // --- Attach/detach clocks --------------------------------------------
  attach_clk: CLOCK;
  detach_clk: CLOCK;
  attach_detach_clk: CLOCK;

  /** VICE `GCR_read` — byte just read by R/W head. */
  GCR_read: number;                   // uint8_t

  // --- Snapshot fields (rotation_table_get/set) ------------------------
  snap_accum: number;
  snap_rotation_last_clk: CLOCK;
  snap_last_read_data: number;
  snap_last_write_data: number;
  snap_bit_counter: number;
  snap_zero_count: number;
  snap_seed: number;
  snap_speed_zone: number;
  snap_ue7_dcba: number;
  snap_ue7_counter: number;
  snap_uf4_counter: number;
  snap_fr_randcount: number;
  snap_filter_counter: number;
  snap_filter_state: number;
  snap_filter_last_state: number;
  snap_write_flux: number;
  snap_PulseHeadPosition: number;
  snap_xorShift32: number;
  snap_so_delay: number;
  snap_cycle_index: number;
  snap_ref_advance: CLOCK;
  snap_req_ref_cycles: number;

  /** VICE `req_ref_cycles` — additional R cycles requested. */
  req_ref_cycles: number;

  // --- UI shadow state -------------------------------------------------
  old_led_status: number;
  old_half_track: number;
  old_side: number;

  // --- Image-type flags ------------------------------------------------
  complicated_image_loaded: number;
  GCR_image_loaded: number;
  P64_image_loaded: number;
  P64_dirty: number;
  read_only: number;
  extend_image_policy: number;
  ask_extend_disk_image: number;

  // --- Image pointers --------------------------------------------------
  /** VICE `image` — generic disk_image_s pointer (TS: opaque). */
  image: unknown | null;
  /** VICE `gcr` — gcr_s pointer (TS: opaque, used by gcr.ts). */
  gcr: unknown | null;
  /** VICE `p64` — PP64Image pointer; null when no .p64 disk mounted. */
  p64: PP64Image | null;

  // --- Speed / wobble --------------------------------------------------
  /** VICE `rpm` — 300 RPM = 30000 (×100 scaled). */
  rpm: number;
  wobble_sin_count: number;           // float
  wobble_factor: number;              // calculated by rotation_do_wobble
  wobble_frequency: number;
  wobble_amplitude: number;
  true_emulation: number;
}

/**
 * Initialize a Drive_t with VICE defaults (memset-zero equivalent
 * plus required pointers). Caller supplies `mynumber` and `clk_ptr`.
 *
 * Use this for new instances; rotation_init/rotation_reset are then
 * the canonical pathways for the rotation_t side.
 */
export function makeDrive_t(opts: {
  drive: number;
  mynumber: number;
  clk_ptr: () => CLOCK;
}): Drive_t {
  return {
    drive: opts.drive,
    diskunit: { mynumber: opts.mynumber, clk_ptr: opts.clk_ptr },
    led_status: 0,
    led_last_change_clk: 0n,
    led_last_uiupdate_clk: 0n,
    led_active_ticks: 0n,
    led_last_pwm: 0n,
    current_half_track: 2,
    stepper_last_change_clk: 0n,
    stepper_new_position: 0,
    side: 0,
    byte_ready_level: 0,
    byte_ready_edge: 0,
    GCR_dirty_track: 0,
    GCR_write_value: 0,
    GCR_track_start_ptr: null,
    GCR_current_track_size: 0,
    GCR_head_offset: 0,
    read_write_mode: 1,                // VICE default: read
    byte_ready_active: 0,
    attach_clk: 0n,
    detach_clk: 0n,
    attach_detach_clk: 0n,
    GCR_read: 0,
    snap_accum: 0,
    snap_rotation_last_clk: 0n,
    snap_last_read_data: 0,
    snap_last_write_data: 0,
    snap_bit_counter: 0,
    snap_zero_count: 0,
    snap_seed: 0,
    snap_speed_zone: 0,
    snap_ue7_dcba: 0,
    snap_ue7_counter: 0,
    snap_uf4_counter: 0,
    snap_fr_randcount: 0,
    snap_filter_counter: 0,
    snap_filter_state: 0,
    snap_filter_last_state: 0,
    snap_write_flux: 0,
    snap_PulseHeadPosition: 0,
    snap_xorShift32: 0,
    snap_so_delay: 0,
    snap_cycle_index: 0,
    snap_ref_advance: 0n,
    snap_req_ref_cycles: 0,
    req_ref_cycles: 0,
    old_led_status: 0,
    old_half_track: 2,
    old_side: 0,
    complicated_image_loaded: 0,
    GCR_image_loaded: 0,
    P64_image_loaded: 0,
    P64_dirty: 0,
    read_only: 0,
    extend_image_policy: 0,
    ask_extend_disk_image: 0,
    image: null,
    gcr: null,
    p64: null,
    rpm: 30000,
    wobble_sin_count: 0,
    wobble_factor: 0,
    wobble_frequency: 0,
    wobble_amplitude: 0,
    true_emulation: 1,
  };
}
