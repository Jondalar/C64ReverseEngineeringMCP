#!/usr/bin/env node
// Spec 820 — the memory access graph. Ground-truth fixture + lnr_boot reconciliation.
//
//   fixture (analyzed by the real pipeline), one routine at $1000:
//     lda $D011 ; and #$7f ; sta $D011      READS + WRITES c64:io:d011, USES_HARDWARE ×2
//     inc $D019                              READS and WRITES c64:io:d019 (RMW = two rows)
//     sta $DC0D                              WRITES c64:io:dc0d
//     lda #$00 ; sta $20 ; lda #$40 ; sta $21   pointer construction → WRITES c64:zp:0020/0021, USES_ZP
//     lda ($20),y                            READS_INDIRECT → c64:zp:0020 (pointer_zp $20, target unknown)
//                                            + D3 second edge READS → $4000 (inferred, via_zp $20) if the
//                                              analyzer records the construction with a constant target
//     sta ($FB),y                            WRITES_INDIRECT → c64:zp:00fb, NO second edge (no construction)
//     lda $A000,x                            READS c64:rom:a000, indexed=true
//     jmp ($0314)                            nothing from 820 (control flow)
//     rts
//   corpus: lnr_boot — edge counts reconcile with an independent instruction classification;
//           every *_INDIRECT edge says target "unknown"; every via_zp edge has a construction; idempotent.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:820

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { seedControlFlow } = await import(join(ROOT, "dist/knowledge-graph/producers/control-flow.js"));
const { seedMemoryAccess, classifyInstruction } = await import(join(ROOT, "dist/knowledge-graph/producers/memory-access.js"));
const { GraphStore } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

function makeProject(name) {
  const dir = mkdtempSync(join(tmpdir(), `c64re-820-${name}-`));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  mkdirSync(join(dir, "analysis"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: name, name, slug: `s820${name}`, rootPath: dir }));
  return dir;
}

// ---------------------------------------------------------------- fixture

const project = makeProject("fx");
const image = new Uint8Array(0x100).fill(0xea);
const code = [
  0xad, 0x11, 0xd0,       // lda $D011
  0x29, 0x7f,             // and #$7f
  0x8d, 0x11, 0xd0,       // sta $D011
  0xee, 0x19, 0xd0,       // inc $D019
  0x8d, 0x0d, 0xdc,       // sta $DC0D
  0xa9, 0x00, 0x85, 0x20, // lda #$00 ; sta $20
  0xa9, 0x40, 0x85, 0x21, // lda #$40 ; sta $21
  0xb1, 0x20,             // lda ($20),y
  0x91, 0xfb,             // sta ($FB),y
  0xbd, 0x00, 0xa0,       // lda $A000,x
  0x6c, 0x14, 0x03,       // jmp ($0314)
  0x60,                   // rts
];
image.set(code, 0);
const prg = new Uint8Array(image.length + 2); prg[0] = 0x00; prg[1] = 0x10; prg.set(image, 2);
const prgPath = join(project, "analysis", "fixture.prg");
const analysisPath = join(project, "analysis", "fixture_analysis.json");
writeFileSync(prgPath, prg);
execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prgPath, analysisPath, "1000"], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: project } });

seedControlFlow({ projectDir: project, analysisPath });
const r = seedMemoryAccess({ projectDir: project, analysisPath });
console.log(`  info  fixture: edges=${JSON.stringify(r.edges)} classified=${JSON.stringify(r.classified)} indirect-resolved=${r.indirectResolved} ${r.ms.toFixed(1)} ms`);

let graph = Graph.open(project);
const R = "s820fx:ram/fixture:routine:1000";
const out = graph.edgesOutOf(R);
const has = (type, to, pred = () => true) => out.some((e) => e.type === type && e.to === to && pred(e));
check(has("READS", "c64:io:d011", (e) => e.evidence.source_address === 0x1000) && has("WRITES", "c64:io:d011", (e) => e.evidence.source_address === 0x1005), "READS + WRITES c64:io:d011 from lda/sta with their own pcs");
check(has("READS", "c64:io:d019") && has("WRITES", "c64:io:d019"), "inc $D019 → one READS and one WRITES row");
check(has("WRITES", "c64:io:dc0d"), "WRITES c64:io:dc0d");
check(has("USES_HARDWARE", "c64:io:d011") && has("USES_HARDWARE", "c64:io:d019") && has("USES_HARDWARE", "c64:io:dc0d"), "USES_HARDWARE rows for D011 / D019 / DC0D");
check(has("WRITES", "c64:zp:0020") && has("WRITES", "c64:zp:0021") && has("USES_ZP", "c64:zp:0020"), "pointer construction: WRITES c64:zp:0020/0021 + USES_ZP");
const ind = out.find((e) => e.type === "READS_INDIRECT");
check(ind && ind.to === "c64:zp:0020" && ind.evidence.pointer_zp === 0x20 && ind.evidence.target === "unknown" && ind.confidence === "heuristic", "lda ($20),y → READS_INDIRECT to the pointer, target unknown, heuristic");
check(has("USES_ZP", "c64:zp:0021", (e) => e.evidence.role === "pointer_base"), "indirect base $20 also USES_ZP $21 (the pair)");
const wind = out.find((e) => e.type === "WRITES_INDIRECT");
check(wind && wind.to === "c64:zp:00fb" && !out.some((e) => e.type === "WRITES" && e.evidence.via_zp === 0xfb), "sta ($FB),y → WRITES_INDIRECT, and NO second edge (no construction anywhere)");
const viaEdge = out.find((e) => e.type === "READS" && e.evidence.via_zp === 0x20);
const constructed = JSON.parse(readFileSync(analysisPath, "utf8")).codeSemantics?.indirectPointers?.some((k) => k.zeroPageBase === 0x20 && k.constantTarget === 0x4000);
if (constructed) check(viaEdge && viaEdge.confidence === "inferred" && viaEdge.toNode.address === 0x4000, "D3: same-routine construction → second READS edge to $4000, inferred, via_zp $20");
else console.log("  info  D3 second edge: the analyzer recorded no constant-target construction for $20 in this fixture — not asserted");
check(has("READS", "c64:rom:a000", (e) => e.evidence.indexed === true), "lda $A000,x → READS c64:rom:a000, indexed=true");
check(!out.some((e) => e.evidence.mnemonic === "jmp"), "jmp ($0314) emits nothing from 820");
check(graph.writers("$D011").some((e) => e.from === R) && graph.readers("$D019").some((e) => e.from === R), "readers/writers answer over platform nodes");
check(graph.zpUsage(R).some((z) => z.address === 0x20 && z.role === "pointer_base"), "zpUsage(routine) groups by role");
check(graph.indirectAccesses(R).length === 2 && graph.indirectAccesses("$FB").length === 1, "indirectAccesses by routine and by ZP");
graph.close();

