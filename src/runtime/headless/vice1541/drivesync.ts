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
// VICE drivesync.c:57 formula (source-verified):
//   sync_factor = floor(65536.0 * (1000000.0 / cycles_per_sec))
// where `cycles_per_sec` is the host (C64) clock and the literal
// `1000000.0` is the 1541 drive's nominal frequency.
//
// Meaning: sync_factor scales **host cycles to drive cycles**. The
// drivecpu_execute() loop multiplies (hostClk_delta * sync_factor)
// >> 16 to obtain how many drive cycles must run for the given host
// time slice. PAL host runs slower than the 1541's 1 MHz, so the
// drive must run *more* cycles per host cycle (sync_factor > 1.0).
//
// Stock 1541 attached to PAL C64:
//   host_freq  = 985 248 Hz
//   drive_freq = 1 000 000 Hz
//   sync_factor = floor(65536 * (1_000_000 / 985_248)) ≈ 66518 ≈ $103D6
//   ⇒ 2_000_000 host cycles → ≈ 2_029_952 drive cycles.
//
// Stock 1541 attached to NTSC C64:
//   host_freq  = 1 022 727 Hz
//   sync_factor = floor(65536 * (1_000_000 / 1_022_727)) ≈ 64108 ≈ $fa6c
//   ⇒ 2_000_000 host cycles → ≈ 1_956_136 drive cycles.
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
 * Compute `sync_factor` per VICE drivesync.c:57 — verbatim:
 *   sync_factor = floor(65536.0 * (drive_freq / host_freq))
 *
 * Returns the integer 16.16 representation. Use this value to scale
 * host cycles → drive cycles: `driveCycles = (hostCycles * sync_factor) >> 16`.
 */
export function computeSyncFactor(
  hostHz: number,
  driveHz: number = DRIVE_HZ_1541,
): number {
  return Math.floor(SYNC_FACTOR_SCALE * (driveHz / hostHz));
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
