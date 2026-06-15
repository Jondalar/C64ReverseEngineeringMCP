#!/usr/bin/env node
// Spec 766.5b — recorder medium stream + reconstruct round-trip.
//
// With a disk mounted, the recorder anchor is CORE-ONLY (omitMedia): the disk
// GCR image rides the separate gen-gated medium stream. reconstruct() must
// re-inject it byte-exact, and the reassembled snapshot must restore the full
// machine (incl drive) to the capture-time signature.
//
//   A) omitMedia really strips the medium from the anchor payload.
//   B) the medium stream shipped the disk image (worker stats show a disk gen).
//   C) reconstruct re-injects driveDiskImage byte-exact vs a fresh snapshot blob.
//   D) restoring the reconstructed snapshot reproduces the capture-time signature
//      and the forward continuation matches a control (full fidelity incl disk).

import { resolve } from "node:path";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { RuntimeRecorder } from "../dist/runtime/headless/recorder/runtime-recorder.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}
function fnv1a(b) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function machineSig(session) {
  const cpu = session.c64Cpu; const r = session.vicRaster();
  const d = session.kernel.drive1541?.debugProbe?.() ?? null;
  return { pc: cpu.pc & 0xffff, a: cpu.a & 0xff, x: cpu.x & 0xff, y: cpu.y & 0xff, sp: cpu.sp & 0xff,
    cycles: cpu.cycles >>> 0, rasterLine: r.line, ramHash: fnv1a(session.c64Bus.ram),
    drive: d ? `${(d.drive_pc ?? 0).toString(16)}/${d.drive_clk ?? 0}/${d.head_halftrack ?? 0}` : "n/a" };
}
function sigEq(a, b) { for (const k of Object.keys(a)) if (a[k] !== b[k]) return { ok: false, k, a: a[k], b: b[k] }; return { ok: true }; }
function bytesEq(a, b) { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

console.log("Spec 766.5b — recorder medium stream + reconstruct");

const d64 = resolve("samples/fixtures/load-fidelity/lf-004-100block.d64");
const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
const recorder = new RuntimeRecorder({ capacityBytes: 8 * 1024 * 1024 });
try {
  session.resetCold("pal-default");
  session.runFor(5_000_000, { cycleBudget: 5_000_000 });
  await mountMedia(session, 8, d64);
  session.typeText('LOAD"*",8,1\r');
  session.runFor(12_000_000, { cycleBudget: 12_000_000 }); // drive active, head positioned

  // Settle any pending GCR writeback ONCE so it is not triggered asymmetrically
  // later (the medium-ship's snapshotDiskImage writeback clears GCR_dirty_track;
  // doing it now makes the capture / control / restore states symmetric).
  session.kernel.drive1541.snapshotDiskImage();

  // capture BOTH a full snapshot and a core-only (omitMedia) anchor at the SAME
  // instant — the equivalence bar for 5b is "reconstruct ≡ the full snapshot".
  const full = session.kernel.snapshot({ shallow: false, omitFramebuffer: true });
  const a = session.kernel.snapshot({ shallow: true, omitFramebuffer: true, omitMedia: true });
  const cycle = session.c64Cpu.cycles;
  gate("A omitMedia strips the disk image from the anchor payload", a.payload.driveDiskImage == null,
    `driveDiskImage=${a.payload.driveDiskImage == null ? "null" : "present"}`);
  recorder.captureAnchor(a.payload, cycle, 1000, a.schemaVersion, session.kernel);
  const sigAtCp = machineSig(session);

  await new Promise((r) => setTimeout(r, 80));

  const stats = await recorder.stats();
  gate("B medium stream shipped the disk image (worker has a disk gen)",
    stats.mediumDisk !== null && recorder.mediumShipped >= 1,
    `mediumDisk=${stats.mediumDisk}, shipped=${recorder.mediumShipped}, anchors=${stats.anchorCount}`);

  const ref = await recorder.findByCycle(cycle);
  const recon = ref ? await recorder.reconstruct(ref.seq) : null;
  gate("C reconstruct re-injects driveDiskImage (matches the full snapshot blob)",
    !!recon && recon.payload.driveDiskImage instanceof Uint8Array && bytesEq(new Uint8Array(recon.payload.driveDiskImage), full.payload.driveDiskImage),
    `recon disk len=${recon?.payload?.driveDiskImage?.length}, full len=${full.payload.driveDiskImage?.length}`);

  // D — equivalence: restoring the reconstructed snapshot must produce the SAME
  // machine as restoring the full snapshot (immediate AND after a forward run).
  const RUN = 800_000;
  session.kernel.restore({ schemaVersion: full.schemaVersion, payload: full.payload });
  const e0 = sigEq(sigAtCp, machineSig(session));
  gate("D restore reproduces capture-time signature", e0.ok,
    e0.ok ? `pc=${sigAtCp.pc.toString(16)} drv=${sigAtCp.drive}` : `mismatch ${e0.k}: ${e0.a} vs ${e0.b}`);
  session.runFor(RUN, { cycleBudget: RUN });
  const sigFull = machineSig(session);

  session.kernel.restore({ schemaVersion: recon.schemaVersion, payload: recon.payload });
  session.runFor(RUN, { cycleBudget: RUN });
  const e2 = sigEq(sigFull, machineSig(session));
  gate("D reconstruct ≡ full snapshot (forward run identical)", e2.ok,
    e2.ok ? `pc=${sigFull.pc.toString(16)} drv=${sigFull.drive}` : `mismatch ${e2.k}: ${e2.a} vs ${e2.b}`);
} finally {
  recorder.dispose();
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 766.5b recorder-medium: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 766.5b recorder-medium: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
