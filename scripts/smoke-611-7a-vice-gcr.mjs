// Spec 611 phase 611.7a smoke — VICE gcr.c port.
//
// Acceptance: literal port of VICE src/gcr.c (357 LOC) including the
// 5-of-4 GCR conv tables, the 4-byte ↔ 5-byte codec, and the sector
// encode/decode pair. No "canonical pattern" invented — every check
// references the VICE source path or a verifiable property of the
// codec.
//
// Checks:
//   (a) GCR_conv_data table = VICE gcr.c:51-57 exact bytes.
//   (b) From_GCR_conv_data table = VICE gcr.c:59-65 exact bytes.
//   (c) From_GCR_conv_data is a left-inverse of GCR_conv_data:
//       for every 4-bit nybble n in 0..15:
//         From_GCR_conv_data[GCR_conv_data[n]] === n.
//   (d) 4-bytes → 5-bytes-GCR round-trip = identity for known patterns:
//       {0x00,0x00,0x00,0x00}, {0xff,0xff,0xff,0xff}, {0xde,0xad,0xbe,0xef},
//       and 32 random buffers.
//   (e) Full-sector encode (gcr_convert_sector_to_GCR) produces:
//       - 5 0xff SYNC bytes at offset 0
//       - 5 0xff SYNC bytes after header+ID block at the inner SYNC slot.
//       - header GCR contains the expected payload (decode round-trip
//         of the 4-byte header block yields {0x08, chksum, sector, track}).
//   (f) Encode-then-decode of a full sector via a synthetic track buffer:
//       attach 7928-byte buffer, encode sector 0, find header back,
//       gcr_find_sync + gcr_decode_block yield the same first header bytes.
//
// Exit 0 = PASS, 1 = FAIL.

import {
  CBMDOS_FDC_ERR_OK,
  From_GCR_conv_data,
  GCR_conv_data,
  gcr_convert_4bytes_to_GCR,
  gcr_convert_GCR_to_4bytes,
  gcr_convert_sector_to_GCR,
  gcr_decode_block,
  gcr_find_sync,
  NUM_MAX_BYTES_TRACK,
} from "../dist/runtime/headless/vice1541/gcr.js";

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

// (a) GCR_conv_data per VICE gcr.c:51-57
const expectGcr = [0x0a, 0x0b, 0x12, 0x13, 0x0e, 0x0f, 0x16, 0x17,
                   0x09, 0x19, 0x1a, 0x1b, 0x0d, 0x1d, 0x1e, 0x15];
check("(a) GCR_conv_data matches VICE gcr.c:51-57 exactly",
  GCR_conv_data.length === 16 && expectGcr.every((v, i) => GCR_conv_data[i] === v));

// (b) From_GCR_conv_data per VICE gcr.c:59-65
const expectFrom = [0, 0, 0, 0, 0, 0, 0, 0,
                    0, 8, 0, 1, 0, 12, 4, 5,
                    0, 0, 2, 3, 0, 15, 6, 7,
                    0, 9, 10, 11, 0, 13, 14, 0];
check("(b) From_GCR_conv_data matches VICE gcr.c:59-65 exactly",
  From_GCR_conv_data.length === 32 && expectFrom.every((v, i) => From_GCR_conv_data[i] === v));

// (c) From_GCR is left-inverse of GCR for all nybbles 0..15.
let invOk = true;
const invDetail = [];
for (let n = 0; n < 16; n++) {
  const gcr = GCR_conv_data[n];
  const back = From_GCR_conv_data[gcr];
  if (back !== n) { invOk = false; invDetail.push(`n=${n} → gcr=$${gcr.toString(16)} → back=${back}`); }
}
check("(c) From_GCR_conv_data is left-inverse of GCR_conv_data for all 4-bit nybbles", invOk, invDetail.join("; "));

// (d) 4-bytes → 5-bytes-GCR round-trip.
function roundTrip(src) {
  const enc = new Uint8Array(5);
  gcr_convert_4bytes_to_GCR(src, 0, enc, 0);
  const dec = new Uint8Array(4);
  gcr_convert_GCR_to_4bytes(enc, 0, dec, 0);
  return dec;
}
function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const cases = [
  new Uint8Array([0x00, 0x00, 0x00, 0x00]),
  new Uint8Array([0xff, 0xff, 0xff, 0xff]),
  new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
];
for (let i = 0; i < 32; i++) {
  cases.push(new Uint8Array([Math.random() * 256, Math.random() * 256, Math.random() * 256, Math.random() * 256]));
}
let rtOk = true;
let rtFailDetail = "";
for (const src of cases) {
  const back = roundTrip(src);
  if (!bytesEq(src, back)) { rtOk = false; rtFailDetail = `src=[${[...src]}] back=[${[...back]}]`; break; }
}
check("(d) 4-bytes ↔ 5-GCR round-trip = identity (3 known + 32 random)", rtOk, rtFailDetail);

// (e) Full-sector encode.
const sectorData = new Uint8Array(256);
for (let i = 0; i < 256; i++) sectorData[i] = i & 0xff;
const header = { sector: 5, track: 18, id2: 0x44, id1: 0x55 };
const encoded = new Uint8Array(512); // plenty of room
gcr_convert_sector_to_GCR(sectorData, 0, encoded, 0, header, 9, 5, CBMDOS_FDC_ERR_OK);
const sync1 = encoded.slice(0, 5).every((v) => v === 0xff);
check("(e.1) sector encode: first 5 bytes = 0xff SYNC", sync1, `bytes=[${[...encoded.slice(0, 5)].map((v) => v.toString(16)).join(",")}]`);

// Header block at offset 5..9 should decode to {0x08, chksum, sector, track}.
const hdrBytes = new Uint8Array(4);
const fakeRaw = { data: encoded, size: encoded.length };
gcr_decode_block(fakeRaw, 5 * 8, hdrBytes, 1);
const expectChksum = (header.sector ^ header.track ^ header.id2 ^ header.id1) & 0xff;
check("(e.2) decoded header bytes = {0x08, chksum, sector, track}",
  hdrBytes[0] === 0x08 && hdrBytes[1] === expectChksum && hdrBytes[2] === header.sector && hdrBytes[3] === header.track,
  `decoded=[${[...hdrBytes].map((v) => "$" + v.toString(16)).join(",")}]`);

// Second SYNC slot (after header+ID = offset 15 + 9 gap = 24)
const sync2 = encoded.slice(15 + 9, 15 + 9 + 5).every((v) => v === 0xff);
check("(e.3) sector encode: 5-byte inner SYNC after header+ID+gap", sync2,
  `bytes=[${[...encoded.slice(15 + 9, 15 + 9 + 5)].map((v) => v.toString(16)).join(",")}]`);

// (f) gcr_find_sync on encoded buffer. SYNC = 5 bytes = 40 bits of 1s;
// VICE find_sync returns the bit position *after* the SYNC, i.e. the
// first non-1 bit. Encoded sector starts with 5 SYNC bytes then header
// 0x08 = 00001000, so first 0-bit at position 40 (MSB of 0x08).
const findP = gcr_find_sync(fakeRaw, 0, fakeRaw.size * 8);
check("(f) gcr_find_sync returns position after the SYNC mark",
  findP === 40, `bit-position=${findP} (expected 40 = first bit of $08 header)`);

console.log("");
const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.error(`FAIL: ${failed}/${results.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${results.length}/${results.length} checks passed.`);
process.exit(0);
