#!/usr/bin/env node
// Spec 820.2 (D7) — the four private walks read the store. Output parity gate.
//
//   The four walks:  inspect_address_range (VIC program + xrefs into range)
//                    ram_report            (the access table)
//                    address-index         (buildXrefIndex)
//                    evidenceGraph         (reads_from / writes_to)
//   Two arms per walk on ONE input: the OLD JSON walk (kept under `source: "json"`)
//   and the NEW store walk. The diff must be empty, or consist ONLY of the
//   differences named below — every one of them a fact the graph holds and the
//   JSON walk did not, or a defect of the JSON walk the graph does not repeat:
//
//     inspect xrefs / xref index
//       removed  (fallthrough)     adjacency, never a reference — 818 has no such edge type
//       removed  jmp (abs) `jump`  store gap: 819 skips `jmp ind`, 820 D1 says "control flow is 818's"
//       relabel  (branch)→read/write  discovery tags every memory operand `branch` (819 D3)
//       added    read / write / read-indirect / write-indirect / data / "… via $zp"  820's edges
//       WARN     call → pc+3       819 producer turns a jsr's FALLTHROUGH xref into CALLS (its defect, not ours)
//     ram_report
//       removed  rows with ZERO touches   the JSON walk aggregated every direct-operand instruction
//                                         (jsr/jmp targets, undocumented opcodes) before checking the mnemonic
//       changed  provenance/confidence    the same defect: a jsr from confirmed code counted as a confirmed touch
//       added    (zp,x) indirect rows     the JSON walk knew only (zp),y; 820 D1 knows both
//       added    one header note          where the table came from
//     evidenceGraph
//       identical, on lnr_boot (no confirmed copy loop) AND on a fixture that has one
//
//   Fallback: an owner with no graph rows is seeded on demand where the project can
//   be seeded (MCP side), and otherwise SAID in the output — never silent.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:820-2

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { seedControlFlow } = await import(join(ROOT, "dist/knowledge-graph/producers/control-flow.js"));
const { seedMemoryAccess } = await import(join(ROOT, "dist/knowledge-graph/producers/memory-access.js"));
const { buildReport, resolveProjectGraph } = await import(join(ROOT, "dist/server-tools/inspect-range.js"));
const { buildXrefIndexDetailed } = await import(join(ROOT, "dist/project-knowledge/address-index.js"));
const { renderRamStateMarkdown, resolveRamAccesses } = require(join(ROOT, "dist/pipeline/analysis/ram-state.cjs"));
const { buildEvidenceGraph } = require(join(ROOT, "dist/pipeline/analysis/evidence-graph.cjs"));
const { extractVicEvidence } = require(join(ROOT, "dist/pipeline/analysis/c64-hardware.cjs"));

let pass = 0;
let failCount = 0;
let warnCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const warn = (msg) => { warnCount += 1; console.log(`  WARN  ${msg}`); };
const info = (msg) => console.log(`  info  ${msg}`);
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

const READ = new Set(["lda", "ldx", "ldy", "cmp", "cpx", "cpy", "adc", "sbc", "and", "ora", "eor", "bit"]);
const WRITE = new Set(["sta", "stx", "sty"]);
const RMW = new Set(["inc", "dec", "asl", "lsr", "rol", "ror"]);
const DIRECT = new Set(["zp", "zp,x", "zp,y", "abs", "abs,x", "abs,y"]);
const ADDED_TYPES = new Set(["read", "write", "read-indirect", "write-indirect", "data"]);

function makeProject(name, withProjectJson = true) {
  const dir = mkdtempSync(join(tmpdir(), `c64re-820-2-${name}-`));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  mkdirSync(join(dir, "analysis"), { recursive: true });
  if (withProjectJson) writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: name, name, slug: `s8202${name}`, rootPath: dir }));
  return dir;
}

