// Synthetic cartridge images for the Spec 909 gates — built here, byte by byte. No third-party bytes.
//
// `makeCrt` writes a .crt: header (hardware type at $16), then one CHIP packet per bank, each `size` bytes at $8000.
// The code of a bank sits at the start of its chip and the rest is `fill`, so two images differ in a way a byte
// compare and a listing both show.
import { Buffer } from "node:buffer";

export const HW_GMOD2 = 60;
export const HW_EASYFLASH = 32;

/** banks: [{ bank, code: number[], at?: number, fill?: number, patches?: [{ at, bytes }] }] */
export function makeCrt({ name, hardwareType, banks, size = 32, load = 0x8000 }) {
  const hdr = 0x40, pkt = 0x10 + size;
  const crt = Buffer.alloc(hdr + pkt * banks.length, 0);
  crt.write("C64 CARTRIDGE   ", 0, "ascii");
  crt.writeUInt32BE(hdr, 0x10);
  crt.writeUInt16BE(0x0100, 0x14);
  crt.writeUInt16BE(hardwareType, 0x16);
  crt[0x18] = 0x00; // EXROM
  crt[0x19] = 0x01; // GAME
  crt.write(name, 0x20, "ascii");
  banks.forEach((b, i) => {
    const at = hdr + pkt * i;
    crt.write("CHIP", at, "ascii");
    crt.writeUInt32BE(pkt, at + 4);
    crt.writeUInt16BE(0, at + 8); // ROM
    crt.writeUInt16BE(b.bank, at + 0x0a);
    crt.writeUInt16BE(load, at + 0x0c);
    crt.writeUInt16BE(size, at + 0x0e);
    const data = Buffer.alloc(size, b.fill ?? 0xea);
    Buffer.from(b.code).copy(data, b.at ?? 0);
    for (const p of b.patches ?? []) Buffer.from(p.bytes).copy(data, p.at);
    data.copy(crt, at + 0x10);
  });
  return crt;
}

/** The bytes of one bank's chip, as the image holds them. */
export function chipBytes(crt, index, size = 32) {
  const hdr = 0x40, pkt = 0x10 + size;
  return crt.subarray(hdr + pkt * index + 0x10, hdr + pkt * index + 0x10 + size);
}

// 8000: lda #n / sta $DE00 / jmp $8000   — a store to the cartridge's control register, named by the type
export const bankSwitchCode = (n) => [0xa9, n, 0x8d, 0x00, 0xde, 0x4c, 0x00, 0x80];
