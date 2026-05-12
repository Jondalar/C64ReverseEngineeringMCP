#!/usr/bin/env node
// Spec 297h smoke — sprite cycle multiplexer per-engine semantics.

import {
  newSpriteEngine, loadSpriteRegs, onLineStart,
  loadSpriteDmaByte, emitSpritePixel, spriteMaskAt,
} from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/vic/sprite-cycle.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-297h-sprite-cycle");

// ---------------------------------------------------------------------------
// Hi-res sprite, no expand, opaque only when bit set
// ---------------------------------------------------------------------------
{
  const e = newSpriteEngine(0);
  loadSpriteRegs(e, 100, 0, 50, true, false, false, false, false, 0x05);
  loadSpriteDmaByte(e, 0, 0xff);  // first byte all bits set
  loadSpriteDmaByte(e, 1, 0x00);
  loadSpriteDmaByte(e, 2, 0x00);
  // Trigger Y match → onLineStart loads shifter
  onLineStart(e, 50);
  // First 8 pixels at x=100..107 → bit=1 → color=5
  let allFg = true;
  for (let px = 100; px < 108; px++) {
    const c = emitSpritePixel(e, px, 0, 0);
    if (c !== 0x05) { allFg = false; break; }
  }
  ok("hi-res sprite: first 8 pixels = sprite color (5)", allFg);
  // Pixels 108..127 → byte 1 ($00) + byte 2 ($00) → all transparent
  let allBgNext = true;
  for (let px = 108; px < 124; px++) {
    const c = emitSpritePixel(e, px, 0, 0);
    if (c !== null) { allBgNext = false; break; }
  }
  ok("hi-res sprite: bytes 1+2 = transparent", allBgNext);
  // Past x+24 → off
  ok("hi-res sprite: pixel beyond x+24 = null", emitSpritePixel(e, 124, 0, 0) === null);
}

// ---------------------------------------------------------------------------
// X-expand: each bit takes 2 pixels
// ---------------------------------------------------------------------------
{
  const e = newSpriteEngine(0);
  loadSpriteRegs(e, 100, 0, 50, true, false, false, false, true, 0x05);
  loadSpriteDmaByte(e, 0, 0xff);
  loadSpriteDmaByte(e, 1, 0);
  loadSpriteDmaByte(e, 2, 0);
  onLineStart(e, 50);
  // First 16 pixels x=100..115 → 8 bits × 2 = sprite color
  let okExpand = true;
  for (let px = 100; px < 116; px++) {
    const c = emitSpritePixel(e, px, 0, 0);
    if (c !== 0x05) { okExpand = false; break; }
  }
  ok("x-expand: first 16 pixels = sprite color (8 bits × 2)", okExpand);
}

// ---------------------------------------------------------------------------
// MC sprite: 2-bit pairs
// ---------------------------------------------------------------------------
{
  const e = newSpriteEngine(0);
  loadSpriteRegs(e, 100, 0, 50, true, false, false, true, false, 0x07);
  // Data byte 0 = 0b01101100 = pairs 01, 10, 11, 00
  loadSpriteDmaByte(e, 0, 0b01101100);
  loadSpriteDmaByte(e, 1, 0);
  loadSpriteDmaByte(e, 2, 0);
  onLineStart(e, 50);
  // First 2 pixels: pair 01 → d025
  ok("mc pair 01 px 100: d025", emitSpritePixel(e, 100, 0x02, 0x06) === 0x02);
  ok("mc pair 01 px 101: d025 (latched)", emitSpritePixel(e, 101, 0x02, 0x06) === 0x02);
  // Next 2 pixels: pair 10 → sprite color
  ok("mc pair 10 px 102: sprite color", emitSpritePixel(e, 102, 0x02, 0x06) === 0x07);
  ok("mc pair 10 px 103: sprite color", emitSpritePixel(e, 103, 0x02, 0x06) === 0x07);
  // Next 2 pixels: pair 11 → d026
  ok("mc pair 11 px 104: d026", emitSpritePixel(e, 104, 0x02, 0x06) === 0x06);
  ok("mc pair 11 px 105: d026", emitSpritePixel(e, 105, 0x02, 0x06) === 0x06);
  // Next 2 pixels: pair 00 → transparent
  ok("mc pair 00 px 106: transparent", emitSpritePixel(e, 106, 0x02, 0x06) === null);
  ok("mc pair 00 px 107: transparent", emitSpritePixel(e, 107, 0x02, 0x06) === null);
}

// ---------------------------------------------------------------------------
// Multi-sprite mask via spriteMaskAt
// ---------------------------------------------------------------------------
{
  const engines = [];
  for (let i = 0; i < 8; i++) engines.push(newSpriteEngine(i));
  // Sprite 0 at x=100, hi-res, $ff data → opaque on px 100..107
  loadSpriteRegs(engines[0], 100, 0, 50, true, false, false, false, false, 0x01);
  loadSpriteDmaByte(engines[0], 0, 0xff);
  // Sprite 1 at x=104, hi-res, $ff data → opaque on px 104..111
  loadSpriteRegs(engines[1], 104, 0, 50, true, false, false, false, false, 0x02);
  loadSpriteDmaByte(engines[1], 0, 0xff);
  for (const e of engines) onLineStart(e, 50);
  // Pixel 105: both sprites opaque
  const r = spriteMaskAt(engines, 105, 0, 0);
  ok("multi: mask at px 105 = bits 0+1", r.mask === 0b11, `got ${r.mask.toString(2)}`);
  ok("multi: pixelByIndex[0] = color 1", r.pixelByIndex[0] === 0x01);
  ok("multi: pixelByIndex[1] = color 2", r.pixelByIndex[1] === 0x02);
}

// ---------------------------------------------------------------------------
// Y-trigger: onLineStart only triggers when y matches AND enabled
// ---------------------------------------------------------------------------
{
  const e = newSpriteEngine(0);
  loadSpriteRegs(e, 100, 0, 50, false /* not enabled */, false, false, false, false, 0x05);
  onLineStart(e, 50);
  ok("y-trigger: not enabled → no activation", e.active === false);
  loadSpriteRegs(e, 100, 0, 50, true, false, false, false, false, 0x05);
  onLineStart(e, 49);  // y mismatch
  ok("y-trigger: y mismatch → no activation", e.active === false);
  onLineStart(e, 50);
  ok("y-trigger: y match + enabled → active", e.active === true);
}

// ---------------------------------------------------------------------------
// Y-expand: line counter doubles
// ---------------------------------------------------------------------------
{
  const e = newSpriteEngine(0);
  loadSpriteRegs(e, 100, 0, 50, true, true /* y-expand */, false, false, false, 0x05);
  loadSpriteDmaByte(e, 0, 0xaa);
  loadSpriteDmaByte(e, 1, 0xbb);
  loadSpriteDmaByte(e, 2, 0xcc);
  onLineStart(e, 50);
  const row1 = e.spriteRow;
  // Same data fetched again (y-expand → no row advance on first replay)
  loadSpriteDmaByte(e, 0, 0x11);
  loadSpriteDmaByte(e, 1, 0x22);
  loadSpriteDmaByte(e, 2, 0x33);
  onLineStart(e, 51);
  const row2 = e.spriteRow;
  ok("y-expand: line 51 keeps spriteRow (row replayed)", row1 === row2,
     `row1=${row1} row2=${row2}`);
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
