// Spec 153 / Sprint 114 — GCR shifter unit tests.
//
// Covers gcr-shifter.ts (1:1 VICE drive/rotation.c port):
//   - density-zone bit-period (4 zones, cycles-per-byte ×8 fixed point)
//   - byte-ready callback fires every 8 non-sync bits
//   - SYNC detect via 10× '1' bits (rotation.c L1052 / gcr.c L184)
//   - motor gate (rotation.c L1108 BRA_MOTOR_ON)
//   - density override change mid-track
//   - snapshot round-trip
//
// Run via:
//   npx tsx tests/unit/drive/gcr-shifter.test.ts

import { strict as assert } from "node:assert";
import {
  GcrShifter,
  cyclesPerByteForZone,
  zoneForTrack,
} from "../../../src/runtime/headless/drive/gcr-shifter.js";
import { HeadPosition } from "../../../src/runtime/headless/drive/head-position.js";
import type { G64Parser } from "../../../src/disk/g64-parser.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ---------------------------------------------------------------------------
// Stub G64Parser — feeds a deterministic byte stream per track.
// ---------------------------------------------------------------------------

function fakeParser(bytesByTrack: Map<number, Uint8Array>): G64Parser {
  return {
    getRawTrackBytes(trackNum: number): Uint8Array | null {
      return bytesByTrack.get(trackNum) ?? null;
    },
  } as unknown as G64Parser;
}

function shifterOnTrack(
  trackNum: number,
  data: Uint8Array,
  hooks: {
    onByte?: (b: number) => void;
    onSync?: (active: boolean) => void;
  } = {},
): { sh: GcrShifter; head: HeadPosition } {
  const parser = fakeParser(new Map([[trackNum, data]]));
  const head = new HeadPosition({ startTrack: trackNum });
  const sh = new GcrShifter({
    parser,
    headPosition: head,
    onByteReady: hooks.onByte,
    onSyncDetected: hooks.onSync,
  });
  return { sh, head };
}

// ---------------------------------------------------------------------------
// Zone tables (sanity)
// ---------------------------------------------------------------------------

// VICE rot_speed_bps[0] zones map: 0=250000bps (32 cyc/byte) … 3=307692bps (26).
test("cyclesPerByteForZone returns VICE-equivalent table", () => {
  assert.equal(cyclesPerByteForZone(0), 32);
  assert.equal(cyclesPerByteForZone(1), 30);
  assert.equal(cyclesPerByteForZone(2), 28);
  assert.equal(cyclesPerByteForZone(3), 26);
});

// 1541 standard layout: tracks 1-17 = z3, 18-24 = z2, 25-30 = z1, 31-35 = z0.
test("zoneForTrack maps track ranges per 1541 layout", () => {
  assert.equal(zoneForTrack(1), 3);
  assert.equal(zoneForTrack(17), 3);
  assert.equal(zoneForTrack(18), 2);
  assert.equal(zoneForTrack(24), 2);
  assert.equal(zoneForTrack(25), 1);
  assert.equal(zoneForTrack(30), 1);
  assert.equal(zoneForTrack(31), 0);
  assert.equal(zoneForTrack(35), 0);
});

// ---------------------------------------------------------------------------
// Bit-period (4 zones)
// ---------------------------------------------------------------------------

// One bit = cyclesPerByte / 8 drive cycles. Verify pulled-bit count
// after exact tick budgets per zone. Track 18 (z2 = 28 cyc/byte → 3.5
// cyc/bit). Track 31 (z0 = 32 cyc/byte → 4 cyc/bit). Use density
// override so we can test all zones on one track.
test("bit-period 4 zones — bit count after N drive cycles matches zone", () => {
  // 4096 bytes of zeros → 32768 bits available.
  const data = new Uint8Array(4096);
  const { sh } = shifterOnTrack(18, data);

  // Z0: 32 cyc/byte = 4 cyc/bit. Tick 320 cycles → 80 bits.
  sh.setDensity(0);
  sh.tick(320);
  assert.equal(sh.cursorBitOffset, 80);

  // Reset for clean count by binding a fresh shifter per zone.
  for (const [zone, expectedBits] of [
    [1, 320 * 8 / 30], // 30 cyc/byte → 320*8/30 = 85.333 → 85 (integer)
    [2, 320 * 8 / 28], // 28 → 91.428 → 91
    [3, 320 * 8 / 26], // 26 → 98.46 → 98
  ] as Array<[0 | 1 | 2 | 3, number]>) {
    const { sh: s2 } = shifterOnTrack(18, data);
    s2.setDensity(zone);
    s2.tick(320);
    assert.equal(
      s2.cursorBitOffset,
      Math.floor(expectedBits),
      `zone ${zone}: expected ~${expectedBits} bits`,
    );
  }
});

