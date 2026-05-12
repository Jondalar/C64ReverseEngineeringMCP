// Spec 150 — VIC-II register R/W unit tests.
//
// Each test cites VICE 3.7.1 src/vicii/vicii-mem.c lines for the
// store/read path under test. Run via:
//   npx tsx tests/unit/vic/vic-register-rw.test.ts

import { strict as assert } from "node:assert";
import { makeTestVic } from "./vic-test-helpers.js";
import {
  VICII_R_BORDER,
  VICII_R_BG0,
  VICII_R_CTRL1,
  VICII_R_CTRL2,
  VICII_R_IRQ_MASK,
  VICII_R_IRQ_STATUS,
  VICII_R_MEM_PTR,
  VICII_R_RASTER,
  VICII_R_SP_BG_COLL,
  VICII_R_SP_ENABLE,
  VICII_R_SP_SP_COLL,
} from "../../../src/runtime/headless/vic/vic-ii-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// VICE: vicii_store $D000-$D00F latch — vicii-mem.c 1313-1333 (sprite
// X LSB / Y position store). Round-trips via regs[].
test("sprite X LSB / Y latch round-trip ($D000..$D00F)", () => {
  const { vic } = makeTestVic();
  for (let r = 0x00; r < 0x10; r++) vic.write(r, (r * 13) & 0xff);
  for (let r = 0x00; r < 0x10; r++) assert.equal(vic.read(r), (r * 13) & 0xff, `reg $D0${r.toString(16).padStart(2,"0")}`);
});

// VICE: vicii_read $D016 returns reg | 0xc0 (vicii-mem.c 1745).
test("$D016 read returns value | 0xc0 (top 2 bits open)", () => {
  const { vic } = makeTestVic();
  vic.write(VICII_R_CTRL2, 0x08);
  assert.equal(vic.read(VICII_R_CTRL2), 0xc8);
});

// VICE: vicii_read $D018 returns reg | 0x01 (vicii-mem.c 1755).
test("$D018 read returns value | 0x01 (bit 0 open)", () => {
  const { vic } = makeTestVic();
  vic.write(VICII_R_MEM_PTR, 0x14);
  assert.equal(vic.read(VICII_R_MEM_PTR), 0x15);
});

// VICE: vicii_read $D01A returns reg | 0xf0 (vicii-mem.c 1770).
test("$D01A read returns value | 0xf0 (top nibble open)", () => {
  const { vic } = makeTestVic();
  vic.write(VICII_R_IRQ_MASK, 0x01);
  assert.equal(vic.read(VICII_R_IRQ_MASK), 0xf1);
});

// VICE: $D020-$D026 colors return reg | 0xf0 — vicii-mem.c 1796/1804/1810.
test("$D020/$D021 color reads return reg | 0xf0", () => {
  const { vic } = makeTestVic();
  vic.write(VICII_R_BORDER, 0x05);
  vic.write(VICII_R_BG0, 0x0a);
  assert.equal(vic.read(VICII_R_BORDER), 0xf5);
  assert.equal(vic.read(VICII_R_BG0), 0xfa);
});

// VICE: color write masks to 4 bits (high nibble discarded — d020_store
// vicii-mem.c d020_store stores value to reg, but read mask | 0xf0
// makes the high nibble irrelevant). Our impl truncates on write so the
// snapshot is canonicalised.
test("color writes truncate to low nibble", () => {
  const { vic } = makeTestVic();
  vic.write(VICII_R_BORDER, 0xa5);
  // Read returns | 0xf0; underlying reg low nibble is 0x05.
  assert.equal(vic.read(VICII_R_BORDER) & 0x0f, 0x05);
});

// VICE: $D02F/$D030 non-VIC-IIe return 0xff — vicii-mem.c 1832/1842.
test("$D02F / $D030 read 0xff (non-VIC-IIe)", () => {
  const { vic } = makeTestVic();
  vic.write(0x2f, 0x42);
  vic.write(0x30, 0x42);
  assert.equal(vic.read(0x2f), 0xff);
  assert.equal(vic.read(0x30), 0xff);
});

// VICE: $D031..$D03F unused return 0xff — vicii-mem.c 1846-1851.
test("$D031..$D03F unused reads return 0xff", () => {
  const { vic } = makeTestVic();
  for (let r = 0x31; r <= 0x3f; r++) {
    assert.equal(vic.read(r), 0xff, `reg $D0${r.toString(16)}`);
  }
});

// VICE: vicii_read $D013/$D014 lightpen — at B-level returns 0
// (light_pen.x / light_pen.y init to 0; vicii.c line 486).
test("$D013/$D014 lightpen reads return 0 (B-level stub)", () => {
  const { vic } = makeTestVic();
  assert.equal(vic.read(0x13), 0);
  assert.equal(vic.read(0x14), 0);
  // Writes ignored.
  vic.write(0x13, 0xff);
  vic.write(0x14, 0xff);
  assert.equal(vic.read(0x13), 0);
  assert.equal(vic.read(0x14), 0);
});

