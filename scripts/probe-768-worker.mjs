#!/usr/bin/env node
// Spec 768.2 — reSID worker renders byte-identical PCM, off-thread.
//
// Reference: an inline reSID engine (today's model — writeTrace applies writes,
// emit(dCycles) per frame). The SAME writes + boundaries are captured into the
// SID write-ring. A real resid-worker (own thread, own reSID-wasm) drains the ring
// and renders into the PCM ring. The PCM the worker produces must be BYTE-
// IDENTICAL to the inline reference — the fidelity bar for moving reSID off the
// emulation thread.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { createAudioSid } from "../dist/runtime/headless/sid/sid-engine.js";
import { SidWriteRingProducer, createSidWriteRingSab } from "../dist/runtime/headless/audio/sid-write-ring.js";
import { SidPcmRingConsumer, createSidPcmRingSab } from "../dist/runtime/headless/audio/sid-pcm-ring.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAL_FRAME = 19705;
const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}
function concatI16(chunks) { let n = 0; for (const c of chunks) n += c.length; const o = new Int16Array(n); let p = 0; for (const c of chunks) { o.set(c, p); p += c.length; } return o; }

console.log("Spec 768.2 — reSID worker (off-thread, byte-identical PCM)");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
let aPcm, bPcm, dropped = 0;
try {
  session.resetCold("pal-default");
  session.runFor(2_500_000, { cycleBudget: 2_500_000 });

  const residA = createAudioSid({ engine: "resid-wasm" });
  await residA.ready?.();
  const initialRegs = Array.from({ length: 0x20 }, (_, a) => session.sid.regs[a] ?? 0);
  for (let a = 0; a < 0x20; a++) residA.write(0xD400 + a, initialRegs[a]);

  const wlayout = { recordCount: 1 << 16 };
  const wsab = createSidWriteRingSab(wlayout);
  const prod = new SidWriteRingProducer(wsab, wlayout);
  const plLayout = { capacitySamples: 1 << 20 };
  const psab = createSidPcmRingSab(plLayout);
  const pcmCons = new SidPcmRingConsumer(psab, plLayout);

  // capture: writeTrace → inline residA + the write-ring
  session.sid.writeTrace = (addr, value) => { residA.write(0xD400 + (addr & 0x1f), value); prod.write(addr & 0x1f, value); };
  const aChunks = [];
  let last = session.c64Cpu.cycles;
  const frame = () => {
    session.runFor(PAL_FRAME, { cycleBudget: PAL_FRAME });
    const now = session.c64Cpu.cycles, d = now - last; last = now;
    if (d > 0) { aChunks.push(residA.emit(d)); prod.boundary(d); }
  };
  const w = (off, v) => session.sid.write(0xD400 + off, v);
  w(0x00, 0x10); w(0x01, 0x20); w(0x05, 0x00); w(0x06, 0xf0); w(0x18, 0x0f); w(0x04, 0x11);
  for (let i = 0; i < 200; i++) frame();
  w(0x04, 0x10);
  for (let i = 0; i < 120; i++) frame();
  aPcm = concatI16(aChunks);
  const totalRecords = prod.headCount();

  // spawn the worker; it drains the write-ring + renders into the PCM ring
  const worker = new Worker(resolve(here, "../dist/runtime/headless/audio/resid-worker.js"), {
    workerData: { writeRingSab: wsab, writeLayout: wlayout, pcmRingSab: psab, pcmLayout: plLayout, engine: "resid-wasm", initialRegs },
  });
  await new Promise((res, rej) => {
    worker.on("error", rej);
    worker.on("message", (m) => { if (m.type === "ready") res(); });
  });
  // wait until the worker has produced ~all the reference samples (drained fully)
  for (let t = 0; t < 200; t++) {
    await new Promise((r) => setTimeout(r, 25));
    if (pcmCons.available() >= aPcm.length) break;
  }
  // read everything the worker rendered
  const bChunks = [];
  const buf = new Int16Array(1 << 16);
  let got;
  while ((got = pcmCons.readInto(buf.length, buf)) > 0) bChunks.push(buf.slice(0, got));
  bPcm = concatI16(bChunks);
  dropped = pcmCons.droppedCount();
  await new Promise((r) => { worker.once("message", (m) => m.type === "stopped" && r()); worker.postMessage({ type: "stop" }); });
  await worker.terminate();
  void totalRecords;
} finally {
  stopIntegratedSession(sessionId);
}

let firstDiff = -1;
const n = Math.min(aPcm.length, bPcm.length);
for (let i = 0; i < n; i++) if (aPcm[i] !== bPcm[i]) { firstDiff = i; break; }
gate("worker PCM length matches inline reference", aPcm.length === bPcm.length, `inline=${aPcm.length} worker=${bPcm.length} dropped=${dropped}`);
gate("worker PCM byte-identical to inline reSID (off-thread)", firstDiff === -1 && aPcm.length === bPcm.length,
  firstDiff === -1 ? `${n} samples match` : `first diff @${firstDiff}: ${aPcm[firstDiff]} vs ${bPcm[firstDiff]}`);

console.log("---");
if (failures.length === 0) { console.log(`GREEN 768.2 worker: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 768.2 worker: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
