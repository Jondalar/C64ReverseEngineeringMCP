// Synthetic media for the Spec 910 tests, built here byte by byte. No third-party bytes, no game data.
import { Buffer } from "node:buffer";

const spt = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);

/** A blank, formatted 35-track D64 the 1541 can SAVE to. */
export function blankD64(name = "WORK") {
  const d = new Uint8Array(174_848);
  let bam = 0;
  for (let t = 1; t < 18; t++) bam += spt(t) * 256;
  d[bam] = 18; d[bam + 1] = 1; d[bam + 2] = 0x41;
  for (let t = 1; t <= 35; t++) {
    const n = spt(t);
    const used = t === 18 ? 0b11 : 0;
    const free = ((1 << n) - 1) & ~used;
    const e = bam + 4 + (t - 1) * 4;
    d[e] = [...free.toString(2)].filter((c) => c === "1").length;
    d[e + 1] = free & 0xff; d[e + 2] = (free >> 8) & 0xff; d[e + 3] = (free >> 16) & 0xff;
  }
  for (let i = 0; i < 16; i++) d[bam + 0x90 + i] = i < name.length ? name.toUpperCase().charCodeAt(i) : 0xa0;
  d[bam + 0xa0] = 0xa0; d[bam + 0xa1] = 0xa0; d[bam + 0xa2] = 0x41; d[bam + 0xa3] = 0x42; d[bam + 0xa4] = 0xa0; d[bam + 0xa5] = 0x32; d[bam + 0xa6] = 0x41;
  d[bam + 256 + 1] = 0xff;
  return d;
}

/** The file names in the directory of a D64 (track 18 from sector 1). */
export function d64Files(d) {
  const off = (t, s) => { let o = 0; for (let k = 1; k < t; k++) o += spt(k); return (o + s) * 256; };
  const out = [];
  let [t, s] = [18, 1];
  for (let i = 0; i < 19; i++) {
    const b = off(t, s);
    for (let k = 0; k < 8; k++) {
      const e = b + k * 32;
      if (d[e + 2] & 0x80) {
        const name = [];
        for (let j = 5; j < 21 && d[e + j] !== 0xa0; j++) name.push(d[e + j]);
        out.push(Buffer.from(name).toString("latin1"));
      }
    }
    if (d[b] === 0) break;
    [t, s] = [d[b], d[b + 1]];
  }
  return out;
}

/** `10 SAVE"0:T",8` / `20 VERIFY"T",8` / `30 POKE2,42`: the program writes, reads its write back through the drive, then marks $0002. */
export function saveProgram(unit = 8) {
  const lines = [
    [10, Buffer.concat([Buffer.from([0x94]), Buffer.from(`"0:T",${unit}`)])],
    [20, Buffer.concat([Buffer.from([0x95]), Buffer.from(`"T",${unit}`)])],
    [30, Buffer.concat([Buffer.from([0x97]), Buffer.from("2,42")])],
  ];
  const out = [0x01, 0x08];
  let addr = 0x0801;
  for (const [n, body] of lines) {
    const next = addr + 4 + body.length + 1;
    out.push(next & 0xff, next >> 8, n & 0xff, n >> 8, ...body, 0);
    addr = next;
  }
  out.push(0, 0);
  return Buffer.from(out);
}

function crtHeader(type, exrom, game, name) {
  const h = Buffer.alloc(0x40);
  h.write("C64 CARTRIDGE   ", 0, "ascii");
  h.writeUInt32BE(0x40, 0x10); h.writeUInt16BE(0x0100, 0x14); h.writeUInt16BE(type, 0x16);
  h[0x18] = exrom; h[0x19] = game;
  h.write(name, 0x20, "ascii");
  return h;
}
function chip(bank, load, data) {
  const h = Buffer.alloc(0x10);
  h.write("CHIP", 0, "ascii");
  h.writeUInt32BE(0x10 + data.length, 4); h.writeUInt16BE(0, 8); h.writeUInt16BE(bank, 0x0a);
  h.writeUInt16BE(load, 0x0c); h.writeUInt16BE(data.length, 0x0e);
  return Buffer.concat([h, data]);
}

/** An EasyFlash CRT whose ultimax boot code (in ROMH) programs the byte at $8100 of ROML to $42 and spins. */
export function efCrt({ writes = true } = {}) {
  const romh = Buffer.alloc(0x2000, 0xff);
  const code = writes
    ? [0x78, 0xa9, 0xaa, 0x8d, 0x55, 0x85, 0xa9, 0x55, 0x8d, 0xaa, 0x82, 0xa9, 0xa0, 0x8d, 0x55, 0x85, 0xa9, 0x42, 0x8d, 0x00, 0x81, 0x4c, 0x15, 0xe0]
    : [0x4c, 0x00, 0xe0, 0xea];
  Buffer.from(code).copy(romh, 0);
  for (const v of [0x1ffa, 0x1ffc, 0x1ffe]) { romh[v] = v === 0x1ffc ? 0x00 : 0x15; romh[v + 1] = 0xe0; }
  return Buffer.concat([crtHeader(32, 1, 0, "NOWRITEB"), chip(0, 0x8000, Buffer.alloc(0x2000, 0xff)), chip(0, 0xa000, romh)]);
}

/** An 8K cartridge whose cold start is $800C: SEI, then INC $C000 forever. */
export function coldStartCrt(name = "COLDSTART") {
  const rom = Buffer.alloc(0x2000, 0xea);
  Buffer.from([0x0c, 0x80, 0x0c, 0x80, 0xc3, 0xc2, 0xcd, 0x38, 0x30]).copy(rom, 0); // cold, warm, CBM80
  Buffer.from([0x78, 0xee, 0x00, 0xc0, 0x4c, 0x0d, 0x80]).copy(rom, 0x0c);
  return Buffer.concat([crtHeader(0, 0, 1, name), chip(0, 0x8000, rom)]);
}
export const COLD_START = 0x800c;
