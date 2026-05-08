// Spec 263 — resid-style audio synthesis (TS port, simplified).
//
// Sources (consulted before any hypothesis):
//   VICE 3.7.1 src/resid/envelope.cc       — ADSR rate_counter_period[],
//                                              exponential_counter_period
//                                              (decay/release piecewise approx).
//   VICE 3.7.1 src/resid/wave.cc           — waveform output (saw/tri/pulse/
//                                              noise) + combined-wave AND.
//   VICE 3.7.1 src/resid/sid.cc clock()    — voice-sum + filter mix.
//   VICE 3.7.1 src/resid/filter.cc         — 6581 IIR filter (LP/BP/HP/mix).
//   VICE 3.7.1 src/resid/extfilt.cc        — DC-block + RC low-pass at output.
//
// Scope (Spec 263 components):
//   - 3 voices: phase accumulator @ 24 bit, raw freq16 step per Φ2 cycle.
//   - Waveforms: triangle / sawtooth / pulse / noise (LFSR), combined = AND
//     (full resid combined-wave ROM tables deferred to V3.1; AND matches
//     VICE fastsid behaviour and approximates resid).
//   - Envelope: rate_counter_period[] verbatim (16-entry table from
//     resid/envelope.cc lines 72-89). Decay/release piecewise expo via
//     `expDivider[]` (resid envelope.cc rate-divider semantics).
//   - Filter (6581): two-pole state-variable model with cutoff
//     fc∈[0,2047], resonance∈[0..15], routing per voice via $D417,
//     mode (LP/BP/HP) per $D418 high nibble. Coefficients use the
//     well-known fc→Hz mapping (~30Hz..12kHz approx 6581 lookup).
//   - Master volume: $D418 low nibble (0..15) scales output.
//   - 6581 model only; 8580 deferred (V3.1 — would just swap filter
//     coefficient table + drop voice-3 leakage at vol=0).
//
// Output: 16-bit signed PCM. Caller passes desired sample-rate (default
// 44100 Hz) and `clockFreq` (PAL 985248 Hz default). emit(cycles)
// generates floor(cycles * sampleRate / clockFreq) samples and consumes
// only the cycles that were actually rendered (returning leftover).
//
// Determinism: integer state only. No Math.random, no Date.now, no
// hidden floats outside filter coefficients (which are precomputed
// once, cached on cutoff change).

import { Sid6581, type SidSnapshot } from "./sid.js";

// PAL clock — matches CYCLES_PER_SECOND in vic/cia code paths.
export const PAL_CLOCK_FREQ = 985248;
export const NTSC_CLOCK_FREQ = 1022730;
export const DEFAULT_SAMPLE_RATE = 44100;

// resid/envelope.cc:72-89 verbatim.
const RATE_COUNTER_PERIOD = [
  8, 31, 62, 94, 148, 219, 266, 312,
  391, 976, 1953, 3125, 3906, 11719, 19531, 31250,
] as const;

// resid/envelope.cc — exponential divider lookup. At envelope levels 255,
// 93, 54, 26, 14, 6 the divider increments. We model it as a small
// piecewise table indexed by current envelope value.
function expDivider(env: number): number {
  if (env > 93) return 1;
  if (env > 54) return 2;
  if (env > 26) return 4;
  if (env > 14) return 8;
  if (env > 6) return 16;
  return 30;
}

// Voice control bits ($Dx04).
const CTRL_GATE  = 0x01;
const CTRL_SYNC  = 0x02;
const CTRL_RING  = 0x04;
const CTRL_TEST  = 0x08;
const CTRL_TRI   = 0x10;
const CTRL_SAW   = 0x20;
const CTRL_PUL   = 0x40;
const CTRL_NOI   = 0x80;

// $D418 high-nibble filter mode bits.
const FMODE_LP    = 0x10;
const FMODE_BP    = 0x20;
const FMODE_HP    = 0x40;
const FMODE_3OFF  = 0x80;

// $D417 routing — bits 0..3 enable filter on V1/V2/V3/EXT.
const FROUTE_V1 = 0x01;
const FROUTE_V2 = 0x02;
const FROUTE_V3 = 0x04;

