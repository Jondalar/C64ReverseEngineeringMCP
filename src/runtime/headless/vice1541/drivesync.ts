// Spec 611 phase 611.3 — drivesync (sync_factor + attach-clk decay).
//
// VICE source: src/drive/drivesync.c
// Doc anchor:  docs/vice-1541-arch.md §5 + §13 C
//
// The drive 6502 runs at a slightly different clock from the host
// (C64) — 1 MHz nominal on both sides, but PAL/NTSC differences and
// implementation tolerances make the *real* ratio host-cycles per
// drive-cycle non-1. VICE expresses the ratio as a 16.16 fixed-point
// `sync_factor` and accumulates fractional drive cycles on each
// `drivecpu_execute()` call.
//
// Stock 1541 attached to PAL C64:
//   host_freq  = 985 248 Hz (PAL C64 clock)
//   drive_freq = 1 000 000 Hz (nominal 1 MHz; clock_frequency = 1)
//   sync_factor = (1.0 / (drive_freq / host_freq)) * 0x10000
//               = (host_freq / drive_freq) * 0x10000
//               ≈ 0.985248 * 0x10000 ≈ 0xfc36
//
// Stock 1541 attached to NTSC C64:
//   host_freq  = 1 022 727 Hz
//   sync_factor ≈ 1.022727 * 0x10000 ≈ 0x105d3
//
// 611.3 stays PAL-only; NTSC values added when needed.

/** Host (C64) clock for PAL (Hz). */
export const C64_HZ_PAL = 985_248;
/** Host (C64) clock for NTSC (Hz). */
export const C64_HZ_NTSC = 1_022_727;
/** Drive (1541) nominal clock (Hz). */
export const DRIVE_HZ_1541 = 1_000_000;

/** VICE sync_factor scale (16.16 fixed point). */
export const SYNC_FACTOR_SCALE = 0x10000;

/**
 * Compute `sync_factor` per VICE drivesync.c.
 * Returns the integer 16.16 representation of `host_freq / drive_freq`.
 */
export function computeSyncFactor(
  hostHz: number,
  driveHz: number = DRIVE_HZ_1541,
): number {
  return Math.round((hostHz / driveHz) * SYNC_FACTOR_SCALE);
}

/**
 * VICE attach_clk decay state. When a disk is attached or detached
 * VICE imposes a small delay before the drive can sense the change
 * (`attach_clk`, `detach_clk`, `attach_detach_clk` in drive_t).
 *
 * 611.3 covers the decay model only — the consumer is `attachDisk()`
 * (phase 611.7) and the rotation step (phase 611.6); both are absent
 * here. We expose just enough of the API surface for those phases to
 * land later without renaming.
 */
export const ATTACH_DETACH_DELAY_CYCLES = 320_000; // ≈ 320 ms at 1 MHz

export interface AttachClkState {
  attachClk: number;
  detachClk: number;
  attachDetachClk: number;
}

/** Reset attach-clk state (no media events outstanding). */
export function resetAttachClk(state: AttachClkState): void {
  state.attachClk = 0;
  state.detachClk = 0;
  state.attachDetachClk = 0;
}
