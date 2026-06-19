#!/usr/bin/env node
// Spec 768.3 — SidAudioWorkerHost end-to-end (emu side), no WS client needed.
//   A) constructing the host hooks writeTrace + registers the audio-checkpoint
//      provider + spawns the worker.
//   B) running frames + host.boundary() → the worker renders → PCM becomes
//      available on the main side (pcmAvailable > 0), readable as samples.
//   C) the 705.A stub provider restore() flushes the PCM transport (no crash).

import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { SidAudioWorkerHost } from "../dist/runtime/headless/audio/sid-audio-worker-host.js";

const PAL_FRAME = 19705;
const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}

console.log("Spec 768.3 — SidAudioWorkerHost end-to-end");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
try {
  session.resetCold("pal-default");
  session.runFor(2_500_000, { cycleBudget: 2_500_000 });

  const prevWriteTrace = session.sid.writeTrace;
  const host = new SidAudioWorkerHost(session, { pcmSamples: 1 << 16 });
  gate("A host hooks writeTrace", session.sid.writeTrace !== prevWriteTrace);
  gate("A host registers the audio-checkpoint provider", session.audioCheckpointProvider === host);

  // give the worker its async reSID-wasm load time
  await new Promise((r) => setTimeout(r, 300));

  // inject a note + run frames, pushing a boundary per frame
  const w = (off, v) => session.sid.write(0xD400 + off, v);
  w(0x00, 0x10); w(0x01, 0x20); w(0x05, 0x00); w(0x06, 0xf0); w(0x18, 0x0f); w(0x04, 0x11);
  for (let i = 0; i < 120; i++) { session.runFor(PAL_FRAME, { cycleBudget: PAL_FRAME }); host.boundary(); }

  // let the worker drain + render
  let avail = 0;
  for (let t = 0; t < 60; t++) { await new Promise((r) => setTimeout(r, 25)); avail = host.pcmAvailable(); if (avail > 10000) break; }
  gate("B worker rendered PCM, available on the main side", avail > 0, `available=${avail} samples`);

  const out = new Int16Array(4096);
  const n = host.pcmReadInto(4096, out);
  gate("B PCM reads back as samples (some non-zero)", n > 0 && out.subarray(0, n).some((s) => s !== 0), `read=${n}`);

  // 705.A stub: restore flushes transport without crashing
  let restored = false;
  host.onRestore = () => { restored = true; };
  host.restore({ residState: null, cycleAcc: 0, lastCycle: 0 });
  gate("C restore() flushes transport + fires onRestore (no crash)", restored && host.pcmAvailable() === 0, `availAfter=${host.pcmAvailable()}`);

  host.detach();
} finally {
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 768.3 host: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 768.3 host: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
