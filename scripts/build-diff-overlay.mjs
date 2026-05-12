#!/usr/bin/env node
// Build pixel-diff overlay PNG: differ → red, match → grey-on-vice.
// Visual aid to spot spatial pattern of literal port bugs vs VICE.

import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
function decodePng(buf) {
  let p = 8, width = 0, height = 0, bpp = 4;
  const idats = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p+4, p+8);
    const data = buf.subarray(p+8, p+8+len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); const ct = data[9]; bpp = (ct === 6) ? 4 : (ct === 2 ? 3 : 4); }
    else if (type === "IDAT") idats.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * bpp);
  let prev = Buffer.alloc(stride), ip = 0, op = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[ip++];
    const row = Buffer.from(raw.subarray(ip, ip+stride)); ip += stride;
    if (f === 1) for (let x = bpp; x < stride; x++) row[x] = (row[x] + row[x-bpp]) & 0xff;
    else if (f === 2) for (let x = 0; x < stride; x++) row[x] = (row[x] + prev[x]) & 0xff;
    else if (f === 3) for (let x = 0; x < stride; x++) { const a = x >= bpp ? row[x-bpp] : 0; row[x] = (row[x] + ((a + prev[x]) >> 1)) & 0xff; }
    else if (f === 4) for (let x = 0; x < stride; x++) { const a = x >= bpp ? row[x-bpp] : 0, b = prev[x], c = x >= bpp ? prev[x-bpp] : 0; const pp = a + b - c; const pa = Math.abs(pp-a), pb = Math.abs(pp-b), pc = Math.abs(pp-c); let pr; if (pa <= pb && pa <= pc) pr = a; else if (pb <= pc) pr = b; else pr = c; row[x] = (row[x] + pr) & 0xff; }
    row.copy(out, op); op += stride; prev = row;
  }
  return { width, height, pixels: out };
}

function encodePng(w, h, rgba) {
  // Minimal PNG encoder: IHDR + filtered IDAT + IEND
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // Filter type 0 per row
  const rawLen = h * (1 + w * 4);
  const raw = Buffer.alloc(rawLen);
  let ro = 0;
  for (let y = 0; y < h; y++) {
    raw[ro++] = 0;
    rgba.copy(raw, ro, y * w * 4, (y + 1) * w * 4);
    ro += w * 4;
  }
  const idatBody = deflateSync(raw);
  // CRC table
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c >>> 0;
  }
  const crc = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = (crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0; return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, "ascii"); const cb = Buffer.concat([t, data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(cb), 0); return Buffer.concat([len, cb, c]); };
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idatBody), chunk("IEND", Buffer.alloc(0))]);
}

const pairs = [
  { label: "B-title-vs-04", vice: `${REPO}/samples/vice-reference/scramble/stage-B-title-screenshot.png`, ours: `${REPO}/samples/screenshots/vic-bugs/scramble-04-after-space2.png`, out: `${REPO}/samples/screenshots/vic-bugs/diff-overlay-B.png` },
  { label: "C-ingame-vs-07", vice: `${REPO}/samples/vice-reference/scramble/stage-C-ingame-screenshot.png`, ours: `${REPO}/samples/screenshots/vic-bugs/scramble-07-game-late.png`, out: `${REPO}/samples/screenshots/vic-bugs/diff-overlay-C.png` },
];

for (const pp of pairs) {
  const v = decodePng(readFileSync(pp.vice));
  const o = decodePng(readFileSync(pp.ours));
  if (v.width !== o.width || v.height !== o.height) { console.log(`${pp.label}: dim mismatch`); continue; }
  const W = v.width, H = v.height;
  const out = Buffer.alloc(W * H * 4);
  let differ = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const off = (y * W + x) * 4;
      const sameRGB = v.pixels[off] === o.pixels[off] && v.pixels[off+1] === o.pixels[off+1] && v.pixels[off+2] === o.pixels[off+2];
      if (sameRGB) {
        // dim grey of vice pixel (= half brightness)
        out[off] = v.pixels[off] >> 1;
        out[off+1] = v.pixels[off+1] >> 1;
        out[off+2] = v.pixels[off+2] >> 1;
        out[off+3] = 0xff;
      } else {
        // bright red where differ
        out[off] = 0xff; out[off+1] = 0; out[off+2] = 0; out[off+3] = 0xff;
        differ++;
      }
    }
  }
  writeFileSync(pp.out, encodePng(W, H, out));
  console.log(`${pp.label}: ${differ}/${W*H} differ -> ${pp.out}`);
}