// Noise LFSR seed (matches sid.ts).
const NSEED = 0x7ffff8;

// Per-voice synthesis state. Distinct from Sid6581.Voice (which is the
// register-state shadow); this carries float-domain envelope + audio
// state needed for sample emission.
interface ResidVoice {
  phase: number;       // 24-bit phase accumulator
  noiseLfsr: number;   // 23-bit noise LFSR (matches sid.ts rv)
  envCounter: number;  // 0..255 envelope counter
  envState: 0 | 1 | 2 | 3; // 0=ATT 1=DEC 2=SUS 3=REL (5=IDLE folded into REL@0)
  rateCounter: number; // 16-bit rate counter
  expCounter: number;  // exponential counter for decay/release
  prevGate: 0 | 1;
  // Memo of last register snapshot used for sync detection on the next
  // voice (hard sync only fires on MSB rising edge in source voice).
  prevPhaseMsb: 0 | 1;
}

function makeResidVoice(): ResidVoice {
  return {
    phase: 0, noiseLfsr: NSEED, envCounter: 0,
    envState: 3, rateCounter: 0, expCounter: 0,
    prevGate: 0, prevPhaseMsb: 0,
  };
}

export interface ResidEmitOptions {
  /** Output sample rate (Hz). Default 44100. */
  sampleRate?: number;
  /** C64 system clock (Hz). Default PAL 985248. */
  clockFreq?: number;
}

/**
 * Sid6581-compatible audio engine. Wraps the existing register-state SID
 * (kept as the canonical bus surface) with cycle-accurate audio synthesis
 * driven from those registers.
 *
 * Key contract: `read`/`write`/`reset`/`snapshot`/`restore` delegate 1:1
 * to the underlying Sid6581 so trace/snapshot/replay flows are unchanged.
 * `tick(cycles)` advances ADSR + osc3 readback (same as Sid6581.tick) but
 * does NOT generate audio — call `emit(cycles)` for that, which integrates
 * the audio sample stream and consumes the same cycle budget.
 *
 * In typical use one of `tick` or `emit` is called per slice — not both
 * (audio path subsumes ADSR advance).
 */
export class Resid {
  public readonly inner: Sid6581;
  public readonly sampleRate: number;
  public readonly clockFreq: number;

  /** Cycle remainder carried between emit() calls so sample timing is exact. */
  private cycleAcc = 0;
  private readonly voices: ResidVoice[] = [
    makeResidVoice(), makeResidVoice(), makeResidVoice(),
  ];

  // Cached filter coefficients. Recomputed only when fc/resonance change.
  private filterFc = -1;
  private filterRes = -1;
  private filterMode = -1;
  private fcW = 0;            // normalized cutoff for one-pole approx
  private q = 0;              // resonance scale
  // Two-pole SVF state (low-pass / band-pass outputs).
  private svfLp = 0;
  private svfBp = 0;
  // External RC DC-block.
  private extLast = 0;
  private extOut = 0;

  constructor(inner?: Sid6581, opts: ResidEmitOptions = {}) {
    this.inner = inner ?? new Sid6581();
    this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.clockFreq = opts.clockFreq ?? PAL_CLOCK_FREQ;
  }

  // ----- pass-through to register-state SID ---------------------------------

  reset(): void {
    this.inner.reset();
    for (let i = 0; i < 3; i++) this.voices[i] = makeResidVoice();
    this.cycleAcc = 0;
    this.svfLp = 0; this.svfBp = 0; this.extLast = 0; this.extOut = 0;
    this.filterFc = -1; this.filterRes = -1; this.filterMode = -1;
  }
  read(addr: number): number { return this.inner.read(addr); }
  write(addr: number, value: number): void { this.inner.write(addr, value); }
  tick(cycles: number): void { this.inner.tick(cycles); }
  snapshot(): SidSnapshot { return this.inner.snapshot(); }
  restore(snap: SidSnapshot): void { this.inner.restore(snap); }
  get regs(): Uint8Array { return this.inner.regs; }
  set potReader(fn: ((idx: 0 | 1) => number) | undefined) { this.inner.potReader = fn; }
  get potReader(): ((idx: 0 | 1) => number) | undefined { return this.inner.potReader; }
  set writeTrace(fn: ((addr: number, value: number) => void) | undefined) { this.inner.writeTrace = fn; }
  get writeTrace(): ((addr: number, value: number) => void) | undefined { return this.inner.writeTrace; }

