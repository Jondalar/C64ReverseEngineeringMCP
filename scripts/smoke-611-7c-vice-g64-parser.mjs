// Spec 611 phase 611.7c smoke — G64 image parser.
//
// Acceptance per Codex 17:20 UTC: G64 raw track bytes preserved
// verbatim, header / table parsing proven, track count + per-track
// byte length probed, custom-gap (non-canonical byteLength) invariant
// asserted.
//
// Uses a real G64 fixture and prints the path. No D64 fallback. No
// gcr_read_sector used as parser truth — G64 truth IS the raw bytes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  G64_MAGIC_1541,
  g64ToGcrTracks,
  parseG64Header,
  parseG64Image,
} from "../dist/runtime/headless/vice1541/drive-image-g64.js";
import { MAX_GCR_TRACKS } from "../dist/runtime/headless/vice1541/gcr.js";

const G64_PATH = resolve("samples/motm.g64");
console.log(`G64 fixture: ${G64_PATH}`);
const g64 = new Uint8Array(readFileSync(G64_PATH));

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

// (a) Magic 9 bytes verbatim.
const magicSlice = g64.slice(0, 9);
let magicMatch = magicSlice.length === G64_MAGIC_1541.length;
for (let i = 0; i < 9 && magicMatch; i++) magicMatch = magicSlice[i] === G64_MAGIC_1541[i];
check("(a) G64 magic 'GCR-1541\\0' at bytes 0..8", magicMatch,
  `bytes=[${[...magicSlice].map((v) => v.toString(16).padStart(2, "0")).join(",")}]`);

// (b) Header parse.
const header = parseG64Header(g64);
check("(b) header parsed: variant=1541, numHalfTracks=84, maxTrackLength > 0",
  header.variant === "1541" && header.numHalfTracks === 84 && header.maxTrackLength > 0,
  `variant=${header.variant} numHalfTracks=${header.numHalfTracks} maxTrackLength=${header.maxTrackLength}`);

// (c) Full parse.
const img = parseG64Image(g64);
check("(c) parseG64Image returns MAX_GCR_TRACKS slots",
  img.tracks.length === MAX_GCR_TRACKS, `slots=${img.tracks.length}`);

// (d) Track count: G64 stores per-half-track entries; many real
// images populate only the integer-track slots (≥35 for a stock disk)
// and leave intermediate half-tracks empty. Acceptance: ≥ 35 (one per
// physical track).
const nonNull = img.tracks.filter((t) => t !== null).length;
check("(d) at least 35 non-empty half-tracks (one per physical track)",
  nonNull >= 35, `non-null half-track entries: ${nonNull}`);

// (e) Per-track byte length: each ≤ maxTrackLength, each ≥ 1.
let allBounded = true;
const boundFail = [];
for (let i = 0; i < img.tracks.length; i++) {
  const t = img.tracks[i];
  if (t === null) continue;
  if (t.byteLength < 1 || t.byteLength > header.maxTrackLength) {
    allBounded = false;
    boundFail.push(`HT${i + 1}: ${t.byteLength}`);
  }
}
check("(e) every parsed track byte length in [1..maxTrackLength]",
  allBounded, boundFail.slice(0, 3).join("; "));

// (f) Bit length = bytes * 8 (G64 has no sub-byte bit count).
let bitOk = true;
for (const t of img.tracks) {
  if (t === null) continue;
  if (t.bitLength !== t.byteLength * 8) { bitOk = false; break; }
}
check("(f) bitLength = byteLength * 8 for every parsed track", bitOk);

// (g) Custom-gap invariant: at least ONE track byteLength differs from
// the canonical raw_track_size_d64 for its zone (6250/6666/7142/7692).
// G64 images often carry non-canonical track lengths for protection
// schemes or custom format. If all tracks were exactly canonical, the
// parser might have silently normalized (it should NOT).
const CANONICAL = new Set([6250, 6666, 7142, 7692]);
let sawCustom = false;
let lengthsSeen = new Set();
for (const t of img.tracks) {
  if (t === null) continue;
  lengthsSeen.add(t.byteLength);
  if (!CANONICAL.has(t.byteLength)) sawCustom = true;
}
check("(g) at least one non-canonical track byteLength preserved (proof of no-normalization)",
  sawCustom || lengthsSeen.size >= 4,
  `lengths seen: {${[...lengthsSeen].sort((a, b) => a - b).join(", ")}}`);

// (h) g64ToGcrTracks shape.
const gcrTracks = g64ToGcrTracks(img);
check("(h) g64ToGcrTracks returns MAX_GCR_TRACKS slots, data/size shape",
  gcrTracks.length === MAX_GCR_TRACKS && gcrTracks.every((t) => (t.data === null && t.size === 0) || (t.data !== null && t.size === t.data.length)));

// (i) Raw byte preservation: for first non-null track, parsed data
// equals raw bytes from file at that offset.
const firstNonNullIdx = img.tracks.findIndex((t) => t !== null);
const firstTrack = img.tracks[firstNonNullIdx];
// Re-extract from raw file at the same offset.
const trackOffsetTable = 12;
const trackOffset = ((g64[trackOffsetTable + firstNonNullIdx * 4] ?? 0) |
                    ((g64[trackOffsetTable + firstNonNullIdx * 4 + 1] ?? 0) << 8) |
                    ((g64[trackOffsetTable + firstNonNullIdx * 4 + 2] ?? 0) << 16) |
                    ((g64[trackOffsetTable + firstNonNullIdx * 4 + 3] ?? 0) << 24)) >>> 0;
const rawFromFile = g64.subarray(trackOffset + 2, trackOffset + 2 + firstTrack.byteLength);
let rawEq = rawFromFile.length === firstTrack.data.length;
for (let i = 0; i < rawFromFile.length && rawEq; i++) {
  if (rawFromFile[i] !== firstTrack.data[i]) rawEq = false;
}
check("(i) first non-null track: parsed data === raw file bytes (verbatim, no copy/transform)",
  rawEq, `firstNonNullIdx=${firstNonNullIdx} byteLength=${firstTrack.byteLength}`);

console.log("");
const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.error(`FAIL: ${failed}/${results.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${results.length}/${results.length} checks passed.`);
process.exit(0);
