// BUG-023 acceptance — drive writes persist to the HOST backing file.
//
// The real bug: a mounted disk is only media.bytes in RAM; nothing wrote it
// back to the .d64/.g64 file on disk, so after a game formats+copies, the host
// file stays empty and its mtime never changes. This gate proves the fix end to
// end against the actual filesystem:
//
//   1. create a temp D64 FILE on disk (blank), backdate its mtime
//   2. mount it by reading the file into the drive (the mount path)
//   3. write a sector through the REAL drive write path (write_next_bit)
//   4. persist via persistMountedDiskToFile (the unmount/save writeback)
//   5. RE-READ the temp file from the filesystem
//   6. assert host bytes changed + host mtime advanced + a remount sees the
//      written sector
//   + read-only media must NOT be written back.
import { mkdtempSync, writeFileSync, readFileSync, statSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-023 acceptance — drive writes persist to the HOST .d64 file\n");

const dist = join(ROOT, "dist/runtime/headless");
if (!existsSync(join(dist, "drive1541/vice1541-facade.js"))) { console.error("build:mcp first"); process.exit(2); }
const { Vice1541Facade } = await import(join(dist, "drive1541/vice1541-facade.js"));
const { write_next_bit } = await import(join(dist, "vice1541/rotation.js"));
const { drive_set_half_track } = await import(join(dist, "vice1541/drive.js"));
const { persistMountedDiskToFile } = await import(join(dist, "media/mount.js"));

const SPT = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
function d64SectorOffset(track, sector) { let o = 0; for (let t = 1; t < track; t++) o += SPT(t) * 256; return o + sector * 256; }
const TRACK = 20, SECTOR = 5, TRK_IDX = TRACK * 2 - 2;
const PATTERN = new Uint8Array(256);
for (let i = 0; i < 256; i++) PATTERN[i] = (i ^ 0x77) & 0xff;
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
function writeStdSector(f, gcr, size) {
  const d = driveOf(f);
  drive_set_half_track(TRACK * 2, d.side, d);
  d.read_write_mode = 0; d.GCR_head_offset = 0;
  for (let b = 0; b < size; b++) for (let bit = 7; bit >= 0; bit--) write_next_bit(d, (gcr[b] >> bit) & 1);
}

const work = mkdtempSync(join(tmpdir(), "c64re-023host-"));
const diskPath = join(work, "blank_s1.d64");
writeFileSync(diskPath, blankD64());                       // (1) real blank D64 file on disk
const past = new Date(Date.now() - 5_000_000);             // backdate mtime so an advance is detectable
utimesSync(diskPath, past, past);
const mtimeBefore = statSync(diskPath).mtimeMs;
const so = d64SectorOffset(TRACK, SECTOR);

const { gcr, size } = stdTrackGcr();

// (2) mount = read the file into the drive
const fileBytes = new Uint8Array(readFileSync(diskPath));
const f = new Vice1541Facade();
f.attachDisk({ kind: "d64", bytes: fileBytes, readOnly: false });
// (3) write through the real drive path
writeStdSector(f, gcr, size);
ok(driveOf(f).GCR_dirty_track === 1, "0 sector written through the real drive path (GCR dirty)");

// host file still blank before persist
const preHost = readFileSync(diskPath);
ok(!preHost.subarray(so, so + 256).some((b) => b !== 0), "1 host .d64 still blank before persist");

// (4) persist (the unmount/save writeback) on the mounted session
const session = { kernel: { drive1541: f }, diskPath };
const res = persistMountedDiskToFile(session);
ok(res.written === true, "2 persistMountedDiskToFile reports written", res.reason || res.path);

// (5) RE-READ the host file from the filesystem
const hostAfter = readFileSync(diskPath);
const mtimeAfter = statSync(diskPath).mtimeMs;
ok(eq(hostAfter, PATTERN, so), "3 host .d64 file on disk now contains the written sector (T20/S5)",
  eq(hostAfter, PATTERN, so) ? "256/256 bytes" : `first byte $${hostAfter[so].toString(16)}`);
ok(mtimeAfter > mtimeBefore, "4 host filesystem mtime changed", `${mtimeBefore} → ${mtimeAfter}`);

// (6) remount the file from disk → the written sector is there
const f2 = new Vice1541Facade();
f2.attachDisk({ kind: "d64", bytes: new Uint8Array(readFileSync(diskPath)), readOnly: false });
ok(eq(f2.getAttachedMedia().bytes, PATTERN, so), "5 remount from filesystem sees the written sector");

// read-only media must NOT be written back
const roPath = join(work, "ro.d64");
writeFileSync(roPath, blankD64());
utimesSync(roPath, past, past);
const fro = new Vice1541Facade();
fro.attachDisk({ kind: "d64", bytes: new Uint8Array(readFileSync(roPath)), readOnly: true });
writeStdSector(fro, gcr, size);
const roRes = persistMountedDiskToFile({ kernel: { drive1541: fro }, diskPath: roPath });
ok(roRes.written === false && /read-only/i.test(roRes.reason || ""), "6 read-only media refuses host-file writeback", roRes.reason);
ok(!readFileSync(roPath).subarray(so, so + 256).some((b) => b !== 0), "6b read-only host file left untouched");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-023-host-file-persist: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
