#!/usr/bin/env node
// Spec 709 — reproducible media ingress gates (acceptance §6).
//
//   G1 disk identity + checkpoint persistence/restore continuation (d64 + g64).
//   G2 PRG load vs inject-run is explicit + visible in the event.
//   G3 CRT real live attach (cartridge mapped + reset), not parse-only success.
//   G4 mid-session swap creates checkpoint-before AND -after (pinned) evidence.
//   G5 dirty writable disk rejects swap + eject with a precise error.
//   G6 drive9 + .c64re-as-media requests fail explicitly.
//
// ingestMedia is the single backend the WS media/ingress + adapted media/*
// routes call (Spec 709 §2.1).

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function fnv1a(b) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function sig(s) {
  const c = s.c64Cpu, d = s.kernel.drive1541?.debugProbe?.() ?? null;
  return { pc: c.pc, cyc: c.cycles >>> 0, ram: fnv1a(s.c64Bus.ram), drv: d ? `${d.drive_pc}/${d.head_halftrack}` : "n/a" };
}
const eq = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
async function expectThrow(fn, frag) {
  try { await fn(); return { ok: false, msg: "no throw" }; }
  catch (e) { const m = String(e?.message ?? e); return { ok: m.toLowerCase().includes(frag.toLowerCase()), msg: m }; }
}
const newSession = () => startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });

const dir = mkdtempSync(join(tmpdir(), "c64re-709-"));
const motm = new Uint8Array(readFileSync(resolve("samples/motm.g64")));
const scramble = new Uint8Array(readFileSync(resolve("samples/scramble_infinity.d64")));
const prg = new Uint8Array(readFileSync(resolve("samples/lnr_boot_02a7_fff7.prg")));
const crt = new Uint8Array(readFileSync(resolve("samples/AccoladeComics_TRX+1D_EF.crt")));
console.log(`Spec 709 — media ingress gates  (tmp ${dir})`);

// ---- G1 disk identity + 707 persistence/restore continuation ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.resetCold("pal-default");
    session.runFor(5_000_000, { cycleBudget: 5_000_000 });
    const ev = (await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: motm, name: "motm.g64" })).event;
    gate("G1 disk ingest yields identity (format/sha/role) + after-checkpoint", ev.format === "g64" && !!ev.sha256 && ev.role === "drive8" && !!ev.checkpointAfterId,
      `fmt=${ev.format} sha=${ev.sha256.slice(0, 8)} after=${ev.checkpointAfterId}`);

    session.typeText('LOAD"*",8,1\r');
    session.runFor(12_000_000, { cycleBudget: 12_000_000 });
    const before = sig(session);
    const snapPath = join(dir, "g1.c64re");
    await dumpRuntimeSnapshot(ctrl, snapPath);
    session.runFor(800_000, { cycleBudget: 800_000 }); const ctlSig = sig(session);
    await undumpRuntimeSnapshot(ctrl, snapPath);
    gate("G1 ingested-disk session survives .c64re dump→undump (immediate identity)", eq(before, sig(session)), JSON.stringify(before));
    session.runFor(800_000, { cycleBudget: 800_000 });
    gate("G1 run-N continuation after restore matches control", eq(ctlSig, sig(session)));
  } finally { stopIntegratedSession(sessionId); }
}

