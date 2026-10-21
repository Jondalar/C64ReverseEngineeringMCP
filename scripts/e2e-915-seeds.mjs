#!/usr/bin/env node
// Spec 915 — a code seed crosses an owner boundary only from real code, into the payload that is in the window.
//
// Hermetic: its own 6502 images, its own `knowledge/graph.sqlite` from the real schema, its own encoded
// `.c64retrace` captures. No project, no ROMs, no daemon, no runtime.
//
//   S1   a probable-code `jsr $0814` (a graphics bank) never seeds across an owner; the stub's confirmed
//        `jmp $0800` does, and $0813 stays `lda $DC01` with nothing stranded
//   S2   three overlays share one window, a resident loader has a confirmed `jmp $3200`
//        static only      none is seeded, the header names the claimants
//        run A (prog_a)   prog_a is seeded, the menu is not
//        run B (prog_b)   the set {prog_a, prog_b} is seeded, still not the menu
//   S2b  `jmp` and `jmp (ind)` into another window are written as payload-keyed edges (the payload in the
//        target's id); a target no claimant matches stays ownerless and is reported, so is one the trace
//        saw too little of to decide
//
// Exit 0 = pass, 1 = fail.   npm run e2e:915-seeds

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));
const hex = (a) => `$${a.toString(16).toUpperCase().padStart(4, "0")}`;

const CLI = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(CLI)) { console.error("pipeline not built — run npm run build"); process.exit(2); }
const { GRAPH_DDL } = await import("../dist/knowledge-graph/schema.js");
const { importRuntimeTrace } = await import("../dist/knowledge-graph/producers/runtime.js");
const { Graph } = await import("../dist/knowledge-graph/query.js");
const { encodeFileHeader, encodeCpuStep, TraceOp } = await import("../dist/trace/binary-format.js");

const SLUG = "f915";
const addrId = (a, owner) => `${SLUG}:ram${owner ? `/${owner}` : ""}:addr:${a.toString(16).padStart(4, "0")}`;
const rid = (owner, kind, a) => `${SLUG}:ram/${owner}:${kind}:${a.toString(16).padStart(4, "0")}`;

// ---------------------------------------------------------------- fixture helpers
function newProject(tag) {
  const dir = mkdtempSync(join(tmpdir(), `c64re-915-${tag}-`));
  mkdirSync(join(dir, "analysis"), { recursive: true });
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "p", name: "Spec 915 fixture", slug: SLUG, rootPath: dir }));
  const scratch = mkdtempSync(join(tmpdir(), `c64re-915-${tag}-out-`));
  return { dir, scratch };
}

/** An image: JAM filler ($02), so nothing decodes that was not seeded; blocks are [address, ...bytes]. */
function writePrg(dir, owner, load, end, blocks) {
  const body = Buffer.alloc(end - load + 1, 0x02);
  for (const [at, ...bytes] of blocks) for (let i = 0; i < bytes.length; i += 1) body[at - load + i] = bytes[i];
  const path = join(dir, "analysis", `${owner}.prg`);
  writeFileSync(path, Buffer.from([load & 0xff, load >> 8, ...body]));
  return path;
}

function writeGraph(dir, { nodes, edges }) {
  const db = new DatabaseSync(join(dir, "knowledge", "graph.sqlite"));
  db.exec(GRAPH_DDL);
  const n = db.prepare("INSERT OR REPLACE INTO nodes (id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence) VALUES (?,?,?,'ram',?,NULL,?,?,?,?,'{}','static','inferred','915','[]')");
  for (const r of nodes) n.run(r.id, "generated", r.kind, r.owner ?? null, r.kind === "addr" ? null : r.owner ?? null, r.address, r.end ?? null, r.name ?? null);
  const e = db.prepare("INSERT OR REPLACE INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?,?,?,'generated',?,'static',?,'control-flow',?,?)");
  for (const r of edges) e.run(r.from, r.type, r.to, r.key, r.confidence, r.owner, JSON.stringify(r.evidence));
  db.close();
}

