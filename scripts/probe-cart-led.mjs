#!/usr/bin/env node
// BUG-042 repro — CART LED signal primitives:
//   booted: resetCold with cart mapped into boot path → cartBootedFrom
//   read:   bankInfo EXROM/GAME asserted = mapped ("CART on"), off-mode releases
//   write:  writableGeneration advances on flash program (BUG-040 counter)
import { readFileSync } from "node:fs";
const D = new URL("../dist", import.meta.url).pathname;
const { startIntegratedSession, stopIntegratedSession } = await import(`${D}/runtime/headless/integrated-session-manager.js`);
const { RuntimeController } = await import(`${D}/runtime/headless/debug/runtime-controller.js`);
const { ingestMedia } = await import(`${D}/runtime/headless/media/ingress.js`);
const SRC = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/AccoladeComics_TRX+1D_EF.crt";

const failures = []; let passes = 0;
const gate = (n, ok, d) => { ok ? passes++ : failures.push(n); console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };
const mapped = (bus) => { const i = bus.getBankInfo(); return i.cartridgeExrom === 0 || i.cartridgeGame === 0; };

// --- EF session: booted + mapped + off + write-generation ---------------------
{
  const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
  const ctrl = new RuntimeController(sessionId, session, () => {});
  await ingestMedia(ctrl, { kind: "crt", bytes: new Uint8Array(readFileSync(SRC)), name: "ac.crt", resetPolicy: "power-cycle" }, {});
  ctrl.pause();
  const bus = session.c64Bus;
  gate("booted: power-cycle with EF → cartBootedFrom", session.cartBootedFrom === true);
  gate("read: EF boot mode is mapped (CART on)", mapped(bus) === true);

  const cart = bus.getCartridge();
  cart.write(0xde02, 0x04, bus.getBankInfo()); bus.notifyCartridgeLinesChanged(); // off
  gate("idle: EF mode off releases EXROM+GAME", mapped(bus) === false);
  gate("booted flag survives unmap (green base state)", session.cartBootedFrom === true);

  cart.write(0xde00, 0x00, bus.getBankInfo());
  cart.write(0xde02, 0x05, bus.getBankInfo()); bus.notifyCartridgeLinesChanged(); // ultimax
  const g0 = cart.writableGeneration?.() ?? 0;
  bus.write(0xe555, 0xaa); bus.write(0xeaaa, 0x55); bus.write(0xe555, 0xa0); bus.write(0xe000, 0x42);
  const g1 = cart.writableGeneration?.() ?? 0;
  gate("write: flash program advances writableGeneration", g1 > g0, `${g0} -> ${g1}`);

  // ws-server handler logic replica (gen delta → write, held 1.2s; else mapped → read)
  let tr = { gen: g0, lastWriteAt: 0 };
  const poll = (gen, now) => {
    if (gen !== tr.gen) { tr.gen = gen; tr.lastWriteAt = now; }
    return (now - tr.lastWriteAt < 1200) ? "write" : mapped(bus) ? "read" : "idle";
  };
  gate("handler: gen delta → write", poll(g1, 10_000) === "write");
  gate("handler: held within 1.2s window", poll(g1, 11_000) === "write");
  gate("handler: decays to read (mapped) after window", poll(g1, 11_300) === "read");
  stopIntegratedSession(sessionId);
}

// --- no-cart session: booted stays false --------------------------------------
{
  const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
  session.resetCold("pal-default");
  gate("no cart: resetCold → cartBootedFrom false", session.cartBootedFrom === false);
  gate("no cart: bankInfo not attached → status null path", session.c64Bus.getBankInfo().cartridgeAttached === false);
  stopIntegratedSession(sessionId);
}

console.log(`\n${passes} PASS, ${failures.length} RED${failures.length ? " — " + failures.join("; ") : ""}`);
process.exit(failures.length ? 1 : 0);
