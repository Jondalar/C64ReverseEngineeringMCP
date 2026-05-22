// Spec 703 §8 — UI WebAudio playback for the live SID stream.
//
// The backend renders reSID PCM in its per-frame loop (the same cadence that
// makes video smooth) and streams BIN_TYPE_AUDIO_BUFFER: interleaved s16le
// stereo at 44.1 kHz. Playback is an AudioWorklet ring (resid-worklet.js) that
// drains continuously at the audio render rate — no per-chunk source nodes
// (those gapped at every boundary), no worker, no feedback loop. A generous
// prebuffer absorbs frame-delivery jitter; on underrun the worklet emits smooth
// silence and re-buffers instead of clicking.

import workletUrl from "./resid-worklet.js?url";

const STREAM_RATE = 44100;
const PREBUFFER_SEC = 0.25; // headroom to ride brief realtime dips (fastloaders)

export class WebAudioPlayer {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private setupP: Promise<void> | null = null;
  private gestureArmed = false;
  private onGesture = (): void => { void this.resume(); };

  private async setup(): Promise<void> {
    if (this.ctx) return;
    const Ctor: typeof AudioContext =
      (window as any).AudioContext ?? (window as any).webkitAudioContext;
    const ctx = new Ctor({ sampleRate: STREAM_RATE });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, "resid-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        ringFrames: STREAM_RATE, // ~1s
        resampleRatio: STREAM_RATE / ctx.sampleRate,
        startFrames: Math.round(STREAM_RATE * PREBUFFER_SEC),
      },
    });
    node.connect(ctx.destination);
    this.node = node;
  }

  /** Create + start the AudioContext/worklet. Must be from a user gesture. */
  async resume(): Promise<void> {
    if (!this.setupP) this.setupP = this.setup().catch((e) => { this.setupP = null; throw e; });
    await this.setupP;
    if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume();
  }

  /** Arm without a gesture: build a suspended context, resume on first input. */
  arm(): void {
    void this.resume().catch(() => { /* resumes on gesture */ });
    if (this.gestureArmed) return;
    this.gestureArmed = true;
    for (const ev of ["pointerdown", "keydown", "touchstart"] as const) {
      window.addEventListener(ev, this.onGesture, { passive: true });
    }
  }

  private disarm(): void {
    if (!this.gestureArmed) return;
    this.gestureArmed = false;
    for (const ev of ["pointerdown", "keydown", "touchstart"] as const) {
      window.removeEventListener(ev, this.onGesture);
    }
  }

  /** Feed one s16le interleaved-stereo PCM frame into the worklet ring. */
  push(bytes: Uint8Array): void {
    const node = this.node;
    if (!node || !this.ctx || this.ctx.state !== "running") return;
    if (bytes.byteLength < 4) return;
    const copy = bytes.slice(0, bytes.byteLength & ~1);
    const i16 = new Int16Array(copy.buffer); // s16le; browsers are little-endian
    node.port.postMessage(i16, [copy.buffer]);
  }

  async close(): Promise<void> {
    this.disarm();
    try { this.node?.disconnect(); } catch { /* ignore */ }
    this.node = null;
    try { await this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.setupP = null;
  }

  get active(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }
}
