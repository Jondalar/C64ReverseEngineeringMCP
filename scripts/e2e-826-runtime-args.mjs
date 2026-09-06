#!/usr/bin/env node
// Spec 826 D6 / D7 / D8 — the runtime half of routine signatures, against a synthetic
// capture and a graph the static slices could have seeded. No daemon.
//
//   fixture (819 nodes seeded directly, hermetic — the 821 gate's pattern):
//     $1000 main:  lda #$01 ; jsr $1100 ; lda #$02 ; jsr $1100 ; lda #$01 ; jsr $1100 ; rts
//     $1100 svc:   rts
//     $1200 loop:  jsr $1300 ×40 with A = 0..39 (the per-site cap: 32 distinct, then "…")
//     $1300 sink:  rts
//     $1400 romc:  jsr $FFD2 ; rts          (the callee is ROM under $01=$37 → c64:rom:ffd2)
//
//   asserts: one runtime CALLS row per jsr site, origin=runtime · observed, evidence_key
//   run:<id>:pc:<hex4>, args_observed A/X/Y/C per site; observedArgs / observedDomain
//   merge the sites to A = {$01:2, $02:1}; the cap; the ROM callee; a synthetic
//   SIGNATURE self-edge + PASSES edges read onto the card (signature.in, argsDomain.A
//   .static); formatNode prints `signature:` / `args:` and the human abi on its OWN
//   line (D8); formatEdges prints `args:` on the static CALLS line and `observed:` on
//   the runtime one; the 821 invariant holds; the UI card type carries the rows.
//
// Exit 0 = pass, 1 = fail.   node scripts/e2e-826-runtime-args.mjs   (after npm run build:mcp)

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.C64RE_RUNTIME_ENDPOINT = "ws://127.0.0.1:1";
process.env.C64RE_RUNTIME_AUTOSTART = "0";
const ROOT = resolve(import.meta.dirname, "..");

