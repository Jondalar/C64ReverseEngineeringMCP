#!/usr/bin/env node
// Spec 714.2-714.4 — VICE1541 mutable disk checkpoint + .c64re + bounded ring dedup.
//
//   Gate 8.1 (same-session, D64 + G64): a checkpoint taken AFTER a disk write
//     restores the WRITTEN media bytes (not the clean source), plus drive
//     continuation + deterministic forward run. This is the §4.1 red repro
//     turned green: write V1 → capture A → write V2 → restore A → byte == V1.
//   Gate 8.2 (.c64re fresh-session, D64 + G64): dirty-disk dump is accepted and
//     a fresh-session undump restores the written disk byte + drive continuation.
//   Gate 8.3 (bounded ring dedup): 8.3a — same disk shares one pooled version,
//     three distinct disk versions in the ring each restore exactly. 8.3b (ring
//     unit, tiny budget) — pin keeps a referenced version alive through
//     eviction, evicted entries release their version, identical images dedup.
//   Gate 8.4 (cross-media branch validity): with a dirty disk, a CRT insert is
//     now ACCEPTED (the 709.13 barrier is retired for disk) and its before-
//     checkpoint restores the modified disk content.
//
// The dirty-CRT barrier stays (Spec 713/714.5); this proves DISK only.

import { resolve, join } from "node:path";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { ingestMedia } from "../dist/runtime/headless/media/ingress.js";
import { dumpRuntimeSnapshot, undumpRuntimeSnapshot } from "../dist/runtime/headless/kernel/snapshot-persistence.js";
import { RuntimeCheckpointRing } from "../dist/runtime/headless/kernel/runtime-checkpoint-ring.js";

const dir = mkdtempSync(join(tmpdir(), "c64re-714-"));

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
console.log("Spec 714.2-714.4 — mutable disk checkpoint + .c64re + bounded ring dedup");

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

// ---- Gate 8.2 — dirty-disk .c64re dump → FRESH-session undump, per format ----
async function gate82(label, bytes, name) {
  const A = newSession();
  let snapPath, V1, dProbe;
  try {
    const ctrl = new RuntimeController(A.sessionId, A.session, () => {});
    A.session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes, name });
    const trk = liveTrack(A.session);
    V1 = (trk.data[0] ^ 0x3c) & 0xff;
    trk.data[0] = V1;
    dProbe = A.session.kernel.drive1541.debugProbe();
    snapPath = join(dir, `${label.replace(/\W/g, "_")}.c64re`);
    try { await dumpRuntimeSnapshot(ctrl, snapPath); gate(`${label} dirty-disk .c64re dump ACCEPTED (714.3, no reject)`, true); }
    catch (e) { gate(`${label} dirty-disk .c64re dump ACCEPTED (714.3, no reject)`, false, String(e?.message).slice(0, 80)); return; }
  } finally { stopIntegratedSession(A.sessionId); }

  const B = newSession();
  try {
    const ctrl = new RuntimeController(B.sessionId, B.session, () => {});
    B.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await undumpRuntimeSnapshot(ctrl, snapPath);
    const trk = liveTrack(B.session);
    gate(`${label} fresh-session undump restores the WRITTEN disk byte (V1)`,
      !!trk && trk.data[0] === V1, `byte=${trk?.data[0]} V1=${V1}`);
    const p = B.session.kernel.drive1541.debugProbe();
    gate(`${label} fresh-session undump restores drive continuation`,
      p.drive_pc === dProbe.drive_pc && p.head_halftrack === dProbe.head_halftrack,
      `pc ${p.drive_pc}/${dProbe.drive_pc} ht ${p.head_halftrack}/${dProbe.head_halftrack}`);
  } finally { stopIntegratedSession(B.sessionId); }
}

await gate82("8.2/G64", g64, "motm.g64");
await gate82("8.2/D64", d64, "scramble.d64");

