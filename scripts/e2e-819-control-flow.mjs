#!/usr/bin/env node
// Spec 819 — the control-flow producer, against a ground-truth fixture and the
// real corpus.
//
//   fixture (analyzed by the real pipeline):
//     $1000 entry:  jsr $1020 ; jsr $FFD2 ; ldx #3 ; loop: dex ; bne loop ; sta $D011 ; jmp $1040
//     $1020 sub:    lda #1 ; rts
//     $1040 tail:   jsr $3000 (OUTSIDE the image) ; rts       … image padded to $20FF
//   - routines: $1000 (entry), $1020 (jsr target), $1040 (jmp target with fall-in? no: jmp target → label unless called)
//   - CALLS $1000→$1020 ; CALLS_ROM $1000→c64:rom:ffd2 with instruction "jsr $FFD2"
//   - BRANCHES_TO with mnemonic bne only; the `sta $D011` (typed `branch` by discovery) emits NOTHING
//   - JUMPS_TO $1000→label $1040 ; CALLS → s819:ram:addr:3000 (outside the image: an addr node, D5)
//   - seed twice → identical dump; a human name survives; orphan on removal
//   corpus: every _analysis.json under analysis/tmp/spec-816 — zero BRANCHES_TO with a non-branch mnemonic,
//           counts printed, lnr_boot seeds in under one second
//
// Exit 0 = pass, 1 = fail.   npm run e2e:819

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { seedControlFlow } = await import(join(ROOT, "dist/knowledge-graph/producers/control-flow.js"));
const { seedMemoryAccess } = await import(join(ROOT, "dist/knowledge-graph/producers/memory-access.js"));
const { GraphStore } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const BRANCHES = new Set(["bcc", "bcs", "beq", "bne", "bmi", "bpl", "bvc", "bvs"]);

// ---------------------------------------------------------------- fixture

const project = mkdtempSync(join(tmpdir(), "c64re-819-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
mkdirSync(join(project, "analysis"), { recursive: true });
writeFileSync(join(project, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "p", name: "Spec 819 fixture", slug: "s819", rootPath: project }));

const image = new Uint8Array(0x1100).fill(0xea); // $1000-$20FF, NOPs
const put = (addr, bytes) => image.set(bytes, addr - 0x1000);
put(0x1000, [
  0x20, 0x20, 0x10,       // jsr $1020
  0x20, 0xd2, 0xff,       // jsr $FFD2
  0xa2, 0x03,             // ldx #3
  0xca,                   // $1008 loop: dex
  0xd0, 0xfd,             // bne $1008
  0x8d, 0x11, 0xd0,       // sta $D011
  0x4c, 0x40, 0x10,       // jmp $1040
]);
put(0x1020, [0xa9, 0x01, 0x60]);           // lda #1 ; rts
put(0x1040, [0x20, 0x00, 0x30, 0x60]);     // jsr $3000 ; rts — $3000 is outside the image
const prg = new Uint8Array(image.length + 2);
prg[0] = 0x00; prg[1] = 0x10; prg.set(image, 2);
const prgPath = join(project, "analysis", "fixture.prg");
const analysisPath = join(project, "analysis", "fixture_analysis.json");
writeFileSync(prgPath, prg);
execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prgPath, analysisPath, "1000"], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: project } });

const r1 = seedControlFlow({ projectDir: project, analysisPath });
console.log(`  info  fixture: routines=${r1.routines} labels=${r1.labels} addr=${r1.addrNodes} edges=${JSON.stringify(r1.edges)} ${r1.ms.toFixed(1)} ms`);

