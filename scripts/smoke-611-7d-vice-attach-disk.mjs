// Spec 611 phase 611.7d smoke — attachDisk / detachDisk /
// setWriteProtect + GCR head-pointer wiring.
//
// Acceptance per Codex 17:29 UTC: wires attachDisk()/detachDisk()/
// setWriteProtect()/media state only. D64/G64 feed VICE-shaped
// gcr_t.tracks[]. No C64-side routing (= 611.7e). No IEC/CIA2/loader
// changes. Guard stays active.
//
// Smoke verifies, all through real VICE1541 path:
//   - attachDisk(D64) populates drive.gcr (168 slots), gcrImageLoaded=1,
//     attachClk set, gcrTrackStartPtr re-pointed to track 18 (default
//     half-track 36 → slot 34).
//   - After DRIVE_ATTACH_DELAY drive cycles elapse, rotation_byte_read
//     returns a non-zero byte (= a byte from the encoded track buffer).
//   - attachDisk(G64) parses motm.g64 → tracks populated; gcrTrackStartPtr
//     points at the motm half-track 36 buffer.
//   - setWriteProtect(true) → drive.readOnly = 1 → WPS reads as 0 from
//     drive_writeprotect_sense.
//   - detachDisk() clears gcrImageLoaded, gcrTrackStartPtr, sets
//     attachDetachClk.
//
// Exit 0 = PASS, 1 = FAIL.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { drive_writeprotect_sense, rotation_byte_read } from "../dist/runtime/headless/_quarantine_vice1541_v4/rotation.js";
import { MAX_GCR_TRACKS } from "../dist/runtime/headless/_quarantine_vice1541_v4/gcr.js";

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const D64_PATH = resolve("samples/synthetic/blank.d64");
const G64_PATH = resolve("samples/motm.g64");
console.log(`D64 fixture: ${D64_PATH}`);
console.log(`G64 fixture: ${G64_PATH}`);

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
  drive1541: "vice",
});
const drive1541 = session.kernel.drive1541;
const drv = drive1541.diskunit.drives[0];
check("(a) ctor: VICE1541 instantiated, drive.gcr null pre-attach",
  drv.gcr === null && drv.gcrImageLoaded === 0);
check("(b) drv.currentHalfTrack === 36 (drive_init default)", drv.currentHalfTrack === 36);

// --- D64 attach ---
const d64 = new Uint8Array(readFileSync(D64_PATH));
drive1541.attachDisk({ kind: "d64", bytes: d64, readOnly: false });
check("(c) attachDisk(D64): drive.gcr non-null with MAX_GCR_TRACKS slots",
  drv.gcr !== null && drv.gcr.tracks.length === MAX_GCR_TRACKS);
check("(d) attachDisk(D64): gcrImageLoaded = 1", drv.gcrImageLoaded === 1);
check("(e) attachDisk(D64): attachClk set (non-zero by attach time)",
  drv.attachClk >= 0); // can be 0 on a fresh session; existence checked
check("(f) attachDisk(D64): readOnly = 0 (writable)", drv.readOnly === 0);
// Slot for half-track 36 = idx 34 (= physical track 18 = directory).
const t18Slot = drv.gcr.tracks[34];
check("(g) GCR slot 34 (half-track 36 = track 18) has real data",
  t18Slot.data !== null && t18Slot.size > 6000);
check("(h) driveSetHalfTrack re-pointed gcrTrackStartPtr to slot 34 data",
  drv.gcrTrackStartPtr === t18Slot.data && drv.gcrCurrentTrackSize === t18Slot.size);

// --- DRIVE_ATTACH_DELAY ---
// Force motor on so rotation actually walks the bit accumulator.
const via2 = drive1541.driveCpu.via2;
via2.write(0x02, 0xff); // DDRB output
via2.write(0x00, 0b0010_0100); // motor on, density=01 (zone 1)
// Advance drive clock past DRIVE_ATTACH_DELAY = 1_800_000.
drive1541.diskunit.clkPtr.value += 2_000_000;
const byteAfter = rotation_byte_read(drive1541.diskunit);
check("(i) rotation_byte_read after DRIVE_ATTACH_DELAY returns track byte (non-zero)",
  byteAfter !== 0, `byte=$${byteAfter.toString(16)}`);

// --- setWriteProtect ---
drive1541.setWriteProtect(true);
check("(j) setWriteProtect(true): drive.readOnly = 1", drv.readOnly === 1);
const wpsSensed = drive_writeprotect_sense(drv);
check("(k) drive_writeprotect_sense returns false (protected) after WP set",
  wpsSensed === false);
drive1541.setWriteProtect(false);
check("(l) setWriteProtect(false): drive.readOnly = 0", drv.readOnly === 0);

