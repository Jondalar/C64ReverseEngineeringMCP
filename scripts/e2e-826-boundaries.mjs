#!/usr/bin/env node
// Spec 826.0 T3/T4 — human nodes without a generated twin, by kind, against a
// ground-truth fixture the real pipeline analyzes and 819 + 820 seed.
//
//   $1000 entry:  lda $1400 ; jsr $1020 ; rts                       extent $1000-$1009
//   $1020 sub:    ldx #3 ; loop: dex ; bne loop ; rts               extent $1020-$1025, 819 label at $1022
//   $1400-$1410   a byte table (data, read by entry)
//   $1500         a lonely data byte nothing reads
//   $1600         lda #2 ; rts — code nothing references            … image $1000-$16FF, NOP padded
//
//   fixture_annotations.json says:
//     routine  $1003 entry_call      → strictly inside W1000       → STARTS_INSIDE + boundary human-splits-generated
//     routine  $1600 hidden_routine  → outside every routine       → boundary unseen-by-discovery
//     label    $1022 loop            → has a generated twin        → nothing (the normal case)
//     label    $1025 sub_exit        → inside W1020, no twin       → CONTAINS from W1020
//     label    $1500 lonely_byte     → outside every routine       → data_block + boundary data-outside-code
//     segment  $1400-$1410 my_table  → data_block; RESOLVES_TO from addr:1400, so the READS from entry lands on it
//   nobody_annotations.json (owner never seeded) → counted as unseededOwner, nothing done
//
// Exit 0 = pass, 1 = fail.   node scripts/e2e-826-boundaries.mjs   (after npm run build:mcp)

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { seedControlFlow } = await import(join(ROOT, "dist/knowledge-graph/producers/control-flow.js"));
const { seedMemoryAccess } = await import(join(ROOT, "dist/knowledge-graph/producers/memory-access.js"));
const { importAnnotationFile } = await import(join(ROOT, "dist/knowledge-graph/migrate/migrate.js"));
const { boundaries, boundaryEntries, formatBoundaries } = await import(join(ROOT, "dist/knowledge-graph/query-boundaries.js"));
const { GraphStore } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const info = (msg) => console.log(`  info  ${msg}`);
const eq = (actual, expected, what) => check(actual === expected, `${what} = ${JSON.stringify(actual)}${actual === expected ? "" : ` (expected ${JSON.stringify(expected)})`}`);

console.log("Spec 826.0 T3/T4 — boundary rule on the annotation import\n");

// ---------------------------------------------------------------- fixture

const project = mkdtempSync(join(tmpdir(), "c64re-826-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
mkdirSync(join(project, "analysis"), { recursive: true });
writeFileSync(join(project, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "p", name: "Spec 826 fixture", slug: "s826", rootPath: project }));

const image = new Uint8Array(0x0700).fill(0xea); // $1000-$16FF, NOPs
const put = (addr, bytes) => image.set(bytes, addr - 0x1000);
put(0x1000, [0xad, 0x00, 0x14, 0xad, 0x05, 0x14, 0x20, 0x20, 0x10, 0x60]); // lda $1400 ; lda $1405 (INSIDE the table) ; jsr $1020 ; rts
put(0x1020, [0xa2, 0x03, 0xca, 0xd0, 0xfd, 0x60]);             // ldx #3 ; loop: dex ; bne loop ; rts
put(0x1400, Array.from({ length: 17 }, (_, i) => 0x30 + i)); // a byte table
put(0x1500, [0xff]);
put(0x1600, [0xa9, 0x02, 0x60]);                               // lda #2 ; rts — unreferenced
const prg = new Uint8Array(image.length + 2);
prg[0] = 0x00; prg[1] = 0x10; prg.set(image, 2);
const prgPath = join(project, "analysis", "fixture.prg");
const analysisPath = join(project, "analysis", "fixture_analysis.json");
writeFileSync(prgPath, prg);
execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prgPath, analysisPath, "1000"], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: project } });

const r819 = seedControlFlow({ projectDir: project, analysisPath });
const r820 = seedMemoryAccess({ projectDir: project, analysisPath });
info(`819: routines=${r819.routines} labels=${r819.labels} edges=${JSON.stringify(r819.edges)}; 820: edges=${JSON.stringify(r820.edges)}`);

