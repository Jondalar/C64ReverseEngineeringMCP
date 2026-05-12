#!/usr/bin/env node
// Sprint 96 — sanity check what files MM disk contains by parsing
// directory directly via G64 parser.

import { existsSync, readFileSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) process.exit(2);

const { G64Parser } = await import("../dist/disk/g64-parser.js");
const parser = new G64Parser(readFileSync(disk));
console.log(`G64: parser ready`);

const t18 = parser.getRawTrackBytes(18);
if (!t18) { console.log("track 18 empty"); process.exit(0); }
console.log(`track 18 raw: ${t18.length} bytes`);

// Find header sync runs and decode 5-byte headers.
let headers = [];
let i = 0;
while (i < t18.length) {
  // Skip non-FF
  while (i < t18.length && t18[i] !== 0xff) i++;
  // Count FF run
  let runStart = i;
  while (i < t18.length && t18[i] === 0xff) i++;
  const runLen = i - runStart;
  if (runLen >= 5 && i + 5 < t18.length) {
    headers.push({ pos: i, runLen, byte0: t18[i], next4: [...t18.slice(i, i+5)] });
    i += 5; // skip past header data
  }
}

console.log(`\nFound ${headers.length} header-after-sync candidates:`);
for (const h of headers.slice(0, 30)) {
  console.log(`  pos=${h.pos} ffRun=${h.runLen} bytes=${h.next4.map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
}

// Decode GCR for first few header candidates. GCR table:
const GCR = { 0x0a:0, 0x0b:1, 0x12:2, 0x13:3, 0x0e:4, 0x0f:5, 0x16:6, 0x17:7,
  0x09:8, 0x19:9, 0x1a:0xa, 0x1b:0xb, 0x0d:0xc, 0x1d:0xd, 0x1e:0xe, 0x15:0xf };
function decodeGcr5to4(bytes) {
  // 5 GCR bytes = 40 bits = 8 nibbles → 4 decoded bytes
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  const out = [];
  for (let n = 7; n >= 0; n--) {
    const nib = Number((bits >> BigInt(n*5)) & 0x1fn);
    out.push(GCR[nib] ?? -1);
  }
  // pack into 4 bytes (high-nib first, low-nib next)
  const decoded = [];
  for (let k = 0; k < 4; k++) decoded.push((out[k*2] << 4) | out[k*2+1]);
  return decoded;
}

console.log(`\nDecoded headers (header marker $08 expected):`);
for (const h of headers.slice(0, 12)) {
  const dec = decodeGcr5to4(h.next4);
  console.log(`  pos=${h.pos} → ${dec.map(b=>(b<0?"??":b.toString(16).padStart(2,"0"))).join(" ")}`);
}
