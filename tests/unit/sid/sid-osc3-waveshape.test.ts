// Spec 151 — $D41B osc3 wave-shape readback unit tests.
//
// Each test asserts behavior derived from VICE 3.7.1 src/sid/fastsid.c
// doosc() (line 341 wavetables / line 349 non-wavetable) plus Spec 151
// arithmetic (lines 56-65). Cited file/line in each test comment.

import { strict as assert } from "node:assert";
import { Sid6581 } from "../../../src/runtime/headless/sid/sid.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// VICE: doosc() with no wave bits set returns 0 (default branch in
// non-wavetable path, line 382). Spec 151 line 65: wave==0 → 0.
test("$D41B with no wave bits set returns 0", () => {
  const sid = new Sid6581();
  // Voice 3 control reg = $D412 (offset 0x12), all wave bits clear.
  sid.write(0x12, 0x00);
  assert.equal(sid.read(0x1b), 0);
});

// VICE doosc TRIANGLE branch (line 362). Spec 151 line 58: tri12 =
// (phase >> 11) ^ ((phase & 0x800000) ? 0xfff : 0); take high 8 bits.
// At phase=0 → tri12=0 → output high-byte=0.
test("triangle wave at phase=0 returns 0", () => {
  const sid = new Sid6581();
  sid.write(0x12, 0x10); // wave bit 4 = triangle
  assert.equal(sid.read(0x1b), 0);
});

// Sawtooth — VICE doosc SAWTOOTHWAVE branch (line 358): `return f >> 17`.
// Spec 151 line 59 (24-bit phase): `(phase >> 16) & 0xff`. At phase=0 → 0.
test("sawtooth wave at phase=0 returns 0", () => {
  const sid = new Sid6581();
  sid.write(0x12, 0x20);
  assert.equal(sid.read(0x1b), 0);
});

// Sawtooth advances with frequency. Set freq=high, tick a few cycles,
// expect non-zero readback.
test("sawtooth wave climbs with phase advance", () => {
  const sid = new Sid6581();
  // Freq = 0x4000 (mid-range). $D40E low / $D40F high.
  sid.write(0x0e, 0x00);
  sid.write(0x0f, 0x40);
  sid.write(0x12, 0x20); // sawtooth
  // After 256 cycles: phase = 0x4000 * 256 = 0x400000. (0x400000 >> 16) & 0xff = 0x40.
  sid.tick(256);
  assert.equal(sid.read(0x1b), 0x40);
});

// VICE doosc PULSEWAVE (line 377-380): f >= pw → 0x7fff else 0x0000.
// Spec 151 line 60: phase < pw<<12 → 0x00 else 0xff.
test("pulse wave: phase < pw<<12 returns 0x00", () => {
  const sid = new Sid6581();
  // PW = 0x800 (mid). $D410 + low-nibble $D411.
  sid.write(0x10, 0x00);
  sid.write(0x11, 0x08);
  sid.write(0x12, 0x40); // pulse
  // Phase = 0 < 0x800<<12 = 0x800000 → 0x00.
  assert.equal(sid.read(0x1b), 0x00);
});

test("pulse wave: phase >= pw<<12 returns 0xff", () => {
  const sid = new Sid6581();
  // Force phase past pw via freq advance.
  sid.write(0x10, 0x00);
  sid.write(0x11, 0x01);  // pw = 0x100, threshold = 0x100000
  sid.write(0x0e, 0x00);
  sid.write(0x0f, 0x40);  // freq = 0x4000
  sid.write(0x12, 0x40);  // pulse
  // 256 cycles → phase 0x400000 > 0x100000 → 0xff.
  sid.tick(256);
  assert.equal(sid.read(0x1b), 0xff);
});

// VICE doosc NOISEWAVE (line 375): NVALUE(NSHIFT(rv, f >> 28)). Spec
// 151 line 62: LFSR-derived. With TEST bit set, rv = NSEED → noise
// returns deterministic NVALUE(NSEED).
test("noise wave with TEST bit set returns NVALUE(NSEED)", () => {
  const sid = new Sid6581();
  // TEST + noise bit set → phase=0, rv=NSEED.
  sid.write(0x12, 0x88); // bit 3 = TEST, bit 7 = noise
  // NSEED = 0x7ffff8. Compute expected NVALUE: bits 22,20,16,13,11,7,4,2.
  // 0x7ffff8 = 0111_1111_1111_1111_1111_1000.
  // bits 22..16 all 1, bits 15..3 all 1, bits 2..0 = 000.
  // bit22=1, bit20=1, bit16=1, bit13=1, bit11=1, bit7=1, bit4=1, bit2=0.
  // NVALUE = 0xff & ~0x01 = 0xfe.
  assert.equal(sid.read(0x1b), 0xfe);
});

// VICE doosc combined waves: in non-wavetable path the cases fall
// through; resid does it differently. Spec 151 line 64: AND of
// individual outputs (close approx, B-level OK).
test("combined triangle+sawtooth ANDs outputs", () => {
  const sid = new Sid6581();
  sid.write(0x0e, 0x00);
  sid.write(0x0f, 0x40);  // freq = 0x4000
  sid.write(0x12, 0x30);  // triangle + sawtooth
  sid.tick(256);
  // phase = 0x400000
  // triangle: tri12 = (0x400000>>11) ^ 0 = 0x800. high 8 = 0x80.
  // sawtooth: (0x400000>>16) & 0xff = 0x40.
  // AND = 0x80 & 0x40 = 0x00.
  assert.equal(sid.read(0x1b), 0x00);
});

// VICE setup_voice line 554-557: TEST bit (control bit 3) zeros phase
// and seeds rv to NSEED.
test("TEST bit holds phase at 0 (sawtooth stays 0 across ticks)", () => {
  const sid = new Sid6581();
  sid.write(0x0e, 0xff);
  sid.write(0x0f, 0xff);  // freq = max
  sid.write(0x12, 0x28);  // sawtooth + TEST
  sid.tick(1000);
  // Even with max freq + 1000 ticks, TEST keeps phase=0 → saw=0.
  assert.equal(sid.read(0x1b), 0);
});

// ---- runner --------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nsid-osc3-waveshape: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
