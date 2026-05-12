#!/usr/bin/env node
// Spec 412 — 1541 Phase F smoke A: rotation tick count == drive cycle
// count after 1M drive cycles.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §13 Phase F step 24 + §14 invariant 1
//       + §12 per-cycle tick-order step 1.
// VICE: src/drive/rotation.c (rotation_rotate_disk),
//       src/6510core.c (drivecpu_rotate macro fires once per cycle).
//
// §14 invariant 1: "rotation_rotate_disk() runs exactly once per drive
// CPU cycle. Skip → SYNC misdetect → 'DRIVE NOT READY'. Double →
// bit-rate doubles → garbage reads."
//
// This smoke asserts the invariant directly: ticking the shifter N
// times must record exactly N invocations of the per-cycle rotation
// step, regardless of motor state, density zone, or attached image.
//
// Doc cite: docs/vice-1541-arch.md §14 invariant 1.
// VICE cite: src/drive/rotation.c L1106 `rotation_rotate_disk`.

import { GcrShifter, ROTATION_WOBBLE_PRNG_SEED, ROT_SPEED_BPS, CYCLES_PER_BYTE_BY_ZONE } from "../dist/runtime/headless/drive/gcr-shifter.js";
import { HeadPosition } from "../dist/runtime/headless/drive/head-position.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}

// Minimal G64 stub — empty tracks so the shifter reads 0-bits and never
// emits a SYNC (we are only asserting tick-count fidelity here).
const emptyParser = {
  getRawTrackBytes: (_track) => null,
};

function makeShifter({ motorOn = true } = {}) {
  const head = new HeadPosition({ startTrack: 18 });
  const shifter = new GcrShifter({
    parser: /** @type {any} */ (emptyParser),
    headPosition: head,
  });
  shifter.setMotor(motorOn);
  return { shifter, head };
}

// --- Sub-test 1: VICE-exact rot_speed_bps[2][4] table ---------------
// OQ-412-2 RESOLVED (doc §17, §8.3). Pinned to rotation.c:89.
{
  const expectedFreq0 = [250000, 266667, 285714, 307692];
  const expectedFreq1 = [125000, 133333, 142857, 153846];
  let ok = true;
  for (let i = 0; i < 4; i++) {
    if (ROT_SPEED_BPS[0][i] !== expectedFreq0[i]) ok = false;
    if (ROT_SPEED_BPS[1][i] !== expectedFreq1[i]) ok = false;
  }
  check("ROT_SPEED_BPS pinned to VICE rotation.c:89", ok,
        `freq0=${JSON.stringify(ROT_SPEED_BPS[0])} freq1=${JSON.stringify(ROT_SPEED_BPS[1])}`);
}

// CYCLES_PER_BYTE_BY_ZONE derived from rot_speed_bps[0] at 1 MHz.
{
  const expected = [32, 30, 28, 26];
  let ok = true;
  for (let i = 0; i < 4; i++) {
    if (CYCLES_PER_BYTE_BY_ZONE[i] !== expected[i]) ok = false;
  }
  check("CYCLES_PER_BYTE_BY_ZONE [32, 30, 28, 26] (zones 0..3)", ok,
        `actual=${JSON.stringify(CYCLES_PER_BYTE_BY_ZONE)}`);
}

// --- Sub-test 2: wobble PRNG seed pinned ---------------------------
// OQ-412-1 RESOLVED (doc §17, §8.5). VICE rotation.c:100, 122.
{
  check("ROTATION_WOBBLE_PRNG_SEED == 0x1234abcd",
        ROTATION_WOBBLE_PRNG_SEED === 0x1234abcd,
        `seed=0x${(ROTATION_WOBBLE_PRNG_SEED >>> 0).toString(16)}`);

  const { shifter } = makeShifter();
  // Pre-tick: PRNG state should still be the fixed seed (advancement
  // happens on tick).
  check("fresh shifter wobblePrngState == 0x1234abcd",
        shifter.wobblePrngState === 0x1234abcd,
        `state=0x${shifter.wobblePrngState.toString(16)}`);

  // After 1 tick (motor on): xorShift32 advances exactly once.
  // Compute expected value with the VICE rotation.c:290-292 sequence.
  let x = 0x1234abcd >>> 0;
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  x = (x ^ (x << 5)) >>> 0;
  shifter.tick(1);
  check("xorShift32 advances per VICE rotation.c:290-292",
        shifter.wobblePrngState === x,
        `expected=0x${x.toString(16)} actual=0x${shifter.wobblePrngState.toString(16)}`);
}