const R = (a) => `s826:ram/fixture:routine:${a}`;
const L = (a) => `s826:ram/fixture:label:${a}`;
const D = (a) => `s826:ram/fixture:data_block:${a}`;
const A = (a) => `s826:ram:addr:${a}`;

// the premise: what 819 drew, and what it did not see
let graph = Graph.open(project);
const w1000 = graph.resolve(R("1000"));
const w1020 = graph.resolve(R("1020"));
check(!w1000.dangling && w1000.endAddress === 0x1009, `W1000 is a generated routine with extent $1000-$1009 (${w1000.endAddress?.toString(16)})`);
check(!w1020.dangling && w1020.endAddress === 0x1025, `W1020 is a generated routine with extent $1020-$1025 (${w1020.endAddress?.toString(16)})`);
check(graph.resolve(L("1022")).layers.includes("generated"), "819 made the label at $1022 (branch target) — the twin case");
check(graph.resolve(R("1003")).dangling && graph.resolve(R("1600")).dangling && graph.resolve(L("1025")).dangling && graph.resolve(L("1500")).dangling, "no generated row at $1003 / $1600 (routines) or $1025 / $1500 (labels)");
const readsBefore = graph.edgesOutOf(R("1000")).filter((e) => e.type === "READS" && e.evidence.via === undefined && e.to === A("1400"));
check(readsBefore.length === 1, `before the import: READS W1000 → ${A("1400")} (an anonymous addr node)`);
graph.close();

// ---------------------------------------------------------------- the annotation files

const NOW = "2026-09-06T12:00:00.000Z";
const annPath = join(project, "analysis", "fixture_annotations.json");
writeFileSync(annPath, JSON.stringify({
  routines: [
    { address: "$1003", name: "entry_call", comment: "a human split of W1000" },
    { address: "$1600", name: "hidden_routine", comment: "nothing references it" },
  ],
  labels: [
    { address: "$1022", label: "loop" },
    { address: "$1025", label: "sub_exit" },
    { address: "$1500", label: "lonely_byte" },
  ],
  segments: [
    { start: "$1400", end: "$1410", kind: "lookup_table", label: "my_table", comment: "17 bytes" },
  ],
}, null, 2));
const nobodyPath = join(project, "analysis", "nobody_annotations.json");
writeFileSync(nobodyPath, JSON.stringify({
  routines: [{ address: "$2000", name: "nobody_routine" }],
  labels: [{ address: "$2010", label: "nobody_label" }],
  segments: [{ start: "$2100", end: "$2110", kind: "data", label: "nobody_table" }],
}, null, 2));

const r1 = importAnnotationFile(annPath, { projectDir: project, now: NOW });
info(`import fixture: r=${r1.routines} l=${r1.labels} s=${r1.segments} dropped=${r1.dropped} attached=${r1.attached} dataBlocks=${r1.dataBlocks} splits=${r1.splits} unseen=${r1.unseen} unseededOwner=${r1.unseededOwner} ${r1.ms.toFixed(1)} ms`);
eq(r1.dropped, 0, "nothing dropped");
eq(r1.attached, 1, "attached (sub_exit → CONTAINS)");
eq(r1.dataBlocks, 2, "dataBlocks (my_table, lonely_byte)");
eq(r1.splits, 1, "splits (entry_call)");
eq(r1.unseen, 1, "unseen (hidden_routine)");
eq(r1.unseededOwner, 0, "unseededOwner (fixture is seeded)");

const r2 = importAnnotationFile(nobodyPath, { projectDir: project, now: NOW });
eq(r2.unseededOwner, 3, "nobody_annotations.json: every node counted as unseededOwner");
eq(r2.attached + r2.dataBlocks + r2.splits + r2.unseen, 0, "nobody_annotations.json: nothing else done");

// ---------------------------------------------------------------- the outcomes

graph = Graph.open(project);
const T3 = (e) => e.layer === "human" && e.origin === "imported" && e.confidence === "inferred" && e.evidence.rule === "826.0-T3";

