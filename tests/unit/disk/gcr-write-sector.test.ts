// Spec 445 Phase 2b — gcr_convert_sector_to_GCR + gcr_write_sector tests.
//
// Round-trip strategy: encode a full sector with VICE-compatible header
// + sync + gap + data layout via `gcr_convert_sector_to_GCR`, then
// decode it back with the (already audited) `gcr_read_sector`. Result
// must match the input data byte-for-byte.
//
// gcr_write_sector tests: write a known data buffer into a pre-encoded
// track (created via convert_sector_to_GCR), then read_sector returns
// the new data with correct checksum.
//
// Run via:
//   npx tsx tests/unit/disk/gcr-write-sector.test.ts

import { strict as assert } from "node:assert";
import {
  gcr_convert_sector_to_GCR,
  gcr_write_sector,
  gcr_read_sector_vice,
  makeDiskTrack,
  CBMDOS_FDC_ERR_OK,
  CBMDOS_FDC_ERR_HEADER,
  type gcr_header_t,
} from "../../../src/disk/gcr.js";

function readSector(raw: Uint8Array, sector: number): { status: string; payload?: Uint8Array } {
  const data = new Uint8Array(256);
  const err = gcr_read_sector_vice(makeDiskTrack(raw), data, sector);
  switch (err) {
    case CBMDOS_FDC_ERR_OK: return { status: "ok", payload: data };
    case 2: return { status: "header_not_found" };
    case 3: return { status: "sync_not_found" };
    case 4: return { status: "no_block" };
    case 5: return { status: "checksum_error" };
    default: return { status: `err${err}` };
  }
}

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// Standard 1541 GAP + SYNC sizes (VICE drive defaults).
const GAP_SIZE = 8;
const SYNC_SIZE = 5;

// Layout per sector: 5 (sync) + 5 (header GCR) + 5 (id GCR) + gap + sync + 5*65 (data block GCR)
// = 5 + 5 + 5 + 8 + 5 + 325 = 353 bytes.
const SECTOR_TRACK_BYTES = 5 + 5 + 5 + GAP_SIZE + SYNC_SIZE + 5 * 65;

// Build a single-sector track buffer. Pad with extra trailing bytes
// so wrap-around in gcr_find_sync has room.
function buildSectorTrack(buffer: Uint8Array, header: gcr_header_t): Uint8Array {
  // 1024 bytes total is plenty for a single sector with wrap-around margin.
  const raw = new Uint8Array(1024);
  raw.fill(0x55);  // sentinel pattern (will be overwritten)
  gcr_convert_sector_to_GCR(buffer, 0, raw, 0, header, GAP_SIZE, SYNC_SIZE, CBMDOS_FDC_ERR_OK);
  return raw;
}

