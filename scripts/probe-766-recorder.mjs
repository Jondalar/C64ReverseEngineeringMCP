#!/usr/bin/env node
// Spec 766.5a — the emulation-thread recorder host (RuntimeRecorder): zero-alloc
// anchor encode → shared ring → worker store, queried back over the async API.
//
//   A) captureAnchor ships anchors: after a few captures the worker store holds
//      them; stats reflect the newest cycle.
//   B) byte-exact reconstruct over the wire: getAnchor(seq) → decodeAnchor →
//      deep-equals the captured snapshot payload.
//   C) restore fidelity: restoring the decoded payload reproduces the capture-
//      time machine signature (the anchor really is a faithful checkpoint).
//   D) hot-path discipline: many captures reuse the encoder scratch (~no heap
//      growth on the producer side).

import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeRecorder } from "../dist/runtime/headless/recorder/runtime-recorder.js";
import { decodeAnchor } from "../dist/runtime/headless/recorder/anchor-codec.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}
function fnv1a(bytes) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function machineSig(session) {
  const cpu = session.c64Cpu; const r = session.vicRaster();
  return { pc: cpu.pc & 0xffff, a: cpu.a & 0xff, x: cpu.x & 0xff, y: cpu.y & 0xff, sp: cpu.sp & 0xff,
    cycles: cpu.cycles >>> 0, rasterLine: r.line, rasterCycle: r.cycle, ramHash: fnv1a(session.c64Bus.ram) };
}
function sigEq(a, b) { for (const k of Object.keys(a)) if (a[k] !== b[k]) return { ok: false, k, a: a[k], b: b[k] }; return { ok: true }; }
function deepEq(a, b, path = "") {
  if (a === b) return null;
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b) ? null : `num@${path}:${a}!=${b}`;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return `typed@${path}`;
    if (a.constructor !== b.constructor || a.byteLength !== b.byteLength) return `tctor/len@${path}`;
    const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return `byte@${path}[${i}]`;
    return null;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `arr@${path}`;
    for (let i = 0; i < a.length; i++) { const e = deepEq(a[i], b[i], `${path}[${i}]`); if (e) return e; }
    return null;
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return `keys@${path}:${ka.length}!=${kb.length}`;
    for (const k of ka) { const e = deepEq(a[k], b[k], `${path}.${k}`); if (e) return e; }
    return null;
  }
  return `prim@${path}`;
}

console.log("Spec 766.5a — runtime recorder host");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
const recorder = new RuntimeRecorder({ capacityBytes: 4 * 1024 * 1024 });
try {
  session.runFor(1_500_000, { cycleBudget: 1_500_000 });

  // capture a handful of anchors at increasing cycles; keep the LAST snapshot
  // for the byte-exact + fidelity checks.
  let lastSnap = null, lastCycle = 0;
  for (let i = 0; i < 6; i++) {
    session.runFor(50_000, { cycleBudget: 50_000 });
    lastSnap = session.kernel.snapshot({ shallow: true, omitFramebuffer: true });
    lastCycle = session.c64Cpu.cycles;
    recorder.captureAnchor(lastSnap.payload, lastCycle, i * 500, session.kernel);
  }
  const sigAtCp = machineSig(session);

  await new Promise((r) => setTimeout(r, 80)); // let the worker drain

  const stats = await recorder.stats();
  gate("A worker stored the captured anchors", stats.anchorCount > 0 && stats.newestCycle === lastCycle,
    `count=${stats.anchorCount}, newest=${stats.newestCycle}, produced=${recorder.produced}, dropped=${stats.dropped}`);

  const ref = await recorder.findByCycle(lastCycle);
  const got = ref ? await recorder.getAnchor(ref.seq) : null;
  const decoded = got ? decodeAnchor(new Uint8Array(got.bytes)) : null;
  const e = decoded ? deepEq(lastSnap.payload, decoded) : "no anchor";
  gate("B getAnchor → decode → byte-exact equals captured payload", e === null, e ?? `seq=${ref?.seq}, bytes=${got?.bytes?.byteLength}`);

  // C — restore fidelity
  session.runFor(400_000, { cycleBudget: 400_000 });
  const sigControl = machineSig(session);
  if (decoded) session.kernel.restore({ schemaVersion: lastSnap.schemaVersion, payload: decoded });
  const e1 = sigEq(sigAtCp, machineSig(session));
  gate("C restore(decoded anchor) reproduces capture-time signature", e1.ok,
    e1.ok ? `pc=${sigAtCp.pc.toString(16)} ram=${sigAtCp.ramHash.toString(16)}` : `mismatch ${e1.k}: ${e1.a} vs ${e1.b}`);
  session.runFor(400_000, { cycleBudget: 400_000 });
  const e2 = sigEq(sigControl, machineSig(session));
  gate("C forward continuation after restore matches control", e2.ok,
    e2.ok ? `pc=${sigControl.pc.toString(16)}` : `mismatch ${e2.k}: ${e2.a} vs ${e2.b}`);

  // D — producer hot-path: repeated captures reuse the scratch
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const snap = session.kernel.snapshot({ shallow: true, omitFramebuffer: true });
  for (let i = 0; i < 500; i++) recorder.captureAnchor(snap.payload, 2_000_000 + i, i, session.kernel);
  if (global.gc) global.gc();
  const grewMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
  gate("D 500 captures reuse the encoder scratch (~no heap growth)",
    grewMiB < 8 && global.gc !== undefined, `Δ=${grewMiB.toFixed(2)} MiB${global.gc ? "" : " (run with --expose-gc!)"}`);
} finally {
  recorder.dispose();
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 766.5a recorder: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 766.5a recorder: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