function analysisContext(report, prgPath) {
  const prg = readFileSync(prgPath);
  return { binaryName: prgPath, buffer: prg.subarray(2), mapping: report.mapping, entryPoints: report.entryPoints ?? [], candidateRegions: [], discoveredCode: report.codeAnalysis, probableCode: report.probableCodeAnalysis, symbols: report.symbols ?? [] };
}

function instructionMap(report) {
  const m = new Map();
  for (const i of [...(report.codeAnalysis?.instructions ?? []), ...(report.probableCodeAnalysis?.instructions ?? [])]) if (!m.has(i.address)) m.set(i.address, i);
  return m;
}

/** Classify one (source, target, type) reference that the OLD walk had and the NEW does not. */
function classifyRemoved(x, newKeys, instAt) {
  if (x.type === "fallthrough") return "removed:fallthrough";
  const src = instAt.get(x.source);
  if (!src) return undefined;
  if (src.mnemonic === "jmp" && src.addressingMode === "ind") return "removed:jmp-indirect(store gap)";
  const mn = src.mnemonic;
  if (x.type === "branch" && (READ.has(mn) || WRITE.has(mn) || RMW.has(mn))) {
    const relabel = RMW.has(mn) ? ["read", "write"] : READ.has(mn) ? ["read"] : ["write"];
    if (relabel.every((t) => newKeys.has(`${x.source}|${x.target}|${t}`))) return "relabel:branch->read/write";
  }
  return undefined;
}

/** Classify one reference the NEW walk has and the OLD did not. */
function classifyAdded(x, instAt) {
  if (ADDED_TYPES.has(x.type) || /^(read|write) via \$/u.test(x.type)) return `added:${x.type.replace(/ via \$[0-9A-F]+$/u, " via zp")}`;
  const src = instAt.get(x.source);
  if (x.type === "call" && src && src.mnemonic === "jsr" && x.target === x.source + 3) return "WARN:819-jsr-fallthrough-CALLS";
  return undefined;
}

