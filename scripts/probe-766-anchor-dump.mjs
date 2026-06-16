#!/usr/bin/env node
// Spec 766.5c-1 — dump a recorder anchor to .c64re, undump into a FRESH session.
//
// The recorder's unique payoff: pick a past scrub point from the cheap worker
// history and persist it as a durable .c64re (then replay it with tracing on).
//
//   A) dumpRecorderAnchorSnapshot writes a .c64re from a worker anchor (seq),
//      listing the embedded media (drive8).
//   B) undumpRuntimeSnapshot into a FRESH session reproduces the anchor's
//      capture-time machine signature (CPU/RAM/drive) — self-contained restore.

import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { RuntimeRecorder } from "../dist/runtime/headless/recorder/runtime-recorder.js";
import { dumpRecorderAnchorSnapshot, undumpRuntimeSnapshot } from "../dist/runtime/headless/kernel/snapshot-persistence.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}
function fnv1a(b) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function machineSig(session) {
  const cpu = session.c64Cpu;
  const d = session.kernel.drive1541?.debugProbe?.() ?? null;
  return { pc: cpu.pc & 0xffff, a: cpu.a & 0xff, x: cpu.x & 0xff, y: cpu.y & 0xff, sp: cpu.sp & 0xff,
    ramHash: fnv1a(session.c64Bus.ram),
    drive: d ? `${(d.drive_pc ?? 0).toString(16)}/${d.head_halftrack ?? 0}` : "n/a" };
}
function sigEq(a, b) { for (const k of Object.keys(a)) if (a[k] !== b[k]) return { ok: false, k, a: a[k], b: b[k] }; return { ok: true }; }

console.log("Spec 766.5c-1 — recorder anchor → .c64re dump/undump");

const d64 = resolve("samples/fixtures/load-fidelity/lf-004-100block.d64");
const snapPath = join(tmpdir(), `anchor-dump-${process.pid}.c64re`);

let sigAtCp;
{
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  const ctrl = new RuntimeController(sessionId, session, () => {});
  // Recorder default is opt-in (C64RE_RECORDER=1); the probe forces it explicitly
  // so it does not depend on the env flag.
  ctrl.recorder = new RuntimeRecorder({ capacityBytes: 8 * 1024 * 1024 });
  try {
    session.resetCold("pal-default");
    session.runFor(5_000_000, { cycleBudget: 5_000_000 });
    await mountMedia(session, 8, d64);
    session.typeText('LOAD"*",8,1\r');
    session.runFor(12_000_000, { cycleBudget: 12_000_000 });
    session.kernel.drive1541.snapshotDiskImage(); // settle pending writeback

    const a = session.kernel.snapshot({ shallow: true, omitFramebuffer: true, omitMedia: true });
    const cycle = session.c64Cpu.cycles;
    ctrl.recorder.captureAnchor(a.payload, cycle, 1000, a.schemaVersion, session.kernel);
    sigAtCp = machineSig(session);

    await new Promise((r) => setTimeout(r, 80)); // worker drain

    const ref = await ctrl.recorder.findByCycle(cycle);
    const dr = await dumpRecorderAnchorSnapshot(ctrl, ref.seq, snapPath);
    gate("A dump writes a .c64re with embedded drive8 media",
      dr.fileBytes > 0 && dr.media.some((m) => m.role === "drive8"),
      `seq=${ref?.seq} bytes=${dr.fileBytes} media=[${dr.media.map((m) => `${m.role}:${m.format}:${((m.bytes) / 1024) | 0}KB`).join(",")}]`);
  } finally {
    ctrl.dispose();
    stopIntegratedSession(sessionId);
  }
}

// B — undump into a FRESH session, reproduce the captured signature
{
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  const ctrl = new RuntimeController(sessionId, session, () => {});
  try {
    session.resetCold("pal-default");
    await undumpRuntimeSnapshot(ctrl, snapPath);
    const e = sigEq(sigAtCp, machineSig(session));
    gate("B undump into a fresh session reproduces the anchor signature", e.ok,
      e.ok ? `pc=${sigAtCp.pc.toString(16)} ram=${sigAtCp.ramHash.toString(16)} drv=${sigAtCp.drive}` : `mismatch ${e.k}: ${e.a} vs ${e.b}`);
  } finally {
    ctrl.dispose();
    stopIntegratedSession(sessionId);
  }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 766.5c-1 anchor-dump: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 766.5c-1 anchor-dump: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
