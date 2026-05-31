// BUG-023 acceptance — snapshot/dump flushes dirty GCR into the embedded .d64.
//
// VICE calls drive_gcr_data_writeback_all() before writing a snapshot, so a
// snapshot/dump taken WHILE the disk is mounted decodes every dirty GCR track
// back into the .d64 image. Our snapshot hook was a no-op, so the embedded .d64
// stayed at its clean baseline (BUG-023). This gate proves the fix: a dirty GCR
// track (written through the real write_next_bit sink) must appear in the
// mounted .d64 (media.bytes) AFTER a snapshot, with no detach.
//
// The real VIA→rotation write path is proven separately by smoke:023-via; here
// we isolate the SNAPSHOT-FLUSH wiring.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-023 acceptance — snapshot flushes dirty GCR into the embedded .d64\n");

const dist = join(ROOT, "dist/runtime/headless");
if (!existsSync(join(dist, "drive1541/vice1541-facade.js"))) { console.error("build:mcp first"); process.exit(2); }
const { Vice1541Facade } = await import(join(dist, "drive1541/vice1541-facade.js"));
const { write_next_bit } = await import(join(dist, "vice1541/rotation.js"));
const { drive_set_half_track } = await import(join(dist, "vice1541/drive.js"));

const SPT = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
function d64SectorOffset(track, sector) { let o = 0; for (let t = 1; t < track; t++) o += SPT(t) * 256; return o + sector * 256; }
const TRACK = 20, SECTOR = 5, TRK_IDX = TRACK * 2 - 2;
const PATTERN = new Uint8Array(256);
for (let i = 0; i < 256; i++) PATTERN[i] = (i ^ 0x3c) & 0xff;
const driveOf = (f) => f.diskunit.drives[0];
const blankD64 = () => new Uint8Array(683 * 256);
const eq = (a, b, off = 0) => { for (let i = 0; i < b.length; i++) if (a[off + i] !== b[i]) return false; return true; };

// standard CBM-GCR track carrying PATTERN in T20/S5, via the port's attach.
function stdTrackGcr() {
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

const { gcr, size } = stdTrackGcr();
const media = blankD64();
const f = new Vice1541Facade();
f.attachDisk({ kind: "d64", bytes: media, readOnly: false });

// write the standard track through the real write_next_bit sink (dirties it).
const d = driveOf(f);
drive_set_half_track(TRACK * 2, d.side, d);
d.read_write_mode = 0;
d.GCR_head_offset = 0;
for (let b = 0; b < size; b++) for (let bit = 7; bit >= 0; bit--) write_next_bit(d, (gcr[b] >> bit) & 1);
ok(d.GCR_dirty_track === 1, "0 GCR track is dirty after the write (no detach)");

// pre-snapshot: the mounted .d64 (media.bytes) is still the clean baseline.
const so = d64SectorOffset(TRACK, SECTOR);
const preBlank = !media.subarray(so, so + 256).some((x) => x !== 0);
ok(preBlank, "1 mounted .d64 is still blank before snapshot (writes live only in GCR)");

// snapshot WITHOUT detach → must trigger drive_gcr_data_writeback_all → flush.
f.snapshot();
const postWritten = eq(media, PATTERN, so);
ok(postWritten, "2 snapshot flushes the dirty GCR into the mounted .d64 (T20/S5 == pattern)",
  postWritten ? "256/256 bytes" : `first byte $${media[so].toString(16)} want $${PATTERN[0].toString(16)}`);

// 3. the verbatim GCRIMAGE round-trip still sees the bytes (read-back).
const blob = f.snapshotDiskImage();
const g = new Vice1541Facade();
g.attachDisk({ kind: "d64", bytes: blankD64(), readOnly: false });
g.restoreDiskImage(blob);
const rtrk = driveOf(g).gcr.tracks[TRK_IDX];
ok(rtrk && rtrk.data && eq(rtrk.data, gcr.subarray(0, size)), "3 GCRIMAGE restore/read-back sees the written bytes (verbatim)");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-023-snapshot-flush: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
