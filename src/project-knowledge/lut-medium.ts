// Spec 750 Decision 8 — get at the bytes a descriptor describes, so the probe can be
// real rather than a re-print of what the author typed.
//
// A descriptor names addresses in a medium's own terms (a cartridge bank window, a disk
// image). Turning those into file offsets is the only medium-specific step in the whole
// slice, and it is deliberately the ONLY thing this file does — the resolver stays
// medium-agnostic behind `MediumReader`.

import { readFileSync, existsSync } from "node:fs";
import type { MediumReader } from "./lut-resolver.js";

/** A .crt is a 64-byte header followed by CHIP packets, each with its own 16-byte
 *  header carrying the bank number and the load address of that chip's window. Read
 *  the packets once, then serve bytes by (bank, address).
 *
 *  Ported from the container facts only — the CRT container layout is public
 *  (VICE `crt.c`), and nothing here knows or cares how a cartridge is BUILT. */
export function crtReader(path: string): { reader: MediumReader; banks: number; note: string } {
  const buf = readFileSync(path);
  const chips: Array<{ bank: number; load: number; data: Buffer }> = [];

  if (buf.length < 0x40 || buf.subarray(0, 16).toString("ascii") !== "C64 CARTRIDGE   ") {
    // Not a .crt: serve it flat, addressed from 0. A raw .bin still has a table in it.
    return {
      reader: { readByte: (_bank, addr) => (addr >= 0 && addr < buf.length ? buf[addr] : undefined) },
      banks: 1,
      note: `flat image, ${buf.length} bytes, addressed from $0000`,
    };
  }

  const headerLen = buf.readUInt32BE(0x10);
  let off = headerLen;
  while (off + 16 <= buf.length) {
    if (buf.subarray(off, off + 4).toString("ascii") !== "CHIP") break;
    const packetLen = buf.readUInt32BE(off + 4);
    const bank = buf.readUInt16BE(off + 10);
    const load = buf.readUInt16BE(off + 12);
    const size = buf.readUInt16BE(off + 14);
    const data = buf.subarray(off + 16, off + 16 + size);
    chips.push({ bank, load, data });
    off += packetLen > 0 ? packetLen : 16 + size;
  }

  const reader: MediumReader = {
    readByte(bank, address) {
      // A column may omit its bank (the table sits in whatever bank is mapped in);
      // default to 0, which is where a boot table lives in every layout seen so far.
      const want = bank ?? 0;
      for (const c of chips) {
        if (c.bank !== want) continue;
        const rel = address - c.load;
        if (rel >= 0 && rel < c.data.length) return c.data[rel];
      }
      return undefined;
    },
  };
  const bankSet = new Set(chips.map((c) => c.bank));
  return {
    reader,
    banks: bankSet.size,
    note: `${chips.length} CHIP packets, ${bankSet.size} bank(s), windows ${[...new Set(chips.map((c) => `$${c.load.toString(16)}`))].join("/")}`,
  };
}

/** A disk image addressed linearly (D64: 256-byte sectors in track order). A table in
 *  a directory sector is addressed by its offset into the image. */
export function flatReader(path: string): { reader: MediumReader; note: string } {
  const buf = readFileSync(path);
  return {
    reader: { readByte: (_bank, addr) => (addr >= 0 && addr < buf.length ? buf[addr] : undefined) },
    note: `${buf.length} bytes, addressed from $0000`,
  };
}

/** Pick a reader from the file itself, not from its extension — an image named `.bin`
 *  that starts with the CRT magic is a CRT. */
export function readerForMedium(path: string): { reader: MediumReader; note: string } | undefined {
  if (!existsSync(path)) return undefined;
  const head = readFileSync(path).subarray(0, 16).toString("ascii");
  if (head === "C64 CARTRIDGE   ") {
    const { reader, note } = crtReader(path);
    return { reader, note };
  }
  return flatReader(path);
}
