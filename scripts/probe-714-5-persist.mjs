#!/usr/bin/env node
// Spec 714.5 — end-to-end writable-cartridge persistence for the device-core
// families (GMOD2 flash+EEPROM, GMOD3 SPI flash, MegaByter flash, C64MegaCart
// flash) through the REAL runtime path: native checkpoint capture/restore AND
// .c64re dump/undump into a FRESH session. Header-inferred mapper (NO override).
// Mutates the flash via the bus (program a known byte), checkpoints, clobbers,
// restores, and asserts the writable byte returns — proving the checkpoint /
// .c64re stack carries mutable cartridge state + continuation, not clean-source.

import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { ingestMedia } from "../dist/runtime/headless/media/ingress.js";
import { dumpRuntimeSnapshot, undumpRuntimeSnapshot } from "../dist/runtime/headless/kernel/snapshot-persistence.js";
import { RuntimeCheckpointRing } from "../dist/runtime/headless/kernel/runtime-checkpoint-ring.js";

const NEW = () => startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
// AMD sector-erase command sequences (start an erase → flash enters the busy
// continuation; magic addrs per flash type, in ultimax so writes reach flash).
function gmod2SectorErase(bus) { // flash040 NORMAL 0x5555/0x2aaa → bank2 $9555 / bank1 $8aaa
  const um = (b) => 0xc0 | b;
  bus.write(0xde00, um(2)); bus.write(0x9555, 0xaa); bus.write(0xde00, um(1)); bus.write(0x8aaa, 0x55);
  bus.write(0xde00, um(2)); bus.write(0x9555, 0x80); bus.write(0xde00, um(2)); bus.write(0x9555, 0xaa);
  bus.write(0xde00, um(1)); bus.write(0x8aaa, 0x55); bus.write(0xde00, um(0)); bus.write(0x8000, 0x30);
}
function mbSectorErase(bus) { // flash800 0xaaa/0x555 bank0; ultimax mode 3
  bus.write(0xde02, 0x03);
  bus.write(0x8aaa, 0xaa); bus.write(0x8555, 0x55); bus.write(0x8aaa, 0x80);
  bus.write(0x8aaa, 0xaa); bus.write(0x8555, 0x55); bus.write(0x8000, 0x30);
}

const failures = []; let passes = 0;
const gate = (n, ok, d) => { ok ? passes++ : failures.push(n); console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };
const dir = mkdtempSync(join(tmpdir(), "c64re-7145p-"));

