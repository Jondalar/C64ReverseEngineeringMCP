#!/usr/bin/env node
// Spec 714.2 — VICE1541 mutable disk checkpoint fidelity (save_disks=1).
//
//   Gate 8.1 (same-session, D64 + G64): a checkpoint taken AFTER a disk write
//     restores the WRITTEN media bytes (not the clean source), plus drive
//     continuation + deterministic forward run. This is the §4.1 red repro
//     turned green: write V1 → capture A → write V2 → restore A → byte == V1.
//   Gate 8.4 (cross-media branch validity): with a dirty disk, a CRT insert is
//     now ACCEPTED (the 709.13 barrier is retired for disk) and its before-
//     checkpoint restores the modified disk content.
//
// The dirty-CRT barrier stays (Spec 713/714.5); this proves DISK only.

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { ingestMedia } from "../dist/runtime/headless/media/ingress.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}
function fnv1a(b) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
const newSession = () => startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });

const g64 = new Uint8Array(readFileSync(resolve("samples/motm.g64")));
const d64 = new Uint8Array(readFileSync(resolve("samples/scramble_infinity.d64")));
const crt = new Uint8Array(readFileSync(resolve("samples/AccoladeComics_TRX+1D_EF.crt")));
console.log("Spec 714.2 — mutable disk checkpoint fidelity (save_disks=1)");

// First GCR track that has data (the write target / readback point).
function liveTrack(session) {
  const gcr = session.kernel.drive1541.diskunit.drives[0].gcr;
  return gcr.tracks.find((t) => t && t.data && t.size > 0) ?? null;
}

// ---- Gate 8.1 — same-session dirty-disk checkpoint, per image format ----
async function gate81(label, bytes, name) {
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes, name });
    const trk = liveTrack(session);
    gate(`${label} mounted with a live GCR track`, !!trk && trk.size > 0, trk ? `size=${trk.size}` : "no track");
    if (!trk) return;

    // Write a distinguishable first state V1, then checkpoint A.
    const V1 = (trk.data[0] ^ 0xa5) & 0xff;
    trk.data[0] = V1;
    gate(`${label} disk is dirty after the write`, session.kernel.drive1541.isMediaDirty?.() === true);

    let A;
    try { A = await ctrl.captureCheckpoint(); }
    catch (e) { gate(`${label} captureCheckpoint ACCEPTS a dirty disk (714.2, no 709.13 reject)`, false, String(e?.message).slice(0, 80)); return; }
    gate(`${label} captureCheckpoint ACCEPTS a dirty disk (714.2, no 709.13 reject)`, true);

    // Mutate to a different state V2, then restore A.
    const V2 = (V1 ^ 0xff) & 0xff;
    trk.data[0] = V2;
    await ctrl.restoreCheckpoint(A.id);
    const restored = liveTrack(session).data[0];
    gate(`${label} restore returns the WRITTEN byte V1, not the later V2 (§4.1 repro fixed)`,
      restored === V1, `restored=${restored} V1=${V1} V2=${V2}`);

    // Deterministic drive continuation + forward run from the restored checkpoint.
    const p1 = session.kernel.drive1541.debugProbe();
    session.runFor(500_000, { cycleBudget: 500_000 }); const sigA = fnv1a(session.c64Bus.ram);
    await ctrl.restoreCheckpoint(A.id);
    const p2 = session.kernel.drive1541.debugProbe();
    session.runFor(500_000, { cycleBudget: 500_000 }); const sigB = fnv1a(session.c64Bus.ram);
    gate(`${label} drive continuation + forward run reproduce from the checkpoint`,
      p1.drive_pc === p2.drive_pc && p1.head_halftrack === p2.head_halftrack && sigA === sigB,
      `pc ${p1.drive_pc}/${p2.drive_pc} ht ${p1.head_halftrack}/${p2.head_halftrack} ram ${sigA === sigB}`);
  } finally { stopIntegratedSession(sessionId); }
}

await gate81("8.1/G64", g64, "motm.g64");
await gate81("8.1/D64", d64, "scramble.d64");

// ---- Gate 8.4 — cross-media branch validity (dirty disk + CRT insert) ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: g64, name: "motm.g64" });
    const trk = liveTrack(session);
    const V1 = (trk.data[0] ^ 0x5a) & 0xff;
    trk.data[0] = V1;

    // Previously rejected by the 709.13 barrier; now accepted because the disk
    // state rides in the before/after checkpoints.
    let res;
    try { res = await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" }); }
    catch (e) { gate("8.4 dirty disk + CRT insert is ACCEPTED (barrier retired for disk)", false, String(e?.message).slice(0, 80)); res = null; }
    if (res) {
      gate("8.4 dirty disk + CRT insert is ACCEPTED with before/after checkpoints",
        !!res.event.checkpointBeforeId && !!res.event.checkpointAfterId,
        `before=${res.event.checkpointBeforeId} after=${res.event.checkpointAfterId}`);
      await ctrl.restoreCheckpoint(res.event.checkpointBeforeId);
      const t = liveTrack(session);
      gate("8.4 the before-checkpoint restores the MODIFIED disk content",
        !!t && t.data[0] === V1, `byte=${t?.data[0]} V1=${V1}`);
    }
  } finally { stopIntegratedSession(sessionId); }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 714.2 mutable disk fidelity: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 714.2: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
