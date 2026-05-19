#!/usr/bin/env node
/**
 * Spec 616 T616.2 — Extract first-PRG oracle bytes from real test disks.
 *
 * For each disk in the canonical 7-game set:
 *   1. Parse directory (D64 or G64)
 *   2. Find first non-deleted PRG entry (= LOAD"*",8,1 target)
 *   3. Extract full PRG bytes, walk sector chain counting sectors
 *   4. Split into load-address (2 bytes) + body
 *   5. SHA-256 body
 *   6. Write body as binary: samples/fixtures/load-fidelity/real-disk-oracle/<shortName>.body.bin
 *
 * Outputs: samples/fixtures/load-fidelity/real-disk-oracle/_index.json
 *
 * Usage:
 *   node scripts/build-load-fidelity-real-oracle.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import { createHash } from "node:crypto";

const repoRoot = resolvePath(import.meta.dirname, "..");
const outDir = join(repoRoot, "samples/fixtures/load-fidelity/real-disk-oracle");
mkdirSync(outDir, { recursive: true });

// ---- Import compiled parsers from dist/disk/ --------------------------------
const { D64Parser } = await import(`${repoRoot}/dist/disk/d64-parser.js`);
const { G64Parser } = await import(`${repoRoot}/dist/disk/g64-parser.js`);
const { traceFileSectorChain, petToAscii, getFileType, extractFileFromChain } = await import(`${repoRoot}/dist/disk/base.js`);

// ---- Disk list --------------------------------------------------------------
const DISKS = [
  {
    disk: "samples/POLARBEAR.d64",
    shortName: "polarbear",
  },
  {
    disk: "samples/motm.g64",
    shortName: "motm",
  },
  {
    disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64",
    shortName: "mm-s1",
  },
  {
    disk: "samples/impossible_mission_ii[epyx_1987](!).g64",
    shortName: "im2",
  },
  {
    disk: "samples/last_ninja_remix_s1[system3_1991].g64",
    shortName: "lnr-s1",
  },
  {
    disk: "samples/scramble_infinity.d64",
    shortName: "scramble",
  },
  {
    disk: "samples/the_pawn_s1.g64",
    shortName: "pawn-s1",
  },
];

// ---- Helpers ----------------------------------------------------------------

function loadParser(diskPath) {
  const data = new Uint8Array(readFileSync(diskPath));
  if (G64Parser.isG64(data)) return new G64Parser(data);
  if (D64Parser.isD64(data)) return new D64Parser(data);
  throw new Error(`Unrecognised disk format: ${diskPath}`);
}

function sha256hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Walk sector chain and count sectors.
 */
function countSectors(parser, entry) {
  const chain = traceFileSectorChain((t, s) => parser.getSector(t, s), entry);
  return chain.length;
}

/**
 * Parse directory for G64 images that use copy-protection on track 18/1
 * (sector checksum intentionally corrupted). Falls back to reading the raw
 * decoded sector bytes ignoring the data checksum.
 *
 * Only called when parser.getDirectory() returns no files.
 */
function parseDirIgnoringChecksum(parser) {
  // Only applicable to G64Parser which has extractTrackSectors()
  if (typeof parser.extractTrackSectors !== "function") return null;

  // BAM at 18/0 — try normal read first, fall back to raw decode
  let bamSector = parser.getSector(18, 0);
  if (!bamSector) {
    const raw = parser.extractTrackSectors(18, [0]);
    const found = raw.find((s) => s.sector === 0 && s.headerValid);
    if (!found) return null;
    bamSector = found.data;
  }

  // Disk name from BAM
  let diskName = "";
  for (let i = 0; i < 16; i++) {
    const byte = bamSector[0x90 + i];
    if (byte === 0xa0) break;
    diskName += String.fromCharCode(petToAscii(byte).charCodeAt(0));
  }

  const files = [];
  let dirTrack = 18;
  let dirSector = 1;

  while (dirTrack !== 0) {
    // Try normal getSector first; fall back to checksum-ignoring decode
    let sectorData = parser.getSector(dirTrack, dirSector);
    if (!sectorData) {
      // G64: try extractTrackSectors which returns data regardless of dataValid
      const rawSectors = parser.extractTrackSectors(dirTrack, [dirSector]);
      const found = rawSectors.find((s) => s.sector === dirSector && s.headerValid);
      if (!found) break;
      sectorData = found.data;
    }

    for (let i = 0; i < 8; i++) {
      const offset = i * 32;
      const typeByte = sectorData[offset + 2];
      if ((typeByte & 0x80) === 0) continue;

      const fileTrack = sectorData[offset + 3];
      const fileSector = sectorData[offset + 4];
      if (fileTrack === 0) continue;

      const nameBytes = sectorData.slice(offset + 5, offset + 21);
      let name = "";
      for (let j = 0; j < 16 && j < nameBytes.length; j++) {
        if (nameBytes[j] === 0xa0) break;
        name += petToAscii(nameBytes[j]);
      }
      name = name.trim();

      const sizeLow = sectorData[offset + 0x1e];
      const sizeHigh = sectorData[offset + 0x1f];
      const sizeSectors = sizeLow | (sizeHigh << 8);

      files.push({
        name,
        type: getFileType(typeByte),
        size: sizeSectors,
        track: fileTrack,
        sector: fileSector,
      });
    }

    dirTrack = sectorData[0];
    dirSector = sectorData[1];
  }

  return files.length > 0 ? { name: diskName || "UNTITLED", files } : null;
}