// CRT with the CORRECT hw-type byte (so ingress infers the mapper, no override).
// bank0 = 0xff (erased → programmable); other banks = bank#.
function buildCrt(hwType, nbanks) {
  const HDR = 0x40, head = Buffer.alloc(HDR);
  head.write("C64 CARTRIDGE   ", 0, "ascii");
  head.writeUInt32BE(HDR, 0x10); head.writeUInt16BE(0x0100, 0x14);
  head.writeUInt16BE(hwType, 0x16); head.writeUInt8(0, 0x18); head.writeUInt8(1, 0x19);
  head.write("PERSIST", 0x20, "ascii");
  const chunks = [head];
  for (let b = 0; b < nbanks; b++) {
    const chip = Buffer.alloc(0x10 + 0x2000);
    chip.write("CHIP", 0, "ascii"); chip.writeUInt32BE(0x10 + 0x2000, 4);
    chip.writeUInt16BE(0, 8); chip.writeUInt16BE(b, 10); chip.writeUInt16BE(0x8000, 12); chip.writeUInt16BE(0x2000, 14);
    chip.fill(b === 0 ? 0xff : (b & 0xff), 0x10);
    chunks.push(chip);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

// per-cart: hw-type id + a "program flash byte0 = v via the bus" routine.
function gmod2Prog(bus, v) { // flash040 NORMAL magic 0x5555/0x2aaa → bank2 $9555 / bank1 $8aaa; ultimax
  bus.write(0xde00, 0xc0 | 2); bus.write(0x9555, 0xaa);
  bus.write(0xde00, 0xc0 | 1); bus.write(0x8aaa, 0x55);
  bus.write(0xde00, 0xc0 | 2); bus.write(0x9555, 0xa0);
  bus.write(0xde00, 0xc0 | 0); bus.write(0x8000, v);
  bus.write(0xde00, 0x00); // back to 8K bank0
}
function mbProg(bus, v) { // flash800 magic 0xaaa/0x555 bank0; ultimax = mode 3
  bus.write(0xde02, 0x03); bus.write(0xde00, 0x00);
  bus.write(0x8aaa, 0xaa); bus.write(0x8555, 0x55); bus.write(0x8aaa, 0xa0); bus.write(0x8000, v);
  bus.write(0xde02, 0x00);
}
function mcProg(bus, v) { // flash040 160 magic 0xaaa/0x555 bank0; ultimax via $DF00=0xc0
  bus.write(0xde00, 0x00); bus.write(0xdf00, 0xc0);
  bus.write(0x8aaa, 0xaa); bus.write(0x8555, 0x55); bus.write(0x8aaa, 0xa0); bus.write(0x8000, v);
  bus.write(0xdf00, 0x00); bus.write(0xde00, 0x00);
}
function gmod3Prog(bus, v) { // SPI WRITE_ENABLE + PAGE_PROGRAM addr0
  bus.write(0xde08, 0x80);
  const spiByte = (b) => { for (let i = 7; i >= 0; i--) { const bit = (b >> i) & 1; bus.write(0xde00, bit << 4); bus.write(0xde00, (bit << 4) | 0x20); } };
  const sel = () => bus.write(0xde00, 0x00), desel = () => bus.write(0xde00, 0x40);
  desel(); sel(); spiByte(0x06); desel();
  desel(); sel(); spiByte(0x02); spiByte(0); spiByte(0); spiByte(0); spiByte(v); desel();
  bus.write(0xde08, 0x00); bus.write(0xde00, 0x00);
}

const carts = [
  { name: "gmod2",       hw: 60, nbanks: 64,  prog: gmod2Prog },
  { name: "megabyter",   hw: 86, nbanks: 128, prog: mbProg },
  { name: "c64megacart", hw: 61, nbanks: 256, prog: mcProg },
  { name: "gmod3",       hw: 62, nbanks: 256, prog: gmod3Prog },
];

console.log("Spec 714.5 — writable cartridge persistence (checkpoint + .c64re fresh-session)");
for (const c of carts) {
  const crt = buildCrt(c.hw, c.nbanks);
  // --- native checkpoint capture/restore ---
  const A = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
  let snapPath;
  try {
    const ctrl = new RuntimeController(A.sessionId, A.session, () => {});
    A.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: `${c.name}.crt`, resetPolicy: "power-cycle" });
    const bus = A.session.kernel.c64Bus;
    const cart = bus.getCartridge();
    gate(`${c.name}: ingress infers mapper (no override)`, cart.getMapperType() === c.name);
    c.prog(bus, 0x5a);
    const v0 = cart.getWritableImage()[0];
    gate(`${c.name}: flash byte0 programmed 0x5a + dirty`, v0 === 0x5a && cart.isWritableDirty?.() === true, `b0=${v0}`);
    const ck = await ctrl.captureCheckpoint();           // dirty cart MUST be accepted (persistsWritableState)
    c.prog(bus, 0x00);                                    // clobber → 0x00
    gate(`${c.name}: clobbered to 0`, bus.getCartridge().getWritableImage()[0] === 0x00);
    await ctrl.restoreCheckpoint(ck.id);
    gate(`${c.name}: checkpoint restore → flash byte0 = 0x5a`, bus.getCartridge().getWritableImage()[0] === 0x5a,
      `b0=${bus.getCartridge().getWritableImage()[0]}`);
    snapPath = join(dir, `${c.name}.c64re`);
    await dumpRuntimeSnapshot(ctrl, snapPath);            // dirty cart → .c64re (not rejected)
  } catch (e) { gate(`${c.name}: checkpoint path threw`, false, e.message); }
  finally { stopIntegratedSession(A.sessionId); }

  // --- .c64re into a FRESH session ---
  if (snapPath) {
    const B = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
    try {
      const ctrl = new RuntimeController(B.sessionId, B.session, () => {});
      B.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
      await undumpRuntimeSnapshot(ctrl, snapPath);
      const cart = B.session.kernel.c64Bus.getCartridge();
      gate(`${c.name}: .c64re fresh-session → mapper + flash byte0 = 0x5a`,
        cart?.getMapperType() === c.name && cart.getWritableImage()[0] === 0x5a,
        `type=${cart?.getMapperType()} b0=${cart?.getWritableImage()[0]}`);
    } catch (e) { gate(`${c.name}: .c64re path threw`, false, e.message); }
    finally { stopIntegratedSession(B.sessionId); }
  }
}
// --- GMOD2 m93c86 EEPROM persistence (writable state beyond flash) ---
{
  const crt = buildCrt(60, 64);
  const A = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
  try {
    const ctrl = new RuntimeController(A.sessionId, A.session, () => {});
    A.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "gmod2-eeprom.crt", resetPolicy: "power-cycle" });
    const bus = A.session.kernel.c64Bus;
    // microwire write 0xABCD @ addr 5 (off mode: cs=bit6, clk=bit5, di=bit4).
    const eClk = (di) => { bus.write(0xde00, 0x40 | (di << 4)); bus.write(0xde00, 0x40 | (di << 4) | 0x20); };
    const eReset = () => { bus.write(0xde00, 0x00); bus.write(0xde00, 0x40); };
    const send = (bits) => { for (const b of bits) eClk(b); };
    const num = (n, w) => { const a = []; for (let i = w - 1; i >= 0; i--) a.push((n >> i) & 1); return a; };
    eReset(); send([1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);          // EWEN
    eReset(); send([1, 0, 1, ...num(5, 10), ...num(0xabcd, 16)]);     // WRITE addr5 = 0xABCD
    bus.write(0xde00, 0x00);                                         // deselect → commit write
    const flashLen = 512 * 1024;
    const eAt = (img, addr) => (img[flashLen + (addr << 1)] << 8) | img[flashLen + (addr << 1) + 1];
    gate("gmod2 EEPROM: write 0xABCD@5 took", eAt(bus.getCartridge().getWritableImage(), 5) === 0xabcd,
      `0x${eAt(bus.getCartridge().getWritableImage(), 5).toString(16)}`);
    const ck = await ctrl.captureCheckpoint();
    // clobber the eeprom word
    eReset(); send([1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    eReset(); send([1, 0, 1, ...num(5, 10), ...num(0x0000, 16)]); bus.write(0xde00, 0x00);
    await ctrl.restoreCheckpoint(ck.id);
    gate("gmod2 EEPROM: checkpoint restore → 0xABCD@5", eAt(bus.getCartridge().getWritableImage(), 5) === 0xabcd,
      `0x${eAt(bus.getCartridge().getWritableImage(), 5).toString(16)}`);
    const sp = join(dir, "gmod2-eeprom.c64re");
    await dumpRuntimeSnapshot(ctrl, sp);
    stopIntegratedSession(A.sessionId);
    const B = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
    const ctrlB = new RuntimeController(B.sessionId, B.session, () => {});
    B.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await undumpRuntimeSnapshot(ctrlB, sp);
    gate("gmod2 EEPROM: .c64re fresh-session → 0xABCD@5", eAt(B.session.kernel.c64Bus.getCartridge().getWritableImage(), 5) === 0xabcd);
    stopIntegratedSession(B.sessionId);
  } catch (e) { gate("gmod2 EEPROM path threw", false, e.message); try { stopIntegratedSession(A.sessionId); } catch {} }
}

// --- generic cart-payload RING multi-version + pin + evict (format-generic) ---
{
  const snap = (b, n = 4096) => ({ schemaVersion: 1, payload: { ram: new Uint8Array(64), cartBytes: new Uint8Array(16), cartFlash: new Uint8Array(n).fill(b) } });
  const ring = new RuntimeCheckpointRing({ budgetBytes: 10_000 });
  const a = ring.capture(snap(0x11), 1, 100); ring.pin(a.id);
  const b = ring.capture(snap(0x22), 2, 200);
  const c = ring.capture(snap(0x33), 3, 300);
  const d = ring.capture(snap(0x44), 4, 400); // tiny budget forces eviction of oldest unpinned
  gate("ring: bounded under budget", ring.stats().totalBytes <= ring.budgetBytes, `bytes=${ring.stats().totalBytes}`);
  gate("ring: pinned cart version kept, oldest unpinned (b) evicted",
    ring.has(a.id) && ring.has(d.id) && !ring.has(b.id), `a=${ring.has(a.id)} b=${ring.has(b.id)} d=${ring.has(d.id)}`);
  const sA = ring.restoreSnapshot(a.id), sD = ring.restoreSnapshot(d.id);
  gate("ring: pinned cartFlash rehydrates exactly", sA?.payload?.cartFlash?.[0] === 0x11 && sA.payload.cartFlash.length === 4096);
  gate("ring: remaining cartFlash version exact", sD?.payload?.cartFlash?.[0] === 0x44);
}

// --- mid-operation continuation through .c64re (not just direct getState/setState) ---
async function midEraseC64re(name, hw, nbanks, eraseFn, label) {
  let sp, before;
  const A = NEW();
  try {
    const ctrl = new RuntimeController(A.sessionId, A.session, () => {});
    A.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: buildCrt(hw, nbanks), name: `${name}-mid.crt`, resetPolicy: "power-cycle" });
    eraseFn(A.session.kernel.c64Bus);
    before = A.session.kernel.c64Bus.getCartridge().getState().flashLoState;
    gate(`${label}: mid-erase busy-window captured (erasing + alarm pending)`,
      before.state >= 10 && (before.eraseAlarmClk ?? -1) >= 0, `state=${before.state} alarm=${before.eraseAlarmClk}`);
    sp = join(dir, `${name}-mid.c64re`); await dumpRuntimeSnapshot(ctrl, sp);
  } finally { stopIntegratedSession(A.sessionId); }
  const B = NEW();
  try {
    const ctrl = new RuntimeController(B.sessionId, B.session, () => {});
    B.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await undumpRuntimeSnapshot(ctrl, sp);
    const after = B.session.kernel.c64Bus.getCartridge().getState().flashLoState;
    gate(`${label}: mid-erase .c64re fresh-session → identical continuation`,
      after.state === before.state && after.eraseAlarmClk === before.eraseAlarmClk &&
      (after.eraseMask ?? []).join("") === (before.eraseMask ?? []).join(""),
      `state ${before.state}->${after.state} alarm ${before.eraseAlarmClk}->${after.eraseAlarmClk}`);
  } finally { stopIntegratedSession(B.sessionId); }
}
await midEraseC64re("gmod2", 60, 64, gmod2SectorErase, "GMOD2 Flash040");
await midEraseC64re("megabyter", 86, 128, mbSectorErase, "MegaByter Flash800");

