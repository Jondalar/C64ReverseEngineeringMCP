// LNR disk directory + first-file load-address inspection.
// Used to confirm whether the file that lands at $1400 is the
// auto-loaded first file, or a later loaded chunk.

import { existsSync, readFileSync } from "node:fs";
const disk = "samples/last_ninja_remix_s1[system3_1991].g64";
if (!existsSync(disk)) { console.error(`missing ${disk}`); process.exit(2); }

const { G64Parser } = await import("../dist/disk/g64-parser.js");
const { readDiskDirectory, extractDiskImage } = await import("../dist/disk-extractor.js");

const buf = readFileSync(disk);
const parser = new G64Parser(buf);
console.log(`G64: ${buf.length} bytes parsed`);

const manifest = readDiskDirectory(disk);
console.log(`\nDir entries (${manifest.files.length}):`);
for (const f of manifest.files.slice(0, 30)) {
  console.log(`  "${f.name.padEnd(16)}" type=${f.type} sectors=${f.sectors?.length ?? 0} startTS=${f.startTrack}/${f.startSector ?? '?'}`);
}

import { mkdirSync, writeFileSync } from "node:fs";
const outDir = "/tmp/lnr-extract";
mkdirSync(outDir, { recursive: true });
const extracted = extractDiskImage(disk, outDir);
console.log(`\nExtracted ${extracted.files.length} files to ${outDir}`);
for (const f of extracted.files.slice(0, 10)) {
  const p = f.payload;
  if (!p || p.length < 2) continue;
  const loadAddr = p[0] | (p[1] << 8);
  const endAddr = loadAddr + p.length - 2;
  // Does this file cover \$1400?
  const covers1400 = loadAddr <= 0x1400 && endAddr >= 0x1400;
  console.log(`  "${f.name.padEnd(16)}" size=${p.length} load=$${loadAddr.toString(16)} end=$${endAddr.toString(16)} ${covers1400?'*** COVERS $1400':''}`);
}
