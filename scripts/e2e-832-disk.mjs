#!/usr/bin/env node
// Spec 832 — D2 (a load address is a hypothesis, not a fact) and D3 (one reader,
// one answer).
//
// Hermetic: a temp project, synthetic directory entries and a synthetic sector
// map. No G64, no D64, no daemon — the two defects are decided on this side of the
// medium, so they can be checked without one.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:832-disk

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const loader = entities.find((e) => e.name === "loader");
  const record = entities.find((e) => e.name === "t202");
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

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 832 disk: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