function classifyReferenceSets(oldRefs, newRefs, instAt, label) {
  const key = (x) => `${x.source}|${x.target}|${x.type}`;
  const newKeys = new Set(newRefs.map(key));
  const oldKeys = new Set(oldRefs.map(key));
  const buckets = {};
  const bump = (k) => { buckets[k] = (buckets[k] ?? 0) + 1; };
  const unexplained = [];
  for (const x of oldRefs) {
    if (newKeys.has(key(x))) { bump("kept"); continue; }
    const c = classifyRemoved(x, newKeys, instAt);
    if (c) bump(c); else unexplained.push(`OLD ${JSON.stringify(x)}`);
  }
  for (const x of newRefs) {
    if (oldKeys.has(key(x))) continue;
    const c = classifyAdded(x, instAt);
    if (c) bump(c); else unexplained.push(`NEW ${JSON.stringify(x)}`);
  }
  info(`${label}: ${Object.entries(buckets).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  check(unexplained.length === 0, `${label}: every difference is a listed one (${unexplained.length} unexplained)`);
  for (const u of unexplained.slice(0, 12)) console.log(`          ${u}`);
  const defect = buckets["WARN:819-jsr-fallthrough-CALLS"] ?? 0;
  if (defect > 0) warn(`${label}: ${defect} CALLS edges to pc+3 — the 819 producer turns a jsr's fallthrough xref into CALLS (control-flow.ts, loop over xrefs: skip type "fallthrough"). Not 820.2's file; they vanish with that one line.`);
  return buckets;
}

function parseXrefSection(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## Code → range xrefs"));
  const out = [];
  let truncated = false;
  for (let i = start + 1; i < lines.length && !lines[i].startsWith("## "); i += 1) {
    const l = lines[i];
    if (l.includes("(truncated)")) { truncated = true; continue; }
    const m = l.match(/^- \$([0-9A-F]{4}) -> (.*)$/u);
    if (!m) continue;
    const source = parseInt(m[1], 16);
    for (const t of m[2].matchAll(/\$([0-9A-F]{4})\(([^)]+)\)/gu)) out.push({ source, target: parseInt(t[1], 16), type: t[2] });
  }
  return { refs: out, truncated };
}

function stripXrefs(text) {
  const lines = text.split("\n").filter((l) => !l.startsWith("Graph:"));
  const start = lines.findIndex((l) => l.startsWith("## Code → range xrefs"));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

function ramBlocks(text) {
  const blocks = new Map();
  const [head, ...rest] = text.split(/\n(?=### )/u);
  for (const b of rest) {
    const m = b.match(/^### \$([0-9A-F]{4})/u);
    if (m) blocks.set(parseInt(m[1], 16), b.replace(/\n+$/u, ""));
  }
  const hypIndex = text.indexOf("## Purpose Hypotheses");
  return { head, blocks, hypotheses: hypIndex >= 0 ? text.slice(hypIndex) : "" };
}

const DIFF_DIR = join(ROOT, "analysis", "tmp", "spec-820-2");
const dump = (arm, name, text) => { try { mkdirSync(join(DIFF_DIR, arm), { recursive: true }); writeFileSync(join(DIFF_DIR, arm, name), text); } catch { /* the diff files are a courtesy */ } };

// ================================================================ A. lnr_boot parity

console.log("\nA. lnr_boot — OLD (JSON walk) vs NEW (store) on one seeded project");
const LNR = join(ROOT, "analysis/tmp/spec-816/samples_lnr_boot_02a7_fff7_prg.analysis.json");
const LNR_PRG = join(ROOT, "samples/lnr_boot_02a7_fff7.prg");
const OWNER = "lnr_boot_02a7_fff7";
if (!existsSync(LNR) || !existsSync(LNR_PRG)) {
  fail(`lnr_boot report or PRG absent (${LNR}) — the acceptance input; run npm run measure:816 first`);
} else {
  const project = makeProject("lnr");
  const analysisPath = join(project, "analysis", `${OWNER}_analysis.json`);
  const prgPath = join(project, "analysis", `${OWNER}.prg`);
  copyFileSync(LNR, analysisPath);
  copyFileSync(LNR_PRG, prgPath);
  const cf = seedControlFlow({ projectDir: project, analysisPath, owner: OWNER });
  const ma = seedMemoryAccess({ projectDir: project, analysisPath, owner: OWNER });
  info(`seeded 819 ${JSON.stringify(cf.edges)} 820 ${JSON.stringify(ma.edges)}`);
  const report = JSON.parse(readFileSync(analysisPath, "utf8"));
  const instAt = instructionMap(report);

  // ---- A1 inspect_address_range
  console.log("\n  A1 inspect_address_range");
  const RANGES = [["0000", "00FF"], ["0400", "07FF"], ["D000", "D02E"], ["DD00", "DD0F"], ["0000", "FFFF"]];
  for (const [s, e] of RANGES) {
    const args = { prgPath, analysisPath, projectDir: project, startAddress: parseInt(s, 16), endAddress: parseInt(e, 16) };
    const oldText = buildReport({ ...args, source: "json" });
    const newText = buildReport(args);
    dump("before", `inspect_${s}_${e}.md`, oldText);
    dump("after", `inspect_${s}_${e}.md`, newText);
    check(stripXrefs(oldText) === stripXrefs(newText), `$${s}-$${e}: segments, VIC register program, copy routines, display sections byte-identical`);
    check(newText.split("\n")[3]?.startsWith("Graph: ") && newText.includes(`owner=${OWNER}`), `$${s}-$${e}: the report says which graph it read`);
    const o = parseXrefSection(oldText);
    const n = parseXrefSection(newText);
    if (o.truncated || n.truncated) { info(`$${s}-$${e}: xref section truncated at 80 sources in ${o.truncated ? "old" : ""}${o.truncated && n.truncated ? "+" : ""}${n.truncated ? "new" : ""} — classified through the xref index below`); continue; }
    classifyReferenceSets(o.refs, n.refs, instAt, `$${s}-$${e} xrefs`);
  }

  // ---- A2 ram_report
  console.log("\n  A2 ram_report");
  const oldRam = renderRamStateMarkdown(report, { source: "json" });
  const newRam = renderRamStateMarkdown(report, { projectDir: project, owner: OWNER });
  dump("before", "ram_report.md", oldRam);
  dump("after", "ram_report.md", newRam);
  const oldT = resolveRamAccesses(report, { source: "json" });
  const newT = resolveRamAccesses(report, { projectDir: project, owner: OWNER });
  check(newT.source === "graph" && /^Access table: knowledge graph /u.test(newT.note ?? ""), `access table read from the graph (${newT.note?.slice(0, 60)}…)`);
  const O = new Map(oldT.ramAccesses.map((a) => [a.address, a]));
  const N = new Map(newT.ramAccesses.map((a) => [a.address, a]));
  const LISTS = ["directReads", "directWrites", "indexedReads", "indexedWrites", "indirectReads", "indirectWrites", "readModifyWrites"];
  const allInsts = [...instAt.values()];
  const zpxPcs = new Set(allInsts.filter((i) => i.addressingMode === "(zp,x)").map((i) => i.address));
  const classified = new Map(); // address → category
  const unexplained = [];
  for (const [addr, o] of O) {
    const n = N.get(addr);
    if (!n) {
      const touches = LISTS.reduce((sum, k) => sum + o[k].length, 0);
      if (touches === 0) { classified.set(addr, "removed:zero-touch-row"); continue; }
      unexplained.push(`removed $${hex4(addr)} with ${touches} touches`);
      continue;
    }
    const listsSame = LISTS.every((k) => JSON.stringify(o[k]) === JSON.stringify(n[k])) && JSON.stringify(o.immediateWriteValues) === JSON.stringify(n.immediateWriteValues);
    const provSame = JSON.stringify(o.provenances) === JSON.stringify(n.provenances);
    if (listsSame && provSame && o.confidence === n.confidence && JSON.stringify(o.reasons) === JSON.stringify(n.reasons)) continue;
    const extra = LISTS.flatMap((k) => n[k].filter((pc) => !o[k].includes(pc)));
    const missing = LISTS.flatMap((k) => o[k].filter((pc) => !n[k].includes(pc)));
    if (missing.length === 0 && extra.length > 0 && extra.every((pc) => zpxPcs.has(pc))) { classified.set(addr, "added:(zp,x)-indirect"); continue; }
    if (listsSame && !provSame) {
      const nonAccess = allInsts.filter((i) => DIRECT.has(i.addressingMode) && (i.targetAddress ?? i.operandValue) === addr && !READ.has(i.mnemonic) && !WRITE.has(i.mnemonic) && !RMW.has(i.mnemonic));
      const explained = [...new Set([...n.provenances, ...nonAccess.map((i) => i.provenance)])].sort().join();
      if (explained === [...o.provenances].sort().join()) { classified.set(addr, "changed:provenance-from-non-access-instruction"); continue; }
    }
    unexplained.push(`changed $${hex4(addr)} extra=[${extra.map(hex4)}] missing=[${missing.map(hex4)}] lists=${listsSame} prov=${provSame}`);
  }
  for (const addr of N.keys()) if (!O.has(addr)) unexplained.push(`added $${hex4(addr)}`);
  const tally = {};
  for (const c of classified.values()) tally[c] = (tally[c] ?? 0) + 1;
  info(`rows old=${oldT.ramAccesses.length} new=${newT.ramAccesses.length}  ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  for (const [addr, c] of classified) if (c !== "removed:zero-touch-row") info(`  $${hex4(addr)}: ${c}`);
  check(unexplained.length === 0, `ram_report: every changed row is a listed one (${unexplained.length} unexplained)`);
  for (const u of unexplained.slice(0, 12)) console.log(`          ${u}`);
  // rendered text: unchanged rows byte-identical, header differs by the note, hypotheses identical
  const ob = ramBlocks(oldRam);
  const nb = ramBlocks(newRam);
  const changedBlocks = [...ob.blocks.keys()].filter((a) => nb.blocks.has(a) && ob.blocks.get(a) !== nb.blocks.get(a));
  check(changedBlocks.every((a) => classified.has(a)), `ram_report text: every address block that differs is a classified one (${changedBlocks.length} differ, ${[...ob.blocks.keys()].filter((a) => nb.blocks.has(a) && !classified.has(a)).length} identical)`);
  check(nb.head.replace(`\n${newT.note}\n`, "") === ob.head, "ram_report text: the header differs by the access-table note only");
  check(ob.hypotheses === nb.hypotheses, "ram_report text: Purpose Hypotheses identical (ramHypotheses stay in the JSON — D7)");

  // ---- A3 address index
  console.log("\n  A3 address index (buildXrefIndex)");
  const oldIdx = buildXrefIndexDetailed(project, { source: "json" });
  const newIdx = buildXrefIndexDetailed(project);
  dump("before", "xref-index.jsonl", `${oldIdx.xrefs.map((x) => JSON.stringify(x, Object.keys(x).sort())).sort().join("\n")}\n`);
  dump("after", "xref-index.jsonl", `${newIdx.xrefs.map((x) => JSON.stringify(x, Object.keys(x).sort())).sort().join("\n")}\n`);
  check(newIdx.sources[OWNER] === "graph" && newIdx.notes.length === 0, `index read from the graph, no fallback notes (${newIdx.xrefs.length} entries; old ${oldIdx.xrefs.length})`);
  check(newIdx.xrefs.every((x) => x.owner === OWNER), "entries keep the artifact stem as owner");
  const b = classifyReferenceSets(oldIdx.xrefs, newIdx.xrefs, instAt, "xref index");
  check((b["added:read"] ?? 0) > 0 && (b["added:write"] ?? 0) > 0 && (b["added:read-indirect"] ?? 0) > 0, "the index now answers who READS and WRITES an address, and through which pointer");
  const opOk = newIdx.xrefs.filter((x) => x.type === "call" || x.type === "jump").every((x) => oldIdx.xrefs.some((y) => y.source === x.source && y.target === x.target && y.operandText === x.operandText) || x.target === x.source + 3);
  check(opOk, "control-flow entries carry the same operandText as before");

  // ---- A4 evidence graph
  console.log("\n  A4 evidenceGraph");
  const vic = extractVicEvidence(analysisContext(report, prgPath));
  const oldEg = buildEvidenceGraph(report.codeSemantics, vic, report.segments, { source: "json" });
  const newEg = buildEvidenceGraph(report.codeSemantics, vic, report.segments, { projectDir: project, owner: OWNER });
  dump("before", "evidence-graph.json", JSON.stringify(oldEg, null, 2));
  dump("after", "evidence-graph.json", JSON.stringify(newEg, null, 2));
  check(JSON.stringify(oldEg) === JSON.stringify(newEg), `evidence graph identical (${newEg.nodes.length} nodes, ${newEg.edges.length} edges)`);
  const rw = newEg.edges.filter((e) => e.kind === "reads_from" || e.kind === "writes_to").length;
  info(`lnr_boot has ${rw} reads_from/writes_to edges (its copy loops are probable_code) — the fixture below proves the store path`);
}

// ================================================================ B. fixture — a confirmed copy loop

console.log("\nB. fixture — confirmed copy loop into the screen, evidence graph from the store");
{
  const project = makeProject("fx");
  const image = new Uint8Array(0x100).fill(0xea);
  const code = [
    0x78,                   // $1000 sei
    0xa9, 0x03, 0x8d, 0x00, 0xdd, // lda #$03 ; sta $DD00   (VIC bank 0)
    0xa9, 0x14, 0x8d, 0x18, 0xd0, // lda #$14 ; sta $D018   (screen $0400)
    0xa2, 0x00,             // ldx #$00
    0xbd, 0x00, 0x20,       // $100D loop: lda $2000,x
    0x9d, 0x00, 0x04,       //             sta $0400,x
    0xbd, 0x00, 0x21,       //             lda $2100,x
    0x9d, 0x00, 0x05,       //             sta $0500,x
    0xe8,                   //             inx
    0xd0, 0xf1,             //             bne loop
    0x60,                   // rts
  ];
  image.set(code, 0);
  const prg = new Uint8Array(image.length + 2); prg[0] = 0x00; prg[1] = 0x10; prg.set(image, 2);
  const prgPath = join(project, "analysis", "fixture.prg");
  const analysisPath = join(project, "analysis", "fixture_analysis.json");
  writeFileSync(prgPath, prg);
  execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prgPath, analysisPath, "1000"], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: project } });
  const report = JSON.parse(readFileSync(analysisPath, "utf8"));
  const copies = (report.codeSemantics?.copyRoutines ?? []).filter((c) => c.provenance === "confirmed_code");
  check(copies.length === 1 && JSON.stringify(copies[0].destinationBases) === "[1024,1280]" && JSON.stringify(copies[0].sourceBases) === "[8192,8448]", `the analyzer sees one confirmed copy loop $2000/$2100 → $0400/$0500 (${copies.length})`);
  seedControlFlow({ projectDir: project, analysisPath });
  seedMemoryAccess({ projectDir: project, analysisPath });
  const vic = extractVicEvidence(analysisContext(report, prgPath));
  const oldEg = buildEvidenceGraph(report.codeSemantics, vic, report.segments, { source: "json" });
  const newEg = buildEvidenceGraph(report.codeSemantics, vic, report.segments, { projectDir: project, owner: "fixture" });
  const rw = (g) => g.edges.filter((e) => e.kind === "reads_from" || e.kind === "writes_to");
  check(rw(oldEg).some((e) => e.kind === "writes_to") && rw(oldEg).filter((e) => e.kind === "reads_from").length === 2, `JSON walk: 1 writes_to (screen) + 2 reads_from (${rw(oldEg).length})`);
  check(JSON.stringify(oldEg) === JSON.stringify(newEg), "store walk: byte-identical evidence graph — bases from the graph's indexed READS/WRITES inside the copy window");
  check(rw(newEg).every((e) => e.attributes?.note === undefined && e.attributes?.accessSource === undefined), "store walk: no fallback note on reads_from/writes_to");
  const atAnalysis = (report.evidenceGraph?.edges ?? []).filter((e) => e.kind === "reads_from" || e.kind === "writes_to");
  // pipeline.ts now passes the owner (integration after this gate was written):
  // at analysis time the graph cannot exist yet, so the note reads "ABSENT";
  // either way the fallback must say so on every edge — loud, not silent.
  check(atAnalysis.length === rw(oldEg).length && atAnalysis.every((e) => typeof e.attributes?.note === "string" && /not consulted|ABSENT/.test(e.attributes.note)), "analysis-time build says the graph was not available on every reads_from/writes_to edge — loud, not silent");
}

