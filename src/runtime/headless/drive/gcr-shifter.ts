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
// Density / speed-zone tables.
//
// VICE rotation.c L88-90:
//   static const unsigned int rot_speed_bps[2][4] = {
//       { 250000, 266667, 285714, 307692 },
//       { 125000, 133333, 142857, 153846 } };
//
// At 1MHz drive clock the per-bit cycle counts are
//   zone 0:   4.000 µs/bit   → 32 drive cycles per GCR byte
//   zone 1:   3.750 µs/bit   → 30
//   zone 2:   3.500 µs/bit   → 28
//   zone 3:   3.250 µs/bit   → 26
// The hardware mapping (VIA2 PB5/PB6) is: zone 0 = outer (slowest,
// tracks 31-35); zone 3 = inner (fastest, tracks 1-17).
//
// We work in fixed-point ×8 (drive cycles × 8 ≡ bit-time × 64) so all
// arithmetic stays integer.  CYCLES_PER_BYTE_BY_ZONE = drive cycles
// per 8 bits = drive cycles × 8 / 8.  We accumulate driveCycles*8
// per tick and pull one bit each time the accumulator reaches the
// (cyclesPerByte) threshold — i.e. one bit per (cyclesPerByte / 8)
// drive cycles.
// ---------------------------------------------------------------------------

export const CYCLES_PER_BYTE_BY_ZONE: ReadonlyArray<number> = [32, 30, 28, 26];

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

  // Track currently bound to the shifter; flushed when head moves.
  private latchedTrack = -1;

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
   * Real-HW analogue: door switch closed + media inserted. Drive's
   * read amplifier sees fresh GCR stream from new media. Internal
   * caches + bit-stream state must drop to track the new disk.
   * Position (= head over current track) is preserved (= drive head
   * doesn't move when media is inserted).
   */
  notifyMediaChange(newParser: G64Parser): void {
    (this as unknown as { parser: G64Parser }).parser = newParser;
    this.trackCache.clear();
    // Re-bind current track so next ensureTrackBytes pulls from new media
    this.latchedTrack = -1;
    // Reset shifter bit-stream state (= equivalent to read amp seeing
    // fresh media; old in-flight bits invalidated)
    this.last_read_data = 0;
    this.bitOffset = 0;
    this.dataByteLatch = 0xff;
  }

  // -------------------------------------------------------------------------
  // Public state accessors
  // -------------------------------------------------------------------------

  /** Latched data byte (VIA2 PRA = $1C01). */
  get dataByte(): BYTE {
    return this.dataByteLatch;
  }

  /**
   * SYNC# bit — VIA2 PB bit 7.  Active LOW per VICE
   * rotation_sync_found L1134-1143:
   *   "0x0 is returned when sync is found and 0x80 is returned when no
   *    sync is found" (here normalised to a single bit, 0 or 1).
   */
  get syncBit(): 0 | 1 {
    return this.syncActive ? 0 : 1;
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
    // VICE rotation.c L1108: motor-off → no rotation.
    if (!this.motorOn || driveCycles <= 0) return;

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

  /** Force-reset to a fresh state on the current track (test helper). */
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
