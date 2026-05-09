#!/usr/bin/env node
// Spec 297i smoke — per-pixel composite (gfx + sprite + collision).

import {
  compositePixel, isGfxForeground,
} from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/vic/cycle-pixel-composite.js";
import {
  newDisplayPipeState,
} from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/vic/display-pipe.js";
import {
  newSpriteEngine, loadSpriteRegs, loadSpriteDmaByte, onLineStart,
} from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/vic/sprite-cycle.js";
import {
  newSpriteCollisionState, IRQ_SPRITE_BACKGROUND, IRQ_SPRITE_SPRITE,
} from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/vic/sprite-collision-latch.js";
import {
  VicFramebuffer,
} from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/peripherals/vic-renderer.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-297i-pixel-composite");

const fb = new VicFramebuffer(true);
function readPx(x, y) {
  const off = (y * fb.width + x) * 4;
  return [fb.pixels[off], fb.pixels[off+1], fb.pixels[off+2]];
}
function colorMatches(actual, palIdx) {
  const [r, g, b] = fb.palette[palIdx & 0x0f];
  return actual[0] === r && actual[1] === g && actual[2] === b;
}

// -----------------------------------------------------------------------
// isGfxForeground basics
// -----------------------------------------------------------------------
{
  const pipe = newDisplayPipeState();
  pipe.gbuf.reg = 0x80;
  ok("mode 0: gbuf MSB=1 → fg", isGfxForeground(pipe, 0) === true);
  pipe.gbuf.reg = 0x00;
  ok("mode 0: gbuf MSB=0 → !fg", isGfxForeground(pipe, 0) === false);
  pipe.gbuf.reg = 0x80; pipe.cbuf.reg = 0x08;
  ok("mode 1 mc: gbuf MSB=1 (pair top) → fg", isGfxForeground(pipe, 1) === true);
  ok("mode 5 illegal: never fg", isGfxForeground(pipe, 5) === false);
}

// -----------------------------------------------------------------------
// composite: no sprites → just gfx pixel
// -----------------------------------------------------------------------
{
  const pipe = newDisplayPipeState();
  pipe.gbuf.reg = 0x80; pipe.cbuf.reg = 0x0e;
  const sprites = [];
  for (let i = 0; i < 8; i++) sprites.push(newSpriteEngine(i));
  const latch = newSpriteCollisionState();
  compositePixel(fb, 100, 100, pipe, 0, 0x06, 0, 0, 0, 0, 0, sprites, latch);
  ok("no sprites + fg pixel: gfx fg color", colorMatches(readPx(100, 100), 0x0e));
  ok("no sprites: no collision", latch.sprite_background_collisions === 0);
}

// -----------------------------------------------------------------------
// composite: sprite over bg, no priority bit → sprite wins
// -----------------------------------------------------------------------
{
  const pipe = newDisplayPipeState();
  pipe.gbuf.reg = 0x80; pipe.cbuf.reg = 0x0e;
  const sprites = [];
  for (let i = 0; i < 8; i++) sprites.push(newSpriteEngine(i));
  loadSpriteRegs(sprites[0], 100, 0, 50, true, false, false, false, false, 0x05);
  loadSpriteDmaByte(sprites[0], 0, 0xff);
  onLineStart(sprites[0], 50);
  const latch = newSpriteCollisionState();
  const r = compositePixel(fb, 100, 100, pipe, 0, 0x06, 0, 0, 0, 0, 0, sprites, latch);
  ok("sprite over fg gfx: sprite color wins", colorMatches(readPx(100, 100), 0x05));
  ok("sprite + fg gfx: sprite-bg latch set", latch.sprite_background_collisions === 0b1);
  ok("sprite + fg gfx: IRQ edge raised", (r.irqEdge & IRQ_SPRITE_BACKGROUND) !== 0);
}

// -----------------------------------------------------------------------
// composite: priority bit set + fg gfx → sprite hidden
// -----------------------------------------------------------------------
{
  const pipe = newDisplayPipeState();
  pipe.gbuf.reg = 0x80; pipe.cbuf.reg = 0x0e;
  const sprites = [];
  for (let i = 0; i < 8; i++) sprites.push(newSpriteEngine(i));
  loadSpriteRegs(sprites[0], 100, 0, 50, true, false, true /* priorityOverBg */, false, false, 0x05);
  loadSpriteDmaByte(sprites[0], 0, 0xff);
  onLineStart(sprites[0], 50);
  const latch = newSpriteCollisionState();
  compositePixel(fb, 101, 100, pipe, 0, 0x06, 0, 0, 0, 0, 0, sprites, latch);
  ok("priority over bg + fg gfx: sprite HIDDEN, gfx color stays",
     colorMatches(readPx(101, 100), 0x0e));
  ok("priority + fg gfx: collision still latches (sprite WAS opaque there)",
     latch.sprite_background_collisions === 0b1);
}

// -----------------------------------------------------------------------
// composite: 2 sprites overlap → spr-spr collision + first wins
// -----------------------------------------------------------------------
{
  const pipe = newDisplayPipeState();
  pipe.gbuf.reg = 0x00; // bg gfx (no fg)
  pipe.cbuf.reg = 0x0e;
  const sprites = [];
  for (let i = 0; i < 8; i++) sprites.push(newSpriteEngine(i));
  loadSpriteRegs(sprites[0], 100, 0, 50, true, false, false, false, false, 0x01);
  loadSpriteRegs(sprites[1], 100, 0, 50, true, false, false, false, false, 0x02);
  loadSpriteDmaByte(sprites[0], 0, 0xff);
  loadSpriteDmaByte(sprites[1], 0, 0xff);
  onLineStart(sprites[0], 50);
  onLineStart(sprites[1], 50);
  const latch = newSpriteCollisionState();
  const r = compositePixel(fb, 100, 100, pipe, 0, 0x06, 0, 0, 0, 0, 0, sprites, latch);
  ok("2 sprites overlap: lower index wins (sprite 0 color)",
     colorMatches(readPx(100, 100), 0x01));
  ok("2 sprites overlap: spr-spr latch = bits 0+1",
     latch.sprite_sprite_collisions === 0b11);
  ok("2 sprites overlap: IRQ edge spr-spr",
     (r.irqEdge & IRQ_SPRITE_SPRITE) !== 0);
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
