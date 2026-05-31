// BUG-023-cart / Spec 742 — writable cartridge (EasyFlash) host-file persistence.
//
// Same class as the disk write-through: a flash-programming cart must persist to
// its host .crt file, not only RAM/checkpoint. Proves the .crt re-pack
// (flash → CHIP packets) + host-file write-back, against a synthetic EasyFlash
// .crt, re-reading the file from the filesystem.
import { mkdtempSync, writeFileSync, readFileSync, statSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-023-cart — EasyFlash .crt host-file write-back (re-pack)\n");

const dist = join(ROOT, "dist/runtime/headless");
if (!existsSync(join(dist, "cartridge.js"))) { console.error("build:mcp first"); process.exit(2); }
const { loadCartridgeMapperFromBytes } = await import(join(dist, "cartridge.js"));
const { persistCartridgeToFile } = await import(join(dist, "media/persist-cartridge.js"));

// ---- build a minimal synthetic EasyFlash .crt: header + bank0 ROML + bank0 ROMH ----
const B = (n) => n & 0xff;
function u16be(n) { return [B(n >> 8), B(n)]; }
function u32be(n) { return [B(n >> 24), B(n >> 16), B(n >> 8), B(n)]; }
function chip(bank, load, data) {
  const size = data.length;
  return [...Buffer.from("CHIP"), ...u32be(16 + size), ...u16be(2 /*flash*/), ...u16be(bank), ...u16be(load), ...u16be(size), ...data];
}
function buildEfCrt(romlBank0, romhBank0) {
  const header = [
    ...Buffer.from("C64 CARTRIDGE   "), ...u32be(0x40), ...u16be(0x0100), ...u16be(32 /*EasyFlash*/),
    1, 1, // exrom, game
    0, 0, 0, 0, 0, 0, // reserved to 0x20
    ...Array.from(Buffer.from("TESTEF\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0".subarray?.(0, 32) ?? "TESTEF")),
  ];
  while (header.length < 0x40) header.push(0);
  return Uint8Array.from([...header.slice(0, 0x40), ...chip(0, 0x8000, romlBank0), ...chip(0, 0xa000, romhBank0)]);
}

const ROML0 = new Uint8Array(0x2000); for (let i = 0; i < 0x2000; i++) ROML0[i] = (i ^ 0x11) & 0xff;
const ROMH0 = new Uint8Array(0x2000); for (let i = 0; i < 0x2000; i++) ROMH0[i] = (i ^ 0x22) & 0xff;
const crt = buildEfCrt(ROML0, ROMH0);

const work = mkdtempSync(join(tmpdir(), "c64re-023cart-"));
const crtPath = join(work, "test_ef.crt");
writeFileSync(crtPath, crt);
const past = new Date(Date.now() - 5_000_000);
utimesSync(crtPath, past, past);

// mount the mapper from the file bytes
const mapper = loadCartridgeMapperFromBytes(new Uint8Array(readFileSync(crtPath)), "test_ef.crt");
ok(typeof mapper.getCrtImage === "function", "0 EasyFlash mapper exposes getCrtImage (re-pack)");

// simulate a flash program: change bank0 ROML + ROMH via setWritableImage
// (getWritableImage layout = loFlash[64*8K] ++ hiFlash[64*8K]).
const FLASH = mapper.getWritableImage();
const LO_LEN = FLASH.length / 2;
const NEW_LO = new Uint8Array(0x2000); for (let i = 0; i < 0x2000; i++) NEW_LO[i] = (i ^ 0xa5) & 0xff;
const NEW_HI = new Uint8Array(0x2000); for (let i = 0; i < 0x2000; i++) NEW_HI[i] = (i ^ 0x5a) & 0xff;
const mut = new Uint8Array(FLASH);
mut.set(NEW_LO, 0);          // bank0 ROML
mut.set(NEW_HI, LO_LEN);     // bank0 ROMH
mapper.setWritableImage(mut);
const eq = (a, b, off = 0) => { for (let i = 0; i < b.length; i++) if (a[off + i] !== b[i]) return false; return true; };
const chip0DataOff = 0x40 + 16; // first CHIP packet (ROML) data

// re-pack: getCrtImage emits the original .crt with bank0 ROML overwritten by
// the live flash, preserving header / load addresses / chip order.
const repacked = mapper.getCrtImage();
ok(!!repacked && repacked.length === crt.length, "1 getCrtImage re-packs to a same-size .crt");
ok(eq(repacked, NEW_LO, chip0DataOff), "2 re-packed .crt ROML bank0 == the live flash (re-pack correct)",
  eq(repacked, NEW_LO, chip0DataOff) ? "8192 bytes" : `first byte $${repacked[chip0DataOff].toString(16)}`);
// header + chip structure unchanged
ok(Buffer.from(repacked.subarray(0, 16)).toString("ascii") === "C64 CARTRIDGE   " && eq(repacked, crt.subarray(0, 0x40)),
  "2b re-packed .crt keeps the original header + chip layout");

// host write-back: write the re-packed image to the host .crt, re-read it.
writeFileSync(crtPath, repacked);
const host = readFileSync(crtPath);
ok(eq(host, NEW_LO, chip0DataOff) && statSync(crtPath).mtimeMs > past.getTime(),
  "3 host .crt file written with the programmed flash + mtime advanced");

// re-mount the persisted .crt → the mapper sees the programmed flash
const mapper2 = loadCartridgeMapperFromBytes(new Uint8Array(readFileSync(crtPath)), "test_ef.crt");
const flash2 = mapper2.getWritableImage();
ok(eq(flash2, NEW_LO, 0) && eq(flash2, NEW_HI, flash2.length / 2), "4 re-mount from filesystem sees the programmed flash (ROML+ROMH)");

// the persist guard skips a fresh (non-dirty) cart — correct: no needless rewrite
const fresh = loadCartridgeMapperFromBytes(new Uint8Array(readFileSync(crtPath)), "test_ef.crt");
const skip = persistCartridgeToFile(fresh, crtPath);
ok(skip.written === false && /not dirty/i.test(skip.reason || ""), "5 persist skips a non-dirty cartridge (no redundant host write)", skip.reason);

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-023-cart-write-through: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
