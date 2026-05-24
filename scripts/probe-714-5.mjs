#!/usr/bin/env node
// Spec 713 (EasyFlash) — VICE-faithful EasyFlash + flash040core gates.
//
// Like-for-like VICE (no documented simplification):
//   1. EAPI present → cart's EAPI replaced with VICE eapiam29f040 at romh $1800.
//   2. IO2 RAM ($DF00-$DFFF) powerup pattern (ram_init_with_pattern) + r/w.
//   3. Flash program physics: `old & byte` ($ff→$14→$10→$ff stays $10).
//   4. Sector erase BUSY WINDOW: status toggles (DQ6) + DQ3 during the ~1M-cycle
//      window, data is NOT yet erased; after the window the sector reads 0xff.
//   5. Chip erase busy window (~8M cycles).
//   6. Mode write ($DE02) → IMMEDIATE PLA/visibility change ($A000 cart in 16k,
//      open in 8k/ultimax); IO1 mirror ($DE04≡$DE00, $DE06≡$DE02).
//   7. Mid-command + mid-erase continuation survives checkpoint (alarm clk).
//   8. Writable flash + IO2 RAM persist through checkpoint / .c64re / ring.
//
// In-game EasyFlash reproduction is the final acceptance gate (separate).

import { resolve, join } from "node:path";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { ingestMedia } from "../dist/runtime/headless/media/ingress.js";
import { dumpRuntimeSnapshot, undumpRuntimeSnapshot } from "../dist/runtime/headless/kernel/snapshot-persistence.js";

const failures = []; let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}
const newSession = () => startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
const dir = mkdtempSync(join(tmpdir(), "c64re-7145-"));
const crt = new Uint8Array(readFileSync(resolve("samples/AccoladeComics_TRX+1D_EF.crt")));
console.log("Spec 713 — VICE-faithful EasyFlash + flash040core");

const cart = (s) => s.kernel.c64Bus.getCartridge();
const bi = (s) => s.kernel.c64Bus.getBankInfo();
const flash0 = (s) => cart(s).getWritableImage()[0];
// 8k mode (roml visible) + bank 0 so flash command writes land at $8000.
function efPrime(s, mode = 0x06) { cart(s).write(0xde00, 0x00, bi(s)); cart(s).write(0xde02, mode, bi(s)); }
const unlock = (s) => { cart(s).write(0x8555, 0xAA, bi(s)); cart(s).write(0x82AA, 0x55, bi(s)); };
const program = (s, v) => { unlock(s); cart(s).write(0x8555, 0xA0, bi(s)); cart(s).write(0x8000, v & 0xff, bi(s)); };
const sectorEraseCmd = (s) => { unlock(s); cart(s).write(0x8555, 0x80, bi(s)); unlock(s); cart(s).write(0x8000, 0x30, bi(s)); };
const chipEraseCmd = (s) => { unlock(s); cart(s).write(0x8555, 0x80, bi(s)); unlock(s); cart(s).write(0x8555, 0x10, bi(s)); };
async function attach(ctrl, s) {
  s.runFor(2_000_000, { cycleBudget: 2_000_000 });
  await ingestMedia(ctrl, { kind: "crt", bytes: crt, name: "accolade.crt", resetPolicy: "power-cycle" });
}