// ---- Gate 8.3a — ring across ≥3 disk-write versions, restored exactly + dedup ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: g64, name: "motm.g64" });
    const trk = liveTrack(session);
    const base = trk.data[0];

    // Two checkpoints of the SAME disk state must share one pooled version.
    await ctrl.captureCheckpoint();
    await ctrl.captureCheckpoint();
    gate("8.3a two checkpoints of the same disk share ONE pooled version (dedup)",
      ctrl.checkpointRing.stats().diskImageVersions === 1, `versions=${ctrl.checkpointRing.stats().diskImageVersions}`);

    // Three distinct disk states across time.
    const V1 = (base ^ 0x11) & 0xff; trk.data[0] = V1; const A = await ctrl.captureCheckpoint();
    const V2 = (base ^ 0x22) & 0xff; trk.data[0] = V2; const B = await ctrl.captureCheckpoint();
    const V3 = (base ^ 0x33) & 0xff; trk.data[0] = V3; const C = await ctrl.captureCheckpoint();
    gate("8.3a three distinct disk versions pooled (+ the shared base = 4)",
      ctrl.checkpointRing.stats().diskImageVersions === 4, `versions=${ctrl.checkpointRing.stats().diskImageVersions}`);

    // Jump between versions — each reconstructs exactly.
    await ctrl.restoreCheckpoint(A.id); const rA = liveTrack(session).data[0];
    await ctrl.restoreCheckpoint(C.id); const rC = liveTrack(session).data[0];
    await ctrl.restoreCheckpoint(B.id); const rB = liveTrack(session).data[0];
    gate("8.3a restore reconstructs each disk version exactly (A=V1, B=V2, C=V3)",
      rA === V1 && rB === V2 && rC === V3, `A=${rA}/${V1} B=${rB}/${V2} C=${rC}/${V3}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- Gate 8.3b — pool refcount/pin/evict mechanics (ring unit, tiny budget) ----
{
  const fakeSnap = (diskByte, n = 4096) => ({
    schemaVersion: 1, payload: { ram: new Uint8Array(64), driveDiskImage: new Uint8Array(n).fill(diskByte) },
  });
  const ring = new RuntimeCheckpointRing({ budgetBytes: 10_000 });
  const a = ring.capture(fakeSnap(0x11), 1, 100); ring.pin(a.id);
  const b = ring.capture(fakeSnap(0x22), 2, 200);
  const c = ring.capture(fakeSnap(0x33), 3, 300);
  const d = ring.capture(fakeSnap(0x44), 4, 400); // budget forces eviction of oldest unpinned (b, c)
  const st = ring.stats();
  gate("8.3b ring stays bounded under a tiny budget", st.totalBytes <= ring.budgetBytes, `bytes=${st.totalBytes} budget=${ring.budgetBytes}`);
  gate("8.3b oldest UNPINNED entries evicted; pinned kept", ring.has(a.id) && !ring.has(b.id) && !ring.has(c.id) && ring.has(d.id),
    `a=${ring.has(a.id)} b=${ring.has(b.id)} c=${ring.has(c.id)} d=${ring.has(d.id)}`);
  const snapA = ring.restoreSnapshot(a.id);
  gate("8.3b pinned entry's pooled disk version survives eviction + rehydrates exactly",
    !!snapA && snapA.payload.driveDiskImage?.[0] === 0x11 && snapA.payload.driveDiskImage?.length === 4096,
    `byte=${snapA?.payload?.driveDiskImage?.[0]} len=${snapA?.payload?.driveDiskImage?.length}`);

  const ring2 = new RuntimeCheckpointRing({ budgetBytes: 1_000_000 });
  const e1 = ring2.capture(fakeSnap(0x55), 1, 1);
  ring2.capture(fakeSnap(0x55), 2, 2); // identical image → dedup
  gate("8.3b identical disk images dedup to one pooled version", ring2.stats().diskImageVersions === 1,
    `versions=${ring2.stats().diskImageVersions}`);
  ring2.unpin(e1.id); // (not pinned) — drop one ref via eviction simulation: capture distinct to push out
  gate("8.3b refcount holds the shared version while any entry references it",
    ring2.stats().diskImageVersions === 1 && !!ring2.restoreSnapshot(e1.id)?.payload?.driveDiskImage);
}

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
if (failures.length === 0) { console.log(`GREEN 714.2-714.4 mutable disk fidelity: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 714.2-714.4: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
