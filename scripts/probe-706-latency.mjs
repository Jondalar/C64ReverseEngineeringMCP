#!/usr/bin/env node
// Spec 706.1 — live SID audio end-to-end latency probe (baseline + before/after).
//
// Models the live audio pipeline headlessly and reports steady-state + peak
// latency, so the Spec 706 fixes have a measured number to beat (§5 #1, #3).
//
// Pipeline (Spec 706 §2):
//   backend reSID render (REAL SidAudioRecorder) --ship all avail per frame-->
//   WS transport (localhost: ~instant) --post--> browser AudioWorklet ring
//   (drains at realtime 882 samples / 20 ms PAL frame).
//
// The latency = audio "in flight" (recorder-unshipped + WS-buffered + worklet
// ring fill) / sample-rate. With the CURRENT design any transient backend lead
// banks samples that NOTHING fast-forwards → permanent latency. The fixes:
//   Fix A  recorder buffer cap (this probe drives the REAL recorder, so the cap
//          is exercised against real code when a stall→catch-up flush emits a
//          large backlog at once).
//   Fix B  worklet latency governor (browser code — its trim arithmetic is
//          REPLICATED here; KEEP IN SYNC with ui/src/v3/resid-worklet.js).
//   Fix C  WS backpressure (modeled as a per-frame ship bound).
//
// Run reports a BEFORE config (current master behavior) and an AFTER config
// (706.2+706.3+706.4 params) side by side. 706.5 turns the AFTER numbers into
// pass/fail thresholds; 706.1 only establishes the baseline.

import {
  startIntegratedSession,
  stopIntegratedSession,
} from "../dist/runtime/headless/integrated-session-manager.js";
import { SidAudioRecorder } from "../dist/runtime/headless/audio/sid-audio-recorder.js";
import { monoToStereoLR } from "../dist/runtime/headless/audio/audio-buffer.js";

// --- PAL realtime constants ------------------------------------------------
const CPU_HZ = 985248;          // PAL 6510
const FPS = 50;                 // wall frames / s (882 samples/frame is exact)
const CYCLES_PER_FRAME = Math.round(CPU_HZ / FPS); // 19705
const SAMPLE_RATE = 44100;
const SAMPLES_PER_FRAME = SAMPLE_RATE / FPS;        // 882 (realtime drain / frame)
const msOf = (samples) => (samples / SAMPLE_RATE) * 1000;

// --- worklet ring model (mono-sample units; stereo handled by /2 on push) --
// Mirrors ui/src/v3/resid-worklet.js: ring with hard-overflow drop-oldest and
// (optionally) the Spec 706.3 latency governor. KEEP IN SYNC.
class WorkletRingModel {
  constructor({ cap, startFill, governor, target, margin }) {
    this.cap = cap;            // frames (stereo) capacity
    this.startFill = startFill;
    this.governor = !!governor;
    this.target = target;      // steady-state fill target (frames)
    this.margin = margin;      // slack above target before trimming (frames)
    this.avail = 0;            // frames currently buffered
    this.started = false;
  }
  // push N stereo frames (already de-interleaved count)
  enqueue(frames) {
    this.avail += frames;
    if (this.avail > this.cap) this.avail = this.cap; // drop oldest at hard cap
  }
  // advance one realtime audio block of `frames`; returns frames actually played
  drain(frames) {
    if (!this.started) {
      if (this.avail >= this.startFill) this.started = true;
      else return 0; // prebuffering: output silence
    }
    // Spec 706.3 governor: stale audio is being discarded anyway (reSID is
    // re-rendered fresh on the backend), so trim back toward target.
    if (this.governor && this.avail > this.target + this.margin) {
      this.avail = this.target; // fast-forward read (drop oldest) — staying current
    }
    const played = Math.min(frames, this.avail);
    this.avail -= played;
    return played;
  }
}

