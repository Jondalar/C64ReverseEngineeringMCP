#!/usr/bin/env node
/**
 * Spec 616 T616.1 — Load-fidelity D64 fixture generator.
 *
 * Emits 9 D64 files into samples/fixtures/load-fidelity/.
 * Each contains one PRG named TEST with pseudo-random body seeded by
 * total payload size (reproducible LCG).
 *
 * Usage:
 *   node scripts/build-load-fidelity-fixtures.mjs
 *   node scripts/build-load-fidelity-fixtures.mjs --verify
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "samples/fixtures/load-fidelity");

// ── LCG pseudo-random generator seeded by size ──────────────────────
// Simple 32-bit Lehmer LCG (same constants as MMIX).
function makeLCG(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 1;
  return () => {
    // LCG: a=6364136223846793005 mod 2^32 (truncated), c=1442695040888963407 mod 2^32
    // Use simpler constants that fit 32-bit: a=1664525, c=1013904223 (Numerical Recipes).
    state = ((Math.imul(state, 1664525) + 1013904223) >>> 0);
    return state & 0xff;
  };
}

/**
 * Build a PRG payload (2-byte load addr header + pseudo-random body).
 * @param {number} totalBytes - total payload bytes INCLUDING the 2-byte header.
 * @param {number} [seed]     - LCG seed (defaults to totalBytes).
 * @returns {Uint8Array}
 */
function buildPRG(totalBytes, seed) {
  const payload = new Uint8Array(totalBytes);
  // Load address: $0801 little-endian.
  payload[0] = 0x01;
  payload[1] = 0x08;
  const rng = makeLCG(seed ?? totalBytes);
  for (let i = 2; i < totalBytes; i++) {
    payload[i] = rng();
  }
  return payload;
}

// ── D64 builder (inline — avoids compiled-TS import requirement) ─────
// Mirrors src/disk/d64-builder.ts but as plain JS so the script is
// self-contained and runnable without a build step.

const SECTORS_PER_TRACK = {
  1: 21, 2: 21, 3: 21, 4: 21, 5: 21, 6: 21, 7: 21, 8: 21, 9: 21,
  10: 21, 11: 21, 12: 21, 13: 21, 14: 21, 15: 21, 16: 21, 17: 21,
  18: 19, 19: 19, 20: 19, 21: 19, 22: 19, 23: 19, 24: 19,
  25: 18, 26: 18, 27: 18, 28: 18, 29: 18, 30: 18,
  31: 17, 32: 17, 33: 17, 34: 17, 35: 17,
};

const D64_TRACK_COUNT = 35;
let D64_TOTAL_SECTORS = 0;
for (let t = 1; t <= D64_TRACK_COUNT; t++) D64_TOTAL_SECTORS += SECTORS_PER_TRACK[t];
const D64_BYTES = D64_TOTAL_SECTORS * 256; // 683 × 256 = 174848

function d64Offset(track, sector) {
  if (track < 1 || track > D64_TRACK_COUNT) throw new Error(`track ${track} out of range`);
  const max = SECTORS_PER_TRACK[track];
  if (sector < 0 || sector >= max) throw new Error(`track ${track} sector ${sector} out of range (max ${max})`);
  let offset = 0;
  for (let t = 1; t < track; t++) offset += SECTORS_PER_TRACK[t] * 256;
  offset += sector * 256;
  return offset;
}

function petPad16(s, fill = 0xa0) {
  const out = new Uint8Array(16).fill(fill);
  for (let i = 0; i < Math.min(16, s.length); i++) {
    let c = s.charCodeAt(i);
    if (c >= 0x61 && c <= 0x7a) c -= 0x20; // ASCII lower → PETSCII upper
    out[i] = c & 0xff;
  }
  return out;
}

/**
 * Build a D64 image with one PRG file named name, payload = prg bytes.
 * @param {Uint8Array} prg      - full PRG including 2-byte load-addr header.
 * @param {string}     name     - up to 16 ASCII chars; uppercased to PETSCII.
 * @param {string}     [diskName]
 * @param {string}     [diskId]
 * @returns {Uint8Array} 174848-byte D64 image.
 */