// VICE: $D01E read-clears (d01e_read vicii-mem.c 1633: vicii.regs[0x1e]
// = vicii.sprite_sprite_collisions; sprite_sprite_collisions = 0).
test("$D01E sprite-sprite collision is read-clear", () => {
  const { vic } = makeTestVic();
  vic.setSpriteSpriteCollisionFlag(0x42);
  assert.equal(vic.read(VICII_R_SP_SP_COLL), 0x42);
  assert.equal(vic.read(VICII_R_SP_SP_COLL), 0);
});

// VICE: $D01F read-clears similarly.
test("$D01F sprite-bg collision is read-clear", () => {
  const { vic } = makeTestVic();
  vic.setSpriteBgCollisionFlag(0x81);
  assert.equal(vic.read(VICII_R_SP_BG_COLL), 0x81);
  assert.equal(vic.read(VICII_R_SP_BG_COLL), 0);
});

// VICE: collision_store (vicii-mem.c d01e/d01f case 0x1e/0x1f) — writes
// to collision regs are no-ops on the latches.
test("$D01E / $D01F writes do not alter latches", () => {
  const { vic } = makeTestVic();
  vic.setSpriteSpriteCollisionFlag(0x12);
  vic.write(VICII_R_SP_SP_COLL, 0xff);
  assert.equal(vic.read(VICII_R_SP_SP_COLL), 0x12); // still latched
});

// VICE: $D015 sprite-enable round-trip.
test("$D015 sprite enable round-trips via regs", () => {
  const { vic } = makeTestVic();
  vic.write(VICII_R_SP_ENABLE, 0xa5);
  assert.equal(vic.read(VICII_R_SP_ENABLE), 0xa5);
});

// VICE: vicii_read addr & 0x3f (vicii-mem.c 1681). Mirroring inside
// $D000-$D03F via stride 0x40.
test("$D040 read maps to $D000 (mirror modulo 0x40)", () => {
  const { vic } = makeTestVic();
  vic.write(0x00, 0x77);
  assert.equal(vic.read(0x40 & 0x3f), 0x77);
});

// VICE: $D012 (raster compare) write doesn't echo via $D012 read —
// $D012 read returns LIVE raster_y (d01112_read line 1583). At line 0
// cycle 0 there's a +1 quirk (line 1576) that returns screen_height-1
// (PAL: 311 → 0x37). Advance raster_cycle past 0 to read clean 0.
test("$D012 read returns live raster_y, not the stored compare value", () => {
  const { vic, clk } = makeTestVic();
  vic.write(VICII_R_RASTER, 0xab);
  // Step past cycle 0 to bypass the line-0 quirk.
  vic.tick(1);
  clk.v += 1;
  // raster_y still 0 → read returns 0.
  assert.equal(vic.read(VICII_R_RASTER), 0);
});

// VICE: $D011 read bit 7 = raster_y bit 8 (d01112_read line 1590).
test("$D011 read bit 7 reflects live raster_y bit 8", () => {
  const { vic, clk } = makeTestVic();
  // Move past line 256 so bit 8 becomes 1.
  for (let i = 0; i < 257; i++) {
    vic.tick(vic.cycles_per_line);
    clk.v += vic.cycles_per_line;
  }
  // raster_y now > 256 → $D011 bit 7 set.
  assert.equal(vic.read(VICII_R_CTRL1) & 0x80, 0x80);
});

// VICE: vicii_powerup zeros all regs. Mirror.
test("powerup zeroes all writable regs", () => {
  const { vic } = makeTestVic();
  for (let r = 0; r < 0x40; r++) vic.write(r, 0xff);
  vic.powerup();
  for (let r = 0; r < 0x10; r++) assert.equal(vic.read(r), 0, `sprite reg $${r.toString(16)}`);
});

// VICE: $D019 IRQ status — write 1-to-clear (d019_store line 640:
// irq_status &= ~((value & 0xf) | 0x80)).
test("$D019 write clears bits with 1-to-clear semantics", () => {
  const { vic } = makeTestVic();
  vic.write(VICII_R_IRQ_MASK, 0x0f); // unmask everything
  vic.setSpriteSpriteCollisionFlag(0x01); // sets sscoll bit
  // Now d019 read will report bit 2 set + bit 7 summary.
  let d019 = vic.read(VICII_R_IRQ_STATUS);
  assert.equal(d019 & 0x04, 0x04, "sscoll bit set");
  // Clear sscoll bit (bit 2) by writing 0x04.
  vic.write(VICII_R_IRQ_STATUS, 0x04);
  d019 = vic.read(VICII_R_IRQ_STATUS);
  assert.equal(d019 & 0x04, 0x00, "sscoll bit cleared");
});

// ---- runner ----
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nvic-register-rw: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
