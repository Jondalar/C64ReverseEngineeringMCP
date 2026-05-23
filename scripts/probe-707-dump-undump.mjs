#!/usr/bin/env node
// Spec 707 — native .c64re dump/undump gates (acceptance §6).
//
//   G1 BASIC READY: dump → disturb → undump → immediate identity + run-N continuation.
//   G2 real media (motm.g64) + reSID active: dump → undump → continuation under 705/706.
//   G3 self-contained portability: undump the real-media .c64re into a FRESH session
//      (no disk mounted) → embedded media re-attaches → state matches (acceptance #3).
//   G4 integrity failure: a flipped body byte is rejected, not partially restored.
//   G5 version failure: an incompatible format version is rejected.
//   G6 dirty disk dump ACCEPTED (Spec 714.3 save_disks=1; old reject retired —
//      the mutated GCR now rides in the drive blob; 8.2 round-trip in probe-714).
//
// dumpRuntimeSnapshot/undumpRuntimeSnapshot ARE the same backend the Spec 623
// monitor dump/undump commands call (§4 single implementation).

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  startIntegratedSession, stopIntegratedSession,
} from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { SidAudioRecorder } from "../dist/runtime/headless/audio/sid-audio-recorder.js";
import {
  dumpRuntimeSnapshot, undumpRuntimeSnapshot,
} from "../dist/runtime/headless/kernel/snapshot-persistence.js";

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
    pc: cpu.pc & 0xffff, a: cpu.a & 0xff, x: cpu.x & 0xff, y: cpu.y & 0xff, sp: cpu.sp & 0xff,
    cycles: cpu.cycles >>> 0, rasterLine: r.line,
    ramHash: fnv1a(session.c64Bus.ram),
    drive: d ? `${(d.drive_pc ?? 0).toString(16)}/${d.drive_clk ?? 0}/${d.head_halftrack ?? 0}` : "n/a",
    iec: `${iec.line.atn ? 1 : 0}${iec.line.clk ? 1 : 0}${iec.line.data ? 1 : 0}`,
  };
}
function sigEqual(a, b) { for (const k of Object.keys(a)) if (a[k] !== b[k]) return { ok: false, k, a: a[k], b: b[k] }; return { ok: true }; }
function sigStr(s) { return `pc=${s.pc.toString(16)} cyc=${s.cycles} ram=${s.ramHash.toString(16)} drv=${s.drive}`; }
async function expectThrow(fn, frag) {
  try { await fn(); return { ok: false, msg: "no throw" }; }
  catch (e) { const m = String(e?.message ?? e); return { ok: m.toLowerCase().includes(frag.toLowerCase()), msg: m }; }
}

const dir = mkdtempSync(join(tmpdir(), "c64re-707-"));
console.log(`Spec 707 — native .c64re dump/undump gates  (tmp ${dir})`);

// ---- G1: BASIC roundtrip ---------------------------------------------------
{
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(1_500_000, { cycleBudget: 1_500_000 });
    const path = join(dir, "basic.c64re");
    const dumpRes = await dumpRuntimeSnapshot(ctrl, path);
    const sigAtDump = machineSig(session);
    gate("G1 dump wrote a .c64re file with a sane summary",
      existsSync(path) && dumpRes.fileBytes > 0 && dumpRes.media.length === 0,
      `${(dumpRes.fileBytes / 1024).toFixed(1)}KB pc=$${dumpRes.pc.toString(16)} media=${dumpRes.media.length}`);

    const RUN = 500_000;
    session.runFor(RUN, { cycleBudget: RUN });
    const sigControl = machineSig(session);

    await undumpRuntimeSnapshot(ctrl, path);
    const e1 = sigEqual(sigAtDump, machineSig(session));
    gate("G1 undump reproduces dump-time machine signature (immediate identity)", e1.ok,
      e1.ok ? sigStr(sigAtDump) : `mismatch ${e1.k}: ${e1.a} vs ${e1.b}`);

    session.runFor(RUN, { cycleBudget: RUN });
    const e2 = sigEqual(sigControl, machineSig(session));
    gate("G1 run-N continuation after undump matches control", e2.ok,
      e2.ok ? sigStr(sigControl) : `mismatch ${e2.k}: ${e2.a} vs ${e2.b}`);

    // G4/G5 reuse this file
    const bytes = readFileSync(path);
    const corrupt = Uint8Array.from(bytes); corrupt[corrupt.length - 8] ^= 0xff;
    const cpath = join(dir, "corrupt.c64re"); writeFileSync(cpath, corrupt);
    const r4 = await expectThrow(() => undumpRuntimeSnapshot(ctrl, cpath), "integrity");
    gate("G4 integrity failure (flipped byte) rejected, not partially restored", r4.ok, r4.msg.slice(0, 70));

    const badver = Uint8Array.from(bytes); badver[8] = 99;
    const vpath = join(dir, "badver.c64re"); writeFileSync(vpath, badver);
    const r5 = await expectThrow(() => undumpRuntimeSnapshot(ctrl, vpath), "version");
    gate("G5 incompatible format version rejected", r5.ok, r5.msg.slice(0, 70));
  } finally { stopIntegratedSession(sessionId); }
}

