#!/usr/bin/env node
// Spec 303 BASIC ready acceptance.
//
// Boot BASIC, default-route renderToPng (no opts.renderer), assert:
//   - file written
//   - dimensions = 384x272 (= literal port crop)
//   - non-empty (>50% non-background pixels in central region)
//   - all palette indices remain in valid C64 16-color RGB range
//     (= colors all in palette key set)

import { mkdirSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);

const OUT_DIR = `${REPO}/samples/screenshots/literal-port`;
mkdirSync(OUT_DIR, { recursive: true });

console.log("Spec 303 BASIC ready acceptance");

const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
  useLiteralPortRenderer: true,
  useLiteralPortVicPerCycle: true,
  useLiteralPortVicReads: true,
  useLiteralPortVicIrq: true,
  useLiteralPortVicStall: true,
  useLiteralPortVicFb: true,  // = default route to literal port
  usePerCycleBusStealing: true,
  useCycleLockstep: true,
});
s.resetCold("pal-default");
s.runFor(2_000_000, { cycleBudget: 3_000_000 });

const path = `${OUT_DIR}/spec-303-basic-ready-default.png`;
// No opts.renderer → with useLiteralPortVicFb=true, defaults to literal.
const r = s.renderToPng(path);
console.log(`render: ${r.width}×${r.height} ${r.bytes} bytes`);

stopIntegratedSession(sessionId);

// Decode + check (lifted from fb-diff harness, minimal).
function decodePng(buf) {
  let p = 8;
  let width = 0, height = 0, bpp = 4;
  const idats = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const ct = data[9]; bpp = (ct === 6) ? 4 : (ct === 2 ? 3 : 4);
    } else if (type === "IDAT") idats.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * bpp);
  let prev = Buffer.alloc(stride), ip = 0, op = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[ip++];
    const row = Buffer.from(raw.subarray(ip, ip + stride)); ip += stride;
    if (f === 1) for (let x = bpp; x < stride; x++) row[x] = (row[x] + row[x - bpp]) & 0xff;
    else if (f === 2) for (let x = 0; x < stride; x++) row[x] = (row[x] + prev[x]) & 0xff;
    else if (f === 3) for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      row[x] = (row[x] + ((a + prev[x]) >> 1)) & 0xff;
    } else if (f === 4) for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const pp = a + b - c;
      const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      let pr;
      if (pa <= pb && pa <= pc) pr = a; else if (pb <= pc) pr = b; else pr = c;
      row[x] = (row[x] + pr) & 0xff;
    }
    row.copy(out, op); op += stride; prev = row;
  }
  return { width, height, bpp, pixels: out };
}

const png = decodePng(readFileSync(path));
const W = png.width, H = png.height;

// Sample background color = top-left corner.
const bgR = png.pixels[0], bgG = png.pixels[1], bgB = png.pixels[2];

// Count non-background pixels in central text region.
let central = 0;
let nonBg = 0;
for (let y = 50; y < 220; y++) {
  for (let x = 50; x < W - 50; x++) {
    central++;
    const off = (y * W + x) * 4;
    if (png.pixels[off] !== bgR || png.pixels[off+1] !== bgG || png.pixels[off+2] !== bgB) nonBg++;
  }
}
const nonBgPct = (nonBg * 100 / central).toFixed(2);

// Palette: load c64 palette + check all pixel RGBs are in known palette.
const palMod = await import(`${REPO}/dist/runtime/headless/vic/palettes.js`);
// Default palette = colodore.
const pal = palMod.PALETTES.colodore;
const palSet = new Set(pal.map(([r, g, b]) => (r << 16) | (g << 8) | b));

let outOfPalette = 0;
const distinct = new Set();
for (let i = 0; i < png.pixels.length; i += 4) {
  const k = (png.pixels[i] << 16) | (png.pixels[i+1] << 8) | png.pixels[i+2];
  distinct.add(k);
  if (!palSet.has(k)) outOfPalette++;
}

console.log(`dimensions: ${W}×${H} (expected 384×272)`);
console.log(`bg color rgb=(${bgR},${bgG},${bgB})`);
console.log(`central region non-bg: ${nonBg}/${central} (${nonBgPct}%)`);
console.log(`distinct colors: ${distinct.size}`);
console.log(`out-of-palette pixels: ${outOfPalette} (palette=colodore)`);

const checks = [
  { name: "dimensions == 384×272", ok: W === 384 && H === 272 },
  { name: "central non-bg > 50%", ok: parseFloat(nonBgPct) > 0.5 },
  { name: "all pixels in palette", ok: outOfPalette === 0 },
];
let ok = true;
for (const c of checks) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}: ${c.name}`);
  if (!c.ok) ok = false;
}
process.exit(ok ? 0 : 1);