function randomBuffer(seed: number): Uint8Array {
  const buf = new Uint8Array(256);
  let s = seed | 0;
  for (let i = 0; i < 256; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (s >>> 16) & 0xff;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// gcr_convert_sector_to_GCR — round-trip with gcr_read_sector
// ---------------------------------------------------------------------------

test("convert_sector_to_GCR + read_sector round-trips all-zero data", () => {
  const data = new Uint8Array(256);  // all 0x00
  const header: gcr_header_t = { sector: 0, track: 18, id1: 0x41, id2: 0x42 };
  const raw = buildSectorTrack(data, header);
  const result = readSector(raw, 0);
  assert.equal(result.status, "ok", `read status = ${result.status}`);
  assert.ok(result.payload, "payload undefined");
  assert.deepEqual(Array.from(result.payload!), Array.from(data));
});

test("convert_sector_to_GCR + read_sector round-trips all-0xff data", () => {
  const data = new Uint8Array(256);
  data.fill(0xff);
  const header: gcr_header_t = { sector: 1, track: 18, id1: 0x41, id2: 0x42 };
  const raw = buildSectorTrack(data, header);
  const result = readSector(raw, 1);
  assert.equal(result.status, "ok");
  assert.deepEqual(Array.from(result.payload!), Array.from(data));
});

test("convert_sector_to_GCR + read_sector round-trips random sector 5", () => {
  const data = randomBuffer(0xdeadbeef);
  const header: gcr_header_t = { sector: 5, track: 1, id1: 0x44, id2: 0x33 };
  const raw = buildSectorTrack(data, header);
  const result = readSector(raw, 5);
  assert.equal(result.status, "ok");
  assert.deepEqual(Array.from(result.payload!), Array.from(data));
});

test("convert_sector_to_GCR + read_sector round-trips counting pattern 0x00..0xff repeated", () => {
  const data = new Uint8Array(256);
  for (let i = 0; i < 256; i++) data[i] = i & 0xff;
  const header: gcr_header_t = { sector: 17, track: 35, id1: 0x11, id2: 0x22 };
  const raw = buildSectorTrack(data, header);
  const result = readSector(raw, 17);
  assert.equal(result.status, "ok");
  assert.deepEqual(Array.from(result.payload!), Array.from(data));
});

// ---------------------------------------------------------------------------
// gcr_write_sector — find sector, overwrite, read back
// ---------------------------------------------------------------------------

test("gcr_write_sector overwrites existing data; read_sector returns new bytes", () => {
  const original = randomBuffer(0x12345678);
  const header: gcr_header_t = { sector: 0, track: 18, id1: 0x41, id2: 0x42 };
  const raw = buildSectorTrack(original, header);

  const newData = randomBuffer(0x87654321);
  const result = gcr_write_sector(makeDiskTrack(raw), newData, 0);
  assert.equal(result, CBMDOS_FDC_ERR_OK, `write status = ${result}`);

  const read = readSector(raw, 0);
  assert.equal(read.status, "ok");
  assert.deepEqual(Array.from(read.payload!), Array.from(newData));
});

test("gcr_write_sector returns OK for valid sector with all-zero data", () => {
  const original = new Uint8Array(256);
  original.fill(0xaa);
  const header: gcr_header_t = { sector: 7, track: 18, id1: 0x41, id2: 0x42 };
  const raw = buildSectorTrack(original, header);

  const newData = new Uint8Array(256);  // all zero
  const result = gcr_write_sector(makeDiskTrack(raw), newData, 7);
  assert.equal(result, CBMDOS_FDC_ERR_OK);

  const read = readSector(raw, 7);
  assert.equal(read.status, "ok");
  assert.deepEqual(Array.from(read.payload!), Array.from(newData));
});

// Spec 445 Phase 2c — BUG fix verification: write_sector on a
// sync-less track must return CBMDOS_FDC_ERR_SYNC (= 3), not
// CBMDOS_FDC_ERR_HEADER (= 2). VICE gcr.c:294-346 distinguishes
// "no syncs at all" (return -3) from "syncs found, no matching
// sector" (return -2). Pre-fix, TS collapsed both to HEADER.
test("gcr_write_sector returns SYNC error on track with NO syncs (Phase 2c BUG fix)", () => {
  // All-zero track: no 10-consecutive-ones run → no syncs.
  const raw = new Uint8Array(1024);
  const data = new Uint8Array(256);
  // Use enum value 3 (CBMDOS_FDC_ERR_SYNC) directly to avoid import bloat.
  const result = gcr_write_sector(makeDiskTrack(raw), data, 0);
  assert.equal(result, 3, `expected CBMDOS_FDC_ERR_SYNC (3), got ${result}`);
});

test("gcr_read_sector_vice returns SYNC on sync-less track (Phase 2c BUG fix)", () => {
  const raw = new Uint8Array(1024);  // all zeros, no syncs
  const data = new Uint8Array(256);
  const result = gcr_read_sector_vice(makeDiskTrack(raw), data, 0);
  assert.equal(result, 3, "expected CBMDOS_FDC_ERR_SYNC");
});

// Symmetric Phase 2c BUG-fix test: pin HEADER vs SYNC distinction.
// Track HAS syncs (sector 0 exists), but caller asks for sector 42.
// VICE: gcr_find_sector_header returns -CBMDOS_FDC_ERR_HEADER (-2).
// Pre-Phase-2c-fix TS conflated both errors; post-fix distinguishes.
test("gcr_read_sector_vice returns HEADER (not SYNC) for syncs-present-but-no-match", () => {
  const data = new Uint8Array(256);
  const header: gcr_header_t = { sector: 0, track: 18, id1: 0x41, id2: 0x42 };
  const raw = buildSectorTrack(data, header);  // track HAS a sync (for sector 0)
  const out = new Uint8Array(256);
  const result = gcr_read_sector_vice(makeDiskTrack(raw), out, 42);
  assert.equal(result, 2, "expected CBMDOS_FDC_ERR_HEADER (2), not SYNC (3)");
});

test("gcr_write_sector returns HEADER error for non-existent sector", () => {
  // Build a track containing sector 0, then ask to write sector 42.
  const data = new Uint8Array(256);
  const header: gcr_header_t = { sector: 0, track: 18, id1: 0x41, id2: 0x42 };
  const raw = buildSectorTrack(data, header);

  const result = gcr_write_sector(makeDiskTrack(raw), data, 42);
  assert.equal(result, CBMDOS_FDC_ERR_HEADER);
});

test("gcr_write_sector preserves OTHER sectors when overwriting one", () => {
  // Multi-sector track: two sectors back-to-back.
  const data0 = randomBuffer(0xaaaa1111);
  const data1 = randomBuffer(0xbbbb2222);
  const header0: gcr_header_t = { sector: 0, track: 18, id1: 0x41, id2: 0x42 };
  const header1: gcr_header_t = { sector: 1, track: 18, id1: 0x41, id2: 0x42 };

  const raw = new Uint8Array(2048);
  raw.fill(0x55);
  gcr_convert_sector_to_GCR(data0, 0, raw, 0, header0, GAP_SIZE, SYNC_SIZE, CBMDOS_FDC_ERR_OK);
  gcr_convert_sector_to_GCR(data1, 0, raw, SECTOR_TRACK_BYTES, header1, GAP_SIZE, SYNC_SIZE, CBMDOS_FDC_ERR_OK);

  // Overwrite sector 1.
  const newData1 = randomBuffer(0xcccc3333);
  const result = gcr_write_sector(makeDiskTrack(raw), newData1, 1);
  assert.equal(result, CBMDOS_FDC_ERR_OK);

  // Sector 0 unchanged.
  const read0 = readSector(raw, 0);
  assert.equal(read0.status, "ok");
  assert.deepEqual(Array.from(read0.payload!), Array.from(data0));

  // Sector 1 = new data.
  const read1 = readSector(raw, 1);
  assert.equal(read1.status, "ok");
  assert.deepEqual(Array.from(read1.payload!), Array.from(newData1));
});

// ---------------------------------------------------------------------------
// Spec 445 Phase 2c — bilateral-bug defense
//
// 2 hand-computed VICE-pinned sector-encode outputs. Each computed
// BY HAND from VICE GCR_conv_data[16] table (gcr.c:51-57); NOT by
// running TS code. If TS encode and TS decode both agree on a
// non-VICE pattern, Phase 2b roundtrip tests still pass — these
// pin tests defend against that bilateral failure mode.
// ---------------------------------------------------------------------------

test("convert_sector_to_GCR pin: sector=0/track=0/id1=0/id2=0/data=zero", () => {
  // Hand-computed expected bytes [0..14]:
  //   [0..4]   = 0xff × 5  (sync block, error_code=OK)
  //   [5..9]   = header GCR encode([0x08, chksum=0, sector=0, track=0])
  //              chksum = 0 ^ 0 ^ 0 ^ 0 ^ 0 = 0
  //              nybbles: 0,8,0,0,0,0,0,0 → GCR_conv_data:
  //                       0x0a,0x09,0x0a,0x0a,0x0a,0x0a,0x0a,0x0a
  //              5-bit stream: 01010 01001 01010 01010 01010 01010 01010 01010
  //              packed 8-bit: 01010010 01010100 10100101 00101001 01001010
  //              hex:          0x52     0x54     0xa5     0x29     0x4a
  //   [10..14] = id GCR encode([id2=0, id1=0, 0x0f, 0x0f])
  //              nybbles: 0,0,0,0,0,f,0,f → 0x0a,0x0a,0x0a,0x0a,0x0a,0x15,0x0a,0x15
  //              5-bit: 01010 01010 01010 01010 01010 10101 01010 10101
  //              packed: 01010010 10010100 10100101 01010101 01010101
  //              hex:    0x52     0x94     0xa5     0x55     0x55
  const data = new Uint8Array(256);  // all zero
  const header: gcr_header_t = { sector: 0, track: 0, id1: 0, id2: 0 };
  const raw = new Uint8Array(1024);
  raw.fill(0);  // explicit zero; we assert exact byte values, no sentinel.
  gcr_convert_sector_to_GCR(data, 0, raw, 0, header, 0, 0, CBMDOS_FDC_ERR_OK);
  // Sync block (5 bytes, filled 0xff per error_code != ERR_SYNC).
  for (let i = 0; i < 5; i++) {
    assert.equal(raw[i], 0xff, `sync byte ${i}`);
  }
  // Header GCR (5 bytes).
  assert.deepEqual(
    Array.from(raw.slice(5, 10)),
    [0x52, 0x54, 0xa5, 0x29, 0x4a],
    "header GCR mismatch",
  );
  // ID GCR (5 bytes).
  assert.deepEqual(
    Array.from(raw.slice(10, 15)),
    [0x52, 0x94, 0xa5, 0x55, 0x55],
    "id GCR mismatch",
  );
});

test("convert_sector_to_GCR pin: sector=0/track=18/id1=0x41/id2=0x42", () => {
  // Hand-computed expected bytes [0..14]:
  //   [0..4]   = 0xff × 5
  //   [5..9]   = header GCR encode([0x08, chksum, sector=0, track=18])
  //              chksum = 0 ^ 18 ^ 0x42 ^ 0x41 ^ 0 = 0x12^0x42^0x41
  //                     = 0x50 ^ 0x41 = 0x11
  //              encode([0x08, 0x11, 0x00, 0x12]):
  //              nybbles: 0,8,1,1,0,0,1,2 → 0x0a,0x09,0x0b,0x0b,0x0a,0x0a,0x0b,0x12
  //              5-bit: 01010 01001 01011 01011 01010 01010 01011 10010
  //              packed: 01010010 01010110 10110101 00101001 01110010
  //              hex:    0x52     0x56     0xb5     0x29     0x72
  //   [10..14] = id GCR encode([id2=0x42, id1=0x41, 0x0f, 0x0f])
  //              nybbles: 4,2,4,1,0,f,0,f → 0x0e,0x12,0x0e,0x0b,0x0a,0x15,0x0a,0x15
  //              5-bit: 01110 10010 01110 01011 01010 10101 01010 10101
  //              packed: 01110100 10011100 10110101 01010101 01010101
  //              hex:    0x74     0x9c     0xb5     0x55     0x55
  const data = new Uint8Array(256);
  const header: gcr_header_t = { sector: 0, track: 18, id1: 0x41, id2: 0x42 };
  const raw = new Uint8Array(1024);
  raw.fill(0);
  gcr_convert_sector_to_GCR(data, 0, raw, 0, header, 0, 0, CBMDOS_FDC_ERR_OK);
  for (let i = 0; i < 5; i++) assert.equal(raw[i], 0xff, `sync byte ${i}`);
  assert.deepEqual(
    Array.from(raw.slice(5, 10)),
    [0x52, 0x56, 0xb5, 0x29, 0x72],
    "header GCR mismatch",
  );
  assert.deepEqual(
    Array.from(raw.slice(10, 15)),
    [0x74, 0x9c, 0xb5, 0x55, 0x55],
    "id GCR mismatch",
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
console.log(`\ngcr-write-sector: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