/** analyze-prg into `out`, with C64RE_PROJECT_DIR = the project, so the graph seeds are read from it. */
function analyze(p, owner, prg, { entries = "", outDir } = {}) {
  const out = join(outDir ?? join(p.dir, "analysis"), `${owner}_analysis.json`);
  mkdirSync(join(out, ".."), { recursive: true });
  execFileSync(process.execPath, [CLI, "analyze-prg", prg, out, ...(entries ? [entries] : []), "--no-register"], { stdio: "pipe", env: { ...process.env, C64RE_PROJECT_DIR: p.dir } });
  return JSON.parse(readFileSync(out, "utf8"));
}
const seedAt = (r, a) => (r.codeSeedReport?.seeds ?? []).find((s) => s.address === a);
const notSeededAt = (r, a) => (r.codeSeedReport?.notSeeded ?? []).find((s) => s.address === a);
const crossSeeds = (r) => (r.codeSeedReport?.seeds ?? []).filter((s) => s.origin === "cross_owner_call" || s.origin === "cross_owner_jump");

const realJump = { provenance: "confirmed_code", mnemonic: "jmp", addressing_mode: "abs" };

// ======================================================================== S1
console.log("Spec 915 — a code seed crosses an owner only from real code, into the payload that is in the window\n");
console.log("S1 — a probable-code call never seeds across an owner; the stub's confirmed jump does\n");
{
  const p = newProject("s1");
  // The stub copy at $0800: a jump to $0813, where `lda $DC01` sits ($0814 is the middle of it).
  const stub = writePrg(p.dir, "stub", 0x0800, 0x087f, [
    [0x0800, 0xa9, 0x00, 0x8d, 0x20, 0xd0],
    [0x0805, 0x4c, 0x13, 0x08],
    [0x0813, 0xad, 0x01, 0xdc, 0x60],
  ]);
  const chip = writePrg(p.dir, "chip", 0x4000, 0x40ff, [[0x4000, 0xa9, 0x01, 0x60]]);
  writeGraph(p.dir, {
    nodes: [
      { id: rid("stub", "segment", 0x0800), kind: "segment", owner: "stub", address: 0x0800, end: 0x087f },
      { id: rid("chip", "segment", 0x4000), kind: "segment", owner: "chip", address: 0x4000, end: 0x40ff },
      { id: rid("boot", "segment", 0x0300), kind: "segment", owner: "boot", address: 0x0300, end: 0x03ff },
      { id: addrId(0x0800), kind: "addr", address: 0x0800 },
      { id: addrId(0x0814), kind: "addr", address: 0x0814 },
    ],
    edges: [
      // the graphics bank: a heuristic render's `jsr $0814` (what control-flow writes for probableCodeAnalysis)
      { from: rid("chip", "segment", 0x4000), type: "CALLS", to: addrId(0x0814), key: "src:4010", confidence: "heuristic", owner: "chip",
        evidence: { source_address: 0x4010, mnemonic: "jsr", addressing_mode: "abs", provenance: "probable_code" } },
      // the boot code: confirmed `jmp $0800`
      { from: rid("boot", "segment", 0x0300), type: "JUMPS_TO", to: addrId(0x0800), key: "src:0300", confidence: "certain", owner: "boot", evidence: { source_address: 0x0300, ...realJump } },
    ],
  });
  const r = analyze(p, "stub", stub, { outDir: p.scratch });
  const cross = crossSeeds(r);
  check(cross.length === 1 && cross[0].address === 0x0800 && cross[0].origin === "cross_owner_jump", `exactly one cross-owner seed, ${hex(0x0800)} cross_owner_jump (${cross.map((s) => `${hex(s.address)} ${s.origin}`).join(", ") || "none"})`);
  check(seedAt(r, 0x0814) === undefined, `${hex(0x0814)} (the heuristic caller's target) is not a seed`);
  const ns = notSeededAt(r, 0x0814);
  check(ns?.reason === "heuristic_caller" && /chip/.test(ns.detail), `…it is reported, not dropped: ${ns?.reason ?? "MISSING"} — ${ns?.detail ?? ""}`);
  const at13 = (r.codeAnalysis?.instructions ?? []).find((i) => i.address === 0x0813);
  check(at13?.mnemonic?.toLowerCase() === "lda" && /dc01/i.test(at13.operandText ?? at13.operand ?? ""), `${hex(0x0813)} decodes as lda $DC01 (${at13?.mnemonic} ${at13?.operandText ?? at13?.operand ?? ""})`);
  check((r.strandedByDecodeConflict ?? []).length === 0, `Bytes stranded by a decode conflict: ${(r.strandedByDecodeConflict ?? []).length}`);
  analyze(p, "chip", chip, { outDir: p.scratch }); // the chip image itself analyses fine
}

