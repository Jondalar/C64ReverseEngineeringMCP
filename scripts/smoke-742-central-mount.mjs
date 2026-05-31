// Spec 742 — the ONE central disk-media attach preserves backing-file identity
// for write-through, across the change/eject path. Proves mountDiskMedia (the
// single path every entry now routes through) threads backingPath → host-file
// write-through, and that a disk CHANGE persists the outgoing disk.
import { mkdtempSync, writeFileSync, readFileSync, statSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 742 — central mountDiskMedia: backing-path identity + write-through\n");

const dist = join(ROOT, "dist/runtime/headless");
if (!existsSync(join(dist, "media/mount-disk-media.js"))) { console.error("build:mcp first"); process.exit(2); }
const { Vice1541Facade } = await import(join(dist, "drive1541/vice1541-facade.js"));
const { write_next_bit } = await import(join(dist, "vice1541/rotation.js"));
const { drive_set_half_track, drive_gcr_data_writeback } = await import(join(dist, "vice1541/drive.js"));
const { mountDiskMedia } = await import(join(dist, "media/mount-disk-media.js"));

const SPT = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
function d64SectorOffset(track, sector) { let o = 0; for (let t = 1; t < track; t++) o += SPT(t) * 256; return o + sector * 256; }
const TRACK = 20, SECTOR = 5, TRK_IDX = TRACK * 2 - 2;
const PATTERN = new Uint8Array(256);
for (let i = 0; i < 256; i++) PATTERN[i] = (i ^ 0x4d) & 0xff;
const driveOf = (f) => f.diskunit.drives[0];
const blankD64 = () => new Uint8Array(683 * 256);
const eq = (a, b, off = 0) => { for (let i = 0; i < b.length; i++) if (a[off + i] !== b[i]) return false; return true; };
const so = d64SectorOffset(TRACK, SECTOR);

function stdTrackGcr() {
  const d64 = blankD64(); d64.set(PATTERN, d64SectorOffset(TRACK, SECTOR));
  const f = new Vice1541Facade(); f.attachDisk({ kind: "d64", bytes: d64, readOnly: false });
  const trk = driveOf(f).gcr.tracks[TRK_IDX];
  const gcr = Uint8Array.from(trk.data.subarray(0, trk.size)); const size = trk.size;
  f.detachDisk(); return { gcr, size };
}
function writeAndCommit(f, gcr, size) {
  const d = driveOf(f);
  drive_set_half_track(TRACK * 2, d.side, d);
  d.read_write_mode = 0; d.GCR_head_offset = 0;
  for (let b = 0; b < size; b++) for (let bit = 7; bit >= 0; bit--) write_next_bit(d, (gcr[b] >> bit) & 1);
  drive_gcr_data_writeback(d);
}

const work = mkdtempSync(join(tmpdir(), "c64re-742-"));
const { gcr, size } = stdTrackGcr();
const past = new Date(Date.now() - 5_000_000);

// one facade, a target that holds the current path (like an IntegratedSession)
const facade = new Vice1541Facade();
let curPath = "";
const target = { drive: facade, getDiskPath: () => curPath, setDiskPath: (p) => { curPath = p; } };

// --- disk A: mount path-backed via the central function → write-through ---
const pathA = join(work, "diskA.d64");
writeFileSync(pathA, blankD64()); utimesSync(pathA, past, past);
mountDiskMedia(target, { kind: "d64", name: "diskA.d64", bytes: new Uint8Array(readFileSync(pathA)), backingPath: pathA, readOnly: false, source: "project-path" });
ok(curPath === pathA, "1 central mount records the backing-path identity (not just a name)", curPath);
writeAndCommit(facade, gcr, size);
ok(eq(readFileSync(pathA), PATTERN, so), "2 write-through: host file A changed at the writeback (no unmount)");
ok(statSync(pathA).mtimeMs > past.getTime(), "2b host file A mtime advanced");

// --- disk CHANGE: mount disk B → the outgoing disk A is persisted + detached ---
const pathB = join(work, "diskB.d64");
writeFileSync(pathB, blankD64()); utimesSync(pathB, past, past);
const res = mountDiskMedia(target, { kind: "d64", name: "diskB.d64", bytes: new Uint8Array(readFileSync(pathB)), backingPath: pathB, readOnly: false, source: "project-path" });
ok(curPath === pathB, "3 disk change switches identity to B", curPath);
ok(res.persistedOutgoing?.written === true, "3b outgoing disk A persisted on change", res.persistedOutgoing?.reason ?? res.persistedOutgoing?.path);
ok(eq(readFileSync(pathA), PATTERN, so), "3c disk A host file still holds its writes after the swap");

// write to B → write-through to B, A untouched
writeAndCommit(facade, gcr, size);
ok(eq(readFileSync(pathB), PATTERN, so), "4 write-through to host file B after the change");

// --- uploaded bytes (no backingPath) → RAM only, no host file written ---
const facadeU = new Vice1541Facade();
let curU = "";
const targetU = { drive: facadeU, getDiskPath: () => curU, setDiskPath: (p) => { curU = p; } };
mountDiskMedia(targetU, { kind: "d64", name: "uploaded.d64", bytes: blankD64(), readOnly: false, source: "uploaded-bytes" });
ok(curU === "uploaded.d64", "5 uploaded bytes keep the display name (no host path)");
writeAndCommit(facadeU, gcr, size); // no backingPath → no file write, must not throw
ok(facadeU.getAttachedMedia() && eq(facadeU.getAttachedMedia().bytes, PATTERN, so), "5b uploaded media mutates RAM only (no host file to write)");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-742-central-mount: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
