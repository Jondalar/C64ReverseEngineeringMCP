#!/usr/bin/env node
// Spec 411 — 1541 Phase E smoke A: VIA2 PB stepper → head-position
// half-track motion via modulo-4 phase-count algorithm.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §7.3 (stepper) + §14 invariant 7
//       + §17 OQ-411-1 (modulo-4 phase counts, NOT Gray code).
//
// VICE: src/drive/iecieee/via2d.c:229-313 `via2d_store()` PRB branch.
//       Algorithm:
//         old_stepper_position = (current_half_track - 2) & 3
//         new_stepper_position = byte & 3
//         step_count           = (new - old) & 3
//         if (step_count == 3) step_count = -1
//         if (motor_on && step_count == ±1) drive_move_head(step_count)
//
// Spec 411 acceptance: step head 1 half-track inward and outward via
// the modulo-4 phase sequence; assert `headPosition.currentTrack`
// advances correctly.

import { HeadPosition } from "../dist/runtime/headless/drive/head-position.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}

// Build a fresh head positioner starting at track 18 (default).
function makeHead(startTrack = 18) {
  return new HeadPosition({ startTrack });
}

// Helper: write a PB-style byte (motor + step phase) and observe motion.
// PB.0 = STEP_LO, PB.1 = STEP_HI, PB.2 = MOTOR.
function step(head, motor, phase) {
  head.applyStepBits(phase & 0x3, !!motor);
}

// --- Sub-test 1: motor OFF — no motion regardless of phase change ----
{
  const head = makeHead(18);
  // From track 18 (trackHalf=36, mod 4 = 2). Try every "next" phase
  // with motor off — none should move.
  for (const next of [0, 1, 2, 3]) {
    step(head, false, next);
  }
  check("motor OFF — head stays at track 18",
        head.currentTrack === 18,
        `currentTrack=${head.currentTrack}`);
}

// --- Sub-test 2: step IN one half-track (track 18 → 18.5) ------------
// At track 18: trackHalf=36, (36-2)&3 = 2. Next phase 3 → step_count = +1.
{
  const head = makeHead(18);
  step(head, true, 3);
  check("step IN: trackHalf 36 + phase 3 (Δ=+1) → trackHalf 37 (track 18.5)",
        head.currentHalfTrack === 37,
        `currentHalfTrack=${head.currentHalfTrack}`);
  check("step IN: currentTrack = 18.5", head.currentTrack === 18.5,
        `currentTrack=${head.currentTrack}`);
}

// --- Sub-test 3: step OUT one half-track (track 18 → 17.5) -----------
// At track 18: trackHalf=36, (36-2)&3 = 2. Next phase 1 → step_count = (1-2)&3 = 3 → -1.
{
  const head = makeHead(18);
  step(head, true, 1);
  check("step OUT: trackHalf 36 + phase 1 (Δ=-1) → trackHalf 35 (track 17.5)",
        head.currentHalfTrack === 35,
        `currentHalfTrack=${head.currentHalfTrack}`);
  check("step OUT: currentTrack = 17.5", head.currentTrack === 17.5,
        `currentTrack=${head.currentTrack}`);
}

// --- Sub-test 4: full IN sequence 00→01→10→11→00 = 4 half-tracks -----
// Sequence advances by +1 mod 4 every write. From track 18 (phase=2):
// write 3 → +1 (18.5, phase 3 in (36-2)&3=2 NO — recompute from new ht).
// After 18.5: ht=37, (37-2)&3=35&3=3. Next: write 0 (3→0: (0-3)&3=1) → +1.
// After 19.0: ht=38, (38-2)&3=36&3=0. Next: write 1 (1-0=1) → +1.
// After 19.5: ht=39, (39-2)&3=37&3=1. Next: write 2 (2-1=1) → +1.
// After 20.0: ht=40.  Total: 4 half-tracks = 2 full tracks inward.
{
  const head = makeHead(18);
  const seqIn = [3, 0, 1, 2];   // VICE-style IN sequence: each (new - old) & 3 = 1
  for (const p of seqIn) step(head, true, p);
  check("full IN seq 4 steps → trackHalf advanced by 4 (track 18 → 20)",
        head.currentHalfTrack === 40 && head.currentTrack === 20,
        `currentHalfTrack=${head.currentHalfTrack}, currentTrack=${head.currentTrack}`);
}