// label inside a routine, no twin → CONTAINS
const contains = graph.edgesInto(L("1025"), ["CONTAINS"]);
check(contains.length === 1 && contains[0].from === R("1020") && T3(contains[0]), `CONTAINS W1020 → sub_exit ($1025): human / imported / inferred / rule 826.0-T3`);
check(graph.containerOf(L("1025")).some((n) => n.id === R("1020")), "containerOf(sub_exit) = W1020");
check(graph.labels(R("1020")).some((n) => n.id === L("1025") && n.name === "sub_exit"), "labels(W1020) lists sub_exit under its human name");
// label with a twin → nothing from the rule
check(!graph.edgesInto(L("1022"), ["CONTAINS"]).some(T3), "loop ($1022, has a twin): no 826.0-T3 edge — the normal case");
check(graph.resolve(L("1022")).name === "loop" && graph.resolve(L("1022")).attrs.boundary === undefined, "loop: human name on the twin, no boundary attr");

// label outside every routine → data_block + boundary
const lonely = graph.resolve(L("1500"));
eq(lonely.attrs.boundary, "data-outside-code", "lonely_byte label attrs.boundary");
const d1500 = graph.resolve(D("1500"));
check(!d1500.dangling && d1500.kind === "data_block" && d1500.name === "lonely_byte" && d1500.endAddress === null && d1500.attrs.legacy_kind === "annotation-label" && d1500.attrs.boundary === "data-outside-code", `data_block ${D("1500")} (lonely_byte, no end, legacy_kind annotation-label)`);

// segment → data_block; RESOLVES_TO from the addr node; the READS re-pointed
const d1400 = graph.resolve(D("1400"));
check(!d1400.dangling && d1400.kind === "data_block" && d1400.name === "my_table" && d1400.endAddress === 0x1410 && d1400.attrs.segment_kind === "lookup_table" && d1400.attrs.legacy_kind === "annotation-segment", `data_block ${D("1400")} (my_table, $1400-$1410, lookup_table)`);
check(graph.resolve(`s826:ram/fixture:segment:1400`).name === "my_table", "the segment human node is still there (the listing reads it)");
const resolves = graph.store.db.prepare("SELECT to_id, producer FROM edges WHERE from_id = ? AND type = 'RESOLVES_TO'").all(A("1400"));
check(resolves.length === 1 && resolves[0].to_id === D("1400") && resolves[0].producer === "826r", `RESOLVES_TO ${A("1400")} → my_table (producer 826r)`);
const reads = graph.edgesOutOf(R("1000")).filter((e) => e.type === "READS" && e.to === D("1400"));
check(reads.length === 2 && reads.every((e) => e.toNode.name === "my_table") && reads.some((e) => e.evidence.via === A("1400")) && reads.some((e) => e.evidence.via === A("1405")), `edgesOutOf(W1000): both READS land on my_table — via ${A("1400")} (first byte) and via ${A("1405")} (inside the range)`);
// 826.0 T4 range rule: an address INSIDE the table resolves to it, offset said
const inside = graph.store.db.prepare("SELECT to_id, evidence FROM edges WHERE from_id = ? AND type = 'RESOLVES_TO'").all(A("1405"));
check(inside.length === 1 && inside[0].to_id === D("1400") && JSON.parse(inside[0].evidence).offset === 5 && JSON.parse(inside[0].evidence).rule === "826.0-T4", `RESOLVES_TO ${A("1405")} → my_table with offset 5 (the range rule)`);
check(graph.edgesInto(D("1400")).filter((e) => e.type === "READS").length === 2, "edgesInto(my_table) counts both READS through the aliases");
check(graph.readers(0x1400).some((e) => e.from === R("1000")), "readers($1400) still answers W1000");

// routine inside a generated routine → STARTS_INSIDE + boundary, never a label
const split = graph.edgesOutOf(R("1003"), ["STARTS_INSIDE"]);
check(split.length === 1 && split[0].to === R("1000") && T3(split[0]) && split[0].evidence.container === R("1000"), `STARTS_INSIDE entry_call ($1003) → W1000, evidence.container = W1000`);
const entryCall = graph.resolve(R("1003"));
check(entryCall.kind === "routine" && entryCall.orphaned && entryCall.attrs.boundary === "human-splits-generated" && entryCall.name === "entry_call", "entry_call stays a routine (orphaned), attrs.boundary human-splits-generated");

