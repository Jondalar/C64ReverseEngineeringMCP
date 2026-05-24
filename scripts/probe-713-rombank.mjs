#!/usr/bin/env node
// Spec 713 — bus-level gates for the ROM-bank mappers (MagicDesk, MagicDesk16,
// Ocean), ported faithfully from magicdesk.c / magicdesk16.c / ocean.c.
// Every access goes through the real PLA/memory-bus path (bus.read/bus.write),
// never cart.read/write directly.

import { HeadlessMemoryBus } from "../dist/runtime/headless/memory-bus.js";
import { loadCartridgeMapperFromBytes } from "../dist/runtime/headless/cartridge.js";

const failures = []; let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push(name); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}

// Build a minimal .crt with `nbanks` CHIP packets. Each bank's data is filled
// with a per-bank sentinel so a read tells us which bank is live.
function buildCrt({ hwType, exrom, game, nbanks, bankBytes }) {
  const HDR = 0x40;
  const head = Buffer.alloc(HDR);
  head.write("C64 CARTRIDGE   ", 0, "ascii");
  head.writeUInt32BE(HDR, 0x10);
  head.writeUInt16BE(0x0100, 0x14);
  head.writeUInt16BE(hwType, 0x16);
  head.writeUInt8(exrom, 0x18);
  head.writeUInt8(game, 0x19);
  head.write("PROBE", 0x20, "ascii");
  const chunks = [head];
  for (let b = 0; b < nbanks; b++) {
    const chip = Buffer.alloc(0x10 + bankBytes);
    chip.write("CHIP", 0, "ascii");
    chip.writeUInt32BE(0x10 + bankBytes, 4);
    chip.writeUInt16BE(0, 8);          // ROM
    chip.writeUInt16BE(b, 10);         // bank
    chip.writeUInt16BE(0x8000, 12);    // load addr
    chip.writeUInt16BE(bankBytes, 14); // size
    // sentinel: low byte = bank, $8000 area; for 16k, $A000 area = bank|0x80
    chip.fill(b & 0xff, 0x10, 0x10 + Math.min(0x2000, bankBytes));
    if (bankBytes > 0x2000) chip.fill((b & 0x7f) | 0x80, 0x10 + 0x2000, 0x10 + bankBytes);
    chunks.push(chip);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function freshBus(crtBytes) {
  const bus = new HeadlessMemoryBus();
  bus.reset();
  bus.setOpenBusProvider(() => 0x3f);
  const cart = loadCartridgeMapperFromBytes(crtBytes, "probe.crt");
  bus.attachCartridge(cart);
  bus.write(0x0001, 0x37); // LORAM/HIRAM/CHAREN = 1
  return { bus, cart };
}

console.log("Spec 713 — ROM-bank mappers (bus-level)");

// ---- MagicDesk (8K game, bit7 disable, bankmask) ----
{
  const crt = buildCrt({ hwType: 19, exrom: 0, game: 1, nbanks: 64, bankBytes: 0x2000 });
  const { bus, cart } = freshBus(crt);
  gate("MD: type=magicdesk", cart.getMapperType() === "magicdesk");
  gate("MD: bank0 ROML at $8000 = 0", bus.read(0x8000) === 0);
  bus.write(0xde00, 0x05);
  gate("MD: $DE00=5 → bank 5 ROML=5", bus.read(0x8000) === 5, `r=${bus.read(0x8000)}`);
  // 8K mode: $A000 is BASIC/RAM, NOT the cart bank (sentinel 5).
  gate("MD: 8K $A000 is not cart ROMH (≠ bank 5)", bus.read(0xa000) !== 5, `a000=${bus.read(0xa000)}`);
  bus.write(0xde00, 0x3f);
  gate("MD: $DE00=$3f → bank 63 ROML=63", bus.read(0x8000) === 63);
  bus.write(0xde00, 0x80 | 0x07); // disable + bank 7
  gate("MD: bit7 disable → $8000 reads RAM (cart off)", bus.read(0x8000) === bus.ram[0x8000], `r=${bus.read(0x8000)} ram=${bus.ram[0x8000]}`);
  gate("MD: disabled lines exrom=1 game=1", cart.getLines().exrom === 1 && cart.getLines().game === 1);
  bus.write(0xde00, 0x05); // re-enable bank 5
  gate("MD: re-enable → bank 5 live again", bus.read(0x8000) === 5);
  // snapshot/restore
  const st = cart.getState();
  gate("MD: snapshot controlRegister captured", (st.controlRegister & 0x3f) === 5);
  bus.write(0xde00, 0x20);
  cart.setState(st);
  gate("MD: setState restores bank 5", bus.read(0x8000) === 5, `r=${bus.read(0x8000)}`);
}

// ---- MagicDesk16 (16K game, ROML+ROMH, disable) ----
{
  const crt = buildCrt({ hwType: 85, exrom: 0, game: 0, nbanks: 32, bankBytes: 0x4000 });
  const { bus, cart } = freshBus(crt);
  gate("MD16: type=magicdesk16", cart.getMapperType() === "magicdesk16");
  gate("MD16: bank0 ROML $8000 = 0", bus.read(0x8000) === 0);
  gate("MD16: bank0 ROMH $A000 = 0x80", bus.read(0xa000) === 0x80, `r=${bus.read(0xa000)}`);
  bus.write(0xde00, 0x09);
  gate("MD16: bank9 ROML=9", bus.read(0x8000) === 9);
  gate("MD16: bank9 ROMH=0x89", bus.read(0xa000) === ((9 & 0x7f) | 0x80));
  gate("MD16: enabled lines exrom=0 game=0 (16K)", cart.getLines().exrom === 0 && cart.getLines().game === 0);
  bus.write(0xde00, 0x80);
  gate("MD16: disable → $8000 RAM", bus.read(0x8000) === bus.ram[0x8000]);
  gate("MD16: disable → $A000 BASIC/RAM (not 0x80)", bus.read(0xa000) !== 0x80);
}

// ---- Ocean 16K (mirror) ----
{
  const crt = buildCrt({ hwType: 5, exrom: 0, game: 0, nbanks: 16, bankBytes: 0x2000 }); // 128KB → 16K game
  const { bus, cart } = freshBus(crt);
  gate("Ocean: type=ocean", cart.getMapperType() === "ocean");
  gate("Ocean16K: lines exrom=0 game=0", cart.getLines().exrom === 0 && cart.getLines().game === 0);
  bus.write(0xde00, 0x07);
  gate("Ocean16K: bank7 ROML $8000 = 7", bus.read(0x8000) === 7);
  gate("Ocean16K: bank7 mirrored to ROMH $A000 = 7", bus.read(0xa000) === 7, `r=${bus.read(0xa000)}`);
}

// ---- Ocean 8K (512KB) ----
{
  const crt = buildCrt({ hwType: 5, exrom: 0, game: 1, nbanks: 64, bankBytes: 0x2000 }); // 512KB → 8K game
  const { bus, cart } = freshBus(crt);
  gate("Ocean8K(512KB): lines exrom=0 game=1", cart.getLines().exrom === 0 && cart.getLines().game === 1);
  bus.write(0xde00, 0x11);
  gate("Ocean8K: bank17 ROML = 17", bus.read(0x8000) === 17);
  gate("Ocean8K: $A000 not cart-mirrored (8K → BASIC/RAM)", bus.read(0xa000) !== 17);
}

// ---- Generic Normal 8K (c64-generic.c: ROML $8000, BASIC $A000) ----
{
  const crt = buildCrt({ hwType: 0, exrom: 0, game: 1, nbanks: 1, bankBytes: 0x2000 });
  const { bus, cart } = freshBus(crt);
  gate("Gen8K: type=normal_8k", cart.getMapperType() === "normal_8k");
  gate("Gen8K: lines exrom=0 game=1", cart.getLines().exrom === 0 && cart.getLines().game === 1);
  bus.ram[0x8000] = 0x77;
  gate("Gen8K: $8000 reads cart ROML (=0), not RAM 0x77", bus.read(0x8000) === 0);
}

// ---- Generic Normal 16K (ROML $8000 + ROMH $A000) ----
{
  const crt = buildCrt({ hwType: 0, exrom: 0, game: 0, nbanks: 1, bankBytes: 0x4000 });
  const { bus, cart } = freshBus(crt);
  gate("Gen16K: type=normal_16k", cart.getMapperType() === "normal_16k");
  gate("Gen16K: lines exrom=0 game=0", cart.getLines().exrom === 0 && cart.getLines().game === 0);
  gate("Gen16K: $8000 ROML=0", bus.read(0x8000) === 0);
  gate("Gen16K: $A000 ROMH=0x80", bus.read(0xa000) === 0x80, `r=${bus.read(0xa000)}`);
}

// ---- Generic Ultimax ($E000 ROMH, hw-type 0, header-inferred, no override) ----
{
  // 2 CHIPs: ROML @ $8000 (8K, sentinel 0x11) + ROMH @ $E000 (8K, 0x22, last byte 0x99).
  const HDR = 0x40, head = Buffer.alloc(HDR);
  head.write("C64 CARTRIDGE   ", 0, "ascii");
  head.writeUInt32BE(HDR, 0x10); head.writeUInt16BE(0x0100, 0x14);
  head.writeUInt16BE(0, 0x16); head.writeUInt8(1, 0x18); head.writeUInt8(0, 0x19); // hw 0, exrom=1 game=0 (ultimax)
  head.write("ULTIMAX", 0x20, "ascii");
  const roml = Buffer.alloc(0x10 + 0x2000); roml.write("CHIP", 0, "ascii"); roml.writeUInt32BE(0x10 + 0x2000, 4);
  roml.writeUInt16BE(0, 10); roml.writeUInt16BE(0x8000, 12); roml.writeUInt16BE(0x2000, 14); roml.fill(0x11, 0x10);
  const romh = Buffer.alloc(0x10 + 0x2000); romh.write("CHIP", 0, "ascii"); romh.writeUInt32BE(0x10 + 0x2000, 4);
  romh.writeUInt16BE(0, 10); romh.writeUInt16BE(0xe000, 12); romh.writeUInt16BE(0x2000, 14); romh.fill(0x22, 0x10); romh[0x10 + 0x1fff] = 0x99;
  const crt = new Uint8Array(Buffer.concat([head, roml, romh]));
  const bus = new HeadlessMemoryBus(); bus.reset(); bus.setOpenBusProvider(() => 0x3f);
  const cart = loadCartridgeMapperFromBytes(crt, "ultimax.crt"); // header-inferred → ultimax
  bus.attachCartridge(cart); bus.write(0x0001, 0x37);
  gate("Ultimax: type=ultimax (hw0 + romh_e000, no override)", cart.getMapperType() === "ultimax");
  gate("Ultimax: lines exrom=1 game=0", cart.getLines().exrom === 1 && cart.getLines().game === 0);
  gate("Ultimax: $8000 ROML = 0x11", bus.read(0x8000) === 0x11);
  gate("Ultimax: $E000 ROMH = 0x22", bus.read(0xe000) === 0x22, `r=${bus.read(0xe000).toString(16)}`);
  gate("Ultimax: $FFFF ROMH last byte = 0x99", bus.read(0xffff) === 0x99, `r=${bus.read(0xffff).toString(16)}`);
  gate("Ultimax: $A000 open window = phi1/open-bus (not cart)", bus.read(0xa000) === 0x3f);
  gate("Ultimax: $5000 open window = phi1/open-bus", bus.read(0x5000) === 0x3f);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 713 ROM-bank: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 713 ROM-bank: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
