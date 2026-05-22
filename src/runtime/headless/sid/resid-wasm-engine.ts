// Spec 703.3 / 703.7 — reSID WASM audio engine.
//
// The audio-synthesis authority: the real reSID engine compiled to WASM
// (third_party/resid/ + wasm/resid_shim.cc, built by `npm run build:resid-wasm`).
//
// §7 bridge: an internal `Sid6581` remains the software-visible register /
// readback authority (so $D419/$D41A POT readback, OSC3/ENV3, snapshot, trace
// and the LNR Spec 429 $D419 bit-7 fix are unchanged). reSID is fed the same
// register writes purely for audio; `read()`/`regs` come from the register SID.
// This is the documented temporary bridge of §7 — one behavioural source for
// readback, reSID for sound — not a second readback model.
//
// Module load is async (emscripten returns a Promise), but `SidLike` is sync.
// We therefore stay fully functional synchronously via the inner Sid6581 from
// construction; the WASM module loads in the background and, once ready, the
// current register file is replayed into reSID so audio starts coherent within
// one load latency. `emit()` returns silence until the module is ready.

import { Sid6581, type SidSnapshot } from "./sid.js";
import {
  PAL_CLOCK_FREQ,
  DEFAULT_SAMPLE_RATE,
  type ResidEmitOptions,
} from "./resid.js";
import type { AudioSidLike } from "./sid-engine.js";

// reSID sampling_method (siddefs.h): 0 FAST, 1 INTERPOLATE, 2 RESAMPLE, 3 RESAMPLE_FASTMEM.
const SAMPLE_RESAMPLE = 2;
// reSID chip_model: 0 = 6581, 1 = 8580.
const MODEL_6581 = 0;
const MODEL_8580 = 1;

// Max samples produced per inner reSID clock() call (the emit loop re-issues
// until the cycle delta is consumed). PAL frame ≈ 882 samples @44.1k; 4096 is a
// comfortable chunk that bounds the WASM-heap scratch buffer.
const MAX_SAMPLES_PER_CALL = 4096;

interface ResidWasmModule {
  cwrap(name: string, ret: string | null, args: string[]): (...a: number[]) => number;
  _malloc(n: number): number;
  _free(p: number): void;
  HEAP16: Int16Array;
}

type ResidBindings = {
  setChipModel: (m: number) => void;
  setVoiceMask: (mask: number) => void;
  enableFilter: (on: number) => void;
  setSampling: (clk: number, sr: number, method: number) => number;
  reset: () => void;
  write: (reg: number, val: number) => void;
  read: (reg: number) => number;
  clock: (delta: number, buf: number, max: number) => number;
  clockRemaining: () => number;
  bufPtr: number;
  mod: ResidWasmModule;
};

export interface ResidWasmOptions extends ResidEmitOptions {
  /** 6581 (default) or 8580. */
  model?: "6581" | "8580";
}

export class ResidWasm implements AudioSidLike {
  public readonly inner: Sid6581;
  public readonly sampleRate: number;
  public readonly clockFreq: number;
  private readonly model: number;

  /** WASM bindings once the module has loaded; undefined until then. */
  private b: ResidBindings | undefined;
  private loadPromise: Promise<void> | undefined;
  private loadFailed: Error | undefined;

  /** Cycle remainder carried between emit() calls for exact sample timing. */
  private cycleAcc = 0;

  constructor(inner?: Sid6581, opts: ResidWasmOptions = {}) {
    this.inner = inner ?? new Sid6581();
    this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.clockFreq = opts.clockFreq ?? PAL_CLOCK_FREQ;
    this.model = opts.model === "8580" ? MODEL_8580 : MODEL_6581;
    // Kick off the background load; emit() yields silence until it resolves.
    this.loadPromise = this.load().catch((e) => {
      this.loadFailed = e instanceof Error ? e : new Error(String(e));
    });
  }

  /** Await this if you need audio guaranteed live before the first emit(). */
  async ready(): Promise<void> {
    await this.loadPromise;
    if (this.loadFailed) throw this.loadFailed;
  }