let graph = Graph.open(project);
const R = (a) => `s819:ram/fixture:routine:${a}`;
const entry = graph.resolve(R("1000"));
check(!entry.dangling && entry.attrs.entry_source !== undefined && entry.name === "W1000", "entry routine s819:ram/fixture:routine:1000 (W1000, entry_source)");
check(!graph.resolve(R("1020")).dangling, "jsr target $1020 is a routine");
const callees = graph.callees(R("1000"));
check(callees.some((e) => e.type === "CALLS" && e.to === R("1020")), "CALLS $1000 → $1020");
const rom = callees.find((e) => e.type === "CALLS_ROM");
check(rom && rom.to === "c64:rom:ffd2" && rom.evidence.instruction === "jsr $FFD2" && rom.toNode.symbol === "CHROUT", 'CALLS_ROM → c64:rom:ffd2, evidence "jsr $FFD2", resolves to CHROUT');
const out1000 = graph.edgesOutOf(R("1000"));
const branches = out1000.filter((e) => e.type === "BRANCHES_TO");
check(branches.length === 1 && branches[0].evidence.mnemonic === "bne", "exactly one BRANCHES_TO from $1000, mnemonic bne");
check(!out1000.some((e) => e.evidence.mnemonic === "sta"), "sta $D011 (typed `branch` by discovery) emits no control-flow edge");
const jmp = out1000.find((e) => e.type === "JUMPS_TO");
check(jmp && jmp.to.endsWith(":1040"), `JUMPS_TO → …:1040 (${jmp?.to})`);
const ext = graph.edgesInto("s819:ram:addr:3000").find((e) => e.type === "CALLS");
check(ext && ext.toNode.kind === "addr" && !ext.toNode.dangling && ext.evidence.instruction === "jsr $3000", "jsr $3000 (outside the image) → CALLS to addr node s819:ram:addr:3000 (D5)");
check(graph.containerOf(`s819:ram/fixture:label:1008`).some((n) => n.id === R("1000")), "label $1008 CONTAINED by routine $1000");
const path = graph.path(R("1000"), "c64:rom:ffd2");
check(path && path.length === 1, "path(entry → CHROUT)");
graph.close();

// idempotence + human survival
let store = GraphStore.open(project);
const h1 = store.contentHash();
store.upsertHuman({ id: R("1020"), kind: "routine", name: "get_one", origin: "user", confidence: "user_asserted" });
store.close();
seedControlFlow({ projectDir: project, analysisPath });
store = GraphStore.open(project);
check(store.contentHash() === h1, `seed twice → identical generated layer (${h1.slice(0, 16)})`);
store.close();
graph = Graph.open(project);
check(graph.resolve(R("1020")).name === "get_one", "human name survives a re-seed");
graph.close();

// ---------------------------------------------------------------- 826.0 T1 / T2 / T5

