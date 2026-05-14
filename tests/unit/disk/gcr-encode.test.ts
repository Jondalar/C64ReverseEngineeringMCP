// Spec 445 — gcr encode round-trip unit tests.
//
// Pins literal-VICE behavior for the encode side:
//   - gcr_convert_4bytes_to_GCR (gcr.c:68-86)
//   - GCR_ENCODE table (gcr.c:51-57 GCR_conv_data)
//   - Round-trip invariant: decode(encode(x)) == x for valid input.
//
// Run via:
//   npx tsx tests/unit/disk/gcr-encode.test.ts

import { strict as assert } from "node:assert";
import {
  gcr_convert_4bytes_to_GCR,
  decodeGCRGroup,
} from "../../../src/disk/gcr.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ---------------------------------------------------------------------------
// gcr_convert_4bytes_to_GCR round-trip
// ---------------------------------------------------------------------------

function encode(source: Uint8Array): Uint8Array {
  const dest = new Uint8Array(5);
  gcr_convert_4bytes_to_GCR(source, 0, dest, 0);
  return dest;
}

test("encode + decode of [0x00, 0x00, 0x00, 0x00] round-trips", () => {
  const src = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
  const gcr = encode(src);
  const decoded = decodeGCRGroup(gcr);
  assert.deepEqual(Array.from(decoded), Array.from(src));
});

test("encode + decode of [0xff, 0xff, 0xff, 0xff] round-trips", () => {
  const src = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  const gcr = encode(src);
  const decoded = decodeGCRGroup(gcr);
  assert.deepEqual(Array.from(decoded), Array.from(src));
});

test("encode + decode of [0x12, 0x34, 0x56, 0x78] round-trips", () => {
  const src = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
  const gcr = encode(src);
  const decoded = decodeGCRGroup(gcr);
  assert.deepEqual(Array.from(decoded), Array.from(src));
});

test("encode + decode of [0x07, 0x08, 0xaa, 0x55] (sector data block prefix) round-trips", () => {
  // 0x07 = data block id; 0x08 = header id in VICE's protocol.
  const src = new Uint8Array([0x07, 0x08, 0xaa, 0x55]);
  const gcr = encode(src);
  const decoded = decodeGCRGroup(gcr);
  assert.deepEqual(Array.from(decoded), Array.from(src));
});

test("encode writes 5 non-zero bytes for non-zero input", () => {
  // Phase 2a sweep: replaces dead-assertion `dest.length === 5`
  // (tautology). This verifies encode actually wrote to all 5
  // destination slots (sentinel survival check + non-zero output).
  const dest = new Uint8Array(5);   // pre-filled with 0
  const src = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  gcr_convert_4bytes_to_GCR(src, 0, dest, 0);
  // All-0xff input produces non-zero output across all 5 bytes
  // (VICE-pinned: [0xad, 0x6b, 0x5a, 0xd6, 0xb5]).
  for (let i = 0; i < 5; i++) {
    assert.ok(dest[i] !== 0, `dest[${i}] = 0 (encode failed to write)`);
  }
});

// Spec 445 Phase 2a sweep — offset-param coverage.
// Phase 2b's gcr_convert_sector_to_GCR iterates a 256-byte buffer in
// 4-byte chunks at non-zero offsets. Silent-regression risk if
// offsets aren't tested.
test("encode with non-zero source/dest offsets honors offsets", () => {
  const src = new Uint8Array(10);
  src.set([0xde, 0xad, 0xbe, 0xef], 4);  // payload at offset 4
  const dest = new Uint8Array(12);
  dest.fill(0xaa);                        // sentinel pattern
  gcr_convert_4bytes_to_GCR(src, 4, dest, 5);
  // Bytes outside [5..9] untouched (sentinel preserved).
  for (let i = 0; i < 5; i++) {
    assert.equal(dest[i], 0xaa, `dest[${i}] sentinel clobbered`);
  }
  for (let i = 10; i < 12; i++) {
    assert.equal(dest[i], 0xaa, `dest[${i}] sentinel clobbered`);
  }
  // Round-trip from dest offset 5 reproduces the input.
  const decoded = decodeGCRGroup(dest, 5);
  assert.deepEqual(Array.from(decoded), [0xde, 0xad, 0xbe, 0xef]);
});

test("encode all 65536 nybble pairs round-trip correctly", () => {
  // Exhaustively test all 16x16 = 256 nybble combinations across positions.
  // (Full 32-bit space too big; pick representative.)
  let failCount = 0;
  for (let hi = 0; hi <= 0xff; hi++) {
    for (let lo = 0; lo <= 0xff; lo++) {
      const src = new Uint8Array([hi, lo, hi ^ 0xff, lo ^ 0xff]);
      const gcr = encode(src);
      const decoded = decodeGCRGroup(gcr);
      for (let k = 0; k < 4; k++) {
        if (decoded[k] !== src[k]) {
          failCount++;
          if (failCount <= 3) {
            console.error(`    src=[${src.join(",")}] decoded=[${Array.from(decoded).join(",")}]`);
          }
        }
      }
    }
  }
  assert.equal(failCount, 0, `${failCount} byte mismatches across 65536 sources`);
});

