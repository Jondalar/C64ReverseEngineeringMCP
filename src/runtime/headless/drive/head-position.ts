// Drive head positioning + track-buffer model.
//
// The 1541's head moves in half-track increments via VIA2 PB bits 0-1
// (the "STEP" bits). Doctrine: 1:1 VICE TDE port.
//
// Spec 411 / docs/vice-1541-arch.md §7.3 + §14 invariant 7 + §17
// OQ-411-1: VICE uses **modulo-4 phase counts**, NOT 2-bit Gray code.
// Step IN sequence  00→01→10→11→00 (Δ=+1)
// Step OUT sequence 00→11→10→01→00 (Δ=-1)
// Only Δ = ±1 mod 4 moves; Δ = 0 ignored; Δ = 2 (invalid double-step)
// ignored.
//
// VICE cite — src/drive/iecieee/via2d.c:229-313 (via2d_store, PRB
// branch):
//   track_number          = drv->current_half_track - 2;
//   new_stepper_position  = byte & 3;
//   old_stepper_position  = track_number & 3;
//   step_count            = (new - old) & 3;
//   if (step_count == 3) step_count = -1;
//   if ((byte & 0x4) && (step_count == 1 || step_count == -1))
//       drive_move_head(step_count, drv);
//
// Two critical fidelity points vs the older "lastStepBits delta"
// model:
//   (1) The reference for `old` is the CURRENT physical half-track
//       (mod 4), NOT the last PB byte written. Reset/cold-boot, VSF
//       restore, and any path that mutates `trackHalf` without going
//       through `applyStepBits` (e.g. mountMedia repositioning) stays
//       consistent — the next stepper write computes its delta from
//       wherever the head actually is.
//   (2) Stepping is GATED by motor-on (PB.2). Motor off ⇒ no head
//       motion even on phase change. VICE: `if (byte & 0x4)` around
//       drive_move_head.
//
// On real hardware the head ranges 1..40 (some 1541-II variants
// support 41-42 for double-sided; we cap at 35 default, 40 extended
// per G64 image).
//
// Track buffer: each track held in memory as the raw GCR byte stream
// from the source G64. Writes mutate the buffer in-place. Modified
// tracks list drives session-persist.

import type { G64Parser } from "../../../disk/g64-parser.js";

export interface TrackBufferOptions {
  startTrack?: number;        // default 18 (BAM/directory track — typical drive boot position)
  defaultTrackCount?: number; // default 35; bumped per G64 image
}

export class HeadPosition {
  private trackHalf = 36;     // 18.0 = 36 half-tracks; index 36 = track 18
  private maxHalfTracks = 70; // 35 tracks × 2
  private lastStepBits = 0;

  constructor(opts: TrackBufferOptions = {}) {
    if (opts.startTrack !== undefined) this.trackHalf = Math.round(opts.startTrack * 2);
    if (opts.defaultTrackCount !== undefined) this.maxHalfTracks = opts.defaultTrackCount * 2;
  }

  // Read by code that needs to look up bytes in the current track.
  get currentTrack(): number {
    return this.trackHalf / 2;
  }

  get currentHalfTrack(): number {
    return this.trackHalf;
  }

  setMaxHalfTracks(max: number): void {
    this.maxHalfTracks = max;
  }

