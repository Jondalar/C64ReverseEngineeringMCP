// Spec 703 §8 — SID audio playback AudioWorklet.
//
// Glitch-free playback: a ring buffer fed by WS PCM frames (posted from the
// main thread), drained continuously in process() at the audio render rate.
// This replaces chaining many short AudioBufferSourceNodes, whose back-to-back
// scheduling left tiny gaps/overlaps at buffer boundaries (audible stutter).
// On underrun the worklet outputs smooth silence and re-buffers, instead of
// clicking.
//
// Input PCM: signed 16-bit interleaved stereo at the stream rate (44.1 kHz),
// posted as an Int16Array (transferred). If the context runs at a different
// rate, a nearest-neighbour resample ratio decimates/repeats on read.

class ResidPlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.cap = o.ringFrames || 44100; // ring capacity in stereo frames (~1s)
    this.l = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.read = 0;
    this.write = 0;
    this.avail = 0; // frames currently buffered
    this.ratio = o.resampleRatio || 1; // stream-rate / context-rate
    this.frac = 0;
    this.started = false;
    this.startFill = o.startFrames || 2048; // prebuffer before first playback
    // Spec 706.3 (Fix B) — latency governor. Steady-state fill target + the
    // slack tolerated above it before trimming. The backend re-renders reSID
    // fresh, so banked audio ahead of `target` is STALE: dropping it (advancing
    // `read`) keeps playback current with video/input, like the video path's
    // "latest frame wins". 0 = governor off (back-compat).
    this.governorTarget = o.governorTarget || 0; // frames
    this.governorMargin = o.governorMargin || 0; // frames of slack above target
    // Spec 706.8 (restore re-sync) — bump this `epoch` from the page on a
    // RuntimeCheckpoint restore to drop all pre-restore (stale-timeline) PCM and
    // re-prebuffer from the restored reSID synthesis state.
    this.epoch = 0;
    // Report the ring fill level back to the page periodically so the backend
    // can slave emulation pace to this audio clock (Spec 703 §8 audio-master).
    this.reportEvery = o.reportEveryBlocks || 32; // ~93ms at 128-frame blocks
    this.blockCount = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      // Spec 706.8 control: {type:"flush"} drops the entire ring and re-arms the
      // prebuffer (new stream epoch after a RuntimeCheckpoint restore).
      if (d && d.type === "flush") { this.flush(); return; }
      this.enqueue(d);
    };
  }

  // Spec 706.8 — discard all buffered (stale-timeline) PCM and re-prebuffer.
  flush() {
    this.read = 0; this.write = 0; this.avail = 0; this.frac = 0;
    this.started = false;
    this.epoch++;
  }

  enqueue(i16) {
    // i16 = Int16Array, interleaved L,R,L,R...
    const n = i16.length >> 1;
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      const w = (this.write + i) % this.cap;
      this.l[w] = i16[i * 2] / 32768;
      this.r[w] = i16[i * 2 + 1] / 32768;
    }
    this.write = (this.write + n) % this.cap;
    this.avail += n;
    if (this.avail > this.cap) {
      // Overflow: drop oldest to keep latency bounded.
      const drop = this.avail - this.cap;
      this.read = (this.read + drop) % this.cap;
      this.avail = this.cap;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const frames = L.length;

    if (!this.started) {
      if (this.avail >= this.startFill) this.started = true;
      else { L.fill(0); R.fill(0); return true; }
    }

    // Spec 706.3 (Fix B) — latency governor: if the ring has banked more than
    // target + margin, fast-forward `read` to trim back to `target`. The dropped
    // frames are STALE (reSID is re-rendered fresh on the backend), so this
    // trades a single tiny skip for staying current — the same trade the video
    // path makes by dropping frames. Steady state stays under target+margin so
    // this never fires; it only re-syncs after a transient backend lead.
    if (this.governorTarget > 0 && this.avail > this.governorTarget + this.governorMargin) {
      const drop = this.avail - this.governorTarget;
      this.read = (this.read + drop) % this.cap;
      this.avail = this.governorTarget;
    }

    for (let i = 0; i < frames; i++) {
      if (this.avail <= 0) {
        // Transient underrun (the backend briefly dips below realtime during a
        // CPU-heavy fastloader): emit silence for the missing samples and keep
        // playing the instant data arrives. Do NOT fully re-buffer — that turns
        // a few-sample gap into a startFill-sized silence (audible ruckeln).
        L[i] = 0; R[i] = 0;
        continue;
      }
      L[i] = this.l[this.read];
      R[i] = this.r[this.read];
      this.frac += this.ratio;
      const step = this.frac | 0;
      if (step > 0) {
        this.frac -= step;
        this.read = (this.read + step) % this.cap;
        this.avail -= step;
      }
    }

    if (++this.blockCount >= this.reportEvery) {
      this.blockCount = 0;
      this.port.postMessage({ type: "level", frames: this.avail });
    }
    return true;
  }
}

registerProcessor("resid-playback", ResidPlaybackProcessor);
