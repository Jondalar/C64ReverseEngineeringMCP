// Spec 153 / Sprint 114 — SyncDetector unit tests.
//
// Each assertion cites the VICE rotation.c line it exercises.
// Run via:
//   npx tsx tests/unit/drive/sync-detector.test.ts

import { strict as assert } from "node:assert";
import {
  SyncDetector,
  type SyncDetectorSnap,
} from "../../../src/runtime/headless/drive/sync-detector.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Push `n` identical bits into a fresh (or provided) detector. */
function pushBits(det: SyncDetector, bit: 0 | 1, count: number): void {
  for (let i = 0; i < count; i++) det.pushBit(bit);
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

// VICE rotation.c line 453: if (rptr->last_read_data == 0x3ff)
// 9 consecutive 1-bits must NOT assert sync (register = 0x1ff, not 0x3ff).
test("9 ones → no sync", () => {
  const det = new SyncDetector();
  pushBits(det, 1, 9);
  assert.equal(det.syncActive, false, "9 ones should not trigger sync");
  assert.equal(det.syncBit, 1, "SYNC# pin should be HIGH (inactive)");
});

// VICE rotation.c line 453: register == 0x3ff after 10 ones.
test("10 ones → sync active", () => {
  const det = new SyncDetector();
  pushBits(det, 1, 10);
  assert.equal(det.syncActive, true, "10 ones should trigger sync");
  assert.equal(det.syncBit, 0, "SYNC# pin should be LOW (active)");
});

// VICE rotation.c line 447: shift register clears LSB on each push.
// After 10 ones followed by one zero the register is 0x3fe (not 0x3ff).
test("10 ones then 1 zero → no sync", () => {
  const det = new SyncDetector();
  pushBits(det, 1, 10);
  assert.equal(det.syncActive, true, "should be in sync before the zero");
  det.pushBit(0);
  assert.equal(det.syncActive, false, "sync must deassert after a 0 bit");
  assert.equal(det.syncBit, 1, "SYNC# pin must return HIGH");
});

// Sustained sync: 100 ones in a row. The register saturates at 0x3ff after
// 10 bits and stays there. VICE behaviour: each new '1' keeps 0x3ff.
// VICE rotation.c line 447: ((0x3ff << 1) & 0x3fe) | 1 == 0x3ff.
test("100 ones → still sync active", () => {
  const det = new SyncDetector();
  pushBits(det, 1, 100);
  assert.equal(det.syncActive, true, "sync must remain active over 100 ones");
  assert.equal(det.syncBit, 0);
});

// After a zero breaks sync, 10 more ones are required to re-assert.
// Mirrors gcr_find_sync (gcr.c lines 183-187) which resets the window on 0.
test("10 ones, 1 zero, 9 ones → no sync; then 1 more one → sync again", () => {
  const det = new SyncDetector();
  pushBits(det, 1, 10);
  det.pushBit(0);           // breaks sync
  pushBits(det, 1, 9);     // 9 more — not enough
  assert.equal(det.syncActive, false, "9 ones after break: still no sync");
  det.pushBit(1);           // 10th one
  assert.equal(det.syncActive, true, "10 ones after break: sync re-asserts");
});

// reset() must zero internal state unconditionally.
// Mirrors VICE rotation_reset() zeroing last_read_data (rotation.c line 118).
test("reset clears state mid-sync", () => {
  const det = new SyncDetector();
  pushBits(det, 1, 10);
  assert.equal(det.syncActive, true);
  det.reset();
  assert.equal(det.syncActive, false, "sync must be false after reset");
  assert.equal(det.syncBit, 1, "SYNC# must be HIGH after reset");
});

test("reset on idle detector is idempotent", () => {
  const det = new SyncDetector();
  det.reset();
  det.reset();
  assert.equal(det.syncActive, false);
});

// snapshot / restore round-trip — no sync state.
test("snapshot round-trip: idle (0 ones)", () => {
  const det = new SyncDetector();
  const snap: SyncDetectorSnap = det.snapshot();
  assert.equal(snap.onesCount, 0);
  assert.equal(snap.syncActive, false);

  const det2 = new SyncDetector();
  det2.restore(snap);
  assert.equal(det2.syncActive, false);
  assert.equal(det2.syncBit, 1);
});

// snapshot / restore round-trip — partial run (5 ones, no sync).
test("snapshot round-trip: partial run (5 ones)", () => {
  const det = new SyncDetector();
  pushBits(det, 1, 5);
  const snap = det.snapshot();
  assert.equal(snap.onesCount, 5);
  assert.equal(snap.syncActive, false);

  const det2 = new SyncDetector();
  det2.restore(snap);
  assert.equal(det2.syncActive, false);
  // After restore with 5 ones, we need 5 more to reach sync.
  pushBits(det2, 1, 4);
  assert.equal(det2.syncActive, false, "4 more ones: still no sync");
  det2.pushBit(1);
  assert.equal(det2.syncActive, true, "5 more ones: sync reached");
});

// snapshot / restore round-trip — active sync.
test("snapshot round-trip: sync active", () => {
  const det = new SyncDetector();
  pushBits(det, 1, 10);
  const snap = det.snapshot();
  assert.equal(snap.onesCount, 10);
  assert.equal(snap.syncActive, true);

  const det2 = new SyncDetector();
  det2.restore(snap);
  assert.equal(det2.syncActive, true, "restored detector must be in sync");
  assert.equal(det2.syncBit, 0);
  // One more 1 should keep it in sync.
  det2.pushBit(1);
  assert.equal(det2.syncActive, true);
  // One 0 should break it.
  det2.pushBit(0);
  assert.equal(det2.syncActive, false);
});

// syncBit active-LOW convention sanity check.
test("syncBit is 0 when sync active, 1 when not", () => {
  const det = new SyncDetector();
  assert.equal(det.syncBit, 1);
  pushBits(det, 1, 10);
  assert.equal(det.syncBit, 0);
  det.pushBit(0);
  assert.equal(det.syncBit, 1);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try {
    c.run();
    pass++;
    console.log(`  PASS ${c.name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${c.name}: ${(e as Error).message}`);
  }
}
console.log(`\nsync-detector: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