async function runConfig(label, cfg) {
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  // Cycle shim: the recorder reads session.c64Cpu.cycles + session.sid; we drive
  // cycles deterministically so the stall→catch-up transient is exact.
  const cpuShim = { cycles: 0 };
  const shim = { sid: session.sid, c64Cpu: cpuShim, registerAudioCheckpoint() {} };

  let recorder;
  let result;
  try {
    recorder = new SidAudioRecorder(shim, {
      engine: "resid-wasm", sampleRate: SAMPLE_RATE, bufferSamples: cfg.recorderCap,
    });
    await recorder.resid.ready?.();
    // A live tone so emit produces a real, non-silent stream.
    recorder.resid.write(0xD400, 0x00); recorder.resid.write(0xD401, 0x20);
    recorder.resid.write(0xD405, 0x09); recorder.resid.write(0xD406, 0xf0);
    recorder.resid.write(0xD418, 0x0f); recorder.resid.write(0xD404, 0x11);

    const cursor = "ws";
    recorder.buffer.attach(cursor);
    const worklet = new WorkletRingModel(cfg.worklet);

    // One backend frame: advance cycles, flush (real reSID emit), ship per the
    // per-frame hook (read all avail), apply Fix C ship bound, push to worklet.
    const wsShipBoundFrames = cfg.wsShipBoundMs != null
      ? Math.round((cfg.wsShipBoundMs / 1000) * SAMPLE_RATE) : Infinity;
    function backendFrame(cyclesToAdvance) {
      cpuShim.cycles += cyclesToAdvance;
      recorder.flush();
      let avail = recorder.buffer.available(cursor);
      // Fix C: cap how much we ship per frame (consumer is realtime) — does NOT
      // drop (no gap): unshipped stays in the recorder ring for next frame, and
      // the recorder cap (Fix A) bounds total banking.
      const shipMono = Math.min(avail, wsShipBoundFrames);
      const { samples } = recorder.buffer.read(cursor, shipMono);
      if (samples.length > 0) {
        const stereo = monoToStereoLR(samples); // count unchanged (mono frames)
        worklet.enqueue(stereo.length >> 1);     // frames = stereo pairs = mono count
      }
    }

    const latencyOf = () =>
      msOf(recorder.buffer.available(cursor) + worklet.avail);

    // --- scenario --------------------------------------------------------
    // 1) warmup at realtime 1× until the worklet has started + settled.
    for (let f = 0; f < 60; f++) { backendFrame(CYCLES_PER_FRAME); worklet.drain(SAMPLES_PER_FRAME); }
    const steadyWarmup = latencyOf();

    // 2) STALL: backend frozen ~1 s (fastloader CPU spike — onAudioFrame does
    //    not fire), then ONE catch-up flush emits the whole ~1 s backlog at once
    //    (Spec 706 §3: the recorder banks, one onAudioFrame ships the backlog).
    cpuShim.cycles += CPU_HZ; // +1 s of emulated cycles, no flush yet
    backendFrame(0);          // single catch-up flush + ship (Fix A/C bite here)
    worklet.drain(SAMPLES_PER_FRAME);
    const peak = latencyOf();

    // 3) RECOVERY: realtime 1× — measure how fast latency returns toward steady.
    let recoveryFrames = -1;
    const RECOVER_TARGET_MS = 150;
    for (let f = 0; f < 200; f++) {
      backendFrame(CYCLES_PER_FRAME);
      worklet.drain(SAMPLES_PER_FRAME);
      if (recoveryFrames < 0 && latencyOf() <= RECOVER_TARGET_MS) recoveryFrames = f + 1;
    }
    const steadyFinal = latencyOf();

    result = {
      label,
      steadyWarmupMs: steadyWarmup,
      peakMs: peak,
      steadyFinalMs: steadyFinal,
      recoveryFrames,
      recoveryMs: recoveryFrames >= 0 ? recoveryFrames * (1000 / FPS) : null,
    };
  } finally {
    recorder?.detach?.();
    stopIntegratedSession(sessionId);
  }
  return result;
}

console.log("Spec 706.1 — live SID audio latency probe (PAL, 44.1 kHz)");
console.log(`  realtime drain = ${SAMPLES_PER_FRAME} samples/frame, ${CYCLES_PER_FRAME} cyc/frame\n`);

