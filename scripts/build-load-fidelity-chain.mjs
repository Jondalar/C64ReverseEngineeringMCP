#!/usr/bin/env node
/**
 * Spec 616 T616.5 — Two-stage chain fixture builder.
 *
 * Emits samples/fixtures/load-fidelity/lf-chain.d64 containing two PRG files:
 *
 *   STAGE1  load addr $C000  ~40-byte ML stub that:
 *             - Sets filename "STAGE2" at $C020
 *             - SETNAM / SETLFS(1,8,1)
 *             - JSR $FFD5 (KERNAL LOAD)
 *             - RTS
 *
 *   STAGE2  load addr $0801  30-sector PRG (~7618-byte body)
 *             Pseudo-random LCG content seeded by total payload bytes.
 *
 * Usage:
 *   node scripts/build-load-fidelity-chain.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "samples/fixtures/load-fidelity");

// ── LCG (matches build-load-fidelity-fixtures.mjs) ────────────────────────
function makeLCG(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = ((Math.imul(state, 1664525) + 1013904223) >>> 0);
    return state & 0xff;
  };
}

function buildPRGRandom(totalBytes, loadAddrLo, loadAddrHi, seed) {
  const payload = new Uint8Array(totalBytes);
  payload[0] = loadAddrLo;
  payload[1] = loadAddrHi;
  const rng = makeLCG(seed ?? totalBytes);
  for (let i = 2; i < totalBytes; i++) payload[i] = rng();
  return payload;
}

// ── STAGE1 ML body ─────────────────────────────────────────────────────────
//
// STAGE1 is loaded to $C000 by the outer ML stub at $033C.
// Its body is a small ML program that chain-loads STAGE2 via KERNAL $FFD5.
//
// Memory layout (relative to $C000):
//
//   $C000...$C01B  code (28 bytes)
//   $C01C...$C01F  padding (4 bytes, $00)
//   $C020...$C025  filename "STAGE2" in PETSCII (6 bytes)
//   $C026...$C027  extra padding
//
// Total body = 40 bytes  →  PRG = 2 header + 40 body = 42 bytes.
//
// "STAGE2" PETSCII = 0x53 0x54 0x41 0x47 0x45 0x32
//
// Code:
//   $C000: A9 06         LDA #$06       ; filename len = 6
//   $C002: A2 20         LDX #$20       ; filename lo = <$C020
//   $C004: A0 C0         LDY #$C0       ; filename hi = >$C020
//   $C006: 20 BD FF      JSR $FFBD      ; SETNAM
//   $C009: A9 01         LDA #$01       ; logical file 1
//   $C00B: A2 08         LDX #$08       ; device 8
//   $C00D: A0 01         LDY #$01       ; secondary 1 (use header addr)
//   $C00F: 20 BA FF      JSR $FFBA      ; SETLFS
//   $C012: A9 00         LDA #$00       ; A=0 → LOAD
//   $C014: A2 00         LDX #$00
//   $C016: A0 00         LDY #$00
//   $C018: 20 D5 FF      JSR $FFD5      ; LOAD STAGE2
//   $C01B: 60            RTS

function buildStage1PRG() {
  // PRG header: load addr $C000 (lo=0x00, hi=0xC0)
  const prg = new Uint8Array(42);
  prg[0] = 0x00; // load addr lo
  prg[1] = 0xc0; // load addr hi = $C0
  // Code starts at offset 2 (= $C000)
  const code = [
    0xa9, 0x06,         // LDA #6
    0xa2, 0x20,         // LDX #$20    (lo of $C020)
    0xa0, 0xc0,         // LDY #$C0    (hi of $C020)
    0x20, 0xbd, 0xff,   // JSR $FFBD   SETNAM
    0xa9, 0x01,         // LDA #1
    0xa2, 0x08,         // LDX #8
    0xa0, 0x01,         // LDY #1
    0x20, 0xba, 0xff,   // JSR $FFBA   SETLFS
    0xa9, 0x00,         // LDA #0
    0xa2, 0x00,         // LDX #0
    0xa0, 0x00,         // LDY #0
    0x20, 0xd5, 0xff,   // JSR $FFD5   LOAD
    0x60,               // RTS
  ];
  // code = 28 bytes → offset 2..29 in PRG = $C000..$C01B ✓
  for (let i = 0; i < code.length; i++) prg[2 + i] = code[i];
  // offsets 30..33 ($C01C..$C01F) = padding zeros (already 0)
  // "STAGE2" PETSCII at offset 34 ($C020)
  const stage2Name = [0x53, 0x54, 0x41, 0x47, 0x45, 0x32]; // S T A G E 2
  for (let i = 0; i < stage2Name.length; i++) prg[34 + i] = stage2Name[i];
  // offsets 40..41 ($C026..$C027) = zeros (padding)
  return prg;
}

// ── D64 layout helpers (copied from build-load-fidelity-fixtures.mjs) ────

const SECTORS_PER_TRACK = {
  1:21,2:21,3:21,4:21,5:21,6:21,7:21,8:21,9:21,
  10:21,11:21,12:21,13:21,14:21,15:21,16:21,17:21,
  18:19,19:19,20:19,21:19,22:19,23:19,24:19,
  25:18,26:18,27:18,28:18,29:18,30:18,
  31:17,32:17,33:17,34:17,35:17,
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

// ── Two-file D64 builder ──────────────────────────────────────────────────
//
// Places STAGE1 on track 16 (21 sectors, plenty for tiny file)
// and STAGE2 on track 17 (21 sectors, plenty for 30 sectors if we spill to 19).
// File allocation is sequential sector-by-sector; skip track 18.

function buildD64Chain(stage1Prg, stage2Prg) {
  const img = new Uint8Array(D64_BYTES);

  // Track/sector allocation state
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

  allocate(18, 0); // BAM
  allocate(18, 1); // dir

  // ── BAM (track 18 sector 0) ──────────────────────────────────────────
  const bam = d64Offset(18, 0);
  img[bam + 0x00] = 18;   // first dir track
  img[bam + 0x01] = 0x01; // first dir sector
  img[bam + 0x02] = 0x41; // DOS version 'A'
  img[bam + 0x03] = 0x00;
  img.set(petPad16("CHAIN FIDELITY"), bam + 0x90);
  img[bam + 0xa0] = 0xa0;
  img[bam + 0xa1] = 0xa0;
  img[bam + 0xa2] = 0x4c; // 'L'
  img[bam + 0xa3] = 0x43; // 'C'
  img[bam + 0xa4] = 0xa0;
  img[bam + 0xa5] = 0x32;
  img[bam + 0xa6] = 0x41;
  img[bam + 0xa7] = 0xa0;

  // ── Directory sector (track 18 sector 1) ─────────────────────────────
  const dirOff = d64Offset(18, 1);
  img[dirOff + 0x00] = 0x00; // no next dir sector
  img[dirOff + 0x01] = 0xff;

  // ── Write a PRG into sequential sectors starting at (startTrack, 0) ──
  function writePRG(prg, startTrack) {
    let track = startTrack;
    let sector = 0;
    let written = 0;
    let prevOff = -1;
    let sectorCount = 0;
    const fileStartTrack = track;
    const fileStartSector = sector;

    while (written < prg.length) {
      const remaining = prg.length - written;
      const chunk = Math.min(254, remaining);
      const off = d64Offset(track, sector);
      img.set(prg.subarray(written, written + chunk), off + 2);
      if (prevOff >= 0) {
        img[prevOff + 0] = track;
        img[prevOff + 1] = sector;
      }
      allocate(track, sector);
      img[off + 0] = 0x00;
      img[off + 1] = (chunk + 1) & 0xff;
      prevOff = off;
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
    return { fileStartTrack, fileStartSector, sectorCount };
  }

  // STAGE1 on track 16
  const s1 = writePRG(stage1Prg, 16);
  // STAGE2 on track 17 (may spill to track 19, skipping 18)
  const s2 = writePRG(stage2Prg, 17);

  // ── Directory entries ─────────────────────────────────────────────────
  // Slot 0 (bytes 0x00..0x1F): STAGE1
  img[dirOff + 0x02] = 0x82; // PRG + closed
  img[dirOff + 0x03] = s1.fileStartTrack;
  img[dirOff + 0x04] = s1.fileStartSector;
  img.set(petPad16("STAGE1"), dirOff + 0x05);
  img[dirOff + 0x1e] = s1.sectorCount & 0xff;
  img[dirOff + 0x1f] = (s1.sectorCount >> 8) & 0xff;

  // Slot 1 (bytes 0x20..0x3F): STAGE2
  img[dirOff + 0x22] = 0x82; // PRG + closed
  img[dirOff + 0x23] = s2.fileStartTrack;
  img[dirOff + 0x24] = s2.fileStartSector;
  img.set(petPad16("STAGE2"), dirOff + 0x25);
  img[dirOff + 0x3e] = s2.sectorCount & 0xff;
  img[dirOff + 0x3f] = (s2.sectorCount >> 8) & 0xff;

  // ── Flush BAM allocation map ──────────────────────────────────────────
  for (let t = 1; t <= D64_TRACK_COUNT; t++) {
    const entry = bam + 0x04 + (t - 1) * 4;
    img[entry + 0] = trackFreeCount[t];
    img[entry + 1] = trackBits[t][0];
    img[entry + 2] = trackBits[t][1];
    img[entry + 3] = trackBits[t][2];
  }

  return img;
}

// ── Main ────────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

// STAGE2: 30-sector PRG at $0801, total payload = 30 × 254 = 7620 bytes.
// Body = 7618 bytes (LCG seeded by 7620).
const STAGE2_PAYLOAD_BYTES = 30 * 254; // 7620
const stage2Prg = buildPRGRandom(STAGE2_PAYLOAD_BYTES, 0x01, 0x08, STAGE2_PAYLOAD_BYTES);

// STAGE1: ML chain-loader at $C000.
const stage1Prg = buildStage1PRG();

const img = buildD64Chain(stage1Prg, stage2Prg);
const outPath = resolve(OUT_DIR, "lf-chain.d64");
writeFileSync(outPath, img);

process.stdout.write(`  WROTE lf-chain.d64\n`);
process.stdout.write(`    STAGE1: ${stage1Prg.length} bytes PRG (load addr $C000, ML chain-loader)\n`);
process.stdout.write(`    STAGE2: ${stage2Prg.length} bytes PRG (load addr $0801, LCG body seed=${STAGE2_PAYLOAD_BYTES})\n`);
process.stdout.write(`    Body for STAGE2: ${STAGE2_PAYLOAD_BYTES - 2} bytes\n`);

// ── Inline verify ────────────────────────────────────────────────────────────

function getSector(d64, track, sector) {
  const off = d64Offset(track, sector);
  return d64.slice(off, off + 256);
}

// Read directory and check both entries exist.
const dirSec = getSector(img, 18, 1);

function parseName(bytes) {
  let n = "";
  for (let i = 0; i < 16; i++) {
    const b = bytes[i];
    if (b === 0xa0 || b === undefined) break;
    n += String.fromCharCode(b >= 0x41 && b <= 0x5a ? b + 0x20 : b);
  }
  return n.toUpperCase();
}

const name0 = parseName(dirSec.slice(0x05, 0x15));
const name1 = parseName(dirSec.slice(0x25, 0x35));

if (name0 !== "STAGE1") {
  process.stderr.write(`  FAIL: dir slot 0 name "${name0}" != STAGE1\n`);
  process.exit(1);
}
if (name1 !== "STAGE2") {
  process.stderr.write(`  FAIL: dir slot 1 name "${name1}" != STAGE2\n`);
  process.exit(1);
}

// Extract STAGE1 and verify it starts at $C000.
function extractFile(d64, startTrack, startSector) {
  const chunks = [];
  let track = startTrack;
  let sector = startSector;
  const visited = new Set();
  while (track !== 0) {
    const key = `${track}:${sector}`;
    if (visited.has(key)) break;
    visited.add(key);
    const sec = getSector(d64, track, sector);
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
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const s1Extracted = extractFile(img, dirSec[0x03], dirSec[0x04]);
const s2Extracted = extractFile(img, dirSec[0x23], dirSec[0x24]);

if (s1Extracted[0] !== 0x00 || s1Extracted[1] !== 0xc0) {
  process.stderr.write(`  FAIL: STAGE1 load addr $${s1Extracted[1].toString(16)}${s1Extracted[0].toString(16).padStart(2,"0")} != $C000\n`);
  process.exit(1);
}
if (s2Extracted[0] !== 0x01 || s2Extracted[1] !== 0x08) {
  process.stderr.write(`  FAIL: STAGE2 load addr $${s2Extracted[1].toString(16)}${s2Extracted[0].toString(16).padStart(2,"0")} != $0801\n`);
  process.exit(1);
}

// Verify STAGE2 body matches expected LCG.
const expectedS2 = buildPRGRandom(STAGE2_PAYLOAD_BYTES, 0x01, 0x08, STAGE2_PAYLOAD_BYTES);
if (s2Extracted.length !== expectedS2.length) {
  process.stderr.write(`  FAIL: STAGE2 extracted ${s2Extracted.length} bytes != expected ${expectedS2.length}\n`);
  process.exit(1);
}
let mismatch = -1;
for (let i = 0; i < expectedS2.length; i++) {
  if (s2Extracted[i] !== expectedS2[i]) { mismatch = i; break; }
}
if (mismatch >= 0) {
  process.stderr.write(`  FAIL: STAGE2 byte mismatch at offset ${mismatch}\n`);
  process.exit(1);
}

// Verify STAGE1 code bytes (check JSR $FFD5 at $C018)
// In the PRG: offset 2 = $C000, so $C018 is at PRG offset 2+24 = 26.
// JSR = 0x20, lo=$D5, hi=$FF
if (s1Extracted[26] !== 0x20 || s1Extracted[27] !== 0xd5 || s1Extracted[28] !== 0xff) {
  process.stderr.write(`  FAIL: STAGE1 missing JSR $FFD5 at $C018 (PRG offset 26): got $${s1Extracted[26].toString(16)} $${s1Extracted[27].toString(16)} $${s1Extracted[28].toString(16)}\n`);
  process.exit(1);
}

process.stdout.write(`  VERIFY OK lf-chain.d64\n`);
process.stdout.write(`    STAGE1 extracted=${s1Extracted.length}B  load=$C000  JSR $FFD5 at $C018 OK\n`);
process.stdout.write(`    STAGE2 extracted=${s2Extracted.length}B  load=$0801  body=${s2Extracted.length - 2}B byte-equal OK\n`);
process.stdout.write(`\nChain fixture built and verified OK.\n`);

export {
  STAGE2_PAYLOAD_BYTES,
};
