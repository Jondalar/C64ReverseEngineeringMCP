// Spec 447.5 — g64-parser.ts literal-VICE port unit tests.
//
// Pins:
//   - disk_image_raw_track_size_g64 returns hand-pinned VICE values
//     for tracks 1, 17, 18, 24, 25, 30, 31, 35
//   - disk_image_speed_map_g64 returns 0..3 for correct track ranges
//   - empty half-track (offset==0) returns 0x55-filled buffer of
//     canonical zone size (Fix #1)
//   - tracks beyond declared trackCount return zero-filled canonical
//     buffer (Fix #4 Option A)
//   - signature check rejects non-G64 bytes
//   - oversized trackCount throws

import { strict as assert } from "node:assert";
import {
  MAX_GCR_TRACKS,
  RAW_TRACK_SIZE_D64,
  disk_image_raw_track_size_g64,
  disk_image_speed_map_g64,
} from "../../../src/disk/disk-image-zones.ts";
import { G64Parser } from "../../../src/disk/g64-parser.ts";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// VICE diskimage.c:201-207 canonical pins.
const VICE_RAW_TRACK_SIZE: ReadonlyArray<readonly [string, number, number]> = [
  ["zone 3 (tracks 1-17)", RAW_TRACK_SIZE_D64[3], 7692],
  ["zone 2 (tracks 18-24)", RAW_TRACK_SIZE_D64[2], 7142],
  ["zone 1 (tracks 25-30)", RAW_TRACK_SIZE_D64[1], 6666],
  ["zone 0 (tracks 31+)", RAW_TRACK_SIZE_D64[0], 6250],
];

for (const [label, ts, vice] of VICE_RAW_TRACK_SIZE) {
  test(`RAW_TRACK_SIZE_D64 ${label} === ${vice} (VICE diskimage.c:201-207)`, () => {
    assert.equal(ts, vice);
  });
}

// VICE diskimage.c:82-94 1541 branch: (track<31) + (track<25) + (track<18).
// Hand-verified expected speed zone per track.
const VICE_SPEED_MAP: ReadonlyArray<readonly [number, number]> = [
  [1, 3], [10, 3], [17, 3],   // zone 3: tracks 1-17
  [18, 2], [20, 2], [24, 2],  // zone 2: tracks 18-24
  [25, 1], [27, 1], [30, 1],  // zone 1: tracks 25-30
  [31, 0], [35, 0], [40, 0],  // zone 0: tracks 31+
];

for (const [track, expectedZone] of VICE_SPEED_MAP) {
  test(`disk_image_speed_map_g64(track=${track}) === ${expectedZone}`, () => {
    assert.equal(disk_image_speed_map_g64(track), expectedZone);
  });
}

// VICE diskimage.c:241-264 — disk_image_raw_track_size for D64/G64.
const VICE_RAW_TRACK_PINS: ReadonlyArray<readonly [number, number]> = [
  [1, 7692], [17, 7692],
  [18, 7142], [24, 7142],
  [25, 6666], [30, 6666],
  [31, 6250], [35, 6250],
];

for (const [track, expectedBytes] of VICE_RAW_TRACK_PINS) {
  test(`disk_image_raw_track_size_g64(track=${track}) === ${expectedBytes} bytes (VICE)`, () => {
    assert.equal(disk_image_raw_track_size_g64(track), expectedBytes);
  });
}

// MAX_GCR_TRACKS constant.
test(`MAX_GCR_TRACKS === 168 (VICE gcr.h)`, () => {
  assert.equal(MAX_GCR_TRACKS, 168);
});

