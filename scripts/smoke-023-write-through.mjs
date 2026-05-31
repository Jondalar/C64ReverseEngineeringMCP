// BUG-023 acceptance — VICE-faithful host-file WRITE-THROUGH at the diskimage
// write point. NOT boundary/unmount persistence (that is caching).
//
// VICE: the disk image fd is the real file; drive_gcr_data_writeback ->
// fsimage_*_write_half_track -> fwrite changes the host file at the commit
// point. So when a track is written back, the host .d64 is already changed —
// no unmount/snapshot needed.
//
//   1. temp D64 FILE on disk (blank), backdated mtime
//   2. mount it path-backed + writable
//   3. write a sector through the real drive path (write_next_bit)
//   4. SEEK to the next track -> drive_gcr_data_writeback commits track ->
//      fsimage_dxx_write_half_track -> hostFlush -> host file written
//   5. RE-READ the host file WITHOUT any detach/unmount/snapshot
//   6. assert host bytes changed + host mtime advanced
//   + read-only path-backed media must NOT touch the host file.
import { mkdtempSync, writeFileSync, readFileSync, statSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-023 acceptance — host-file WRITE-THROUGH at the diskimage write point\n");

const dist = join(ROOT, "dist/runtime/headless");
if (!existsSync(join(dist, "drive1541/vice1541-facade.js"))) { console.error("build:mcp first"); process.exit(2); }
const { Vice1541Facade } = await import(join(dist, "drive1541/vice1541-facade.js"));
const { write_next_bit } = await import(join(dist, "vice1541/rotation.js"));
const { drive_set_half_track, drive_gcr_data_writeback } = await import(join(dist, "vice1541/drive.js"));

const SPT = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
function d64SectorOffset(track, sector) { let o = 0; for (let t = 1; t < track; t++) o += SPT(t) * 256; return o + sector * 256; }
const TRACK = 20, SECTOR = 5, TRK_IDX = TRACK * 2 - 2;
const PATTERN = new Uint8Array(256);
for (let i = 0; i < 256; i++) PATTERN[i] = (i ^ 0x6e) & 0xff;
const driveOf = (f) => f.diskunit.drives[0];
const blankD64 = () => new Uint8Array(683 * 256);
const eq = (a, b, off = 0) => { for (let i = 0; i < b.length; i++) if (a[off + i] !== b[i]) return false; return true; };

function stdTrackGcr() {
  const d64 = blankD64(); d64.set(PATTERN, d64SectorOffset(TRACK, SECTOR));
  const f = new Vice1541Facade(); f.attachDisk({ kind: "d64", bytes: d64, readOnly: false });
  const trk = driveOf(f).gcr.tracks[TRK_IDX];
  const gcr = Uint8Array.from(trk.data.subarray(0, trk.size)); const size = trk.size;
  f.detachDisk(); return { gcr, size };
}
function writeSector(f, gcr, size) {
  const d = driveOf(f);
  drive_set_half_track(TRACK * 2, d.side, d);
  d.read_write_mode = 0; d.GCR_head_offset = 0;
  for (let b = 0; b < size; b++) for (let bit = 7; bit >= 0; bit--) write_next_bit(d, (gcr[b] >> bit) & 1);
}

const work = mkdtempSync(join(tmpdir(), "c64re-023wt-"));
const diskPath = join(work, "blank_s1.d64");
writeFileSync(diskPath, blankD64());
const past = new Date(Date.now() - 5_000_000);
utimesSync(diskPath, past, past);
const mtimeBefore = statSync(diskPath).mtimeMs;
const so = d64SectorOffset(TRACK, SECTOR);
const { gcr, size } = stdTrackGcr();

// mount path-backed + writable
const f = new Vice1541Facade();
f.attachDisk({ kind: "d64", bytes: new Uint8Array(readFileSync(diskPath)), readOnly: false, backingPath: diskPath });
writeSector(f, gcr, size);
ok(driveOf(f).GCR_dirty_track === 1, "0 sector written through the real drive path (GCR dirty)");
ok(!readFileSync(diskPath).subarray(so, so + 256).some((b) => b !== 0), "1 host file still blank before the track is committed");

// Commit the track (drive_gcr_data_writeback) — the exact point the drive ROM
// reaches via drive_set_last_read after a sector read / before a seek, and that
// detach also hits. This must write the host file via hostFlush.
drive_gcr_data_writeback(driveOf(f));

// RE-READ from filesystem — NO detach/unmount/snapshot
const host = readFileSync(diskPath);
const mtimeAfter = statSync(diskPath).mtimeMs;
ok(eq(host, PATTERN, so), "2 host .d64 changed at the WRITEBACK (no detach/unmount/snapshot)",
  eq(host, PATTERN, so) ? "256/256 bytes" : `first byte $${host[so].toString(16)}`);
ok(mtimeAfter > mtimeBefore, "3 host filesystem mtime advanced", `${mtimeBefore} → ${mtimeAfter}`);

// remount from filesystem sees it
const f2 = new Vice1541Facade();
f2.attachDisk({ kind: "d64", bytes: new Uint8Array(readFileSync(diskPath)), readOnly: false, backingPath: diskPath });
ok(eq(f2.getAttachedMedia().bytes, PATTERN, so), "4 remount from filesystem sees the written sector");

// read-only path-backed media must NOT touch the host file
const roPath = join(work, "ro.d64");
writeFileSync(roPath, blankD64()); utimesSync(roPath, past, past);
const roMtime = statSync(roPath).mtimeMs;
const fro = new Vice1541Facade();
fro.attachDisk({ kind: "d64", bytes: new Uint8Array(readFileSync(roPath)), readOnly: true, backingPath: roPath });
writeSector(fro, gcr, size);
drive_gcr_data_writeback(driveOf(fro));
ok(!readFileSync(roPath).subarray(so, so + 256).some((b) => b !== 0), "5 read-only host file NOT written through");
ok(statSync(roPath).mtimeMs === roMtime, "5b read-only host mtime unchanged");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-023-write-through: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