// --- Sub-test 3: rotation tick count == drive cycle count (motor on) ---
// §14 invariant 1: exactly one rotation per drive cycle.
{
  const { shifter } = makeShifter();
  const N = 1_000_000;
  for (let i = 0; i < N; i++) shifter.tick(1);
  check(`tickCount == ${N.toLocaleString()} after ${N.toLocaleString()} ticks (motor on)`,
        shifter.tickCount === N,
        `actual=${shifter.tickCount}`);
}

// --- Sub-test 4: tickCount still increments with motor off -----------
// §14 invariant 1 counts the *invocation*. VICE rotation_rotate_disk
// is called per drive cycle by drivecpu_rotate macro regardless of
// motor state — the BRA_MOTOR_ON gate is INSIDE rotation_rotate_disk
// (rotation.c L1108). Our invocation accounting must match.
{
  const { shifter } = makeShifter({ motorOn: false });
  const N = 100_000;
  for (let i = 0; i < N; i++) shifter.tick(1);
  check(`tickCount == ${N.toLocaleString()} after ${N.toLocaleString()} ticks (motor off)`,
        shifter.tickCount === N,
        `actual=${shifter.tickCount}`);
}

// --- Sub-test 5: tickCount NOT doubled by re-entry ----------------------
// "Double → bit-rate doubles → garbage reads" (invariant 1).  We
// approximate the "double" failure mode by ticking with a positive
// `driveCycles` argument: the counter must increment by exactly that
// amount, not 2× (= no accidental loop body re-execution).
{
  const { shifter } = makeShifter();
  shifter.tick(7);
  check("tick(7) → tickCount == 7 (not 14, not 0)",
        shifter.tickCount === 7,
        `actual=${shifter.tickCount}`);
  shifter.tick(3);
  check("tick(3) cumulative → tickCount == 10",
        shifter.tickCount === 10,
        `actual=${shifter.tickCount}`);
}

// --- Sub-test 6: tick(0) does NOT advance counter -------------------
// VICE rotation_rotate_disk returns early if delta == 0 (rotation.c
// L1036). Our equivalent: caller passes driveCycles<=0 → no-op.
{
  const { shifter } = makeShifter();
  shifter.tick(0);
  shifter.tick(-1);
  check("tick(0) / tick(-1) → tickCount unchanged",
        shifter.tickCount === 0,
        `actual=${shifter.tickCount}`);
}

// --- Sub-test 7: reset() re-seeds PRNG + clears counter --------------
// VICE rotation_reset (rotation.c:122) sets xorShift32 = 0x1234abcd.
{
  const { shifter } = makeShifter();
  for (let i = 0; i < 100; i++) shifter.tick(1);
  // sanity: state has moved off seed.
  const movedOff = shifter.wobblePrngState !== 0x1234abcd && shifter.tickCount === 100;
  check("pre-reset: PRNG moved off seed; tickCount accumulated",
        movedOff,
        `state=0x${shifter.wobblePrngState.toString(16)} count=${shifter.tickCount}`);
  shifter.reset();
  check("reset(): wobblePrngState back to 0x1234abcd",
        shifter.wobblePrngState === 0x1234abcd,
        `state=0x${shifter.wobblePrngState.toString(16)}`);
  check("reset(): tickCount back to 0",
        shifter.tickCount === 0,
        `count=${shifter.tickCount}`);
}

// --- Report ----------------------------------------------------------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`Spec 412 smoke A — rotation per-cycle invariant — ${pass}/${results.length} pass, ${fail} fail`);
for (const r of results) {
  if (!r.pass) console.log(`  [FAIL] ${r.label}: ${r.detail}`);
}
if (fail > 0) process.exit(1);
