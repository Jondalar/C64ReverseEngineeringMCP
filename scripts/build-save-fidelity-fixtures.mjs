#!/usr/bin/env node
/**
 * Spec 617 T617.1 — Save-fidelity source byte blob generator.
 *
 * Emits 9 raw source-byte blobs into samples/fixtures/save-fidelity/source/.
 * Each blob contains the bytes that will be SAVEd by KERNAL SAVE — i.e.
 * the program body WITHOUT a 2-byte load-address header (KERNAL SAVE prepends
 * the 2-byte header automatically from ZP $AC/$AD before writing).
 *
 * sf-001 through sf-009: sizes per Spec 617 §5.1 matrix.
 *
 * NOTE: sf-006-max uses a source size of 60000 bytes (< 64 KB C64 RAM
 *   available above $0900 and below $D000 I/O). The spec says "max disk"
 *   (~158 KB) but the C64 has only 64 KB RAM; $0900 + 60000 = $EDE0 which
 *   is safely below the $D000 I/O boundary. Documented carve-out.
 *
 * Usage:
 *   node scripts/build-save-fidelity-fixtures.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "samples/fixtures/save-fidelity/source");

// ── LCG (same constants as Spec 616 build-load-fidelity-fixtures.mjs) ────────
function makeLCG(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = ((Math.imul(state, 1664525) + 1013904223) >>> 0);
    return state & 0xff;
  };
}

/**
 * Build a source-byte blob of exactly `size` bytes seeded by `size`.
 * These are the bytes SAVEd to disk — no load-addr header.
 * KERNAL SAVE prepends the 2-byte header from ZP $AC/$AD.
 */
function buildSourceBlob(size) {
  const buf = new Uint8Array(size);
  const rng = makeLCG(size);
  for (let i = 0; i < size; i++) buf[i] = rng();
  return buf;
}

// ── Fixture definitions ───────────────────────────────────────────────────────
// Spec 617 §5.1 matrix.
// sourceSize = raw bytes in the save payload (no PRG header).
// KERNAL SAVE writes (loadAddr lo, loadAddr hi) + sourceBytes to disk.
// Sectors written = ceil((sourceSize + 2) / 254)

const LOAD_ADDR = 0x0900; // base load address for all save fixtures

// For sf-007 and sf-008: N such that payload is interesting
const EOI_N  = 5;  // sf-007: exactly 5 full sectors
const TAIL_N = 5;  // sf-008: 5 full sectors + 1 extra byte

// sf-009-cross-track: size designed to span tracks 17→19 (skip t18 directory)
// Track 17 has 21 sectors → each sector holds 254 payload bytes. After 2-byte
// header: 21 sectors = 21*254 - 2 = 5332 body bytes on track 17. Add 4 sectors
// on track 19 → total payload = 25*254 - 2 = 6348 bytes. We use 25*254 = 6350
// total with header, so 6348 body bytes.
const CROSS_TRACK_SECTORS = 25;

// sf-006: max disk is ~660 sectors → 660*254 = 167640 + 2 header = 167642 bytes.
// But C64 RAM: load addr $0900 → max safe addr $D000 (I/O boundary) minus
// small stack headroom → $CFFF - $0900 = 0xC6FF = 50943 bytes.
// Use 50000 bytes (fits safely) as practical max.
// Documented carve-out: real disk max exceeds C64 RAM; test uses 50000 bytes.
const SF006_SIZE = 50000;

