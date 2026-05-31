// BUG-023 — custom true-drive (drive-side GCR) write persistence classifier.
//
// Product class under test: "custom/fastloader save paths on D64 do not
// persist" (Wasteland Utils Copy + Scramble HighScore — both .d64, both write
// via drive-side GCR head writes through STA $1C01, NOT KERNAL/DOS SAVE).
//
// This gate drives the REAL drive write path (`write_next_bit`, the same sink
// `store_pra` feeds from $1C01) into a writable disk image and asks, layer by
// layer, where the bytes stop:
//
//   A. standard CBM-GCR sector write → D64   → does it persist?
//   B. custom/non-standard GCR write   → D64  → lossy? (observed, not green)
//   C. same custom GCR via the verbatim GCR path (snapshot/restore = G64-class)
//   C2.dirty flag set on the GCR write?
//   D. persistence boundary: writes live only in the GCR buffer until a
//      writeback trigger (seek/detach); a snapshot-without-detach does NOT
//      flush the D64 (drive_gcr_data_writeback_all is a no-op).
//
// It CLASSIFIES (decode-bug vs dirty/flush-bug vs D64-unsuitable vs
// G64-works); it does not assert a product fix.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const note = (m) => console.log(`  ----  ${m}`);

console.log("BUG-023 — custom true-drive GCR write persistence classifier\n");

const dist = join(ROOT, "dist/runtime/headless");
if (!existsSync(join(dist, "drive1541/vice1541-facade.js"))) { console.error("build:mcp first"); process.exit(2); }
const { Vice1541Facade } = await import(join(dist, "drive1541/vice1541-facade.js"));
const { write_next_bit } = await import(join(dist, "vice1541/rotation.js"));
const { drive_set_half_track } = await import(join(dist, "vice1541/drive.js"));
const { gcr_find_sector_header, CBMDOS_FDC_ERR_OK } = await import(join(dist, "vice1541/gcr.js"));

// ── D64 geometry ────────────────────────────────────────────────────────────
const SPT = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
function d64SectorOffset(track, sector) {
  let off = 0;
  for (let t = 1; t < track; t++) off += SPT(t) * 256;
  return off + sector * 256;
}
function blankD64() { return new Uint8Array(683 * 256); }

const TRACK = 20, SECTOR = 5;
const TRK_IDX = TRACK * 2 - 2; // gcr.tracks[half_track-2]
const PATTERN = new Uint8Array(256);
for (let i = 0; i < 256; i++) PATTERN[i] = (i ^ 0x5a) & 0xff;

function driveOf(f) { return f.diskunit.drives[0]; }

// Encode a standard CBM-GCR track via the port's OWN attach pipeline: put the
// pattern into a D64 sector, attach it, read the live (standard) GCR track.
function encodeStdTrackGcr() {
  const d64 = blankD64();
  d64.set(PATTERN, d64SectorOffset(TRACK, SECTOR));
  const f = new Vice1541Facade();
  f.attachDisk({ kind: "d64", bytes: d64, readOnly: false });
  const trk = driveOf(f).gcr.tracks[TRK_IDX];
  const gcr = Uint8Array.from(trk.data.subarray(0, trk.size));
  const size = trk.size;
  f.detachDisk();
  return { gcr, size };
}

// Write a full track through the REAL write path (write_next_bit), exactly as
// STA $1C01 → store_pra → rotation does, bit by bit MSB-first.
function writeTrackViaBits(f, track, gcr, size) {
  const d = driveOf(f);
  drive_set_half_track(track * 2, d.side, d);
  d.read_write_mode = 1;
  d.GCR_image_loaded = d.GCR_image_loaded || 1;
  d.GCR_head_offset = 0;
  for (let b = 0; b < size; b++) {
    const byte = gcr[b];
    for (let bit = 7; bit >= 0; bit--) write_next_bit(d, (byte >> bit) & 1);
  }
}

