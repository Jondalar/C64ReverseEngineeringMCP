#!/usr/bin/env node
// Spec 709.12 — dirty writable-CRT boundary at the SHARED runtime path + the
// live UI CRT-insert UX. 709.11b put Policy B (reject dirty writable CRT) only
// at dumpRuntimeSnapshot(); this proves it now also holds at the native
// checkpoint path (RuntimeController.captureCheckpoint + auto-cadence) and at
// media-ingress eject/replace — and that a normal UI CRT insert from a running
// session resumes and executes the cart.
//
//   Part A (core, deterministic):
//     A1 clean EasyFlash captures + restores through the ring (no regression).
//   (Former A2-A5 = written-EasyFlash REJECT = the temporary 709.11b barrier,
//    retired by Spec 714.5 — EasyFlash now persists its flash; see probe-714-5.
//    Former Part C = dirty-DISK reject = the 709.13 barrier, retired by Spec
//    714.2; dirty-disk capture/restore now lives in probe-714.mjs.)
//   Part D (Spec 709.13.1 — device vs C64-internal pause rule):
//     D1 disk insert while running → C64 stays running (1541 = device).
//     D2 disk eject while running → C64 stays running.
//     D3 CRT op → C64 pauses (cartridge port = part of the C64).
//   Part B (live UI/WS gate, real V3WsServer + ws client):
//     B1 running session + media/mount slot 0 .crt → cart attached, runtime
//        resumes (running) and the CPU leaves cycle 0 (cart executes).
//     B2 paused session + media/mount slot 0 .crt → stays paused at cycle 0.
//     B3 CART eject (slot 0) clears the cart, leaves drive 8 intact.

import { resolve } from "node:path";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController, ensureRuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { ingestMedia } from "../dist/runtime/headless/media/ingress.js";
import { V3WsServer } from "../dist/workspace-ui/v3-ws-server.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}
async function expectThrow(fn, frag) {
  try { await fn(); return { ok: false, msg: "no throw" }; }
  catch (e) { const m = String(e?.message ?? e); return { ok: m.toLowerCase().includes(frag.toLowerCase()), msg: m }; }
}
const newSession = () => startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "c64re-70912-"));
const crt = new Uint8Array(readFileSync(resolve("samples/AccoladeComics_TRX+1D_EF.crt")));
const motm = resolve("samples/motm.g64");
const motmBytes = new Uint8Array(readFileSync(motm));
const prg = new Uint8Array(readFileSync(resolve("samples/lnr_boot_02a7_fff7.prg")));
console.log(`Spec 709.12/13 — dirty-media checkpoint boundary + live insert  (tmp ${dir})`);

// Mutate one live GCR track byte (= a written disk) and return { trk, orig }.
function dirtyDisk(session) {
  const gcr = session.kernel.drive1541.diskunit.drives[0].gcr;
  const trk = gcr.tracks.find((t) => t && t.data && t.size > 0);
  const orig = trk.data[0];
  trk.data[0] = (orig ^ 0xff) & 0xff;
  return { trk, orig, mutated: trk.data[0] };
}

// Program one EasyFlash flash byte via the AMD command sequence (ultimax mode
// after attach → roml writable). Returns { orig, written } as read back.
function writeFlashByte(session, value = 0x42) {
  const cartM = session.kernel.c64Bus.getCartridge();
  const bi = session.kernel.c64Bus.getBankInfo();
  const orig = cartM.read(0x8000, bi);
  cartM.write(0x8555, 0xAA, bi); cartM.write(0x82AA, 0x55, bi); cartM.write(0x8555, 0xA0, bi);
  cartM.write(0x8000, value & 0xff, bi);
  return { cartM, bi, orig, written: cartM.read(0x8000, bi) };
}

// ---- A1 clean EasyFlash captures + restores (no regression) ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
    const cartM = session.kernel.c64Bus.getCartridge();
    gate("A1 clean EasyFlash is not writable-dirty after attach", cartM.isWritableDirty?.() === false);
    const ref = await ctrl.captureCheckpoint();
    session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await ctrl.restoreCheckpoint(ref.id);
    gate("A1 clean EasyFlash captures + restores through the ring (no regression)",
      session.kernel.c64Bus.getBankInfo().cartridgeAttached === true && cartM.isWritableDirty?.() === false);
  } finally { stopIntegratedSession(sessionId); }
}

// NOTE: the former A2-A5 (written-EasyFlash → REJECT, the temporary 709.11b
// policy-B barrier) are retired by Spec 714.5: EasyFlash now PERSISTS its flash
// (persistsWritableState), so a dirty EasyFlash is captured/dumped, not
// rejected. EasyFlash flash checkpoint/.c64re/ring fidelity lives in
// scripts/probe-714-5.mjs. The reject now only applies to writable cartridge
// families without a persistence port (no test corpus yet).

// NOTE: the former Part C (dirty-DISK → reject) asserted the TEMPORARY 709.13
// barrier. Spec 714.2 retires that barrier: a dirty disk is now CAPTURED (the
// VICE1541 snapshot runs save_disks=1). Dirty-disk capture/restore + dirty-disk
// branch validity now live in scripts/probe-714.mjs. The dirty-CRT reject (A)
// stays here until Spec 713/714.5.

