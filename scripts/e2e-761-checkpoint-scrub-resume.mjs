#!/usr/bin/env node
// Spec 761 — checkpoint scrub + resume (ring-bound rewind, then run on).
//
// Proves the user-facing contract on top of the already-green 705.B restore:
//   1  then:"pause"  — scrub-and-look: restore reaches the anchor signature AND
//      leaves the controller paused.
//   2  then:"run"    — resume-from-X: restore (re)starts the autonomous loop AND
//      auto-pins the resumed-from anchor (OQ2) so the branch point survives.
//   3  determinism   — restore (then:"keep") + run the same span forward
//      re-reaches the control signature, drive head included.
//   4  floppy rollback — a simulated disk write between the anchor and "now" is
//      rolled back by restore (driveDiskImage overlay, mutable-wins §6.1).
//
// Floppy correctness invariant (§4): restore moves the C64 and the 1541 to the
// SAME instant — tests 3+4 assert drive head + disk content come along.

import {
  startIntegratedSession,
  stopIntegratedSession,
} from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

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
  return {
    pc: cpu.pc & 0xffff, a: cpu.a & 0xff, x: cpu.x & 0xff, y: cpu.y & 0xff,
    sp: cpu.sp & 0xff, cycles: cpu.cycles >>> 0,
    rasterLine: r.line, rasterCycle: r.cycle,
    ramHash: fnv1a(session.c64Bus.ram),
    drive: d ? `${(d.drive_pc ?? 0).toString(16)}/${d.drive_clk ?? 0}/${d.head_halftrack ?? 0}` : "n/a",
  };
}
function sigEqual(a, b) {
  for (const k of Object.keys(a)) if (a[k] !== b[k]) return { ok: false, k, a: a[k], b: b[k] };
  return { ok: true };
}
function sigStr(s) { return `pc=${s.pc.toString(16)} cyc=${s.cycles} ry=${s.rasterLine} ram=${s.ramHash.toString(16)} drv=${s.drive}`; }
function diskHash(facade) {
  const img = facade.snapshotDiskImage();
  return img ? fnv1a(img) : -1;
}

console.log("Spec 761 — checkpoint scrub + resume\n");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
try {
  await mountMedia(session, 8, resolve("samples/fixtures/load-fidelity/lf-004-100block.d64"));
  const ctrl = new RuntimeController(sessionId, session, () => {});
  const facade = session.kernel.drive1541;

  // settle to a mid-frame boundary with the drive spun up
  session.runFor(1_500_000, { cycleBudget: 1_500_000 });
  session.runFor(20_000, { cycleBudget: 20_000 });

  const anchor = await ctrl.captureCheckpoint();
  const sigAnchor = machineSig(session);
  const diskAnchor = diskHash(facade);
  gate("0 anchor captured with disk image", !!anchor && ctrl.checkpointRing.has(anchor.id) && diskAnchor !== -1,
    `id=${anchor?.id} diskHash=${diskAnchor.toString(16)}`);

  const RUN = 500_000;

  // ---- Test 1: then:"pause" — scrub-and-look ------------------------------
  session.runFor(RUN, { cycleBudget: RUN });
  await ctrl.restoreCheckpoint(anchor.id, { then: "pause" });
  const sig1 = machineSig(session);
  const e1 = sigEqual(sigAnchor, sig1);
  gate("1 then:pause reaches the anchor signature", e1.ok,
    e1.ok ? sigStr(sigAnchor) : `mismatch ${e1.k}: ${e1.a} vs ${e1.b}`);
  gate("1b then:pause leaves the controller paused", ctrl.runState === "paused", `runState=${ctrl.runState}`);

  // ---- Test 2: then:"run" — resume-from-X ---------------------------------
  await ctrl.restoreCheckpoint(anchor.id, { then: "run" });
  const running = ctrl.runState === "running";
  const pinned = !!ctrl.checkpointRing.get(anchor.id)?.pinned;
  ctrl.pause(); // stop the scheduled loop so the test process can exit
  gate("2 then:run (re)starts the autonomous loop", running, `runState was ${running ? "running" : ctrl.runState}`);
  gate("2b then:run auto-pins the resumed-from anchor (OQ2)", pinned, `pinned=${pinned}`);

  // ---- Test 3: determinism — restore then run the span forward -------------
  await ctrl.restoreCheckpoint(anchor.id, { then: "keep" });
  session.runFor(RUN, { cycleBudget: RUN });
  const sigControl = machineSig(session);
  await ctrl.restoreCheckpoint(anchor.id, { then: "keep" });
  session.runFor(RUN, { cycleBudget: RUN });
  const sigReplay = machineSig(session);
  const e3 = sigEqual(sigControl, sigReplay);
  gate("3 forward continuation after restore is deterministic (drive incl.)", e3.ok,
    e3.ok ? sigStr(sigControl) : `mismatch ${e3.k}: ${e3.a} vs ${e3.b}`);

  // ---- Test 4: floppy rollback --------------------------------------------
  // Restore to the anchor first so the live disk == anchor content, then
  // simulate a disk write by poking an inactive track's GCR buffer.
  await ctrl.restoreCheckpoint(anchor.id, { then: "keep" });
  const headHt = (facade.debugProbe?.().head_halftrack ?? 0) | 0;
  const gcr = facade.drive.gcr;
  let poked = false;
  if (gcr) {
    for (let t = 0; t < gcr.tracks.length; t++) {
      if (t === headHt) continue; // avoid the active track (writeback would touch it)
      const trk = gcr.tracks[t];
      if (trk?.data && trk.size > 64) {
        for (let i = 0; i < 32; i++) trk.data[i] ^= 0xa5; // simulate a sector write
        poked = true; break;
      }
    }
  }
  const diskAfterWrite = diskHash(facade);
  gate("4 simulated disk write changed the live image", poked && diskAfterWrite !== diskAnchor,
    `before=${diskAnchor.toString(16)} after=${diskAfterWrite.toString(16)} poked=${poked}`);
  await ctrl.restoreCheckpoint(anchor.id, { then: "keep" });
  const diskRolledBack = diskHash(facade);
  gate("4b restore rolls the disk content back to the anchor (mutable-wins)",
    diskRolledBack === diskAnchor && diskRolledBack !== diskAfterWrite,
    `rolledBack=${diskRolledBack.toString(16)} anchor=${diskAnchor.toString(16)}`);
} finally {
  stopIntegratedSession(sessionId);
}

console.log("\n---");
if (failures.length === 0) {
  console.log(`GREEN 761 scrub+resume: ${passes} checks pass.`);
  process.exit(0);
}
console.log(`RED 761 scrub+resume: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
