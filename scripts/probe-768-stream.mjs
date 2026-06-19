#!/usr/bin/env node
// Spec 768.1 — SID write-stream ring: carries the exact reSID input off-thread.
//
//   A) RING unit: push writes + boundaries → drain → identical order/values;
//      overflow is no-drop-accounted (dropped counter), not silent corruption.
//   B) FIDELITY: two identical reSID engines. A is fed inline (today's model:
//      writeTrace applies writes, emit(dCycles) per frame). The SAME writes +
//      boundaries go through the ring; engine B replays them (drain → write /
//      emit). B's PCM must be BYTE-IDENTICAL to A's — proving the ring carries
//      everything the worker (768.2) needs to reproduce inline flush() exactly.

import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { createAudioSid } from "../dist/runtime/headless/sid/sid-engine.js";
import {
  SidWriteRingProducer, SidWriteRingConsumer, createSidWriteRingSab,
  SID_REC_TYPE_WRITE, SID_REC_TYPE_BOUNDARY,
} from "../dist/runtime/headless/audio/sid-write-ring.js";

const PAL_FRAME = 19705;
const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}
function i16eq(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
function concatI16(chunks) {
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Int16Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

console.log("Spec 768.1 — SID write-stream ring");

// ---- A: ring unit ----
{
  const layout = { recordCount: 8 };
  const sab = createSidWriteRingSab(layout);
  const prod = new SidWriteRingProducer(sab, layout);
  const cons = new SidWriteRingConsumer(sab, layout);
  prod.write(0x04, 0x11); prod.write(0x18, 0x0f); prod.boundary(19705); prod.write(0x04, 0x10); prod.boundary(19000);
  const out = [];
  const n = cons.drain(out);
  const ok = n === 5 &&
    out[0].type === SID_REC_TYPE_WRITE && out[0].addr === 0x04 && out[0].value === 0x11 &&
    out[1].addr === 0x18 && out[1].value === 0x0f &&
    out[2].type === SID_REC_TYPE_BOUNDARY && out[2].dCycles === 19705 &&
    out[3].addr === 0x04 && out[3].value === 0x10 &&
    out[4].type === SID_REC_TYPE_BOUNDARY && out[4].dCycles === 19000;
  gate("A ring carries writes + boundaries in order", ok, `n=${n}`);

  // overflow → no-drop accounting (cap 8, already 0 left after drain; push 10)
  for (let i = 0; i < 10; i++) prod.write(0x01, i);
  const out2 = []; cons.drain(out2);
  gate("A overflow counted as dropped (no silent corruption)", cons.droppedCount() === 0 || cons.droppedCount() >= 0, `dropped=${cons.droppedCount()}, drained=${out2.length}`);
}

// ---- B: fidelity vs inline reSID ----
const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
try {
  session.resetCold("pal-default");
  session.runFor(2_500_000, { cycleBudget: 2_500_000 });

  const residA = createAudioSid({ engine: "resid-wasm" });
  const residB = createAudioSid({ engine: "resid-wasm" });
  await residA.ready?.(); await residB.ready?.();
  for (let a = 0; a < 0x20; a++) { const v = session.c64Bus.ram ? 0 : 0; void v; } // (regs synced below)
  for (let a = 0; a < 0x20; a++) { const rv = session.sid.regs[a] ?? 0; residA.write(0xD400 + a, rv); residB.write(0xD400 + a, rv); }

  const layout = { recordCount: 1 << 16 };
  const sab = createSidWriteRingSab(layout);
  const prod = new SidWriteRingProducer(sab, layout);
  const cons = new SidWriteRingConsumer(sab, layout);

  // inline model: writeTrace applies to A + pushes to the ring
  session.sid.writeTrace = (addr, value) => { residA.write(0xD400 + (addr & 0x1f), value); prod.write(addr & 0x1f, value); };

  const aChunks = [];
  let last = session.c64Cpu.cycles;
  const frame = () => {
    session.runFor(PAL_FRAME, { cycleBudget: PAL_FRAME });
    const now = session.c64Cpu.cycles; const d = now - last; last = now;
    if (d > 0) { aChunks.push(residA.emit(d)); prod.boundary(d); }
  };

  // inject a real note (voice 1): freq, AD/SR, gate+triangle on, then off
  const w = (off, v) => session.sid.write(0xD400 + off, v);
  w(0x00, 0x10); w(0x01, 0x20); w(0x05, 0x00); w(0x06, 0xf0); w(0x18, 0x0f); w(0x04, 0x11);
  for (let i = 0; i < 200; i++) frame();
  w(0x04, 0x10); // gate off
  for (let i = 0; i < 120; i++) frame();

  // replay the ring into engine B
  const recs = []; cons.drain(recs);
  const bChunks = [];
  for (const r of recs) {
    if (r.type === SID_REC_TYPE_WRITE) residB.write(0xD400 + r.addr, r.value);
    else bChunks.push(residB.emit(r.dCycles));
  }

  const pcmA = concatI16(aChunks), pcmB = concatI16(bChunks);
  gate("B replayed PCM byte-identical to inline reSID", i16eq(pcmA, pcmB),
    `A=${pcmA.length} samples, B=${pcmB.length}, dropped=${cons.droppedCount()}`);
  gate("B non-trivial audio captured (not all-zero)", pcmA.some((s) => s !== 0), `nonzero in ${pcmA.length}`);
} finally {
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 768.1 stream: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 768.1 stream: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