{
  const { resolveAddresses, ambiguousAddresses } = await import(join(ROOT, "dist/knowledge-graph/producers/resolve.js"));
  const { PlatformKb } = await import(join(ROOT, "dist/platform-kb/read.js"));
  const analyze = (prgPath, analysisPath, load) => execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prgPath, analysisPath, load], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: project } });
  const makePrg = (name, load, size, parts) => {
    const img = new Uint8Array(size).fill(0xea);
    for (const [addr, bytes] of parts) img.set(bytes, addr - load);
    const p = new Uint8Array(size + 2);
    p[0] = load & 0xff; p[1] = load >> 8; p.set(img, 2);
    const prgPath = join(project, "analysis", `${name}.prg`);
    const analysisPath = join(project, "analysis", `${name}_analysis.json`);
    writeFileSync(prgPath, p);
    analyze(prgPath, analysisPath, load.toString(16));
    return analysisPath;
  };

  // T1 — code UNDER BASIC: the jsr target is decoded code in the image → CALLS only, the ROM named as the alternative
  const kb = new PlatformKb();
  let romTarget;
  for (let a = 0xbb10; a < 0xbbf0; a += 1) { const n = kb.node("c64", a); if (n && n.kind === "rom") { romTarget = a; break; } }
  kb.close();
  if (romTarget === undefined) {
    console.log("  skip  T1: no documented BASIC ROM entry in $BB10-$BBF0 — loudly skipped, not passed");
  } else {
    const lo = romTarget & 0xff;
    const ub = makePrg("under_basic", 0xbb00, 0x100, [[0xbb00, [0x20, lo, 0xbb, 0x60]], [romTarget, [0xa9, 0x01, 0x60]]]);
    seedControlFlow({ projectDir: project, analysisPath: ub });
    const g = Graph.open(project);
    const hex = romTarget.toString(16).padStart(4, "0");
    const out = g.callees(`s819:ram/under_basic:routine:bb00`);
    const calls = out.filter((e) => e.type === "CALLS");
    const romCalls = out.filter((e) => e.type === "CALLS_ROM");
    check(calls.length === 1 && calls[0].to === `s819:ram/under_basic:routine:${hex}` && calls[0].evidence.ambiguity === "ram-under-rom" && calls[0].evidence.rom_alternative === `c64:rom:${hex}`, `T1: jsr $${hex.toUpperCase()} into decoded code under BASIC → CALLS with evidence.rom_alternative`);
    check(romCalls.length === 0 && g.romCalls("under_basic").length === 0, "T1: no CALLS_ROM for code under BASIC (306 of 328 on Wasteland were this)");
    g.close();
  }

  // T2 — two owners, one address: alpha calls $2000, beta HAS $2000 → RESOLVES_TO, callers / callees / path cross the boundary
  const alpha = makePrg("alpha", 0x1000, 0x100, [[0x1000, [0x20, 0x00, 0x20, 0x60]]]);
  const beta = makePrg("beta", 0x2000, 0x100, [[0x2000, [0xa9, 0x01, 0x60]]]);
  seedControlFlow({ projectDir: project, analysisPath: alpha });
  seedControlFlow({ projectDir: project, analysisPath: beta });
  const r = resolveAddresses(project);
  check(r.resolved >= 1 && r.ambiguous === 0, `T2: resolve pass → RESOLVES_TO=${r.resolved} ambiguous=${r.ambiguous} (${r.ms.toFixed(0)} ms)`);
  let g = Graph.open(project);
  const A = "s819:ram/alpha:routine:1000";
  const B = "s819:ram/beta:routine:2000";
  const into = g.callers(B);
  check(into.some((e) => e.from === A && e.type === "CALLS" && e.evidence.via === "s819:ram:addr:2000"), "T2: callers(beta $2000) includes alpha's jsr, evidence.via = the addr alias");
  const outA = g.callees(A);
  check(outA.length === 1 && outA[0].to === B && outA[0].toNode.kind === "routine" && outA[0].evidence.via === "s819:ram:addr:2000", "T2: callees(alpha) lands on beta's ROUTINE, not the addr node");
  const p = g.path(A, B);
  check(p && p.length === 1 && p[0].to === B, "T2: path(alpha → beta) crosses the artifact boundary in one hop");
  check(g.edgesOutOf("s819:ram:addr:2000").some((e) => e.type === "RESOLVES_TO" && e.to === B), "T2: the addr node carries RESOLVES_TO → beta");
  g.close();
  // a third owner at the same address → ambiguous: no edge, the ambiguity recorded
  const gamma = makePrg("gamma", 0x2000, 0x100, [[0x2000, [0xa9, 0x02, 0x60]]]);
  seedControlFlow({ projectDir: project, analysisPath: gamma });
  const r2 = resolveAddresses(project);
  g = Graph.open(project);
  const amb = ambiguousAddresses(g.store);
  check(r2.ambiguous === 1 && amb.length === 1 && amb[0].id === "s819:ram:addr:2000" && amb[0].candidates.length === 2, "T2: a second owner at $2000 → no RESOLVES_TO, ambiguity recorded (2 candidates)");
  check(g.callers(B).length === 0 && g.callees(A)[0].toNode.kind === "addr", "T2: ambiguous alias → callees(alpha) is the addr node again, visible not guessed");
  // T5 — a zero-page cell without a book line is a node by grammar
  const fe = g.nodesAt("$00FE");
  check(fe.some((n) => n.id === "c64:zp:00fe" && !n.dangling && n.platform), "T5: nodesAt($00FE) includes c64:zp:00fe (synthesized from the grammar)");
  check(g.resolve("c64:zp:00fe").dangling === false && g.resolve("c64:rom:0000").dangling === true, "T5: c64:zp:00fe resolves; c64:rom:0000 (kind contradicts address) stays dangling (818 D7)");
  g.close();

  // T7 — an artifact needs a machine: drive code declared c1541 seeds under drv/ with 1541 ROM / ZP / VIA ids
  const { contextForOwner, declareMachine, declaredMachines } = await import(join(ROOT, "dist/knowledge-graph/producers/machine.js"));
  const { ownerFromAnalysisPath } = await import(join(ROOT, "dist/knowledge-graph/producers/control-flow.js"));
  mkdirSync(join(project, "analysis", "drivecode"), { recursive: true });
  const drvImg = new Uint8Array(0x100).fill(0xea);
  drvImg.set([0x20, 0xe9, 0xf5, 0xa5, 0x31, 0x8d, 0x00, 0x18, 0x60], 0); // $0300: jsr $F5E9 ; lda $31 ; sta $1800 ; rts
  const drvPrg = new Uint8Array(0x102); drvPrg[0] = 0x00; drvPrg[1] = 0x03; drvPrg.set(drvImg, 2);
  const drvPrgPath = join(project, "analysis", "drivecode", "t18s12_0300.prg");
  const drvAnalysis = join(project, "analysis", "drivecode", "t18s12_0300_analysis.json");
  writeFileSync(drvPrgPath, drvPrg);
  analyze(drvPrgPath, drvAnalysis, "300");
  const drvOwner = ownerFromAnalysisPath(drvAnalysis);
  const before = contextForOwner(project, drvOwner, undefined, drvAnalysis);
  check(before.machine === "c64" && before.source === "default" && typeof before.hint === "string" && before.hint.includes("c64re graph machine"), `T7: undeclared drive code defaults to c64 WITH a hint (${before.source})`);
  seedControlFlow({ projectDir: project, analysisPath: drvAnalysis, owner: drvOwner, ctx: before.ctx });
  g = Graph.open(project);
  // as C64 code, $F5E9 is an undocumented address in the ROM range: an addr node with the ROM named as the alternative (RAM could live under it)
  check(!g.resolve(`s819:ram/${drvOwner}:routine:0300`).dangling && g.callees(`s819:ram/${drvOwner}:routine:0300`).some((e) => (e.type === "CALLS_ROM" && e.to === "c64:rom:f5e9") || (e.type === "CALLS" && e.to === "s819:ram:addr:f5e9" && e.evidence.rom_alternative === "c64:rom:f5e9")), "T7: seeded as c64 it wears C64 ids — addr:f5e9 with rom_alternative c64:rom:f5e9 (the mistake WL1 found, visible not hidden)");
  g.close();
  declareMachine(project, drvOwner, "c1541");
  const after = contextForOwner(project, drvOwner, undefined, drvAnalysis);
  check(after.machine === "c1541" && after.source === "declared" && after.ctx.space === "drv" && after.hint === undefined, "T7: declared → c1541, space drv, no hint");
  check(declaredMachines(project).some((m) => m.owner === drvOwner && m.machine === "c1541"), "T7: the declaration is listed");
  seedControlFlow({ projectDir: project, analysisPath: drvAnalysis, owner: drvOwner, ctx: after.ctx });
  seedMemoryAccess({ projectDir: project, analysisPath: drvAnalysis, owner: drvOwner, ctx: after.ctx });
  g = Graph.open(project);
  const drvR = `s819:drv/${drvOwner}:routine:0300`;
  check(!g.resolve(drvR).dangling && g.resolve(`s819:ram/${drvOwner}:routine:0300`).dangling, "T7: re-seed moved the routine to drv/ and removed the ram/ row (replacement unit = owner)");
  const drvOut = g.edgesOutOf(drvR);
  const romCall = drvOut.find((e) => e.type === "CALLS_ROM");
  check(romCall && romCall.to === "c1541:rom:f5e9" && romCall.toNode.platform && !romCall.toNode.dangling, `T7: jsr $F5E9 → c1541:rom:f5e9 (1541 DOS ROM by the machine's map, synthesized when the cache has no name)`);
  check(drvOut.some((e) => e.type === "USES_ZP" && e.to === "c1541:zp:0031"), "T7: lda $31 → c1541:zp:0031 (a DOS variable, not a KERNAL name)");
  check(drvOut.some((e) => e.type === "USES_HARDWARE" && e.to === "c1541:io:1800" && e.toNode.symbol === "VIA1_PRB"), "T7: sta $1800 → c1541:io:1800 VIA1_PRB");
  g.close();
}