// ---------------------------------------------------------------------------
// Byte-ready timing
// ---------------------------------------------------------------------------

// Z0 = 32 cyc/byte: byte-ready fires once per 32 cycles when the
// bit pattern doesn't trip SYNC. We use 0x55 (alternating 01010101)
// — never 10 consecutive 1s.
test("byte-ready fires every 8 non-sync bits (zone 0 → 32 drive cycles)", () => {
  const data = new Uint8Array(256).fill(0x55);
  const events: number[] = [];
  const { sh } = shifterOnTrack(18, data, { onByte: (b) => events.push(b) });
  sh.setDensity(0);

  // First byte ready after 32 cycles. We tick 32×4 = 128 cycles
  // → expect exactly 4 byte-ready events (one per 8 bits).
  sh.tick(32 * 4);
  assert.equal(events.length, 4, `expected 4 events, got ${events.length}`);
  // Latched byte should be 0x55 (we're feeding $55 stream in MSB
  // alignment, byte-aligned cursor).
  for (const b of events) assert.equal(b, 0x55);
  assert.equal(sh.dataByte, 0x55);
});

// Pre-byte: only 7 bits in → no event yet.
test("byte-ready does NOT fire before 8 bits accumulated", () => {
  const data = new Uint8Array(256).fill(0x55);
  const events: number[] = [];
  const { sh } = shifterOnTrack(18, data, { onByte: (b) => events.push(b) });
  sh.setDensity(0);
  // 7 bits at 4 cyc/bit = 28 cycles.
  sh.tick(28);
  assert.equal(events.length, 0);
  // 1 more bit → 4 cycles → event.
  sh.tick(4);
  assert.equal(events.length, 1);
});

// ---------------------------------------------------------------------------
// Motor off
// ---------------------------------------------------------------------------

// VICE rotation.c L1108 BRA_MOTOR_ON gate: motor off → no rotation.
test("motor off → tick is no-op (no bit advance, no byte-ready)", () => {
  const data = new Uint8Array(256).fill(0x55);
  const events: number[] = [];
  const { sh } = shifterOnTrack(18, data, { onByte: (b) => events.push(b) });
  sh.setDensity(0);
  sh.setMotor(false);
  sh.tick(1000);
  assert.equal(sh.cursorBitOffset, 0);
  assert.equal(events.length, 0);
});

// Motor toggles back on → rotation resumes from current state.
test("motor on after off resumes rotation", () => {
  const data = new Uint8Array(256).fill(0x55);
  const events: number[] = [];
  const { sh } = shifterOnTrack(18, data, { onByte: (b) => events.push(b) });
  sh.setDensity(0);
  sh.setMotor(false);
  sh.tick(1000);
  sh.setMotor(true);
  sh.tick(32);
  assert.equal(events.length, 1);
});

// ---------------------------------------------------------------------------
// SYNC detect (10× '1' bits)
// ---------------------------------------------------------------------------

// VICE gcr.c L184: sync = (last_read_data == 0x3ff). 10 ones in a
// row. A sequence of 0xFF bytes feeds 8 ones each → after the 2nd
// $FF byte we have ≥10 ones → sync.
test("sync detected after 10 consecutive '1' bits ($FF stream)", () => {
  const data = new Uint8Array(256).fill(0xff);
  const syncEvents: boolean[] = [];
  const { sh } = shifterOnTrack(
    18,
    data,
    { onSync: (a) => syncEvents.push(a) },
  );
  sh.setDensity(0); // 4 cyc/bit
  // 10 bits → 40 cycles. After bit #10 sync should fire.
  sh.tick(40);
  assert.equal(sh.isSyncActive, true, "sync should be active after 10 ones");
  assert.equal(sh.syncBit, 0, "VIA2 PB7 = 0 when sync (active LOW)");
  assert.deepEqual(syncEvents, [true]);
});

