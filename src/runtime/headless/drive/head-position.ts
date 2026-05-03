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
export class TrackBuffer {
  // Maps integer track number → raw GCR byte stream for that track.
  // Loaded lazily from the G64 on first access; modified in-place by
  // writes. Tracks the parser saw as empty stay null forever.
  private readonly tracks = new Map<number, Uint8Array | null>();
  private readonly modified = new Set<number>();
  private byteCursor = 0;
  private lastReadByteIsSyncContext = 0;

  constructor(public readonly source: G64Parser) {}

  // Returns the byte at the head's current position within its current
  // track, or 0xFF (idle bus) if the track is empty / unavailable.
  // Advances the byte cursor by 1 for the next read.
  readByte(track: number): number {
    const data = this.ensureTrack(track);
    if (!data || data.length === 0) return 0xff;
    const idx = this.byteCursor % data.length;
    const byte = data[idx]!;
    this.byteCursor = (idx + 1) % data.length;
    // Track sync context: count consecutive 0xFF bytes for the
    // SYNC-mark detector that VIA2 PB bit 7 reports.
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

  // Returns true while the head is currently over a SYNC mark
  // approximation. Real hardware detects 10 consecutive 1-bits at
  // bit-stream level; we approximate at byte-aligned level: ≥3
  // consecutive 0xFF bytes counts as sync. False-positives possible
  // for unusual track patterns; bit-exact detection is a candidate
  // for a follow-up sprint when drive code surfaces a regression.
  syncDetected(): boolean {
    return this.lastReadByteIsSyncContext >= 3;
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
