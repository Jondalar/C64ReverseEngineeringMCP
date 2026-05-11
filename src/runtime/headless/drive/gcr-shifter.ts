// Spec 153 / Sprint 114 — bit-stream GCR rotation simulator,
// 1:1 port of VICE drive/rotation.c (specifically the simplified
// rotation_1541_simple bit shifter; the full UE7/UF4/flux-filter
// chain in rotation_1541_gcr is not modeled here — it operates on
// raw GCR bit streams from G64 images and has no NRZI/p64 input).
//
// VICE source paths read:
//  - vice/src/drive/rotation.h           — public API + struct fields
//  - vice/src/drive/rotation.c L43-110   — rotation_t + init
//  - vice/src/drive/rotation.c L256-278  — read_next_bit() bit-level pull
//  - vice/src/drive/rotation.c L989-1100 — rotation_1541_simple (bit
//    shifter + 10-bit SYNC detect + byte latch + byte-ready)
//  - vice/src/drive/rotation.c L1106-1125 — rotation_rotate_disk dispatch
//    (motor gate + simple/complex selection)
//  - vice/src/drive/rotation.c L1134-1143 — rotation_sync_found (returns
//    bit#7 of VIA2 PRB: 0 if SYNC active else 0x80)
//  - vice/src/gcr.c L170-189            — gcr_find_sync (10 ones = SYNC)
//
// This module is the *standalone* shifter; integration into via2d1541
// (PA latch, CA1 byte-ready, SO pin → CPU V flag) lives in a separate
// task. Only the bit accumulator + sync detector + byte-ready callback
// are modeled here. The neighbouring file `head-position.ts` already
// contains an inline copy of this logic on the legacy `TrackBuffer`
// class — that path stays for now; this new module replaces it once
// integration lands.
//
// Naming is hybrid: VICE field names retained verbatim where they
// clarify intent (`last_read_data`, `bit_counter`, `accum`) and TS
// camelCase elsewhere.

import type { G64Parser } from "../../../disk/g64-parser.js";
import type { HeadPosition } from "./head-position.js";
import { type BYTE, u8 } from "../util/uint.js";

// ---------------------------------------------------------------------------
// Density / speed-zone tables — Spec 412 / doc §8.3, §17 OQ-412-2.
//
// Canonical VICE source: `src/drive/rotation.c:89`:
//   static const unsigned int rot_speed_bps[2][4] = {
//       { 250000, 266667, 285714, 307692 },   // freq=0 (1541 1× speed)
//       { 125000, 133333, 142857, 153846 } }; // freq=1 (1571 HS — not used here)
//
// 1541 uses only `rot_speed_bps[0]` (clockFrequency=1). At a 1 MHz
// drive clock (= 1e6 cycles/sec):
//   zone 0:   250000 bps → 4.000 cyc/bit → 32 drive cycles per GCR byte
//   zone 1:   266667 bps → 3.750 cyc/bit → 30
//   zone 2:   285714 bps → 3.500 cyc/bit → 28
//   zone 3:   307692 bps → 3.250 cyc/bit → 26
// The hardware mapping (VIA2 PB5/PB6) is: zone 0 = outer (slowest,
// tracks 31-35); zone 3 = inner (fastest, tracks 1-17).
//
// We work in fixed-point ×8 (drive cycles × 8 ≡ bit-time × 64) so all
// arithmetic stays integer. CYCLES_PER_BYTE_BY_ZONE = drive cycles per
// 8 bits. We accumulate driveCycles*8 per tick and pull one bit each
// time the accumulator reaches the (cyclesPerByte) threshold — one
// bit per (cyclesPerByte / 8) drive cycles.
//
// Doc: docs/vice-1541-arch.md §8.3 + §17 OQ-412-2 (RESOLVED 2026-05-11).
// VICE: src/drive/rotation.c:89 `rot_speed_bps[2][4]`.
// ---------------------------------------------------------------------------

/**
 * VICE-exact bits-per-second per (frequency, zone). Frequency 0 = 1541
 * 1× speed; frequency 1 = 1571 high-speed (kept for completeness, not
 * used by the 1541 path).
 *
 * Doc: docs/vice-1541-arch.md §8.3, §17 OQ-412-2.
 * VICE: src/drive/rotation.c:89 `rot_speed_bps[2][4]`.
 */