// ---------------------------------------------------------------- corpus

const corpus = join(ROOT, "analysis/tmp/spec-816");
if (existsSync(corpus)) {
  const files = readdirSync(corpus).filter((f) => f.endsWith(".analysis.json") || f.endsWith("_analysis.json")).map((f) => join(corpus, f));
  const cproject = mkdtempSync(join(tmpdir(), "c64re-819-corpus-"));
  mkdirSync(join(cproject, "knowledge"), { recursive: true });
  writeFileSync(join(cproject, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "c", name: "corpus", slug: "corpus", rootPath: cproject }));
  let bad = 0;
  let total = 0;
  let slowest = { owner: "", ms: 0 };
  for (const f of files) {
    const owner = f.replace(/^.*\//, "").replace(/(_analysis|\.analysis)\.json$/, "").toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
    let r;
    try { r = seedControlFlow({ projectDir: cproject, analysisPath: f, owner }); } catch (e) { fail(`${owner}: ${e.message.slice(0, 120)}`); continue; }
    total += Object.values(r.edges).reduce((x, y) => x + y, 0);
    if (r.ms > slowest.ms) slowest = { owner, ms: r.ms };
  }
  const g = Graph.open(cproject);
  const rows = g.store.db.prepare("SELECT evidence FROM edges WHERE type = 'BRANCHES_TO'").all();
  for (const row of rows) { const ev = JSON.parse(row.evidence); if (!BRANCHES.has(ev.mnemonic)) bad += 1; }
  const c = g.store.counts();
  g.close();
  check(bad === 0, `corpus (${files.length} reports): zero BRANCHES_TO with a non-branch mnemonic (${rows.length} branches checked)`);
  console.log(`  info  corpus: ${c.nodes} nodes, ${c.edges} edges; slowest seed ${slowest.owner} ${slowest.ms.toFixed(0)} ms`);
  check(slowest.ms < 1000, "slowest report seeds in under one second");
  const lnr = files.find((f) => /lnr_boot/.test(f));
  if (lnr) {
    const g2 = Graph.open(cproject);
    const chrout = g2.callers("c64:rom:ffd2");
    console.log(`  info  lnr_boot: callers(c64:rom:ffd2) = ${chrout.length} (${chrout.map((e) => e.evidence.ambiguity ?? "direct").join(",")})`);
    check(chrout.every((e) => e.evidence.instruction === "jsr $FFD2"), "lnr_boot: every CHROUT caller carries instruction \"jsr $FFD2\"");
    g2.close();
  }
} else {
  console.log("  skip  corpus: analysis/tmp/spec-816 absent (run npm run measure:816 first) — loudly skipped, not passed");
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 819: ${pass} pass, ${failCount} fail.  project: ${project}`);
process.exit(failCount ? 1 : 0);
