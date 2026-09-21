#!/usr/bin/env node
// Spec 832 — D2 (a load address is a hypothesis, not a fact) and D3 (one reader,
// one answer).
//
// Hermetic: a temp project, synthetic directory entries and a synthetic sector
// map. No G64, no D64, no daemon — the two defects are decided on this side of the
// medium, so they can be checked without one.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:832-disk

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 832 — what the disk tools claim\n");

const { extractFileFromChain, loadAddressRejection } = await import(join(ROOT, "dist/disk/base.js"));
const { buildDiskSpec784Manifest } = await import(join(ROOT, "dist/server-tools/disk-spec784-manifest.js"));
const { manifestSchemaNames, readManifestKnowledge } = await import(join(ROOT, "dist/project-knowledge/manifest-import.js"));
const { ProjectKnowledgeService } = await import(join(ROOT, "dist/project-knowledge/service.js"));

// ---------------------------------------------------------------- the predicate
//
// It rejects only what it can disprove; anything it cannot disprove stays a load
// address, because a whitelist of "known good" addresses would be the invention
// this defect is about.
check(loadAddressRejection(0x0801, 2 + 300) === undefined, "$0801 with 300 bytes of body is a load address");
check(loadAddressRejection(0xfffe, 2 + 2) === undefined, "$FFFE with 2 bytes ends exactly at $FFFF — still an address");
check(loadAddressRejection(0x0200, 2 + 1) === undefined, "$0200, the first byte above the stack page, is a load address");
check(typeof loadAddressRejection(0x01ff, 2 + 4) === "string", "$01FF (Ultima VI's t001: $FF + record id) is refused — zero page / stack");
check(typeof loadAddressRejection(0xcaff, 2 + 0x4000) === "string", "$CAFF + 16 KB runs past $FFFF — refused");
check(typeof loadAddressRejection(0x2000, 2) === "string", "two bytes and nothing else place nothing anywhere — refused");
check(/\$FFFF/.test(loadAddressRejection(0xcaff, 2 + 0x4000) ?? ""), "…and the refusal says WHY, in the reader's own terms");

// -------------------------------------------------- a chain, read as it would be
//
// A synthetic sector map: 254 data bytes behind a 2-byte T/S link, exactly like a
// 1541 file chain, so extractFileFromChain does the real walk.
function sectorMap(entries) {
  const sectors = new Map();
  for (const { track, sector, next, body } of entries) {
    const data = new Uint8Array(256);
    if (next) { data[0] = next.track; data[1] = next.sector; } else { data[0] = 0; data[1] = body.length + 1; }
    data.set(body, 2);
    sectors.set(`${track}/${sector}`, data);
  }
  return (t, s) => sectors.get(`${t}/${s}`) ?? null;
}

// A record file: every record begins $FF,<id>. 60 linked sectors, so reading the
// first two bytes as $CAFF would claim a file running far past the top of memory.
const recordSectors = [];
for (let i = 0; i < 60; i += 1) {
  const body = new Uint8Array(254).fill(0x41);
  if (i === 0) { body[0] = 0xff; body[1] = 0xca; }
  recordSectors.push({ track: 20, sector: i, next: i < 59 ? { track: 20, sector: i + 1 } : null, body });
}
const recordEntry = { name: "t202", type: "PRG", size: 60, track: 20, sector: 0 };
const recordBytes = extractFileFromChain(sectorMap(recordSectors), recordEntry, false);
check(recordBytes !== null && recordBytes.length > 0x3501, `the record file reads back whole (${recordBytes?.length} bytes)`);
check(recordEntry.loadAddress === undefined, "a record header is NOT recorded as a load address — the defect, gone");
check(typeof recordEntry.loadAddressNote === "string" && recordEntry.loadAddressNote.includes("CAFF"),
  `…and the entry says what it saw instead: ${recordEntry.loadAddressNote}`);