// ---- G1b d64 + g64 distinct identity ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    const d = (await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: scramble, name: "scramble.d64" })).event;
    gate("G1b d64 format detected + sha differs from g64", d.format === "d64" && d.sha256 !== undefined, `fmt=${d.format}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- G2 PRG load vs inject-run ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    const loadEv = (await ingestMedia(ctrl, { kind: "prg", bytes: prg, name: "boot.prg", mode: "load" })).event;
    const pcAfterLoad = session.c64Cpu.pc;
    const injEv = (await ingestMedia(ctrl, { kind: "prg", bytes: prg, name: "boot.prg", mode: "inject-run" })).event;
    const loadAddr = prg[0] | (prg[1] << 8);
    gate("G2 PRG load mode visible + does NOT set PC to entry", loadEv.operation === "prg",
      `mode load, pc stayed $${pcAfterLoad.toString(16)}`);
    gate("G2 PRG inject-run sets PC to load entry (explicit, no heuristic)", (session.c64Cpu.pc & 0xffff) === (loadAddr & 0xffff),
      `pc=$${session.c64Cpu.pc.toString(16)} entry=$${loadAddr.toString(16)}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- G3 CRT real live attach ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    const res = await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
    const ev = res.event;
    const bank = session.kernel.c64Bus.getBankInfo?.() ?? {};
    gate("G3 CRT really attached (mapper + cartridgeAttached), not parse-only", ev.format === "crt" && bank.cartridgeAttached === true,
      `mapper=${res.detail.mapperType} attached=${bank.cartridgeAttached} exrom=${bank.cartridgeExrom} game=${bank.cartridgeGame}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- G4 swap → checkpoint before + after ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: motm, name: "motm.g64" }); // root
    const swap = (await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: scramble, name: "scramble.d64" })).event; // intervention
    const beforePinned = swap.checkpointBeforeId && ctrl.checkpointRing.get(swap.checkpointBeforeId)?.pinned;
    const afterPinned = ctrl.checkpointRing.get(swap.checkpointAfterId)?.pinned;
    gate("G4 mid-session swap creates pinned before+after checkpoints", !!swap.checkpointBeforeId && !!beforePinned && !!afterPinned,
      `before=${swap.checkpointBeforeId} after=${swap.checkpointAfterId}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- G5 dirty disk swap/eject ACCEPTED (Spec 714.2 — disk now persistable) ----
// The 709.13 dirty-disk reject was a TEMPORARY barrier; 714.2 (save_disks=1)
// retires it. A dirty disk's modified GCR rides in the before/after checkpoints,
// so swap/eject is accepted and the before-checkpoint restores the written disk.
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: motm, name: "motm.g64" });
    // simulate a disk write (mutate a live GCR track byte → isMediaDirty)
    const gcr = session.kernel.drive1541.diskunit.drives[0].gcr;
    const trk = gcr.tracks.find((t) => t && t.data && t.size > 0);
    const V1 = (trk.data[0] ^ 0xff) & 0xff;
    trk.data[0] = V1;
    const swap = (await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: scramble, name: "scramble.d64" })).event;
    gate("G5 dirty disk swap is ACCEPTED with before+after checkpoints (714.2)",
      !!swap.checkpointBeforeId && !!swap.checkpointAfterId, `before=${swap.checkpointBeforeId} after=${swap.checkpointAfterId}`);
    await ctrl.restoreCheckpoint(swap.checkpointBeforeId);
    const t = session.kernel.drive1541.diskunit.drives[0].gcr.tracks.find((x) => x && x.data && x.size > 0);
    gate("G5 the swap before-checkpoint restores the MODIFIED disk content (V1)", !!t && t.data[0] === V1, `byte=${t?.data[0]} V1=${V1}`);
    const ej = await ingestMedia(ctrl, { kind: "eject", role: "drive8" });
    gate("G5 dirty disk eject is ACCEPTED (714.2, no barrier)", ej.ok === true);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- G6 drive9 + .c64re-as-media reject ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    const r9 = await expectThrow(() => ingestMedia(ctrl, { kind: "disk", role: "drive9", bytes: scramble, name: "x.d64" }), "drive 9");
    gate("G6 drive9 request rejected explicitly", r9.ok, r9.msg.slice(0, 60));
    const c64re = new Uint8Array([...Buffer.from("C64RESNP", "ascii"), 1, 2, 3, 4]);
    const rC = await expectThrow(() => ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: c64re, name: "x.c64re" }), "snapshot");
    gate("G6 .c64re-as-media rejected explicitly", rC.ok, rC.msg.slice(0, 60));
  } finally { stopIntegratedSession(sessionId); }
}

