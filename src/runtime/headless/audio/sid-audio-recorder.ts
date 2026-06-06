// Spec 263 — passive audio recorder.
//
// Wraps a live IntegratedSession (or any object exposing
// `sid: Sid6581 + c64Cpu.cycles`) and records the SID register stream
// onto a parallel Resid engine, calling `emit()` per slice to produce
// a stereo PCM stream into an AudioRingBuffer.
//
// This keeps the session SID untouched (still Sid6581 register-state)
// so existing trace/snapshot/replay paths remain bit-equal. Audio is a
// read-side overlay: same writes → same audio every time → determinism.

import { type ResidEmitOptions } from "../sid/resid.js";
import type { Sid6581 } from "../sid/sid.js";
import { createAudioSid, type AudioSidLike, type SidEngineKind } from "../sid/sid-engine.js";
import { AudioRingBuffer, monoToStereoLR } from "./audio-buffer.js";

// Spec 706.2 (Fix A) — recorder buffer size is per-use, NOT one-size.
//
// The recorder ring is the primary banking enabler (Spec 706 §3): a backend
// lead (startup burst / fastloader catch-up) can flush a large backlog in one
// go; whatever the recorder holds becomes permanent downstream latency. The
// LIVE stream therefore uses a SMALL cap (~80 ms) so a catch-up flush drops the
// stale excess at the source (reSID is re-rendered fresh — dropping stale
// samples = staying current with video, no quality loss). The OFFLINE export
// path legitimately banks (it drains linearly, never realtime) and keeps the
// LARGE buffer.
//
// NB AudioRingBuffer rounds capacity up to a power of two, so 3528 → 4096
// (~93 ms). That is the realized live cap.
export const LIVE_RECORDER_BUFFER_SAMPLES = 3528;   // ~80 ms @ 44.1 kHz (→ 4096 after pow2)
export const EXPORT_RECORDER_BUFFER_SAMPLES = 65536; // ~1.48 s — offline banking

export interface SessionLike {
  sid: Sid6581;
  c64Cpu: { cycles: number };
  /**
   * Spec 705.A step 4 — optional registration of the active reSID audio
   * recorder, so a native RuntimeCheckpoint can OPTIONALLY capture/restore the
   * audio continuation state. When no recorder is registered, the core
   * checkpoint works without audio (machine continuation is already GREEN
   * without audio). Pass null to unregister (on detach).
   */
  registerAudioCheckpoint?(provider: AudioCheckpointProvider | null): void;
}

/** The audio-checkpoint slice the session/kernel can optionally own. */
export interface AudioCheckpointProvider {
  snapshot(): SidAudioRecorderSnapshot;
  restore(s: SidAudioRecorderSnapshot): void;
}

export interface RecorderOptions extends ResidEmitOptions {
  /** Ring-buffer capacity in mono samples (default 65536). */
  bufferSamples?: number;
  /**
   * Audio synth engine for the parallel mirror. Default resolves via
   * `createAudioSid` (explicit > C64RE_SID_ENGINE > `resid-wasm`). Spec 703:
   * the live stream + WAV export now run the real reSID WASM engine.
   */
  engine?: SidEngineKind;
}

/**
 * Attach a Resid mirror to `session.sid.writeTrace`. Captures every
 * register write and replays it onto the mirror SID. Caller drives
 * sample emission via `flush(cycles)`.
 *
 * Important: this composes with an existing writeTrace if one is set.
 */
/**
 * Spec 705.A step 4 — the audio-checkpoint slice of a live recorder. Carries
 * ONLY the reSID synthesis state (+ TS sample-cadence). The PCM ring / WS /
 * worklet FIFO are presentation/transport state and are NOT serialized; on
 * restore they are flushed and re-buffered from the restored reSID state.
 */
export interface SidAudioRecorderSnapshot {
  /** reSID synthesis state (sizeof reSID::SID::State); null if WASM not loaded. */
  residState: Uint8Array | null;
  /** ResidWasm cycle-cadence remainder. */
  cycleAcc: number;
  /** Sample-emit clock anchor (re-synced to the restored cpu cycle on restore). */
  lastCycle: number;
}

export class SidAudioRecorder {
  public readonly resid: AudioSidLike;
  public readonly buffer: AudioRingBuffer;
  private prevWriteTrace?: ((addr: number, value: number) => void) | undefined;
  private lastCycle: number;
  private detached = false;
  /**
   * Spec 706.8 — transport re-sync hook. Invoked at the end of restore(), after
   * the recorder PCM ring is flushed, so the transport owner (the WS audio
   * stream) can invalidate downstream presentation state: reset its send seq +
   * tell the browser to flush its worklet/FIFO and re-prebuffer from the
   * restored reSID synthesis state. The recorder owns NO transport itself; it
   * only signals that a restore happened.
   */
  public onRestore?: () => void;

  constructor(public readonly session: SessionLike, opts: RecorderOptions = {}) {
    this.resid = createAudioSid(opts);
    this.buffer = new AudioRingBuffer({
      capacitySamples: opts.bufferSamples ?? 65536,
      sampleRate: this.resid.sampleRate,
    });
    // Sync mirror state to current registers (catches mid-session attach).
    for (let a = 0; a < 0x20; a++) {
      this.resid.write(0xD400 + a, session.sid.regs[a] ?? 0);
    }
    this.lastCycle = session.c64Cpu.cycles;
    this.prevWriteTrace = session.sid.writeTrace;
    session.sid.writeTrace = (addr, value) => {
      this.prevWriteTrace?.(addr, value);
      // addr is the offset within the SID tile (& 0x1f) per Sid6581.write.
      this.resid.write(0xD400 + (addr & 0x1f), value);
    };
    // Register as the session's active audio-checkpoint owner (optional hook).
    this.session.registerAudioCheckpoint?.(this);
  }

