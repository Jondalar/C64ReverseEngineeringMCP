#!/usr/bin/env node
// Spec 296c smoke — sprite collision latch + IRQ + read-clear timing.

import {
  newSpriteCollisionState, resetSpriteCollisionState,
  pixelCollisionUpdate, readD01E, readD01F,
  peekD01E, peekD01F, applyDeferredCollisionClear,
  writeD01E, writeD01F,
  IRQ_SPRITE_SPRITE, IRQ_SPRITE_BACKGROUND,
} from "../dist/runtime/headless/vic/sprite-collision-latch.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-sprite-collision-latch — Spec 296c");

// 1. Init
{
  const s = newSpriteCollisionState();
  ok("init: latches zero", s.sprite_sprite_collisions === 0 && s.sprite_background_collisions === 0);
  ok("init: clear_collisions zero", s.clear_collisions === 0);
}

// 2. Single sprite + no fg → no collision
{
  const s = newSpriteCollisionState();
  const edge = pixelCollisionUpdate(s, 0x01, 0);
  ok("single sprite + no fg: no spr-spr (need 2+)", s.sprite_sprite_collisions === 0);
  ok("single sprite + no fg: no spr-bg (need fg)", s.sprite_background_collisions === 0);
  ok("single sprite + no fg: no IRQ edge", edge === 0);
}

// 3. Two sprites overlap → spr-spr latch
{
  const s = newSpriteCollisionState();
  const edge = pixelCollisionUpdate(s, 0b00000011, 0);
  ok("2 sprites: latch = both bits", s.sprite_sprite_collisions === 0b11);
  ok("2 sprites: IRQ edge spr-spr asserted", (edge & IRQ_SPRITE_SPRITE) !== 0);
  ok("2 sprites + no fg: no spr-bg latch", s.sprite_background_collisions === 0);
}

// 4. Sprite + fg → spr-bg latch
{
  const s = newSpriteCollisionState();
  const edge = pixelCollisionUpdate(s, 0b00000001, 1);
  ok("sprite+fg: spr-bg latch sprite 0", s.sprite_background_collisions === 0b1);
  ok("sprite+fg: IRQ edge spr-bg asserted", (edge & IRQ_SPRITE_BACKGROUND) !== 0);
  ok("sprite+fg: no spr-spr (only 1 sprite)", s.sprite_sprite_collisions === 0);
}

// 5. IRQ edge fires ONLY on 0 → non-0 transition
{
  const s = newSpriteCollisionState();
  const e1 = pixelCollisionUpdate(s, 0b11, 0);
  ok("first 2-sprite hit: IRQ edge", (e1 & IRQ_SPRITE_SPRITE) !== 0);
  // Latch still non-zero. Second hit with same or different sprites should NOT raise edge again.
  const e2 = pixelCollisionUpdate(s, 0b11, 0);
  ok("second hit while latch non-zero: NO IRQ edge", (e2 & IRQ_SPRITE_SPRITE) === 0);
  // Different sprite pair, latch still non-zero — also no edge
  const e3 = pixelCollisionUpdate(s, 0b1100, 0);
  ok("third hit while latch non-zero: NO IRQ edge", (e3 & IRQ_SPRITE_SPRITE) === 0);
  ok("latch accumulates bits", s.sprite_sprite_collisions === 0b1111);
}

// 6. Read $D01F returns latch + schedules clear (NOT immediate)
{
  const s = newSpriteCollisionState();
  pixelCollisionUpdate(s, 0b1, 1);
  const v = readD01F(s);
  ok("read $D01F: returns latch", v === 0b1);
  ok("read $D01F: latch NOT yet cleared", s.sprite_background_collisions === 0b1);
  ok("read $D01F: clear scheduled", (s.clear_collisions & 0x1f) !== 0);
  applyDeferredCollisionClear(s);
  ok("after applyDeferredClear: latch cleared", s.sprite_background_collisions === 0);
  ok("after applyDeferredClear: clear flag reset", s.clear_collisions === 0);
}

// 7. Read $D01E returns latch + schedules clear
{
  const s = newSpriteCollisionState();
  pixelCollisionUpdate(s, 0b11, 0);
  const v = readD01E(s);
  ok("read $D01E: returns spr-spr latch", v === 0b11);
  ok("read $D01E: clear scheduled (bit 0x1e)", (s.clear_collisions & 0x1e) !== 0);
  applyDeferredCollisionClear(s);
  ok("$D01E: deferred clear", s.sprite_sprite_collisions === 0);
}

// 8. peek $D01E/$D01F returns latch WITHOUT scheduling clear
{
  const s = newSpriteCollisionState();
  pixelCollisionUpdate(s, 0b11, 1);
  const v1 = peekD01E(s);
  const v2 = peekD01F(s);
  ok("peek $D01E: returns latch", v1 === 0b11);
  ok("peek $D01F: returns latch", v2 === 0b11);
  ok("peek: no clear scheduled", s.clear_collisions === 0);
  applyDeferredCollisionClear(s);
  ok("peek: latch survives apply (no clear)", s.sprite_sprite_collisions === 0b11);
}

// 9. Writes to $D01E/$D01F are IGNORED
{
  const s = newSpriteCollisionState();
  pixelCollisionUpdate(s, 0b1, 1);
  writeD01E(s, 0xff);
  writeD01F(s, 0xff);
  ok("write $D01E ignored", s.sprite_sprite_collisions === 0);
  ok("write $D01F ignored: latch unchanged", s.sprite_background_collisions === 0b1);
}

// 10. After clear, NEXT collision raises IRQ edge again
{
  const s = newSpriteCollisionState();
  const e1 = pixelCollisionUpdate(s, 0b11, 0);
  ok("hit 1: IRQ edge", (e1 & IRQ_SPRITE_SPRITE) !== 0);
  readD01E(s);
  applyDeferredCollisionClear(s);
  const e2 = pixelCollisionUpdate(s, 0b11, 0);
  ok("after read+clear, hit 2: IRQ edge again", (e2 & IRQ_SPRITE_SPRITE) !== 0);
}

// 11. resetSpriteCollisionState clears everything
{
  const s = newSpriteCollisionState();
  pixelCollisionUpdate(s, 0b11, 1);
  readD01E(s); readD01F(s);
  resetSpriteCollisionState(s);
  ok("reset: all zero", s.sprite_sprite_collisions === 0 &&
                        s.sprite_background_collisions === 0 &&
                        s.clear_collisions === 0);
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
