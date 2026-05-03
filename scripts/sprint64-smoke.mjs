// Spec 062 Sprint 64 smoke — VSF read/write for the modeled drive subset.
//
// Tests:
// - VsfWriter + readVsf round-trip a synthetic file with multiple modules
// - saveDriveSessionVsf produces a valid VSF
// - loadDriveSessionVsf restores drive CPU + RAM + VIA state + IEC bus + GCR head
// - Loading a VSF with unknown modules reports them as "ignored" (no error)
// - Magic mismatch raises a clear error

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { VsfWriter, readVsf, VSF_MAGIC_BYTES } from "../dist/runtime/headless/vsf/vsf-format.js";
import { startDriveSession, stopDriveSession } from "../dist/runtime/headless/drive/drive-session-manager.js";
import { saveDriveSessionVsf, loadDriveSessionVsf } from "../dist/runtime/headless/vsf/drive-vsf.js";

// ---- Test 1: VSF format round-trip ----
{
  const w = new VsfWriter("C64");
  w.addModule("MODA", new Uint8Array([0x11, 0x22, 0x33]));
  w.addModule("MODB", new Uint8Array([0xaa, 0xbb]), 2, 5);
  const bytes = w.toBytes();
  const f = readVsf(bytes);
  assert.equal(f.machineName, "C64");
  assert.equal(f.modules.length, 2);
  assert.equal(f.modules[0].name, "MODA");
  assert.deepEqual([...f.modules[0].data], [0x11, 0x22, 0x33]);
  assert.equal(f.modules[1].name, "MODB");
  assert.equal(f.modules[1].versionMajor, 2);
  assert.equal(f.modules[1].versionMinor, 5);
  console.log("  ✓ VSF format round-trip");
}

// ---- Test 2: Magic mismatch raises ----
{
  const fake = new Uint8Array(20);
  fake.set(new TextEncoder().encode("not a vsf at all"));
  let threw = false;
  try { readVsf(fake); } catch { threw = true; }
  assert.ok(threw, "wrong magic should throw");
  console.log("  ✓ Magic mismatch raises");
}

// ---- Find a sample to use ----
const samples = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples";
const candidates = [
  "maniac_mansion_s1[activision_1987](german)(manual)(!).g64",
  "impossible_mission_ii[epyx_1987](!).g64",
];
let sampleG64 = null;
for (const c of candidates) {
  const p = join(samples, c);
  if (existsSync(p)) { sampleG64 = p; break; }
}
if (!sampleG64) {
  console.log("Sprint 64 smoke partial (VSF format OK; sample-roundtrip skipped — no G64 in samples/)");
  process.exit(0);
}

// ---- Test 3: drive session save → load → state matches ----
{
  const tmp = mkdtempSync(join(tmpdir(), "sprint64-vsf-"));
  try {
    const r1 = startDriveSession({ diskPath: sampleG64 });
    // Mutate some state.
    r1.session.drive.bus.ram[0x0100] = 0xaa;
    r1.session.drive.bus.ram[0x0200] = 0xbb;
    r1.session.drive.cpu.a = 0x42;
    r1.session.drive.cpu.x = 0x99;
    r1.session.drive.cpu.pc = 0xc500;
    r1.session.drive.bus.via1.ddra = 0xff;
    r1.session.drive.bus.via1.ora = 0x55;
    r1.session.drive.bus.via2.t1Latch = 0x1234;
    // Modify a track via the bus.
    r1.session.drive.bus.write(0x1c03, 0xff);
    r1.session.drive.bus.write(0x1c01, 0xde);
    // Pull ATN low so IEC bus state is non-default.
    r1.session.iecBus.setC64Output(0xff & ~(1 << 3), 0xff);

    const vsfPath = join(tmp, "test.vsf");
    const saved = saveDriveSessionVsf(r1, vsfPath);
    assert.ok(saved.bytesWritten > 0);
    assert.ok(existsSync(vsfPath));

    // Open a fresh session, load VSF into it.
    const r2 = startDriveSession({ diskPath: sampleG64 });
    const loaded = loadDriveSessionVsf(r2, vsfPath);
    assert.equal(loaded.errors.length, 0, `no load errors; got ${JSON.stringify(loaded.errors)}`);
    assert.equal(loaded.ignoredModules.length, 0, `no ignored modules expected for self-roundtrip`);
    // Verify state restored.
    assert.equal(r2.session.drive.bus.ram[0x0100], 0xaa, "RAM byte $0100 restored");
    assert.equal(r2.session.drive.bus.ram[0x0200], 0xbb, "RAM byte $0200 restored");
    assert.equal(r2.session.drive.cpu.a, 0x42, "A register restored");
    assert.equal(r2.session.drive.cpu.x, 0x99, "X register restored");
    assert.equal(r2.session.drive.cpu.pc, 0xc500, "PC restored");
    assert.equal(r2.session.drive.bus.via1.ddra, 0xff, "VIA1 DDRA restored");
    assert.equal(r2.session.drive.bus.via1.ora, 0x55, "VIA1 ORA restored");
    assert.equal(r2.session.drive.bus.via2.t1Latch, 0x1234, "VIA2 T1 latch restored");
    assert.equal(r2.session.iecBus.snapshot().line.atn, false, "IEC ATN line state restored (low)");
    // GCR head: modified track 18 with $DE at byte 0
    const mods = r2.trackBuffer.modifiedTracks();
    assert.ok(mods.size > 0, "modified tracks restored");
    console.log(`  ✓ Drive session VSF round-trip: ${saved.bytesWritten} bytes, ${loaded.loadedModules.length} modules`);
    stopDriveSession(r1.sessionId);
    stopDriveSession(r2.sessionId);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- Test 4: Loading VSF with unknown modules reports ignored, no error ----
{
  const tmp = mkdtempSync(join(tmpdir(), "sprint64-vsf-ignore-"));
  try {
    const w = new VsfWriter("C64");
    w.addModule("DRIVECPU", new Uint8Array(11)); // valid empty drive CPU
    w.addModule("VIC", new Uint8Array([0xff, 0xee, 0xdd])); // unknown to us
    w.addModule("SID", new Uint8Array([0xaa, 0xbb])); // unknown
    const path = join(tmp, "mixed.vsf");
    writeFileSync(path, w.toBytes());
    const r = startDriveSession({ diskPath: sampleG64 });
    const loaded = loadDriveSessionVsf(r, path);
    assert.equal(loaded.loadedModules.length, 1, "1 module loaded (DRIVECPU)");
    assert.deepEqual(loaded.ignoredModules.sort(), ["SID", "VIC"], "VIC + SID ignored");
    console.log("  ✓ Unknown modules reported ignored, no error");
    stopDriveSession(r.sessionId);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("Sprint 64 smoke (VSF read/write) OK");