  // Called when VIA2 PB STEP bits (PB0/PB1) + MOTOR bit (PB2) change.
  //
  // 1:1 VICE port — `src/drive/iecieee/via2d.c:229-313` `via2d_store()`.
  // Doc: vice-1541-arch.md §7.3 + §14 invariant 7 + §17 OQ-411-1.
  //
  // Algorithm:
  //   old_stepper_position = (current_half_track - 2) & 3   // VICE numbering: track 1.0 = ht 2
  //   new_stepper_position = newBits & 3
  //   step_count           = (new - old) & 3
  //   if (step_count == 3) step_count = -1
  //   if (motor_on && step_count == ±1) move head one half-track
  //
  // `lastStepBits` is retained for VSF snapshot compatibility but is
  // NOT part of the decision — VICE compares to current physical
  // half-track, not the prior PB byte.
  applyStepBits(newBits: number, motorOn: boolean = true): void {
    const next = newBits & 0x3;
    // VICE: track_number = current_half_track - 2; old = track_number & 3.
    // Our trackHalf uses the same numbering (track 1.0 → trackHalf 2),
    // so (trackHalf - 2) & 3 yields the VICE old_stepper_position.
    const old = (this.trackHalf - 2) & 0x3;
    let stepCount = (next - old) & 0x3;
    if (stepCount === 3) stepCount = -1;
    // VICE via2d.c:255 — `if (byte & 0x4)` — stepper only acts when
    // motor on. Phase still latches into lastStepBits regardless.
    if (motorOn) {
      if (stepCount === 1) this.stepInward();
      else if (stepCount === -1) this.stepOutward();
      // stepCount === 0 → no motion. stepCount === 2 → invalid
      // double-step, ignored (per VICE via2d.c:307).
    }
    this.lastStepBits = next;
  }

  stepInward(): void {
    // Real 1541 has mechanical stop at track 35 (= halfTrack 70). G64
    // images may have data on tracks 36-42 for copy protection but the
    // physical drive can't reach those without modification. Cap step
    // at min(maxHalfTracks-1, 70) so HL behaves like real hardware
    // even with extended-track G64 images.
    const cap = Math.min(this.maxHalfTracks - 1, 70);
    if (this.trackHalf < cap) {
      this.trackHalf += 1;
      this.onStep?.("inward", this.trackHalf);
    }
  }

  // Spec 116 (M3.8b): track-zero stop. Real 1541 head physically halts
  // at track 1 (= half-track index 2). Drive ROM bumps the head against
  // this stop while seeking to determine track 1 baseline. Bound here
  // so seek-to-zero loops terminate naturally.
  stepOutward(): void {
    if (this.trackHalf > 2) {
      this.trackHalf -= 1;
      this.onStep?.("outward", this.trackHalf);
    }
  }

  /**
   * Spec 205-A c9: kernel-installed callback fired on every successful
   * head step. `direction` = "inward" (toward higher track) or
   * "outward" (toward lower track). `halfTrack` = post-step
   * half-track index (track*2; ignores the "stuck at edge" case).
   */
  public onStep?: (direction: "inward" | "outward", halfTrack: number) => void;

  reset(track: number = 18): void {
    this.trackHalf = Math.round(track * 2);
    this.lastStepBits = 0;
  }
}

