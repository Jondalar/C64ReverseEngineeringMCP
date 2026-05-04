// Drive head positioning + track-buffer model.
//
// The 1541's head moves in half-track increments via VIA2 PB bits 0-1
// (the "STEP" bits). The head-step pattern is a 2-bit gray-code
// sequence:
//   00 → 01 → 11 → 10 → 00  (one direction = inward, towards higher tracks)
//   00 → 10 → 11 → 01 → 00  (other direction = outward, towards lower tracks)
//
// Drive ROM walks this sequence one step per ~5ms to physically move
// the head. Each transition advances the head by half a track. We
// model the same way: keep the previous STEP bits, decode the
// transition, advance/retreat by 0.5.
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

  // Called when VIA2 PB STEP bits change. Decodes the gray-code
  // direction and advances by 0.5 if the step is valid.
  applyStepBits(newBits: number): void {
    const old = this.lastStepBits & 0x3;
    const next = newBits & 0x3;
    if (old === next) {
      this.lastStepBits = next;
      return;
    }
    // Gray-code sequence inward: 00, 01, 11, 10, 00...
    // Gray-code sequence outward: 00, 10, 11, 01, 00...
    const inwardSeq = [0, 1, 3, 2];
    const oldIdx = inwardSeq.indexOf(old);
    const newIdx = inwardSeq.indexOf(next);
    if (oldIdx >= 0 && newIdx >= 0) {
      const diff = (newIdx - oldIdx + 4) % 4;
      if (diff === 1) this.stepInward();
      else if (diff === 3) this.stepOutward();
      // diff = 2 means jumped 2 positions (invalid step, no movement)
    }
    this.lastStepBits = next;
  }

  stepInward(): void {
    if (this.trackHalf < this.maxHalfTracks - 1) this.trackHalf += 1;
  }

  stepOutward(): void {
    if (this.trackHalf > 0) this.trackHalf -= 1;
  }

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
  // We pick by current track. DENSITY-bit override (drive can program
  // zone independently of head position) is a follow-up.
  private static cyclesPerByteForTrack(track: number): number {
    if (track >= 31) return 32;
    if (track >= 25) return 28;
    if (track >= 18) return 26;
    return 24;
  }
  // Sprint 96 part 8: byte-ready signal. Real 1541 hardware pulses
  // VIA2 CA1 when GCR shifter completes a byte; CA1 is wired to the
  // 6502 SO (Set Overflow) pin. Drive ROM polls V flag with BVC/BVS
  // to detect byte-ready (e.g. $F3BE wait loop). Callback fires once
  // per shifter byte advance.
  public onByteReady?: () => void;

  constructor(public readonly source: G64Parser) {}

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
    if (currentTrack !== this.latchedTrack) {
      this.latchedTrack = currentTrack;
      this.bitOffset = 0;
      this.shifter = 0;
      this.bitCounter = 0;
      this.syncActive = false;
      this.bitTimeAccumX8 = 0;
      this.refreshLatch();
    }
    const cyclesPerByte = TrackBuffer.cyclesPerByteForTrack(currentTrack);
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
    const data = this.latchedTrack < 1 ? null : this.ensureTrack(this.latchedTrack);
    if (data && data.length > 0) {
      const totalBits = data.length * 8;
      this.bitOffset = (this.bitOffset + 1) % totalBits;
      const byteIdx = this.bitOffset >>> 3;
      const bitIdxInByte = 7 - (this.bitOffset & 7);
      bit = (data[byteIdx]! >> bitIdxInByte) & 1;
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