// BEFORE = current master: recorder 65536 (1.48 s), worklet 1 s ring, no
// governor, no WS ship bound.
const before = await runConfig("BEFORE (master)", {
  recorderCap: 65536,
  wsShipBoundMs: null,
  worklet: { cap: SAMPLE_RATE /* 1 s */, startFill: Math.round(SAMPLE_RATE * 0.25), governor: false },
});

// AFTER = the SHIPPED Spec 706 fix params (must mirror the real code):
//   Fix A  LIVE_RECORDER_BUFFER_SAMPLES = 3528 (sid-audio-recorder.ts)
//   Fix C  MAX_AUDIO_SHIP_SAMPLES = 1764 mono ≈ 40 ms (v3-ws-server.ts)
//   Fix B  audio-player.ts: prebuffer 120 ms, governor target 100 ms / margin 50 ms
const after = await runConfig("AFTER (706 fixes)", {
  recorderCap: 3528,           // Fix A LIVE_RECORDER_BUFFER_SAMPLES
  wsShipBoundMs: (1764 / SAMPLE_RATE) * 1000, // Fix C MAX_AUDIO_SHIP_SAMPLES ≈ 40 ms
  worklet: {
    cap: SAMPLE_RATE, startFill: Math.round(SAMPLE_RATE * 0.12), // prebuffer 120 ms
    governor: true,
    target: Math.round(SAMPLE_RATE * 0.10),  // ~100 ms
    margin: Math.round(SAMPLE_RATE * 0.05),  // ~50 ms
  },
});

const fmt = (n) => (n == null ? "  n/a " : `${n.toFixed(1).padStart(7)} ms`);
console.log("  config              steady(warm)   peak(post-stall)   steady(final)   recovery");
for (const r of [before, after]) {
  console.log(
    `  ${r.label.padEnd(18)} ${fmt(r.steadyWarmupMs)}   ${fmt(r.peakMs)}      ${fmt(r.steadyFinalMs)}   ` +
    (r.recoveryMs == null ? "  never≤150ms" : `${r.recoveryMs.toFixed(0)}ms (${r.recoveryFrames}f)`),
  );
}
console.log("");

// --- 706.5 acceptance gates (§5 #1 steady < 150ms, #3 recovery < ~1s) -------
const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail });
  console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}
const STEADY_MAX_MS = 150;     // §5 #1
const RECOVERY_MAX_MS = 1000;  // §5 #3 "within ~1 s"
gate("§5#1 AFTER steady-state latency < 150 ms (warm)", after.steadyWarmupMs < STEADY_MAX_MS, `${after.steadyWarmupMs.toFixed(1)} ms`);
gate("§5#1 AFTER steady-state latency < 150 ms (after stall)", after.steadyFinalMs < STEADY_MAX_MS, `${after.steadyFinalMs.toFixed(1)} ms`);
gate("§5#3 AFTER recovers to ≤150 ms within ~1 s of a 1 s stall",
  after.recoveryMs != null && after.recoveryMs <= RECOVERY_MAX_MS,
  after.recoveryMs == null ? "never recovered" : `${after.recoveryMs.toFixed(0)} ms`);
gate("BEFORE confirms the bug: post-stall latency is permanent (never ≤150 ms)",
  before.recoveryMs == null, before.recoveryMs == null ? `stuck at ${before.steadyFinalMs.toFixed(0)} ms` : `recovered in ${before.recoveryMs} ms`);
gate("fix reduces post-stall steady-state latency", after.steadyFinalMs < before.steadyFinalMs,
  `${before.steadyFinalMs.toFixed(0)} ms -> ${after.steadyFinalMs.toFixed(0)} ms`);

console.log("---");
console.log("  Live-UI gates (user-verified): §5 #2 60s no-stutter, #5 audio/video sync.");
if (failures.length === 0) {
  console.log(`GREEN 706.5 latency gates: ${passes} checks pass.`);
  process.exit(0);
}
console.log(`RED 706.5 latency: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