function buildD64Single(prg, name, diskName = "LOADFIDELITY", diskId = "LF", fileStartTrack = 17) {
  const img = new Uint8Array(D64_BYTES);

  // Track/sector allocation state.
  const trackFreeCount = new Array(D64_TRACK_COUNT + 1).fill(0);
  const trackBits = Array.from({ length: D64_TRACK_COUNT + 1 }, () => [0xff, 0xff, 0xff]);

  for (let t = 1; t <= D64_TRACK_COUNT; t++) {
    trackFreeCount[t] = SECTORS_PER_TRACK[t];
    const sectors = SECTORS_PER_TRACK[t];
    const lastByte = Math.floor((sectors - 1) / 8);
    const trailingBits = sectors - lastByte * 8;
    trackBits[t][lastByte] = (1 << trailingBits) - 1;
    for (let i = lastByte + 1; i < 3; i++) trackBits[t][i] = 0;
  }

  function allocate(track, sector) {
    if (track === 0) return;
    trackFreeCount[track]--;
    const byteIdx = Math.floor(sector / 8);
    const bitIdx = sector % 8;
    trackBits[track][byteIdx] = trackBits[track][byteIdx] & ~(1 << bitIdx) & 0xff;
  }

  // ── BAM (track 18 sector 0) ────────────────────────────────────────
  const bam = d64Offset(18, 0);
  img[bam + 0x00] = 18;   // first dir track
  img[bam + 0x01] = 0x01; // first dir sector
  img[bam + 0x02] = 0x41; // DOS version 'A'
  img[bam + 0x03] = 0x00;
  img.set(petPad16(diskName), bam + 0x90);
  img[bam + 0xa0] = 0xa0;
  img[bam + 0xa1] = 0xa0;
  img[bam + 0xa2] = diskId.charCodeAt(0) & 0xff;
  img[bam + 0xa3] = (diskId.charCodeAt(1) ?? 0x20) & 0xff;
  img[bam + 0xa4] = 0xa0;
  img[bam + 0xa5] = 0x32; // '2'
  img[bam + 0xa6] = 0x41; // 'A'
  img[bam + 0xa7] = 0xa0;
  img[bam + 0xa8] = 0xa0;
  img[bam + 0xa9] = 0xa0;
  img[bam + 0xaa] = 0xa0;

  allocate(18, 0); // BAM
  allocate(18, 1); // dir

  // ── Directory sector (track 18 sector 1) ──────────────────────────
  const dirSec = d64Offset(18, 1);
  img[dirSec + 0x00] = 0x00; // last dir sector (no chain)
  img[dirSec + 0x01] = 0xff;

  // ── File allocation starting at fileStartTrack sector 0 ──────────
  let track = fileStartTrack;
  let sector = 0;
  const startTrack = track;
  const startSector = sector;
  let written = 0;
  let prevOffset = -1;
  let sectorCount = 0;

  while (written < prg.length) {
    const remaining = prg.length - written;
    const chunk = Math.min(254, remaining);
    const off = d64Offset(track, sector);
    img.set(prg.subarray(written, written + chunk), off + 2);
    if (prevOffset >= 0) {
      img[prevOffset + 0] = track;
      img[prevOffset + 1] = sector;
    }
    allocate(track, sector);
    // Last-sector marker: next_track=0, next_sector=bytes_in_sector (1-based, 1..255)
    img[off + 0] = 0x00;
    img[off + 1] = (chunk + 1) & 0xff;
    prevOffset = off;
    written += chunk;
    sectorCount++;

    if (written < prg.length) {
      sector++;
      if (sector >= SECTORS_PER_TRACK[track]) {
        sector = 0;
        track++;
        if (track === 18) track = 19;
        if (track > D64_TRACK_COUNT) throw new Error("disk full");
      }
    }
  }

  // ── Directory entry (slot 0 of first dir sector) ───────────────────
  // Slot 0 occupies bytes 0x00..0x1f; bytes 0-1 are the chain pointer (already set).
  img[dirSec + 0x02] = 0x82;       // PRG + closed
  img[dirSec + 0x03] = startTrack;
  img[dirSec + 0x04] = startSector;
  img.set(petPad16(name), dirSec + 0x05);
  img[dirSec + 0x1e] = sectorCount & 0xff;
  img[dirSec + 0x1f] = (sectorCount >> 8) & 0xff;

  // ── Flush BAM allocation map ───────────────────────────────────────
  for (let t = 1; t <= D64_TRACK_COUNT; t++) {
    const entry = bam + 0x04 + (t - 1) * 4;
    img[entry + 0] = trackFreeCount[t];
    img[entry + 1] = trackBits[t][0];
    img[entry + 2] = trackBits[t][1];
    img[entry + 3] = trackBits[t][2];
  }

  return img;
}