export const ROT_SPEED_BPS: ReadonlyArray<ReadonlyArray<number>> = [
  [250000, 266667, 285714, 307692],
  [125000, 133333, 142857, 153846],
] as const;

/**
 * Drive cycles per GCR byte by zone (1541, frequency=0). Pinned to
 * VICE `rot_speed_bps[0][zone]` at 1 MHz drive clock:
 *
 *   cycles_per_byte[zone] = round(1_000_000 / rot_speed_bps[0][zone] * 8)
 *
 *   zone 0: 32 (= 1e6 / 250000 * 8 = 32.000)
 *   zone 1: 30 (= 1e6 / 266667 * 8 = 29.9996…)
 *   zone 2: 28 (= 1e6 / 285714 * 8 = 28.0000…)
 *   zone 3: 26 (= 1e6 / 307692 * 8 = 26.0000…)
 *
 * Doc: docs/vice-1541-arch.md §8.3 + §17 OQ-412-2.
 * VICE: src/drive/rotation.c:89 + drive_clock=1MHz.
 */
export const CYCLES_PER_BYTE_BY_ZONE: ReadonlyArray<number> = [32, 30, 28, 26];

/**
 * VICE-exact wobble PRNG seed. Per OQ-412-1 (RESOLVED 2026-05-11) the
 * wobble xorShift32 is seeded to the fixed constant `0x1234abcd` in
 * both `rotation_init()` (rotation.c:100) and `rotation_reset()`
 * (rotation.c:122). Deterministic across runs — important for
 * diff-trace reproducibility (doc §8.5).
 *
 * Doc: docs/vice-1541-arch.md §8.5 + §17 OQ-412-1.
 * VICE: src/drive/rotation.c:100, 122, 290 (`xorShift32`).
 */
export const ROTATION_WOBBLE_PRNG_SEED = 0x1234abcd as const;

// VICE drive.h media-attach delay constants. Drive sees no-sync +
// neutral data for this many cycles after attach/detach so the read
// amp + drive ROM can settle without abrupt bit-stream transition.
export const DRIVE_ATTACH_DELAY = 3 * 600_000;          // 1,800,000 cycles
export const DRIVE_DETACH_DELAY = 3 * 200_000;          //   600,000 cycles
export const DRIVE_ATTACH_DETACH_DELAY = 3 * 400_000;   // 1,200,000 cycles

/** Drive cycles per single GCR bit for the given zone (zone & 0x03). */
export function cyclesPerByteForZone(zone: number): number {
  return CYCLES_PER_BYTE_BY_ZONE[zone & 0x03]!;
}

