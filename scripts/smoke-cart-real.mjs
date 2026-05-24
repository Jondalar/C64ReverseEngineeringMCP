#!/usr/bin/env node
// Spec 713 — real-CRT smoke. Loads the actual scene/commercial cartridge samples
// (gitignored, under samples/) through the same code path the runtime uses:
// auto-infer the mapper from the CRT header, attach via the memory bus, and
// confirm the right VICE-shaped mapper is selected and the cart reads without
// throwing. Per-family VICE differential gates (probe-713-*) remain authoritative
// for behaviour; this proves the real headers/sizes parse + route correctly.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { HeadlessMemoryBus } from "../dist/runtime/headless/memory-bus.js";
import { loadCartridgeMapperFromBytes } from "../dist/runtime/headless/cartridge.js";

const samples = [
  { file: "samples/AccoladeComics_TRX+1D_EF.crt", type: "easyflash" },
  { file: "samples/yeti_mountain_GMOD2.crt",      type: "gmod2" },
  { file: "samples/im3_MAGICDESK.crt",            type: "magicdesk" },
  { file: "samples/lykia_MEGABYTER.crt",          type: "megabyter" },
];
let pass = 0, fail = 0, skip = 0;
for (const s of samples) {
  const p = resolve(s.file);
  if (!existsSync(p)) { console.log(`  SKIP  ${s.file} (not present)`); skip++; continue; }
  try {
    const bytes = new Uint8Array(readFileSync(p));
    const cart = loadCartridgeMapperFromBytes(bytes, s.file);
    const got = cart.getMapperType();
    const bus = new HeadlessMemoryBus(); bus.reset(); bus.setOpenBusProvider(() => 0x3f);
    bus.attachCartridge(cart); bus.write(0x0001, 0x37);
    const v = bus.read(0x8000); // read first ROML byte (mode-dependent; must not throw)
    const ok = got === s.type && typeof v === "number";
    console.log(`  ${ok ? "PASS" : "RED "}  ${s.type} ← ${s.file}  (inferred=${got}, $8000=${v})`);
    ok ? pass++ : fail++;
  } catch (e) {
    console.log(`  RED   ${s.type} ← ${s.file}  threw: ${e.message}`); fail++;
  }
}
console.log(`---\nreal-CRT smoke: ${pass} pass, ${fail} fail, ${skip} skip`);
process.exit(fail ? 1 : 0);