// ---- 1 EAPI replacement ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    const img = cart(session).getWritableImage(); const loLen = img.length / 2;
    // romh bank0 $1800: "eapi" sig + VICE-distinctive bytes c1 4d 2f cd at +4.
    const sig = String.fromCharCode(img[loLen + 0x1800], img[loLen + 0x1801], img[loLen + 0x1802], img[loLen + 0x1803]);
    gate("1 EAPI replaced with VICE eapiam29f040 at romh $1800",
      sig === "eapi" && img[loLen + 0x1804] === 0xc1 && img[loLen + 0x1805] === 0x4d && img[loLen + 0x1806] === 0x2f,
      `sig=${sig} +4=${img[loLen + 0x1804].toString(16)}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- 2 IO2 RAM powerup pattern + r/w ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    const c = cart(session);
    const pat = [c.read(0xdf00, bi(session)), c.read(0xdf01, bi(session)), c.read(0xdf02, bi(session)), c.read(0xdf03, bi(session))];
    gate("2 IO2 RAM powerup pattern = FF 00 00 FF", pat.join(",") === "255,0,0,255", pat.join(" "));
    c.write(0xdf10, 0x5a, bi(session));
    gate("2 IO2 RAM read-back after write", c.read(0xdf10, bi(session)) === 0x5a);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- 3 flash program physics (old & byte) ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    efPrime(session);
    chipEraseCmd(session); session.runFor(9_000_000, { cycleBudget: 9_000_000 }); // let chip erase complete
    cart(session).read(0x8000, bi(session)); // catch the lazy erase-alarm up
    gate("3 chip erase → byte 0 = 0xff", flash0(session) === 0xff, `b=${flash0(session)}`);
    program(session, 0x14); const a = flash0(session);
    program(session, 0x10); const b = flash0(session);
    program(session, 0xff); const c = flash0(session);
    gate("3 program physics $ff→$14→$10→$ff keeps $10", a === 0x14 && b === 0x10 && c === 0x10, `14→${a} 10→${b} ff→${c}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- 4 sector erase busy window + status toggle ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    efPrime(session);
    program(session, 0x00); // sector 0 byte 0 → 0x00 (distinguishable from erased 0xff)
    sectorEraseCmd(session);
    // during the busy window: reads return STATUS that toggles (DQ6), not data.
    const s1 = cart(session).read(0x8000, bi(session));
    const s2 = cart(session).read(0x8000, bi(session));
    session.runFor(200, { cycleBudget: 200 });
    const s3 = cart(session).read(0x8000, bi(session));
    const toggling = (s1 & 0x40) !== (s2 & 0x40) || (s2 & 0x40) !== (s3 & 0x40);
    const notErasedYet = flash0(session) !== 0xff;
    gate("4 sector erase BUSY: status DQ6 toggles + data not yet 0xff", toggling && notErasedYet,
      `s1=${s1.toString(16)} s2=${s2.toString(16)} s3=${s3.toString(16)} flash0=${flash0(session)}`);
    session.runFor(1_100_000, { cycleBudget: 1_100_000 }); // > erase_sector_cycles
    cart(session).read(0x8000, bi(session)); // catch the alarm up
    gate("4 sector erased to 0xff after the busy window", flash0(session) === 0xff, `b=${flash0(session)}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- 5 chip erase busy window ----
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    efPrime(session);
    program(session, 0x00);
    chipEraseCmd(session);
    const busy = flash0(session) !== 0xff;
    session.runFor(8_500_000, { cycleBudget: 8_500_000 }); // > erase_chip_cycles
    cart(session).read(0x8000, bi(session));
    gate("5 chip erase busy then 0xff after ~8M cycles", busy && flash0(session) === 0xff, `busy=${busy} after=${flash0(session)}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- 6 PLA-gated cart dispatch via the REAL CPU bus (Spec 713 §1-3) ----
// Every mode/bank/IO access goes through bus.read/bus.write — never cart.read/
// write directly — so the gates exercise the same PLA the CPU sees.
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    const bus = session.kernel.c64Bus;
    const knownPort = () => { bus.write(0x0000, 0x2f); bus.write(0x0001, 0x37); }; // LORAM/HIRAM/CHAREN=1

    // (a) EF 16k + $01 ROM-out → $8000/$A000 read the RAM underneath.
    knownPort();
    bus.write(0xde00, 0x00); bus.write(0xde02, 0x07);   // 16k (exrom=0 game=0)
    bus.write(0x8000, 0x11); bus.write(0xa000, 0x22);   // 16k ROM-window write → RAM beneath
    const rom8 = bus.read(0x8000), romA = bus.read(0xa000); // cart ROM shadows RAM on read
    bus.write(0x0001, 0x37 & ~0x03);                    // LORAM=0,HIRAM=0 → ROM out, $8000/$A000 = RAM
    const ram8 = bus.read(0x8000), ramA = bus.read(0xa000);
    gate("6a EF 16k + $01 ROM-out → $8000/$A000 read RAM underneath",
      ram8 === 0x11 && ramA === 0x22 && (rom8 !== 0x11 || romA !== 0x22),
      `rom8=${rom8} romA=${romA} ram8=${ram8} ramA=${ramA}`);

    // (b) non-ultimax + CHAREN=0 → $DE00 changes NO bank register + $DFxx not IO2 RAM.
    knownPort();
    bus.write(0xde02, 0x06);                            // 8k (non-ultimax), IO visible
    bus.write(0xde00, 0x00);                            // bank 0
    bus.write(0xdf00, 0x5e);                            // IO2 RAM[0] = 0x5e (IO visible)
    const bankBefore = cart(session).getState().currentBank;
    const io2Seen = bus.read(0xdf00);                   // 0x5e while IO visible
    bus.write(0x0001, 0x37 & ~0x04);                    // CHAREN=0 → I/O invisible (char ROM at $D000-$DFFF)
    bus.write(0xde00, 0x1f);                            // would set bank 0x1f IF cart IO were reachable
    const bankAfter = cart(session).getState().currentBank;
    const dfx = bus.read(0xdf00);                       // char ROM, NOT IO2 RAM
    gate("6b non-ultimax + CHAREN=0 → $DE00 no bank change",
      io2Seen === 0x5e && bankAfter === bankBefore, `bank ${bankBefore}->${bankAfter} io2=${io2Seen}`);
    gate("6b non-ultimax + CHAREN=0 → $DFxx is char ROM not IO2 RAM",
      dfx !== 0x5e && dfx === bus.charRom[0x0f00], `df00=${dfx} char=${bus.charRom[0x0f00]}`);

    // (c) ultimax → $5000 / $A000 / $C000 are open bus (phi1), not RAM.
    knownPort();
    bus.ram[0x5000] = 0xab; bus.ram[0xa000] = 0xcd; bus.ram[0xc000] = 0xef;
    bus.write(0xde02, 0x00);                            // CMODE ultimax (memconfig[0]=3)
    const u5 = bus.read(0x5000), uA = bus.read(0xa000), uC = bus.read(0xc000);
    gate("6c ultimax → $5000/$A000/$C000 are open bus, not RAM",
      u5 !== 0xab && uA !== 0xcd && uC !== 0xef, `5000=${u5} a000=${uA} c000=${uC}`);

    // IO1 mirror ($DE04≡$DE00, $DE06≡$DE02) — via the bus, in a non-ultimax IO-visible config.
    knownPort();
    bus.write(0xde02, 0x06);
    bus.write(0xde04, 0x05); gate("6 IO1 $DE04 mirrors $DE00 (bank)", cart(session).getState().currentBank === 5);
    bus.write(0xde06, 0x07); gate("6 IO1 $DE06 mirrors $DE02 (control)", cart(session).getState().controlRegister === 0x07);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- 7 mid-erase continuation state is snapshotted/restored ----
// (The erase BUSY-WINDOW completion is gated by 4/5; here we prove the in-flight
// command-state machine — state + erase mask + pending alarm clk — survives a
// checkpoint, so a restore resumes the exact same erase. Read state directly
// rather than running the live game, which would re-touch the flash.)
{
  const { session, sessionId } = newSession();
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    await attach(ctrl, session);
    efPrime(session);
    program(session, 0x00);
    sectorEraseCmd(session); // erase in progress (busy: SECTOR_ERASE_TIMEOUT, alarm pending)
    const before = cart(session).getState().flashLoState;
    const ck = await ctrl.captureCheckpoint();
    // clobber the live flash state, then restore.
    cart(session).write(0x8000, 0xf0, bi(session)); // reset command → state=READ
    await ctrl.restoreCheckpoint(ck.id);
    const after = cart(session).getState().flashLoState;
    gate("7 mid-erase command-state (state/mask/alarm) survives checkpoint restore",
      after.state === before.state && after.eraseAlarmClk === before.eraseAlarmClk &&
      after.eraseMask.join("") === before.eraseMask.join("") && before.state >= 9,
      `state ${before.state}->${after.state} alarm ${before.eraseAlarmClk}->${after.eraseAlarmClk} mask ${after.eraseMask.join("")}`);
  } finally { stopIntegratedSession(sessionId); }
}

// ---- 8 writable flash + IO2 RAM persist (.c64re fresh session) ----
{
  const A = newSession(); let snapPath, V;
  try {
    const ctrl = new RuntimeController(A.sessionId, A.session, () => {});
    await attach(ctrl, A.session);
    efPrime(A.session);
    chipEraseCmd(A.session); A.session.runFor(9_000_000, { cycleBudget: 9_000_000 }); cart(A.session).read(0x8000, bi(A.session));
    program(A.session, 0x42); V = flash0(A.session);
    cart(A.session).write(0xdf20, 0x99, bi(A.session));
    snapPath = join(dir, "ef.c64re");
    await dumpRuntimeSnapshot(ctrl, snapPath);
  } finally { stopIntegratedSession(A.sessionId); }
  const B = newSession();
  try {
    const ctrl = new RuntimeController(B.sessionId, B.session, () => {});
    B.session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    await undumpRuntimeSnapshot(ctrl, snapPath);
    gate("8 .c64re fresh-session restores written flash + IO2 RAM",
      flash0(B.session) === V && cart(B.session).read(0xdf20, bi(B.session)) === 0x99,
      `flash0=${flash0(B.session)}/${V} df20=${cart(B.session).read(0xdf20, bi(B.session))}`);
  } finally { stopIntegratedSession(B.sessionId); }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 713 EasyFlash VICE-faithful: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 713: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