// Construct a synthetic minimal G64 to exercise the parser.
function buildSyntheticG64(opts: {
  trackCount: number;
  maxTrackSize: number;
  trackOffsets: number[];
  speedZoneOffsets: number[];
  trackBlobs: Map<number, Uint8Array>; // slotIndex → bytes
}): Uint8Array {
  const headerSize = 12 + opts.trackCount * 4 + opts.trackCount * 4;
  let imageSize = headerSize;
  for (const bytes of opts.trackBlobs.values()) {
    imageSize += 2 + bytes.length;
  }
  const out = new Uint8Array(imageSize);
  // Signature "GCR-1541\0"
  out.set([0x47, 0x43, 0x52, 0x2d, 0x31, 0x35, 0x34, 0x31, 0x00], 0);
  out[9] = opts.trackCount;
  out[10] = opts.maxTrackSize & 0xff;
  out[11] = (opts.maxTrackSize >> 8) & 0xff;

  for (let i = 0; i < opts.trackCount; i++) {
    const off = opts.trackOffsets[i] ?? 0;
    const pos = 12 + i * 4;
    out[pos] = off & 0xff;
    out[pos + 1] = (off >> 8) & 0xff;
    out[pos + 2] = (off >> 16) & 0xff;
    out[pos + 3] = (off >> 24) & 0xff;
  }
  for (let i = 0; i < opts.trackCount; i++) {
    const sz = opts.speedZoneOffsets[i] ?? 0;
    const pos = 12 + opts.trackCount * 4 + i * 4;
    out[pos] = sz & 0xff;
    out[pos + 1] = (sz >> 8) & 0xff;
    out[pos + 2] = (sz >> 16) & 0xff;
    out[pos + 3] = (sz >> 24) & 0xff;
  }

  for (const [slot, bytes] of opts.trackBlobs) {
    const off = opts.trackOffsets[slot]!;
    out[off] = bytes.length & 0xff;
    out[off + 1] = (bytes.length >> 8) & 0xff;
    out.set(bytes, off + 2);
  }

  return out;
}

test("Fix #1 — empty half-track (offset==0) returns 0x55-filled canonical buffer", () => {
  const trackCount = 4;
  const headerSize = 12 + trackCount * 4 + trackCount * 4;
  const realTrackLen = 100;
  // Layout: slot 0 = real data, slot 1 = empty (offset==0), slot 2/3 = empty
  const trackOffsets = [headerSize, 0, 0, 0];
  const speedZoneOffsets = [3, 3, 3, 3];
  const trackBlobs = new Map<number, Uint8Array>();
  const slot0Bytes = new Uint8Array(realTrackLen).fill(0xab);
  trackBlobs.set(0, slot0Bytes);
  const img = buildSyntheticG64({
    trackCount, maxTrackSize: 7928,
    trackOffsets, speedZoneOffsets, trackBlobs,
  });

  const p = new G64Parser(img);
  // Slot 1 is empty (offset==0) but within trackCount.
  // half_track = 1+2 = 3, whole_track = 3>>1 = 1 → zone 3 → 7692 bytes.
  const track1Half = p.getRawTrackBytes(1.5); // slot 1
  assert.ok(track1Half, "empty track should now return a buffer, not null");
  assert.equal(track1Half!.length, 7692, "canonical size for zone 3");
  for (let i = 0; i < track1Half!.length; i++) {
    if (track1Half![i] !== 0x55) {
      throw new Error(`empty track byte ${i} expected 0x55, got 0x${track1Half![i]!.toString(16)}`);
    }
  }
});

test("Fix #4 (Option A) — track beyond declared trackCount returns canonical zero-filled buffer", () => {
  const trackCount = 4;
  const headerSize = 12 + trackCount * 4 + trackCount * 4;
  const trackOffsets = [headerSize, 0, 0, 0];
  const speedZoneOffsets = [3, 3, 3, 3];
  const trackBlobs = new Map<number, Uint8Array>([[0, new Uint8Array(50).fill(0xab)]]);
  const img = buildSyntheticG64({
    trackCount, maxTrackSize: 7928,
    trackOffsets, speedZoneOffsets, trackBlobs,
  });
  const p = new G64Parser(img);

  // Track 35 → slot 68 → beyond trackCount=4 → zero-fill expected.
  const t35 = p.getRawTrackBytes(35);
  assert.ok(t35);
  assert.equal(t35!.length, 6250, "track 35 zone 0 canonical size");
  for (let i = 0; i < Math.min(64, t35!.length); i++) {
    if (t35![i] !== 0x00) {
      throw new Error(`out-of-range track byte ${i} expected 0x00, got 0x${t35![i]!.toString(16)}`);
    }
  }
});

test("signature check rejects non-G64 bytes", () => {
  const bad = new Uint8Array(20);
  bad.set([0x42, 0x41, 0x44], 0); // "BAD"
  assert.throws(() => new G64Parser(bad), /Invalid G64 signature/);
});

test("trackCount > MAX_GCR_TRACKS throws", () => {
  // Build minimal header with overflow trackCount.
  const img = new Uint8Array(12 + 169 * 8);
  img.set([0x47, 0x43, 0x52, 0x2d, 0x31, 0x35, 0x34, 0x31, 0x00], 0);
  img[9] = 169; // > 168
  img[10] = 0xe8; img[11] = 0x1e; // maxTrackSize=7912
  assert.throws(() => new G64Parser(img), /MAX_GCR_TRACKS/);
});

// ---------------------------------------------------------------------------
// Suite runner.
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ng64-parser-literal: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
