// Spec 750 Decision 8 — get at the bytes a descriptor describes, so the probe can be
// real rather than a re-print of what the author typed.
//
// A descriptor names addresses in a medium's own terms (a cartridge bank window, a disk
// image). Turning those into file offsets is the only medium-specific step in the whole
// slice, and it is deliberately the ONLY thing this file does — the resolver stays
// medium-agnostic behind `MediumReader`.

import { readFileSync, existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
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

/**
 * Where a `medium_path` may be, in the order the other tools look.
 *
 * Every path-taking tool in this server resolves relative to the project root;
 * `readerForMedium` alone resolved against the process cwd, so
 * `medium_path: "input/disk/CRAZY1.D64"` — the form every other tool takes — reported
 * "no medium at input/disk/CRAZY1.D64" with the file sitting right there, and only an
 * absolute path probed. Silent, because the probe is optional: the descriptor was
 * written, the rows were never checked.
 */
export function mediumSearchPaths(path: string, projectRoot?: string): string[] {
  const out = [isAbsolute(path) ? path : resolve(process.cwd(), path)];
  if (projectRoot && !isAbsolute(path)) out.push(resolve(projectRoot, path));
  return [...new Set(out)];
}

/** The first of `mediumSearchPaths` that exists, or every path that was tried. */
export function resolveMediumPath(path: string, projectRoot?: string): { abs: string } | { tried: string[] } {
  const tried = mediumSearchPaths(path, projectRoot);
  const hit = tried.find((p) => existsSync(p));
  return hit ? { abs: hit } : { tried };
}

/** Pick a reader from the file itself, not from its extension — an image named `.bin`
 *  that starts with the CRT magic is a CRT. Project-relative paths resolve against
 *  `projectRoot`, the same way every other path argument in this server does. */
export function readerForMedium(
  path: string,
  projectRoot?: string,
): { reader: MediumReader; note: string; path: string } | undefined {
  const found = resolveMediumPath(path, projectRoot);
  if (!("abs" in found)) return undefined;
  const abs = found.abs;
  const head = readFileSync(abs).subarray(0, 16).toString("ascii");
  if (head === "C64 CARTRIDGE   ") {
    const { reader, note } = crtReader(abs);
    return { reader, note, path: abs };
  }
  return { ...flatReader(abs), path: abs };
}

// ── the table that is NOT on the medium ─────────────────────────────────────
//
// Every reader above answers in a MEDIUM's terms. A game whose index tables live
// inside a payload the loader has already pulled into RAM has no such address, and a
// .g64 has no usable byte offset to count from in the first place. The workaround was
// to point `medium_path` at the extracted .prg and hand-offset every column by two for
// the CBM load-address word: right numbers, false record, and the two bytes folded in
// by hand where nothing could see them. This is the reader that makes the true framing
// expressible — the addresses stay the RUNTIME ones the disassembly quotes.

const hex4 = (n: number) => `$${(n & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * How many bytes at the head of an extracted payload are not payload.
 *
 * The same rule the disassembly doors use, and for the same reason: THE LOAD ADDRESS
 * DECIDES, never the file name. When the first two bytes ARE the declared load
 * address, the file carries a CBM load word and the body starts at offset 2.
 */
export function inferPayloadHeaderBytes(abs: string, loadAddress: number): { bytes: number; why: string } {
  const buf = readFileSync(abs);
  if (buf.length >= 2 && (buf[0]! | (buf[1]! << 8)) === loadAddress) {
    return {
      bytes: 2,
      why: `its first two bytes are ${hex4(loadAddress)}, the load address you declared, so they are a CBM load word and the body starts at offset 2`,
    };
  }
  return { bytes: 0, why: `its first two bytes are not ${hex4(loadAddress)}, so nothing at the front is treated as a header` };
}

/** Read a LOADED payload by runtime address. `headerBytes` is taken out of the mapping
 *  once, here, so no column address has to carry it. */
export function payloadReader(
  path: string,
  frame: { loadAddress: number; headerBytes?: number },
  projectRoot?: string,
): { reader: MediumReader; note: string; path: string } | undefined {
  const found = resolveMediumPath(path, projectRoot);
  if (!("abs" in found)) return undefined;
  const abs = found.abs;
  const buf = readFileSync(abs);
  const header = frame.headerBytes ?? 0;
  const bodyLength = Math.max(0, buf.length - header);
  const last = frame.loadAddress + bodyLength - 1;
  return {
    reader: {
      readByte(_bank, address) {
        const index = address - frame.loadAddress + header;
        return index >= header && index < buf.length ? buf[index] : undefined;
      },
    },
    note: `${basename(abs)} as a LOADED PAYLOAD — ${bodyLength} bytes running ${hex4(frame.loadAddress)}-${hex4(last)}`
      + `${header > 0 ? `, ${header} header byte(s) skipped` : ", no header bytes"}`
      + `; column addresses are RUNTIME addresses, not offsets into the file`,
    path: abs,
  };
}

/** The refusal a caller gets when nothing was found: what was tried, not just what failed. */
export function noMediumMessage(path: string, projectRoot?: string): string {
  const tried = mediumSearchPaths(path, projectRoot);
  return `no medium at ${path} — tried ${tried.join(" and ")}. `
    + `Paths are resolved against the project root, like every other path argument; an absolute path also works.`;
}
