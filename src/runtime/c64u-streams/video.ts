// Spec 889 §4c — video datagrams into frames. Ported from FrameAssembler in
// 1541ultimate/tests/e2e/lib/streams.py with its loss / re-anchor accounting, and changed in
// ONE way the live relay needs: a frame is handed out when it is complete OR when the next
// frame starts (then with its gaps filled), so a lost packet never holds the picture back.
//
// What differs from the reference, and why:
//  - The reference keeps two frames in progress and drops an unfinished one only when a third
//    arrives, and never hands out a partial frame. Here, the first packet of a NEWER frame
//    hands out every older unfinished frame (complete:false). A packet of an already-handed-out
//    frame is counted `packets_late` and dropped: with a direct device link reordering across a
//    frame boundary is rare and loss is the real case.
//  - `frames_lost` counts frame numbers never seen at all; a partial frame is
//    `frames_incomplete`, not lost (the reference's completed-only baseline counted it as both).
//  - A backward jump larger than LATE_FRAME_WINDOW is a device restart (counter reset), not
//    "reordering" forever.

import {
  VIDEO_HEIGHT_60HZ, VIDEO_HEIGHT_PAL, VIDEO_LINES_PER_PACKET, VIDEO_PACKET_BYTES, VIDEO_WIDTH,
  VIDEO_HEADER_BYTES, parseVideoHeader, unpackNibbles, wrappedGap,
} from "./wire.js";

export const DEVICE_RESTART = "device-restart";

const FRAMES_PER_SECOND = 50;
const PACKETS_PER_PAL_FRAME = VIDEO_HEIGHT_PAL / VIDEO_LINES_PER_PACKET;
/** A forward gap beyond 2 s of stream cannot be network loss (restart / stream stopped / receiver away). */
export const MAX_PLAUSIBLE_FRAME_GAP = 2 * FRAMES_PER_SECOND;
export const MAX_PLAUSIBLE_PACKET_GAP = MAX_PLAUSIBLE_FRAME_GAP * PACKETS_PER_PAL_FRAME;
/** How far behind the newest frame number a packet may be and still count as a late straggler. */
export const LATE_FRAME_WINDOW = 8;

export interface Frame {
  readonly number: number;
  readonly width: number;
  readonly height: number;
  /** One VIC colour index (0-15) per byte, width*height. */
  readonly indices: Uint8Array;
  /** Every packet of the frame arrived. False: lines of a missing packet are filled (see `missingPackets`). */
  readonly complete: boolean;
  readonly missingPackets: number;
}

class FrameBuilder {
  readonly indices = new Uint8Array(VIDEO_HEIGHT_PAL * VIDEO_WIDTH);
  readonly lines = new Set<number>();
  height: number | null = null;
  maxLine = 0;
  constructor(readonly number: number) {}

  add(line: number, last: boolean, packed: Uint8Array): void {
    unpackNibbles(packed, this.indices, line * VIDEO_WIDTH);
    this.lines.add(line);
    if (line > this.maxLine) this.maxLine = line;
    if (last) this.height = Math.min(Math.max(line + VIDEO_LINES_PER_PACKET, VIDEO_HEIGHT_60HZ), VIDEO_HEIGHT_PAL);
  }

  isComplete(): boolean {
    if (this.height === null) return false;
    for (let l = 0; l < this.height; l += VIDEO_LINES_PER_PACKET) if (!this.lines.has(l)) return false;
    return true;
  }
}

export type VideoCounts = Record<
  "packets" | "packets_malformed" | "packets_dropped" | "packets_late" | "frames_completed" |
  "frames_incomplete" | "frames_lost" | "stream_discontinuities", number
>;

export class FrameAssembler {
  private lastSeq: number | null = null;
  private newest: number | null = null;
  private lastEmitted: number | null = null;
  private lastFrame: Frame | null = null;
  private builders = new Map<number, FrameBuilder>();
  private cnt: VideoCounts = {
    packets: 0, packets_malformed: 0, packets_dropped: 0, packets_late: 0, frames_completed: 0,
    frames_incomplete: 0, frames_lost: 0, stream_discontinuities: 0,
  };
  readonly discontinuities: Record<string, number> = {};