  private async load(): Promise<void> {
    let factory: (cfg?: unknown) => Promise<ResidWasmModule>;
    try {
      const url = new URL("./wasm/resid.mjs", import.meta.url).href;
      const glue = (await import(/* @vite-ignore */ url)) as {
        default: (cfg?: unknown) => Promise<ResidWasmModule>;
      };
      factory = glue.default;
    } catch (e) {
      throw new Error(
        "reSID WASM module not found (src/runtime/headless/sid/wasm/resid.mjs). " +
          "Run `npm run build:resid-wasm` (needs emscripten) to build it. " +
          `Underlying: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const mod = await factory();
    const b: ResidBindings = {
      setChipModel: mod.cwrap("resid_set_chip_model", null, ["number"]),
      setVoiceMask: mod.cwrap("resid_set_voice_mask", null, ["number"]),
      enableFilter: mod.cwrap("resid_enable_filter", null, ["number"]),
      setSampling: mod.cwrap("resid_set_sampling", "number", ["number", "number", "number"]),
      reset: mod.cwrap("resid_reset", null, []),
      write: mod.cwrap("resid_write", null, ["number", "number"]),
      read: mod.cwrap("resid_read", "number", ["number"]),
      clock: mod.cwrap("resid_clock", "number", ["number", "number", "number"]),
      clockRemaining: mod.cwrap("resid_clock_remaining", "number", []),
      bufPtr: mod._malloc(MAX_SAMPLES_PER_CALL * 2),
      mod,
    };
    b.reset();
    this.configure(b);
    this.b = b;
    // Replay the live register file so reSID matches the bus state captured
    // while it was still loading. Skips $19-$1f (read-only OSC3/ENV3/POT).
    const regs = this.inner.regs;
    for (let r = 0x00; r <= 0x18; r++) b.write(r, regs[r] ?? 0);
  }

  // ----- pass-through to register-state SID (readback authority, §7) --------

  /**
   * Apply the post-reset configuration in VICE's exact order (sid/resid.cc):
   * set_chip_model → set_voice_mask(0x07) → enable_filter → set_sampling.
   * The reSID ctor sets none of voice_mask/filter, so skipping this mutes
   * voices and bypasses the filter.
   */
  private configure(b: ResidBindings): void {
    b.setChipModel(this.model);
    b.setVoiceMask(0x07); // all three voices (single SID)
    b.enableFilter(1);
    b.setSampling(this.clockFreq, this.sampleRate, SAMPLE_RESAMPLE);
  }

  reset(): void {
    this.inner.reset();
    this.cycleAcc = 0;
    if (this.b) {
      this.b.reset();
      this.configure(this.b);
    }
  }
  read(addr: number): number { return this.inner.read(addr); }
  write(addr: number, value: number): void {
    this.inner.write(addr, value);
    // Feed reSID the same write for audio. $D400-mirror collapses to 0x00-0x1f.
    this.b?.write(addr & 0x1f, value & 0xff);
  }
  tick(cycles: number): void { this.inner.tick(cycles); }
  snapshot(): SidSnapshot { return this.inner.snapshot(); }
  restore(snap: SidSnapshot): void {
    this.inner.restore(snap);
    // Re-seed reSID from the restored register file so audio follows replay.
    if (this.b) {
      const regs = this.inner.regs;
      for (let r = 0x00; r <= 0x18; r++) this.b.write(r, regs[r] ?? 0);
    }
  }
  get regs(): Uint8Array { return this.inner.regs; }
  set potReader(fn: ((idx: 0 | 1) => number) | undefined) { this.inner.potReader = fn; }
  get potReader(): ((idx: 0 | 1) => number) | undefined { return this.inner.potReader; }
  set writeTrace(fn: ((addr: number, value: number) => void) | undefined) { this.inner.writeTrace = fn; }
  get writeTrace(): ((addr: number, value: number) => void) | undefined { return this.inner.writeTrace; }

  // ----- audio synthesis (reSID WASM) ---------------------------------------

  /**
   * Emit signed 16-bit mono samples for `cycles` Φ2 cycles. Mirrors
   * Resid.emit(): the sample count tracks `cycles * sampleRate / clockFreq`
   * with the fractional remainder carried across calls. Until the WASM module
   * has loaded, returns the right number of zero samples (silence) while the
   * inner SID still advances ADSR/readback via tick().
   */
  emit(cycles: number): Int16Array {
    if (cycles <= 0) return new Int16Array(0);

    const b = this.b;
    if (!b) {
      // Module not ready: keep register readback advancing, return silence
      // sized to the cycle budget (reSID owns exact timing once loaded).
      this.inner.tick(cycles);
      const total = this.cycleAcc + cycles;
      const samples = Math.floor((total * this.sampleRate) / this.clockFreq);
      this.cycleAcc = total - Math.floor((samples * this.clockFreq) / this.sampleRate);
      return new Int16Array(samples);
    }

    // Consume the FULL cycle delta and return exactly the samples reSID emits.
    // reSID tracks fractional sample timing internally (sample_offset), so we
    // must NOT pre-estimate or cap the count — capping would leave cycles
    // unconsumed inside reSID, making it lag cumulatively (pitch/timing drift).
    const chunks: Int16Array[] = [];
    let totalSamples = 0;
    let dt = cycles;
    let guard = 0;
    const base = b.bufPtr >> 1;
    while (dt > 0 && guard++ < 1 << 20) {
      const n = b.clock(dt, b.bufPtr, MAX_SAMPLES_PER_CALL);
      if (n > 0) {
        // Copy out immediately: ALLOW_MEMORY_GROWTH can swap the heap buffer.
        chunks.push(b.mod.HEAP16.slice(base, base + n));
        totalSamples += n;
      }
      const rem = b.clockRemaining();
      if (n === 0 && rem >= dt) break; // no progress — avoid spin
      dt = rem;
    }
    // reSID owns ADSR/osc internally; keep the register SID's readback in step.
    this.inner.tick(cycles);

    if (chunks.length === 1) return chunks[0]!;
    const out = new Int16Array(totalSamples);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
}