/** Track → density zone mapping (1541 standard layout). */
export function zoneForTrack(track: number): 0 | 1 | 2 | 3 {
  if (track >= 31) return 0;
  if (track >= 25) return 1;
  if (track >= 18) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GcrShifterOptions {
  /** GCR bit-stream source (G64). */
  parser: G64Parser;
  /** Head position tracker (provides current half-track / track). */
  headPosition: HeadPosition;
  /** Fired when 8 bits have been clocked in (outside SYNC). */
  onByteReady?: (byte: BYTE) => void;
  /** Fired on SYNC# transitions (true = sync detected, 10×'1' bits). */
  onSyncDetected?: (active: boolean) => void;
}

export interface GcrShifterSnapshot {
  bitOffset: number;
  lastReadData: number;     // 10-bit shifter, VICE last_read_data
  bitCounter: number;       // 0..7
  accumX8: number;          // fixed-point bit-time accumulator (×8)
  syncActive: boolean;
  motorOn: boolean;
  densityOverride: 0 | 1 | 2 | 3 | undefined;
  latchedTrack: number;     // last track the shifter was bound to
  dataByte: BYTE;           // last latched VIA2 PA value
}

/**
 * Cycle-accurate 1541 GCR shifter.
 *
 * Mirrors VICE rotation_1541_simple's read path
 * (drive/rotation.c L1021-1074):
 *   - 10-bit sliding shift register (last_read_data)
 *   - 8-bit byte counter (bit_counter)
 *   - SYNC = (~last_read_data & 0x1ff80) == 0  (i.e. 10 consecutive 1s)
 *   - On SYNC, bit_counter is held at 0 — byte latch suppressed
 *   - On 8th non-sync bit: latch GCR_read, fire byte-ready
 *
 * Density zone selection: VIA2 PB5/PB6 via setDensity() overrides
 * the track-derived zone (Spec 113 M3.5b parity).
 *
 * Motor gate: when off, tick() is a no-op (Spec 113 M3.5a parity,
 * VICE rotation_rotate_disk L1108-1111 BRA_MOTOR_ON gate).
 */
export class GcrShifter {
  private readonly parser: G64Parser;
  private readonly head: HeadPosition;
  /**
   * Byte-ready callback. Mutable so callers can rewire after construction
   * (e.g. DriveCpu post-CPU-construct wiring of CA1 + SO pin pulse — the
   * shifter is built before the drive CPU and VIA2 in IntegratedSession).
   * Spec 153 / Sprint 114 contract.
   */
  public onByteReady?: (byte: BYTE) => void;
  /** SYNC#-edge callback. Mutable for the same reason. */
  public onSyncDetected?: (active: boolean) => void;

  /**
   * Spec 205-A c6: kernel trace observer. Independent of onByteReady
   * (which is owned by DriveCpu for V-flag set + VIA2 CA1) so the
   * trace path doesn't conflict with the timing-critical wiring.
   * Kernel installs this; called AFTER onByteReady fires.
   */
  public traceByteReady?: (byte: BYTE) => void;
  /** Spec 205-A c6: kernel trace SYNC# observer. */
  public traceSyncDetected?: (active: boolean) => void;

  // Track buffer cache: track-number → raw GCR bytes (or null for
  // unformatted/half-track positions). Lazy-loaded on first reach.
  private readonly trackCache = new Map<number, Uint8Array | null>();

  // Bit cursor within the current track's GCR stream.
  // VICE drive_t.GCR_head_offset L256-278.
  private bitOffset = 0;

  // 10-bit sliding window (VICE rotation_t.last_read_data — masked to
  // 0x3ff).  Used for both byte-latch and SYNC detection.
  private last_read_data = 0;

  // VICE rotation_t.bit_counter (0..7). Reset to 0 on SYNC.
  private bit_counter = 0;

  // Fixed-point bit-time accumulator. Increments by driveCycles*8 per
  // tick; we pull one bit each time this crosses cyclesPerByte (which
  // already represents bit-cell × 8).
  private accumX8 = 0;

  // SYNC# state (active LOW at hardware level, but we expose syncBit
  // via getter).  Internal flag is "sync detected" (true=10 ones).
  private syncActive = false;

  // VIA2 PB2 (motor) gate.
  private motorOn = true;

  // VIA2 PB5/PB6 density-zone override (undefined → derive from track).
  private densityOverride: 0 | 1 | 2 | 3 | undefined;

  // VICE attach/detach state machine (drive.h DRIVE_ATTACH_DELAY etc).
  // While attach_clk != 0 AND (clk - attach_clk) < DRIVE_ATTACH_DELAY:
  //   syncBit returns "no sync" (0x80 / bit=1)
  //   dataByte returns 0 (= GCR_read = 0 in VICE rotation_byte_read)
  // attach_clk auto-clears once delay elapses (mirrors VICE
  // rotation.c:1153). Same pattern for detach + attach-after-detach.
  private attach_clk: number = 0;
  private detach_clk: number = 0;
  private attach_detach_clk: number = 0;
  // External clock provider — set by IntegratedSession to c64Cpu.cycles.
  // When undefined, attach delays are effectively skipped (= unit test mode).
  private clockProvider?: () => number;

  // Track currently bound to the shifter; flushed when head moves.
  private latchedTrack = -1;

  // Spec 412 / doc §8.5 + §17 OQ-412-1 (RESOLVED 2026-05-11): VICE-exact
  // wobble PRNG. Seeded to fixed constant 0x1234abcd in both
  // rotation_init() (rotation.c:100) and rotation_reset() (rotation.c:122).
  // Advanced via xorShift32 (rotation.c:290-292). Even though the
  // simplified shifter does not currently apply RPM modulation to the
  // bit-cell timing (the simple path uses constant cycles_per_byte =
  // rot_speed_bps[0][zone] at nominal 300 RPM), the PRNG state is
  // modelled for deterministic diff-trace fidelity vs VICE and for any
  // future wobble-factor injection. `rotationTickCount` mirrors the
  // VICE per-drive-cycle rotation_rotate_disk invocation counter; used
  // by spec 412 acceptance smoke (tick count == drive cycle count).
  //
  // Doc: docs/vice-1541-arch.md §8.5 + §17 OQ-412-1.
  // VICE: src/drive/rotation.c:100, 122, 290.
  private wobbleXorShift32 = ROTATION_WOBBLE_PRNG_SEED >>> 0;
  private rotationTickCount = 0;

  // Latched VIA2 PA byte (last completed byte from the shifter).
  // VICE drive_t.GCR_read.  Default 0xff = "no data" (open bus).
  private dataByteLatch: BYTE = 0xff;

  constructor(opts: GcrShifterOptions) {
    this.parser = opts.parser;
    this.head = opts.headPosition;
    this.onByteReady = opts.onByteReady;
    this.onSyncDetected = opts.onSyncDetected;
  }

  /**
   * Disk-insert event: caller swapped the parser to a new disk.
   *
   * Two regimes:
   *   1. First insert (= prior parser yielded NULL bytes for all
   *      tracks, e.g. NoDiskParser). Shifter accumulated bit-state
   *      from null/0 reads while drive was idle/empty. RESET
   *      bit-stream state so first reads from new disk start clean.
   *      Real-HW analogue: drive was empty (no flux), now sees
   *      fresh GCR stream from new media → read amp settles to
   *      a clean bit pattern.
   *   2. Disk-to-disk swap (= prior parser had real data). Drive
   *      may be mid-protocol (fastloader). PRESERVE bit-stream
   *      state — destroying it breaks in-flight reads.
   *
   * Detection: if previous parser.getRawTrackBytes(18) returned
   * null, treat as first insert.
   */
  notifyMediaChange(newParser: G64Parser): void {
    (this as unknown as { parser: G64Parser }).parser = newParser;
    this.trackCache.clear();
  }

  // -------------------------------------------------------------------------
  // Public state accessors
  // -------------------------------------------------------------------------

  /** Latched data byte (VIA2 PRA = $1C01). */
  get dataByte(): BYTE {
    // VICE rotation_byte_read (rotation.c:1145+): during attach delay,
    // GCR_read forced to 0 regardless of underlying GCR data. Drive ROM
    // sees neutral byte stream while media settles.
    if (this.isInAttachDelay()) return 0;
    return this.dataByteLatch;
  }

  /**
   * SYNC# bit — VIA2 PB bit 7.  Active LOW per VICE
   * rotation_sync_found L1134-1143:
   *   "0x0 is returned when sync is found and 0x80 is returned when no
   *    sync is found" (here normalised to a single bit, 0 or 1).
   * During attach/detach delay, returns no-sync (= 0x80 → bit 1).
   */
  get syncBit(): 0 | 1 {
    if (this.isInAttachDelay()) return 1;
    return this.syncActive ? 0 : 1;
  }

  /** True if currently inside attach/detach settle window. */
  private isInAttachDelay(): boolean {
    if (!this.clockProvider) return false;
    const clk = this.clockProvider();
    if (this.attach_clk !== 0) {
      if (clk - this.attach_clk < DRIVE_ATTACH_DELAY) return true;
      this.attach_clk = 0;  // auto-clear (mirrors VICE rotation.c:1153)
    }
    if (this.detach_clk !== 0) {
      if (clk - this.detach_clk < DRIVE_DETACH_DELAY) return true;
      this.detach_clk = 0;
    }
    if (this.attach_detach_clk !== 0) {
      if (clk - this.attach_detach_clk < DRIVE_ATTACH_DETACH_DELAY) return true;
      this.attach_detach_clk = 0;
    }
    return false;
  }

  /**
   * VICE drive_writeprotect_sense (drive-writeprotect.c:32). Returns
   * 0x10 = WP set (= "no disk" or "attached writable") or 0x0 = WP
   * cleared (= "WP just changed" / attach window).
   *
   * 1541 DOS watches PB4 transitions via `wpsw` + `lwpt` to trigger
   * "new disk inserted" handling (re-read BAM, flush cached headers,
   * reset error flags). Without dynamic transition the drive ROM
   * keeps stale state from prior NoDisk phase.
   *
   * Truth table (VICE):
   *   detach in progress (< DRIVE_DETACH_DELAY)         → 0x0
   *   attach-after-detach (< DRIVE_ATTACH_DETACH_DELAY) → 0x10
   *   attach in progress (< DRIVE_ATTACH_DELAY)         → 0x0
   *   no disk loaded                                    → 0x10
   *   disk loaded + read_only                           → 0x0
   *   disk loaded + writable                            → 0x10
   */
  writeProtectSense(): 0 | 0x10 {
    if (!this.clockProvider) {
      // No clock = unit test / pre-init: treat as no disk = WP set
      return this.parser.getRawTrackBytes(18) === null ? 0x10 : 0x10;
    }
    const clk = this.clockProvider();
    if (this.detach_clk !== 0) {
      if (clk - this.detach_clk < DRIVE_DETACH_DELAY) return 0;
      this.detach_clk = 0;
    }
    if (this.attach_detach_clk !== 0) {
      if (clk - this.attach_detach_clk < DRIVE_ATTACH_DETACH_DELAY) return 0x10;
      this.attach_detach_clk = 0;
    }
    if (this.attach_clk !== 0) {
      if (clk - this.attach_clk < DRIVE_ATTACH_DELAY) return 0;
      this.attach_clk = 0;
    }
    // No transition pending — return based on current disk presence.
    const noDisk = this.parser.getRawTrackBytes(18) === null;
    if (noDisk) return 0x10;
    // Disk loaded — read_only flag would set 0x0 here, but we don't
    // model read-only at shifter level yet (default writable = 0x10).
    return 0x10;
  }

  /** Wire the clock source (= c64Cpu.cycles getter). Called once at
   *  IntegratedSession construction. */
  setClockProvider(p: () => number): void {
    this.clockProvider = p;
  }

  /** Trigger attach delay — called by mountMedia. clk is current cpu cycle.
   *  Pure VICE behavior: set attach_clk, don't touch shifter state.
   *  During delay window, syncBit + dataByte getters return neutral.
   *  After delay, shifter continues from wherever its bit-stream is —
   *  next sync mark in real disk data will re-sync naturally. */
  notifyAttach(clk: number): void {
    if (this.detach_clk !== 0) {
      this.attach_detach_clk = clk;
      this.detach_clk = 0;
    } else {
      this.attach_clk = clk;
    }
  }

  /** Trigger detach delay — called by unmountMedia. */
  notifyDetach(clk: number): void {
    this.detach_clk = clk;
  }

  /** True when SYNC is currently detected (convenience). */
  get isSyncActive(): boolean {
    return this.syncActive;
  }

  /** Internal cursor (test inspection). */
  get cursorBitOffset(): number {
    return this.bitOffset;
  }

  /** Bits accumulated since last byte latch (test inspection). */
  get bitsSinceByte(): number {
    return this.bit_counter;
  }

  /**
   * Spec 412 — per-drive-cycle rotation invocation counter. Mirrors
   * the VICE invariant: `rotation_rotate_disk()` is called exactly
   * once per drive CPU cycle. Smoke
   * `scripts/smoke-412-rotation-per-cycle.mjs` asserts this matches
   * the drive cycle count after 1M cycles.
   *
   * Doc: docs/vice-1541-arch.md §14 invariant 1.
   * VICE: src/drive/rotation.c (rotation_rotate_disk invoked from
   *       drivecpu_rotate macro inside 6510core.c per-cycle loop).
   */
  get tickCount(): number {
    return this.rotationTickCount;
  }

  /**
   * Spec 412 — current VICE-exact wobble PRNG state (xorShift32).
   * Useful for smoke diff-trace alignment vs VICE captures.
   *
   * Doc: docs/vice-1541-arch.md §8.5 + §17 OQ-412-1.
   * VICE: src/drive/rotation.c:290 (RANDOM_nextUInt advance).
   */
  get wobblePrngState(): number {
    return this.wobbleXorShift32 >>> 0;
  }

  // -------------------------------------------------------------------------
  // Configuration setters (driven by VIA2 backend)
  // -------------------------------------------------------------------------

  /** VIA2 PB5/PB6 density bits → speed zone. */
  setDensity(zone: 0 | 1 | 2 | 3): void {
    const z = (zone & 0x03) as 0 | 1 | 2 | 3;
    if (this.densityOverride !== z) {
      this.densityOverride = z;
      this.onDensity?.(z);
    } else {
      this.densityOverride = z;
    }
  }

  /** Clear density override → derive zone from current track. */
  clearDensityOverride(): void {
    if (this.densityOverride !== undefined) {
      this.densityOverride = undefined;
      this.onDensity?.(undefined);
    }
  }

  /** VIA2 PB2 motor gate. Off → rotation freezes. */
  setMotor(on: boolean): void {
    if (this.motorOn !== on) {
      this.motorOn = on;
      this.onMotor?.(on);
    } else {
      this.motorOn = on;
    }
  }

  /**
   * Spec 205-A c9: kernel-installed motor toggle callback. Fires only
   * on actual on→off / off→on transitions, not on every setMotor call.
   */
  public onMotor?: (on: boolean) => void;

  /**
   * Spec 205-A c9: density zone change callback. Fires only on actual
   * zone transitions. `zone` undefined when override cleared (zone
   * derived from track).
   */
  public onDensity?: (zone: 0 | 1 | 2 | 3 | undefined) => void;

  // -------------------------------------------------------------------------
  // Tick — advance N drive cycles
  // -------------------------------------------------------------------------

  /**
   * Advance the shifter by `driveCycles` drive-clock cycles.  Pulls
   * raw GCR bits from the current track at bit-cell rate determined
   * by the active density zone.
   *
   * Mirrors rotation_1541_simple read path L1021-1068 condensed into
   * a per-bit loop (no flux filter, no UE7/UF4 chain — that's the
   * complex 1541_gcr path).
   */
  tick(driveCycles: number): void {
    // Spec 412 / doc §13 step 24 / §14 invariant 1: rotation_rotate_disk
    // runs exactly once per drive CPU cycle. Caller invokes this with
    // driveCycles=1 from the cycle-stepped path (DriveCpuCycled +
    // DriveCpu.executeToClock); the tick counter increments per call
    // regardless of motor state so the spec-412 acceptance smoke can
    // verify the per-cycle invariant.
    if (driveCycles > 0) this.rotationTickCount += driveCycles;
    // VICE rotation.c L1108: motor-off → no rotation.
    if (!this.motorOn || driveCycles <= 0) return;
    // Advance wobble PRNG once per call. VICE rotation.c L290-292
    // xorShift32 (note operator precedence — `^=` after the
    // post-increment shift; we replicate the assignment pattern
    // exactly so the state sequence matches bit-for-bit). Doc §8.5.
    let x = this.wobbleXorShift32 >>> 0;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.wobbleXorShift32 = x;

    // Resync if head moved — we re-bind to the new track and clear
    // the shifter (matches existing TrackBuffer behaviour and is
    // consistent with VICE's per-track buffer pointer reset).
    const track = this.head.currentTrack;
    if (track !== this.latchedTrack) {
      this.bindTrack(track);
    }

    const cyclesPerByte = this.densityOverride !== undefined
      ? cyclesPerByteForZone(this.densityOverride)
      : cyclesPerByteForZone(zoneForTrack(track | 0));

    // Fixed-point: ×8 means we accumulate driveCycles*8 and pull a
    // bit when ≥ cyclesPerByte (drive cycles per 8 bits = drive
    // cycles × 8 per bit ÷ 8 = bit-time × 8).
    this.accumX8 += driveCycles * 8;
    while (this.accumX8 >= cyclesPerByte) {
      this.accumX8 -= cyclesPerByte;
      this.advanceOneBit();
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot / restore (save-state plumbing)
  // -------------------------------------------------------------------------

  snapshot(): GcrShifterSnapshot {
    return {
      bitOffset: this.bitOffset,
      lastReadData: this.last_read_data,
      bitCounter: this.bit_counter,
      accumX8: this.accumX8,
      syncActive: this.syncActive,
      motorOn: this.motorOn,
      densityOverride: this.densityOverride,
      latchedTrack: this.latchedTrack,
      dataByte: this.dataByteLatch,
    };
  }

  restore(snap: GcrShifterSnapshot): void {
    this.bitOffset = snap.bitOffset;
    this.last_read_data = snap.lastReadData & 0x3ff;
    this.bit_counter = snap.bitCounter & 0x07;
    this.accumX8 = snap.accumX8;
    this.syncActive = snap.syncActive;
    this.motorOn = snap.motorOn;
    this.densityOverride = snap.densityOverride;
    this.latchedTrack = snap.latchedTrack;
    this.dataByteLatch = u8(snap.dataByte);
  }

  /**
   * Force-reset to a fresh state on the current track (test helper).
   *
   * Spec 412: re-seed the wobble PRNG to the VICE-exact fixed
   * constant 0x1234abcd (rotation.c:122 `rotation_reset()`). The
   * tick counter is also cleared — matches VICE `rotation_begins()`
   * which resets cycle_index on each rotation re-anchor.
   *
   * Doc: docs/vice-1541-arch.md §8.5 + §17 OQ-412-1.
   * VICE: src/drive/rotation.c:122 `rotation_reset()`.
   */
  reset(): void {
    this.bitOffset = 0;
    this.last_read_data = 0;
    this.bit_counter = 0;
    this.accumX8 = 0;
    if (this.syncActive) {
      this.syncActive = false;
      this.onSyncDetected?.(false);
      this.traceSyncDetected?.(false);
    }
    this.dataByteLatch = 0xff;
    this.latchedTrack = -1;
    this.wobbleXorShift32 = ROTATION_WOBBLE_PRNG_SEED >>> 0;
    this.rotationTickCount = 0;
    // Defer track-rebind to next tick().
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private bindTrack(track: number): void {
    this.latchedTrack = track;
    this.bitOffset = 0;
    // Note: VICE does NOT clear last_read_data on head-step
    // (it's an analogue shift register continuously fed by the
    // read amplifier).  We mirror that — the SYNC pattern can
    // legitimately span an in-progress head step in pathological
    // cases.  bit_counter and accum stay too — drive clock is
    // continuous.
    this.ensureTrackBytes(track);
  }

  private ensureTrackBytes(track: number): Uint8Array | null {
    if (!this.trackCache.has(track)) {
      // Half-track positions (track is non-integer) and out-of-range
      // tracks both yield null → 0-bits stream (matches VICE
      // read_next_bit when GCR_track_start_ptr is NULL).
      const integerTrack = (track === Math.floor(track)) ? track : -1;
      const buf = integerTrack < 1 ? null : this.parser.getRawTrackBytes(integerTrack);
      this.trackCache.set(track, buf);
    }
    return this.trackCache.get(track) ?? null;
  }

  /**
   * Pull one GCR bit from the disk and feed the shifter.
   *
   * Direct port of rotation.c L1033-1067 condensed (the simple path
   * uses MSB-first bit ordering: the byte is shifted left and
   * `byte & 0x80` is the next bit, advancing the head offset by one
   * bit at a time).  10-bit shift register + SYNC detect identical.
   */
  private advanceOneBit(): void {
    const data = this.ensureTrackBytes(this.latchedTrack);
    let bit = 0;
    if (data && data.length > 0) {
      const totalBits = data.length * 8;
      // VICE read_next_bit L256-271: read bit at current offset,
      // then increment.  MSB-first within the byte (bit 7 first).
      const byteIdx = this.bitOffset >>> 3;
      const bitIdxInByte = 7 - (this.bitOffset & 7);
      bit = (data[byteIdx]! >> bitIdxInByte) & 1;
      this.bitOffset = (this.bitOffset + 1) % totalBits;
    } else {
      // No image / unformatted half-track → 0 bits (VICE
      // read_next_bit L264 returns 0 when GCR_track_start_ptr is
      // NULL).
      this.bitOffset = (this.bitOffset + 1) | 0;
    }

    // Feed 10-bit shift register (VICE last_read_data, mask 0x3ff).
    this.last_read_data = ((this.last_read_data << 1) & 0x3fe) | (bit & 1);

    // SYNC detect — VICE rotation.c L1052 condition
    //   if (~last_read_data & 0x1ff80)  → still inside a byte
    //     equivalent for 10-bit window: NOT all-ones means not sync.
    //   else (== 0x3ff) → SYNC: hold bit_counter at 0, no byte latch.
    // Matches gcr.c gcr_find_sync L184-188 exactly.
    const isSync = this.last_read_data === 0x3ff;
    if (isSync) {
      this.bit_counter = 0;
      if (!this.syncActive) {
        this.syncActive = true;
        this.onSyncDetected?.(true);
        this.traceSyncDetected?.(true);
      }
      return;
    }

    // SYNC just dropped — emit edge.
    if (this.syncActive) {
      this.syncActive = false;
      this.onSyncDetected?.(false);
      this.traceSyncDetected?.(false);
    }

    // Non-sync bit: count toward next byte.
    this.bit_counter++;
    if (this.bit_counter === 8) {
      this.bit_counter = 0;
      const byte = u8(this.last_read_data);
      this.dataByteLatch = byte;
      this.onByteReady?.(byte);
      this.traceByteReady?.(byte);
    }
  }
}
