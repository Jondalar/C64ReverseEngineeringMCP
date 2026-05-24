#!/usr/bin/env node
// Spec 713 audit #5 — flash erase alarm must be caught up at CAPTURE/INSPECT
// points (snapshot / writable-image), not only at flash read/store. VICE's
// erase_alarm_handler fires independently at the alarm clk, so a checkpoint that
// lands past completion WITHOUT an intervening flash access must still capture
// erased data. Drives the REAL EasyFlash mapper (inferred from the CRT header,
// no override) with a controllable clock.
import { loadCartridgeMapperFromBytes } from "../dist/runtime/headless/cartridge.js";
import { readFileSync } from "node:fs"; import { resolve } from "node:path";

const bytes = new Uint8Array(readFileSync(resolve("samples/AccoladeComics_TRX+1D_EF.crt")));
const cart = loadCartridgeMapperFromBytes(bytes, "ef.crt"); // infers easyflash
const clk = { v: 0 };
cart.setClock(() => clk.v);
const bi = {}; // unused by EF flash/IO path
let pass = 0, fail = 0;
const gate = (n, ok, d) => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };

// ultimax mode + bank 0 so AMD writes reach flash_low
cart.write(0xde00, 0x00, bi); cart.write(0xde02, 0x00, bi);
const orig = cart.getWritableImage()[0];
gate("setup: flash byte0 not yet 0xff (real game data)", orig !== 0xff, `orig=${orig}`);

// AMD chip-erase: AA@555, 55@2AA, 80@555, AA@555, 55@2AA, 10@555 (addrs in $8000 window)
const w = (a, v) => cart.write(a, v, bi);
w(0x8555, 0xAA); w(0x82AA, 0x55); w(0x8555, 0x80); w(0x8555, 0xAA); w(0x82AA, 0x55); w(0x8555, 0x10);

// advance the clock PAST chip-erase completion (8M cycles) WITHOUT any flash access
clk.v = 9_000_000;

// capture WITHOUT a prior read/store — getWritableImage must catch the erase up
const after = cart.getWritableImage()[0];
gate("audit#5: getWritableImage past completion (no flash access) → erased 0xff", after === 0xff, `byte0=${after}`);

// and the command-state snapshot must reflect completion (state back to read)
const snap = cart.getState().flashLoState;
gate("audit#5: snapshotState past completion → state=read (0), alarm cleared", snap.state === 0 && (snap.eraseAlarmClk ?? -1) < 0, `state=${snap.state} alarm=${snap.eraseAlarmClk}`);

console.log("---");
if (fail === 0) { console.log(`GREEN 713 erase-catchup: ${pass} pass.`); process.exit(0); }
console.log(`RED 713 erase-catchup: ${pass} pass, ${fail} fail.`); process.exit(1);
