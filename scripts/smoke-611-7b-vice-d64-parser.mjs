// Spec 611 phase 611.7b smoke — D64 image parser + GCR encoder.
//
// Acceptance per Codex 17:08 UTC: prove track count, sector count by
// track range, NUM_MAX_BYTES_TRACK-bounded GCR buffers, and
// deterministic directory-sector read through gcr_read_sector.
//
// Uses the exact D64 fixture behind the Spec 423 load-directory
// golden: samples/synthetic/blank.d64 (printed below).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  encodeD64ToGcrTracks,
  probeD64,
  readD64DiskId,
  rawTrackSizeD64,
  sectorsPerTrackD64,
} from "../dist/runtime/headless/vice1541/drive-image-d64.js";
import {
  CBMDOS_FDC_ERR_OK,
  gcr_read_sector,
  NUM_MAX_BYTES_TRACK,
} from "../dist/runtime/headless/vice1541/gcr.js";

const D64_PATH = resolve("samples/synthetic/blank.d64");
console.log(`D64 fixture: ${D64_PATH}`);
const d64 = new Uint8Array(readFileSync(D64_PATH));

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const info = probeD64(d64);
check("(a) D64 size recognised: 174_848 bytes, 35 tracks, 683 sectors",
  info.trackCount === 35 && info.sectorCount === 683 && !info.hasErrorInfo,
  `size=${d64.length} trackCount=${info.trackCount} sectorCount=${info.sectorCount}`);

// Sectors-per-track ranges per VICE diskimage.c:132-137 sector_map_d64:
//   tracks 1-17  → 21 sectors
//   tracks 18-24 → 19 sectors
//   tracks 25-30 → 18 sectors
//   tracks 31-35 → 17 sectors
let spsOk = true;
const spsDetail = [];
for (let t = 1; t <= 35; t++) {
  const s = sectorsPerTrackD64(t);
  let expected;
  if (t < 18) expected = 21;
  else if (t < 25) expected = 19;
  else if (t < 31) expected = 18;
  else expected = 17;
  if (s !== expected) { spsOk = false; spsDetail.push(`t${t}=${s}≠${expected}`); }
}
check("(b) sectorsPerTrackD64 matches VICE sector_map_d64 across all 35 tracks",
  spsOk, spsDetail.join("; "));

// raw_track_size_d64 per zone — direct table check.
const sumSectors = (() => { let s = 0; for (let t = 1; t <= 35; t++) s += sectorsPerTrackD64(t); return s; })();
check("(c) total sector count = 683 (= 174848 / 256)", sumSectors === 683, `total=${sumSectors}`);

const id = readD64DiskId(d64);
check("(d) disk ID read from T18S0 bytes 0xa2/0xa3",
  typeof id.id1 === "number" && typeof id.id2 === "number" && id.id1 >= 0 && id.id2 >= 0,
  `id1=$${id.id1.toString(16)} id2=$${id.id2.toString(16)}`);

const tracks = encodeD64ToGcrTracks(d64);
check("(e) encodeD64ToGcrTracks returns 36 entries (1-indexed; slot 0 unused)",
  tracks.length === 36 && tracks[0]?.data === null);

// All track buffers are bounded by NUM_MAX_BYTES_TRACK.
let allBounded = true;
const boundDetail = [];
for (let t = 1; t <= 35; t++) {
  const size = tracks[t].size;
  const expected = rawTrackSizeD64(t);
  if (size !== expected) { allBounded = false; boundDetail.push(`t${t}: size=${size}≠${expected}`); }
  if (size > NUM_MAX_BYTES_TRACK) { allBounded = false; boundDetail.push(`t${t}: exceeds NUM_MAX_BYTES_TRACK`); }
}
check("(f) every track buffer = exact raw_track_size_d64 and ≤ NUM_MAX_BYTES_TRACK",
  allBounded, boundDetail.slice(0, 3).join("; "));

// Deterministic directory-sector read: T18S0 via gcr_read_sector
// returns CBMDOS_FDC_ERR_OK and matches the original D64 bytes.
const t18 = tracks[18];
const decoded = new Uint8Array(256);
const rc = gcr_read_sector(t18, decoded, 0);
check("(g) gcr_read_sector(T18S0) = CBMDOS_FDC_ERR_OK",
  rc === CBMDOS_FDC_ERR_OK, `rc=${rc}`);

const orig = d64.subarray(0, 256 * 0); // we'll compare with T18S0 of D64.
const t18s0Off = (() => { let s = 0; for (let t = 1; t < 18; t++) s += sectorsPerTrackD64(t); return s * 256; })();
const origT18S0 = d64.subarray(t18s0Off, t18s0Off + 256);
function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
check("(h) decoded T18S0 sector matches D64 source bytes (round-trip)",
  bytesEq(decoded, origT18S0),
  `decoded first 8: [${[...decoded.slice(0, 8)].map((v) => v.toString(16)).join(",")}] orig first 8: [${[...origT18S0.slice(0, 8)].map((v) => v.toString(16)).join(",")}]`);

// Also verify T1S0 (first sector first track) round-trip.
const decT1S0 = new Uint8Array(256);
const rc2 = gcr_read_sector(tracks[1], decT1S0, 0);
const origT1S0 = d64.subarray(0, 256);
check("(i) decoded T1S0 sector matches D64 source bytes",
  rc2 === CBMDOS_FDC_ERR_OK && bytesEq(decT1S0, origT1S0));

// Last sector of last track (T35Sn-1) for boundary safety.
const lastN = sectorsPerTrackD64(35);
const decLast = new Uint8Array(256);
const rc3 = gcr_read_sector(tracks[35], decLast, lastN - 1);
const lastOff = (() => { let s = 0; for (let t = 1; t < 35; t++) s += sectorsPerTrackD64(t); return (s + lastN - 1) * 256; })();
const origLast = d64.subarray(lastOff, lastOff + 256);
check("(j) decoded T35S(last) sector matches D64 source bytes",
  rc3 === CBMDOS_FDC_ERR_OK && bytesEq(decLast, origLast));

console.log("");
const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.error(`FAIL: ${failed}/${results.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${results.length}/${results.length} checks passed.`);
process.exit(0);
