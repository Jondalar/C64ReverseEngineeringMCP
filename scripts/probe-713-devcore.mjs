#!/usr/bin/env node
// Spec 713 — bus-level gates for the device-core mappers (GMOD2 = flash040core
// TYPE_NORMAL + m93c86 EEPROM). All access via the real PLA/memory-bus path.

import { HeadlessMemoryBus } from "../dist/runtime/headless/memory-bus.js";
import { loadCartridgeMapperFromBytes } from "../dist/runtime/headless/cartridge.js";

const failures = []; let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push(name); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}

// CRT with nbanks 8K CHIPs; bank0 = 0xff (erased, programmable), banks 1.. = bank#.
function buildCrt({ hwType, exrom, game, nbanks }) {
  const HDR = 0x40, head = Buffer.alloc(HDR);
  head.write("C64 CARTRIDGE   ", 0, "ascii");
  head.writeUInt32BE(HDR, 0x10); head.writeUInt16BE(0x0100, 0x14);
  head.writeUInt16BE(hwType, 0x16); head.writeUInt8(exrom, 0x18); head.writeUInt8(game, 0x19);
  head.write("PROBE", 0x20, "ascii");
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

console.log("Spec 713 — device-core mappers (bus-level)");

// ============ GMOD2 (flash040 TYPE_NORMAL + m93c86) ============
{
  const crt = buildCrt({ hwType: 0, exrom: 0, game: 1, nbanks: 64 });
  const bus = new HeadlessMemoryBus(); bus.reset(); bus.setOpenBusProvider(() => 0x3f);
  const cart = loadCartridgeMapperFromBytes(crt, "gmod2.crt", "gmod2");
  bus.attachCartridge(cart);
  bus.write(0x0001, 0x37);

  gate("GMOD2: type=gmod2", cart.getMapperType() === "gmod2");
  // default 8K mode, bank 0
  gate("GMOD2: initial 8K lines exrom=0 game=1", cart.getLines().exrom === 0 && cart.getLines().game === 1);

  // bank select in 8K (bit6=0 → 8K, bit7=0). read flash bank sentinel.
  bus.write(0xde00, 0x05);
  gate("GMOD2: 8K bank5 → $8000 reads flash sentinel 5", bus.read(0x8000) === 5, `r=${bus.read(0x8000)}`);
  bus.write(0xde00, 0x0a);
  gate("GMOD2: 8K bank10 → $8000 = 10", bus.read(0x8000) === 10);

  // cmode transitions
  bus.write(0xde00, 0xc0);            // 0xc0 → ultimax
  gate("GMOD2: $DE00=0xc0 → ultimax lines exrom=1 game=0", cart.getLines().exrom === 1 && cart.getLines().game === 0);
  bus.write(0xde00, 0x40);            // bit6=1,bit7=0 → off (RAM)
  gate("GMOD2: $DE00=0x40 → off lines exrom=1 game=1", cart.getLines().exrom === 1 && cart.getLines().game === 1);

  // write routing: 8K $8000 write → RAM underneath (not flash); ultimax → consumed.
  bus.write(0xde00, 0x00);            // 8K bank0
  bus.write(0x8000, 0x99);            // 8K → RAM (flash bank0 is 0xff; flash read would be 0xff)
  gate("GMOD2: 8K $8000 write goes to RAM (read still flash 0xff)", bus.read(0x8000) === 0xff, `r=${bus.read(0x8000)}`);

  // flash program in ULTIMAX (AMD TYPE_NORMAL unlock 0x5555/0x2aaa → banks 2/1).
  const um = (bank) => 0xc0 | (bank & 0x3f); // ultimax + bank (eeprom cs=1 but clk/data=0 for low banks)
  bus.write(0xde00, um(2)); bus.write(0x9555, 0xAA); // flash off 0x5555 ← AA
  bus.write(0xde00, um(1)); bus.write(0x8aaa, 0x55); // flash off 0x2aaa ← 55
  bus.write(0xde00, um(2)); bus.write(0x9555, 0xA0); // program command
  bus.write(0xde00, um(0)); bus.write(0x8000, 0x3c); // program flash off 0 ← 0x3c (0xff & 0x3c = 0x3c)
  bus.write(0xde00, 0x00);            // back to 8K bank0
  gate("GMOD2: ultimax flash program → read 0x3c in 8K", bus.read(0x8000) === 0x3c, `r=${bus.read(0x8000)}`);

  // ---- m93c86 EEPROM round-trip via microwire bit-bang ----
  // off mode (bit6=1,bit7=0): cs=1, cmode=off (flash untouched). clk=bit5, di=bit4.
  const eClk = (di) => { bus.write(0xde00, 0x40 | (di << 4)); bus.write(0xde00, 0x40 | (di << 4) | 0x20); };
  const eReset = () => { bus.write(0xde00, 0x00); bus.write(0xde00, 0x40); }; // cs 0→1 with clk0 = reset shiftreg
  const send = (bits) => { for (const b of bits) eClk(b); };
  const num = (n, w) => { const a = []; for (let i = w - 1; i >= 0; i--) a.push((n >> i) & 1); return a; };
  // EWEN: start(1) cmd(00) 10011... (13 bits)
  eReset(); send([1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  // WRITE addr=5 data=0xABCD: start(1) cmd(01) addr(10) data(16) = 29 bits
  eReset(); send([1, 0, 1, ...num(5, 10), ...num(0xabcd, 16)]);
  // READ addr=5: start(1) cmd(10) addr(10) = 13 bits → READDUMMY; then 16 clocks shift out
  eReset(); send([1, 1, 0, ...num(5, 10)]);
  let val = 0;
  for (let i = 0; i < 16; i++) { eClk(0); val = (val << 1) | ((bus.read(0xde00) >> 7) & 1); }
  gate("GMOD2: m93c86 EEPROM write 0xABCD@5 → read back 0xABCD", val === 0xabcd, `read=0x${val.toString(16)}`);

  // ---- snapshot/restore ----
  // getState/setState carry the small continuation (bank, cmode, flash command
  // state, eeprom shift state); the 512K flash + 2K eeprom DATA ride in the
  // separate getWritableImage payload (the bounded ring / .c64re).
  bus.write(0xde00, 0x00);
  const st = cart.getState();
  gate("GMOD2: snapshot has flash + eeprom continuation", !!st.flashLoState && !!st.eepromState && st.writable === true);

  // writable-image (data) round-trip: capture, clobber flash, restore.
  const img = cart.getWritableImage();
  gate("GMOD2: writable image = flash(512K) + eeprom(2K)", img.length === 0x80000 + 2048, `len=${img.length}`);
  bus.write(0xde00, um(2)); bus.write(0x9555, 0xAA); bus.write(0xde00, um(1)); bus.write(0x8aaa, 0x55);
  bus.write(0xde00, um(2)); bus.write(0x9555, 0xA0); bus.write(0xde00, um(0)); bus.write(0x8000, 0x00); // clobber off0 → 0
  bus.write(0xde00, 0x00);
  gate("GMOD2: flash clobbered to 0", bus.read(0x8000) === 0x00);
  cart.setWritableImage(img); cart.setState(st);
  bus.write(0xde00, 0x00);
  gate("GMOD2: setWritableImage restores flash 0x3c", bus.read(0x8000) === 0x3c, `r=${bus.read(0x8000)}`);
}

// ============ C64MegaCart (flash040 TYPE_160, 14-bit bank, no EEPROM) ============
{
  const crt = buildCrt({ hwType: 0, exrom: 0, game: 1, nbanks: 256 });
  const bus = new HeadlessMemoryBus(); bus.reset(); bus.setOpenBusProvider(() => 0x3f);
  const cart = loadCartridgeMapperFromBytes(crt, "megacart.crt", "c64megacart");
  bus.attachCartridge(cart); bus.write(0x0001, 0x37);

  gate("MegaCart: type=c64megacart", cart.getMapperType() === "c64megacart");
  // $DF00=0x00 → 8K mode, bank-high 0; $DE00 = bank low.
  bus.write(0xdf00, 0x00); bus.write(0xde00, 0x0a);
  gate("MegaCart: 8K bank 0x0a → $8000 sentinel 0x0a", bus.read(0x8000) === 0x0a, `r=${bus.read(0x8000)}`);
  gate("MegaCart: 8K lines exrom=0 game=1", cart.getLines().exrom === 0 && cart.getLines().game === 1);
  bus.write(0xde00, 0x80);
  gate("MegaCart: bank 0x80 → sentinel 0x80", bus.read(0x8000) === 0x80);
  // 14-bit bank: lo via $DE00, hi via $DF00 (cmode 8K since 0x01 & 0xc0 == 0).
  bus.write(0xde00, 0x05); bus.write(0xdf00, 0x01);
  gate("MegaCart: 14-bit bank = (hi<<8)|lo = 0x105", cart.getState().currentBank === 0x105, `b=${cart.getState().currentBank}`);
  // cmode via $DF00
  bus.write(0xdf00, 0xc0);
  gate("MegaCart: $DF00=0xc0 → ultimax", cart.getLines().exrom === 1 && cart.getLines().game === 0);
  bus.write(0xdf00, 0x80);
  gate("MegaCart: $DF00=0x80 → off", cart.getLines().exrom === 1 && cart.getLines().game === 1);

  // flash program in ultimax (TYPE_160 magic 0xaaa/0x555, bank0 erased=0xff).
  bus.write(0xde00, 0x00); bus.write(0xdf00, 0xc0); // ultimax, bank 0
  bus.write(0x8aaa, 0xAA); bus.write(0x8555, 0x55); bus.write(0x8aaa, 0xA0); bus.write(0x8000, 0x5a);
  bus.write(0xdf00, 0x00); bus.write(0xde00, 0x00); // back to 8K bank0
  gate("MegaCart: ultimax flash program → read 0x5a in 8K", bus.read(0x8000) === 0x5a, `r=${bus.read(0x8000)}`);

  // writable image (2MB flash) + restore
  const img = cart.getWritableImage();
  gate("MegaCart: writable image = 2MB flash", img.length === 0x200000, `len=${img.length}`);
  bus.write(0xdf00, 0xc0); bus.write(0x8aaa, 0xAA); bus.write(0x8555, 0x55); bus.write(0x8aaa, 0xA0); bus.write(0x8000, 0x00);
  bus.write(0xdf00, 0x00); bus.write(0xde00, 0x00);
  gate("MegaCart: flash clobbered to 0", bus.read(0x8000) === 0x00);
  cart.setWritableImage(img);
  gate("MegaCart: setWritableImage restores 0x5a", bus.read(0x8000) === 0x5a, `r=${bus.read(0x8000)}`);
}

// ============ MegaByter (flash800core MX29F800CB, ROML-only) ============
{
  const crt = buildCrt({ hwType: 0, exrom: 0, game: 1, nbanks: 128 });
  const bus = new HeadlessMemoryBus(); bus.reset(); bus.setOpenBusProvider(() => 0x3f);
  const cart = loadCartridgeMapperFromBytes(crt, "megabyter.crt", "megabyter");
  bus.attachCartridge(cart); bus.write(0x0001, 0x37);

  gate("MegaByter: type=megabyter", cart.getMapperType() === "megabyter");
  // $DE02 mode 0 = 8K; $DE00 (bit1=0) = bank.
  bus.write(0xde02, 0x00); bus.write(0xde00, 0x07);
  gate("MegaByter: 8K bank7 → $8000 sentinel 7", bus.read(0x8000) === 7, `r=${bus.read(0x8000)}`);
  gate("MegaByter: mode0 lines 8K exrom=0 game=1", cart.getLines().exrom === 0 && cart.getLines().game === 1);
  bus.write(0xde02, 0x01); gate("MegaByter: mode1 → 16K exrom=0 game=0", cart.getLines().exrom === 0 && cart.getLines().game === 0);
  bus.write(0xde02, 0x02); gate("MegaByter: mode2 → off exrom=1 game=1", cart.getLines().exrom === 1 && cart.getLines().game === 1);
  bus.write(0xde02, 0x03); gate("MegaByter: mode3 → ultimax exrom=1 game=0", cart.getLines().exrom === 1 && cart.getLines().game === 0);

  // flash program in 8K (flash800 magic 0xaaa/0x555 mask 0xfff, bank0 erased).
  bus.write(0xde02, 0x00); bus.write(0xde00, 0x00); // 8K, bank0
  bus.write(0x8aaa, 0xAA); bus.write(0x8555, 0x55); bus.write(0x8aaa, 0xA0); bus.write(0x8000, 0x6b);
  gate("MegaByter: flash800 program → read 0x6b", bus.read(0x8000) === 0x6b, `r=${bus.read(0x8000)}`);

  // writable image (1MB flash) round-trip
  const img = cart.getWritableImage();
  gate("MegaByter: writable image = 1MB flash", img.length === 0x100000, `len=${img.length}`);
  bus.write(0x8aaa, 0xAA); bus.write(0x8555, 0x55); bus.write(0x8aaa, 0xA0); bus.write(0x8000, 0x00);
  gate("MegaByter: clobbered to 0", bus.read(0x8000) === 0x00);
  cart.setWritableImage(img);
  gate("MegaByter: setWritableImage restores 0x6b", bus.read(0x8000) === 0x6b, `r=${bus.read(0x8000)}`);
}

// ============ GMOD3 (spi-flash serial core, dual-mode) ============
{
  const crt = buildCrt({ hwType: 0, exrom: 0, game: 1, nbanks: 256 }); // 2MB
  const bus = new HeadlessMemoryBus(); bus.reset(); bus.setOpenBusProvider(() => 0x3f);
  const cart = loadCartridgeMapperFromBytes(crt, "gmod3.crt", "gmod3");
  bus.attachCartridge(cart); bus.write(0x0001, 0x37);

  gate("GMOD3: type=gmod3", cart.getMapperType() === "gmod3");
  // $DE08=0x00 → 8K (bitbang off, vectors off). $DE00 = bank low.
  bus.write(0xde08, 0x00); bus.write(0xde00, 0x07);
  gate("GMOD3: 8K bank7 → $8000 sentinel 7", bus.read(0x8000) === 7, `r=${bus.read(0x8000)}`);
  gate("GMOD3: 8K lines exrom=0 game=1", cart.getLines().exrom === 0 && cart.getLines().game === 1);
  // 11-bit bank: $DE01 sets bank = value | (1<<8) = 0x105
  bus.write(0xde01, 0x05);
  gate("GMOD3: $DE01=5 → bank 0x105", cart.getState().currentBank === 0x105, `b=${cart.getState().currentBank}`);
  // modes
  bus.write(0xde08, 0x20); gate("GMOD3: $DE08 vectors+b6=0 → ultimax", cart.getLines().exrom === 1 && cart.getLines().game === 0);
  bus.write(0xde08, 0x40); gate("GMOD3: $DE08 b6=1 → off", cart.getLines().exrom === 1 && cart.getLines().game === 1);

  // SPI reflash round-trip: bitbang mode, WRITE_ENABLE + PAGE_PROGRAM(addr0, 0x5a), read via ROM.
  bus.write(0xde08, 0x80); // bitbang on (vectors off, b6=0 → 8K config)
  const spiByte = (b) => { for (let i = 7; i >= 0; i--) { const bit = (b >> i) & 1; bus.write(0xde00, bit << 4); bus.write(0xde00, (bit << 4) | 0x20); } };
  const sel = () => bus.write(0xde00, 0x00);     // cs=0 (active low, selected) → reset shiftregs
  const desel = () => bus.write(0xde00, 0x40);   // cs=1 (deselected) → execute command
  desel(); sel(); spiByte(0x06); desel();        // WRITE_ENABLE
  desel(); sel(); spiByte(0x02); spiByte(0x00); spiByte(0x00); spiByte(0x00); spiByte(0x5a); desel(); // PAGE_PROGRAM addr0 ← 0x5a
  bus.write(0xde08, 0x00); bus.write(0xde00, 0x00); // 8K, bank0, bitbang off
  gate("GMOD3: SPI PAGE_PROGRAM 0x5a@0 → ROML read 0x5a", bus.read(0x8000) === 0x5a, `r=${bus.read(0x8000)}`);

  // SPI READ_DATA serial read-back of addr 0
  bus.write(0xde08, 0x80); // bitbang
  desel(); sel(); spiByte(0x03); spiByte(0x00); spiByte(0x00); spiByte(0x00); // READ_DATA addr0
  let val = 0;
  for (let i = 0; i < 8; i++) { bus.write(0xde00, 0x00); val = (val << 1) | ((bus.read(0xde00) >> 7) & 1); bus.write(0xde00, 0x20); }
  gate("GMOD3: SPI READ_DATA serial read-back = 0x5a", val === 0x5a, `read=0x${val.toString(16)}`);

  const img = cart.getWritableImage();
  gate("GMOD3: writable image = 2MB", img.length === 0x200000, `len=${img.length}`);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 713 device-core: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 713 device-core: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