// Once sync drops (a 0 bit clocked in) syncBit returns to 1.
test("sync drops on first 0 bit after sync — emits falling edge", () => {
  // 4 bytes of $FF then $7F → 32 ones, then a 0 bit.
  const data = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x7f, 0xff]);
  const syncEvents: boolean[] = [];
  const { sh } = shifterOnTrack(
    18,
    data,
    { onSync: (a) => syncEvents.push(a) },
  );
  sh.setDensity(0);
  // 33 bits worth of cycles to ensure the 0 bit is clocked in.
  sh.tick(33 * 4);
  assert.equal(sh.isSyncActive, false);
  assert.equal(sh.syncBit, 1);
  // Should have seen at least one true and one false.
  assert.ok(syncEvents.includes(true));
  assert.ok(syncEvents.includes(false));
});

// During sync, byte-ready is suppressed (bit_counter held at 0 — VICE
// rotation.c L1052: "is sync? reset bit counter, don't move data").
//
// All-$FF stream: first 8 ones clock in → first byte ($FF) latches
// before the 10-ones window can form (VICE simple-path mirror — see
// rotation.c L1052-1063 ordering: bit_counter increment + byte latch
// happen for bits 1..8, sync only kicks in once bits 9-10 are also
// 1).  After that single byte sync activates and no further bytes
// latch for the rest of the all-ones stream.
test("byte-ready suppressed during sustained sync window", () => {
  const data = new Uint8Array(256).fill(0xff);
  const events: number[] = [];
  const { sh } = shifterOnTrack(18, data, { onByte: (b) => events.push(b) });
  sh.setDensity(0);
  // Plenty of cycles — first byte latches at bit#8, remainder are sync.
  sh.tick(100 * 4);
  assert.equal(events.length, 1, `expected exactly 1 byte before sync clamp; got ${events.length}`);
  assert.equal(events[0], 0xff);
  assert.equal(sh.isSyncActive, true);
});

// ---------------------------------------------------------------------------
// Density change mid-track
// ---------------------------------------------------------------------------

test("density change mid-tick takes effect on next bit", () => {
  const data = new Uint8Array(256).fill(0x55);
  const { sh } = shifterOnTrack(18, data);
  sh.setDensity(0); // 4 cyc/bit
  sh.tick(32);     // 8 bits
  const before = sh.cursorBitOffset;
  assert.equal(before, 8);
  sh.setDensity(3); // 26 cyc/byte → 3.25 cyc/bit
  // 26 cycles in zone 3 = exactly 8 more bits.
  sh.tick(26);
  assert.equal(sh.cursorBitOffset, before + 8);
});

// ---------------------------------------------------------------------------
// Snapshot round-trip
// ---------------------------------------------------------------------------

test("snapshot round-trip preserves observable state", () => {
  const data = new Uint8Array(256).fill(0x55);
  const { sh: a } = shifterOnTrack(18, data);
  a.setDensity(0);
  a.tick(32 * 5 + 7); // partial — leaves bit_counter mid-byte
  const snap = a.snapshot();
  const before = a.dataByte;
  const beforeOffset = a.cursorBitOffset;
  const beforeBits = a.bitsSinceByte;

  // Build a fresh shifter, restore, advance both — must stay in step.
  const { sh: b } = shifterOnTrack(18, data);
  b.restore(snap);
  assert.equal(b.dataByte, before);
  assert.equal(b.cursorBitOffset, beforeOffset);
  assert.equal(b.bitsSinceByte, beforeBits);
  assert.equal(b.syncBit, a.syncBit);

  a.tick(64);
  b.tick(64);
  assert.equal(b.cursorBitOffset, a.cursorBitOffset);
  assert.equal(b.dataByte, a.dataByte);
  assert.equal(b.bitsSinceByte, a.bitsSinceByte);
});

// ---------------------------------------------------------------------------
// Track-rebind on head move
// ---------------------------------------------------------------------------

test("head-track change rebinds shifter cursor (resets bit offset)", () => {
  const dataA = new Uint8Array(256).fill(0x55);
  const dataB = new Uint8Array(256).fill(0xaa);
  const parser = fakeParser(new Map([[18, dataA], [19, dataB]]));
  const head = new HeadPosition({ startTrack: 18 });
  const sh = new GcrShifter({ parser, headPosition: head });
  sh.setDensity(0);
  sh.tick(32 * 3); // advance 3 bytes on track 18
  assert.ok(sh.cursorBitOffset > 0);
  // Step head two half-tracks → track 19.
  head.stepInward();
  head.stepInward();
  assert.equal(head.currentTrack, 19);
  sh.tick(32); // 1 byte on track 19
  // Cursor was reset on rebind, then advanced 8 bits.
  assert.equal(sh.cursorBitOffset, 8);
});

// ---- runner --------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ngcr-shifter: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
