#!/usr/bin/env node
// A disk needs data, not a BAM. A D64 is its size; the DOS directory is one resolver on top
// of the blocks. A data disk read by its own loader has no BAM at 18/0 and must still be a
// disk to every reader (inspect_disk, extract_disk_custom_lut, the sector map) — only its
// directory is empty, and the read says why. Synthetic images only, built here.
//
//   node scripts/smoke-d64-no-bam.mjs     (needs `npm run build`)

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createDiskParser } = await import("../dist/disk/index.js");
const { readDiskDirectory } = await import("../dist/disk-extractor.js");

let pass = 0, fail = 0;
const check = (ok, what, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};

const SPT = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
const off = (t, s) => { let o = 0; for (let x = 1; x < t; x++) o += SPT(x); return (o + s) * 256; };
const image = (tracks) => { let n = 0; for (let t = 1; t <= tracks; t++) n += SPT(t); return new Uint8Array(n * 256); };
const dirEntry = (img, slot, type, t, s, name) => {
  const o = off(18, 1) + slot * 32;
  img[o + 2] = type; img[o + 3] = t; img[o + 4] = s;
  for (let i = 0; i < 16; i++) img[o + 5 + i] = i < name.length ? name.charCodeAt(i) : 0xa0;
  img[o + 0x1e] = 1;
};

const dir = mkdtempSync(join(tmpdir(), "d64-no-bam-"));
try {
  console.log("A D64 without a BAM is still a D64\n");

  // 1. a 40-track data disk: 18/0 links $3F/$3F, 18/1 holds data that is no directory
  const data = image(40);
  data[off(18, 0)] = 0x3f; data[off(18, 0) + 1] = 0x3f;
  for (let i = 0; i < 256; i++) data[off(18, 1) + i] = (i * 37 + 11) & 0xff;
  const pData = join(dir, "data40.d64"); writeFileSync(pData, data);
  check(createDiskParser(data) !== null, "a 40-track D64 with no BAM is a disk (the parser opens it)", String(data.length));
  const r1 = readDiskDirectory(pData);
  check(r1.files.length === 0 && /18\/0 links \$3F\/\$3F/.test(r1.noDos ?? ""), "its directory is empty and says what 18/0 holds", r1.noDos);
  check(createDiskParser(data)?.getSector(1, 0) !== null, "its blocks stay readable");

  // 2. a 35-track data disk, all zero
  const zero = image(35);
  check(createDiskParser(zero) !== null, "a 35-track all-zero D64 is a disk");

  // 3. a bent 18/0 link, but a real entry at 18/1: DOS reads 18/1 regardless, so it is listed
  const bent = image(35);
  bent[off(18, 0)] = 0x00; bent[off(18, 0) + 1] = 0xff;
  dirEntry(bent, 0, 0x82, 17, 0, "BOOT");
  dirEntry(bent, 1, 0x82, 99, 0, "BOGUS");          // a track no disk has: not loadable
  const pBent = join(dir, "bent.d64"); writeFileSync(pBent, bent);
  const r3 = readDiskDirectory(pBent);
  check(r3.files.length === 1 && r3.files[0].name.toUpperCase() === "BOOT", "a bent BAM link still lists the loadable 18/1 entry, and only that", r3.files.map((f) => f.name).join(","));
  check(/DOS reads 18\/1 regardless/.test(r3.noDos ?? ""), "  and says the link is bent", r3.noDos);

  // 4. a normal DOS disk is untouched
  const dos = image(35);
  dos[off(18, 0)] = 18; dos[off(18, 0) + 1] = 1;
  dirEntry(dos, 0, 0x82, 17, 0, "GAME");
  const pDos = join(dir, "dos.d64"); writeFileSync(pDos, dos);
  const r4 = readDiskDirectory(pDos);
  check(r4.files.length === 1 && r4.files[0].name.toUpperCase() === "GAME" && r4.noDos === undefined, "a DOS disk reads as before, no note", r4.files.map((f) => f.name).join(","));

  // 5. an off-size file still needs the BAM link as the witness that it is a disk
  const odd = new Uint8Array(180000);
  check(createDiskParser(odd) === null, "an off-size file without a BAM link is not taken for a disk");

  // 6. through the tool: inspect_disk reads the data disk, and a D64 is never a custom-GCR candidate
  {
    const { Harness } = await import("./lib/e2e-906-harness.mjs");
    const H = new Harness("d64nobam-");
    try {
      const proj = await H.project("nobam");
      writeFileSync(join(proj, "data40.d64"), data);
      const m = await H.mcp(proj, {});
      const r = await m.call("inspect_disk", { image_path: join(proj, "data40.d64") });
      check(/DOS directory: none \(18\/0 links \$3F\/\$3F/.test(r), "inspect_disk reads a D64 without a BAM and says so", r.split("\n").slice(1, 5).join(" | "));
      check(/Substrate: standard-gcr/.test(r) && !/custom-gcr/.test(r), "a D64 data disk is standard GCR (a static depack), never a custom-GCR candidate", (r.match(/Substrate: .*/) ?? [""])[0]);
    } finally { H.cleanup(); }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-d64-no-bam: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
