// Spec 703 §8 — UI WebAudio playback for the live SID stream.
//
// The backend pumps BIN_TYPE_AUDIO_BUFFER frames: interleaved signed-16-bit
// little-endian stereo PCM at 44.1 kHz (mono SID duplicated to L/R). This is a
// small jitter-buffered scheduler: each frame becomes an AudioBuffer played
// back-to-back on a moving play-head, with a short lead so network/timer jitter
// doesn't underrun, and a hard cap so a backgrounded tab can't build a huge
// backlog (latest-wins resync instead).

const STREAM_RATE = 44100; // backend SID stream rate
const LEAD_SEC = 0.08; // target buffered lead (~80ms)
const MAX_BACKLOG_SEC = 1.0; // resync if scheduled this far ahead

export class WebAudioPlayer {
  private ctx: AudioContext | null = null;
  private playHead = 0;

  private gestureArmed = false;
  private onGesture = (): void => { void this.resume(); };

  /** Create/resume the AudioContext. MUST be called from a user gesture. */
  async resume(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        (window as any).AudioContext ?? (window as any).webkitAudioContext;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  /**
   * Arm audio without a user gesture: create the (suspended) context now and
   * resume it on the first interaction anywhere. Lets us default audio ON —
   * frames are dropped (not queued) until the context actually runs, so there
   * is no backlog burst when it finally starts.
   */
  arm(): void {
    void this.resume(); // creates the context; may stay suspended
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

  /** Schedule one s16le interleaved-stereo PCM frame for playback. */
  push(bytes: Uint8Array): void {
    const ctx = this.ctx;
    // Drop frames until the context is actually running (autoplay-gated): no
    // queueing into a frozen clock, so playback starts clean on first gesture.
    if (!ctx || ctx.state !== "running") return;
    const frames = (bytes.byteLength / 4) | 0; // 2ch × 2 bytes
    if (frames === 0) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // AudioBuffer carries its own sampleRate; the device context resamples.
    const buf = ctx.createBuffer(2, frames, STREAM_RATE);
    const l = buf.getChannelData(0);
    const r = buf.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      l[i] = view.getInt16(i * 4, true) / 32768;
      r[i] = view.getInt16(i * 4 + 2, true) / 32768;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    // Underrun (head fell behind) or first frame → re-arm the lead.
    if (this.playHead < now + 0.01) this.playHead = now + LEAD_SEC;
    src.start(this.playHead);
    this.playHead += buf.duration;
    // Overrun guard (tab was backgrounded): drop ahead to the lead window.
    if (this.playHead > now + MAX_BACKLOG_SEC) this.playHead = now + LEAD_SEC;
  }

  async close(): Promise<void> {
    this.disarm();
    try { await this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.playHead = 0;
  }

  get active(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }
}