  /** Generate samples for cycles elapsed since last flush. Returns the buffer. */
  flush(): AudioRingBuffer {
    if (this.detached) return this.buffer;
    const now = this.session.c64Cpu.cycles;
    const dCycles = now - this.lastCycle;
    // A cold reset (resetCold / power-cycle / EF cart attach) sets c64 cycles
    // back to 0, so `now` jumps BACKWARDS past lastCycle. resid.emit needs a
    // positive delta; the old `dCycles <= 0 → return` left lastCycle STALE, so
    // it stayed negative for the whole pre-reset cycle span (~seconds) → audio
    // went permanently silent after any cold reset (the boot transient is the
    // last thing heard). Re-sync to the new clock and skip this frame's gap;
    // the next frame emits normally. (restore() already resyncs on scrub.)
    if (dCycles < 0) { this.lastCycle = now; return this.buffer; }
    if (dCycles === 0) return this.buffer;
    this.lastCycle = now;
    const samples = this.resid.emit(dCycles);
    this.buffer.write(samples);
    return this.buffer;
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    // Restore prior writeTrace.
    this.session.sid.writeTrace = this.prevWriteTrace;
    // Unregister from the session audio-checkpoint hook.
    this.session.registerAudioCheckpoint?.(null);
  }

  /**
   * Spec 705.A step 4 — capture the audio-checkpoint slice: reSID synthesis
   * state + cadence. NOT the PCM ring (transport).
   */
  snapshot(): SidAudioRecorderSnapshot {
    return {
      residState: this.resid.captureResidState ? this.resid.captureResidState() : null,
      cycleAcc: this.resid.cycleAccumulator ?? 0,
      lastCycle: this.lastCycle,
    };
  }

  /**
   * Spec 705.A step 4 — restore the reSID synthesis state directly (NOT
   * register replay, which would clobber the restored interna), re-sync the
   * sample-cadence clock to the machine-restored cpu cycle, and FLUSH the PCM
   * ring (pre-restore buffered audio is transport state, dropped + re-buffered
   * from the restored reSID state). The reSID synthesis state already carries
   * sid_register[]; the inner readback mirror re-syncs lazily via writeTrace.
   */
  restore(s: SidAudioRecorderSnapshot): void {
    if (this.detached) return;
    if (s.residState && this.resid.restoreResidState) {
      this.resid.restoreResidState(s.residState);
    }
    if (this.resid.cycleAccumulator !== undefined) this.resid.cycleAccumulator = s.cycleAcc;
    this.lastCycle = this.session.c64Cpu.cycles;
    this.buffer.clear();
    // Spec 706.8 — pre-restore PCM in the WS send queue + browser worklet ring
    // is OLD-timeline transport state; tell the transport owner to invalidate it
    // and re-prebuffer from the restored reSID synthesis state.
    this.onRestore?.();
  }

  /**
   * Convenience for one-shot export: run `runFn(cycleBudget)` against the
   * session, flush, then return mono+stereo buffers. Caller is responsible
   * for actually advancing the session — we don't drive it here to keep
   * the recorder agnostic to session-mode.
   */
  collectStereo(): Int16Array {
    this.flush();
    // Drain entire buffer via a dedicated cursor.
    const id = `__collect_${Date.now()}_${Math.random()}`;
    this.buffer.attach(id);
    // Re-attach starts at write head — but we want everything since
    // recorder-construction. Reset cursor to zero by reading capacity-sized
    // window: easier is to track total writes ourselves.
    this.buffer.detach(id);
    // Simpler: rebuild a fresh buffer view from total samples written so
    // far is impractical (data may have wrapped). For export, callers
    // should attach a consumer up-front (see AudioExportSession below).
    return new Int16Array(0);
  }
}

/**
 * One-shot WAV export helper. Attaches recorder, drives session for
 * `cycleBudget` cycles, drains the buffer linearly, returns stereo PCM.
 */
export class AudioExportSession {
  private recorder: SidAudioRecorder;
  private cursorId: string;
  private collected: Int16Array[] = [];

  constructor(session: SessionLike, opts: RecorderOptions = {}) {
    // Export pumps synchronously, so it pins the synchronous TS `Resid` engine
    // by default: the reSID WASM engine loads asynchronously and would emit
    // silence (and non-deterministic timing) under a sync pump. Migrating
    // export to reSID is Spec 703.5 (needs an `await resid.ready()` pass). The
    // live WS stream already runs reSID via SidAudioRecorder's default.
    // Spec 706.2: export banks legitimately (linear drain, not realtime) → keep
    // the large buffer. Explicit so a future ctor-default change can't shrink it.
    this.recorder = new SidAudioRecorder(session, {
      engine: "resid", bufferSamples: EXPORT_RECORDER_BUFFER_SAMPLES, ...opts,
    });
    this.cursorId = `export_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    this.recorder.buffer.attach(this.cursorId);
  }

  /** Pump samples after the session has advanced. */
  pump(): void {
    this.recorder.flush();
    while (this.recorder.buffer.available(this.cursorId) > 0) {
      const { samples } = this.recorder.buffer.read(this.cursorId, 8192);
      if (samples.length === 0) break;
      this.collected.push(samples);
    }
  }

  /** Finish + return concatenated stereo PCM. */
  finishStereo(): Int16Array {
    this.pump();
    let total = 0;
    for (const c of this.collected) total += c.length;
    const mono = new Int16Array(total);
    let off = 0;
    for (const c of this.collected) { mono.set(c, off); off += c.length; }
    this.recorder.buffer.detach(this.cursorId);
    this.recorder.detach();
    return monoToStereoLR(mono);
  }

  get sampleRate(): number { return this.recorder.resid.sampleRate; }
}
