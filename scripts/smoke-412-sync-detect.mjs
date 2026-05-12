#!/usr/bin/env node
// Spec 412 — 1541 Phase F smoke B: synthetic GCR stream with SYNC
// marker (≥10 consecutive 1-bits) — assert SYNC line goes low at the
// right bit.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §8.2 (GCR encoding — SYNC = 10+ ones),
//       §8.4 (SYNC detection — zero_count >= 10),
//       §14 invariant 1, §13 step 24.
// VICE: src/drive/rotation.c L1052 simple path SYNC test:
//         "if (~last_read_data & 0x1ff80)" → still inside byte
//         else                              → SYNC active.
//       src/gcr.c:170 `gcr_find_sync` — same 10-ones detection.
//       src/drive/rotation.c L1134 `rotation_sync_found` — returns
//         0x00 when sync is asserted, 0x80 when not (active LOW).
//
// Acceptance per spec 412: feed a synthetic GCR bit stream containing
// a SYNC marker; assert the shifter's syncBit transitions from 1 (no
// sync) to 0 (sync active) at the 10th consecutive 1-bit, and the
// transition latches PA `dataByte` to 0xff.

import { GcrShifter, CYCLES_PER_BYTE_BY_ZONE } from "../dist/runtime/headless/drive/gcr-shifter.js";
import { HeadPosition } from "../dist/runtime/headless/drive/head-position.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}

// Build a synthetic GCR track: leading zeros to flush the shifter,
// then $FF $FF $FF (= 24 consecutive 1-bits = unambiguous SYNC), then
// a $52 data byte after sync to verify byte-latch resumes.
//
// Bit order in the track buffer: MSB-first per byte (VICE
// read_next_bit, rotation.c L256-271). So $FF = 8×1, $52 = 0101_0010.
function buildSyncTrack() {
  // 64 bytes leading 0x00, then 4 bytes $FF (SYNC), then 8 bytes of
  // $52 data. Track 18 = zone 2 = 28 cyc/byte.
  const lead = 64;
  const sync = 4;
  const data = 8;
  const buf = new Uint8Array(lead + sync + data);
  for (let i = 0; i < sync; i++) buf[lead + i] = 0xff;
  for (let i = 0; i < data; i++) buf[lead + sync + i] = 0x52;
  return buf;
}

const fakeTrack = buildSyncTrack();
const parser = {
  getRawTrackBytes: (track) => (track === 18 ? fakeTrack : null),
};

function makeRig() {
  const head = new HeadPosition({ startTrack: 18 });
  const shifter = new GcrShifter({
    parser: /** @type {any} */ (parser),
    headPosition: head,
  });
  shifter.setMotor(true);
  // Force zone 2 (28 cyc/byte = 3.5 cyc/bit ×8) so timing is deterministic.
  shifter.setDensity(2);
  return { shifter, head };
}

// --- Sub-test 1: SYNC detected before reaching the first $FF byte's
//                 10th bit (10 consecutive 1-bits = bits 0..9 of the
//                 SYNC field, i.e. mid-way through the second $FF). --
{
  const { shifter } = makeRig();
  let syncFell = false;
  let bytesBeforeSync = 0;
  shifter.onSyncDetected = (active) => {
    if (active && !syncFell) syncFell = true;
  };
  shifter.onByteReady = () => { if (!syncFell) bytesBeforeSync++; };

  // 28 cyc/byte = 3.5 cyc/bit. Tick enough cycles to consume the lead
  // 64 zero bytes plus the second $FF (where the 10-ones run completes
  // partway through). Lead 64 × 28 = 1792 cycles, then 16 bits =
  // 16 × 3.5 = 56 more = 1848 cycles. Run 1900 — well inside the SYNC
  // window of bytes 64-67 (FF FF FF FF spans cycles 1792..1904).
  const cyclesPerByte = CYCLES_PER_BYTE_BY_ZONE[2]; // = 28
  const N = 1900;
  for (let i = 0; i < N; i++) shifter.tick(1);

  check("SYNC line went LOW after consuming the synthetic $FF SYNC marker",
        syncFell, `syncFell=${syncFell} bytesBeforeSync=${bytesBeforeSync}`);

  // Inside the SYNC window (4× $FF = 32 ones in a row): syncBit must
  // be 0 (active LOW per VICE rotation_sync_found rotation.c:1134).
  check("inside SYNC window: shifter syncBit == 0 (active LOW)",
        shifter.syncBit === 0,
        `syncBit=${shifter.syncBit}`);
  // While shifter is in SYNC its bit_counter is held at 0 and no new
  // byte latches; the PA latch should still be the last pre-SYNC byte
  // (0xff per VICE rotation.c:1072-1074, "GCR_read = 0x11 if NULL"
  // fallback — our initial latch is 0xff = open-bus default).
  check("inside SYNC: PA latch holds prior level (0xff)",
        shifter.dataByte === 0xff,
        `dataByte=0x${shifter.dataByte.toString(16)}`);

  // Doc §14 invariant 1: rotation runs once per cycle. tickCount must
  // equal cycle count.
  check(`smoke ${N} ticks → tickCount == ${N} (per-cycle invariant)`,
        shifter.tickCount === N,
        `tickCount=${shifter.tickCount} (cyclesPerByte=${cyclesPerByte})`);
}