// A genuine PRG: $0801, one sector.
const prgBody = new Uint8Array(254).fill(0xea);
prgBody[0] = 0x01;
prgBody[1] = 0x08;
const prgEntry = { name: "loader", type: "PRG", size: 1, track: 17, sector: 0 };
const prgBytes = extractFileFromChain(sectorMap([{ track: 17, sector: 0, next: null, body: prgBody }]), prgEntry, false);
check(prgEntry.loadAddress === 0x0801, `a real PRG still gets its load address ($${(prgEntry.loadAddress ?? 0).toString(16)})`);
check(prgEntry.loadAddressNote === undefined, "…and carries no excuse");
check(prgBytes?.length === 254 && prgBytes[0] === 0x01 && prgBytes[1] === 0x08,
  "…and its bytes come back whole, header included (the caller did not ask for a strip)");

// --------------------------------------------------- the manifest, imported whole
const project = mkdtempSync(join(tmpdir(), "c64re-832-"));
try {
  const service = new ProjectKnowledgeService(project);
  service.initProject({ name: "832 fixture", description: "Spec 832 disk gate", tags: ["gate"] });
  const diskDir = join(project, "analysis", "disk", "fixture");
  mkdirSync(diskDir, { recursive: true });
  writeFileSync(join(diskDir, "01_loader.prg"), Buffer.from([0x01, 0x08, 0xa9, 0x00]));
  writeFileSync(join(diskDir, "02_t202.prg"), Buffer.from([0xff, 0xca, 0x41, 0x41]));

  // Row 0 is a real PRG. Row 1 is a record file whose manifest (written before this
  // fix) still claims $CAFF. Row 2 is the row that survives the load-address check
  // and still cannot be asserted: $FFFE + 4 bytes of file runs one byte past the
  // top, so its range would be end < start once the graph masks it.
  const manifestPath = join(diskDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    sourceImage: "fixture.d64",
    format: "d64",
    diskName: "FIXTURE",
    diskId: "83",
    files: [
      { index: 0, origin: "kernal", name: "loader", type: "PRG", sizeSectors: 1, sizeBytes: 4, track: 17, sector: 0, loadAddress: 0x0801, relativePath: "01_loader.prg" },
      { index: 1, origin: "kernal", name: "t202", type: "PRG", sizeSectors: 60, sizeBytes: 15238, track: 20, sector: 0, loadAddress: 0xcaff, relativePath: "02_t202.prg" },
      { index: 2, origin: "kernal", name: "edge", type: "PRG", sizeSectors: 1, sizeBytes: 4, track: 18, sector: 5, loadAddress: 0xfffe },
    ],
  }, null, 2)}\n`);

  const manifestArtifact = service.saveArtifact({
    kind: "manifest",
    scope: "generated",
    title: "Fixture disk manifest",
    path: manifestPath,
    role: "disk-manifest",
    format: "json",
    producedByTool: "extract_disk",
  });

  const imported = service.importManifestArtifact(manifestArtifact.id);
  check(imported.importedEntityCount === 2, `one bad row costs itself, not the disk: ${imported.importedEntityCount} of 3 rows imported`);
  check(imported.skippedRows.length === 1, `the skip is REPORTED: ${imported.skippedRows.length} row(s)`);
  check(imported.skippedRows[0]?.index === 2 && imported.skippedRows[0]?.name === "edge",
    `…and names the row: #${imported.skippedRows[0]?.index} ${imported.skippedRows[0]?.name}`);
  check(/end|address/i.test(imported.skippedRows[0]?.reason ?? ""), `…with the reason: ${imported.skippedRows[0]?.reason}`);

  const entities = service.listEntities();
  // BUG-060 defect 2: a disk file is named after the FILE it was extracted into, so the
  // payload and the disassembly of that file stand under one owner stem. The CBM
  // directory name stays reachable as an alias, which is how these two are found here.
  const byCbmName = (cbm) => entities.find((e) => e.name === cbm || (e.aliases ?? []).includes(cbm));
  const loader = byCbmName("loader");
  const record = byCbmName("t202");
  check(loader?.name === "01_loader", `the row is named after its extracted file: ${loader?.name}`);
  check((loader?.aliases ?? []).includes("loader"), `…and the CBM directory name is kept as an alias: ${(loader?.aliases ?? []).join(",")}`);
  check((loader?.summary ?? "").includes('CBM directory name "loader"'), `…and stated in the summary: ${loader?.summary}`);
  check(loader?.payloadLoadAddress === 0x0801, "the real PRG keeps $0801 through the import");
  check(loader?.payloadFormat === "prg", "…and stays format prg");
  check(record !== undefined, "the record file is still imported — it is a file, it just has no load address");
  check(record?.payloadLoadAddress === undefined, "…with NO load address asserted, although the manifest on disk claims $CAFF");
  check(record?.payloadFormat === "raw", "…and format raw, which is the honest answer for a record file");
  check((record?.summary ?? "").includes("CAFF"), `…and the demotion is on the record: ${record?.summary}`);

  // -------------------------------------------- D3: the content decides, not the role
  //
  // A manifest this repo WROTE (the Spec-784 shape extract_disk emits beside the
  // legacy one), registered under a role that is not its own. The old reader
  // branched on the role string and refused it; register_payloads_from_manifest
  // read the same bytes happily.
  const spec784 = buildDiskSpec784Manifest({
    sourceImage: join(diskDir, "fixture.d64"),
    format: "d64",
    diskName: "FIXTURE",
    diskId: "83",
    outputDir: diskDir,
    manifestPath,
    files: [{
      index: 0, origin: "kernal", name: "loader", type: "PRG", sizeSectors: 1, sizeBytes: 4,
      track: 17, sector: 0, loadAddress: 0x0801, format: "prg", relativePath: "01_loader.prg",
      sectorChain: [{ index: 0, track: 17, sector: 0, nextTrack: 0, nextSector: 5, bytesUsed: 4, isLast: true }],
      md5: "0".repeat(32),
    }],
  }, project);
  check(spec784 !== null && spec784.manifestVersion === 1, "extract_disk's own Spec-784 builder produced the manifest");
  check(spec784?.payloads[0]?.format === "prg" && spec784?.payloads[0]?.loadAddress === 0x0801,
    "…and the real PRG is a prg payload at $0801 in it");

  // The same builder, given the record file: it must not claim prg either.
  const spec784Record = buildDiskSpec784Manifest({
    sourceImage: join(diskDir, "fixture.d64"), format: "d64", diskName: "FIXTURE", diskId: "83",
    outputDir: diskDir, manifestPath,
    files: [{
      index: 0, origin: "kernal", name: "t202", type: "PRG", sizeSectors: 60, sizeBytes: 15238,
      track: 20, sector: 0, format: "raw", relativePath: "02_t202.prg",
      sectorChain: [{ index: 0, track: 20, sector: 0, nextTrack: 0, nextSector: 5, bytesUsed: 4, isLast: true }],
    }],
  }, project);
  check(spec784Record?.payloads[0]?.format === "raw" && spec784Record?.payloads[0]?.loadAddress === null,
    "a PRG-typed record file is a RAW payload with a null load address — the directory type byte does not overrule the bytes");
  const spec784Path = join(diskDir, "manifest.spec784.json");
  writeFileSync(spec784Path, `${JSON.stringify(spec784, null, 2)}\n`);
  const spec784Artifact = service.saveArtifact({
    kind: "manifest",
    scope: "generated",
    title: "Fixture Spec-784 manifest",
    path: spec784Path,
    role: "disk-manifest", // deliberately the WRONG role — content must still decide
    format: "json",
    producedByTool: "extract_disk",
  });
  const reimported = service.importManifestArtifact(spec784Artifact.id);
  check(reimported.importedEntityCount === 1, "a manifest this repo wrote re-imports through the content reader");
  check(/Spec 784/.test(reimported.schema), `…and the result names the schema that read it: ${reimported.schema}`);
  check(reimported.skippedRows.length === 0, "…with nothing skipped");

  // A file that matches no schema still fails — with the shapes it was tried against.
  const strayPath = join(diskDir, "stray.json");
  writeFileSync(strayPath, `${JSON.stringify({ hello: "world", note: "not a manifest" }, null, 2)}\n`);
  const strayArtifact = service.saveArtifact({
    kind: "manifest",
    scope: "generated",
    title: "Stray JSON",
    path: strayPath,
    role: "disk-manifest",
    format: "json",
  });
  let strayError = "";
  try {
    service.importManifestArtifact(strayArtifact.id);
  } catch (error) {
    strayError = error instanceof Error ? error.message : String(error);
  }
  check(strayError.length > 0, "a random JSON is still refused — no schema was weakened to let it in");
  const names = manifestSchemaNames();
  check(names.length === 3, `three manifest schemas are known: ${names.length}`);
  for (const name of names) {
    check(strayError.includes(name), `the refusal names the schema it was tried against: ${name.split(" ")[0]}`);
  }
  check(/no .files. array/.test(strayError), "…and what each one missed, so the next reader knows the expected shape");

  // The role is a hint for ORDER, not a gate: the same stray file under no role at
  // all fails identically, and a disk manifest under the wrong role still reads.
  const noRole = readManifestKnowledge({ ...spec784Artifact, role: undefined });
  check(noRole.knowledge !== undefined, "the Spec-784 manifest reads with NO role at all");
  check(noRole.attempts.filter((a) => !a.matched).length >= 1, "…after the other schemas said no, each on its own terms");
} finally {
  rmSync(project, { recursive: true, force: true });
}