// ---- Part D — 1541 = device (C64 keeps running); cart port = C64 (pause) ----
// Spec 709.13.1: a disk insert/eject/swap must NOT pause a running C64; a CRT
// op (C64-internal cold-boot) must.
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = ensureRuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    ctrl.run({ mode: "warp" });
    await sleep(40);
    // D1 disk insert while running → still running (device, no C64 pause).
    const r1 = await ingestMedia(ctrl, { kind: "disk", role: "drive8", bytes: motmBytes, name: "motm.g64" });
    gate("D1 disk insert does NOT pause the running C64 (1541 = device)",
      ctrl.runState === "running" && r1.paused === false, `runState=${ctrl.runState} paused=${r1.paused}`);
    const cyc1 = session.c64Cpu.cycles; await sleep(120);
    gate("D1 C64 keeps executing across the disk insert", session.c64Cpu.cycles > cyc1, `+${session.c64Cpu.cycles - cyc1} cyc`);
    // D2 disk eject while running → still running.
    const r2 = await ingestMedia(ctrl, { kind: "eject", role: "drive8" });
    gate("D2 disk eject does NOT pause the running C64", ctrl.runState === "running" && r2.paused === false,
      `runState=${ctrl.runState}`);
    // D3 CRT op (default, no resume) → C64 pauses (cart port = part of C64).
    const r3 = await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
    gate("D3 CRT op DOES pause the C64 (cartridge port = C64-internal cold-boot)",
      ctrl.runState === "paused" && r3.paused === true, `runState=${ctrl.runState} paused=${r3.paused}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- Part B — live UI/WS CRT insert ----
const PORT = 43000 + Math.floor(Math.random() * 2000);
let idc = 0;
function rpc(ws, method, params) {
  return new Promise((res, rej) => {
    const id = ++idc;
    const onMsg = (data) => {
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      if (m.id !== id) return;
      ws.off("message", onMsg);
      if (m.error) rej(new Error(m.error.message || JSON.stringify(m.error)));
      else res(m.result);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}
const driveHasDisk = (session) => !!session.kernel.drive1541?.getAttachedMedia?.();

const server = new V3WsServer({ port: PORT, host: "127.0.0.1", projectDir: process.cwd() });
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const crtPath = resolve("samples/AccoladeComics_TRX+1D_EF.crt");

// B1 — RUNNING session resumes + executes the cart after a slot-0 insert.
const run = newSession();
try {
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  // Same controller the server will use (registry keyed by sessionId); start it
  // running so the insert sees a RUNNING session.
  const ctrlRun = ensureRuntimeController(run.sessionId, run.session, () => {});
  ctrlRun.run();
  await sleep(60);
  gate("B1 setup: controller is running before insert", ctrlRun.runState === "running");

  await rpc(ws, "media/mount", { session_id: run.sessionId, slot: 0, path: crtPath });
  const cartB1 = await rpc(ws, "session/cart_status", { session_id: run.sessionId });
  gate("B1 slot-0 .crt really attaches the cartridge", cartB1 && !!cartB1.type, `cart=${JSON.stringify(cartB1)}`);
  gate("B1 running session RESUMES after the CRT insert", ctrlRun.runState === "running");
  await sleep(180); // let the resumed PAL loop execute the cart ROM
  gate("B1 CPU leaves cycle 0 (cart executes after the power-cycle)", run.session.c64Cpu.cycles > 0,
    `cycles=${run.session.c64Cpu.cycles}`);
  ctrlRun.pause();
} finally { stopIntegratedSession(run.sessionId); }

// B2 — PAUSED session stays paused at cycle 0 after a slot-0 insert.
const pau = newSession();
try {
  const ctrlPau = ensureRuntimeController(pau.sessionId, pau.session, () => {});
  gate("B2 setup: controller is paused before insert", ctrlPau.runState === "paused");
  await rpc(ws, "media/mount", { session_id: pau.sessionId, slot: 0, path: crtPath });
  const cartB2 = await rpc(ws, "session/cart_status", { session_id: pau.sessionId });
  gate("B2 paused session: cartridge attached", cartB2 && !!cartB2.type, `cart=${JSON.stringify(cartB2)}`);
  gate("B2 paused session STAYS paused after the CRT insert", ctrlPau.runState === "paused");
  gate("B2 paused session sits at cycle 0 (cold boot, not executed)", pau.session.c64Cpu.cycles === 0,
    `cycles=${pau.session.c64Cpu.cycles}`);

  // B3 — CART eject leaves drive 8 intact (CRT first, then disk; eject slot 0).
  await rpc(ws, "media/mount", { session_id: pau.sessionId, slot: 8, path: motm });
  gate("B3 setup: disk in drive 8 + cartridge attached", driveHasDisk(pau.session) && !!(await rpc(ws, "session/cart_status", { session_id: pau.sessionId })));
  await rpc(ws, "media/unmount", { session_id: pau.sessionId, slot: 0 });
  const cartB3 = await rpc(ws, "session/cart_status", { session_id: pau.sessionId });
  gate("B3 CART eject clears the cartridge", cartB3 === null, `cart_status=${JSON.stringify(cartB3)}`);
  gate("B3 CART eject leaves the disk in drive 8 intact", driveHasDisk(pau.session) === true);
} finally {
  try { ws.close(); } catch { /* ignore */ }
  await server.close().catch(() => {});
  stopIntegratedSession(pau.sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 709.12/13 dirty-media boundary + live insert: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 709.12/13: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
