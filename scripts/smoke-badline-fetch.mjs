#!/usr/bin/env node
// Spec 280e smoke — badline DMA fetch logic (matrix + chargen + bitmap).
//
// 5+ cases:
//   1. isBadline() correct for various (rasterY, ysmooth, allowBadLines) combos
//   2. fetchMatrix reads expected bytes from synthetic RAM at screen base
//   3. fetchChargen handles all 256 chars (spot-checks a few)
//   4. fetchBitmap reads correct bytes for given char-row + sub-row
//   5. Bank 0/2 chargen quirk: $1000-$1FFF reads char ROM not RAM

import { resolve } from "node:path";
const repoRoot = resolve(import.meta.dirname, "..");
const m = await import(`${repoRoot}/dist/runtime/headless/vic/badline-fetch.js`);

const {
  isBadline,
  fetchMatrix,
  fetchChargen,
  fetchBitmap,
  fetchBadlineMatrix,
} = m;

const results = [];
function test(name, ok, detail = "") {
  results.push({ name, pass: ok });
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}${detail ? ": " + detail : ""}`);
}

console.log("=== Spec 280e smoke — badline DMA fetch ===\n");

// ---------------------------------------------------------------------------
// Case 1 — isBadline() detection (VICE vicii-badline.c 145-148).
// ---------------------------------------------------------------------------
console.log("--- Case 1: isBadline() ---");

// PAL: first_dma_line=0x30 (48), last_dma_line=0xf7 (247)
const FIRST = 0x30;
const LAST = 0xf7;

// Line 0x30, ysmooth=0 → bad (0x30 & 7 == 0, ysmooth 0)
test("isBadline(0x30, 0, true, 0x30, 0xf7)",
  isBadline(0x30, 0, true, FIRST, LAST) === true,
  `got ${isBadline(0x30, 0, true, FIRST, LAST)}`);

// Line 0x31, ysmooth=1 → bad (0x31 & 7 == 1, ysmooth 1)
test("isBadline(0x31, 1, true, 0x30, 0xf7)",
  isBadline(0x31, 1, true, FIRST, LAST) === true);

// Line 0x30, ysmooth=1 → NOT bad (0x30 & 7 == 0, ysmooth 1 → mismatch)
test("isBadline(0x30, 1, true, 0x30, 0xf7) = false (ysmooth mismatch)",
  isBadline(0x30, 1, true, FIRST, LAST) === false);

// allow_bad_lines false → never bad
test("isBadline with allowBadLines=false → false",
  isBadline(0x30, 0, false, FIRST, LAST) === false);

// Line 0 (above first_dma_line) → not bad
test("isBadline(0, 0, true, 0x30, 0xf7) = false (above range)",
  isBadline(0, 0, true, FIRST, LAST) === false);

// Line 0xf8 (one past last_dma_line) → not bad
test("isBadline(0xf8, 0, true, 0x30, 0xf7) = false (below range)",
  isBadline(0xf8, 0, true, FIRST, LAST) === false);

// Line 0xf7, ysmooth=7 → bad (0xf7 & 7 == 7)
test("isBadline(0xf7, 7, true, 0x30, 0xf7) = true (last DMA line)",
  isBadline(0xf7, 7, true, FIRST, LAST) === true);

// ---------------------------------------------------------------------------
// Case 2 — fetchMatrix reads expected bytes from synthetic RAM.
// ---------------------------------------------------------------------------
console.log("\n--- Case 2: fetchMatrix ---");

// Build synthetic bus: 64KB RAM, 4KB charRom, 1KB colorRam.
const ram = new Uint8Array(65536);
const charRom = new Uint8Array(4096);
const colorRam = new Uint8Array(1024);

// Fill screen RAM at bank=0, screenBase=0x0400 (D018=0x14 → bits 7..4 = 1).
// For simplicity: char code at position i = i (for i in 0..39).
const screenBase = 0x0400;
for (let i = 0; i < 40; i++) {
  ram[screenBase + i] = i; // char code = position index
}
// Color RAM: color[i] = (i & 0x0f)
for (let i = 0; i < 40; i++) {
  colorRam[i] = i & 0x0f;
}

const bus = { ram, charRom, colorRam };
// vicBankBase=0 (bank 0), screenBaseOffset=0x0400, charRowStart=0
const { vbuf, cbuf } = fetchMatrix(bus, 0x0000, 0x0400, 0);

test("fetchMatrix vbuf[0] = 0 (char code 0 at first position)",
  vbuf[0] === 0, `got ${vbuf[0]}`);
test("fetchMatrix vbuf[39] = 39 (char code 39 at last position)",
  vbuf[39] === 39, `got ${vbuf[39]}`);
test("fetchMatrix cbuf[0] = 0 (color nibble at pos 0)",
  cbuf[0] === 0, `got ${cbuf[0]}`);
test("fetchMatrix cbuf[7] = 7 (color nibble at pos 7)",
  cbuf[7] === 7, `got ${cbuf[7]}`);
test("fetchMatrix cbuf[15] = 15 (color nibble at pos 15, max nibble)",
  cbuf[15] === 15, `got ${cbuf[15]}`);
test("fetchMatrix vbuf length = 40",
  vbuf.length === 40);
test("fetchMatrix cbuf length = 40",
  cbuf.length === 40);

// Test 10-bit counter wrap: charRowStart = 0x3ff → wraps to 0 for subsequent.
// charRowStart=0x3ff means idx = (0x3ff + 0) & 0x3ff = 0x3ff = 1023
// and idx = (0x3ff + 1) & 0x3ff = 0 → wraps.
// Place known values at those positions.
const bus2Ram = new Uint8Array(65536);
bus2Ram[0x0400 + 0x3ff] = 0xAA; // position 1023 in screen RAM
bus2Ram[0x0400 + 0x000] = 0xBB; // position 0 (wrapped)
const bus2ColorRam = new Uint8Array(1024);
bus2ColorRam[0x3ff] = 0x0A;
bus2ColorRam[0x000] = 0x0B;
const bus2 = { ram: bus2Ram, charRom: new Uint8Array(4096), colorRam: bus2ColorRam };
const res2 = fetchMatrix(bus2, 0x0000, 0x0400, 0x3ff);
test("fetchMatrix 10-bit wrap: vbuf[0] = 0xAA (at pos 0x3ff)",
  res2.vbuf[0] === 0xAA, `got ${res2.vbuf[0]}`);
test("fetchMatrix 10-bit wrap: vbuf[1] = 0xBB (wrapped pos 0)",
  res2.vbuf[1] === 0xBB, `got ${res2.vbuf[1]}`);

// ---------------------------------------------------------------------------
// Case 3 — fetchChargen handles all 256 chars (spot-checks).
// ---------------------------------------------------------------------------
console.log("\n--- Case 3: fetchChargen ---");

// Build charRom: charRom[charCode * 8 + subRow] = charCode ^ subRow
const charRomData = new Uint8Array(4096);
for (let c = 0; c < 256; c++) {
  for (let sub = 0; sub < 8; sub++) {
    charRomData[c * 8 + sub] = (c ^ sub) & 0xff;
  }
}
// In bank 0, chargen at $1000: vicBankBase=0, chargenBaseOffset=0x1000
// vicBankRead will route to charRom[offset - 0x1000] = charRom[charCode*8+sub]
// So chargenBaseOffset - $1000 = 0 → chargenBaseOffset = 0x1000 ✓

// Build vbuf with ascending char codes 0..39
const vbufTest = new Uint8Array(40);
for (let i = 0; i < 40; i++) vbufTest[i] = i;

const charBus = {
  ram: new Uint8Array(65536),
  charRom: charRomData,
  colorRam: new Uint8Array(1024),
};
const bitmapBuf0 = fetchChargen(charBus, 0x0000, 0x1000, vbufTest, 0);
const bitmapBuf3 = fetchChargen(charBus, 0x0000, 0x1000, vbufTest, 3);
const bitmapBuf7 = fetchChargen(charBus, 0x0000, 0x1000, vbufTest, 7);

// char 0, sub 0 → charRom[0] = 0 ^ 0 = 0
test("fetchChargen char0 sub0 = 0",
  bitmapBuf0[0] === 0, `got ${bitmapBuf0[0]}`);
// char 5, sub 0 → charRom[5*8+0] = 5 ^ 0 = 5
test("fetchChargen char5 sub0 = 5",
  bitmapBuf0[5] === 5, `got ${bitmapBuf0[5]}`);
// char 5, sub 3 → charRom[5*8+3] = 5 ^ 3 = 6
test("fetchChargen char5 sub3 = 6 (5 XOR 3)",
  bitmapBuf3[5] === 6, `got ${bitmapBuf3[5]}`);
// char 0, sub 7 → 0 ^ 7 = 7
test("fetchChargen char0 sub7 = 7",
  bitmapBuf7[0] === 7, `got ${bitmapBuf7[0]}`);
// char 39, sub 0 → 39 ^ 0 = 39
test("fetchChargen char39 sub0 = 39",
  bitmapBuf0[39] === 39, `got ${bitmapBuf0[39]}`);
test("fetchChargen returns Uint8Array(40)",
  bitmapBuf0.length === 40);

// ---------------------------------------------------------------------------
// Case 4 — fetchBitmap reads correct bytes for char-row + sub-row.
// ---------------------------------------------------------------------------
console.log("\n--- Case 4: fetchBitmap ---");

// Bitmap: address = bitmapBase + (charRowStart + i) * 8 + subRow
// Fill bitmap RAM with unique value at each cell:
//   value = ((charRowStart + i) * 8 + subRow) & 0xff
const bitmapRam = new Uint8Array(65536);
const bitmapBase = 0x0000; // bank 0 bitmap at $0000 (D018 bit3=0)
// charRowStart = 0 (= first row of screen)
for (let i = 0; i < 40; i++) {
  for (let sub = 0; sub < 8; sub++) {
    // bank 0, base 0, so absolute addr = (i * 8 + sub)
    bitmapRam[i * 8 + sub] = ((i * 8 + sub) & 0xff);
  }
}
const bitmapBus = { ram: bitmapRam, charRom: new Uint8Array(4096), colorRam: new Uint8Array(1024) };
// charRowStart=0, subRow=0
const bm0 = fetchBitmap(bitmapBus, 0x0000, bitmapBase, 0, 0);
// charRowStart=0, subRow=3
const bm3 = fetchBitmap(bitmapBus, 0x0000, bitmapBase, 0, 3);

// position 0, sub 0 → bitmapRam[0*8+0] = 0
test("fetchBitmap col0 sub0 = 0",
  bm0[0] === 0, `got ${bm0[0]}`);
// position 0, sub 3 → bitmapRam[0*8+3] = 3
test("fetchBitmap col0 sub3 = 3",
  bm3[0] === 3, `got ${bm3[0]}`);
// position 5, sub 0 → bitmapRam[5*8+0] = 40
test("fetchBitmap col5 sub0 = 40",
  bm0[5] === 40, `got ${bm0[5]}`);
// position 5, sub 3 → bitmapRam[5*8+3] = 43
test("fetchBitmap col5 sub3 = 43",
  bm3[5] === 43, `got ${bm3[5]}`);
// position 39 (last), sub 0 → 39*8+0 = 312, 312 & 0xff = 56
test("fetchBitmap col39 sub0 = 56 (312 & 0xff)",
  bm0[39] === (39 * 8) % 256, `got ${bm0[39]}, expected ${(39 * 8) % 256}`);
test("fetchBitmap returns Uint8Array(40)",
  bm0.length === 40);

// ---------------------------------------------------------------------------
// Case 5 — Bank 0/2 chargen quirk: $1000-$1FFF reads char ROM not RAM.
// ---------------------------------------------------------------------------
console.log("\n--- Case 5: Bank 0/2 chargen ROM quirk ---");

// Build a bus where RAM has 0xAA in the chargen area, but charRom has 0x55.
const quirkRam = new Uint8Array(65536).fill(0xAA);
const quirkCharRom = new Uint8Array(4096).fill(0x55);
const quirkColorRam = new Uint8Array(1024);
const quirkBus = { ram: quirkRam, charRom: quirkCharRom, colorRam: quirkColorRam };

// Bank 0: chargenBaseOffset=0x1000. Read of char 0 sub 0 → bankRelAddr=0x1000
// → should hit char ROM → 0x55 (NOT RAM 0xAA).
const vbufZero = new Uint8Array(40); // all char code 0
const resultBank0 = fetchChargen(quirkBus, 0x0000, 0x1000, vbufZero, 0);
test("Bank 0 chargen at $1000: reads char ROM (0x55), not RAM (0xAA)",
  resultBank0[0] === 0x55, `got ${resultBank0[0]}`);

// Bank 2 (base=0x8000): same quirk.
// With vicBankBase=0x8000 and chargenBaseOffset=0x1000, bankRelAddr=0x1000
// → chargen ROM overlay active → read char ROM.
const resultBank2 = fetchChargen(quirkBus, 0x8000, 0x1000, vbufZero, 0);
test("Bank 2 chargen at $1000: reads char ROM (0x55), not RAM (0xAA)",
  resultBank2[0] === 0x55, `got ${resultBank2[0]}`);

// Bank 1 (base=0x4000): NO quirk — $1000 reads RAM.
const resultBank1 = fetchChargen(quirkBus, 0x4000, 0x1000, vbufZero, 0);
test("Bank 1 chargen at $1000: reads RAM (0xAA), NOT char ROM",
  resultBank1[0] === 0xAA, `got ${resultBank1[0]}`);

// Bank 3 (base=0xC000): NO quirk.
const resultBank3 = fetchChargen(quirkBus, 0xC000, 0x1000, vbufZero, 0);
test("Bank 3 chargen at $1000: reads RAM (0xAA), NOT char ROM",
  resultBank3[0] === 0xAA, `got ${resultBank3[0]}`);

// Bitmap in bank 0 at $2000 (address $2000 — NOT in $1000-$1FFF): reads RAM.
// fetchBitmap at bitmapBase=0x2000 → bankRelAddr=0x2000 → RAM.
const quirkBitmapBus = {
  ram: new Uint8Array(65536).fill(0xBB),
  charRom: quirkCharRom,
  colorRam: quirkColorRam,
};
const bitmapResult = fetchBitmap(quirkBitmapBus, 0x0000, 0x2000, 0, 0);
test("Bank 0 bitmap at $2000: reads RAM (0xBB), not char ROM",
  bitmapResult[0] === 0xBB, `got ${bitmapResult[0]}`);

// ---------------------------------------------------------------------------
// Case 6 — fetchBadlineMatrix composite: vbuf + cbuf + bitmapBuf populated.
// ---------------------------------------------------------------------------
console.log("\n--- Case 6: fetchBadlineMatrix composite ---");

// Re-use the charBus setup from Case 3.
// charRomData: charCode*8+sub → (charCode ^ sub)
// screenRam at 0x0400: position i → char code i (for i in 0..39)
const compBus = {
  ram: (() => {
    const r = new Uint8Array(65536);
    for (let i = 0; i < 40; i++) r[0x0400 + i] = i;
    return r;
  })(),
  charRom: charRomData,
  colorRam: (() => {
    const c = new Uint8Array(1024);
    for (let i = 0; i < 40; i++) c[i] = (i * 3) & 0x0f;
    return c;
  })(),
};
// bank 0, screenBase=0x0400, chargenBase=0x1000, charRowStart=0, subRow=2
const compResult = fetchBadlineMatrix(compBus, 0x0000, 0x0400, 0x1000, 0, 2);
test("fetchBadlineMatrix: vbuf[3] = 3",
  compResult.vbuf[3] === 3, `got ${compResult.vbuf[3]}`);
// cbuf[3] = (3*3) & 0x0f = 9
test("fetchBadlineMatrix: cbuf[3] = 9",
  compResult.cbuf[3] === 9, `got ${compResult.cbuf[3]}`);
// bitmapBuf[3] = char3 sub2 = 3 XOR 2 = 1
test("fetchBadlineMatrix: bitmapBuf[3] = 1 (char 3 sub-row 2)",
  compResult.bitmapBuf[3] === 1, `got ${compResult.bitmapBuf[3]}`);
test("fetchBadlineMatrix: all three buffers length 40",
  compResult.vbuf.length === 40 && compResult.cbuf.length === 40 && compResult.bitmapBuf.length === 40);

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log();
const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log(`Spec 280e badline-fetch: ${pass}/${results.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
