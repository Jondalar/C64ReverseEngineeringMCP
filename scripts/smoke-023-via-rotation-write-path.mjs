// BUG-023 — REAL VIA→rotation write-path probe (no gameplay).
//
// The earlier classifier (smoke:023) drove write_next_bit DIRECTLY with a
// test-set read_write_mode — a shortcut that bypassed the VIA/rotation chain.
// This probe drives the ACTUAL chain a custom drive-code save uses, the same
// the 1541 ROM/game code hits via STA $1C0C / STA $1C03 / STA $1C01:
//
//   1. seek to a track (loads GCR_track_start_ptr)
//   2. STA $1C03 = $FF  (DDRA: port A = output)
//   3. STA $1C0C = $C0  (PCR: CB2 low output → WRITE head mode)  → read_write_mode must become 0
//   4. STA $1C01 = byte (PRA: GCR_write_value) with the drive clock advancing,
//      so rotation_rotate_disk's WRITE branch shifts bits into write_next_bit
//   5. GCR_dirty_track must become 1   (the write reached the GCR buffer)
//   6. detach → the written track must decode back into the mounted D64
//
// If 3 or 5 fail → the VIA→rotation write TRIGGER diverges from VICE (port bug).
// If all pass → the per-op write path is correct end to end and the field
// failure lives in the persistence/inspect path (detach vs snapshot), not here.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-023 — real VIA→rotation write-path probe\n");

const dist = join(ROOT, "dist/runtime/headless");
if (!existsSync(join(dist, "drive1541/vice1541-facade.js"))) { console.error("build:mcp first"); process.exit(2); }
const { Vice1541Facade } = await import(join(dist, "drive1541/vice1541-facade.js"));
const { viacore_store } = await import(join(dist, "vice1541/viacore.js"));
const { drive_set_half_track } = await import(join(dist, "vice1541/drive.js"));
const { diskunit_clk_refs } = await import(join(dist, "vice1541/drivecpu.js"));
const { VIA_PRA, VIA_PCR, VIA_DDRA } = await import(join(dist, "vice1541/drivetypes.js"));

const SPT = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
function d64SectorOffset(track, sector) { let o = 0; for (let t = 1; t < track; t++) o += SPT(t) * 256; return o + sector * 256; }
const TRACK = 20;

const f = new Vice1541Facade();
const d64 = new Uint8Array(683 * 256);
f.attachDisk({ kind: "d64", bytes: d64, readOnly: false });
const drive = f.diskunit.drives[0];
const via2 = f.diskunit.via2;
ok(!!via2, "0 VIA2 context present");

// seek → GCR_track_start_ptr for TRACK
drive_set_half_track(TRACK * 2, drive.side, drive);
ok(drive.GCR_track_start_ptr != null && drive.GCR_image_loaded === 1, "0b head on track, GCR image loaded");

// VICE inits read_write_mode=1 (drive.c:258); the real drive reads first
// (PCR=$E0 → read) then switches to write (PCR=$C0). Mimic that real sequence —
// a write-first from the init value is a no-op in VICE too (set_cb2 guard).
viacore_store(via2, VIA_DDRA, 0xff);     // DDRA: port A output
viacore_store(via2, VIA_PCR, 0xe0);      // PCR=$E0: CB2 high → READ mode
const rwRead = drive.read_write_mode;
ok(rwRead === 0x20, "1a PCR=$E0 → READ mode (read_write_mode==0x20)", `$${(rwRead & 0xff).toString(16)}`);
viacore_store(via2, VIA_PCR, 0xc0);      // PCR=$C0: CB2 low → WRITE mode
const writeModeEngaged = drive.read_write_mode === 0;
ok(writeModeEngaged, "1b PCR=$C0 via the real VIA store sets WRITE mode (read_write_mode==0)",
  `$${(drive.read_write_mode & 0xff).toString(16)}`);

// 4. write a run of bytes like the game's `bvc; sta $1C01` loop, advancing the
//    drive clock between writes so rotation_rotate_disk shifts the bits out.
const CYC_PER_BYTE = 32; // ~1 GCR byte at the inner speed zone
drive.GCR_dirty_track = 0; // clear, observe whether the real path sets it
const headBefore = drive.GCR_head_offset;
for (let i = 0; i < 64; i++) {
  diskunit_clk_refs[0].value = (diskunit_clk_refs[0].value + CYC_PER_BYTE) >>> 0;
  viacore_store(via2, VIA_PRA, (0x55 + i) & 0xff); // STA $1C01
}

ok(drive.GCR_dirty_track === 1, "2 STA $1C01 writes through rotation reach the GCR buffer (GCR_dirty_track==1)",
  `dirty=${drive.GCR_dirty_track}, head moved ${(drive.GCR_head_offset - headBefore)} bits`);

// 6. back to read mode + detach → the written track must decode into the D64.
viacore_store(via2, VIA_PCR, 0xe0); // CB2 high → READ
f.detachDisk();
const touched = d64.some((b) => b !== 0);
ok(touched, "3 detach writeback decodes the written track into the mounted D64 (bytes changed)",
  touched ? "D64 mutated" : "D64 still blank");

console.log("\n=== VERDICT ===");
if (!writeModeEngaged) {
  console.log("  → PCR write did NOT engage write mode: VIA→read_write_mode trigger diverges from VICE (PORT BUG).");
} else if (fail === 0) {
  console.log("  → Full real VIA→rotation→write_next_bit→detach→D64 chain WORKS (write mode engaged via the");
  console.log("    real VIA store, bits reached the GCR buffer, detach decoded them into the mounted D64).");
  console.log("    The per-op write path is correct → the field failure is the PERSISTENCE/INSPECT path, not the");
  console.log("    drive emulation: .d64 only reflects writes via detach/seek decode; a snapshot/dump keeps writes");
  console.log("    in the GCRIMAGE blob (verbatim) while the embedded .d64 stays the clean baseline because");
  console.log("    drive_gcr_data_writeback_all() is a no-op (VICE calls it before snapshot write). Fix there.");
} else {
  console.log("  → write mode engaged but bits did not reach the GCR buffer or detach didn't persist:");
  console.log("    divergence is in the rotation write branch trigger / clock catch-up. Inspect rotation_rotate_disk call cadence.");
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-023-via: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