// ======================================================================== S2 + S2b
console.log("\nS2 — three overlays share a window; a resident loader jumps into it\n");
const OVERLAYS = [
  { owner: "menu", mark: 0x10, end: 0x37ff },
  { owner: "prog_a", mark: 0x20, end: 0x35ff },
  { owner: "prog_b", mark: 0x30, end: 0x36ff },
];
// The window's code the loader reaches: a routine at $3200 and one at $3400, each overlay's own bytes.
const routineAt = (at, m) => [at, 0xa9, m, 0x8d, 0x20, 0xd0, 0xa9, m + 1, 0x8d, 0x21, 0xd0, 0xa2, m + 2, 0x60];

const p = newProject("s2");
for (const o of OVERLAYS) o.prg = writePrg(p.dir, o.owner, 0x2700, o.end, [routineAt(0x3200, o.mark), routineAt(0x3400, o.mark + 4)]);
const nodes = OVERLAYS.map((o) => ({ id: rid(o.owner, "segment", 0x2700), kind: "segment", owner: o.owner, address: 0x2700, end: o.end }));
nodes.push({ id: rid("loader", "segment", 0x0300), kind: "segment", owner: "loader", address: 0x0300, end: 0x03ff });
nodes.push({ id: rid("loader", "routine", 0x0300), kind: "routine", owner: "loader", address: 0x0300, end: 0x0340, name: "W0300" });
for (const a of [0x3200]) nodes.push({ id: addrId(a), kind: "addr", address: a });
writeGraph(p.dir, {
  nodes,
  edges: [{ from: rid("loader", "routine", 0x0300), type: "JUMPS_TO", to: addrId(0x3200), key: "src:0300", confidence: "certain", owner: "loader", evidence: { source_address: 0x0300, ...realJump } }],
});

// The claimants' own analyses (what residency compares the trace against): decoded at both routines.
for (const o of OVERLAYS) analyze(p, o.owner, o.prg, { entries: "3200,3400" });

const staticOf = (o) => analyze(p, o.owner, o.prg, { outDir: join(p.scratch, "static") });
let st = Object.fromEntries(OVERLAYS.map((o) => [o.owner, staticOf(o)]));
for (const o of OVERLAYS) {
  const ns = notSeededAt(st[o.owner], 0x3200);
  check(crossSeeds(st[o.owner]).length === 0 && ns?.reason === "not_validated", `static only: ${o.owner} is not seeded at ${hex(0x3200)} (${ns?.reason ?? "no report"})`);
}
{
  const ns = notSeededAt(st.menu, 0x3200)?.detail ?? "";
  check(/target not validated, claimants menu \/ prog_a \/ prog_b/.test(ns), `…and the report names the claimants: "${ns}"`);
}
{
  // the listing header says it too
  const listing = join(p.scratch, "menu.asm");
  execFileSync(process.execPath, [CLI, "disasm-prg", OVERLAYS[0].prg, listing, "--dialect", "kickass", "--analysis", join(p.scratch, "static", "menu_analysis.json")], { stdio: "pipe", env: { ...process.env, C64RE_PROJECT_DIR: p.dir } });
  const head = readFileSync(listing, "utf8");
  check(/not seeded: 1 cross-owner address/.test(head) && /target not validated, claimants menu \/ prog_a \/ prog_b/.test(head), "the listing header carries the seed report: not seeded, claimants named");
}

