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

// The emulator streams 44.1 kHz. A backend that streams another rate (the C64 Ultimate relay:
// 48,003.07 Hz, Spec 889 §4c) says so in its `audio/start` reply and the page passes it here;
// the default keeps the emulator path exactly as it was.
export const DEFAULT_STREAM_RATE = 44100;
// Spec 706.3 — live latency budget. Prebuffer is the startup headroom that
// rides brief realtime dips (fastloaders); the governor target is the
// steady-state ring fill the worklet trims back toward; margin is the slack
// above target before a trim fires (so steady state never trims). Prebuffer
// sits just above target so playback starts at the governed level without an
// immediate trim. Was 0.25 s flat (banked permanently — Spec 706 §3).
// BUG-049 cushion experiment (2026-06-15): bumped 100→180 ms steady-state to
// ride the sub-50fps dips on visually complex (multicolor) screens where the
// VIC literal-port per-cycle draw cost blows the 20 ms frame budget and the
// daemon under-delivers PCM. +80 ms latency is the trade. Revert to 0.12/0.10
// if the VIC draw hot path is optimized instead.
const PREBUFFER_SEC = 0.20;    // ~200 ms startup headroom (just above target)
const LIVE_TARGET_SEC = 0.18;  // ~180 ms steady-state fill target
const LIVE_MARGIN_SEC = 0.05;  // trim when fill exceeds target + 50 ms

export class WebAudioPlayer {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private setupP: Promise<void> | null = null;
  private gestureArmed = false;
  private onGesture = (): void => { void this.resume(); };

  constructor(private streamRate: number = DEFAULT_STREAM_RATE) {}

  /** The rate of the PCM this player is fed, in Hz. */
  get rate(): number { return this.streamRate; }

  /**
   * The backend streams a different rate than the player was built for. The context and the
   * worklet resample from the stream rate, so a change rebuilds both; PCM pushed meanwhile is
   * stale anyway. A no-op for the same rate.
   */
  async setStreamRate(hz: number): Promise<void> {
    if (!(hz > 0) || hz === this.streamRate) return;
    const wasArmed = this.gestureArmed;
    await this.close();
    this.streamRate = hz;
    if (wasArmed) this.arm();
  }

  private async setup(): Promise<void> {
    if (this.ctx) return;
    const Ctor: typeof AudioContext =
      (window as any).AudioContext ?? (window as any).webkitAudioContext;
    // sampleRate must be a whole number the browser accepts; resampleRatio below carries the fraction.
    const ctx = new Ctor({ sampleRate: Math.round(this.streamRate) });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(workletUrl);
    if (this.ctx !== ctx) return; // closed (rate change) while the module loaded: a newer setup owns the player
    const node = new AudioWorkletNode(ctx, "resid-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        ringFrames: Math.round(this.streamRate), // ~1s hard cap (governor keeps fill far below)
        resampleRatio: this.streamRate / ctx.sampleRate,
        startFrames: Math.round(this.streamRate * PREBUFFER_SEC),
        governorTarget: Math.round(this.streamRate * LIVE_TARGET_SEC),
        governorMargin: Math.round(this.streamRate * LIVE_MARGIN_SEC),
      },
    });
    node.connect(ctx.destination);
    this.node = node;
  }

  /** Create + start the AudioContext/worklet. Must be from a user gesture. */
  async resume(): Promise<void> {
    if (!this.setupP) {
      const p: Promise<void> = this.setup().catch((e) => { if (this.setupP === p) this.setupP = null; throw e; });
      this.setupP = p;
    }
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

  /**
   * Spec 706.8 — drop all buffered (stale-timeline) PCM and re-prebuffer. Call
   * on a RuntimeCheckpoint restore: pre-restore PCM is transport state for the
   * OLD timeline; after restore, audio re-syncs from the restored reSID state.
   */
  flush(): void {
    this.node?.port.postMessage({ type: "flush" });
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
