#!/usr/bin/env node
/**
 * Spec 617 T617.2 — Blank formatted D64 builder.
 *
 * Emits samples/fixtures/save-fidelity/_blank.d64 — a 35-track D64 with:
 *   - BAM at track 18 sector 0: all sectors free except t18 s0 (BAM) + s1 (dir).
 *   - Dir header at track 18 sector 1: disk name "BLANK", ID "BL".
 *   - Empty directory (no files).
 *
 * Usage:
 *   node scripts/build-save-fidelity-blank-d64.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "samples/fixtures/save-fidelity");

// ── D64 geometry (same as Spec 616 build scripts) ────────────────────────────
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
  let off = 0;
  for (let t = 1; t < track; t++) off += SECTORS_PER_TRACK[t] * 256;
  return off + sector * 256;
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

function buildBlankD64(diskName = "BLANK", diskId = "BL") {
  const img = new Uint8Array(D64_BYTES);

  // Track/sector allocation state — all free initially.
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
    trackFreeCount[track]--;
    const byteIdx = Math.floor(sector / 8);
    const bitIdx = sector % 8;
    trackBits[track][byteIdx] = trackBits[track][byteIdx] & ~(1 << bitIdx) & 0xff;
  }

  allocate(18, 0); // BAM sector
  allocate(18, 1); // Dir header sector

  // ── BAM (track 18 sector 0) ───────────────────────────────────────────────
  const bam = d64Offset(18, 0);
  img[bam + 0x00] = 18;    // first dir track
  img[bam + 0x01] = 0x01;  // first dir sector
  img[bam + 0x02] = 0x41;  // DOS version 'A'
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

  // Flush BAM allocation map — must do this AFTER all allocations.
  for (let t = 1; t <= D64_TRACK_COUNT; t++) {
    const entry = bam + 0x04 + (t - 1) * 4;
    img[entry + 0] = trackFreeCount[t];
    img[entry + 1] = trackBits[t][0];
    img[entry + 2] = trackBits[t][1];
    img[entry + 3] = trackBits[t][2];
  }

  // ── Directory header sector (track 18 sector 1) ───────────────────────────
  const dirOff = d64Offset(18, 1);
  img[dirOff + 0x00] = 0x00; // no next dir sector (empty directory)
  img[dirOff + 0x01] = 0xff;
  // All directory slots zero (type=0x00 = scratched/unused)

  return img;
}

// ── Generate + verify ─────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

const img = buildBlankD64("BLANK", "BL");
const outPath = resolve(OUT_DIR, "_blank.d64");
writeFileSync(outPath, img);
process.stdout.write(`  WROTE ${outPath}  (${img.length} bytes = 683 sectors × 256)\n`);

// Smoke verify: check BAM + dir header.
const bam = d64Offset(18, 0);
const dir = d64Offset(18, 1);

const bamFirstDirTrack = img[bam + 0x00];
const bamFirstDirSector = img[bam + 0x01];
const bamDosVersion = img[bam + 0x02];
if (bamFirstDirTrack !== 18 || bamFirstDirSector !== 1 || bamDosVersion !== 0x41) {
  process.stderr.write(`  FAIL: BAM header wrong: t${bamFirstDirTrack} s${bamFirstDirSector} ver=0x${bamDosVersion.toString(16)}\n`);
  process.exit(1);
}

// Check t18s0 + t18s1 are allocated (free count should be 17, not 19).
const t18Entry = bam + 0x04 + (18 - 1) * 4;
const t18Free = img[t18Entry];
if (t18Free !== 17) {
  process.stderr.write(`  FAIL: track 18 free count = ${t18Free}, expected 17 (19 - 2 system sectors)\n`);
  process.exit(1);
}

// Check all other tracks are fully free.
let allTracksOk = true;
for (let t = 1; t <= D64_TRACK_COUNT; t++) {
  if (t === 18) continue;
  const entry = bam + 0x04 + (t - 1) * 4;
  const free = img[entry];
  const expected = SECTORS_PER_TRACK[t];
  if (free !== expected) {
    process.stderr.write(`  FAIL: track ${t} free=${free} != expected ${expected}\n`);
    allTracksOk = false;
  }
}
if (!allTracksOk) process.exit(1);

// Dir header: no next sector (should be 0x00 0xff).
if (img[dir + 0x00] !== 0x00 || img[dir + 0x01] !== 0xff) {
  process.stderr.write(`  FAIL: dir header chain: t${img[dir+0x00]} s${img[dir+0x01]}, expected 0x00 0xff\n`);
  process.exit(1);
}

// Dir slot 0 type should be 0x00 (unused).
if (img[dir + 0x02] !== 0x00) {
  process.stderr.write(`  FAIL: dir slot 0 type=0x${img[dir+0x02].toString(16)}, expected 0x00 (empty)\n`);
  process.exit(1);
}

process.stdout.write(`  VERIFY OK: t18 free=17, all other tracks fully free, dir empty\n`);
process.stdout.write(`\nBlank D64 built and verified OK.\n`);
