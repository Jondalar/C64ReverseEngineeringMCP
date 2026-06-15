#!/usr/bin/env node
// Spec 705.B — automatic checkpoint ring + pin/restore lifecycle.
//
// Built on the green 705.A RuntimeCheckpoint. Proves:
//   A) ring POLICY (synthetic snapshots, small budget — fast + deterministic):
//      A1 bytes-budget eviction drops OLDEST-first, total stays ≤ budget;
//      A2 a PINNED checkpoint survives eviction even when it is the oldest;
//      A3 unpin makes it reclaimable again.
//   B) ring CONTINUATION through the controller (real session):
//      B1 captureCheckpoint() → run N → restoreCheckpoint() restores the exact
//         machine signature at capture (byte-identical RAM/regs/raster/drive);
//      B2 running N more after restore reproduces the control signature
//         (deterministic forward continuation from a ring checkpoint).
//
// NOT here: persistence/dump-undump (later slice), replay event-log (§3.5),
// rewind UI. Pin is the only durability primitive in 705.B.

import {
  startIntegratedSession,
  stopIntegratedSession,
} from "../dist/runtime/headless/integrated-session-manager.js";
import {
  RuntimeCheckpointRing,
  SLOT_BYTES,
} from "../dist/runtime/headless/kernel/runtime-checkpoint-ring.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail });
  console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}
function fnv1a(bytes) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function machineSig(session) {
  const cpu = session.c64Cpu;
  const r = session.vicRaster();
  const d = session.kernel.drive1541?.debugProbe?.() ?? null;
  const iec = session.iecBus.snapshot();
  return {
    pc: cpu.pc & 0xffff, a: cpu.a & 0xff, x: cpu.x & 0xff, y: cpu.y & 0xff,
    sp: cpu.sp & 0xff, cycles: cpu.cycles >>> 0,
    rasterLine: r.line, rasterCycle: r.cycle,
    ramHash: fnv1a(session.c64Bus.ram),
    frameHash: session.literalPortFbStable ? fnv1a(session.literalPortFbStable) : -1,
    drive: d ? `${(d.drive_pc ?? 0).toString(16)}/${d.drive_clk ?? 0}/${d.head_halftrack ?? 0}` : "n/a",
  };
}
function sigEqual(a, b) {
  for (const k of Object.keys(a)) if (a[k] !== b[k]) return { ok: false, k, a: a[k], b: b[k] };
  return { ok: true };
}
function sigStr(s) { return `pc=${s.pc.toString(16)} cyc=${s.cycles} ry=${s.rasterLine} ram=${s.ramHash.toString(16)} fr=${s.frameHash.toString(16)} drv=${s.drive}`; }

// Spec 765 — synthetic checkpoint with the REAL big-buffer shape (RAM 64 KiB;
// framebuffers omitted = null, valid). The flat ring copies RAM into its slab,
// so the fixture must be the real size (the ring rejects others).
function fakeSnap() { return { schemaVersion: 1, payload: { ram: new Uint8Array(0x10000) } }; }

console.log("Spec 705.B / 765 — checkpoint ring + pin/restore lifecycle");

// ---- Part A: ring policy (synthetic, deterministic) ------------------------
// Spec 765 — the ring is now a fixed flat slab of N = floor(budget / SLOT_BYTES)
// slots; eviction reclaims the OLDEST unpinned slot (same semantics as the old
// bytes-budget model, just slot-granular). Budget sized for exactly 4 slots.
{
  const ring = new RuntimeCheckpointRing({ budgetBytes: SLOT_BYTES * 4 }); // 4 slots
  const refs = [];
  for (let i = 0; i < 10; i++) refs.push(ring.capture(fakeSnap(), i, i * 1000));
  const s = ring.stats();
  gate("A1 slot-budget eviction keeps total ≤ budget", s.totalBytes <= ring.budgetBytes && s.slotCount === 4,
    `${(s.totalBytes / 1024).toFixed(0)} KB ≤ ${(ring.budgetBytes / 1024).toFixed(0)} KB, slots=${s.slotCount}, count=${s.count}`);
  gate("A1 oldest evicted, newest retained",
    !ring.has(refs[0].id) && ring.has(refs[9].id) && s.count === 4,
    `count=${s.count}, oldest present=${ring.has(refs[0].id)}, newest present=${ring.has(refs[9].id)}`);

  // A2: pin the OLDEST surviving entry, then flood — it must survive.
  const survivors = ring.list();
  const pinId = survivors[0].id;
  ring.pin(pinId);
  for (let i = 10; i < 30; i++) ring.capture(fakeSnap(), i, i * 1000);
  gate("A2 pinned checkpoint survives eviction (even as oldest)", ring.has(pinId),
    `pinnedCount=${ring.stats().pinnedCount}, total=${(ring.stats().totalBytes / 1024).toFixed(0)} KB`);

  // A3: unpin → reclaimable; another flood evicts it.
  ring.unpin(pinId);
  for (let i = 30; i < 50; i++) ring.capture(fakeSnap(), i, i * 1000);
  gate("A3 unpinned checkpoint becomes reclaimable", !ring.has(pinId),
    `present after unpin+flood=${ring.has(pinId)}`);
}

// ---- Part B: real ring capture → restore continuation ----------------------
const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
try {
  const ctrl = new RuntimeController(sessionId, session, () => {});

  // settle to a mid-frame instruction boundary
  session.runFor(1_500_000, { cycleBudget: 1_500_000 });
  session.runFor(20_000, { cycleBudget: 20_000 });

  const ref = await ctrl.captureCheckpoint();   // paused → synchronous take()
  const sigAtCp = machineSig(session);
  gate("B0 captureCheckpoint stored a ring ref", !!ref && ctrl.checkpointRing.has(ref.id),
    `id=${ref?.id}, byteSize=${((ref?.byteSize ?? 0) / 1024).toFixed(0)} KB`);

  const RUN = 500_000;
  session.runFor(RUN, { cycleBudget: RUN });
  const sigControl = machineSig(session);

  await ctrl.restoreCheckpoint(ref.id);
  const sigAfterRestore = machineSig(session);
  const e1 = sigEqual(sigAtCp, sigAfterRestore);
  gate("B1 restoreCheckpoint reproduces capture-time machine signature", e1.ok,
    e1.ok ? sigStr(sigAtCp) : `mismatch ${e1.k}: ${e1.a} vs ${e1.b}`);

  session.runFor(RUN, { cycleBudget: RUN });
  const sigReplay = machineSig(session);
  const e2 = sigEqual(sigControl, sigReplay);
  gate("B2 forward continuation after restore matches control", e2.ok,
    e2.ok ? sigStr(sigControl) : `mismatch ${e2.k}: ${e2.a} vs ${e2.b}`);
} finally {
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) {
  console.log(`GREEN 705.B ring: ${passes} checks pass.`);
  process.exit(0);
}
console.log(`RED 705.B ring: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