const eq = (a, b, off = 0) => { for (let i = 0; i < b.length; i++) if (a[off + i] !== b[i]) return false; return true; };

// ── A. standard CBM-GCR sector write → D64 ───────────────────────────────────
let standardD64Persists = false, dirtySet = false, writebackRan = false, boundaryIsDetach = false;
{
  const { gcr, size } = encodeStdTrackGcr();
  const d64 = blankD64();
  const f = new Vice1541Facade();
  f.attachDisk({ kind: "d64", bytes: d64, readOnly: false });
  writeTrackViaBits(f, TRACK, gcr, size);

  dirtySet = driveOf(f).GCR_dirty_track === 1;
  ok(dirtySet, "C2 GCR write sets GCR_dirty_track (the $1C01 write path dirties the track)", `dirty=${driveOf(f).GCR_dirty_track}`);

  // D. boundary: before any writeback trigger the D64 bytes are still blank.
  const beforeDetach = !d64.subarray(d64SectorOffset(TRACK, SECTOR), d64SectorOffset(TRACK, SECTOR) + 256).some((b) => b !== 0);
  ok(beforeDetach, "D writes live only in the GCR buffer until a writeback trigger (D64 still blank pre-detach)");

  f.detachDisk(); // seek/detach → drive_gcr_data_writeback
  const sectorBytes = d64.subarray(d64SectorOffset(TRACK, SECTOR), d64SectorOffset(TRACK, SECTOR) + 256);
  writebackRan = sectorBytes.some((b) => b !== 0);
  boundaryIsDetach = writebackRan && beforeDetach;
  standardD64Persists = eq(d64, PATTERN, d64SectorOffset(TRACK, SECTOR));
  ok(writebackRan, "D detach triggers writeback (D64 bytes change after detach)");
  ok(standardD64Persists, "A standard CBM-GCR sector write PERSISTS to D64 (T20/S5 == pattern)",
    standardD64Persists ? "256/256 bytes" : `first byte got $${sectorBytes[0].toString(16)} want $${PATTERN[0].toString(16)}`);
}

// ── B. custom / non-standard GCR write → D64 (expect lossy) ──────────────────
let customD64Persists = false, corruptedGcr, corruptedSize;
{
  const { gcr, size } = encodeStdTrackGcr();
  corruptedGcr = Uint8Array.from(gcr); corruptedSize = size;
  // Make sector 5 non-standard: scramble its data block so the CBM decoder
  // (gcr_read_sector) cannot read it — Wasteland/krill-class custom encoding.
  const raw = { data: corruptedGcr, size };
  const pBits = gcr_find_sector_header(raw, SECTOR); // bit offset of S5 header
  const corruptStart = pBits >= 0 ? (pBits >> 3) + 12 : Math.floor(size / 2);
  for (let i = 0; i < 96 && corruptStart + i < size; i++) corruptedGcr[corruptStart + i] = 0x55;

  const d64 = blankD64();
  const f = new Vice1541Facade();
  f.attachDisk({ kind: "d64", bytes: d64, readOnly: false });
  writeTrackViaBits(f, TRACK, corruptedGcr, corruptedSize);
  f.detachDisk();
  const sectorBytes = d64.subarray(d64SectorOffset(TRACK, SECTOR), d64SectorOffset(TRACK, SECTOR) + 256);
  customD64Persists = eq(d64, PATTERN, d64SectorOffset(TRACK, SECTOR));
  // Observed classification — NOT asserted as product-green.
  if (customD64Persists) note("B custom/non-standard GCR write on D64: PERSISTED (decoder tolerated it)");
  else note(`B custom/non-standard GCR write on D64: LOST — S5 not recoverable (first byte $${sectorBytes[0].toString(16)}). D64 writeback is lossy for non-standard GCR.`);
  ok(true, "B custom-D64 observed (classification, not a product gate)");
}

