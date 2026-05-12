#!/usr/bin/env node
// Spec 413 — 1541 Phase G smoke A: D64 → GCR encode at attach time,
// then scan-back decode = byte-identical sectors.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §9.1 (D64 attach encode loop +
//       detach scan-back),
//       §13 Phase G steps 27 + 29,
//       §17 OQ-413-1 (eager at attach).
//
// VICE: src/drive/driveimage.c:169-220 drive_image_attach() →
//         disk_image_read_image() →
//         src/diskimage/fsimage-dxx.c:149-280 fsimage_read_dxx_image()
//         walks every track and fills gcr->tracks[ht].data at attach.
//       src/diskimage/gcr.c gcr_convert_sector_to_GCR / inverse used
//         on detach via drive_gcr_data_writeback().
//
// Acceptance per spec 413: build a known D64, encode to GCR through
// the attach path (= buildG64), then decode each sector back via the
// G64Parser GCR scan-back path. Result must be byte-identical to the
// original sector payloads (header + data block).

import { buildG64 } from "../dist/disk/g64-builder.js";
import { buildD64 } from "../dist/disk/d64-builder.js";
import { G64Parser } from "../dist/disk/g64-parser.js";
import { D64Parser } from "../dist/disk/d64-parser.js";
import { SECTORS_PER_TRACK } from "../dist/disk/base.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}

// ── Build a synthetic D64 with a deterministic payload ────────────────
// Use the existing D64 builder so we get a real BAM + directory
// structure, then we will exercise both directory sectors AND raw
// sector reads on every track.
const PAYLOAD = new Uint8Array(256 * 4);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 0x9d + 0x37) & 0xff;
const d64 = buildD64({
  diskName: "PHASE-G-413",
  diskId: "GG",
  files: [
    { name: "PAYLOAD.PRG", payload: PAYLOAD, startTrack: 17, startSector: 0 },
  ],
});

check("D64 size = 174848 bytes (35-track)", d64.length === 174848, `len=${d64.length}`);
check("D64Parser recognises payload", D64Parser.isD64(d64));

// Reference D64 parser → sector reads (= source of truth for the
// scan-back comparison).
const refParser = new D64Parser(d64);

// ── Phase G step 27: eager D64→GCR encoding at attach ────────────────
// buildG64 is the TS analogue of fsimage_read_dxx_image() — invoked
// at mount time (mount.ts:142-143) so the G64Parser sees a fully
// pre-encoded image.
const g64 = buildG64({ d64 });
check("G64 has GCR-1541 magic", g64[0] === 0x47 && g64[1] === 0x43 && g64[2] === 0x52 && g64[3] === 0x2d, `magic=${[...g64.slice(0, 8)].map(b => b.toString(16)).join(" ")}`);
check("G64Parser recognises encoded image", G64Parser.isG64(g64));

const enc = new G64Parser(g64);

// ── Phase G step 29 analogue: scan-back decode each sector and ───────
// compare to the original D64 sector payload. We use the public
// getSector(), which walks the per-track GCR through decodeGCRTrack
// (= the same pathway VICE uses on detach via fsimage_write_sector()).
let sectorsCompared = 0;
let sectorsMismatched = 0;
const mismatches = [];
for (let track = 1; track <= 35; track++) {
  const maxSector = SECTORS_PER_TRACK[track];
  for (let sector = 0; sector < maxSector; sector++) {
    const ref = refParser.getSector(track, sector);
    const dec = enc.getSector(track, sector);
    sectorsCompared++;
    if (!ref || !dec) {
      sectorsMismatched++;
      mismatches.push(`t${track}/s${sector}: ref=${!!ref} dec=${!!dec}`);
      continue;
    }
    if (ref.length !== dec.length) {
      sectorsMismatched++;
      mismatches.push(`t${track}/s${sector}: len ref=${ref.length} dec=${dec.length}`);
      continue;
    }
    let same = true;
    for (let i = 0; i < ref.length; i++) {
      if (ref[i] !== dec[i]) { same = false; break; }
    }
    if (!same) {
      sectorsMismatched++;
      if (mismatches.length < 5) mismatches.push(`t${track}/s${sector}: byte mismatch`);
    }
  }
}
check(
  `every sector round-trips byte-identical through eager D64→GCR encode + scan-back decode (${sectorsCompared} sectors, ${sectorsMismatched} mismatched)`,
  sectorsMismatched === 0,
  mismatches.slice(0, 5).join("; "),
);

// ── Verify eager-at-attach: every real track has a non-zero GCR slot
// in the encoded image, NOT just track 18 / track 17. If the encoder
// were lazy / on-demand, only the tracks the test touched would be
// populated — but we want to assert step 27 ran for ALL 35 tracks.
let tracksWithData = 0;
for (let t = 1; t <= 35; t++) {
  const raw = enc.getRawTrackBytes(t);
  if (raw && raw.length > 0) tracksWithData++;
}
check(
  "all 35 tracks pre-encoded at attach (eager, NOT on-demand)",
  tracksWithData === 35,
  `tracksWithData=${tracksWithData}`,
);

// ── Verify the file payload survives the encode → decode round-trip
// using the higher-level extractFile API (= what the kernel calls).
const refDir = refParser.getDirectory();
const encDir = enc.getDirectory();
check("directory entry count round-trips (D64 → G64 → decode)",
  refDir.files.length === encDir.files.length,
  `ref=${refDir.files.length} enc=${encDir.files.length}`);

if (refDir.files[0] && encDir.files[0]) {
  const refBytes = refParser.extractFile(refDir.files[0], false);
  const encBytes = enc.extractFile(encDir.files[0], false);
  let same = !!refBytes && !!encBytes && refBytes.length === encBytes.length;
  if (same) {
    for (let i = 0; i < refBytes.length; i++) {
      if (refBytes[i] !== encBytes[i]) { same = false; break; }
    }
  }
  check("file extracted via chain → byte-identical after eager GCR encode + scan-back",
    same,
    `refLen=${refBytes?.length} encLen=${encBytes?.length}`);
}

// ── Report ────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`Spec 413 smoke A — D64→GCR eager attach round-trip — ${pass}/${results.length} pass, ${fail} fail`);
for (const r of results) {
  if (!r.pass) console.log(`  [FAIL] ${r.label}: ${r.detail}`);
}
if (fail > 0) process.exit(1);