// ================================================================ C. fallback is loud, seeding is on demand

console.log("\nC. absent graph — loud fallback (pipeline side), seed on demand (MCP side)");
{
  // C1: a directory that cannot be seeded (no knowledge/project.json) — every walk says so
  const bare = makeProject("bare", false);
  const src = existsSync(LNR) ? LNR : undefined;
  if (!src) {
    fail("C needs the lnr_boot report");
  } else {
    const analysisPath = join(bare, "analysis", `${OWNER}_analysis.json`);
    copyFileSync(src, analysisPath);
    copyFileSync(LNR_PRG, join(bare, "analysis", `${OWNER}.prg`));
    const report = JSON.parse(readFileSync(analysisPath, "utf8"));
    const view = resolveProjectGraph(analysisPath, bare);
    check(view.status === "absent" && view.note.includes("ABSENT") && view.note.includes("project.json"), `inspect: "${view.note.slice(0, 90)}…"`);
    const text = buildReport({ prgPath: join(bare, "analysis", `${OWNER}.prg`), analysisPath, projectDir: bare, startAddress: 0xd000, endAddress: 0xd02e });
    check(text.split("\n")[3]?.startsWith("Graph: ABSENT") && text.includes("## Code → range xrefs"), "inspect: the note is IN the report and the JSON walk still renders");
    const ram = resolveRamAccesses(report, { projectDir: bare, owner: OWNER });
    check(ram.source === "json" && ram.note?.startsWith("Access table: KNOWLEDGE GRAPH ABSENT"), `ram_report: "${ram.note?.slice(0, 80)}…"`);
    check(renderRamStateMarkdown(report, { projectDir: bare, owner: OWNER }).includes("KNOWLEDGE GRAPH ABSENT"), "ram_report: the note is IN the markdown (pipeline half cannot seed — producers are ESM)");
    const idx = buildXrefIndexDetailed(bare);
    check(idx.sources[OWNER] === "json" && idx.notes.some((n) => n.includes("ABSENT") && n.includes(OWNER)), `xref index: "${idx.notes[0]?.slice(0, 90)}…"`);
    check(idx.xrefs.length > 0, "xref index: the JSON walk still answers");
    const vic = extractVicEvidence(analysisContext(report, join(bare, "analysis", `${OWNER}.prg`)));
    const eg = buildEvidenceGraph({ ...report.codeSemantics, copyRoutines: report.codeSemantics.copyRoutines.map((c) => ({ ...c, provenance: "confirmed_code" })) }, vic, report.segments, { projectDir: bare, owner: OWNER });
    const rw = eg.edges.filter((e) => e.kind === "reads_from" || e.kind === "writes_to");
    check(rw.length > 0 && rw.every((e) => e.attributes?.accessSource === "json-walk" && String(e.attributes.note).includes("ABSENT")), `evidence graph: ${rw.length} reads_from/writes_to edges carry the ABSENT note`);
    const noOwner = buildEvidenceGraph({ ...report.codeSemantics, copyRoutines: report.codeSemantics.copyRoutines.map((c) => ({ ...c, provenance: "confirmed_code" })) }, vic, report.segments, {});
    check(noOwner.edges.filter((e) => e.kind === "reads_from").every((e) => String(e.attributes?.note).includes("not consulted")), "evidence graph without an owner: says the graph was not consulted");
  }

  // C2: a seedable project with no graph yet — the MCP-side walks seed 819+820 on demand
  if (src) {
    const fresh = makeProject("fresh");
    const analysisPath = join(fresh, "analysis", `${OWNER}_analysis.json`);
    copyFileSync(src, analysisPath);
    const view = resolveProjectGraph(analysisPath, fresh);
    check(view.status === "graph-seeded" && view.note.includes("seeded on demand") && existsSync(join(fresh, "knowledge", "graph.sqlite")), `inspect: "${view.note.slice(0, 80)}…"`);
    check(resolveProjectGraph(analysisPath, fresh).status === "graph", "inspect: the second call reads what the first seeded");
    const fresh2 = makeProject("fresh2");
    copyFileSync(src, join(fresh2, "analysis", `${OWNER}_analysis.json`));
    const idx = buildXrefIndexDetailed(fresh2);
    check(idx.sources[OWNER] === "graph-seeded" && idx.notes.some((n) => n.includes("seeded on demand")), `xref index: "${idx.notes[0]?.slice(0, 80)}…"`);
    check(buildXrefIndexDetailed(fresh2).sources[OWNER] === "graph", "xref index: the second build reads the seed");
  }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 820.2: ${pass} pass, ${failCount} fail, ${warnCount} warn.  diffs under ${DIFF_DIR}/{before,after}`);
process.exit(failCount ? 1 : 0);
