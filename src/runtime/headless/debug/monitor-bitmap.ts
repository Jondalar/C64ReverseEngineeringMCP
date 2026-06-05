// Spec 754 §3.3b — RAM-as-bitmap render for the monitor (`bitmap` verb). A text
// console can't inline an image, so this decodes a memory range to RGBA per the
// chosen C64 graphics mode and writes a PNG artifact (the caller returns its path).
//
// Self-contained + runtime-pure: a minimal PNG encoder over node:zlib (no image
// dependency, no WS/UI bridge — same posture as the Block G file-IO).

import { deflateSync } from "node:zlib";

export type BitmapMode = "hires" | "charset" | "sprite";
export interface BitmapOpts { addr: number; w: number; h: number; mode: BitmapMode; }

// Monochrome palette (bit set = foreground). C64-ish blue so it reads as a screen.
const FG: readonly [number, number, number] = [0xcc, 0xcc, 0xff];
const BG: readonly [number, number, number] = [0x20, 0x20, 0x40];

type Read = (addr: number) => number;

/** Decode a memory range to an RGBA buffer for the mode. Returns pixels + dims. */
function decode(read: Read, o: BitmapOpts): { rgba: Uint8Array; width: number; height: number } {
  let width: number, height: number;
  let plot: (set: (x: number, y: number, on: boolean) => void) => void;

  if (o.mode === "charset") {
    // w×h grid of 8×8 char cells; 8 bytes per cell.
    width = o.w * 8; height = o.h * 8;
    plot = (set) => {
      for (let cy = 0; cy < o.h; cy++) for (let cx = 0; cx < o.w; cx++) {
        const base = o.addr + (cy * o.w + cx) * 8;
        for (let r = 0; r < 8; r++) {
          const byte = read((base + r) & 0xffff);
          for (let b = 0; b < 8; b++) set(cx * 8 + b, cy * 8 + r, !!((byte >> (7 - b)) & 1));
        }
      }
    };
  } else if (o.mode === "sprite") {
    // w×h grid of 24×21 sprites; 3 bytes/row × 21 rows, 64-byte stride.
    width = o.w * 24; height = o.h * 21;
    plot = (set) => {
      for (let sy = 0; sy < o.h; sy++) for (let sx = 0; sx < o.w; sx++) {
        const base = o.addr + (sy * o.w + sx) * 64;
        for (let r = 0; r < 21; r++) for (let bcol = 0; bcol < 3; bcol++) {
          const byte = read((base + r * 3 + bcol) & 0xffff);
          for (let b = 0; b < 8; b++) set(sx * 24 + bcol * 8 + b, sy * 21 + r, !!((byte >> (7 - b)) & 1));
        }
      }
    };
  } else {
    // hires: w bytes/row → w*8 px wide, h rows tall; linear (not VIC char-interleaved).
    width = o.w * 8; height = o.h;
    plot = (set) => {
      for (let y = 0; y < o.h; y++) for (let bx = 0; bx < o.w; bx++) {
        const byte = read((o.addr + y * o.w + bx) & 0xffff);
        for (let b = 0; b < 8; b++) set(bx * 8 + b, y, !!((byte >> (7 - b)) & 1));
      }
    };
  }

  const rgba = new Uint8Array(width * height * 4);
  const set = (x: number, y: number, on: boolean) => {
    const i = (y * width + x) * 4; const c = on ? FG : BG;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 0xff;
  };
  plot(set);
  return { rgba, width, height };
}

// ---- minimal PNG encoder (RGBA, filter 0) over node:zlib --------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const t = Buffer.from(type, "latin1");
  const body = Buffer.concat([t, Buffer.from(data)]);
  const out = Buffer.alloc(8 + body.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + body.length);
  return out;
}
function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit, RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1); }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

/** Render a memory range to a PNG buffer (+ dims) for the given mode. */
export function renderBitmapPng(read: Read, o: BitmapOpts): { png: Buffer; width: number; height: number; bytes: number } {
  const { rgba, width, height } = decode(read, o);
  const bytes = o.mode === "charset" ? o.w * o.h * 8 : o.mode === "sprite" ? o.w * o.h * 64 : o.w * o.h;
  return { png: encodePng(rgba, width, height), width, height, bytes };
}
