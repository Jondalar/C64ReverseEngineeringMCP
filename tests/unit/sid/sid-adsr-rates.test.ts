// Spec 151 — ADSR rate-table + state-machine unit tests.
//
// Each test asserts behavior derived from VICE 3.7.1 src/sid/fastsid.c
// set_adsr() (line 387) + trigger_adsr() (line 435) + setup_voice()
// gate-edge handling (line 660). Cited file/line in each test comment.

import { strict as assert } from "node:assert";
import {
  Sid6581,
  ADSR_ATTACK_CYCLES,
  ADSR_DECAY_RELEASE_CYCLES,
} from "../../../src/runtime/headless/sid/sid.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// VICE adrtable[] — fastsid.c line 236-239. Real-HW PAL cycles-per-step:
//   9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907,
//   11720, 19532, 31251.
test("ADSR_ATTACK_CYCLES matches Yannes / VICE adrtable scaling", () => {
  const expected = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];
  assert.deepEqual([...ADSR_ATTACK_CYCLES], expected);
});

test("ADSR_DECAY_RELEASE_CYCLES = 3 * attack table", () => {
  for (let i = 0; i < 16; i++) {
    assert.equal(ADSR_DECAY_RELEASE_CYCLES[i], ADSR_ATTACK_CYCLES[i]! * 3);
  }
});

// VICE setup_voice() line 660-678: GATE rising edge while ADSR in
// RELEASE/IDLE → set_adsr(ATTACK). $D41C readback tracks adsr counter.
test("env3 starts at 0 before GATE", () => {
  const sid = new Sid6581();
  sid.write(0x12, 0x10); // pulse
  sid.write(0x13, 0x00); // attack=0 decay=0
  sid.write(0x14, 0xf0); // sustain=15 release=0
  assert.equal(sid.read(0x1c), 0);
});

// VICE trigger_adsr ATTACK→DECAY (line 438): when adsr counter reaches
// 0x7fffffff, transition to DECAY. With attack=0 (9 cycles per step),
// reaching 255 takes 9*255 = 2295 cycles, then DECAY (27 cycles per
// step) drains to sustain.
test("env3 climbs after GATE rising with attack=0", () => {
  const sid = new Sid6581();
  sid.write(0x12, 0x10);
  sid.write(0x13, 0x00);
  sid.write(0x14, 0xf0); // sustain=15 → level=255, release=0
  sid.write(0x12, 0x11); // GATE on
  // attack rate index 0 = 9 cycles/step. 9*100 = 900 cycles → ~100 steps.
  sid.tick(900);
  const env = sid.read(0x1c);
  assert.ok(env >= 90 && env <= 110, `expected ~100, got ${env}`);
});

// VICE setup_voice line 668: GATE falling → set_adsr(RELEASE). Release
// drains adsr counter. With release=0 (27 cycles/step), adsr goes from
// peak to 0 in 27*255 = 6885 cycles.
test("env3 drains after GATE falling", () => {
  const sid = new Sid6581();
  sid.write(0x12, 0x10);
  sid.write(0x13, 0x00); // attack=0 decay=0
  sid.write(0x14, 0xf0); // sustain=15 release=0
  sid.write(0x12, 0x11); // GATE on
  sid.tick(2400);        // ~ peak
  const peak = sid.read(0x1c);
  assert.ok(peak >= 250, `peak too low: ${peak}`);
  sid.write(0x12, 0x10); // GATE off → release
  sid.tick(10000);
  const after = sid.read(0x1c);
  assert.ok(after < 16, `release didn't drain: ${after}`);
});

// VICE set_adsr SUSTAIN (line 409): adsrs=0, holds at sustain level.
// Decay reaches sustain level then SUSTAIN holds.
test("env3 stabilizes at sustain level after attack+decay", () => {
  const sid = new Sid6581();
  // Attack=0 (9 cyc/step), decay=0 (27 cyc/step), sustain=8 → level
  // 8*17 = 136. Release = whatever.
  sid.write(0x12, 0x10);
  sid.write(0x13, 0x00); // attack=0 decay=0
  sid.write(0x14, 0x80); // sustain=8 release=0
  sid.write(0x12, 0x11); // GATE on
  // Attack: 9*255 = 2295 cyc. Decay: 27 * (255-136) = ~3213 cyc.
  // Total ~5508. Tick well past + give margin.
  sid.tick(20000);
  const env = sid.read(0x1c);
  assert.equal(env, 136, `expected sustain=136, got ${env}`);
});

// VICE: ADSR rate-table indices propagate from $Dx05/$Dx06. Bigger
// attack index = more cycles per step.
test("attack=15 (slow) climbs much slower than attack=0 (fast)", () => {
  const slowSid = new Sid6581();
  slowSid.write(0x12, 0x10);
  slowSid.write(0x13, 0xf0); // attack=15 decay=0
  slowSid.write(0x14, 0xf0);
  slowSid.write(0x12, 0x11); // GATE
  slowSid.tick(50_000);
  const slow = slowSid.read(0x1c);
  // attack=15 = 31251 cycles/step. 50000/31251 ≈ 1 step.
  assert.ok(slow <= 5, `expected very low climb, got ${slow}`);

  const fastSid = new Sid6581();
  fastSid.write(0x12, 0x10);
  fastSid.write(0x13, 0x00); // attack=0
  fastSid.write(0x14, 0xf0);
  fastSid.write(0x12, 0x11);
  fastSid.tick(50_000);
  const fast = fastSid.read(0x1c);
  // attack=0 = 9 cycles/step. 50000/9 ≈ 5555 steps → saturated long ago.
  assert.ok(fast >= 250, `expected saturated, got ${fast}`);
});

// VICE setup_voice GATE flip during sustain → re-enter ATTACK if rising
// (line 660-665).
test("re-triggering GATE during sustain restarts attack", () => {
  const sid = new Sid6581();
  sid.write(0x12, 0x10);
  sid.write(0x13, 0x00);
  sid.write(0x14, 0x80); // sustain=8 → 136
  sid.write(0x12, 0x11); // GATE on
  sid.tick(20000);
  assert.equal(sid.read(0x1c), 136);
  // Drop GATE → release
  sid.write(0x12, 0x10);
  sid.tick(2000); // partial drain
  const mid = sid.read(0x1c);
  assert.ok(mid < 136 && mid > 0, `expected partial drain, got ${mid}`);
  // Re-raise GATE → attack restarts from current envelope value.
  sid.write(0x12, 0x11);
  sid.tick(20000);
  // Should saturate at sustain again (136).
  assert.equal(sid.read(0x1c), 136);
});

// ---- runner --------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nsid-adsr-rates: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
