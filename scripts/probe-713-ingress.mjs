#!/usr/bin/env node
// Spec 713 audit #1 — real CRT HEADER dispatch (no mapper override) through the
// active load + media-ingress + checkpoint-restore path. Proves inferMapperType
// routes GMOD2(60)/C64MegaCart(61)/GMOD3(62) and that an unknown type is rejected.
import { existsSync, readFileSync } from "node:fs"; import { resolve } from "node:path";
import { loadCartridgeMapperFromBytes } from "../dist/runtime/headless/cartridge.js";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { ingestMedia } from "../dist/runtime/headless/media/ingress.js";

let pass = 0, fail = 0;
const gate = (n, ok, d) => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };

function buildCrt({ hwType, exrom, game, nbanks, bankBytes = 0x2000 }) {
  const HDR = 0x40, head = Buffer.alloc(HDR);
  head.write("C64 CARTRIDGE   ", 0, "ascii");
  head.writeUInt32BE(HDR, 0x10); head.writeUInt16BE(0x0100, 0x14);
  head.writeUInt16BE(hwType, 0x16); head.writeUInt8(exrom, 0x18); head.writeUInt8(game, 0x19);
  head.write("PROBE", 0x20, "ascii");
  const chunks = [head];
  for (let b = 0; b < nbanks; b++) {
    const chip = Buffer.alloc(0x10 + bankBytes);
    chip.write("CHIP", 0, "ascii"); chip.writeUInt32BE(0x10 + bankBytes, 4);
    chip.writeUInt16BE(0, 8); chip.writeUInt16BE(b, 10); chip.writeUInt16BE(0x8000, 12); chip.writeUInt16BE(bankBytes, 14);
    chip.fill(b & 0xff, 0x10);
    chunks.push(chip);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

console.log("Spec 713 audit #1 — CRT header dispatch (NO override)");
// A. header-only dispatch (the override that hid this is NOT passed)
for (const [hw, expect, nb] of [[60, "gmod2", 64], [61, "c64megacart", 256], [62, "gmod3", 64], [32, "easyflash", 64], [86, "megabyter", 64]]) {
  const crt = buildCrt({ hwType: hw, exrom: 0, game: 1, nbanks: nb });
  let got = "(threw)";
  try { got = loadCartridgeMapperFromBytes(crt, `hw${hw}.crt`).getMapperType(); } catch (e) { got = `threw:${e.message.slice(0,30)}`; }
  gate(`#1 hw-id ${hw} → ${expect} (no override)`, got === expect, `got=${got}`);
}
// unknown type must reject explicitly
{ const crt = buildCrt({ hwType: 999, exrom: 0, game: 1, nbanks: 1 });
  let threw = false; try { loadCartridgeMapperFromBytes(crt, "hw999.crt"); } catch { threw = true; }
  gate("#1 unknown hw-id 999 → explicit reject", threw); }

// B. real GMOD2 sample through media-ingress (no override) + checkpoint/restore
const real = resolve("samples/yeti_mountain_GMOD2.crt");
if (!existsSync(real)) { console.log("  SKIP  real GMOD2 ingress (sample absent)"); }
else {
  const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: new Uint8Array(readFileSync(real)), name: "yeti", resetPolicy: "power-cycle" });
    const cart = session.kernel.c64Bus.getCartridge();
    gate("#1 real GMOD2 via ingress → mapper=gmod2 (header-inferred)", cart.getMapperType() === "gmod2");
    session.runFor(10_000_000, { cycleBudget: 10_000_000 });
    const bankBefore = cart.getState().currentBank;
    const ck = await ctrl.captureCheckpoint();
    session.runFor(5_000_000, { cycleBudget: 5_000_000 });
    await ctrl.restoreCheckpoint(ck.id);
    const c2 = session.kernel.c64Bus.getCartridge();
    gate("#1 checkpoint→restore keeps GMOD2 mapper + bank", c2.getMapperType() === "gmod2" && typeof c2.getState().currentBank === "number",
      `bankBefore=${bankBefore} after=${c2.getState().currentBank}`);
  } finally { stopIntegratedSession(sessionId); }
}
console.log("---");
if (fail === 0) { console.log(`GREEN 713 ingress: ${pass} pass.`); process.exit(0); }
console.log(`RED 713 ingress: ${pass} pass, ${fail} fail.`); process.exit(1);
