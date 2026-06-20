// Spec 768.3 — emu-thread host for the off-thread reSID worker.
//
// Drop-in alternative to SidAudioRecorder's inline render: instead of running
// reSID in the emulation loop (the ~2.1 ms/frame that drops fps), it hooks
// session.sid.writeTrace → push to the SID write-stream ring and, once per frame
// (boundary), tells the worker how many cycles to emit. The worker renders PCM on
// its own core into the PCM ring; the WS audio ship reads from here. The emu loop
// keeps 50 fps WITH audio.
//
// Implements AudioCheckpointProvider so scrub/restore doesn't crash. 768.3 is a
// STUB provider: it carries no reSID state yet (residState: null) — on restore it
// flushes the PCM transport + re-syncs the worker from its CURRENT state (a small
// audible blip on a scrub, no desync/crash). 768.4 fills in the real reSID
// state round-trip (worker get/setState) for sample-exact scrub.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import {
  SidWriteRingProducer, createSidWriteRingSab, type SidWriteRingLayout,
} from "./sid-write-ring.js";
import {
  SidPcmRingConsumer, createSidPcmRingSab, type SidPcmRingLayout,
} from "./sid-pcm-ring.js";
import type { AudioCheckpointProvider, SidAudioRecorderSnapshot } from "./sid-audio-recorder.js";

const WORKER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "resid-worker.js");

interface HostSession {
  c64Cpu: { cycles: number };
  sid: { regs: Uint8Array | number[]; writeTrace?: ((addr: number, value: number) => void) | undefined };
  registerAudioCheckpoint?(p: AudioCheckpointProvider | null): void;
}

export interface SidAudioWorkerHostOptions {
  engine?: string;
  /** SID write-stream ring depth (records). */
  writeRecords?: number;
  /** PCM ring depth (Int16 samples). */
  pcmSamples?: number;
}

export class SidAudioWorkerHost implements AudioCheckpointProvider {
  readonly sampleRate = 44100;
  /** Transport re-sync hook (set by the WS stream — flush worklet + reset seq). */
  onRestore?: () => void;

  private readonly worker: Worker;
  private readonly writeProd: SidWriteRingProducer;
  private readonly pcmCons: SidPcmRingConsumer;
  private readonly prevWriteTrace?: ((addr: number, value: number) => void) | undefined;
  private lastCycle: number;
  private detached = false;
  private ready = false;

  constructor(private readonly session: HostSession, opts: SidAudioWorkerHostOptions = {}) {
    const writeLayout: SidWriteRingLayout = { recordCount: opts.writeRecords ?? (1 << 16) };
    // Spec 768 latency — small ring (~93 ms): drop-oldest keeps audio fresh, no
    // banked latency (the inline path's LIVE buffer is ~80 ms for the same reason).
    const pcmLayout: SidPcmRingLayout = { capacitySamples: opts.pcmSamples ?? (1 << 12) };
    const writeRingSab = createSidWriteRingSab(writeLayout);
    const pcmRingSab = createSidPcmRingSab(pcmLayout);
    this.writeProd = new SidWriteRingProducer(writeRingSab, writeLayout);
    this.pcmCons = new SidPcmRingConsumer(pcmRingSab, pcmLayout);

    const initialRegs = Array.from({ length: 0x20 }, (_, a) => (session.sid.regs as Uint8Array)[a] ?? 0);
    this.worker = new Worker(WORKER_PATH, {
      workerData: { writeRingSab, writeLayout, pcmRingSab, pcmLayout, engine: opts.engine ?? "resid-wasm", initialRegs },
    });
    this.worker.on("message", (m: { type: string }) => { if (m.type === "ready") this.ready = true; });
    this.worker.on("error", () => { /* worker death must never crash the emu thread */ });
    this.worker.unref();

    // Compose with any existing writeTrace (mirror SidAudioRecorder.ctor).
    this.prevWriteTrace = session.sid.writeTrace;
    session.sid.writeTrace = (addr, value) => {
      this.prevWriteTrace?.(addr, value);
      this.writeProd.write(addr & 0x1f, value);
    };
    this.lastCycle = session.c64Cpu.cycles;
    session.registerAudioCheckpoint?.(this);
  }

  /** Per completed frame: push the boundary so the worker emits this frame's PCM. */
  boundary(): void {
    if (this.detached) return;
    const now = this.session.c64Cpu.cycles;
    const d = now - this.lastCycle;
    // Cold reset (resetCold / power-cycle / EF attach): cycles jump back → skip
    // the negative span + re-sync, exactly like SidAudioRecorder.flush().
    if (d < 0) { this.lastCycle = now; return; }
    if (d === 0) return;
    this.lastCycle = now;
    this.writeProd.boundary(d);
  }

  pcmAvailable(): number { return this.pcmCons.available(); }
  pcmReadInto(max: number, out: Int16Array): number { return this.pcmCons.readInto(max, out); }

  // ---- AudioCheckpointProvider (768.3 stub — no reSID state round-trip yet) ----
  snapshot(): SidAudioRecorderSnapshot {
    // Non-null slice so kernel.restore() invokes restore() (→ transport flush).
    return { residState: null, cycleAcc: 0, lastCycle: this.lastCycle };
  }
  restore(_s: SidAudioRecorderSnapshot): void {
    // 768.3: no reSID state to push yet — flush the PCM transport + re-sync the
    // worker + re-anchor the emit clock so a scrub doesn't replay stale audio.
    this.lastCycle = this.session.c64Cpu.cycles;
    this.pcmCons.clear();
    try { this.worker.postMessage({ type: "resync" }); } catch { /* ignore */ }
    this.onRestore?.();
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.session.sid.writeTrace = this.prevWriteTrace;
    this.session.registerAudioCheckpoint?.(null);
    try { this.worker.postMessage({ type: "stop" }); } catch { /* ignore */ }
    void this.worker.terminate();
  }
}