// --- Sub-test 1b: SYNC releases after the $FF run ends ---------------
// Once a 0-bit arrives (i.e. we move past the 4× $FF SYNC marker into
// the $52 data), syncActive should go false again and byte-latch
// resumes. VICE rotation.c L1052 — `bit_counter = 0` reset on
// non-sync bit, then 8 non-sync bits latch the next byte.
{
  const { shifter } = makeRig();
  // Tick just past the SYNC marker into the $52 data run, then sample.
  // Lead 64 bytes × 28 = 1792 cycles. SYNC field 4 × 28 = 112 cycles
  // (ends at ~1904). One $52 byte = 28 more = 1932. Two $52 = 1960.
  // Stop at 1980 — comfortably mid-$52 stream, before track wraps
  // back to leading zeros at byte 76 × 28 = 2128.
  for (let i = 0; i < 1980; i++) shifter.tick(1);
  check("after SYNC + data bytes: syncBit back to 1 (line HIGH)",
        shifter.syncBit === 1,
        `syncBit=${shifter.syncBit}`);
  // PA latch should reflect a $52-derived byte. After SYNC end + 8
  // non-sync bits the latch holds 0x52 (MSB-first read of $52 =
  // 0101_0010). Accept 0x52 exactly.
  const post = shifter.dataByte;
  check("after SYNC: PA latch holds post-SYNC data byte 0x52",
        post === 0x52,
        `dataByte=0x${post.toString(16)}`);
}

// --- Sub-test 2: synthetic exact-10-ones boundary --------------------
// Build a track with exactly 9 ones followed by a zero: must NOT
// trigger SYNC (zero_count < 10).
{
  // Bit pattern as bytes (MSB-first): 0xFF (8 ones), 0x80 (1 one then
  // 7 zeros) — total run of 9 consecutive 1-bits. No sync.
  const buf = new Uint8Array(64 + 4);
  buf[64] = 0xff;
  buf[65] = 0x80;
  // remaining zeros — flushes shifter back
  const parser9 = {
    getRawTrackBytes: (track) => (track === 18 ? buf : null),
  };
  const head = new HeadPosition({ startTrack: 18 });
  const shifter = new GcrShifter({
    parser: /** @type {any} */ (parser9),
    headPosition: head,
  });
  shifter.setMotor(true);
  shifter.setDensity(2);
  let sawSync = false;
  shifter.onSyncDetected = (active) => { if (active) sawSync = true; };
  for (let i = 0; i < 4000; i++) shifter.tick(1);
  check("9 consecutive 1-bits (< 10) MUST NOT trigger SYNC",
        !sawSync, `sawSync=${sawSync}`);
}

// --- Sub-test 3: exactly 10 consecutive ones DOES trigger SYNC -------
// 0xFF (8 ones) + 0xC0 (2 ones then 6 zeros) = 10 ones followed by 0.
{
  const buf = new Uint8Array(64 + 4);
  buf[64] = 0xff;
  buf[65] = 0xc0;
  const parser10 = {
    getRawTrackBytes: (track) => (track === 18 ? buf : null),
  };
  const head = new HeadPosition({ startTrack: 18 });
  const shifter = new GcrShifter({
    parser: /** @type {any} */ (parser10),
    headPosition: head,
  });
  shifter.setMotor(true);
  shifter.setDensity(2);
  let sawSync = false;
  shifter.onSyncDetected = (active) => { if (active) sawSync = true; };
  for (let i = 0; i < 4000; i++) shifter.tick(1);
  check("10 consecutive 1-bits (>= 10) MUST trigger SYNC",
        sawSync, `sawSync=${sawSync}`);
}

// --- Report ----------------------------------------------------------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`Spec 412 smoke B — SYNC detection — ${pass}/${results.length} pass, ${fail} fail`);
for (const r of results) {
  if (!r.pass) console.log(`  [FAIL] ${r.label}: ${r.detail}`);
}
if (fail > 0) process.exit(1);