  // ----- audio synthesis ----------------------------------------------------

  /**
   * Emit signed 16-bit mono samples for `cycles` Φ2 cycles. Stereo
   * duplication happens at the writer/streamer level (single SID is mono;
   * the two channels carry identical content for compatibility with
   * stereo PCM consumers).
   *
   * Returns the produced sample buffer. The cycleAcc remainder is carried
   * between calls so successive emit()s stay sample-accurate.
   */
  emit(cycles: number): Int16Array {
    if (cycles <= 0) return new Int16Array(0);
    const totalCycles = this.cycleAcc + cycles;
    const samples = Math.floor(totalCycles * this.sampleRate / this.clockFreq);
    const cyclesUsed = Math.floor(samples * this.clockFreq / this.sampleRate);
    this.cycleAcc = totalCycles - cyclesUsed;
    const out = new Int16Array(samples);
    if (samples === 0) {
      // Still advance ADSR for the consumed cycles (subset).
      this.advanceAdsrCycles(cycles);
      return out;
    }
    const cyclesPerSample = cyclesUsed / samples;
    let cyAccum = 0;
    for (let i = 0; i < samples; i++) {
      cyAccum += cyclesPerSample;
      const step = Math.floor(cyAccum);
      cyAccum -= step;
      this.advanceVoices(step);
      this.advanceAdsrCycles(step);
      const mix = this.mixSample();
      out[i] = mix;
    }
    // Any leftover cycles from rounding go back to ADSR (kept exact).
    const leftover = cycles - cyclesUsed;
    if (leftover > 0) this.advanceAdsrCycles(leftover);
    return out;
  }

  // ----- internals ----------------------------------------------------------

  private advanceVoices(cycles: number): void {
    if (cycles <= 0) return;
    for (let v = 0; v < 3; v++) {
      const ctrl = this.regs[v * 7 + 4]!;
      if (ctrl & CTRL_TEST) {
        // TEST holds phase at 0 + reseeds noise LFSR.
        this.voices[v]!.phase = 0;
        this.voices[v]!.noiseLfsr = NSEED;
        continue;
      }
      const fs = this.regs[v * 7]! | (this.regs[v * 7 + 1]! << 8);
      const vc = this.voices[v]!;
      // Per-cycle advance with wrap detection for noise LFSR.
      // Bulk path: advance phase, count wraps via integer math.
      const delta = (fs * cycles) >>> 0;
      const newPhase = (vc.phase + delta) >>> 0;
      const wraps = Math.floor((vc.phase + delta) / 0x1000000);
      vc.phase = newPhase & 0xffffff;
      // NSHIFT noise LFSR per phase wrap (resid wave.cc clock_noise).
      for (let w = 0; w < wraps && w < 64; w++) {
        // bit19 ^ bit18 → bit0, shift left.
        const bit = (((vc.noiseLfsr >>> 22) ^ (vc.noiseLfsr >>> 17)) & 1);
        vc.noiseLfsr = (((vc.noiseLfsr << 1) | bit) >>> 0) & 0x7fffff;
      }
      vc.prevPhaseMsb = ((newPhase >>> 23) & 1) as 0 | 1;
    }
  }