// --- Sub-test 5: full OUT sequence — 4 half-tracks outward -----------
// From track 18 (phase=2): write 1 → -1 (17.5, ht=35, phase=(35-2)&3=33&3=1).
// 17.5: write 0 (0-1)&3=3 → -1 (17.0, ht=34, (34-2)&3=0).
// 17.0: write 3 (3-0)&3=3 → -1 (16.5, ht=33, (33-2)&3=3).
// 16.5: write 2 (2-3)&3=3 → -1 (16.0, ht=32). Total: track 18 → 16.
{
  const head = makeHead(18);
  const seqOut = [1, 0, 3, 2];
  for (const p of seqOut) step(head, true, p);
  check("full OUT seq 4 steps → trackHalf retreated by 4 (track 18 → 16)",
        head.currentHalfTrack === 32 && head.currentTrack === 16,
        `currentHalfTrack=${head.currentHalfTrack}, currentTrack=${head.currentTrack}`);
}

// --- Sub-test 6: invalid double-step (Δphase = 2) → ignored ----------
// At track 18: phase=2. Write 0 → (0-2)&3 = 2 → invalid double-step.
// Per VICE via2d.c:307 — only ±1 advances. Head must NOT move.
{
  const head = makeHead(18);
  step(head, true, 0);   // Δ = 2 = invalid
  check("double-step (Δ=2) ignored — head stays at track 18",
        head.currentTrack === 18 && head.currentHalfTrack === 36,
        `currentHalfTrack=${head.currentHalfTrack}`);
}

// --- Sub-test 7: no-op (Δphase = 0) → no motion -----------------------
// At track 18: phase=2. Write same phase 2. Δ=0 — no motion.
{
  const head = makeHead(18);
  step(head, true, 2);
  check("same phase (Δ=0) — no motion",
        head.currentTrack === 18 && head.currentHalfTrack === 36,
        `currentHalfTrack=${head.currentHalfTrack}`);
}

// --- Sub-test 8: track-0 mechanical stop (vice-1541-arch §7.3) ------
// 1541 head physically halts. Our HeadPosition stops at trackHalf=2.
{
  const head = makeHead(1);     // trackHalf = 2
  // Try to step OUT below trackHalf=2 by writing phase = (-1) mod 4 phase
  // sequence: at trackHalf=2, (2-2)&3 = 0. Write 3 → (3-0)&3 = 3 → -1.
  step(head, true, 3);
  check("track-1 stop — head halts at trackHalf=2",
        head.currentHalfTrack === 2 && head.currentTrack === 1,
        `currentHalfTrack=${head.currentHalfTrack}`);
}

// --- Sub-test 9: 1 half-track IN + OUT round-trip from track 18 ------
// Required by spec 411 acceptance: "step head 1 half-track in + out".
{
  const head = makeHead(18);
  step(head, true, 3);  // IN: 18 → 18.5
  check("round-trip IN: track 18.5", head.currentTrack === 18.5,
        `currentTrack=${head.currentTrack}`);
  // Now at trackHalf=37, phase=(37-2)&3=35&3=3. To step OUT: need Δ=-1.
  // (next - 3) & 3 = 3 → next = 2.
  step(head, true, 2);
  check("round-trip OUT: track 18 (returned)", head.currentTrack === 18,
        `currentTrack=${head.currentTrack}`);
}

// --- Report ----------------------------------------------------------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`Spec 411 smoke A — VIA2 stepper modulo-4 phase counts — ${pass}/${results.length} pass, ${fail} fail`);
for (const r of results) {
  if (!r.pass) console.log(`  [FAIL] ${r.label}: ${r.detail}`);
}
if (fail > 0) process.exit(1);