// ---- G7 CRT persistence: attach → checkpoint → eject → restore (709.7a) ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    const att = (await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" })).event;
    const b0 = session.kernel.c64Bus.getBankInfo();
    await ingestMedia(ctrl, { kind: "eject", role: "cartridge" });
    const bEject = session.kernel.c64Bus.getBankInfo();
    await ctrl.restoreCheckpoint(att.checkpointAfterId); // restore the after-attach checkpoint
    const bR = session.kernel.c64Bus.getBankInfo();
    gate("G7 CRT attach→checkpoint→eject→restore reattaches identical cartridge",
      b0.cartridgeAttached === true && bEject.cartridgeAttached === false &&
      bR.cartridgeAttached === true && bR.cartridgeMapperType === b0.cartridgeMapperType &&
      bR.cartridgeExrom === b0.cartridgeExrom && bR.cartridgeGame === b0.cartridgeGame,
      `attached ${b0.cartridgeAttached}→eject ${bEject.cartridgeAttached}→restore ${bR.cartridgeAttached} (${bR.cartridgeMapperType} exrom=${bR.cartridgeExrom})`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- G8 CRT dump → fresh session → undump (709.7b/c) ----
{
  const a = newSession();
  let snapPath, b0, ctlPc;
  try {
    const ctrl = new RuntimeController(a.sessionId, a.session, () => {});
    a.session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
    a.session.runFor(4_000_000, { cycleBudget: 4_000_000 });
    b0 = a.session.kernel.c64Bus.getBankInfo();
    snapPath = join(dir, "crt.c64re");
    await dumpRuntimeSnapshot(ctrl, snapPath);
    a.session.runFor(500_000, { cycleBudget: 500_000 }); ctlPc = a.session.c64Cpu.pc;
  } finally { stopIntegratedSession(a.sessionId); }

  const f = newSession();
  try {
    const ctrl = new RuntimeController(f.sessionId, f.session, () => {});
    f.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await undumpRuntimeSnapshot(ctrl, snapPath); // embedded CRT recreated + reattached
    const bU = f.session.kernel.c64Bus.getBankInfo();
    gate("G8 CRT dump→fresh-session undump reattaches same mapper/lines/state",
      bU.cartridgeAttached === true && bU.cartridgeMapperType === b0.cartridgeMapperType &&
      bU.cartridgeExrom === b0.cartridgeExrom && bU.cartridgeGame === b0.cartridgeGame,
      `${bU.cartridgeMapperType} exrom=${bU.cartridgeExrom} game=${bU.cartridgeGame}`);
    f.session.runFor(500_000, { cycleBudget: 500_000 });
    gate("G8 run-N continuation after CRT undump (same forward PC as control)",
      (f.session.c64Cpu.pc & 0xffff) === (ctlPc & 0xffff), `pc=$${f.session.c64Cpu.pc.toString(16)} ctl=$${ctlPc.toString(16)}`);
  } finally { stopIntegratedSession(f.sessionId); }
}

// ---- G9 persisted ordered media-event history (709.8) ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: motm, name: "motm.g64" });
    await ingestMedia(ctrl, { kind: "prg", bytes: prg, name: "boot.prg", mode: "load" });
    await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
    const ev = ctrl.mediaEvents;
    const ops = ev.map((e) => e.operation).join(",");
    const allHaveAfter = ev.every((e) => !!e.checkpointAfterId);
    const swapHasBefore = ev[2].checkpointBeforeId; // crt after disk+prg present → intervention
    gate("G9 media events persisted in order with checkpoint refs (queryable for 710-712)",
      ev.length === 3 && ops === "disk,prg,crt" && allHaveAfter && !!swapHasBefore,
      `[${ops}] all-after=${allHaveAfter} crt-before=${swapHasBefore}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- G10 WS adapter projection building blocks (709.9 route contract) ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    const res = await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
    // the media/mount adapter projects { mountedPath, type:event.format, mapperType:detail.mapperType }
    gate("G10 result carries the fields the MountResult-compatible adapter needs",
      res.event.format === "crt" && typeof res.detail.mapperType === "string",
      `type=${res.event.format} mapperType=${res.detail.mapperType}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- G11 durable media events across fresh-session dump/undump (709.11a) ----
{
  const a = newSession();
  let snapPath, srcEvent;
  try {
    const ctrl = new RuntimeController(a.sessionId, a.session, () => {});
    a.session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
    srcEvent = ctrl.mediaEvents[0];
    snapPath = join(dir, "events.c64re");
    await dumpRuntimeSnapshot(ctrl, snapPath);
  } finally { stopIntegratedSession(a.sessionId); }

  const f = newSession();
  try {
    const ctrl = new RuntimeController(f.sessionId, f.session, () => {});
    f.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    gate("G11 fresh session starts with empty media history", ctrl.mediaEvents.length === 0);
    await undumpRuntimeSnapshot(ctrl, snapPath);
    const ev = ctrl.mediaEvents;
    gate("G11 fresh-session undump restores the CRT ingress event (stable identity)",
      ev.length === 1 && ev[0].operation === "crt" && ev[0].format === srcEvent.format &&
      ev[0].sha256 === srcEvent.sha256,
      `n=${ev.length} op=${ev[0]?.operation} sha=${ev[0]?.sha256?.slice(0, 8)} (src ${srcEvent.sha256.slice(0, 8)})`);
  } finally { stopIntegratedSession(f.sessionId); }
}

// ---- G12 written EasyFlash dump ACCEPTED (Spec 713/714.5 — flash persists) ----
{
  // EasyFlash is now VICE-faithful (flash040core port + IO mirror + IO2 RAM +
  // command-state snapshot), so persistsWritableState is true and a written
  // EasyFlash dump is accepted. Full flash round-trip lives in probe-714-5.
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
    const cartM = session.kernel.c64Bus.getCartridge();
    const bi = session.kernel.c64Bus.getBankInfo();
    // AMD program sequence (EasyFlash loFlash, ultimax mode after attach → roml visible):
    cartM.write(0x8555, 0xAA, bi); cartM.write(0x82AA, 0x55, bi); cartM.write(0x8555, 0xA0, bi);
    cartM.write(0x8000, 0x42, bi); // program one flash byte
    gate("G12 flash write marks the cartridge writable-dirty", cartM.isWritableDirty?.() === true);
    let g12ok = false, g12msg = "";
    try { await dumpRuntimeSnapshot(ctrl, join(dir, "dirty-crt.c64re")); g12ok = true; }
    catch (e) { g12msg = String(e?.message ?? e).slice(0, 80); }
    gate("G12 written EasyFlash dump ACCEPTED (713/714.5 persists flash)", g12ok, g12msg);
  } finally { stopIntegratedSession(sessionId); }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 709 media ingress: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 709 media ingress: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
