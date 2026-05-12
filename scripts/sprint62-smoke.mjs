// Spec 062 Sprint 62 smoke — GCR drive-side I/O + write back + persist.
//
// Tests:
// - Head-step gray-code: VIA2 PB STEP bits drive head positioner
// - $1C01 read returns expected GCR bytes from a real G64
// - SYNC detection ($1800 PB bit 7 from VIA2 PB7) when head over $FF run
// - $1C01 write modifies in-memory track buffer
// - persistTrackBuffer writes <image>_session.g64 with modifications
// - Original image untouched

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { G64Parser } from "../dist/disk/g64-parser.js";
import { DriveCpu } from "../dist/runtime/headless/drive/drive-cpu.js";
import { HeadPosition, TrackBuffer } from "../dist/runtime/headless/drive/head-position.js";
import { persistTrackBuffer, defaultSessionG64Path } from "../dist/runtime/headless/drive/session-persist.js";
import { PB_STEP_LO, PB_STEP_HI } from "../dist/runtime/headless/drive/via2-gcr.js";

// Locate a sample G64. Prefer Maniac Mansion side 1 since the user
// confirmed it; fall back to anything in samples/.
function pickSampleG64() {
  const samples = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples";
  const candidates = [
    "maniac_mansion_s1[activision_1987](german)(manual)(!).g64",
    "impossible_mission_ii[epyx_1987](!).g64",
    "last_ninja_remix_s1[system3_1991].g64",
  ];
  for (const c of candidates) {
    const p = join(samples, c);
    if (existsSync(p)) return p;
  }
  return null;
}

const sampleG64Path = pickSampleG64();
if (!sampleG64Path) {
  console.log("Sprint 62 smoke skipped (no sample G64 in samples/)");
  process.exit(0);
}

const parser = new G64Parser(readFileSync(sampleG64Path));
const trackBuffer = new TrackBuffer(parser);
const headPosition = new HeadPosition({ startTrack: 18 });
const drive = new DriveCpu({ gcr: { trackBuffer, headPosition } });

// ---- Test 1: head-step gray-code advances track ----
{
  const start = headPosition.currentTrack;
  // Inward sequence: 00 → 01 → 11 → 10 → 00. Each transition = +0.5.
  drive.bus.via2.write(0x2, 0x03); // DDRB = output for STEP bits
  drive.bus.via2.write(0x0, 0x00); // STEP=00
  drive.bus.via2.write(0x0, 0x01); // STEP=01 → +0.5
  drive.bus.via2.write(0x0, 0x03); // STEP=11 → +0.5
  drive.bus.via2.write(0x0, 0x02); // STEP=10 → +0.5
  drive.bus.via2.write(0x0, 0x00); // STEP=00 → +0.5
  assert.equal(headPosition.currentTrack, start + 2, `head moved 4 half-steps inward (${start} → ${start + 2})`);
  console.log(`  ✓ Head-step gray-code: ${start} → ${headPosition.currentTrack}`);
}

// ---- Test 2: $1C01 read returns track byte stream ----
{
  // Reset head back to track 18.
  headPosition.reset(18);
  trackBuffer.resetByteCursor();
  // Read a few bytes from track 18 directly via the CPU bus.
  const b1 = drive.bus.read(0x1c01);
  const b2 = drive.bus.read(0x1c01);
  // Compare against parser-direct read.
  const raw = parser.getRawTrackBytes(18);
  assert.ok(raw, "track 18 has data");
  assert.equal(b1, raw[0], "first byte from $1C01 matches track-stream byte 0");
  assert.equal(b2, raw[1], "second byte matches stream byte 1");
  console.log(`  ✓ $1C01 read returns track byte stream (track 18 byte 0 = $${b1.toString(16).padStart(2, "0")})`);
}

// ---- Test 3: SYNC detection — find a sync mark in the track ----
{
  headPosition.reset(18);
  trackBuffer.resetByteCursor();
  const raw = parser.getRawTrackBytes(18);
  // Walk byte-by-byte until SYNC reports. Real tracks have at least
  // one sync mark (10+ consecutive $FF bytes) per sector header.
  let syncFound = false;
  for (let i = 0; i < raw.length; i++) {
    drive.bus.read(0x1c01);
    // PB read returns SYNC bit (PB7) — 0 = sync detected.
    const pb = drive.bus.read(0x1c00);
    if ((pb & 0x80) === 0) { syncFound = true; break; }
  }
  assert.ok(syncFound, "found at least one SYNC mark in track 18");
  console.log("  ✓ SYNC detection works (track 18)");
}

// ---- Test 4: $1C01 write modifies track buffer ----
{
  headPosition.reset(20);
  trackBuffer.resetByteCursor();
  const beforeRaw = parser.getRawTrackBytes(20);
  // Write all-output mode + write a sentinel byte.
  drive.bus.write(0x1c03, 0xff);  // DDRA = $FF (output)
  drive.bus.write(0x1c01, 0xa5);  // write $A5 to current head position
  assert.ok(trackBuffer.isModified(), "track buffer flagged modified");
  // Re-read the byte we just wrote — buffer cursor advanced, reset to confirm.
  trackBuffer.resetByteCursor();
  // Read should return $A5 (we wrote at byte 0 of track 20)
  const readBack = drive.bus.read(0x1c01);
  assert.equal(readBack, 0xa5, "wrote-then-read returns $A5");
  // Ensure original parser bytes untouched (deep copy semantic).
  assert.equal(beforeRaw[0], parser.getRawTrackBytes(20)[0], "parser's underlying bytes unchanged");
  console.log("  ✓ $1C01 write modifies buffer; original parser bytes preserved");
}

// ---- Test 5: persist creates <image>_session.g64 ----
{
  const tempDir = mkdtempSync(join(tmpdir(), "sprint62-persist-"));
  try {
    const localG64 = join(tempDir, "test.g64");
    writeFileSync(localG64, parser.getRawImageBytes());
    const localParser = new G64Parser(readFileSync(localG64));
    const localBuffer = new TrackBuffer(localParser);
    const localHead = new HeadPosition({ startTrack: 22 });
    const localDrive = new DriveCpu({ gcr: { trackBuffer: localBuffer, headPosition: localHead } });
    localDrive.bus.write(0x1c03, 0xff);
    localDrive.bus.write(0x1c01, 0xde);
    const result = persistTrackBuffer(localParser, localBuffer, localG64);
    assert.equal(result.outputPath, defaultSessionG64Path(localG64));
    assert.ok(existsSync(result.outputPath), "session G64 written to disk");
    assert.deepEqual(result.modifiedTracks, [22]);
    // Re-load + verify modification preserved.
    const persistedParser = new G64Parser(readFileSync(result.outputPath));
    const persisted = persistedParser.getRawTrackBytes(22);
    assert.equal(persisted[0], 0xde, "first byte of track 22 = $DE in persisted file");
    // Original local file still untouched.
    const original = new G64Parser(readFileSync(localG64));
    assert.notEqual(original.getRawTrackBytes(22)[0], 0xde, "original G64 untouched");
    console.log(`  ✓ Persist writes ${result.outputPath} (${result.bytesWritten} bytes); track 22 modified; original preserved`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log("Sprint 62 smoke (GCR drive-side I/O + write back + persist) OK");