// GMOD3 mid-SPI READ continuation through .c64re
{
  let sp, before;
  const A = NEW();
  try {
    const ctrl = new RuntimeController(A.sessionId, A.session, () => {});
    A.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: buildCrt(62, 256), name: "gmod3-mid.crt", resetPolicy: "power-cycle" });
    const bus = A.session.kernel.c64Bus;
    const spiByte = (b) => { for (let i = 7; i >= 0; i--) { const bit = (b >> i) & 1; bus.write(0xde00, bit << 4); bus.write(0xde00, (bit << 4) | 0x20); } };
    bus.write(0xde08, 0x80); bus.write(0xde00, 0x40); bus.write(0xde00, 0x00); // bitbang, deselect→select
    spiByte(0x03); spiByte(0); spiByte(0); spiByte(0); // READ@0 → output loaded mid-shift
    before = bus.getCartridge().getState().spiState;
    gate("GMOD3 mid-SPI: READ in progress captured", before.command !== 0 || before.outCount > 0, `cmd=${before.command} outCount=${before.outCount}`);
    sp = join(dir, "gmod3-mid.c64re"); await dumpRuntimeSnapshot(ctrl, sp);
  } finally { stopIntegratedSession(A.sessionId); }
  const B = NEW();
  try {
    const ctrl = new RuntimeController(B.sessionId, B.session, () => {});
    B.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await undumpRuntimeSnapshot(ctrl, sp);
    const after = B.session.kernel.c64Bus.getCartridge().getState().spiState;
    gate("GMOD3 mid-SPI .c64re fresh-session → identical SPI continuation",
      after.command === before.command && after.outSR === before.outSR && after.outCount === before.outCount && after.inSR === before.inSR,
      `cmd ${before.command}->${after.command} outCount ${before.outCount}->${after.outCount}`);
  } finally { stopIntegratedSession(B.sessionId); }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 714.5 cartridge persistence: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 714.5: ${passes} pass, ${failures.length} fail.`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
