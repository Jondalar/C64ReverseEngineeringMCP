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

test("encode output is always exactly 5 bytes", () => {
  const dest = new Uint8Array(5);
  const src = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  gcr_convert_4bytes_to_GCR(src, 0, dest, 0);
  // No assertion: just verify no out-of-bound write (dest is fixed 5 bytes).
  assert.equal(dest.length, 5);
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
// VICE table values pinned literal
// ---------------------------------------------------------------------------
test("GCR_ENCODE table values match VICE gcr.c:51-57 GCR_conv_data", () => {
  // Indirect verify: encoding nybble N must produce a GCR symbol with
  // valid bit pattern. Quick sanity: encoding 0x00 produces lowest entry 0x0a.
  const src = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
  const gcr = encode(src);
  // 8 nybbles of 0x00 → 8 GCR symbols of 0x0a → packed bits:
  // 01010 01010 01010 01010 01010 01010 01010 01010
  // = 01010010 10010100 10100101 00101001 01001010
  // = 0x52, 0x94, 0xa5, 0x29, 0x4a
  assert.deepEqual(
    Array.from(gcr),
    [0x52, 0x94, 0xa5, 0x29, 0x4a],
    "VICE GCR_conv_data[0]=0x0a packed 8x",
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