// TrackBuffer wraps a G64 image with mutation support.
//
// Sprint 96 part 7-9 (Bug 39 follow-up): bit-level free-running GCR
// shifter, mirroring VICE rotation_1541_simple (drive/rotation.c).
//
// Real 1541 hardware clocks raw GCR BITS off the spinning disk
// continuously. A 10-bit sliding shift register detects SYNC (10
// consecutive 1-bits). Once SYNC ends, bit_counter starts at 0
// and after 8 non-sync bits the byte is latched + byte-ready
// pulses (CA1 → 6502 SO → V flag).
//
// CRITICAL: byte alignment relative to SYNC is determined at the
// BIT level, not the byte level. Byte-aligned models can't reproduce
// proper header decode alignment and drive ROM rejects every
// header it tries to read.
export class TrackBuffer {
  // Maps integer track number → raw GCR byte stream for that track.
  // Loaded lazily from the G64 on first access; modified in-place by
  // writes. Tracks the parser saw as empty stay null forever.
  private readonly tracks = new Map<number, Uint8Array | null>();
  private readonly modified = new Set<number>();
  private byteCursor = 0;
  private lastReadByteIsSyncContext = 0;
  private latchedByte = 0xff;
  private latchedTrack = -1;
  // Bit-level shifter state (per VICE rotation.c).
  private bitOffset = 0;        // current bit position within track GCR stream
  private shifter = 0;          // 10-bit sliding window of last bits read
  private bitCounter = 0;       // bits since last byte latch (0..7); reset by sync
  private syncActive = false;
  // Fixed-point bit-time accumulator. Unit: drive_cycles × 8.
  // Increments by driveCycles*8 per tick; advance one bit when ≥ cyclesPerByte.
  private bitTimeAccumX8 = 0;
  // Per-zone bit cell × 8 = drive cycles per GCR byte. 1541 speed zones:
  //   zone 0 (tracks 31-35): 4.00 µs/bit → 32 cyc/byte
  //   zone 1 (tracks 25-30): 3.50 µs/bit → 28 cyc/byte
  //   zone 2 (tracks 18-24): 3.25 µs/bit → 26 cyc/byte
  //   zone 3 (tracks  1-17): 3.00 µs/bit → 24 cyc/byte
  static cyclesPerByteForTrack(track: number): number {
    if (track >= 31) return 32;
    if (track >= 25) return 28;
    if (track >= 18) return 26;
    return 24;
  }
  static cyclesPerByteForZone(zone: number): number {
    switch (zone & 0x03) {
      case 0: return 32;
      case 1: return 28;
      case 2: return 26;
      case 3: return 24;
      default: return 26;
    }
  }
  // Spec 113 (M3.5a): VIA2 PB2 (MOTOR) gates the shifter. Motor off →
  // shifter freezes, byte-ready never fires. Default on so existing
  // LOAD paths keep working until drive ROM toggles MOTOR explicitly.
  private motorOn = true;
  setMotorOn(on: boolean): void { this.motorOn = on; }
  // Spec 113 (M3.5b): VIA2 PB5/PB6 (DENSITY) override. When set, drive
  // forces a specific zone independent of head position. Encoded as
  //   undefined: use track-derived zone (default)
  //   0..3:      forced zone
  private densityOverride: number | undefined;
  setDensityOverride(zone: number | undefined): void {
    this.densityOverride = zone === undefined ? undefined : (zone & 0x03);
  }
  // Spec 113 (M3.5c): half-track reads return deterministic garbage
  // ($55 stream — neither $ff sync nor decodable GCR). Real hardware
  // delivers off-track flux; we pick a deterministic byte so tests
  // can pin behavior. Set by `headPosition` via `setHalfTrackMode`.
  private halfTrackMode = false;
  setHalfTrackMode(active: boolean): void { this.halfTrackMode = active; }
  // Sprint 96 part 8: byte-ready signal. Real 1541 hardware pulses
  // VIA2 CA1 when GCR shifter completes a byte; CA1 is wired to the
  // 6502 SO (Set Overflow) pin. Drive ROM polls V flag with BVC/BVS
  // to detect byte-ready (e.g. $F3BE wait loop). Callback fires once
  // per shifter byte advance.
  public onByteReady?: () => void;

  constructor(public readonly source: G64Parser) {}

  /**
   * Disk-insert event: caller swapped to new media. Drop track cache
   * so subsequent reads fetch from the new disk via source.
   */
  notifyMediaChange(newSource: G64Parser): void {
    (this as unknown as { source: G64Parser }).source = newSource;
    this.tracks.clear();
  }

  // CPU-side latched byte read ($1C01 PA). Returns the most recent
  // GCR byte clocked into the shifter for the requested track. Does
  // NOT advance the cursor — that happens in tickShifter().
  readLatchedByte(track: number): number {
    if (track !== this.latchedTrack) {
      // Head moved to new track; resync latch from current cursor.
      this.latchedTrack = track;
      this.refreshLatch();
    }
    return this.latchedByte;
  }

  // Free-running bit-level shifter. Call once per drive cycle from
  // the scheduler with the current physical track under the head.
  tickShifter(driveCycles: number, currentTrack: number): void {
    // Spec 113 M3.5a: motor gating — shifter advances only when motor
    // is on. Off ↔ no bit-counter advance, no byte-ready, no SYNC.
    if (!this.motorOn) return;
    if (currentTrack !== this.latchedTrack) {
      this.latchedTrack = currentTrack;
      this.bitOffset = 0;
      this.shifter = 0;
      this.bitCounter = 0;
      this.syncActive = false;
      this.bitTimeAccumX8 = 0;
      this.refreshLatch();
    }
    // Spec 113 M3.5b: density override beats track-derived zone.
    const cyclesPerByte = this.densityOverride !== undefined
      ? TrackBuffer.cyclesPerByteForZone(this.densityOverride)
      : TrackBuffer.cyclesPerByteForTrack(currentTrack);
    // bitTime = cyclesPerByte / 8 (drive cycles per bit). Use ×8
    // fixed-point so we work with integers.
    this.bitTimeAccumX8 += driveCycles * 8;
    while (this.bitTimeAccumX8 >= cyclesPerByte) {
      this.bitTimeAccumX8 -= cyclesPerByte;
      this.advanceOneBit();
    }
  }

