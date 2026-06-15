#!/usr/bin/env node
// Spec 766.2 — generic compact-binary anchor codec round-trip + fidelity gate.
//
//   A) STRUCTURAL byte-exact: a real kernel.snapshot() payload → encode → decode
//      → deep-equal (every number, string, typed-array byte, array, nested object).
//   B) FIDELITY: restore the DECODED payload into the machine → it reproduces the
//      capture-time machine signature; run-on matches a control (like probe-705b).
//   C) zero-alloc-after-warmup: repeated encodes reuse the scratch buffer.

import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { AnchorEncoder, decodeAnchor } from "../dist/runtime/headless/recorder/anchor-codec.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}

function fnv1a(bytes) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function machineSig(session) {
  const cpu = session.c64Cpu; const r = session.vicRaster();
  const d = session.kernel.drive1541?.debugProbe?.() ?? null;
  return {
    pc: cpu.pc & 0xffff, a: cpu.a & 0xff, x: cpu.x & 0xff, y: cpu.y & 0xff, sp: cpu.sp & 0xff, cycles: cpu.cycles >>> 0,
    rasterLine: r.line, rasterCycle: r.cycle, ramHash: fnv1a(session.c64Bus.ram),
    frameHash: session.literalPortFbStable ? fnv1a(session.literalPortFbStable) : -1,
    drive: d ? `${(d.drive_pc ?? 0).toString(16)}/${d.drive_clk ?? 0}/${d.head_halftrack ?? 0}` : "n/a",
  };
}
function sigEq(a, b) { for (const k of Object.keys(a)) if (a[k] !== b[k]) return { ok: false, k, a: a[k], b: b[k] }; return { ok: true }; }

// Deep structural compare, byte-exact for typed arrays.
function deepEq(a, b, path = "") {
  if (a === b) return null;
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b) ? null : `num@${path}: ${a} vs ${b}`;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return `typed-vs-not@${path}`;
    if (a.constructor !== b.constructor) return `ctor@${path}: ${a.constructor.name} vs ${b.constructor.name}`;
    if (a.byteLength !== b.byteLength) return `byteLen@${path}: ${a.byteLength} vs ${b.byteLength}`;
    const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return `byte@${path}[${i}]: ${ua[i]} vs ${ub[i]}`;
    return null;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `arr-vs-not@${path}`;
    if (a.length !== b.length) return `arrLen@${path}: ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const e = deepEq(a[i], b[i], `${path}[${i}]`); if (e) return e; }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return `keys@${path}: ${ka.length} vs ${kb.length} (${ka}|${kb})`;
    for (const k of ka) { const e = deepEq(a[k], b[k], `${path}.${k}`); if (e) return e; }
    return null;
  }
  return `prim@${path}: ${a} vs ${b}`;
}

console.log("Spec 766.2 — generic compact-binary anchor codec");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
try {
  session.runFor(1_500_000, { cycleBudget: 1_500_000 });
  session.runFor(20_000, { cycleBudget: 20_000 });

  const snap = session.kernel.snapshot();              // full real payload
  const sigAtCp = machineSig(session);

  const enc = new AnchorEncoder();
  const encoded = enc.encode(snap.payload);
  const wire = encoded.slice();                        // detach from the scratch
  const decoded = decodeAnchor(wire);

  // A — structural byte-exact
  const e = deepEq(snap.payload, decoded);
  gate("A structural byte-exact round-trip", e === null, e ?? `${wire.length} bytes encoded`);

  // B — fidelity: restore the DECODED payload, reproduce capture-time signature
  const RUN = 500_000;
  session.runFor(RUN, { cycleBudget: RUN });
  const sigControl = machineSig(session);

  session.kernel.restore({ schemaVersion: snap.schemaVersion, payload: decoded });
  const sigAfter = machineSig(session);
  const e1 = sigEq(sigAtCp, sigAfter);
  gate("B restore(decoded) reproduces capture-time signature", e1.ok,
    e1.ok ? `pc=${sigAtCp.pc.toString(16)} ram=${sigAtCp.ramHash.toString(16)} drv=${sigAtCp.drive}` : `mismatch ${e1.k}: ${e1.a} vs ${e1.b}`);

  session.runFor(RUN, { cycleBudget: RUN });
  const e2 = sigEq(sigControl, machineSig(session));
  gate("B forward continuation after restore matches control", e2.ok,
    e2.ok ? `pc=${sigControl.pc.toString(16)} ram=${sigControl.ramHash.toString(16)}` : `mismatch ${e2.k}: ${e2.a} vs ${e2.b}`);

  // C — zero alloc after warmup: scratch reused, encoded view points into it
  const len1 = enc.encode(snap.payload).length;
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  let lastLen = 0;
  for (let i = 0; i < 2000; i++) lastLen = enc.encode(snap.payload).length;
  if (global.gc) global.gc();
  const grewMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
  gate("C 2000 re-encodes reuse the scratch (~no heap growth)",
    Math.abs(grewMiB) < 4 && lastLen === len1 && global.gc !== undefined,
    `Δ=${grewMiB.toFixed(2)} MiB, len=${lastLen}${global.gc ? "" : " (run with --expose-gc!)"}`);
} finally {
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 766.2 codec: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 766.2 codec: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
