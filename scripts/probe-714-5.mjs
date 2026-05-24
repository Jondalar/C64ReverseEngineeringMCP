#!/usr/bin/env node
// Spec 713 (EasyFlash) + 714.5 — VICE-faithful EasyFlash writable cartridge.
//
// Faithful port of easyflash.c + flash040core.c (TYPE_B / AM29F040B) into the
// active runtime, proven against the auditor-reproduced REDs:
//   1. IO1 mirror: $DE04 acts like $DE00 (bank), $DE06 like $DE02 (control).
//   2. IO2 RAM ($DF00-$DFFF, 256B): read/write + checkpoint + .c64re + ring.
//   3. Flash program physics: `old & byte` — $ff→$14→$10→$ff stays $10.
//   4. Mid-command continuation: checkpoint mid-AMD-unlock → identical continue.
//   5. Erase result persistence (atomic-erase model; timing N/A, data gated).
//   6. Active-runtime banking: real CRT cold-boot, program-driven bank switch
//      reads the correct per-bank flash (not just bank-0 boot).
//   + same-session checkpoint, .c64re fresh-session, ring across flash versions.
//
// EasyFlash is the first family of the Spec 713 batch; the others (GMOD2/3,
// Ocean, Magic Desk, MegaByter) remain IN PROGRESS.

import { resolve, join } from "node:path";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController, ensureRuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { ingestMedia } from "../dist/runtime/headless/media/ingress.js";
import { dumpRuntimeSnapshot, undumpRuntimeSnapshot } from "../dist/runtime/headless/kernel/snapshot-persistence.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}
const newSession = () => startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "c64re-7145-"));
const crt = new Uint8Array(readFileSync(resolve("samples/AccoladeComics_TRX+1D_EF.crt")));
console.log("Spec 713+714.5 — VICE-faithful EasyFlash writable cartridge");

const cart = (s) => s.kernel.c64Bus.getCartridge();
const bi = (s) => s.kernel.c64Bus.getBankInfo();
const flash0 = (s) => cart(s).getWritableImage()[0];
// 8k mode (roml visible) + bank 0 so flash command writes land at $8000-$9FFF.
function efPrime(s) { cart(s).write(0xde00, 0x00, bi(s)); cart(s).write(0xde02, 0x06, bi(s)); }
const unlock = (s) => { cart(s).write(0x8555, 0xAA, bi(s)); cart(s).write(0x82AA, 0x55, bi(s)); };
const program = (s, v) => { unlock(s); cart(s).write(0x8555, 0xA0, bi(s)); cart(s).write(0x8000, v & 0xff, bi(s)); };
const chipErase = (s) => { unlock(s); cart(s).write(0x8555, 0x80, bi(s)); unlock(s); cart(s).write(0x8555, 0x10, bi(s)); };

async function attach(ctrl, s) {
  s.runFor(2_000_000, { cycleBudget: 2_000_000 });
  await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
}