// ── C. same custom GCR via verbatim GCR path (snapshot/restore = G64-class) ───
let verbatimPersists = false;
{
  const d64 = blankD64();
  const f = new Vice1541Facade();
  f.attachDisk({ kind: "d64", bytes: d64, readOnly: false });
  writeTrackViaBits(f, TRACK, corruptedGcr, corruptedSize);
  let blob = null;
  try { blob = f.snapshotDiskImage(); } catch (e) { note(`C snapshotDiskImage threw: ${e.message}`); }
  if (blob) {
    const g = new Vice1541Facade();
    g.attachDisk({ kind: "d64", bytes: blankD64(), readOnly: false });
    try { g.restoreDiskImage(blob); } catch (e) { note(`C restoreDiskImage threw: ${e.message}`); }
    const trk = driveOf(g).gcr.tracks[TRK_IDX];
    verbatimPersists = trk && trk.data && eq(trk.data, corruptedGcr.subarray(0, corruptedSize));
  }
  ok(verbatimPersists, "C verbatim GCR persistence (snapshot/restore, the G64-class raw path) preserves the custom write byte-for-byte",
    verbatimPersists ? `${corruptedSize} GCR bytes round-trip` : "GCR did not round-trip verbatim");
}

// ── Classification ────────────────────────────────────────────────────────────
console.log("\n=== CLASSIFICATION ===");
const lines = [];
lines.push(`A standard CBM-GCR → D64:        ${standardD64Persists ? "PASS (persists)" : "FAIL (lost)"}`);
lines.push(`B custom/non-standard → D64:     ${customD64Persists ? "persisted" : "LOSSY (dropped)"}`);
lines.push(`C verbatim GCR (snapshot/G64):   ${verbatimPersists ? "PASS (verbatim)" : "FAIL"}`);
lines.push(`C2 $1C01 write sets dirty flag:  ${dirtySet ? "yes" : "NO"}`);
lines.push(`D writeback fires on detach:     ${writebackRan ? "yes" : "NO"}  (boundary=${boundaryIsDetach ? "detach/seek only" : "?"})`);
for (const l of lines) console.log("  " + l);

console.log("\n=== VERDICT ===");
if (!dirtySet) console.log("  → $1C01/GCR write does NOT dirty the track: dirty-path bug (write never recorded).");
else if (!writebackRan) console.log("  → dirty set but detach does not flush: writeback/flush-trigger bug.");
else if (!standardD64Persists) console.log("  → even STANDARD drive-side GCR write is lost on D64: D64 writeback/decode path bug (not custom-specific).");
else if (!customD64Persists && verbatimPersists)
  console.log("  → standard D64 write persists, custom/non-standard is dropped, verbatim (G64-class) keeps it:\n    D64 is UNSUITABLE for non-standard custom-GCR true-drive saves (lossy GCR→sector decode).\n    Product needs format-aware/verbatim writeback OR a G64-backed writable target for custom-save media.\n    G64/verbatim is the short-term workaround; D64 custom-save is a policy/bug decision.");
else if (!customD64Persists && !verbatimPersists)
  console.log("  → custom write lost on BOTH D64 and verbatim path: deeper write-path bug.");
else console.log("  → custom write persisted on D64: no reproduction here (decoder tolerated this fixture).");

// Gate is green when the CLASSIFIER ran cleanly: standard write must persist
// (else it's a plain bug we assert), dirty+writeback must fire, verbatim must
// work. The custom-D64 loss is reported, not failed (that's the open product
// decision BUG-023 tracks).
ok(dirtySet && writebackRan, "classifier: dirty + detach-writeback path is exercised");
ok(standardD64Persists, "classifier: standard drive-side GCR write round-trips on D64 (baseline sanity)");
ok(verbatimPersists, "classifier: verbatim GCR path preserves custom writes (workaround proven)");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-023: ${pass} pass, ${fail} fail.`);
console.log(fail === 0 ? "(classifier ran; custom-D64 persistence is the open product decision — see verdict)" : "");
process.exit(fail === 0 ? 0 : 1);