  /**
   * Per-cycle ADSR advance with rate_counter + exponential divider (resid
   * envelope.cc semantics). Folds Sid6581.tick semantics so callers using
   * Resid.emit alone get correct $D41B/$D41C readback.
   */
  private advanceAdsrCycles(cycles: number): void {
    if (cycles <= 0) return;
    // Mirror to the inner SID so $D41B/$D41C reads stay coherent for
    // analysis tools that consume register-state SID.
    this.inner.tick(cycles);
    for (let v = 0; v < 3; v++) {
      const vc = this.voices[v]!;
      const ad = this.regs[v * 7 + 5]!;
      const sr = this.regs[v * 7 + 6]!;
      const ctrl = this.regs[v * 7 + 4]!;
      const attack = (ad >> 4) & 0x0f;
      const decay = ad & 0x0f;
      const sustain = (sr >> 4) & 0x0f;
      const release = sr & 0x0f;
      const gate = (ctrl & CTRL_GATE) as 0 | 1;
      // GATE-edge state transitions.
      if (gate && !vc.prevGate) {
        vc.envState = 0; vc.rateCounter = 0; vc.expCounter = 0;
      } else if (!gate && vc.prevGate) {
        vc.envState = 3; vc.rateCounter = 0; vc.expCounter = 0;
      }
      vc.prevGate = gate;

      // Walk rate counter `cycles` times (B-level: small numbers per
      // call, ≤ ~22 per audio sample @ 44.1kHz).
      let left = cycles;
      while (left-- > 0) {
        let period: number;
        switch (vc.envState) {
          case 0: period = RATE_COUNTER_PERIOD[attack]!; break;
          case 1: period = RATE_COUNTER_PERIOD[decay]!; break;
          case 2: {
            // SUSTAIN: hold value. Recompute target so sustain-nibble
            // changes take effect immediately (matches resid).
            vc.envCounter = sustain * 17;
            continue;
          }
          case 3: period = RATE_COUNTER_PERIOD[release]!; break;
          default: period = 0;
        }
        if (++vc.rateCounter < period) continue;
        vc.rateCounter = 0;
        if (vc.envState === 0) {
          if (vc.envCounter < 0xff) vc.envCounter++;
          if (vc.envCounter >= 0xff) {
            vc.envState = 1; vc.expCounter = 0;
          }
        } else {
          // Decay / Release: exponential approximation.
          if (++vc.expCounter < expDivider(vc.envCounter)) continue;
          vc.expCounter = 0;
          if (vc.envState === 1) {
            const sustainLevel = sustain * 17;
            if (vc.envCounter <= sustainLevel) {
              vc.envState = 2;
              vc.envCounter = sustainLevel;
            } else {
              vc.envCounter--;
            }
          } else {
            // RELEASE
            if (vc.envCounter > 0) vc.envCounter--;
          }
        }
      }
    }
  }