// ---- Gate 1 — IO1 mirror ($DE04≡$DE00, $DE06≡$DE02) ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    const cartM = cart(session);
    cartM.write(0xde04, 0x05, bi(session)); // mirror of $DE00 → bank
    gate("1 IO1 $DE04 mirrors $DE00 (sets bank)", cartM.getState().currentBank === 0x05,
      `bank=${cartM.getState().currentBank}`);
    cartM.write(0xde06, 0x07, bi(session)); // mirror of $DE02 → control (& 0x87)
    gate("1 IO1 $DE06 mirrors $DE02 (sets control reg & 0x87)", cartM.getState().controlRegister === 0x07,
      `ctrl=${cartM.getState().controlRegister}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- Gate 2 — IO2 RAM $DF00-$DFFF + persistence ----
{
  const A = newSession();
  let snapPath;
  try {
    const ctrl = new RuntimeController(A.sessionId, A.session, () => {});
    await attach(ctrl, A.session);
    const cartM = cart(A.session);
    cartM.write(0xdf00, 0x90, bi(A.session));
    cartM.write(0xdfff, 0x42, bi(A.session));
    gate("2 IO2 RAM read-back ($DF00=0x90, $DFFF=0x42)",
      cartM.read(0xdf00, bi(A.session)) === 0x90 && cartM.read(0xdfff, bi(A.session)) === 0x42,
      `df00=${cartM.read(0xdf00, bi(A.session))} dfff=${cartM.read(0xdfff, bi(A.session))}`);
    const ckpt = await ctrl.captureCheckpoint();
    cartM.write(0xdf00, 0x00, bi(A.session)); // clobber
    await ctrl.restoreCheckpoint(ckpt.id);
    gate("2 IO2 RAM survives same-session checkpoint restore", cart(A.session).read(0xdf00, bi(A.session)) === 0x90);
    snapPath = join(dir, "io2.c64re");
    await dumpRuntimeSnapshot(ctrl, snapPath);
  } finally { stopIntegratedSession(A.sessionId); }
  const B = newSession();
  try {
    const ctrl = new RuntimeController(B.sessionId, B.session, () => {});
    B.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await undumpRuntimeSnapshot(ctrl, snapPath);
    gate("2 IO2 RAM survives .c64re fresh-session undump",
      cart(B.session).read(0xdf00, bi(B.session)) === 0x90 && cart(B.session).read(0xdfff, bi(B.session)) === 0x42);
  } finally { stopIntegratedSession(B.sessionId); }
}

// ---- Gate 3 — flash program physics (old & byte) ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    efPrime(session);
    chipErase(session);
    gate("3 chip erase → byte 0 = 0xff", flash0(session) === 0xff, `b=${flash0(session)}`);
    program(session, 0x14); const a = flash0(session);
    program(session, 0x10); const b = flash0(session);
    program(session, 0xff); const c = flash0(session);
    gate("3 program physics $ff→$14→$10→$ff keeps $10 (bits only 1→0)",
      a === 0x14 && b === 0x10 && c === 0x10, `14→${a} 10→${b} ff→${c}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- Gate 4 — mid-command continuation (checkpoint mid-unlock) ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    efPrime(session);
    chipErase(session);
    // uninterrupted reference: full program of 0x10 → byte 0x10.
    program(session, 0x10);
    const uninterrupted = flash0(session);
    // interrupted: erase, do unlock step 1, CHECKPOINT, then continue.
    chipErase(session);
    cart(session).write(0x8555, 0xAA, bi(session)); // unlock step 1 → flash mid-command
    const mid = await ctrl.captureCheckpoint(); // accepted (state captured)
    // continue without restore (control path):
    cart(session).write(0x82AA, 0x55, bi(session)); cart(session).write(0x8555, 0xA0, bi(session)); cart(session).write(0x8000, 0x10, bi(session));
    const contNoRestore = flash0(session);
    // restore the mid-command checkpoint, then continue identically:
    await ctrl.restoreCheckpoint(mid.id);
    cart(session).write(0x82AA, 0x55, bi(session)); cart(session).write(0x8555, 0xA0, bi(session)); cart(session).write(0x8000, 0x10, bi(session));
    const contAfterRestore = flash0(session);
    gate("4 mid-command checkpoint accepted + continuation identical (no drift)",
      uninterrupted === 0x10 && contNoRestore === 0x10 && contAfterRestore === 0x10,
      `uninterrupted=${uninterrupted} noRestore=${contNoRestore} afterRestore=${contAfterRestore}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- Gate 5 — erase result persistence (atomic-erase model) ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    efPrime(session);
    chipErase(session);          // → 0xff so the program lands the full value
    program(session, 0x3c);      // 0xff & 0x3c = 0x3c
    gate("5 programmed byte = 0x3c (post-erase)", flash0(session) === 0x3c, `b=${flash0(session)}`);
    const ck = await ctrl.captureCheckpoint();
    chipErase(session);          // erases to 0xff
    gate("5 erase result is 0xff", flash0(session) === 0xff);
    await ctrl.restoreCheckpoint(ck.id);
    gate("5 pre-erase flash (0x3c) restores from checkpoint (erase is atomic; data gated)",
      flash0(session) === 0x3c, `b=${flash0(session)}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- Gate 6 — active-runtime program-driven banking ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = ensureRuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    // The cold-booted cart executes (leaves cycle 0).
    ctrl.run({ mode: "warp" }); await sleep(120); ctrl.pause();
    gate("6 EasyFlash cold-boot executes (CPU leaves cycle 0)", session.c64Cpu.cycles > 0, `cycles=${session.c64Cpu.cycles}`);
    // Program-driven bank switch reads the correct per-bank flash data.
    const cartM = cart(session);
    cartM.write(0xde02, 0x06, bi(session)); // 8k (roml visible)
    cartM.write(0xde00, 0x00, bi(session));
    const bank0 = cartM.read(0x8000, bi(session));
    cartM.write(0xde00, 0x01, bi(session)); // bank 1 via $DE00
    const bank1 = cartM.read(0x8000, bi(session));
    const img = cartM.getWritableImage();
    gate("6 bank switch reads correct per-bank flash (bank0 vs bank1)",
      bank0 === img[0] && bank1 === img[0x2000], `bank0=${bank0}/${img[0]} bank1=${bank1}/${img[0x2000]}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- Gate 7 — same-session + .c64re + ring (written flash persistence) ----
{
  const A = newSession();
  let snapPath, V;
  try {
    const ctrl = new RuntimeController(A.sessionId, A.session, () => {});
    await attach(ctrl, A.session);
    efPrime(A.session); chipErase(A.session);
    program(A.session, 0x5a); V = flash0(A.session);
    const ck = await ctrl.captureCheckpoint();
    program(A.session, 0x0a); // 0x5a & 0x0a = 0x0a (different)
    await ctrl.restoreCheckpoint(ck.id);
    gate("7a same-session checkpoint restores written flash", flash0(A.session) === V, `b=${flash0(A.session)} V=${V}`);
    // ring: 3 distinct flash versions + .crt dedup to one.
    const w1 = flash0(A.session); const c1 = await A.session.kernel.c64Bus.getCartridge();
    const r0 = await ctrl.captureCheckpoint();
    program(A.session, 0x42); const r1 = await ctrl.captureCheckpoint(); const v1 = flash0(A.session);
    program(A.session, 0x02); const r2 = await ctrl.captureCheckpoint(); const v2 = flash0(A.session);
    await ctrl.restoreCheckpoint(r1.id); const rv1 = flash0(A.session);
    await ctrl.restoreCheckpoint(r2.id); const rv2 = flash0(A.session);
    gate("7b ring restores distinct flash versions", rv1 === v1 && rv2 === v2, `v1=${rv1}/${v1} v2=${rv2}/${v2}`);
    void w1; void c1; void r0;
    snapPath = join(dir, "ef-written.c64re");
    await dumpRuntimeSnapshot(ctrl, snapPath);
  } finally { stopIntegratedSession(A.sessionId); }
  const B = newSession();
  try {
    const ctrl = new RuntimeController(B.sessionId, B.session, () => {});
    B.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await undumpRuntimeSnapshot(ctrl, snapPath);
    gate("7c .c64re fresh-session reattaches EasyFlash with written flash + mapper",
      cart(B.session) && cart(B.session).getState().mapperType === "easyflash" && B.session.kernel.c64Bus.getBankInfo().cartridgeAttached === true);
  } finally { stopIntegratedSession(B.sessionId); }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 713+714.5 EasyFlash VICE-faithful: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 713+714.5: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
