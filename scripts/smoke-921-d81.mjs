#!/usr/bin/env node
// Spec 921 — a D81 is read like a D64: inspect, extract, register, and every sector accounted for.
// Synthetic images only, built here (scripts/lib/d81-fixture.mjs); nothing leaves the temp dirs.
//
//   node scripts/smoke-921-d81.mjs     (needs `npm run build`)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness } from "./lib/e2e-906-harness.mjs";
import { D81Image, d81WithPrg } from "./lib/d81-fixture.mjs";

let pass = 0, fail = 0;
const check = (ok, what, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${!ok && detail !== "" ? `  (${String(detail).slice(0, 400)})` : ""}`);
};
const head = (t) => console.log(`\n-- ${t}`);

const { createDiskParser, isDiskImage, D81Parser, D64Parser } = await import("../dist/disk/index.js");
const { readDiskDirectory, extractDiskImage } = await import("../dist/disk-extractor.js");
const { diskSectorAllocation, formatSectorMap, SECTOR_MAP_LEGEND } = await import("../dist/disk-custom-lut.js");

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const prgBytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i === 0 ? 0x00 : i === 1 ? 0x10 : (i * 7 + seed) & 0xff)); // load $1000

const H = new Harness("smoke-921-");
try {
  const scratch = join(H.dir, "images");
  mkdirSync(scratch, { recursive: true });
  const write = (name, bytes) => { const p = join(scratch, name); writeFileSync(p, bytes); return p; };

  // ---- S1 ----------------------------------------------------------------------------------
  head("S1  a D81 lists like a D64");
  const prg = Uint8Array.from([0x00, 0x20, 0xa9, 0x01, 0x60]);
  const s1 = d81WithPrg("HELLO", prg);
  check(s1.length === 819200, "the fixture is 819 200 bytes");
  check(createDiskParser(s1) instanceof D81Parser, "createDiskParser picks D81Parser by size");
  check(isDiskImage(s1), "isDiskImage accepts it");
  check(createDiskParser(new Uint8Array(174848)) instanceof D64Parser, "a 174 848-byte image is still a D64");
  const withErrors = new Uint8Array(822400); withErrors.set(s1);
  check(createDiskParser(withErrors) instanceof D81Parser, "822 400 bytes (3 200 error bytes) is a D81 too");
  const p1 = write("s1.d81", s1);
  const l1 = readDiskDirectory(p1);
  check(l1.format === "d81", "the listing says format d81", l1.format);
  check(l1.diskName === "c64re test" && l1.diskId === "RE", "disk name and id", `${l1.diskName}/${l1.diskId}`);
  check(l1.dosType === "3D", "DOS type 3D", l1.dosType);
  check(l1.files.length === 1 && l1.files[0].name === "hello" && l1.files[0].type === "PRG", "one PRG named hello (PETSCII upper reads as lower, as on a D64)");
  check(l1.files[0].chainStatus === "complete" && l1.files[0].sectorChain.length === 1 && l1.files[0].sectorChain[0].track === 1 && l1.files[0].sectorChain[0].sector === 0, "its chain is 1/0, complete");
  const x1 = extractDiskImage(p1, join(H.dir, "x1"));
  check(x1.format === "d81" && x1.files.length === 1 && same(readFileSync(join(x1.outputDir, x1.files[0].relativePath)), prg), "extract writes the file's bytes back");
  check(x1.files[0].loadAddress === 0x2000, "the load address is read", String(x1.files[0].loadAddress));
  check(JSON.parse(readFileSync(x1.manifestPath, "utf8")).format === "d81", "the manifest says format d81");

  // ---- S2 ----------------------------------------------------------------------------------
  head("S2  chain verdicts are a D64's");
  const multi = prgBytes(600);
  const im2 = new D81Image();
  im2.addFile("MULTI", multi, 2, 5);
  // cyclic: 3/0 -> 3/1 -> 3/0
  im2.put(3, 0, [3, 1]); im2.put(3, 1, [3, 0]); im2.entry(40, 1, 0x82, 3, 0, "LOOP", 2);
  // unreadable link: 4/0 -> 99/0
  im2.put(4, 0, [99, 0]); im2.entry(40, 2, 0x82, 4, 0, "BADLINK", 2);
  // malformed terminator: 5/0 links track 0, byte 1 = 0
  im2.put(5, 0, [0, 0]); im2.entry(40, 3, 0x82, 5, 0, "BADEND", 1);
  const l2 = readDiskDirectory(write("s2.d81", im2.img));
  const byName = (l, n) => l.files.find((f) => f.name === n);
  check(byName(l2, "multi")?.chainStatus === "complete" && byName(l2, "multi").sectorChain.length === 3, "a 600-byte file walks 3 sectors, complete");
  check(byName(l2, "multi")?.sectorChain.map((c) => `${c.track}/${c.sector}`).join() === "2/5,2/6,2/7", "in track order");
  check(byName(l2, "loop")?.chainStatus === "cyclic", "a closed loop is cyclic", byName(l2, "loop")?.chainStatus);
  check(byName(l2, "badlink")?.chainStatus === "unreadable", "a link off the image is unreadable", byName(l2, "badlink")?.chainStatus);
  check(byName(l2, "badend")?.chainStatus === "malformed-terminator", "a $00 byte count is a malformed terminator", byName(l2, "badend")?.chainStatus);
  const x2 = extractDiskImage(join(scratch, "s2.d81"), join(H.dir, "x2"));
  const multiOut = x2.files.find((f) => f.name === "multi");
  check(multiOut && same(readFileSync(join(x2.outputDir, multiOut.relativePath)), multi), "the 3-sector file extracts byte-exact");
  check(multiOut?.loadAddress === 0x1000, "its load address is $1000");

  // ---- S3 ----------------------------------------------------------------------------------
  head("S3  CBM partitions");
  const inner = prgBytes(300, 9);
  const im3 = new D81Image();
  // a subdirectory partition: tracks 5-7 (120 sectors), one file inside
  im3.addPartition("SUB", 5, 120, { files: [{ name: "INNER", bytes: inner, track: 5, sector: 10 }], nested: [{ name: "DEEP", track: 5, sector: 0, size: 120 }] });
  // a plain data partition crossing a track boundary: 10 sectors from 20/35
  im3.addPartition("DATA", 20, 10, { sector: 35, fill: 0xa5 });
  const p3 = write("s3.d81", im3.img);
  const l3 = readDiskDirectory(p3);
  const names3 = l3.files.map((f) => `${f.name}:${f.type}`);
  check(names3.includes("sub:CBM") && names3.includes("data:CBM"), "both partitions are listed as CBM", names3.join());
  check(names3.indexOf("sub/inner:PRG") === names3.indexOf("sub:CBM") + 1, "the subdirectory's file follows it as sub/inner", names3.join());
  check(names3.includes("sub/deep:CBM") && names3.filter((n) => n.startsWith("sub/deep")).length === 1, "a partition pointing at itself ends at the depth/seen guard (listed once)", names3.join());
  const x3 = extractDiskImage(p3, join(H.dir, "x3"));
  const sub = x3.files.find((f) => f.name === "sub");
  check(sub && sub.sizeBytes === 120 * 256 && sub.chainStatus === "complete" && sub.sectorChain.length === 120, "the partition extracts as 120 whole sectors, complete", `${sub?.sizeBytes}/${sub?.chainStatus}`);
  check(sub && same(readFileSync(join(x3.outputDir, sub.relativePath)), im3.img.subarray(((5 - 1) * 40) * 256, ((5 - 1) * 40 + 120) * 256)), "its bytes are the contiguous range");
  check(sub?.relativePath.endsWith(".cbm"), "extension .cbm", sub?.relativePath);
  const inn = x3.files.find((f) => f.name === "sub/inner");
  check(inn && same(readFileSync(join(x3.outputDir, inn.relativePath)), inner), "the file inside the partition extracts through its chain");
  const dat = x3.files.find((f) => f.name === "data");
  const datBytes = dat ? readFileSync(join(x3.outputDir, dat.relativePath)) : new Uint8Array();
  check(dat?.sectorChain.map((c) => `${c.track}/${c.sector}`).join() === "20/35,20/36,20/37,20/38,20/39,21/0,21/1,21/2,21/3,21/4", "a data partition runs on across the track boundary", dat?.sectorChain.map((c) => `${c.track}/${c.sector}`).join());
  check(datBytes.length === 2560 && datBytes[0] === 0 && datBytes[256] === 1 && datBytes[2304] === 9, "and its bytes are the 10 sectors");

  // ---- S6 (library) ------------------------------------------------------------------------
  head("S6  every sector accounted for");
  const im6 = new D81Image();
  im6.addFile("ONE", prgBytes(10), 1, 0);
  im6.put(60, 7, [1, 2, 3, 4, 5]); // bytes no chain reaches
  const p6 = write("s6.d81", im6.img);
  const x6 = extractDiskImage(p6, join(H.dir, "x6"));
  const alloc = diskSectorAllocation(p6, x6.manifestPath);
  const cell = (t, s) => alloc.ownership.find((o) => o.track === t && o.sector === s);
  check(alloc.totalSectors === 3200 && alloc.tracks === 80, "3 200 sectors on 80 tracks", `${alloc.totalSectors}/${alloc.tracks}`);
  check(cell(60, 7)?.role === "orphan_data", "60/7 is orphan_data", cell(60, 7)?.role);
  check([0, 1, 2].every((s) => cell(40, s)?.role === "system"), "40/0..40/2 are system");
  check(cell(40, 3)?.role === "system" && cell(40, 3)?.owner === "DOS directory", "40/3 is the directory");
  check(cell(40, 4)?.role === "unclaimed_padding", "40/4 (zero, no claimant) is unclaimed padding", cell(40, 4)?.role);
  check(cell(1, 0)?.role === "kernal_file" && cell(1, 0)?.owner === "kernal:one", "1/0 belongs to the file");
  check(alloc.orphanCount === 1 && alloc.unclaimedCount === 3200 - 4 - 1, "one orphan, the rest unclaimed", `${alloc.orphanCount}/${alloc.unclaimedCount}`);
  check(!/ free/.test(SECTOR_MAP_LEGEND) && /unexplained/.test(SECTOR_MAP_LEGEND), "the legend never says free for an orphan");
  check(formatSectorMap(alloc).length === 80, "the map has 80 track rows");

  // ---- S4 / S5 / S6 through the MCP tools ---------------------------------------------------
  head("S4  MCP: inspect_disk / extract_disk / disk_sector_allocation");
  const proj = await H.project("p921");
  mkdirSync(join(proj, "input", "disk"), { recursive: true });
  writeFileSync(join(proj, "input", "disk", "side1.d81"), im6.img);
  const m = await H.mcp(proj, {});
  let r = await m.call("inspect_disk", { image_path: "input/disk/side1.d81" });
  check(/Format: D81/.test(r) && /c64re test \[RE\] DOS 3D/.test(r) && /one \(PRG\)/.test(r), "inspect_disk names format, disk, id, DOS and the PRG", r.split("\n").slice(0, 6).join(" | "));
  check(/Substrate: standard-gcr/.test(r) && /static depack/.test(r), "substrate: a sector image, payloads are a static depack", r.split("\n").find((l) => /Substrate/.test(l)));
  r = await m.call("extract_disk", { image_path: "input/disk/side1.d81" });
  check(/Format: D81/.test(r) && /01_one\.prg/.test(r) && /load=\$1000/.test(r), "extract_disk lists the file with its load address", r.split("\n").slice(0, 14).join(" | "));
  const manifestPath = join(proj, "analysis", "disk", "side1", "manifest.json");
  check(existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, "utf8")).format === "d81", "manifest.json says d81", manifestPath);
  check(/Auto-disasm|auto/i.test(r) || /Imported manifest knowledge/.test(r), "the manifest is imported and the payloads analysed like a D64's", r.split("\n").slice(-6).join(" | "));
  r = await m.call("disk_sector_allocation", { image_path: "input/disk/side1.d81" });
  check(/Total sectors: 3200 on 80 tracks/.test(r), "allocation: 3 200 sectors on 80 tracks", r.split("\n").slice(0, 5).join(" | "));
  check(/T60\/S7\s+1 sector/.test(r) && /unexplained/i.test(r), "the orphan is a named unexplained range", r.split("\n").filter((l) => /nexplained|T60/.test(l)).join(" | "));
  check(!/\bfree\b/i.test(r), "the answer never calls anything free", r.split("\n").filter((l) => /\bfree\b/i.test(l)).join(" | "));

  head("S5  registration");
  const proj5 = await H.project("p921reg");
  mkdirSync(join(proj5, "input", "disk"), { recursive: true });
  writeFileSync(join(proj5, "input", "disk", "a.d81"), s1);
  writeFileSync(join(proj5, "input", "b.d81"), s1);
  const m5 = await H.mcp(proj5, {});
  await m5.call("project_inventory_sync", {});
  const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");
  const arts = new ProjectKnowledgeService(proj5).listArtifacts().filter((a) => a.kind === "d81");
  const rels = arts.map((a) => a.path.replace(proj5 + "/", "")).sort();
  check(rels.join() === "input/b.d81,input/disk/a.d81", "input/disk/a.d81 and input/b.d81 both register as kind d81", rels.join());
  check(arts.every((a) => a.role === "source-disk" && a.scope === "input"), "role source-disk, scope input");
  check(existsSync(join(proj5, "input", "b.d81")), "the loose image was not moved");
  // project_init routing
  const proj5b = await H.project("p921route");
  writeFileSync(join(proj5b, "loose.d81"), s1);
  const sorted = new ProjectKnowledgeService(proj5b).sortLooseInputMedia();
  check(existsSync(join(proj5b, "input", "disk", "loose.d81")) && !existsSync(join(proj5b, "loose.d81")), "a loose .d81 in the project root is routed to input/disk/", JSON.stringify(sorted).slice(0, 300));
} finally {
  H.stopMcps();
  H.cleanup();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-921-d81: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
