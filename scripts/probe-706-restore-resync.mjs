#!/usr/bin/env node
// Spec 706.8 — restore/resume audio transport re-sync.
//
// Contract (Spec 706 §9, from Spec 705.A step 4): reSID SYNTHESIS state is
// machine state (in the RuntimeCheckpoint); the buffered PCM (recorder ring +
// WS send queue + browser worklet FIFO) is OLD-timeline transport state. On a
// RuntimeCheckpoint restore the transport is invalidated/flushed and re-buffered
// from the restored reSID state — no old-timeline playback.
//
// Headless-provable here:
//   G1  recorder.restore() flushes the recorder PCM ring (transport dropped).
//   G2  recorder.restore() fires the onRestore transport-resync hook exactly
//       once (the WS layer wires this to: reset send seq + broadcast audio/flush).
//   G3  the worklet flush model empties the ring AND re-arms the prebuffer, so
//       post-restore only NEW (post-restore) PCM is played, never stale frames.
//       (Mirrors ui/src/workbench/resid-worklet.js flush() — KEEP IN SYNC.)
//
// NOT asserted: byte-identity of already-buffered PCM across restore (transport,
// not machine state — Spec 706 §9 / 705.A reSID gate covers synthesis identity).

import {
  startIntegratedSession,
  stopIntegratedSession,
} from "../dist/runtime/headless/integrated-session-manager.js";
import { SidAudioRecorder } from "../dist/runtime/headless/audio/sid-audio-recorder.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail });
  console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}

// Worklet ring flush model — mirrors resid-worklet.js flush(). KEEP IN SYNC.
class WorkletRingModel {
  constructor(cap, startFill) { this.cap = cap; this.startFill = startFill; this.read = 0; this.write = 0; this.avail = 0; this.started = false; this.epoch = 0; }
  enqueue(n) { this.write = (this.write + n) % this.cap; this.avail = Math.min(this.avail + n, this.cap); }
  flush() { this.read = 0; this.write = 0; this.avail = 0; this.started = false; this.epoch++; }
  drain(n) {
    if (!this.started) { if (this.avail >= this.startFill) this.started = true; else return 0; }
    const played = Math.min(n, this.avail); this.avail -= played; return played;
  }
}

console.log("Spec 706.8 — restore/resume audio transport re-sync");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});

let recorder;
try {
  recorder = new SidAudioRecorder(session, { engine: "resid-wasm", sampleRate: 44100, bufferSamples: 3528 });
  await recorder.resid.ready?.();

  // wire the transport-resync hook (as the WS server does)
  let onRestoreCalls = 0;
  recorder.onRestore = () => { onRestoreCalls++; };

  // a live tone so the synthesis state + PCM are non-trivial
  recorder.resid.write(0xD400, 0x00); recorder.resid.write(0xD401, 0x20);
  recorder.resid.write(0xD405, 0x09); recorder.resid.write(0xD406, 0xf0);
  recorder.resid.write(0xD418, 0x0f); recorder.resid.write(0xD404, 0x11);
  recorder.resid.emit(120_000);

  const snap = recorder.snapshot();

  // disturb + buffer pre-restore (old-timeline) PCM into the recorder ring
  const cursor = "transport";
  recorder.buffer.attach(cursor);
  recorder.buffer.write(recorder.resid.emit(60_000));
  const availBefore = recorder.buffer.available(cursor);

  recorder.restore(snap);
  const availAfter = recorder.buffer.available(cursor);

  gate("G1 restore flushes recorder PCM ring (old-timeline transport dropped)",
    availBefore > 0 && availAfter === 0, `available ${availBefore} -> ${availAfter}`);
  gate("G2 restore fires onRestore transport-resync hook exactly once",
    onRestoreCalls === 1, `${onRestoreCalls} call(s)`);

  // G3 worklet flush model: fill with stale, flush, then verify only NEW plays.
  const wk = new WorkletRingModel(44100, Math.round(44100 * 0.12));
  wk.enqueue(8000);            // stale pre-restore PCM banked
  const staleAvail = wk.avail, staleEpoch = wk.epoch;
  wk.flush();                  // <- audio/flush on restore
  const flushedAvail = wk.avail, flushedStarted = wk.started, newEpoch = wk.epoch;
  // re-prebuffer from restored state, then play
  wk.enqueue(Math.round(44100 * 0.12) + 500);
  const played = wk.drain(128);
  gate("G3 worklet flush empties ring + bumps epoch + re-arms prebuffer",
    staleAvail === 8000 && flushedAvail === 0 && flushedStarted === false && newEpoch === staleEpoch + 1,
    `avail ${staleAvail}->${flushedAvail}, epoch ${staleEpoch}->${newEpoch}, started=${flushedStarted}`);
  gate("G3 post-flush playback resumes from NEW prebuffer (no old-timeline frames)",
    played === 128 && wk.avail < 44100, `played ${played}, ring ${wk.avail}`);
} finally {
  recorder?.detach?.();
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) {
  console.log(`GREEN 706.8 restore re-sync: ${passes} checks pass.`);
  process.exit(0);
}
console.log(`RED 706.8 restore re-sync: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