// ---- the captures
function capture(runId, steps) {
  const header = encodeFileHeader({ runId, defId: "d915", defVersion: 1, defName: "915 fixture", defJson: "{}", domains: ["c64-cpu", "memory"], cycleStart: 0, createdAt: "2026-10-21T00:00:00.000Z" });
  const buf = new Uint8Array(1 << 16);
  const dv = new DataView(buf.buffer);
  let off = 0;
  let cycle = 0;
  for (const [pc, opcode, b1 = 0, b2 = 0] of steps) {
    cycle += 3;
    off = encodeCpuStep(dv, off, buf.length, TraceOp.CPU_STEP, cycle, pc, opcode, 0, 0, 0, 0xfd, 0x24, b1, b2);
  }
  const file = new Uint8Array(header.length + off);
  file.set(header, 0);
  file.set(buf.subarray(0, off), header.length);
  const path = join(p.dir, `${runId}.c64retrace`);
  writeFileSync(path, file);
  return path;
}
/** The retiring steps of `routineAt(at, m)`. */
const stepsOf = (at, m) => [[at, 0xa9, m], [at + 2, 0x8d, 0x20, 0xd0], [at + 5, 0xa9, m + 1], [at + 7, 0x8d, 0x21, 0xd0], [at + 10, 0xa2, m + 2], [at + 12, 0x60]];
const JMP = 0x4c, JMP_IND = 0x6c;
const A = OVERLAYS[1], B = OVERLAYS[2];
const residentRun = (runId, ov) => capture(runId, [
  [0x0300, JMP, 0x00, 0x32], ...stepsOf(0x3200, ov.mark),                  // jmp $3200 -> the resident overlay's routine
  [0x0310, JMP_IND, 0x30, 0x03], ...stepsOf(0x3200, ov.mark),               // jmp ($0330) -> $3200 again, through a pointer
  [0x0320, JMP, 0x00, 0x34], ...stepsOf(0x3400, ov.mark + 4),               // jmp $3400 -> the same overlay's other routine
  [0x0330, JMP, 0x00, 0x30], [0x3000, 0xa9, 0x01], [0x3002, 0x60],          // jmp $3000: two instructions, nothing near it to compare
  [0x0340, JMP, 0x00, 0x34], [0x3400, 0xa9, 0xee], [0x3402, 0x8d, 0x20, 0xd0], [0x3405, 0xa9, 0xef], [0x3407, 0x8d, 0x21, 0xd0], [0x340a, 0xa2, 0xed], [0x340c, 0x60], // jmp $3400: bytes that are NOBODY's
  [0x0350, 0xea],
]);
const importRun = (path) => importRuntimeTrace({ projectDir: p.dir, tracePath: path, slug: SLUG });

// ---- run A: prog_a resident
const rA = importRun(residentRun("run_915_a", A));
console.log(`  info  run A: ${JSON.stringify(rA.rows)} cross=${JSON.stringify(rA.crossWindow)}`);
st = Object.fromEntries(OVERLAYS.map((o) => [o.owner, staticOf(o)]));
{
  const sa = seedAt(st.prog_a, 0x3200);
  check(sa?.origin === "cross_owner_jump" && /traced run/.test(sa.detail), `run A: prog_a is seeded at ${hex(0x3200)} (${sa?.origin ?? "MISSING"}; ${sa?.detail ?? ""})`);
  check(crossSeeds(st.menu).length === 0 && notSeededAt(st.menu, 0x3200)?.reason === "other_resident", `run A: the menu is not seeded (${notSeededAt(st.menu, 0x3200)?.reason ?? "MISSING"}: ${notSeededAt(st.menu, 0x3200)?.detail ?? ""})`);
  check(crossSeeds(st.prog_b).length === 0 && notSeededAt(st.prog_b, 0x3200)?.reason === "other_resident", "run A: prog_b is not seeded either (it was not the one resident)");
}

// ---- run B: prog_b resident — the set
const rB = importRun(residentRun("run_915_b", B));
st = Object.fromEntries(OVERLAYS.map((o) => [o.owner, staticOf(o)]));
check(seedAt(st.prog_a, 0x3200) !== undefined && seedAt(st.prog_b, 0x3200) !== undefined, "run B added: prog_a and prog_b are both seeded at $3200 (the set {prog_a, prog_b})");
check(crossSeeds(st.menu).length === 0, "…and the menu still is not");
check(/prog_a \/ prog_b/.test(seedAt(st.prog_a, 0x3200)?.detail ?? ""), `…the seed names the set: ${seedAt(st.prog_a, 0x3200)?.detail ?? ""}`);

