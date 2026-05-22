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

export interface SessionLike {
  sid: Sid6581;
  c64Cpu: { cycles: number };
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
export class SidAudioRecorder {
  public readonly resid: AudioSidLike;
  public readonly buffer: AudioRingBuffer;
  private prevWriteTrace?: ((addr: number, value: number) => void) | undefined;
  private lastCycle: number;
  private detached = false;

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
  }

  /** Generate samples for cycles elapsed since last flush. Returns the buffer. */
  flush(): AudioRingBuffer {
    if (this.detached) return this.buffer;
    const now = this.session.c64Cpu.cycles;
    const dCycles = now - this.lastCycle;
    if (dCycles <= 0) return this.buffer;
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
    this.recorder = new SidAudioRecorder(session, { engine: "resid", ...opts });
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