  /** Take one datagram, in arrival order. Returns the frames it handed out (usually 0 or 1). */
  push(data: Uint8Array): Frame[] {
    this.cnt.packets++;
    const h = parseVideoHeader(data);
    if (!h) { this.cnt.packets_malformed++; return []; }
    this.accountSeq(h.seq);

    const out: Frame[] = [];
    let b = this.builders.get(h.frame);
    if (!b) {
      if (this.newest !== null) {
        const gap = wrappedGap(h.frame, this.newest);
        if (gap > MAX_PLAUSIBLE_FRAME_GAP || gap < -LATE_FRAME_WINDOW) {
          this.reanchor(DEVICE_RESTART);
        } else if (gap <= 0) {
          this.cnt.packets_late++;
          return out;
        }
      }
      // The next frame has started: hand out every older unfinished one, gaps filled.
      for (const old of [...this.builders.values()]) out.push(this.emit(old, false));
      b = new FrameBuilder(h.frame);
      this.builders.set(h.frame, b);
      this.newest = h.frame;
    }
    b.add(h.line, h.last, data.subarray(VIDEO_HEADER_BYTES, VIDEO_PACKET_BYTES));
    if (b.isComplete()) out.push(this.emit(b, true));
    return out;
  }

  /** The stream's continuity ended (stopped, restarted, re-armed): drop partial frames, restart the counters. */
  reanchor(reason: string): void {
    this.cnt.frames_incomplete += this.builders.size;
    this.builders.clear();
    this.lastSeq = null;
    this.newest = null;
    this.lastEmitted = null;
    this.cnt.stream_discontinuities++;
    this.discontinuities[reason] = (this.discontinuities[reason] ?? 0) + 1;
  }

  counts(): VideoCounts { return { ...this.cnt }; }
  /** Frames still being assembled (their last packet not yet in). */
  get inProgress(): number { return this.builders.size; }

  private emit(b: FrameBuilder, complete: boolean): Frame {
    this.builders.delete(b.number);
    const height = b.height ?? this.lastFrame?.height ?? (b.maxLine + VIDEO_LINES_PER_PACKET > VIDEO_HEIGHT_60HZ ? VIDEO_HEIGHT_PAL : VIDEO_HEIGHT_60HZ);
    const indices = b.indices.slice(0, height * VIDEO_WIDTH);
    let missing = 0;
    const prev = this.lastFrame && this.lastFrame.height === height ? this.lastFrame.indices : null;
    for (let l = 0; l < height; l += VIDEO_LINES_PER_PACKET) {
      if (b.lines.has(l)) continue;
      missing++;
      // A line nobody sent shows what it last showed, not a black bar.
      if (prev) indices.set(prev.subarray(l * VIDEO_WIDTH, (l + VIDEO_LINES_PER_PACKET) * VIDEO_WIDTH), l * VIDEO_WIDTH);
    }
    const frame: Frame = { number: b.number, width: VIDEO_WIDTH, height, indices, complete: complete && missing === 0, missingPackets: missing };
    if (frame.complete) this.cnt.frames_completed++; else this.cnt.frames_incomplete++;
    if (this.lastEmitted !== null) {
      const gap = wrappedGap(b.number, this.lastEmitted);
      if (gap > 1) this.cnt.frames_lost += gap - 1;
    }
    this.lastEmitted = b.number;
    this.lastFrame = frame;
    return frame;
  }

  private accountSeq(seq: number): void {
    if (this.lastSeq !== null) {
      const gap = wrappedGap(seq, this.lastSeq);
      if (gap > MAX_PLAUSIBLE_PACKET_GAP) { this.reanchor(DEVICE_RESTART); this.lastSeq = seq; return; }
      if (gap > 1) this.cnt.packets_dropped += gap - 1;
      if (gap <= 0) return; // behind the newest: never moves the baseline back
    }
    this.lastSeq = seq;
  }
}
