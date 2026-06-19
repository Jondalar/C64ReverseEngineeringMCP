#!/usr/bin/env node
// Measure reSID's per-frame backend cost (separate backend, NOT the live session).
// The live emu loop calls recorder.flush() (= render this frame's PCM via reSID)
// once per completed frame, ON the single emulation thread. This times it:
//   A) baseline: runFor(1 PAL frame) alone (CPU+VIC+drive, no audio)
//   B) +reSID:  runFor(1 PAL frame) + recorder.flush()
//   C) flush()-only wall-time (the reSID render itself)
// Reports MIN ms/frame over batches (robust to a contended machine). The A→B
// delta ≈ what audio costs the emulation pace → why audio-on drops 50→<48 fps.

import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { SidAudioRecorder } from "../dist/runtime/headless/audio/sid-audio-recorder.js";

const PAL_FRAME = 19705;
const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});

function minMsPerFrame(fn, batches = 6, fr = 120) {
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < fr; i++) fn();
    const msf = (Number(process.hrtime.bigint() - t0) / 1e6) / fr;
    if (msf < best) best = msf;
  }
  return best;
}

try {
  session.resetCold("pal-default");
  session.runFor(3_000_000, { cycleBudget: 3_000_000 }); // to BASIC READY

  const recorder = new SidAudioRecorder(session, { engine: "resid-wasm" });
  await recorder.resid.ready?.();
  const cursorId = recorder.buffer.attach();

  // warmup
  for (let i = 0; i < 30; i++) { session.runFor(PAL_FRAME, { cycleBudget: PAL_FRAME }); recorder.flush(); }

  const base = minMsPerFrame(() => { session.runFor(PAL_FRAME, { cycleBudget: PAL_FRAME }); });
  const withSid = minMsPerFrame(() => { session.runFor(PAL_FRAME, { cycleBudget: PAL_FRAME }); recorder.flush(); });
  // flush-only: run a frame (so there are writes), then time JUST the flush
  let flushOnly = Infinity;
  for (let b = 0; b < 6; b++) {
    let acc = 0;
    for (let i = 0; i < 120; i++) {
      session.runFor(PAL_FRAME, { cycleBudget: PAL_FRAME });
      const t0 = process.hrtime.bigint();
      recorder.flush();
      acc += Number(process.hrtime.bigint() - t0) / 1e6;
    }
    flushOnly = Math.min(flushOnly, acc / 120);
  }

  recorder.buffer.detach(cursorId);
  recorder.detach();

  console.log("reSID per-frame backend cost (MIN ms/frame, 6×120):");
  console.log(`  A baseline (no audio):        ${base.toFixed(3)} ms/frame`);
  console.log(`  B +reSID (runFor+flush):      ${withSid.toFixed(3)} ms/frame`);
  console.log(`  → audio delta (B-A):          ${(withSid - base).toFixed(3)} ms/frame`);
  console.log(`  C flush()-only (reSID render):${flushOnly.toFixed(3)} ms/frame`);
  console.log(`  PAL budget = 20.0 ms/frame (50 fps). reSID render = ${(recorder.resid.sampleRate ?? 0)} Hz`);
} finally {
  stopIntegratedSession(sessionId);
}