// ======================================================================== S2b
console.log("\nS2b — jmp and jmp (ind) into another window are payload-keyed edges; what no claimant matches is reported\n");
const graph = Graph.open(p.dir);
const db = graph.store.db;
const edgesOf = (run, type, to) => db.prepare("SELECT from_id, to_id, evidence, origin, confidence FROM edges WHERE producer = 'runtime-trace' AND owner = ? AND type = ? AND to_id = ?").all(run, type, to);
const jmpA = edgesOf("run_915_a", "JUMPS_TO", addrId(0x3200, "prog_a"));
check(jmpA.length === 2, `run A: the \`jmp $3200\` and the \`jmp ($0330)\` are two JUMPS_TO edges onto ${addrId(0x3200, "prog_a")} (${jmpA.length})`);
const kinds = jmpA.map((e) => JSON.parse(e.evidence).addr_mode).sort().join(",");
check(kinds === "abs,ind", `…one from jmp abs, one from jmp (ind) (${kinds})`);
check(jmpA.every((e) => e.origin === "runtime" && e.confidence === "observed" && e.from_id === rid("loader", "routine", 0x0300)), "…runtime · observed, from the loader's routine");
const evA = JSON.parse(jmpA[0].evidence);
check(evA.resident_payload === "prog_a" && evA.matched_executions === 1 && evA.match?.compared >= 4 && evA.match.matched === evA.match.compared && evA.run_id === "run_915_a", `…the evidence is the trace and the match count (${JSON.stringify({ resident: evA.resident_payload, executions: evA.matched_executions, match: evA.match })})`);
check(edgesOf("run_915_a", "JUMPS_TO", addrId(0x3200, "menu")).length === 0 && edgesOf("run_915_a", "JUMPS_TO", addrId(0x3200, "prog_b")).length === 0, "…and no edge for the overlays whose bytes were not there");
check(edgesOf("run_915_b", "JUMPS_TO", addrId(0x3200, "prog_b")).length === 2 && edgesOf("run_915_b", "JUMPS_TO", addrId(0x3200, "prog_a")).length === 0, "run B: the same jumps are filed under prog_b");
const mid3400 = edgesOf("run_915_a", "JUMPS_TO", addrId(0x3400, "prog_a"));
check(mid3400.length === 1, `run A: the first \`jmp $3400\` (prog_a's other routine) is filed under prog_a too`);

const noMatch = rA.crossWindow.ownerless.find((o) => o.target === 0x3400 && o.pc === 0x0340);
check(noMatch?.reason === "no_match" && [...noMatch.claimants].sort().join() === "menu,prog_a,prog_b", `a target no claimant matches (bytes that are nobody's) is reported: ${JSON.stringify(noMatch)}`);
const ownerless3400 = edgesOf("run_915_a", "JUMPS_TO", addrId(0x3400));
check(ownerless3400.length === 1 && JSON.parse(ownerless3400[0].evidence).residency === "no_match" && JSON.parse(ownerless3400[0].evidence).resident_payload === null, "…its edge stays on the ownerless addr node and says so");
const undecided = rA.crossWindow.ownerless.find((o) => o.target === 0x3000);
check(undecided?.reason === "undecided", `a target the trace saw too little of to compare is reported as undecided, never guessed: ${JSON.stringify(undecided)}`);
check(rA.crossWindow.matched === 3 && rA.crossWindow.ownerless.length === 2, `run A summary: 3 matched sites, 2 ownerless (${rA.crossWindow.matched}, ${rA.crossWindow.ownerless.length})`);
check(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE producer = 'runtime-trace' AND (origin <> 'runtime' OR confidence <> 'observed')").get().n === 0, "invariant: every runtime-trace edge is runtime · observed");
// the same capture twice is one set of rows (the importer's replacement unit is unchanged)
const before = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE producer = 'runtime-trace' AND owner = 'run_915_a'").get().n;
graph.close?.();
importRun(join(p.dir, "run_915_a.c64retrace"));
const g2 = Graph.open(p.dir);
check(g2.store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE producer = 'runtime-trace' AND owner = 'run_915_a'").get().n === before, "importing the same capture again replaces its rows (no duplicates)");
void rB;

console.log(`\n${failCount === 0 ? "GREEN" : "RED"}  Spec 915 seeds: ${pass} pass, ${failCount} fail.`);
process.exit(failCount === 0 ? 0 : 1);
