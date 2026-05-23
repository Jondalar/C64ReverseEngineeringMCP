#!/usr/bin/env node
// Spec 713 + 714.5 — writable EasyFlash cartridge persistence (gate 8.5).
//
//   8.5a same-session: program flash → checkpoint A → program again → restore A
//     restores the programmed flash exactly (the §4.3 red repro, now green).
//     A dirty EasyFlash is ACCEPTED for capture (the 709.11b reject is retired
//     for EasyFlash via persistsWritableState).
//   8.5b .c64re fresh-session: program flash → dump → fresh session → undump
//     reattaches the cartridge with the written flash + mapper/bank state.
//   8.5c ring across versions + dedup: three distinct flash versions each
//     restore exactly; the constant .crt bytes dedup to ONE pooled version.
//
// EasyFlash is the priority (mounted in the UI). GMOD2/GMOD3/MegaByter follow
// their Spec 713 ports and stay reject-on-dirty until then.

import { resolve, join } from "node:path";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { ingestMedia } from "../dist/runtime/headless/media/ingress.js";
import { dumpRuntimeSnapshot, undumpRuntimeSnapshot } from "../dist/runtime/headless/kernel/snapshot-persistence.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}
const newSession = () => startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
const dir = mkdtempSync(join(tmpdir(), "c64re-7145-"));
const crt = new Uint8Array(readFileSync(resolve("samples/AccoladeComics_TRX+1D_EF.crt")));
console.log("Spec 713+714.5 — writable EasyFlash cartridge persistence");

// Program one EasyFlash low-flash byte (offset 0) via the AMD command sequence.
function writeFlash(session, value) {
  const cartM = session.kernel.c64Bus.getCartridge();
  const bi = session.kernel.c64Bus.getBankInfo();
  cartM.write(0x8555, 0xAA, bi); cartM.write(0x82AA, 0x55, bi); cartM.write(0x8555, 0xA0, bi);
  cartM.write(0x8000, value & 0xff, bi);
}
// Read flash byte 0 mode-independently via the writable-image surface.
const flash0 = (session) => session.kernel.c64Bus.getCartridge().getWritableImage()[0];

// ---- 8.5a same-session checkpoint/restore of programmed flash ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
    const cartM = session.kernel.c64Bus.getCartridge();
    const orig = flash0(session);
    const V1 = (orig ^ 0xa5) & 0xff;
    writeFlash(session, V1);
    gate("8.5a EasyFlash flash write is dirty AND persistable (persistsWritableState)",
      cartM.isWritableDirty?.() === true && cartM.persistsWritableState?.() === true && flash0(session) === V1,
      `dirty=${cartM.isWritableDirty?.()} persist=${cartM.persistsWritableState?.()} byte=${flash0(session)}`);
    let A;
    try { A = await ctrl.captureCheckpoint(); }
    catch (e) { gate("8.5a captureCheckpoint ACCEPTS a written EasyFlash (reject retired)", false, String(e?.message).slice(0, 80)); A = null; }
    if (!A) { stopIntegratedSession(sessionId); throw new Error("8.5a capture failed"); }
    gate("8.5a captureCheckpoint ACCEPTS a written EasyFlash (709.11b reject retired)", true);
    const V2 = (orig ^ 0x5a) & 0xff;
    writeFlash(session, V2);
    await ctrl.restoreCheckpoint(A.id);
    gate("8.5a restore reconstructs the programmed flash byte V1, not the later V2",
      flash0(session) === V1, `byte=${flash0(session)} V1=${V1} V2=${V2}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- 8.5b .c64re dump → FRESH-session undump ----
{
  const A = newSession();
  let snapPath, V1, mapperType, bank;
  try {
    const ctrl = new RuntimeController(A.sessionId, A.session, () => {});
    A.session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
    const orig = flash0(A.session);
    V1 = (orig ^ 0x3c) & 0xff;
    writeFlash(A.session, V1);
    const st = A.session.kernel.c64Bus.getCartridge().getState();
    mapperType = st.mapperType; bank = st.currentBank;
    snapPath = join(dir, "ef.c64re");
    try { await dumpRuntimeSnapshot(ctrl, snapPath); gate("8.5b written-EasyFlash .c64re dump ACCEPTED", true); }
    catch (e) { gate("8.5b written-EasyFlash .c64re dump ACCEPTED", false, String(e?.message).slice(0, 80)); throw e; }
  } finally { stopIntegratedSession(A.sessionId); }

  const B = newSession();
  try {
    const ctrl = new RuntimeController(B.sessionId, B.session, () => {});
    B.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await undumpRuntimeSnapshot(ctrl, snapPath);
    const bus = B.session.kernel.c64Bus;
    const attached = bus.getBankInfo().cartridgeAttached === true;
    const st = bus.getCartridge()?.getState?.();
    gate("8.5b fresh-session undump reattaches EasyFlash with the WRITTEN flash + state",
      attached && flash0(B.session) === V1 && st?.mapperType === mapperType && st?.currentBank === bank,
      `attached=${attached} byte=${flash0(B.session)} V1=${V1} mapper=${st?.mapperType} bank=${st?.currentBank}`);
  } finally { stopIntegratedSession(B.sessionId); }
}

// ---- 8.5c ring across distinct flash versions + .crt dedup ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });

    await ctrl.captureCheckpoint(); // pools cartBytes(1) + cartFlash(orig)
    await ctrl.captureCheckpoint(); // same state → dedup
    const vSame = ctrl.checkpointRing.stats().diskImageVersions;
    gate("8.5c two same-state captures dedup (cartBytes + cartFlash shared)", vSame === 2, `versions=${vSame}`);

    const orig = flash0(session);
    const V1 = (orig ^ 0x11) & 0xff; writeFlash(session, V1); const A = await ctrl.captureCheckpoint();
    const V2 = (orig ^ 0x22) & 0xff; writeFlash(session, V2); const B = await ctrl.captureCheckpoint();
    const V3 = (orig ^ 0x33) & 0xff; writeFlash(session, V3); const C = await ctrl.captureCheckpoint();
    const vAll = ctrl.checkpointRing.stats().diskImageVersions;
    gate("8.5c .crt dedups to ONE pooled version across all flash versions (1 .crt + 4 flash = 5)",
      vAll === 5, `versions=${vAll}`);

    await ctrl.restoreCheckpoint(A.id); const rA = flash0(session);
    await ctrl.restoreCheckpoint(C.id); const rC = flash0(session);
    await ctrl.restoreCheckpoint(B.id); const rB = flash0(session);
    gate("8.5c ring restore reconstructs each flash version exactly (A=V1, B=V2, C=V3)",
      rA === V1 && rB === V2 && rC === V3, `A=${rA}/${V1} B=${rB}/${V2} C=${rC}/${V3}`);
  } finally { stopIntegratedSession(sessionId); }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 713+714.5 EasyFlash persistence: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 713+714.5: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