// routine outside every routine → boundary unseen
const hidden = graph.resolve(R("1600"));
check(hidden.kind === "routine" && hidden.orphaned && hidden.attrs.boundary === "unseen-by-discovery", "hidden_routine ($1600): attrs.boundary unseen-by-discovery");
check(graph.edgesOutOf(R("1600"), ["STARTS_INSIDE"]).length === 0, "hidden_routine: no STARTS_INSIDE");

// the unseeded owner: rows exist, untouched
check(graph.resolve("s826:ram/nobody:routine:2000").attrs.boundary === undefined && graph.resolve("s826:ram/nobody:data_block:2100").dangling, "nobody: the routine carries no boundary attr, the segment made no data_block");

// ---------------------------------------------------------------- the report

const b = boundaries(graph);
console.log(formatBoundaries(b).split("\n").map((l) => `        ${l}`).join("\n"));
check(b.splits.length === 1 && b.splits[0].id === R("1003") && b.splits[0].name === "entry_call" && b.splits[0].container.id === R("1000") && b.splits[0].container.address === 0x1000 && b.splits[0].container.end === 0x1009, "boundaries().splits = [entry_call inside W1000 $1000-$1009]");
check(b.unseen.length === 1 && b.unseen[0].id === R("1600") && b.unseen[0].name === "hidden_routine" && b.unseen[0].owner === "fixture", "boundaries().unseen = [hidden_routine]");
check(b.dataOutsideCode.length === 1 && b.dataOutsideCode[0].id === L("1500") && b.dataOutsideCode[0].dataBlock === D("1500"), "boundaries().dataOutsideCode = [lonely_byte → its data_block]");
check(b.unseededOwners.length === 1 && b.unseededOwners[0].owner === "nobody" && b.unseededOwners[0].humanNodes === 3, "boundaries().unseededOwners = [nobody: 3 human nodes]");
eq(JSON.stringify(boundaryEntries(graph)), JSON.stringify(["$1600"]), "boundaryEntries()");
check(formatBoundaries(b).includes("$1600 hidden_routine") && formatBoundaries(b).includes("$1003 entry_call  inside $1000-$1009 W1000"), "formatBoundaries: one line per item");
const ambiguous = JSON.parse(graph.store.getMeta("resolve.ambiguous") ?? "[]");
info(`resolve.ambiguous after the import: ${JSON.stringify(ambiguous)}`);
graph.close();

// ---------------------------------------------------------------- idempotence

const snapshot = () => {
  const s = GraphStore.open(project, { readOnly: true });
  const c = s.counts();
  const dump = s.canonicalDump("generated") + s.canonicalDump("human");
  const edges = s.db.prepare("SELECT COUNT(*) AS n FROM edges").get().n;
  s.close();
  return { ...c, edges, dump };
};
const s1 = snapshot();
const r3 = importAnnotationFile(annPath, { projectDir: project, now: NOW });
const s2 = snapshot();
check(r3.changed === false && s2.nodes === s1.nodes && s2.edges === s1.edges && s2.humanNodes === s1.humanNodes && s2.dump === s1.dump, `unchanged re-import: changed=false, nodes ${s1.nodes}=${s2.nodes}, edges ${s1.edges}=${s2.edges}, identical dump`);
eq(`${r3.attached}/${r3.splits}/${r3.unseen}`, "1/1/1", "unchanged re-import still reports the file's boundary state (attached/splits/unseen)");
const r4 = importAnnotationFile(annPath, { projectDir: project, now: NOW, force: true });
const s3 = snapshot();
check(r4.changed === true && r4.dataBlocks === 2 && s3.nodes === s1.nodes && s3.edges === s1.edges && s3.dump === s1.dump, `forced re-import: rows retired and re-made, nodes ${s1.nodes}=${s3.nodes}, edges ${s1.edges}=${s3.edges}, identical dump`);
importAnnotationFile(nobodyPath, { projectDir: project, now: NOW, force: true });
check(snapshot().dump === s1.dump, "forced re-import of the unseeded file: identical dump");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 826 boundaries: ${pass} pass, ${failCount} fail.  project: ${project}`);
process.exit(failCount ? 1 : 0);