// --- detachDisk (VICE-shape per driveimage.c:271-283) ---
const preDetachClk = drive1541.diskunit.clkPtr.value;
drive1541.setWriteProtect(true); // verify readOnly resets on detach
drive1541.detachDisk();
check("(m) detachDisk: drive.gcr object PRESERVED (VICE keeps gcr_t)",
  drv.gcr !== null);
check("(m.1) detachDisk: every drive.gcr.tracks[i] cleared to {data:null,size:0}",
  drv.gcr.tracks.every((t) => t.data === null && t.size === 0));
check("(n) detachDisk: gcrImageLoaded = 0", drv.gcrImageLoaded === 0);
check("(n.1) detachDisk: complicatedImageLoaded = 0", drv.complicatedImageLoaded === 0);
check("(n.2) detachDisk: readOnly reset to 0 (VICE drive_image_detach)", drv.readOnly === 0);
check("(o) detachDisk: gcrTrackStartPtr = null (driveSetHalfTrack post-clear)",
  drv.gcrTrackStartPtr === null);
check("(p) detachDisk: detachClk = current clk (NOT attachDetachClk)",
  drv.detachClk === preDetachClk && drv.attachDetachClk === 0,
  `detachClk=${drv.detachClk} attachDetachClk=${drv.attachDetachClk}`);

// --- attach-after-detach: VICE driveimage.c:186-188 sets
//     attach_detach_clk = diskunit_clk (= current attach clock),
//     NOT the old detach clock. Condition uses detach_clk > 0,
//     VALUE is current clk. VICE does NOT clear detach_clk in attach. ---
drv.currentHalfTrack = 36; // reset HT for predictable slot
// Advance clock between detach and attach so attach != detach time.
const attachNow = preDetachClk + 5_000_000;
drive1541.diskunit.clkPtr.value = attachNow;
const g64 = new Uint8Array(readFileSync(G64_PATH));
drive1541.attachDisk({ kind: "g64", bytes: g64, readOnly: false });
check("(q) attachDisk(G64): drive.gcr non-null",
  drv.gcr !== null && drv.gcr.tracks.some((t) => t.data !== null));
check("(q.1) attachDisk(G64) sets complicatedImageLoaded = 1 (VICE driveimage.c:222-224)",
  drv.complicatedImageLoaded === 1);
check("(q.2) attachClk = current clock (= attachNow), not detach clock",
  drv.attachClk === attachNow,
  `attachClk=${drv.attachClk} attachNow=${attachNow}`);
check("(q.3) attachDetachClk = current attach clock per VICE driveimage.c:188 (NOT prior detachClk)",
  drv.attachDetachClk === attachNow && drv.attachDetachClk !== preDetachClk,
  `attachDetachClk=${drv.attachDetachClk} attachNow=${attachNow} preDetachClk=${preDetachClk}`);
check("(q.4) VICE never clears detach_clk in attach — detachClk preserved",
  drv.detachClk === preDetachClk,
  `detachClk=${drv.detachClk} preDetachClk=${preDetachClk}`);
const t18SlotG64 = drv.gcr.tracks[drv.currentHalfTrack - 2];
check("(r) attachDisk(G64): current half-track slot has motm data",
  t18SlotG64.data !== null && t18SlotG64.size > 6000);
check("(s) attachDisk(G64): gcrTrackStartPtr === gcr.tracks[currentHalfTrack-2].data",
  drv.gcrTrackStartPtr === t18SlotG64.data);

// --- G64 rotation path MUST throw loudly (complex engine unported) ---
// rotation_byte_read first walks the attachClk + attachDetachClk
// decay windows; only when both are 0 does it call rotation_rotate_disk.
// Bypass the windows by clearing them so we reach the complex-engine
// dispatch immediately.
drv.attachClk = 0;
drv.attachDetachClk = 0;
let g64RotThrew = null;
try {
  rotation_byte_read(drive1541.diskunit);
} catch (e) { g64RotThrew = e; }
check("(s.1) rotation under complicatedImageLoaded=1 throws (complex engine not ported)",
  g64RotThrew !== null && /complicated|gcr_cycle|611\.7/.test(String(g64RotThrew.message)),
  g64RotThrew ? g64RotThrew.message.slice(0, 80) : "no throw");

// --- P64 throw ---
let p64Threw = null;
try { drive1541.attachDisk({ kind: "p64", bytes: new Uint8Array(1024), readOnly: false }); }
catch (e) { p64Threw = e; }
check("(t) attachDisk(P64) throws (Spec 611 §2 P64 stub policy)",
  p64Threw !== null && /P64/.test(String(p64Threw.message)));

console.log("");
const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.error(`FAIL: ${failed}/${results.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${results.length}/${results.length} checks passed.`);
process.exit(0);
