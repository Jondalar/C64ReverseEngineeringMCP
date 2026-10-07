// Spec 889 §4c — audio datagrams into continuous PCM. Ported from AudioTimeline in
// 1541ultimate/tests/e2e/lib/streams.py, with its classification kept: the 16-bit sequence is
// the only clock; in order = written; a duplicate or a packet a few places late is dropped
// without moving the timeline (concealment already covered its slot); a forward gap is
// concealed with a decaying fill that ramps into the next real packet; a gap or a backward
// jump too large to be loss re-anchors instead of being bridged.
//
// The one number that differs: the reference writes FILES and caps a fill at 2500 packets
// (~10 s) because a file absorbs a long fade better than a lost sync. A LIVE relay is the
// opposite case: ten seconds of fading tail played into the browser is worse than the
// discontinuity a re-anchor causes. LIVE_FILL_CAP_PACKETS is 12 packets = 12 * 192 frames /
// 48,003.07 Hz = 48 ms: two or three video frames of dropped bursts get bridged, anything
// longer re-anchors (no fill; the player's own underrun handling covers the hole).

import { AUDIO_FRAMES_PER_PACKET, AUDIO_FRAME_BYTES, AUDIO_HEADER_BYTES, AUDIO_PACKET_BYTES } from "./wire.js";

export const LATE_REORDER_WINDOW_PACKETS = 16;
export const LIVE_FILL_CAP_PACKETS = 12;
export const RAMP_IN_FRAMES = 32;

const clamp16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));

function fadeChannel(last: number, next: number, n: number): number[] {
  if (n <= 0) return [];
  if (n <= RAMP_IN_FRAMES) return Array.from({ length: n }, (_, i) => clamp16(last + (next - last) * (i + 1) / (n + 1)));
  const fadeLen = n - RAMP_IN_FRAMES;
  const fade = Array.from({ length: fadeLen }, (_, i) => clamp16(last * (fadeLen - i) / fadeLen));
  const ramp = Array.from({ length: RAMP_IN_FRAMES }, (_, j) => clamp16(next * (j + 1) / RAMP_IN_FRAMES));
  return fade.concat(ramp);
}

function fadeToSilence(last: number, n: number): number[] {
  if (n <= 0) return [];
  return Array.from({ length: n }, (_, i) => clamp16(last * (n - i) / n));
}

function interleave(left: number[], right: number[]): Buffer {
  const out = Buffer.alloc(left.length * AUDIO_FRAME_BYTES);
  for (let i = 0; i < left.length; i++) {
    out.writeInt16LE(left[i]!, i * 4);
    out.writeInt16LE(right[i]!, i * 4 + 2);
  }
  return out;
}

const signedDelta = (seq: number, last: number): number => {
  let d = (seq - last) & 0xffff;
  if (d >= 0x8000) d -= 0x10000;
  return d;
};

export interface Written {
  /** s16le interleaved stereo, ready to play; empty for a discarded late/duplicate/malformed packet. */
  readonly pcm: Buffer;
  /** How many packets' worth of `pcm` was synthesised rather than received. */
  readonly concealedPackets: number;
}

export type AudioCounts = Record<
  "packets" | "packets_written" | "packets_lost" | "packets_concealed" | "late_dropped" | "duplicates" |
  "resyncs" | "malformed" | "stream_discontinuities", number
>;

const EMPTY: Written = { pcm: Buffer.alloc(0), concealedPackets: 0 };

export class AudioTimeline {
  private anchored = false;
  private lastSeq = 0;
  private hasSamples = false;
  private lastL = 0;
  private lastR = 0;
  private cnt: AudioCounts = {
    packets: 0, packets_written: 0, packets_lost: 0, packets_concealed: 0, late_dropped: 0, duplicates: 0,
    resyncs: 0, malformed: 0, stream_discontinuities: 0,
  };
  readonly discontinuities: Record<string, number> = {};

  constructor(private readonly fillCapPackets: number = LIVE_FILL_CAP_PACKETS) {}

  push(data: Uint8Array): Written {
    this.cnt.packets++;
    if (data.length !== AUDIO_PACKET_BYTES) { this.cnt.malformed++; return EMPTY; }
    const seq = data[0]! | (data[1]! << 8);
    const payload = Buffer.from(data.subarray(AUDIO_HEADER_BYTES));

    if (!this.anchored) { this.anchor(seq, payload); this.cnt.packets_written++; return { pcm: payload, concealedPackets: 0 }; }

    const delta = signedDelta(seq, this.lastSeq);
    if (delta === 1) {
      this.lastSeq = seq; this.updateLast(payload); this.cnt.packets_written++;
      return { pcm: payload, concealedPackets: 0 };
    }
    if (delta <= 0) {
      if (-delta <= LATE_REORDER_WINDOW_PACKETS) {
        if (delta === 0) this.cnt.duplicates++; else this.cnt.late_dropped++;
        return EMPTY;
      }
      this.cnt.resyncs++; this.anchor(seq, payload); this.cnt.packets_written++;
      return { pcm: payload, concealedPackets: 0 };
    }
    if (delta <= this.fillCapPackets) {
      const gap = delta - 1;
      const fill = this.makeFill(gap, payload);
      this.lastSeq = seq; this.updateLast(payload);
      this.cnt.packets_written++; this.cnt.packets_lost += gap; this.cnt.packets_concealed += gap;
      return { pcm: Buffer.concat([fill, payload]), concealedPackets: gap };
    }
    this.cnt.resyncs++; this.anchor(seq, payload); this.cnt.packets_written++;
    return { pcm: payload, concealedPackets: 0 };
  }

  /** The stream's continuity ended: the next packet starts a new timeline, no fill for the gap. */
  reanchor(reason: string): void {
    this.anchored = false;
    this.cnt.stream_discontinuities++;
    this.discontinuities[reason] = (this.discontinuities[reason] ?? 0) + 1;
  }

  get hasAnchor(): boolean { return this.anchored; }
  counts(): AudioCounts { return { ...this.cnt }; }

  private anchor(seq: number, payload: Buffer): void { this.lastSeq = seq; this.anchored = true; this.updateLast(payload); }

  private updateLast(payload: Buffer): void {
    this.lastL = payload.readInt16LE(payload.length - 4);
    this.lastR = payload.readInt16LE(payload.length - 2);
    this.hasSamples = true;
  }

  private makeFill(gapPackets: number, next: Buffer): Buffer {
    const n = gapPackets * AUDIO_FRAMES_PER_PACKET;
    const l = this.hasSamples ? this.lastL : 0;
    const r = this.hasSamples ? this.lastR : 0;
    return interleave(fadeChannel(l, next.readInt16LE(0), n), fadeChannel(r, next.readInt16LE(2), n));
  }
}
