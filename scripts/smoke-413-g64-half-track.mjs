#!/usr/bin/env node
// Spec 413 — 1541 Phase G smoke B: G64 with half-track data, mount,
// head step to half-track position, verify track data is read back.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §9.2 (G64 raw load),
//       §13 Phase G step 28,
//       §7.3 (stepper motor — half-track increments),
//       §14 invariant 7 (Δphase ±1 = single half-step).
//
// VICE: src/diskimage/fsimage-gcr.c fsimage_read_gcr_image() loads
//         84 half-track slots verbatim (G64 layout = 84 slots,
//         indexed 0..83 for half-tracks 1.0, 1.5, …, 42.5).
//       src/drive/iecieee/via2d.c:229-313 stepper modulo-4 phase walk.
//
// Per spec 413: half-track support is the load-time invariant — G64
// stores track data at half-track granularity (84 slots), and the
// drive head must be addressable in half-track increments. We test
// the spec's claim by:
//   1. Constructing a G64 image with explicit data at half-track 18.5
//      (slot index 37) — distinct from the integer-track 18 data.
//   2. Mounting via G64Parser.
//   3. Stepping head to halfTrack 37 via the modulo-4 stepper sequence.
//   4. Verifying getRawTrackBytes(18.5) returns the half-track payload,
//      and that integer-track 18 returns the integer-track payload —
//      i.e. the parser distinguishes the two slots correctly.
//
// 18.5 is chosen instead of 35.5 because 35.5 sits past the mechanical
// stop modeled in HeadPosition.stepInward (cap = min(maxHalfTracks-1,
// 70) per the motm fix); 18.5 exercises the same half-track machinery
// well within the steppable range.

import { G64Parser } from "../dist/disk/g64-parser.js";
import { HeadPosition } from "../dist/runtime/headless/drive/head-position.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}

// ── Construct a minimal G64 with two distinct half-tracks ────────────
// Layout (per docs/vice-1541-arch.md §9.2):
//   0x00..0x07  "GCR-1541"
//   0x08        version (0)
//   0x09        track count (84 — half-tracks 1.0..42.5)
//   0x0a..0x0b  max track size LE u16
//   0x0c+i*4    track offset table (84 slots × 4 bytes)
//   then         speed-zone table (84 slots × 4 bytes)
//   per slot     u16 actual size + GCR bytes padded to max track size
//
// Slot indexing:  slot = (track - 1) * 2 (integer track),
//                 slot = (track - 1) * 2 + 1 (half-track).
// So track 18.0 → slot 34; track 18.5 → slot 35.
const G64_SIGNATURE = [0x47, 0x43, 0x52, 0x2d, 0x31, 0x35, 0x34, 0x31];
const G64_TRACK_COUNT = 84;
const G64_MAX_TRACK_SIZE = 7142; // zone 2 (= track 18 capacity)

function buildHalfTrackG64() {
  // Just two slots populated: 34 (track 18) and 35 (track 18.5).
  const headerSize = 12 + G64_TRACK_COUNT * 4 + G64_TRACK_COUNT * 4;
  const trackBlock = 2 + G64_MAX_TRACK_SIZE;
  const totalSize = headerSize + 2 * trackBlock;
  const out = new Uint8Array(totalSize);
  out.set(G64_SIGNATURE, 0);
  out[0x08] = 0;
  out[0x09] = G64_TRACK_COUNT;
  out[0x0a] = G64_MAX_TRACK_SIZE & 0xff;
  out[0x0b] = (G64_MAX_TRACK_SIZE >> 8) & 0xff;

  // Two slot payloads: distinct fill bytes so we can tell them apart.
  // Slot 34 = track 18.0 → fill 0xA5.
  // Slot 35 = track 18.5 → fill 0x5A.
  const writeSlot = (slotIndex, fill, writePos) => {
    const offsetTable = 0x0c + slotIndex * 4;
    out[offsetTable + 0] = writePos & 0xff;
    out[offsetTable + 1] = (writePos >> 8) & 0xff;
    out[offsetTable + 2] = (writePos >> 16) & 0xff;
    out[offsetTable + 3] = (writePos >> 24) & 0xff;
    const speedTable = 0x0c + G64_TRACK_COUNT * 4 + slotIndex * 4;
    out[speedTable + 0] = 2; // zone 2
    // u16 actual size
    out[writePos + 0] = G64_MAX_TRACK_SIZE & 0xff;
    out[writePos + 1] = (G64_MAX_TRACK_SIZE >> 8) & 0xff;
    out.fill(fill, writePos + 2, writePos + 2 + G64_MAX_TRACK_SIZE);
  };
  let writePos = headerSize;
  writeSlot(34, 0xa5, writePos); writePos += trackBlock;
  writeSlot(35, 0x5a, writePos); writePos += trackBlock;
  return out;
}

