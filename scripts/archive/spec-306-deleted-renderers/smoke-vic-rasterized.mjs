#!/usr/bin/env node
// Spec 280c smoke — VICE-faithful per-line VIC renderer.
//
// Synthetic-trace cases. Builds tiny `vic` + `bus` stubs, populates the
// `frameLineLogs` (or skips it for static-state cases), then runs
// renderFrameRasterized and probes the framebuffer at known pixels.

import { resolve } from "node:path";
const repoRoot = resolve(import.meta.dirname, "..");
const rast = await import(`${repoRoot}/dist/runtime/headless/peripherals/vic-renderer-rasterized.js`);
const rend = await import(`${repoRoot}/dist/runtime/headless/peripherals/vic-renderer.js`);

const { renderFrameRasterized, resetFrameCarry, VicFramebuffer } = rast;
const { VIC_PALETTE, VISIBLE_X, VISIBLE_Y } = rend;

const results = [];
function test(name, ok, detail = "") {
  results.push({ name, pass: ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
}

console.log("=== Spec 280c smoke — vice-rasterized renderer ===\n");

// ---------- Test bus + vic builders ----------

function makeBus() {
  return {
    ram: new Uint8Array(0x10000),
    io: new Uint8Array(0x1000),
    charRom: new Uint8Array(0x1000),
  };
}

function makeVic(opts = {}) {
  const regs = new Uint8Array(0x50);
  regs[0x11] = opts.d011 ?? 0x1b; // DEN=1, RSEL=1, ysmooth=3 (default)
  regs[0x16] = opts.d016 ?? 0x08; // CSEL=1
  regs[0x18] = opts.d018 ?? 0x14; // screen=$0400, chargen=$1000
  regs[0x20] = opts.d020 ?? 14;   // light blue border
  regs[0x21] = opts.d021 ?? 6;    // blue bg
  regs[0x22] = opts.d022 ?? 1;    // mc1=white
  regs[0x23] = opts.d023 ?? 2;    // mc2=red
  regs[0x15] = opts.d015 ?? 0;    // sprite enable
  if (opts.regsExtra) for (const [r, v] of Object.entries(opts.regsExtra)) regs[+r] = v;
  return {
    regs,
    screen_height: 312,
    frameLineLogs: opts.frameLineLogs ?? [],
  };
}

function rgbAt(fb, x, y) {
  const off = (y * fb.width + x) * 4;
  return [fb.pixels[off], fb.pixels[off + 1], fb.pixels[off + 2]];
}

function colorIdx(fb, x, y) {
  const [r, g, b] = rgbAt(fb, x, y);
  for (let i = 0; i < 16; i++) {
    const [pr, pg, pb] = VIC_PALETTE[i];
    if (pr === r && pg === g && pb === b) return i;
  }
  return -1;
}

// Fill a fake char ROM with a recognizable pattern: char 0x40 (= '@')
// has byte 0xff for row 0 (full bright), 0x00 elsewhere. Char 0x20 is
// blank (all 0x00).
function setupCharRom(bus) {
  // Char 0x20 (= space): all zeros (already).
  // Char 0x40: row 0 = 0xff, rest 0x00.
  bus.charRom[0x40 * 8 + 0] = 0xff;
}

// ---------- Test 1: standard text mode renders 40 cols ----------
{
  resetFrameCarry();
  const bus = makeBus();
  setupCharRom(bus);
  // Bank 0: chargen offset $1000 → char ROM (banks 0/2). Screen RAM at $0400.
  // Fill screen RAM with char 0x40 at row 0.
  for (let col = 0; col < 40; col++) bus.ram[0x0400 + col] = 0x40;
  // Color RAM (D800) — white.
  for (let i = 0; i < 0x400; i++) bus.io[0x800 + i] = 1;
  const vic = makeVic();
  const fb = new VicFramebuffer(true);
  renderFrameRasterized(fb, { vic, bus, initialCia2PaByte: 3, resetCarry: true });

  // Row 0, col 0, scanline 51, pixel x = VISIBLE_X = 24, char-row 0,
  // cy=0, byte=0xff → all 8 bits set → fg=white at pixel (24..31, 51).
  const c1 = colorIdx(fb, VISIBLE_X + 0, VISIBLE_Y + 0);
  const c2 = colorIdx(fb, VISIBLE_X + 7, VISIBLE_Y + 0);
  test("std text: row 0 col 0 fg pixels = white(1)", c1 === 1 && c2 === 1, `got ${c1}/${c2}`);
  // cy=1: byte 0x00 → bg.
  const cBg = colorIdx(fb, VISIBLE_X + 0, VISIBLE_Y + 1);
  test("std text: row 0 col 0 cy=1 = bg(6)", cBg === 6, `got ${cBg}`);
  // Border at far-left pixel 0.
  const cBorder = colorIdx(fb, 0, VISIBLE_Y);
  test("std text: border = 14", cBorder === 14, `got ${cBorder}`);
}

// ---------- Test 2: standard bitmap mode ----------
{
  resetFrameCarry();
  const bus = makeBus();
  // Bitmap mode: $D011 BMM=1. Bitmap base $2000, screen $0400.
  // Bank 0: $2000 = ram[0x2000..]. $0400 = screen RAM.
  // Each cell screen byte: high nibble fg, low nibble bg.
  for (let i = 0; i < 1000; i++) bus.ram[0x0400 + i] = 0x71; // fg=7 yellow, bg=1 white
  // Set bitmap row 0 cell 0 to 0xff (= all 8 fg pixels).
  bus.ram[0x2000 + 0] = 0xff;
  // d018 for bitmap base $2000 → bit 3 = 1: regs[0x18] = (screen<<4) | (bitmap=$2000? bit3) = 0x14|0x08=0x1c.
  // Actually: bitmap_base = bit3 * 0x2000. bit3=1 → 0x2000. screen high nibble=0x1 → $0400. So 0x18.
  const vic = makeVic({ d011: 0x1b | 0x20, d018: 0x18, d020: 14, d021: 6 });
  const fb = new VicFramebuffer(true);
  renderFrameRasterized(fb, { vic, bus, initialCia2PaByte: 3, resetCarry: true });

  const cFg = colorIdx(fb, VISIBLE_X + 0, VISIBLE_Y + 0);
  test("std bitmap: row 0 col 0 cy=0 = fg(7 yellow)", cFg === 7, `got ${cFg}`);
  // cy=1: byte 0 → bg.
  const cBg = colorIdx(fb, VISIBLE_X + 0, VISIBLE_Y + 1);
  test("std bitmap: row 0 col 0 cy=1 = bg(1 white)", cBg === 1, `got ${cBg}`);
}

// ---------- Test 3: mid-line bg color change ----------
{
  resetFrameCarry();
  const bus = makeBus();
  setupCharRom(bus);
  for (let col = 0; col < 40; col++) bus.ram[0x0400 + col] = 0x20; // space (blank)
  for (let i = 0; i < 0x400; i++) bus.io[0x800 + i] = 1;
  const vic = makeVic({ d021: 6 });
  // Inject mid-line bg change at cycle 30 of line 51 (= first visible).
  vic.frameLineLogs.push({
    rasterLine: 51,
    writes: [{ cycleInLine: 30, reg: 0x21, value: 8 }], // change to orange at cycle 30
  });
  const fb = new VicFramebuffer(true);
  renderFrameRasterized(fb, { vic, bus, initialCia2PaByte: 3, resetCarry: true });

  // pixel at cycle 30 = (30-17)*8 + 32 = 136. So pixels < 136 = bg=6
  // (blue), pixels ≥ 136 should be 8 (orange). Use cy=1 row (= blank
  // char's bg) so we measure bg directly.
  // Test on line 51 itself — the line where the mid-line change fires.
  // Use cy=1 (= blank-char bg pixel) to read bg color directly.
  // pixel x = 50 (in active region) = scanline pixel 74; pivot at 136.
  const cBefore = colorIdx(fb, VISIBLE_X + 50, VISIBLE_Y + 0);
  const cAfter = colorIdx(fb, VISIBLE_X + 200, VISIBLE_Y + 0);
  test("mid-line bg split: before pivot = blue(6)", cBefore === 6, `got ${cBefore}`);
  test("mid-line bg split: after pivot = orange(8)", cAfter === 8, `got ${cAfter}`);
}

// ---------- Test 4: d018 next_line behavior ----------
{
  resetFrameCarry();
  const bus = makeBus();
  setupCharRom(bus);
  // Two screen RAM regions: $0400 has char 0x40 everywhere; $0800 has
  // char 0x20 (blank).
  for (let i = 0; i < 1000; i++) {
    bus.ram[0x0400 + i] = 0x40;
    bus.ram[0x0800 + i] = 0x20;
  }
  for (let i = 0; i < 0x400; i++) bus.io[0x800 + i] = 1;
  const vic = makeVic({ d018: 0x14 }); // screen=$0400
  // Mid-line d018 write at line 51 → next-line lane → next line uses new screen base.
  vic.frameLineLogs.push({
    rasterLine: 51,
    writes: [{ cycleInLine: 30, reg: 0x18, value: 0x24 }], // screen=$0800
  });
  const fb = new VicFramebuffer(true);
  renderFrameRasterized(fb, { vic, bus, initialCia2PaByte: 3, resetCarry: true });

  // Line 51: still uses $0400 (char 0x40 → bright row at cy=0). Test
  // pixel (24,51) = white.
  const c1 = colorIdx(fb, VISIBLE_X, VISIBLE_Y);
  // Line 52: next-line lane applied → screen=$0800 (char 0x20 = blank).
  // Char 0x20 cy=1 = bg (0x00 byte) → blue bg.
  // Char-row at line 52 is row 0 cy=1 → also from char 0x20 = blank.
  const c2 = colorIdx(fb, VISIBLE_X, VISIBLE_Y + 1);
  test("d018 next_line: line 51 still uses $0400 (white)", c1 === 1, `got ${c1}`);
  test("d018 next_line: line 52 uses $0800 (blank → bg blue)", c2 === 6, `got ${c2}`);
}

// ---------- Test 5: DEN off → border-only ----------
{
  resetFrameCarry();
  const bus = makeBus();
  setupCharRom(bus);
  for (let col = 0; col < 40; col++) bus.ram[0x0400 + col] = 0x40;
  for (let i = 0; i < 0x400; i++) bus.io[0x800 + i] = 1;
  const vic = makeVic({ d011: 0x0b }); // DEN=0
  const fb = new VicFramebuffer(true);
  renderFrameRasterized(fb, { vic, bus, initialCia2PaByte: 3, resetCarry: true });

  // Inside the would-be display area, with DEN off we still get border
  // color drawn full-width at scanline init, then segment-fill draws bg
  // (no DEN early-return → bg fill). Renderer first paints border, then
  // emitGfxRun fills bg color across segment but skips mode dispatch.
  // So pixels in display region = bg color (6 blue). Border bands = 14.
  const cBorder = colorIdx(fb, 0, VISIBLE_Y);
  const cActive = colorIdx(fb, VISIBLE_X, VISIBLE_Y);
  test("DEN off: border color visible", cBorder === 14, `got ${cBorder}`);
  test("DEN off: active region = bg (no chars)", cActive === 6, `got ${cActive}`);
}

// ---------- Test 6: multicolor bitmap ----------
{
  resetFrameCarry();
  const bus = makeBus();
  // MC bitmap mode: BMM=1, MCM=1.
  // bitmap_base = $2000 (d018 bit 3 = 1), screen = $0400 (high nibble 1).
  for (let i = 0; i < 1000; i++) bus.ram[0x0400 + i] = 0x73; // c01=7 yellow, c10=3 cyan
  for (let i = 0; i < 0x400; i++) bus.io[0x800 + i] = 4; // c11 = purple
  // Bitmap row 0 cell 0 byte = 0b01101100 (= 4 pairs: 01 10 11 00)
  bus.ram[0x2000 + 0] = 0b01101100;
  const vic = makeVic({ d011: 0x1b | 0x20, d016: 0x08 | 0x10, d018: 0x18, d021: 6 });
  const fb = new VicFramebuffer(true);
  renderFrameRasterized(fb, { vic, bus, initialCia2PaByte: 3, resetCarry: true });

  // Pair 0 (xIn 0..1) = 01 → c01=7 yellow.
  const p0 = colorIdx(fb, VISIBLE_X + 0, VISIBLE_Y);
  // Pair 1 (xIn 2..3) = 10 → c10=3 cyan.
  const p1 = colorIdx(fb, VISIBLE_X + 2, VISIBLE_Y);
  // Pair 2 (xIn 4..5) = 11 → c11=4 purple.
  const p2 = colorIdx(fb, VISIBLE_X + 4, VISIBLE_Y);
  // Pair 3 (xIn 6..7) = 00 → bg=6 blue.
  const p3 = colorIdx(fb, VISIBLE_X + 6, VISIBLE_Y);
  test("mc bitmap: pair 01 = c01 yellow(7)", p0 === 7, `got ${p0}`);
  test("mc bitmap: pair 10 = c10 cyan(3)", p1 === 3, `got ${p1}`);
  test("mc bitmap: pair 11 = c11 purple(4)", p2 === 4, `got ${p2}`);
  test("mc bitmap: pair 00 = bg blue(6)", p3 === 6, `got ${p3}`);
}

// ---------- Test 7: sprite at known position ----------
{
  resetFrameCarry();
  const bus = makeBus();
  // Standard text mode, blank screen.
  setupCharRom(bus);
  for (let col = 0; col < 1000; col++) bus.ram[0x0400 + col] = 0x20; // blank
  for (let i = 0; i < 0x400; i++) bus.io[0x800 + i] = 1;
  // Sprite 0 enabled at x=24+50=74 (pixel screen-relative 50), y=50+10=60.
  // Sprite data pointer @ screen+0x3f8 = $07f8. ptr=8 → data @ 8*64=$0200.
  // Fill sprite data with all 0xff (= solid).
  bus.ram[0x07f8] = 8;
  for (let i = 0; i < 63; i++) bus.ram[0x0200 + i] = 0xff;
  const vic = makeVic({ d015: 1 });
  vic.regs[0x00] = 74; // x lo
  vic.regs[0x01] = 60; // y
  vic.regs[0x10] = 0;  // x msb
  vic.regs[0x27] = 9;  // sprite 0 color = brown
  const fb = new VicFramebuffer(true);
  renderFrameRasterized(fb, { vic, bus, initialCia2PaByte: 3, resetCarry: true });

  // Sprite at screen (50, 10) → fb pixel (VISIBLE_X+50, line 60).
  const sCol = colorIdx(fb, VISIBLE_X + 50, 60);
  test("sprite 0 visible at expected pixel = brown(9)", sCol === 9, `got ${sCol}`);
}

// ---------- Summary ----------
const passed = results.filter(r => r.pass).length;
console.log(`\nSpec 280c rasterized renderer: ${passed}/${results.length} pass, ${results.length - passed} fail`);
process.exit(passed === results.length ? 0 : 1);