// ── Fixture definitions ──────────────────────────────────────────────
// Each entry: { filename, totalPayloadBytes, note }
// totalPayloadBytes = 2-byte header + body.
// For N data sectors: bodyBytes = N*254 - padding (last sector may be partial).
// We specify payload size in bytes; sector count = ceil(payload / 254).

function payloadForSectors(n) {
  // The 2-byte load-address header lives inside the 254-byte sector payload.
  // So for exactly n sectors (each holding up to 254 payload bytes):
  //   total payload bytes = n * 254
  // The last sector is full (254 bytes used), which is the common case.
  return n * 254;
}

// lf-007-eoi-edge: exactly 254×N bytes of payload body (no partial last sector).
// last sector bytes_used = 254, next_sector marker = 255 (254+1).
// N=5 chosen: small enough to be quick, large enough to be interesting.
const EOI_EDGE_N = 5;

// lf-008-short-tail: (254×N)+1 bytes body, so last sector has 1 valid byte.
// N=5 chosen to match eoi-edge for easy comparison.
const SHORT_TAIL_N = 5;

// lf-009-cross-track: span tracks 17→19 (skip 18). Track 17 has 21 sectors.
// Use 25 sectors total: 21 on track 17 + 4 on track 19.
const CROSS_TRACK_SECTORS = 25;

const fixtures = [
  {
    filename: "lf-001-1block.d64",
    payloadBytes: payloadForSectors(1),      // 256 bytes total
    note: "1 sector minimum PRG",
  },
  {
    filename: "lf-002-5block.d64",
    payloadBytes: payloadForSectors(5),      // 1272 bytes
    note: "5 sectors small multi-block",
  },
  {
    filename: "lf-003-30block.d64",
    payloadBytes: payloadForSectors(30),     // 7622 bytes
    note: "30 sectors mid-size",
  },
  {
    filename: "lf-004-100block.d64",
    payloadBytes: payloadForSectors(100),    // 25402 bytes
    note: "100 sectors large",
  },
  {
    filename: "lf-005-200block.d64",
    payloadBytes: payloadForSectors(200),    // 50802 bytes
    note: "200 sectors very large",
  },
  {
    filename: "lf-006-max.d64",
    payloadBytes: payloadForSectors(660),    // 167642 bytes (660 data sectors)
    startTrack: 1,                           // must start at t1 to fit 660 sectors
    note: "660 sectors max disk capacity",
  },
  {
    filename: "lf-007-eoi-edge.d64",
    // Exactly EOI_EDGE_N full sectors: total payload = EOI_EDGE_N*254 bytes.
    // Last sector has 254 payload bytes → next_sector = 255 (254+1).
    // ACPTR EOI edge: full-block last sector.
    payloadBytes: EOI_EDGE_N * 254,
    note: `${EOI_EDGE_N} full sectors, EOI edge (last sector full-block)`,
  },
  {
    filename: "lf-008-short-tail.d64",
    // (SHORT_TAIL_N full sectors) + 1 extra byte → last sector has 1 valid byte (next_sector=2).
    // Total payload = SHORT_TAIL_N*254 + 1 bytes → ceil = SHORT_TAIL_N+1 sectors.
    payloadBytes: SHORT_TAIL_N * 254 + 1,
    note: `${SHORT_TAIL_N+1} sectors, short tail (last sector = 1 byte)`,
  },
  {
    filename: "lf-009-cross-track.d64",
    // 25 sectors: fills track 17 (21 sectors) then spills 4 sectors to track 19.
    // Tests inter-track stepper crossing track 17→19 (skips t18 dir track).
    payloadBytes: CROSS_TRACK_SECTORS * 254,
    note: `${CROSS_TRACK_SECTORS} sectors spanning track 17→19 boundary`,
  },
];

// ── Generate fixtures ────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

const manifest = [];

for (const fix of fixtures) {
  const prg = buildPRG(fix.payloadBytes);
  const d64 = buildD64Single(prg, "TEST", "LOAD FIDELITY", "LF", fix.startTrack ?? 17);
  const outPath = resolve(OUT_DIR, fix.filename);
  writeFileSync(outPath, d64);
  const sectors = Math.ceil(fix.payloadBytes / 254);
  manifest.push({ filename: fix.filename, payloadBytes: fix.payloadBytes, sectors, note: fix.note });
  process.stdout.write(`  WROTE ${fix.filename}  payload=${fix.payloadBytes}B  sectors=${sectors}  (${fix.note})\n`);
}