  private advanceOneBit(): void {
    let bit = 0;
    if (this.halfTrackMode) {
      // Spec 113 M3.5c: half-track read returns alternating 0/1
      // garbage bits. Never reaches 10-in-a-row so SYNC stays low,
      // and decoded bytes never form valid GCR — drive ROM retries
      // until head reaches an integer track.
      this.bitOffset = (this.bitOffset + 1) & 0x7fffffff;
      bit = this.bitOffset & 1;
    } else {
      const data = this.latchedTrack < 1 ? null : this.ensureTrack(this.latchedTrack);
      if (data && data.length > 0) {
        const totalBits = data.length * 8;
        this.bitOffset = (this.bitOffset + 1) % totalBits;
        const byteIdx = this.bitOffset >>> 3;
        const bitIdxInByte = 7 - (this.bitOffset & 7);
        bit = (data[byteIdx]! >> bitIdxInByte) & 1;
      }
    }
    this.shifter = ((this.shifter << 1) | bit) & 0x3ff;
    if (this.shifter === 0x3ff) {
      // SYNC: 10 consecutive 1-bits. Hold bit counter, flag sync.
      this.bitCounter = 0;
      this.syncActive = true;
    } else {
      this.syncActive = false;
      this.bitCounter++;
      if (this.bitCounter === 8) {
        this.bitCounter = 0;
        this.latchedByte = this.shifter & 0xff;
        this.onByteReady?.();
      }
    }
  }

  private refreshLatch(): void {
    const data = this.ensureTrack(this.latchedTrack);
    if (!data || data.length === 0) { this.latchedByte = 0xff; return; }
    this.latchedByte = data[(this.bitOffset >>> 3) % data.length]!;
  }

  // Legacy advancing read (kept for tests / callers that pre-date the
  // free-running shifter). Reads byte at cursor and advances by 1.
  readByte(track: number): number {
    const data = this.ensureTrack(track);
    if (!data || data.length === 0) return 0xff;
    const idx = this.byteCursor % data.length;
    const byte = data[idx]!;
    this.byteCursor = (idx + 1) % data.length;
    if (byte === 0xff) this.lastReadByteIsSyncContext++;
    else this.lastReadByteIsSyncContext = 0;
    return byte;
  }

  writeByte(track: number, value: number): void {
    const data = this.ensureTrack(track);
    if (!data || data.length === 0) return;
    const idx = this.byteCursor % data.length;
    data[idx] = value & 0xff;
    this.byteCursor = (idx + 1) % data.length;
    this.modified.add(track);
  }

  // SYNC detection mirrors VICE: shift register == $3FF (10 ones).
  // Maintained per bit advance in advanceOneBit().
  syncDetected(): boolean {
    return this.syncActive;
  }

  resetByteCursor(): void {
    this.byteCursor = 0;
    this.lastReadByteIsSyncContext = 0;
  }

  isModified(): boolean {
    return this.modified.size > 0;
  }

  modifiedTracks(): Map<number, Uint8Array> {
    const out = new Map<number, Uint8Array>();
    for (const t of this.modified) {
      const buf = this.tracks.get(t);
      if (buf) out.set(t, buf);
    }
    return out;
  }

  private ensureTrack(track: number): Uint8Array | null {
    if (!this.tracks.has(track)) {
      this.tracks.set(track, this.source.getRawTrackBytes(track));
    }
    return this.tracks.get(track) ?? null;
  }
}