// ---- G2/G3/G6: real media (motm.g64) + reSID ------------------------------
const motm = resolve("samples/motm.g64");
let motmSnapPath;
let sigRealDump;
{
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  let recorder;
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.resetCold("pal-default");
    session.runFor(5_000_000, { cycleBudget: 5_000_000 });
    await mountMedia(session, 8, motm);
    session.typeText('LOAD"*",8,1\r');
    session.runFor(12_000_000, { cycleBudget: 12_000_000 }); // drive active, head positioned, NO write
    recorder = new SidAudioRecorder(session, { engine: "resid-wasm" }); // reSID active (706 audio provider)
    await recorder.resid.ready?.();

    motmSnapPath = join(dir, "motm.c64re");
    const dr = await dumpRuntimeSnapshot(ctrl, motmSnapPath);
    sigRealDump = machineSig(session);
    gate("G2 real-media dump embeds drive8 media", dr.media.length === 1 && dr.media[0].role === "drive8",
      `media=${dr.media.map((m) => `${m.role}:${m.format}:${(m.bytes / 1024).toFixed(0)}KB`).join(",")}`);

    const RUN = 800_000;
    session.runFor(RUN, { cycleBudget: RUN });
    const sigControl = machineSig(session);

    await undumpRuntimeSnapshot(ctrl, motmSnapPath); // reSID active → 706.8 flush runs, no throw
    const e1 = sigEqual(sigRealDump, machineSig(session));
    gate("G2 real-media undump immediate identity (CPU/VIC/drive/IEC, reSID active)", e1.ok,
      e1.ok ? sigStr(sigRealDump) : `mismatch ${e1.k}: ${e1.a} vs ${e1.b}`);
    session.runFor(RUN, { cycleBudget: RUN });
    const e2 = sigEqual(sigControl, machineSig(session));
    gate("G2 real-media run-N continuation matches control", e2.ok,
      e2.ok ? sigStr(sigControl) : `mismatch ${e2.k}: ${e2.a} vs ${e2.b}`);

    // G6 (Spec 714.3) — a written disk is now PERSISTABLE: the VICE1541 snapshot
    // runs save_disks=1, so the mutated GCR rides in the blob and the dump is
    // ACCEPTED (the old dirty-media abort is retired). The fresh-session round-
    // trip of the written bytes is gated by probe-714 (gate 8.2).
    const du = session.kernel.drive1541.diskunit;
    const gcr = du.drives[0].gcr;
    const trk = gcr.tracks.find((t) => t && t.data && t.size > 0);
    trk.data[0] = (trk.data[0] ^ 0xff) & 0xff; // a write that was "flushed" to the image
    let g6ok = false, g6msg = "";
    try { await dumpRuntimeSnapshot(ctrl, join(dir, "dirty.c64re")); g6ok = true; }
    catch (e) { g6msg = String(e?.message ?? e).slice(0, 80); }
    gate("G6 dirty disk dump is ACCEPTED (714.3 save_disks=1; reject retired)", g6ok, g6msg);
  } finally { recorder?.detach?.(); stopIntegratedSession(sessionId); }
}

// ---- G3: undump the real-media snapshot into a FRESH session ---------------
if (motmSnapPath && sigRealDump) {
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(1_000_000, { cycleBudget: 1_000_000 }); // fresh, no disk mounted
    await undumpRuntimeSnapshot(ctrl, motmSnapPath); // embedded media re-attaches
    const e = sigEqual(sigRealDump, machineSig(session));
    gate("G3 self-contained: undump into a FRESH session reproduces dump state", e.ok,
      e.ok ? sigStr(sigRealDump) : `mismatch ${e.k}: ${e.a} vs ${e.b}`);
  } finally { stopIntegratedSession(sessionId); }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 707 dump/undump: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 707 dump/undump: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