// ───────────────────────────── disk_sector_allocation gives back the MAP ──────
//
// The tool promised "per-track/sector ownership … unclaimed padding, orphan data"
// and printed three numbers: total, unclaimed, overlaps — plus a JSON block holding
// the same three. A session that wanted the cartography rebuilt it by hand out of
// manifest.spec784.json. And the overlap count was noise: seven zero-block DEL
// directory comments each "claimed" the seven directory sectors, 49 phantom
// overlaps, with any real one buried among them.
{
  const { diskSectorAllocation, formatSectorMap, formatSectorOwners, SECTOR_MAP_LEGEND } =
    await import(join(ROOT, "dist/disk-custom-lut.js"));
  const { SECTORS_PER_TRACK } = await import(join(ROOT, "dist/disk/base.js"));

  const dir = mkdtempSync(join(tmpdir(), "c64re-alloc-"));
  try {
    // A real-shaped 35-track D64: 683 sectors of 256 bytes.
    let total = 0;
    for (let t = 1; t <= 35; t += 1) total += SECTORS_PER_TRACK[t];
    const image = Buffer.alloc(total * 256, 0x00);
    const offsetOf = (track, sector) => {
      let off = 0;
      for (let t = 1; t < track; t += 1) off += SECTORS_PER_TRACK[t] * 256;
      return off + sector * 256;
    };
    // A real BAM link at T18/S0, so the D64 reader recognises the image at all.
    image[offsetOf(18, 0)] = 18;
    image[offsetOf(18, 0) + 1] = 1;
    // One sector nobody claims, holding data: the orphan this tool exists to find.
    image[offsetOf(20, 5) + 7] = 0xa9;
    const imagePath = join(dir, "SIDE1.D64");
    writeFileSync(imagePath, image);

    const chain = (cells) => cells.map(([track, sector], index) => ({
      index, track, sector, nextTrack: 0, nextSector: 0, bytesUsed: 254, isLast: index === cells.length - 1,
    }));
    // The seven directory sectors, which is exactly what a zero-block DEL entry's
    // stale start pointer walks into.
    const dirChain = chain([[18, 1], [18, 3], [18, 5], [18, 7], [18, 9], [18, 11], [18, 13]]);
    const files = [
      {
        index: 0, origin: "kernal", name: "LOADER", type: "PRG", sizeSectors: 3, sizeBytes: 700,
        track: 17, sector: 0, relativePath: "files/LOADER.prg",
        sectorChain: chain([[17, 0], [17, 1], [17, 2]]),
      },
    ];
    for (let i = 0; i < 7; i += 1) {
      files.push({
        index: 1 + i, origin: "kernal", name: `----${i}`, type: "DEL", sizeSectors: 0, sizeBytes: 0,
        track: 18, sector: 1, relativePath: `files/del${i}`, sectorChain: dirChain,
      });
    }
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ diskName: "SIDE1", diskId: "01", files }, null, 2));

    const r = diskSectorAllocation(imagePath, manifestPath);
    check(r.overlapsCount === 0,
      `seven zero-block DEL entries produce 0 overlaps, not 49 (got ${r.overlapsCount})`);
    check((r.ignored ?? []).length === 7, `…and all seven are reported as non-claimants (got ${(r.ignored ?? []).length})`);
    check(/zero-block DEL/.test(r.ignored?.[0]?.reason ?? ""), "…each saying why it was not counted");
    check(r.ownership.length === total, `the map has one row per sector (${r.ownership.length} of ${total})`);
    const at = (t, s) => r.ownership.find((x) => x.track === t && x.sector === s);
    check(at(18, 1)?.role === "system", "T18/S1 is still the DOS directory, unclaimed by any DEL entry");
    check(at(17, 1)?.owner === "kernal:LOADER", "a real file owns its chain");
    check(at(20, 5)?.role === "orphan_data", "an unclaimed sector that holds bytes is orphan_data, not padding");
    check(r.orphanCount === 1, `…and it is counted (${r.orphanCount})`);
    check(at(20, 6)?.role === "unclaimed_padding", "an unclaimed EMPTY sector stays padding");
    check(r.imageRead === true, "the image argument is actually read — it used to be echoed and ignored");

    const map = formatSectorMap(r);
    check(map.length === 35, `the printable map is one line per track (${map.length})`);
    check(map[17].startsWith("T18 SSS"), `T18 reads as system in the map (${map[17].slice(0, 12)})`);
    check(/^T17 KKK\./.test(map[16]), `the loader's three sectors read as K (${map[16].slice(0, 12)})`);
    check(map[19].includes("#"), "the orphan sector shows as # in the map");
    check(/orphan data/.test(SECTOR_MAP_LEGEND), "the legend explains the glyphs");
    const owners = formatSectorOwners(r);
    check(owners.some((l) => /kernal:LOADER\s+3 sectors: T17\/S0 T17\/S1 T17\/S2/.test(l)),
      "the owner list gives the T/S cells, not just a count");

    // A DEL entry with real blocks is NOT waved through — only the zero-block kind.
    const withBlocks = JSON.parse(JSON.stringify({ diskName: "SIDE1", diskId: "01", files }));
    withBlocks.files[1].sizeSectors = 7;
    const mp2 = join(dir, "manifest2.json");
    writeFileSync(mp2, JSON.stringify(withBlocks));
    const r2 = diskSectorAllocation(imagePath, mp2);
    check(r2.overlapsCount === 7 && (r2.ignored ?? []).length === 6,
      `a DEL entry that owns blocks still claims and still collides (${r2.overlapsCount} overlaps, ${(r2.ignored ?? []).length} ignored)`);

    // …and the DOOR hands it over, rather than keeping it in the process.
    const { registerMediaTools } = await import(join(ROOT, "dist/server-tools/media.js"));
    const handlers = new Map();
    registerMediaTools(
      { tool: (name, _d, _s, handler) => handlers.set(name, handler) },
      { projectDir: () => dir, toolsDir: () => ROOT, readTextFile: (x) => x,
        cliResultToContent: (x) => ({ content: [{ type: "text", text: `${x.stdout}${x.stderr}` }] }),
        tryRegisterKnowledgeArtifacts: () => ({}) },
    );
    const answer = (await handlers.get("disk_sector_allocation")({
      project_dir: dir, image_path: imagePath, manifest_path: manifestPath,
    })).content.map((c) => c.text).join("\n");
    check(/^T18 SSS/m.test(answer), "the answer PRINTS the map — it used to print three numbers");
    check(/Unclaimed: \d+ \(of which 1 hold data/.test(answer), "…and says how much of the unclaimed space is not empty");
    const written = /written to (\S+) \((\d+) rows/.exec(answer);
    check(!!written, "…and names the file it wrote the full per-sector map to");
    check(!!written && existsSync(written[1]) && Number(written[2]) === total,
      "…which exists and holds one row per sector");
    const onDisk = written ? JSON.parse(readFileSync(written[1], "utf8")) : {};
    check(onDisk.ownership?.length === total && onDisk.ignored?.length === 7,
      "…with the ownership rows and the discarded claimants in it");
    check(!/Overlaps: 49/.test(answer), "no phantom overlap count survives into the answer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 832 disk: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