// Write manifest JSON for use by test harness (Task 616.4).
writeFileSync(
  resolve(OUT_DIR, "_manifest.json"),
  JSON.stringify({ generated: new Date().toISOString(), fixtures: manifest }, null, 2) + "\n",
);
process.stdout.write(`  WROTE _manifest.json\n`);

// ── Smoke verification ───────────────────────────────────────────────
// Parse each fixture back with the inline D64 reader and verify:
//   1. Directory contains exactly one entry named TEST.
//   2. Extracted PRG bytes == original generated PRG bytes.

let allOk = true;

for (const fix of fixtures) {
  const d64Buf = (await import("node:fs")).readFileSync(resolve(OUT_DIR, fix.filename));
  const d64 = new Uint8Array(d64Buf.buffer, d64Buf.byteOffset, d64Buf.length);

  // Read BAM + directory using the same inline parser logic.
  function getSector(track, sector) {
    const off = d64Offset(track, sector);
    return d64.slice(off, off + 256);
  }

  // Parse directory.
  const bamSec = getSector(18, 0);
  const diskName = (() => {
    let n = "";
    for (let i = 0; i < 16; i++) {
      const b = bamSec[0x90 + i];
      if (b === 0xa0) break;
      const c = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
      n += String.fromCharCode(c);
    }
    return n;
  })();

  const dirSec = getSector(18, 1);
  const typeByte = dirSec[0x02];
  const fileTrack = dirSec[0x03];
  const fileSector = dirSec[0x04];
  const nameBytes = dirSec.slice(0x05, 0x15);
  let fileName = "";
  for (let i = 0; i < 16; i++) {
    if (nameBytes[i] === 0xa0) break;
    const b = nameBytes[i];
    const c = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
    fileName += String.fromCharCode(c);
  }

  if ((typeByte & 0x07) !== 0x02) {
    process.stderr.write(`  FAIL ${fix.filename}: dir entry type 0x${typeByte.toString(16)} != PRG\n`);
    allOk = false;
    continue;
  }
  if (fileName.toUpperCase() !== "TEST") {
    process.stderr.write(`  FAIL ${fix.filename}: name "${fileName}" != TEST\n`);
    allOk = false;
    continue;
  }

  // Extract file via sector chain.
  const chunks = [];
  let track = fileTrack;
  let sector = fileSector;
  const visited = new Set();
  while (track !== 0) {
    const key = `${track}:${sector}`;
    if (visited.has(key)) break;
    visited.add(key);
    const sec = getSector(track, sector);
    const nextTrack = sec[0];
    const nextSector = sec[1];
    if (nextTrack === 0) {
      const used = nextSector > 0 ? nextSector - 1 : 254;
      chunks.push(sec.slice(2, 2 + used));
    } else {
      chunks.push(sec.slice(2));
    }
    track = nextTrack;
    sector = nextSector;
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const extracted = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) { extracted.set(c, off); off += c.length; }

  // Regenerate original PRG.
  const expected = buildPRG(fix.payloadBytes);

  // Compare.
  if (extracted.length !== expected.length) {
    process.stderr.write(`  FAIL ${fix.filename}: len ${extracted.length} != expected ${expected.length}\n`);
    allOk = false;
    continue;
  }
  let mismatch = -1;
  for (let i = 0; i < expected.length; i++) {
    if (extracted[i] !== expected[i]) { mismatch = i; break; }
  }
  if (mismatch >= 0) {
    process.stderr.write(`  FAIL ${fix.filename}: byte mismatch at offset ${mismatch}: got 0x${extracted[mismatch].toString(16).padStart(2,"0")} expected 0x${expected[mismatch].toString(16).padStart(2,"0")}\n`);
    allOk = false;
    continue;
  }

  process.stdout.write(`  VERIFY OK ${fix.filename}  extracted=${extracted.length}B  name=${fileName}  disk=${diskName}\n`);
}

if (allOk) {
  process.stdout.write("\nAll 9 fixtures built and verified OK.\n");
  process.exit(0);
} else {
  process.stderr.write("\nSome fixtures FAILED verification.\n");
  process.exit(1);
}
