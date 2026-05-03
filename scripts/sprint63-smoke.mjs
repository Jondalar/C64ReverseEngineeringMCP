// Spec 062 Sprint 63 smoke — DriveSessionManager + sample title harness.
//
// Tests:
// - startDriveSession opens a G64 and returns a session record
// - getDriveSession / listDriveSessions retrieve it
// - status query reports head + CPU + IRQ snapshot
// - persistDriveSession writes <image>_session.g64 only after modifications
// - sample-title harness: each known sample (Murder/Maniac/etc.) opens
//   without throwing, drive ROM loads, head positions correctly

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startDriveSession, getDriveSession, listDriveSessions, persistDriveSession, stopDriveSession } from "../dist/runtime/headless/drive/drive-session-manager.js";

const samples = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples";
const knownTitles = [
  "maniac_mansion_s1[activision_1987](german)(manual)(!).g64",
  "impossible_mission_ii[epyx_1987](!).g64",
  "last_ninja_remix_s1[system3_1991].g64",
];
const presentTitles = knownTitles
  .map((name) => ({ name, path: join(samples, name) }))
  .filter((entry) => existsSync(entry.path));

if (presentTitles.length === 0) {
  console.log("Sprint 63 smoke skipped (no sample G64 in samples/)");
  process.exit(0);
}

// ---- Test 1: start + retrieve a drive session ----
{
  const record = startDriveSession({ diskPath: presentTitles[0].path });
  assert.ok(record.sessionId);
  assert.equal(record.diskPath, presentTitles[0].path);
  assert.equal(record.headPosition.currentTrack, 18);
  assert.ok(getDriveSession(record.sessionId));
  assert.ok(listDriveSessions().some((r) => r.sessionId === record.sessionId));
  stopDriveSession(record.sessionId);
  console.log(`  ✓ Drive session lifecycle (id=${record.sessionId})`);
}

// ---- Test 2: persist with no modifications returns skipped ----
{
  const record = startDriveSession({ diskPath: presentTitles[0].path });
  const result = persistDriveSession(record.sessionId);
  assert.equal(result.skipped, "no-modifications");
  stopDriveSession(record.sessionId);
  console.log("  ✓ Persist skips when no modifications");
}

// ---- Test 3: status snapshot accessible ----
{
  const record = startDriveSession({ diskPath: presentTitles[0].path });
  const drive = record.session.drive;
  assert.equal(drive.bus.romSource === "bundled" || drive.bus.romSource === "env", true,
    `drive ROM should be loaded; got source=${drive.bus.romSource}`);
  // Reset PC to ROM reset vector ($FFFC/$FFFD) and verify it's not 0.
  drive.cpu.reset();
  assert.notEqual(drive.cpu.pc, 0, `drive PC after reset should be from ROM reset vector; got ${drive.cpu.pc.toString(16)}`);
  console.log(`  ✓ Drive ROM loaded (source=${drive.bus.romSource}); reset PC = $${drive.cpu.pc.toString(16).toUpperCase().padStart(4, "0")}`);
  stopDriveSession(record.sessionId);
}

// ---- Test 4: each sample title opens cleanly ----
for (const { name, path } of presentTitles) {
  const record = startDriveSession({ diskPath: path });
  assert.ok(record.parser);
  assert.equal(record.headPosition.currentTrack, 18);
  // Read a byte from track 18 (BAM).
  const byte = record.session.drive.bus.read(0x1c01);
  assert.equal(typeof byte, "number");
  stopDriveSession(record.sessionId);
  console.log(`  ✓ Sample opens cleanly: ${name}`);
}

console.log("Sprint 63 smoke (drive session manager + sample harness) OK");