// ---- Main -------------------------------------------------------------------

const entries = [];

for (const { disk, shortName } of DISKS) {
  const diskPath = join(repoRoot, disk);
  console.log(`\nProcessing ${shortName} (${disk}) ...`);

  let parser;
  try {
    parser = loadParser(diskPath);
  } catch (err) {
    console.error(`  HALT: parse failed — ${err.message}`);
    process.exit(1);
  }

  let dir;
  try {
    dir = parser.getDirectory();
  } catch (err) {
    // Some disks (e.g. Pawn) have copy-protection on BAM/dir sectors too —
    // parser.getDirectory() throws "Cannot read BAM sector (18/0)".
    // Treat as "no files" and fall through to the checksum-ignoring path.
    console.log(`  Standard dir threw (${err.message}) — trying checksum-ignoring fallback ...`);
    dir = { files: [] };
  }

  // First non-deleted PRG entry (CBM DOS: type byte 0x82 = closed PRG)
  let prgEntry = dir.files.find((f) => f.type === "PRG");
  let dirNote = null;

  if (!prgEntry) {
    // Fallback: copy-protected directory (e.g. IM2/Pawn — checksum deliberately
    // corrupted on track 18). Read raw decoded sector bytes ignoring checksum.
    console.log(`  Standard dir returned no files — trying checksum-ignoring fallback ...`);
    const fallbackDir = parseDirIgnoringChecksum(parser);
    if (!fallbackDir) {
      console.error(`  HALT: no PRG entry found in directory (even with checksum fallback)`);
      process.exit(1);
    }
    prgEntry = fallbackDir.files.find((f) => f.type === "PRG");
    if (!prgEntry) {
      console.error(`  HALT: fallback directory also has no PRG entry`);
      process.exit(1);
    }
    dirNote = "directory sector has intentionally corrupted checksum (copy protection); read ignoring GCR data checksum";
    console.log(`  Fallback dir: disk="${fallbackDir.name}" files=${fallbackDir.files.length}`);
  }

  console.log(`  First PRG: "${prgEntry.name}" track=${prgEntry.track} sector=${prgEntry.sector} size=${prgEntry.size} sectors (dir)`);

  // Extract full PRG bytes (with load address — first 2 bytes).
  // For G64 images: use getSector which respects dataValid. If a sector in
  // the file chain is also checksum-protected, fall back to raw decode.
  function getSectorFallback(t, s) {
    const sec = parser.getSector(t, s);
    if (sec) return sec;
    // G64 fallback: return raw decoded data even if dataValid=false
    if (typeof parser.extractTrackSectors === "function") {
      const raw = parser.extractTrackSectors(t, [s]);
      const found = raw.find((r) => r.sector === s && r.headerValid);
      return found ? found.data : null;
    }
    return null;
  }

  let prg;
  try {
    prg = extractFileFromChain(getSectorFallback, prgEntry, false); // false = keep load address
  } catch (err) {
    console.error(`  HALT: extractFile failed — ${err.message}`);
    process.exit(1);
  }

  if (!prg || prg.length < 2) {
    console.error(`  HALT: extracted PRG is empty or too short (${prg?.length ?? 0} bytes)`);
    process.exit(1);
  }

  // Load address = first 2 bytes (little-endian)
  const loadAddr = prg[0] | (prg[1] << 8);
  const body = prg.slice(2);

  // Count sectors via chain walk (authoritative, not dir size field)
  let sectorCount;
  try {
    sectorCount = traceFileSectorChain(getSectorFallback, prgEntry).length;
  } catch (err) {
    console.error(`  HALT: sector chain walk failed — ${err.message}`);
    process.exit(1);
  }

  const bodySha256 = sha256hex(body);
  const bodyPath = `real-disk-oracle/${shortName}.body.bin`;
  const bodyOutPath = join(outDir, `${shortName}.body.bin`);

  writeFileSync(bodyOutPath, body);

  console.log(`  loadAddr=0x${loadAddr.toString(16).toUpperCase().padStart(4,"0")} bodyLen=${body.length} sectorCount=${sectorCount}`);
  console.log(`  sha256=${bodySha256}`);
  console.log(`  -> ${bodyOutPath}`);

  const entry = {
    disk,
    shortName,
    prgName: prgEntry.name,
    loadAddr: `0x${loadAddr.toString(16).toUpperCase().padStart(4,"0")}`,
    bodyLen: body.length,
    sectorCount,
    bodySha256,
    bodyPath,
  };

  // Note copy-protection anomalies
  const noteFragments = [];
  if (dirNote) noteFragments.push(dirNote);
  if (prgEntry.size !== sectorCount) {
    noteFragments.push(`dir reports ${prgEntry.size} sectors but sector chain has ${sectorCount}`);
  }
  if (noteFragments.length > 0) {
    entry.note = noteFragments.join("; ");
    console.log(`  NOTE: ${entry.note}`);
  }

  entries.push(entry);
}

// ---- Write _index.json ------------------------------------------------------
const index = {
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  entries,
};

const indexPath = join(outDir, "_index.json");
writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
console.log(`\nWrote ${indexPath}`);
console.log(`Done. ${entries.length} disks processed.`);