// ---------------------------------------------------------------------------
// VICE-pinned outputs (computed BY HAND from gcr.c:51-57 GCR_conv_data
// table — NOT from running TS code; defends against bilateral
// encode/decode bug fail-mode where both sides silently agree on a
// non-VICE pattern).
// ---------------------------------------------------------------------------
test("encode [0x00, 0x00, 0x00, 0x00] pins VICE GCR_conv_data[0]=0x0a", () => {
  // 8 nybbles of 0x0 → 8 GCR symbols of 0x0a (= 0b01010).
  // 40-bit stream: 01010 × 8 = 01010_01010_01010_01010_01010_01010_01010_01010
  // Group 8-bit: 01010010 10010100 10100101 00101001 01001010
  // Hex:         0x52     0x94     0xa5     0x29     0x4a
  const src = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
  assert.deepEqual(
    Array.from(encode(src)),
    [0x52, 0x94, 0xa5, 0x29, 0x4a],
  );
});

test("encode [0xff, 0xff, 0xff, 0xff] pins VICE GCR_conv_data[0xf]=0x15", () => {
  // 8 nybbles of 0xf → 8 GCR symbols of 0x15 (= 0b10101).
  // 40-bit stream: 10101 × 8 = 10101_10101_10101_10101_10101_10101_10101_10101
  // Group 8-bit: 10101101 01101011 01011010 11010110 10110101
  // Hex:         0xad     0x6b     0x5a     0xd6     0xb5
  const src = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(
    Array.from(encode(src)),
    [0xad, 0x6b, 0x5a, 0xd6, 0xb5],
  );
});

test("encode [0x18, 0x18, 0x18, 0x18] pins VICE GCR_conv_data[1]=0x0b, [8]=0x09", () => {
  // Each 0x18 = nybbles (hi=1, lo=8). GCR_conv_data[1]=0x0b=0b01011;
  // GCR_conv_data[8]=0x09=0b01001.
  // Per byte: 01011 01001 (10 bits)
  // 40-bit stream: 0101101001 × 4
  //   = 0101101001_0101101001_0101101001_0101101001
  // Group 8-bit: 01011010 01010110 10010101 10100101 01101001
  // Hex:         0x5a     0x56     0x95     0xa5     0x69

  // Wait — recompute byte boundaries carefully from positions:
  //   chunk1 chars 1-10:  0101101001
  //   chunk2 chars 11-20: 0101101001
  //   chunk3 chars 21-30: 0101101001
  //   chunk4 chars 31-40: 0101101001
  //   byte0 chars 1-8:    01011010 = 0x5a
  //   byte1 chars 9-16:   01010110 = 0x56  (chars 9-10 from c1: 01; chars 11-16 from c2: 010110)
  //   byte2 chars 17-24:  10010101 = 0x95
  //   byte3 chars 25-32:  10100101 = 0xa5
  //   byte4 chars 33-40:  01101001 = 0x69
  const src = new Uint8Array([0x18, 0x18, 0x18, 0x18]);
  assert.deepEqual(
    Array.from(encode(src)),
    [0x5a, 0x56, 0x95, 0xa5, 0x69],
  );
});

test("encode [0x00, 0xff, 0x00, 0xff] pins alternating GCR symbols", () => {
  // byte 0 0x00: hi=0→0x0a, lo=0→0x0a. byte 1 0xff: hi=f→0x15, lo=f→0x15.
  // Per byte: byte0 → 01010 01010, byte1 → 10101 10101.
  // Stream: 0101001010 1010110101 0101001010 1010110101
  // Group 8-bit:
  //   byte0 chars 1-8:    01010010 = 0x52
  //   byte1 chars 9-16:   10101011 = 0xab  (chars 9-10: 10; chars 11-16 from c2: 101011)
  //   byte2 chars 17-24:  01010101 = 0x55
  //   byte3 chars 25-32:  00101010 = 0x2a
  //   byte4 chars 33-40:  10110101 = 0xb5
  const src = new Uint8Array([0x00, 0xff, 0x00, 0xff]);
  assert.deepEqual(
    Array.from(encode(src)),
    [0x52, 0xab, 0x55, 0x2a, 0xb5],
  );
});

// ---------------------------------------------------------------------------
// Suite runner
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ngcr-encode: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
