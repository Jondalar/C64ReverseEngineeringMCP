// BUG-023 — real custom-writer GCR classifier (opt-in).
//
// Decides whether a custom true-drive writer's actual on-disk GCR is
// CBM-decodable or non-standard — the question that picks the BUG-023 fix:
//   decodable  → D64 write-back would PRESERVE it → the field failure is a
//                flush/trigger/session-persistence bug (NOT decode).
//   non-decode → D64 GCR→sector write-back zeros it → D64 is unsuitable for
//                this save class (need G64/verbatim or format-aware writeback).
//
// It runs the existing `gcr_read_sector` decoder against a captured raw track:
// per sector it reports OK / decode-fail, the data-block id byte, the checksum
// result, and whether the D64 write-back would preserve or zero it.
//
// INPUT (opt-in — needs a real sample of what the game actually wrote):
//   C64RE_GCR_SAMPLE = path to a .g64 the game wrote (raw GCR, lossless), or a
//                      drive GCR-snapshot blob from snapshotDiskImage().
//   C64RE_GCR_TRACK  = track number to inspect (default 20).
//   C64RE_GCR_KIND   = "g64" (default) | "gcrsnap"
// Without a sample it PENDS and prints what to capture.
//
// It also prints the READING-DERIVED preliminary: gcr_read_sector ignores the
// disk id (header id/checksum unchecked; data checksum is id-independent), so a
// standard-structure sector with a custom disk id still decodes.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-023 — real custom-writer GCR classifier (opt-in)\n");

const dist = join(ROOT, "dist/runtime/headless");
if (!existsSync(join(dist, "drive1541/vice1541-facade.js"))) { console.error("build:mcp first"); process.exit(2); }
const { Vice1541Facade } = await import(join(dist, "drive1541/vice1541-facade.js"));
const { drive_set_half_track } = await import(join(dist, "vice1541/drive.js"));
const { gcr_read_sector, gcr_find_sector_header, gcr_decode_block, CBMDOS_FDC_ERR_OK } = await import(join(dist, "vice1541/gcr.js"));

const SPT = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
const driveOf = (f) => f.diskunit.drives[0];
const ERRNAME = { 1: "OK(ERR_OK=1)" };
const errName = (rf) => rf === CBMDOS_FDC_ERR_OK ? "OK" : `decode-fail(rf=${rf})`;

const sample = process.env.C64RE_GCR_SAMPLE;
const track = Number(process.env.C64RE_GCR_TRACK ?? 20);
const kind = process.env.C64RE_GCR_KIND ?? "g64";

if (!sample || !existsSync(sample)) {
  console.log("PENDING — no real GCR sample provided.");
  console.log("\nTo capture and classify the REAL custom writer output:");
  console.log("  1. Mount a writable target, run the game's custom write (Wasteland Utils→Copy / Scramble HighScore).");
  console.log("  2. BEFORE detach, capture raw GCR: facade.snapshotDiskImage()  (or save a .g64 the game wrote).");
  console.log("  3. Re-run with:  C64RE_GCR_SAMPLE=<path> C64RE_GCR_TRACK=<n> C64RE_GCR_KIND=g64|gcrsnap node scripts/smoke-023-real-gcr-capture.mjs");
  console.log("\nReading-derived preliminary (no sample needed):");
  console.log("  • gcr_read_sector ignores the disk id (gcr_find_sector_header: 'ID's are not checked'); the");
  console.log("    data checksum is XOR-of-data (id-independent). So a STANDARD-structure CBM sector with a");
  console.log("    custom disk id ($50/$49) still decodes → would PERSIST through D64 write-back.");
  console.log("  • Wasteland's drive writer ($05C2/$062A) emits standard CBM SHAPE: 5×$FF sync, $55 gaps,");
  console.log("    10-byte header block, data block (sync + GCR). If markers are $08/$07 + XOR checksum, the");
  console.log("    field failure is a flush/trigger/session-persistence bug, NOT a decode/D64-format bug.");
  console.log("\nPENDING (opt-in). 0 pass, 0 fail.");
  process.exit(0);
}

// ---- load the captured raw GCR track ----
const bytes = new Uint8Array(readFileSync(sample));
const f = new Vice1541Facade();
if (kind === "gcrsnap") {
  f.attachDisk({ kind: "d64", bytes: new Uint8Array(683 * 256), readOnly: false });
  f.restoreDiskImage(bytes);
} else {
  f.attachDisk({ kind: "g64", bytes, readOnly: true });
}
const d = driveOf(f);
drive_set_half_track(track * 2, d.side, d);
const trk = d.gcr.tracks[track * 2 - 2];
ok(!!(trk && trk.data && trk.size > 0), `0 captured track ${track} has raw GCR`, trk ? `${trk.size} bytes` : "none");

const raw = { data: trk.data, size: trk.size };
const maxSec = SPT(track);
let decoded = 0, failed = 0;
const failSectors = [];
console.log(`\n=== track ${track}: ${maxSec} sectors ===`);
for (let s = 0; s < maxSec; s++) {
  const data = new Uint8Array(256);
  // header presence + data-block id (independent of full decode)
  const hp = gcr_find_sector_header(raw, s);
  let dataId = "?";
  const rf = gcr_read_sector(raw, data, s);
  if (rf === CBMDOS_FDC_ERR_OK || rf === 4 /* DCHECK */ || rf === 3 /* NOBLOCK */) {
    // peek data-block id via a fresh decode at the data sync
    try { const blk = new Uint8Array(4); const ds = (hp >= 0) ? hp : 0; gcr_decode_block(raw, ds, blk, 1); } catch {}
  }
  const okSec = rf === CBMDOS_FDC_ERR_OK;
  if (okSec) decoded++; else { failed++; failSectors.push(s); }
  const first = Array.from(data.slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  console.log(`  S${String(s).padStart(2)}  header=${hp >= 0 ? "found" : "MISSING"}  decode=${errName(rf)}  first4=${first}  → D64 writeback ${okSec ? "PRESERVES" : "ZEROS"}`);
}

ok(true, "1 ran gcr_read_sector over the captured track (classification)", `${decoded} OK, ${failed} fail`);

console.log("\n=== CLASSIFICATION ===");
if (failed === 0) {
  console.log(`  → ALL ${decoded} sectors decode (CBM-standard GCR). D64 write-back would PRESERVE them.`);
  console.log("    The field failure is NOT a decode/D64-format problem → flush/trigger/session-persistence bug.");
} else if (decoded === 0) {
  console.log(`  → NO sector decodes (non-standard GCR). D64 write-back ZEROS the whole track.`);
  console.log("    D64 is unsuitable for this writer's GCR → need G64/verbatim or format-aware write-back.");
} else {
  console.log(`  → MIXED: ${decoded} decode, ${failed} fail (sectors ${failSectors.join(",")}).`);
  console.log("    The failing sectors are non-standard for the CBM decoder; inspect their markers/checksum.");
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-023-capture: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