const g64 = buildHalfTrackG64();
check("synthetic G64 has GCR-1541 magic", G64Parser.isG64(g64));

const parser = new G64Parser(g64);
check("G64Parser reports halfTrackCount = 84",
  parser.getHalfTrackCount() === 84,
  `halfTrackCount=${parser.getHalfTrackCount()}`);

// ── Step 28 acceptance: getRawTrackBytes returns distinct payloads
// for integer track 18.0 and half-track 18.5. This is the doctrine
// invariant: G64 = "what you store is what the drive sees" (§9.2).
const t18 = parser.getRawTrackBytes(18);
const t185 = parser.getRawTrackBytes(18.5);
check("getRawTrackBytes(18.0) returns track 18 payload", !!t18 && t18[0] === 0xa5,
  `byte0=0x${t18?.[0]?.toString(16)} len=${t18?.length}`);
check("getRawTrackBytes(18.5) returns half-track 18.5 payload (distinct from 18.0)",
  !!t185 && t185[0] === 0x5a,
  `byte0=0x${t185?.[0]?.toString(16)} len=${t185?.length}`);
check("track 18.0 vs 18.5 are different payloads",
  t18 && t185 && t18[0] !== t185[0],
  `t18=0x${t18?.[0]?.toString(16)} t185=0x${t185?.[0]?.toString(16)}`);

// ── Half-track step exercise ─────────────────────────────────────────
// HeadPosition starts at track 18 (= trackHalf 36). One step inward
// → trackHalf 37 = track 18.5. VICE stepper sequence: phase advances
// modulo 4 with motor on (PB.2 = 1).
//
// Phase walk (VICE via2d.c:229-313):
//   trackHalf 36 → old phase = (36 - 2) & 3 = 2.
//   new phase 3   → step_count = (3 - 2) & 3 = 1 → stepInward.
//   new phase 2   → step_count = (2 - 3) & 3 = 3 → -1 → stepOutward.
const head = new HeadPosition({ startTrack: 18 });
check("head starts at trackHalf 36 (track 18.0)",
  head.currentHalfTrack === 36 && head.currentTrack === 18,
  `trackHalf=${head.currentHalfTrack} track=${head.currentTrack}`);

// Apply phase 3 with motor on (Δ = +1 mod 4) → step inward to trackHalf 37 (= 18.5).
head.applyStepBits(3, true);
check("after phase 2→3 with motor on: head is at trackHalf 37 (track 18.5)",
  head.currentHalfTrack === 37 && head.currentTrack === 18.5,
  `trackHalf=${head.currentHalfTrack} track=${head.currentTrack}`);

// Apply phase 2 (Δ = -1 mod 4) → step outward back to trackHalf 36 (= 18.0).
head.applyStepBits(2, true);
check("after phase 3→2 with motor on: head back at trackHalf 36 (track 18.0)",
  head.currentHalfTrack === 36 && head.currentTrack === 18,
  `trackHalf=${head.currentHalfTrack} track=${head.currentTrack}`);

// ── Cross-verify: parser returns the half-track data at the position
// the head moved to. (Integration check: the parser indexing scheme
// (round((track-1)*2)) is the same as the head's half-track index.)
//
// Step inward again with the next valid phase (3 → 0, Δ = +1).
// Wait — we are back at trackHalf 36, lastStepBits = 2 latched, so
// next valid +1 step is phase 3 again from old phase 2.
head.applyStepBits(3, true); // back to 18.5
const headTrack = head.currentTrack;
const dataAtHead = parser.getRawTrackBytes(headTrack);
check("parser data at head position 18.5 = half-track payload",
  !!dataAtHead && dataAtHead[0] === 0x5a,
  `headTrack=${headTrack} byte0=0x${dataAtHead?.[0]?.toString(16)}`);

// ── Report ────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`Spec 413 smoke B — G64 half-track mount + head step — ${pass}/${results.length} pass, ${fail} fail`);
for (const r of results) {
  if (!r.pass) console.log(`  [FAIL] ${r.label}: ${r.detail}`);
}
if (fail > 0) process.exit(1);
