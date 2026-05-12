#!/usr/bin/env node
// Pixel diff: our naturally-driven scramble stages 04+07 vs VICE
// reference PNGs B+C.

import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
function decodePng(buf) {
  let p = 8;
  let width = 0, height = 0, bpp = 4;
  const idats = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p+4, p+8);
    const data = buf.subarray(p+8, p+8+len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const ct = data[9]; bpp = (ct === 6) ? 4 : (ct === 2 ? 3 : 4); }
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
    else if (f === 3) for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x-bpp] : 0;
      row[x] = (row[x] + ((a + prev[x]) >> 1)) & 0xff;
    } else if (f === 4) for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x-bpp] : 0, b = prev[x], c = x >= bpp ? prev[x-bpp] : 0;
      const pp = a + b - c;
      const pa = Math.abs(pp-a), pb = Math.abs(pp-b), pc = Math.abs(pp-c);
      let pr; if (pa <= pb && pa <= pc) pr = a; else if (pb <= pc) pr = b; else pr = c;
      row[x] = (row[x] + pr) & 0xff;
    }
    row.copy(out, op); op += stride; prev = row;
  }
  return { width, height, bpp, pixels: out };
}

const pairs = [
  { label: "B-title-vs-04", vice: `${REPO}/samples/vice-reference/scramble/stage-B-title-screenshot.png`, ours: `${REPO}/samples/screenshots/vic-bugs/scramble-04-after-space2.png` },
  { label: "C-ingame-vs-07", vice: `${REPO}/samples/vice-reference/scramble/stage-C-ingame-screenshot.png`, ours: `${REPO}/samples/screenshots/vic-bugs/scramble-07-game-late.png` },
];

for (const p of pairs) {
  console.log(`\n=== ${p.label} ===`);
  const v = decodePng(readFileSync(p.vice));
  const o = decodePng(readFileSync(p.ours));
  console.log(`  vice ${v.width}x${v.height}  ours ${o.width}x${o.height}`);
  if (v.width !== o.width || v.height !== o.height) { console.log("  DIM MISMATCH"); continue; }
  let exact = 0, differ = 0;
  const rowDiffs = new Int32Array(v.height);
  // Per-row distinct-color tracking to spot stripe pattern
  for (let y = 0; y < v.height; y++) {
    for (let x = 0; x < v.width; x++) {
      const off = (y * v.width + x) * 4;
      if (v.pixels[off] === o.pixels[off] && v.pixels[off+1] === o.pixels[off+1] && v.pixels[off+2] === o.pixels[off+2]) exact++;
      else { differ++; rowDiffs[y]++; }
    }
  }
  const total = v.width * v.height;
  console.log(`  exact=${exact}/${total} (${(exact*100/total).toFixed(2)}%)  differ=${differ}`);
  // Print row diff histogram bands
  const bands = 8;
  const bandH = Math.ceil(v.height / bands);
  const bandTotals = new Array(bands).fill(0);
  for (let y = 0; y < v.height; y++) bandTotals[Math.floor(y / bandH)] += rowDiffs[y];
  console.log(`  row-band diff totals (${bands} bands of ${bandH}px):`);
  for (let i = 0; i < bands; i++) {
    const yStart = i * bandH;
    const yEnd = Math.min((i+1)*bandH - 1, v.height - 1);
    const pct = (bandTotals[i] * 100 / (bandH * v.width)).toFixed(1);
    const bar = "#".repeat(Math.floor(parseFloat(pct) / 2));
    console.log(`    rows ${yStart.toString().padStart(3)}-${yEnd.toString().padStart(3)}: ${pct.padStart(5)}% ${bar}`);
  }
  // Top 12 worst rows
  const sorted = [];
  for (let y = 0; y < v.height; y++) sorted.push({ y, n: rowDiffs[y] });
  sorted.sort((a,b) => b.n - a.n);
  console.log(`  worst 12 rows:`);
  for (const r of sorted.slice(0, 12)) console.log(`    row ${r.y.toString().padStart(3)}: ${r.n}/${v.width} differ (${(r.n*100/v.width).toFixed(0)}%)`);
}
