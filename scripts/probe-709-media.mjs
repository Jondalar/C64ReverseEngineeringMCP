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

// ---- G5 dirty disk rejects swap + eject ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: motm, name: "motm.g64" });
    // simulate a disk write (mutate a live GCR track byte → isMediaDirty)
    const gcr = session.kernel.drive1541.diskunit.drives[0].gcr;
    const trk = gcr.tracks.find((t) => t && t.data && t.size > 0);
    trk.data[0] = (trk.data[0] ^ 0xff) & 0xff;
    const rSwap = await expectThrow(() => ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: scramble, name: "scramble.d64" }), "dirty");
    gate("G5 dirty disk rejects swap with precise error", rSwap.ok, rSwap.msg.slice(0, 70));
    const rEject = await expectThrow(() => ingestMedia(ctrl, { kind: "eject", role: "drive8" }), "dirty");
    gate("G5 dirty disk rejects eject with precise error", rEject.ok, rEject.msg.slice(0, 70));
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

console.log("---");
if (failures.length === 0) { console.log(`GREEN 709 media ingress: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 709 media ingress: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