const { importRuntimeTrace, RUNTIME_EDGE_TYPES } = await import(join(ROOT, "dist/knowledge-graph/producers/runtime.js"));
const { GraphStore } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));
const { observedArgs, observedDomain } = await import(join(ROOT, "dist/knowledge-graph/query-runtime.js"));
const { nodeCard, edgesWalk } = await import(join(ROOT, "dist/knowledge-graph/cards.js"));
const { formatNode, formatEdges } = await import(join(ROOT, "dist/knowledge-graph/format.js"));
const { encodeFileHeader, encodeCpuStep, encodeMemAccess, TraceOp, ACCESS_READ, ACCESS_WRITE } = await import(join(ROOT, "dist/trace/binary-format.js"));

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
// key-order-insensitive: the store canonicalizes evidence JSON (sorted keys)
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// ---------------------------------------------------------------- project + the static side (819-shaped, seeded directly)
const project = mkdtempSync(join(tmpdir(), "c64re-826-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
writeFileSync(join(project, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "p", name: "Spec 826 runtime-args fixture", slug: "s826", rootPath: project }));

const R = (a) => `s826:ram/fixture:routine:${a}`;
const MAIN = R("1000"), SVC = R("1100"), LOOP = R("1200"), SINK = R("1300"), ROMC = R("1400");
const routine = (id, name, end) => ({ id, kind: "routine", name, endAddress: end, attrs: { provenance: "confirmed_code" }, origin: "static", confidence: "certain" });
const call = (from, to, pc, target) => ({ from, type: "CALLS", to, evidenceKey: `src:${pc.toString(16).padStart(4, "0")}`, origin: "static", confidence: "certain", evidence: { source_address: pc, mnemonic: "jsr", instruction: `jsr $${target.toString(16).toUpperCase().padStart(4, "0")}` } });
{
  const store = GraphStore.open(project);
  store.replaceGenerated("819", "fixture", [
    routine(MAIN, "main", 0x100f), routine(SVC, "svc", 0x1100), routine(LOOP, "loop", 0x1203), routine(SINK, "sink", 0x1300), routine(ROMC, "romc", 0x1403),
  ], [
    call(MAIN, SVC, 0x1002, 0x1100), call(MAIN, SVC, 0x1007, 0x1100), call(MAIN, SVC, 0x100c, 0x1100), call(LOOP, SINK, 0x1200, 0x1300),
    { from: ROMC, type: "CALLS_ROM", to: "c64:rom:ffd2", evidenceKey: "src:1400", origin: "static", confidence: "certain", evidence: { source_address: 0x1400, mnemonic: "jsr", instruction: "jsr $FFD2" } },
  ]);
  store.close();
}

// ---------------------------------------------------------------- the capture
const RUN_ID = "run_s826_args";
function buildCapture() {
  const header = encodeFileHeader({ runId: RUN_ID, defId: "d826", defVersion: 1, defName: "826 runtime args", defJson: "{}", domains: ["c64-cpu", "memory"], cycleStart: 0, createdAt: "2026-09-06T00:00:00.000Z" });
  const buf = new Uint8Array(65536);
  const dv = new DataView(buf.buffer);
  let off = 0;
  let cycle = 0;
  const step = (pc, opcode, { a = 0, x = 0x12, y = 0x05, sp = 0xfd, p = 0x24, b1 = 0, b2 = 0, dc = 2 } = {}) => {
    cycle += dc;
    off = encodeCpuStep(dv, off, buf.length, TraceOp.CPU_STEP, cycle, pc, opcode, a, x, y, sp, p, b1, b2);
  };
  const rd = (addr, value, livePc) => { cycle += 1; off = encodeMemAccess(dv, off, buf.length, TraceOp.RAM_WRITE, cycle, addr, value, livePc, ACCESS_READ); };
  const wr = (addr, value, livePc, old) => { cycle += 1; off = encodeMemAccess(dv, off, buf.length, TraceOp.RAM_WRITE, cycle, addr, value, livePc, ACCESS_WRITE, old); };
  // a jsr pushes the return address, then retires; the callee's rts pops it
  const jsr = (pc, target, regs) => {
    const ret = pc + 2;
    wr(0x01fd, ret >> 8, target, 0xff); wr(0x01fc, ret & 0xff, target, 0xff);
    step(pc, 0x20, { ...regs, sp: 0xfb, b1: target & 0xff, b2: target >> 8, dc: 6 });
    rd(0x01fc, ret & 0xff, ret + 1); rd(0x01fd, ret >> 8, ret + 1);
    step(target, 0x60, { ...regs, sp: 0xfd, dc: 6 });
  };
  // main: three sites, A = 1, 2, 1; the second call with the carry set
  step(0x1000, 0xa9, { a: 1, b1: 1 });               jsr(0x1002, 0x1100, { a: 1 });
  step(0x1005, 0xa9, { a: 2, b1: 2 });               jsr(0x1007, 0x1100, { a: 2, p: 0x25 });
  step(0x100a, 0xa9, { a: 1, b1: 1 });               jsr(0x100c, 0x1100, { a: 1 });
  step(0x100f, 0x60, { a: 1, dc: 6 });
  // loop: one site retired 40 times with 40 distinct A values (cap = 32 + "…": 8)
  for (let i = 0; i < 40; i += 1) jsr(0x1200, 0x1300, { a: i, x: 7, y: 9 });
  // romc: the KERNAL under the default $01
  jsr(0x1400, 0xffd2, { a: 0x41 });
  const file = new Uint8Array(header.length + off);
  file.set(header, 0);
  file.set(buf.subarray(0, off), header.length);
  return file;
}
mkdirSync(join(project, "traces"), { recursive: true });
const tracePath = join(project, "traces", "args.c64retrace");
writeFileSync(tracePath, buildCapture());

// ---------------------------------------------------------------- import
const r = importRuntimeTrace({ projectDir: project, tracePath, owner: "fixture" });
console.log(`  info  import: steps=${r.cpuSteps} accesses=${r.accesses} rows=${JSON.stringify(r.rows)} notes=${JSON.stringify(r.notes)} ${r.ms.toFixed(1)} ms`);
check(RUNTIME_EDGE_TYPES.includes("CALLS") && r.rows.CALLS === 5, `RUNTIME_EDGE_TYPES carries CALLS; five runtime CALLS rows, one per jsr site (${r.rows.CALLS})`);
check(r.notes.noStaticEdge === 0, "every runtime jsr site has a static CALLS/CALLS_ROM row — no 'no static edge' note");

let graph = Graph.open(project);
const ev = (e) => e.evidence;
const invariant = Number(graph.store.db.prepare("SELECT (SELECT COUNT(*) FROM edges WHERE producer='821' AND (origin<>'runtime' OR confidence<>'observed' OR layer<>'generated')) + (SELECT COUNT(*) FROM nodes WHERE producer='821' AND (origin<>'runtime' OR confidence<>'observed' OR layer<>'generated')) AS n").get().n);
check(invariant === 0, "821 invariant: producer='821' ⇒ origin=runtime ∧ confidence=observed ∧ layer=generated");

// ---- D6: the runtime CALLS rows into svc
const into = graph.edgesInto(SVC, ["CALLS"]);
const rt = into.filter((e) => e.origin === "runtime").sort((a, b) => ev(a).pc - ev(b).pc);
const st = into.filter((e) => e.origin === "static");
check(st.length === 3 && rt.length === 3, `edgesInto(svc, CALLS): 3 static + 3 runtime rows, side by side (${st.length}/${rt.length})`);
check(rt.every((e) => e.from === MAIN && e.confidence === "observed" && e.owner === RUN_ID && ev(e).run_id === RUN_ID), "each runtime row: from main · observed · owner = the run (replacement unit)");
check(rt.map((e) => e.evidenceKey).join() === [`run:${RUN_ID}:pc:1002`, `run:${RUN_ID}:pc:1007`, `run:${RUN_ID}:pc:100c`].join(), `evidence_key = run:<run_id>:pc:<hex4 of the jsr> (${rt.map((e) => e.evidenceKey.split(":").pop()).join(" ")})`);
check(rt.every((e) => ev(e).count === 1 && ev(e).target === 0x1100 && ev(e).instruction === "jsr $1100" && ev(e).mnemonic === "jsr" && ev(e).flow === "main"), "count=1, target=$1100, instruction 'jsr $1100', flow=main");
check(same(ev(rt[0]).args_observed, { A: { "$01": 1 }, X: { "$12": 1 }, Y: { "$05": 1 }, C: { "0": 1 } }), `site $1002: args_observed ${JSON.stringify(ev(rt[0]).args_observed)}`);
check(same(ev(rt[1]).args_observed, { A: { "$02": 1 }, X: { "$12": 1 }, Y: { "$05": 1 }, C: { "1": 1 } }), `site $1007: A=$02 and the carry SET (${JSON.stringify(ev(rt[1]).args_observed.C)})`);
check(same(ev(rt[2]).args_observed.A, { "$01": 1 }), "site $100C: A=$01");
check(ev(rt[0]).bank_ctx === "01=37 dd00=97 cart=-" && ev(rt[0]).bank_ctx_conf === "inferred", "bank_ctx reconstructed and labelled inferred (821 D5)");
// the static rows are untouched
check(st.every((e) => e.confidence === "certain" && ev(e).args_observed === undefined), "the static CALLS rows keep confidence=certain and carry no args_observed (821 D3: confirms, never promotes)");

// ---- observedArgs / observedDomain
const sites = observedArgs(graph, SVC);
check(sites.length === 3 && sites.map((s) => s.site).join() === "$1002,$1007,$100C" && sites.every((s) => s.run === RUN_ID && s.count === 1), `observedArgs(svc): 3 sites ${sites.map((s) => s.site).join(" ")} in run ${RUN_ID}`);
const dom = observedDomain(graph, SVC);
check(same(dom.A, { "$01": 2, "$02": 1 }), `observedDomain(svc).A = ${JSON.stringify(dom.A)} (the spec's {01:2, 02:1})`);
check(same(dom.X, { "$12": 3 }) && same(dom.Y, { "$05": 3 }) && same(dom.C, { "0": 2, "1": 1 }), `observedDomain(svc): X=${JSON.stringify(dom.X)} Y=${JSON.stringify(dom.Y)} C=${JSON.stringify(dom.C)}`);
check(same(observedDomain(graph, "$1100").A, dom.A) && same(observedDomain(graph, 0x1100).A, dom.A) && same(observedDomain(graph, "svc").A, dom.A), "observedDomain accepts an id, '$1100', 0x1100 and a name");

// ---- the per-site cap
const loopRow = graph.edgesInto(SINK, ["CALLS"]).find((e) => e.origin === "runtime");
const loopA = loopRow ? ev(loopRow).args_observed.A : {};
check(loopRow && ev(loopRow).count === 40 && Object.keys(loopA).length === 33 && loopA["…"] === 8 && loopA["$00"] === 1 && loopA["$1F"] === 1 && loopA["$20"] === undefined, `loop site: count=40, 32 distinct A values kept + "…": ${loopA["…"]} (${Object.keys(loopA).length} keys)`);
check(same(ev(loopRow).args_observed.X, { "$07": 40 }) && same(ev(loopRow).args_observed.Y, { "$09": 40 }), "a constant register collapses to one value ×40");

// ---- the ROM callee
const romRow = graph.edgesOutOf(ROMC, ["CALLS"]).find((e) => e.origin === "runtime");
check(romRow && romRow.to === "c64:rom:ffd2" && same(ev(romRow).args_observed.A, { "$41": 1 }), `jsr $FFD2 under $01=$37 → c64:rom:ffd2 (${romRow?.to}), A=$41 observed`);
check(observedDomain(graph, "c64:rom:ffd2").A?.["$41"] === 1, "observedDomain works for a platform (ROM) callee");
graph.close();

// ---------------------------------------------------------------- D7 / D6 static half, synthesized: SIGNATURE self-edge + PASSES rows
{
  const store = GraphStore.open(project);
  const passes = (pc, A) => ({
    from: MAIN, type: "PASSES", to: SVC, evidenceKey: `src:${pc.toString(16).padStart(4, "0")}`, origin: "static", confidence: "inferred",
    evidence: { site: `$${pc.toString(16).toUpperCase()}`, instruction: "jsr $1100", args: { A: { source: "imm", value: A, site: `$${(pc - 2).toString(16).toUpperCase()} lda #$0${A}` }, X: { source: "mem", from: "s826:ram:addr:27e1", site: "$27E1" }, Y: { source: "op", from: "op:$2805", site: "$2805" }, C: { source: "flag", site: "$2807 sec" }, "zp:$F3": { source: "unknown" } } },
  });
  store.replaceGenerated("826", "fixture", [
    { id: "s826:ram:addr:27e1", kind: "addr", name: null, attrs: {}, origin: "static", confidence: "certain" },
  ], [
    { from: SVC, type: "SIGNATURE", to: SVC, evidenceKey: "", origin: "static", confidence: "inferred", evidence: {
      in: [{ loc: "A", confidence: "certain", first_use: "$1100 sta $F3" }, { loc: "X", confidence: "certain", first_use: "$1102 stx $F4" }, { loc: "zp:$F3", confidence: "inferred", first_use: "$1104 lda $F3" }],
      out: [{ loc: "zp:$FC", last_def: "$1108 sta $FC" }, { loc: "C", last_def: "$110A clc" }],
      clobbers: ["A", "X", "Y"], preserves: [], stack: { delta: 0, balanced: true, tricks: [] }, partial: null, version: 1,
    } },
    passes(0x1002, 1), passes(0x1007, 2), passes(0x100c, 1),
    { from: LOOP, type: "SIGNATURE", to: LOOP, evidenceKey: "", origin: "static", confidence: "inferred", evidence: { in: [], out: [], clobbers: ["A"], preserves: [], stack: { delta: -1, balanced: false, unbalanced_at: "$1203" }, partial: { because: "callee unknown", site: "$1200 jsr $1300" }, version: 1 } },
  ]);
  store.close();
}
graph = Graph.open(project);
const card = nodeCard(graph, graph.resolve(SVC));
check(card.signature && same(card.signature.in, ["A", "X", "zp:$F3"]) && same(card.signature.out, ["zp:$FC", "C"]) && same(card.signature.clobbers, ["A", "X", "Y"]) && same(card.signature.preserves, []), `nodeCard(svc).signature: in=${JSON.stringify(card.signature?.in)} out=${JSON.stringify(card.signature?.out)} clobbers=${JSON.stringify(card.signature?.clobbers)}`);
check(card.signature?.stack === "balanced" && card.signature.partial === null && card.signature.humanAbi === null, "stack: balanced, partial: null, humanAbi: null before any human line");
check(card.argsDomain && same(card.argsDomain.A.static, { "$01": 2, "$02": 1 }) && same(card.argsDomain.A.observed, { "$01": 2, "$02": 1 }), `nodeCard(svc).argsDomain.A: static=${JSON.stringify(card.argsDomain?.A.static)} observed=${JSON.stringify(card.argsDomain?.A.observed)}`);
check(card.argsDomain && same(card.argsDomain.X.static, { "s826:ram:addr:27e1": 3 }) && same(card.argsDomain.Y.static, { "op:$2805": 3 }) && same(card.argsDomain.C.static, { "1": 3 }) && same(card.argsDomain["zp:$F3"].static, { "?": 3 }), "mem → the cell id, op → the operand location, flag → the bit, unknown → '?'");
const loopCard = nodeCard(graph, graph.resolve(LOOP));
check(loopCard.signature?.stack === "unbalanced @$1203" && loopCard.signature.partial === "callee unknown @ $1200 jsr $1300", `loop card: stack '${loopCard.signature?.stack}', partial '${loopCard.signature?.partial}'`);
const mainCard = nodeCard(graph, graph.resolve(MAIN));
check(mainCard.signature === null && mainCard.argsDomain === null, "a routine with neither a SIGNATURE nor an incoming PASSES/runtime CALLS row: signature=null, argsDomain=null");

// ---- formatNode
const text1 = formatNode(card).text;
const sigLine = text1.split("\n").find((l) => l.startsWith("  signature: "));
const argsLine = text1.split("\n").find((l) => l.startsWith("  args: "));
check(sigLine === "  signature: in: A X zp:$F3 · out: zp:$FC C · clobbers: A X Y · preserves: — · stack: balanced", `formatNode: ${sigLine?.trim()}`);
check(argsLine === "  args: A ∈ {$01 ×2, $02 ×1} (observed $01 ×2, $02 ×1) · X ← s826:ram:addr:27e1 ×3 (observed $12 ×3) · Y ← op:$2805 ×3 (observed $05 ×3) · C ∈ {1 ×3} (observed 0 ×2, 1 ×1) · zp:$F3 ← ? ×3", `formatNode: ${argsLine?.trim()}`);
check(!text1.includes("  human abi:"), "no human abi line without a human row");
const loopText = formatNode(loopCard).text;
check(loopText.includes("  signature: in: — · out: — · clobbers: A · preserves: — · stack: unbalanced @$1203") && loopText.includes("  partial: callee unknown @ $1200 jsr $1300"), "formatNode prints the partial line under the signature");
check(same(formatNode(card).json, card), "formatNode json === the card (823 D3: one document)");

// ---- formatEdges: the PASSES join on the CALLS line, the observed suffix on the runtime one
const walk = edgesWalk(graph, [graph.resolve(MAIN)], { direction: "out", kind: "calls", limit: 50 });
const stLines = formatEdges(walk).text.split("\n").filter((l) => l.startsWith("CALLS") && l.includes("static/"));
const rtLines = formatEdges(walk).text.split("\n").filter((l) => l.startsWith("CALLS") && l.includes("runtime/"));
check(stLines.length === 3 && stLines.every((l) => / args: A=#\$0[12] X←\$27E1 Y←op:\$2805 C=1 zp:\$F3←\?$/u.test(l)), `static CALLS lines carry ' args: A=#$0x X←$27E1 Y←op:$2805 C=1 zp:$F3←?' (${stLines[0]?.split(" args: ")[1]})`);
check(rtLines.length === 3 && rtLines.some((l) => l.endsWith(" observed: A∈{$02} X∈{$12} Y∈{$05} C∈{1}")), `runtime CALLS lines carry ' observed: A∈{…} …' (${rtLines[1]?.split(" observed: ")[1]})`);
check(walk.edges.every((e) => e.type !== "PASSES" && e.type !== "SIGNATURE") && walk.edges.filter((e) => e.args).length === 3, "PASSES / SIGNATURE rows are joined, not walked; three CALLS hits carry args");
check(formatEdges(walk).json.edges.filter((e) => e.args?.A?.label === "#$01").length === 2, "the walk JSON carries the joined args (the UI reads it)");
const anyWalk = edgesWalk(graph, [graph.resolve(SVC)], { direction: "both", kind: "any", limit: 200 });
check(!anyWalk.edges.some((e) => e.type === "SIGNATURE" || e.type === "PASSES"), "kind=any walk hides the SIGNATURE self-loop and the PASSES rows");
graph.close();

// ---------------------------------------------------------------- D8 — the human abi, on its own line, never merged
let humanTried = false;
try {
  const { annotate } = await import(join(ROOT, "dist/knowledge-graph/migrate/human.js"));
  humanTried = true;
  annotate(project, { nodeId: SVC, kind: "abi", title: "abi", body: "A = mode (01 read / 02 write / 03 finish)" });
  graph = Graph.open(project);
  const c2 = nodeCard(graph, graph.resolve(SVC));
  const t2 = formatNode(c2).text;
  const lines = t2.split("\n");
  check(c2.signature?.humanAbi === "A = mode (01 read / 02 write / 03 finish)", `card.signature.humanAbi = '${c2.signature?.humanAbi}'`);
  check(lines.includes("  human abi: A = mode (01 read / 02 write / 03 finish)"), "formatNode prints '  human abi: …' as its own line");
  check(lines.find((l) => l.startsWith("  signature: ")) === sigLine, "the computed signature line is byte-identical with the human line present (D8: beside, never merged)");
  check(same(c2.signature.in, card.signature.in) && same(c2.argsDomain, card.argsDomain), "the computed sets and the domain are unchanged by the human row");
  // attrs.abi on the human node row (the annotations.json door) is the fallback
  graph.close();
  const { nameNode } = await import(join(ROOT, "dist/knowledge-graph/migrate/human.js"));
  nameNode(project, { id: LOOP, kind: "routine", name: "loop_named", attrs: { abi: "X = count" } });
  graph = Graph.open(project);
  check(nodeCard(graph, graph.resolve(LOOP)).signature?.humanAbi === "X = count", "attrs.abi on the human row is the fallback when no abi annotation exists");
  // the human name survives a re-import of the run (818 D6) and the 826 signature is still read
  graph.close();
  importRuntimeTrace({ projectDir: project, tracePath, owner: "fixture" });
  graph = Graph.open(project);
  const c3 = nodeCard(graph, graph.resolve(LOOP));
  check(c3.humanName === "loop_named" && c3.signature?.stack === "unbalanced @$1203" && same(observedDomain(graph, SVC).A, { "$01": 2, "$02": 1 }), "re-import: the human name, the signature and the observed domain all survive (same run replaced in place)");
  graph.close();
} catch (error) {
  if (!humanTried) console.log(`  SKIP  human abi assertions — migrate/human.js not loadable: ${error.message}`);
  else fail(`human abi assertions threw: ${error.stack ?? error.message}`);
}

// ---------------------------------------------------------------- the UI card carries the rows (source-level; smoke:824 covers the bundle)
const panel = readFileSync(join(ROOT, "ui/src/components/graph-panel.tsx"), "utf8");
check(/signature\?: Signature \| null; argsDomain\?: ArgsDomain \| null/.test(panel) && /graph-card-signature/.test(panel) && /graph-card-human-abi/.test(panel) && /graph-card-args/.test(panel), "graph-panel.tsx: Card type has signature/argsDomain; one signature row, one human abi row, one args row");
check(/human abi: \{card\.signature\.humanAbi\}/.test(panel) && !/signatureText\([^)]*humanAbi/.test(panel), "the UI prints the human abi on its own row, never inside the computed line (D8)");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 826 runtime args: ${pass} pass, ${failCount} fail.  project: ${project}`);
process.exit(failCount ? 1 : 0);