// idempotence + human survival
let store = GraphStore.open(project);
const h1 = store.contentHash();
store.upsertHuman({ id: R, kind: "routine", name: "vic_setup", origin: "user", confidence: "user_asserted" });
store.close();
seedMemoryAccess({ projectDir: project, analysisPath });
store = GraphStore.open(project);
check(store.contentHash() === h1, `seed twice → identical generated layer (${h1.slice(0, 16)})`);
store.close();
graph = Graph.open(project);
check(graph.resolve(R).name === "vic_setup", "human name survives a re-seed");
graph.close();

// ---------------------------------------------------------------- lnr_boot reconciliation

const lnr = join(ROOT, "analysis/tmp/spec-816/samples_lnr_boot_02a7_fff7_prg.analysis.json");
if (existsSync(lnr)) {
  const cproject = makeProject("lnr");
  seedControlFlow({ projectDir: cproject, analysisPath: lnr, owner: "lnr_boot" });
  const rr = seedMemoryAccess({ projectDir: cproject, analysisPath: lnr, owner: "lnr_boot" });
  const report = JSON.parse(readFileSync(lnr, "utf8"));
  const seen = new Map();
  for (const i of [...(report.codeAnalysis?.instructions ?? []), ...(report.probableCodeAnalysis?.instructions ?? [])]) if (!seen.has(i.address)) seen.set(i.address, i);
  let reads = 0, writes = 0, rmw = 0, indirect = 0;
  for (const i of seen.values()) {
    const c = classifyInstruction(i);
    if (!c) continue;
    if (c.mode === "indirect") { indirect += 1; continue; }
    if (c.kind === "read") reads += 1; else if (c.kind === "write") writes += 1; else rmw += 1;
  }
  const g = Graph.open(cproject);
  const db = g.store.db;
  const n = (t) => Number(db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE type = ? AND producer = '820'`).get(t).n);
  const direct = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type IN ('READS','WRITES') AND producer = '820' AND json_extract(evidence, '$.via_zp') IS NULL").get().n;
  const expectedDirect = reads + writes + 2 * rmw;
  check(Number(direct) === expectedDirect, `lnr_boot: direct READS+WRITES rows ${direct} = ${reads} + ${writes} + 2×${rmw}`);
  check(n("READS_INDIRECT") + n("WRITES_INDIRECT") === indirect + Number(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type='WRITES_INDIRECT' AND producer='820' AND json_extract(evidence,'$.mnemonic') IN ('inc','dec','asl','lsr','rol','ror')").get().n), `lnr_boot: INDIRECT rows = ${indirect} indirect instructions (RMW-indirect counted twice)`);
  const unknown = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type LIKE '%_INDIRECT' AND json_extract(evidence, '$.target') = 'unknown'").get().n;
  check(Number(unknown) === n("READS_INDIRECT") + n("WRITES_INDIRECT"), "every *_INDIRECT edge says target unknown (no invented target)");
  const via = db.prepare("SELECT evidence FROM edges WHERE producer = '820' AND json_extract(evidence, '$.via_zp') IS NOT NULL").all();
  const constructions = report.codeSemantics?.indirectPointers ?? [];
  const viaOk = via.every((row) => { const ev = JSON.parse(row.evidence); return constructions.some((k) => k.zeroPageBase === ev.via_zp && k.start === ev.constructed_at && k.constantTarget !== undefined); });
  check(viaOk, `every via_zp edge (${via.length}) has a matching constant-target construction`);
  console.log(`  info  lnr_boot: ${JSON.stringify(rr.edges)} classified=${JSON.stringify(rr.classified)} indirect-resolved=${rr.indirectResolved} ${rr.ms.toFixed(0)} ms`);
  check(rr.ms < 2000, "lnr_boot seeds in under two seconds");
  g.close();
} else {
  console.log("  skip  lnr_boot report absent (run npm run measure:816) — loudly skipped, not passed");
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 820: ${pass} pass, ${failCount} fail.  project: ${project}`);
process.exit(failCount ? 1 : 0);