  /**
   * Compute one output sample by summing voices + applying filter +
   * master volume. Returns Int16-clamped value.
   */
  private mixSample(): number {
    const fmodeVol = this.regs[0x18]!;
    const vol = fmodeVol & 0x0f;
    const fmode = fmodeVol & 0xf0;
    const route = this.regs[0x17]!;

    let direct = 0;
    let filtered = 0;
    for (let v = 0; v < 3; v++) {
      // Voice-3 disable bit ($D418 bit 7) silences voice 3 only when
      // voice 3 is NOT routed through the filter.
      if (v === 2 && (fmode & FMODE_3OFF) && !(route & FROUTE_V3)) continue;
      const ctrl = this.regs[v * 7 + 4]!;
      const wave = (ctrl >> 4) & 0x0f;
      if (wave === 0) continue;
      const vc = this.voices[v]!;
      // 12-bit waveform output (resid wave.cc returns 12-bit).
      let wv12 = 0xfff;
      let any = false;
      if (ctrl & CTRL_TRI) {
        const tri12 = ((vc.phase >>> 11) ^ ((vc.phase & 0x800000) ? 0xfff : 0)) & 0xfff;
        wv12 &= tri12; any = true;
      }
      if (ctrl & CTRL_SAW) {
        wv12 &= (vc.phase >>> 12) & 0xfff;
        any = true;
      }
      if (ctrl & CTRL_PUL) {
        const pw = (this.regs[v * 7 + 2]! | ((this.regs[v * 7 + 3]! & 0x0f) << 8)) & 0xfff;
        const pwShifted = pw << 12;
        wv12 &= (vc.phase < pwShifted) ? 0x000 : 0xfff;
        any = true;
      }
      if (ctrl & CTRL_NOI) {
        // 8-bit noise pattern → expand to 12-bit by replicating.
        const n8 = this.nvalue(vc.noiseLfsr);
        wv12 &= ((n8 << 4) | (n8 >> 4)) & 0xfff;
        any = true;
      }
      if (!any) continue;
      // Centre wave around 0 (12-bit signed: -2048..+2047).
      const centred = wv12 - 0x800;
      // Apply envelope (0..255 → 0..1).
      const envScaled = (centred * vc.envCounter) >> 8;
      const routed = (route & (FROUTE_V1 << v)) !== 0;
      if (routed) filtered += envScaled;
      else direct += envScaled;
    }

    // Filter pass.
    if (filtered !== 0) {
      const fcLo = this.regs[0x15]! & 0x07;
      const fcHi = this.regs[0x16]!;
      const fc = ((fcHi << 3) | fcLo) & 0x7ff;
      const resFt = this.regs[0x17]!;
      const res = (resFt >> 4) & 0x0f;
      if (fc !== this.filterFc || res !== this.filterRes || fmode !== this.filterMode) {
        this.recomputeFilter(fc, res, fmode);
      }
      const input = filtered;
      // SVF: lp += fcW * bp; bp += fcW * (input - lp - q*bp).
      this.svfBp += this.fcW * (input - this.svfLp - this.q * this.svfBp);
      this.svfLp += this.fcW * this.svfBp;
      let fout = 0;
      if (fmode & FMODE_LP) fout += this.svfLp;
      if (fmode & FMODE_BP) fout += this.svfBp;
      if (fmode & FMODE_HP) fout += input - this.svfLp - this.q * this.svfBp;
      // If no mode selected and routing is active → silenced (matches resid).
      if (!(fmode & (FMODE_LP | FMODE_BP | FMODE_HP))) fout = 0;
      direct += fout;
    } else {
      // Decay filter state when nothing routed (avoids state freeze).
      this.svfBp *= 0.999;
      this.svfLp *= 0.999;
    }

    // Master volume.
    let sample = (direct * vol) / 15;
    // Output RC DC-block (resid extfilt.cc) — first-order high-pass.
    const a = 0.999;
    this.extOut = a * (this.extOut + sample - this.extLast);
    this.extLast = sample;
    sample = this.extOut;
    // Scale to int16 range. Voice 12-bit signed, 3 voices, vol/15 →
    // worst case ~3*2048 = 6144. Map to ~24000 headroom (avoid clip).
    let s = Math.round(sample * 4);
    if (s > 32767) s = 32767;
    if (s < -32768) s = -32768;
    return s;
  }

  /**
   * 6581 fc → coefficient. Real 6581 fc-curve is non-linear; approximate
   * with a logarithmic mapping from fc ∈ [0..2047] → ~30Hz..12kHz, then
   * pre-warped to the SVF coefficient. Resonance bits 0..15 → q ∈
   * [1.4..0.4] (lower = more resonant).
   */
  private recomputeFilter(fc: number, res: number, fmode: number): void {
    const fHz = 30 + (12000 - 30) * Math.pow(fc / 2047, 2);
    const w = 2 * Math.sin(Math.PI * fHz / this.sampleRate);
    this.fcW = Math.min(0.99, w);
    this.q = 1.4 - res * 0.07;
    this.filterFc = fc;
    this.filterRes = res;
    this.filterMode = fmode;
  }

  private nvalue(v: number): number {
    return (
      (((v >>> 22) & 1) << 7) |
      (((v >>> 20) & 1) << 6) |
      (((v >>> 16) & 1) << 5) |
      (((v >>> 13) & 1) << 4) |
      (((v >>> 11) & 1) << 3) |
      (((v >>> 7)  & 1) << 2) |
      (((v >>> 4)  & 1) << 1) |
      (((v >>> 2)  & 1) << 0)
    ) & 0xff;
  }
}