const fixtures = [
  {
    filename: "sf-001-1block.src.bin",
    // 1 sector: (254 - 2) = 252 bytes payload (header uses 2 of 254 bytes in sector)
    sourceSize: 252,
    note: "1 sector min SAVE (252 src bytes → 254 on disk with 2-byte header)",
  },
  {
    filename: "sf-002-5block.src.bin",
    // 5 sectors: 5*254 - 2 = 1268 bytes
    sourceSize: 5 * 254 - 2,
    note: "5 sectors small multi-block",
  },
  {
    filename: "sf-003-30block.src.bin",
    // 30 sectors: 30*254 - 2 = 7618 bytes
    sourceSize: 30 * 254 - 2,
    note: "30 sectors mid-size",
  },
  {
    filename: "sf-004-100block.src.bin",
    // 100 sectors: 100*254 - 2 = 25398 bytes
    sourceSize: 100 * 254 - 2,
    note: "100 sectors large",
  },
  {
    filename: "sf-005-200block.src.bin",
    // 200 sectors: 200*254 - 2 = 50798 bytes
    sourceSize: 200 * 254 - 2,
    note: "200 sectors very large",
  },
  {
    filename: "sf-006-max.src.bin",
    // Max-RAM carve-out: 50000 source bytes (~197 sectors). See note above.
    sourceSize: SF006_SIZE,
    note: `max-RAM carve-out: ${SF006_SIZE} src bytes (~${Math.ceil((SF006_SIZE+2)/254)} sectors). Real disk max ~660 sectors exceeds C64 RAM; test capped at $0900+${SF006_SIZE}=$${(0x0900+SF006_SIZE).toString(16).toUpperCase()} (below $D000 I/O).`,
  },
  {
    filename: "sf-007-full-block.src.bin",
    // Exactly EOI_N full 254-byte sectors: (EOI_N*254 - 2) body bytes.
    // Last sector has 254 payload bytes → next_sector marker = 255 (254+1).
    sourceSize: EOI_N * 254 - 2,
    note: `${EOI_N} full sectors, last sector full-block (next_sector=255) — EOI edge`,
  },
  {
    filename: "sf-008-short-tail.src.bin",
    // (TAIL_N full sectors) + 1 extra byte → last sector has 1 payload byte (next_sector=2).
    sourceSize: TAIL_N * 254 - 2 + 1,
    note: `${TAIL_N+1} sectors, short tail (last sector = 1 byte)`,
  },
  {
    filename: "sf-009-cross-track.src.bin",
    // Spans track 17→19 (skips t18 directory). 25 sectors total.
    sourceSize: CROSS_TRACK_SECTORS * 254 - 2,
    note: `spans tracks 17→19 (skip t18): ${CROSS_TRACK_SECTORS} sectors, ${CROSS_TRACK_SECTORS*254-2} src bytes`,
  },
];

// ── Generate ──────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

const manifest = { loadAddr: LOAD_ADDR, fixtures: [] };

for (const fix of fixtures) {
  const blob = buildSourceBlob(fix.sourceSize);
  const outPath = resolve(OUT_DIR, fix.filename);
  writeFileSync(outPath, blob);
  const diskSectors = Math.ceil((fix.sourceSize + 2) / 254);
  manifest.fixtures.push({
    filename: fix.filename,
    sourceSize: fix.sourceSize,
    loadAddr: `0x${LOAD_ADDR.toString(16).padStart(4, "0")}`,
    sectors: diskSectors,
    note: fix.note,
  });
  process.stdout.write(`  WROTE ${fix.filename}  sourceSize=${fix.sourceSize}B  diskSectors=${diskSectors}  (${fix.note.slice(0, 60)})\n`);
}

const manifestPath = resolve(OUT_DIR, "..", "_source-manifest.json");
writeFileSync(manifestPath, JSON.stringify({ generated: new Date().toISOString(), ...manifest }, null, 2) + "\n");
process.stdout.write(`  WROTE _source-manifest.json\n`);

// ── Inline smoke verify ───────────────────────────────────────────────────────
// Verify each blob: re-generate expected bytes, compare.
let allOk = true;
for (const fix of fixtures) {
  const { readFileSync } = await import("node:fs");
  const buf = new Uint8Array(readFileSync(resolve(OUT_DIR, fix.filename)));
  const expected = buildSourceBlob(fix.sourceSize);
  if (buf.length !== expected.length) {
    process.stderr.write(`  FAIL ${fix.filename}: length ${buf.length} != ${expected.length}\n`);
    allOk = false;
    continue;
  }
  let mismatch = -1;
  for (let i = 0; i < expected.length; i++) {
    if (buf[i] !== expected[i]) { mismatch = i; break; }
  }
  if (mismatch >= 0) {
    process.stderr.write(`  FAIL ${fix.filename}: byte mismatch at offset ${mismatch}\n`);
    allOk = false;
    continue;
  }
  process.stdout.write(`  VERIFY OK ${fix.filename}  size=${buf.length}B\n`);
}

if (allOk) {
  process.stdout.write("\nAll 9 source blobs built and verified OK.\n");
  process.exit(0);
} else {
  process.stderr.write("\nSome blobs FAILED verification.\n");
  process.exit(1);
}
