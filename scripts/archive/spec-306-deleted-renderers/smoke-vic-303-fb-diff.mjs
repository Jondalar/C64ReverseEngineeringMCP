#!/usr/bin/env node
// Spec 303 framebuffer diff harness.
//
// Boot BASIC ready, render the same frame two ways:
//   1. snapshot path (vice-rasterized)
//   2. literal-port path
// Read both PNGs, decode RGBA, compute per-pixel match %, distinct
// color counts, worst-rows report. Informational gate (no hard
// threshold yet — literal port pixel completeness is ~95% on text
// scenes per Phase 5 mini Phase 0).

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);

const OUT_DIR = `${REPO}/samples/screenshots/literal-port`;
mkdirSync(OUT_DIR, { recursive: true });

console.log("Spec 303 framebuffer diff — BASIC ready");

const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
  useLiteralPortRenderer: true,
  useLiteralPortVicPerCycle: true,
  useLiteralPortVicReads: true,
  useLiteralPortVicIrq: true,
  useLiteralPortVicStall: true,
  useLiteralPortVicFb: true,  // sets default but we override below
  usePerCycleBusStealing: true,
  useCycleLockstep: true,
});
s.resetCold("pal-default");
s.runFor(2_000_000, { cycleBudget: 3_000_000 });

const vicePath = `${OUT_DIR}/spec-303-vice-rasterized.png`;
const litPath  = `${OUT_DIR}/spec-303-literal-port.png`;

// Render both explicitly.
s.renderToPng(vicePath, { renderer: "vice-rasterized" });
s.renderToPng(litPath,  { renderer: "literal-port" });

stopIntegratedSession(sessionId);

// Minimal PNG decoder (RGBA, no palette PNGs expected).
function decodePng(buf) {
  // Skip 8-byte signature.
  let p = 8;
  let width = 0, height = 0, bpp = 4;
  const idatChunks = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colorType = data[9];
      bpp = (colorType === 6) ? 4 : (colorType === 2 ? 3 : 4);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    p += 12 + len;
  }
  const idat = Buffer.concat(idatChunks);
  const raw = inflateSync(idat);
  // Per-row filter byte at start of each row.
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * bpp);
  let prevRow = Buffer.alloc(stride);
  let ip = 0, op = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[ip++];
    const row = Buffer.from(raw.subarray(ip, ip + stride));
    ip += stride;
    if (filter === 0) {
      // none
    } else if (filter === 1) {
      // sub
      for (let x = bpp; x < stride; x++) row[x] = (row[x] + row[x - bpp]) & 0xff;
    } else if (filter === 2) {
      // up
      for (let x = 0; x < stride; x++) row[x] = (row[x] + prevRow[x]) & 0xff;
    } else if (filter === 3) {
      // average
      for (let x = 0; x < stride; x++) {
        const left = x >= bpp ? row[x - bpp] : 0;
        const up = prevRow[x];
        row[x] = (row[x] + ((left + up) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      // paeth
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prevRow[x];
        const c = x >= bpp ? prevRow[x - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        let pred;
        if (pa <= pb && pa <= pc) pred = a;
        else if (pb <= pc) pred = b;
        else pred = c;
        row[x] = (row[x] + pred) & 0xff;
      }
    } else {
      throw new Error(`unknown PNG filter: ${filter}`);
    }
    row.copy(out, op);
    op += stride;
    prevRow = row;
  }
  return { width, height, bpp, pixels: out };
}

const vicePng = decodePng(readFileSync(vicePath));
const litPng  = decodePng(readFileSync(litPath));

console.log(`vice: ${vicePng.width}×${vicePng.height} bpp=${vicePng.bpp}`);
console.log(`lit:  ${litPng.width}×${litPng.height} bpp=${litPng.bpp}`);

if (vicePng.width !== litPng.width || vicePng.height !== litPng.height) {
  console.log(`FAIL: dimension mismatch (vice=${vicePng.width}x${vicePng.height} lit=${litPng.width}x${litPng.height})`);
  process.exit(1);
}

const W = vicePng.width;
const H = vicePng.height;
const bpp = 4;
let exact = 0;
let differ = 0;
const perRowDiffer = new Int32Array(H);
const distinctVice = new Set();
const distinctLit = new Set();

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const off = (y * W + x) * bpp;
    const vR = vicePng.pixels[off], vG = vicePng.pixels[off+1], vB = vicePng.pixels[off+2];
    const lR = litPng.pixels[off],  lG = litPng.pixels[off+1],  lB = litPng.pixels[off+2];
    distinctVice.add((vR << 16) | (vG << 8) | vB);
    distinctLit.add((lR << 16)  | (lG << 8)  | lB);
    if (vR === lR && vG === lG && vB === lB) {
      exact++;
    } else {
      differ++;
      perRowDiffer[y]++;
    }
  }
}

const total = W * H;
const pct = (exact * 100 / total).toFixed(2);

const sortedRows = [];
for (let y = 0; y < H; y++) sortedRows.push({ row: y, n: perRowDiffer[y] });
sortedRows.sort((a, b) => b.n - a.n);

const out = {
  width: W, height: H, total,
  exact, differ,
  matchPct: parseFloat(pct),
  distinctViceColors: distinctVice.size,
  distinctLitColors: distinctLit.size,
  worst10Rows: sortedRows.slice(0, 10),
};
writeFileSync(`${OUT_DIR}/spec-303-fb-diff.json`, JSON.stringify(out, null, 2));

console.log(`exact match: ${exact}/${total} (${pct}%)`);
console.log(`differ:      ${differ}`);
console.log(`distinct colors vice=${distinctVice.size} lit=${distinctLit.size}`);
console.log(`worst rows: ${sortedRows.slice(0, 5).map(r => `${r.row}=${r.n}`).join(", ")}`);

// Informational gate only — literal port not required to be byte-perfect
// vs snapshot renderer (different crop offsets + L/R border simplification).
// PASS = literal frame has any pixels at all + no decode crash.
const litNonEmpty = distinctLit.size > 1;
console.log(`  ${litNonEmpty ? "PASS" : "FAIL"}: literal frame non-empty (>1 distinct color)`);
process.exit(litNonEmpty ? 0 : 1);
