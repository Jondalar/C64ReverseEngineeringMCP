#!/usr/bin/env node
// Spec 867 — the window a payload owns, and who is resident in it.
//
// Hermetic. Builds its own 6502 images and its own `knowledge/graph.sqlite` from
// the real schema, runs the bundled analyzer on them, and reads the analysis JSON,
// the claimant answer and the residency answer. No project, no ROMs, no assembler,
// no runtime — the capture the byte-match needs is handed in as a `ByteSource`,
// which is exactly the interface the live runtime implements. The same path
// against a real machine is `npm run smoke:867`.
//
// One acceptance item per section, in the spec's own order:
//
//   1  six payloads on ONE window each seed their own entry points, and none is
//      refused as another's
//   2  a payload spanning half the machine stops inheriting what loads inside it
//   3  an ambiguous address names its claimants and picks none
//   4  with a capture, the bytes name which claimant is in the window
//   5  with no capture, a load call naming track and sector decides, and the call
//      is the evidence
//   6  with neither, the answer says so — a named ambiguity, never a silent pick
//   7  a project with no recorded window behaves as it did
//
//   +  the two implementations of the window model — ESM (src/knowledge-graph)
//      and CommonJS (pipeline/src/analysis) — answer identically over one graph.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:867-window

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

const cli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cli)) { console.error("pipeline not built — run npm run build"); process.exit(2); }
const { GRAPH_DDL } = await import("../dist/knowledge-graph/schema.js");
const { Graph } = await import("../dist/knowledge-graph/query.js");
const { claimantsCard } = await import("../dist/knowledge-graph/cards.js");
const esmWindows = await import("../dist/knowledge-graph/windows.js");
const { windowResidency, formatWindowResidency } = await import("../dist/symbols/window-residency.js");
const { createRequire } = await import("node:module");
const cjsWindows = createRequire(import.meta.url)("../dist/pipeline/analysis/payload-windows.cjs");
const { loadCodeSeeds } = createRequire(import.meta.url)("../dist/pipeline/analysis/graph-reader.cjs");

console.log("Spec 867 — the window a payload owns, and who is resident in it\n");

// ------------------------------------------------------------------ fixture
// Both 867 gates share it — `scripts/lib/fixture-867.mjs` describes what is in it.
const { buildFixture, writeGraph, writePrg, analyze: analyzeImage, MODULES, WIDE, ENGINE, LOADER, ROUTINE, MOD_C_LOAD_CALL, SLUG } =
  await import("./lib/fixture-867.mjs");

const proj = mkdtempSync(join(tmpdir(), "c64re-867-proj-"));
const { nodes, edges } = buildFixture(proj, GRAPH_DDL);

const analyze = (owner, prg, dir = proj) => analyzeImage(dir, owner, prg);
const seedAt = (report, a) => (report.codeSeedReport?.seeds ?? []).find((s) => s.address === a);
const scopeAt = (report, a) => (report.codeSeedReport?.outOfScope ?? []).find((s) => s.address === a);
const refusals = (report) => (report.rejectedEntryPoints ?? []).filter((r) => r.reason !== "already_code");

// ======================================================================== §6.1
console.log("§6.1 — six modules on one window, each seeding its OWN entry points\n");
const analysed = {};
for (const m of MODULES) analysed[m.owner] = analyze(m.owner, m.prg);

for (const m of MODULES) {
  const r = analysed[m.owner];
  check(seedAt(r, 0x1000) !== undefined, `${m.owner} seeds its own entry point ${hex(0x1000)} (${seedAt(r, 0x1000)?.origin ?? "MISSING"})`);
}
const ownedByOther = MODULES.flatMap((m) => refusals(analysed[m.owner]).filter((x) => x.reason === "owned_by_other"));
check(ownedByOther.length === 0, `not one of the six is refused as another's — owned_by_other = ${ownedByOther.length} (it was 6 before the window)`);
check(
  (seedAt(analysed.mod_b, 0x1000)?.detail ?? "").includes("mod_a"),
  "…and the seed says the window is shared, naming the owner whose routine the graph records at the same address",
);
check(analysed.mod_c.codeSeedReport?.window?.source === "payload", "a module with a payload record takes its window from the record");
check(analysed.mod_b.codeSeedReport?.window?.source === "analysed-range", "…and one without takes the range it is being analysed at");

// mod_f's record says it ends at $10FF. $1180 is in the image but not in the window.
check(scopeAt(analysed.mod_f, 0x1180) !== undefined, `${hex(0x1180)} is OUT OF SCOPE for mod_f — its recorded window ends at ${hex(0x10ff)}`);
check(refusals(analysed.mod_f).every((x) => x.address !== 0x1180), "…and it is not reported as a refusal: nobody asked for it, so nothing was refused");
check(/outside this payload's window/.test(scopeAt(analysed.mod_f, 0x1180)?.detail ?? ""), "…the answer says why");
check(seedAt(analysed.mod_c, 0x1180) !== undefined, "…while mod_c, whose window DOES reach $1180, seeds it");

// ======================================================================== §6.2
console.log("\n§6.2 — a wide payload stops collecting what loads inside it\n");
analysed.engine = analyze(ENGINE.owner, ENGINE.prg);
analysed.wide = analyze(WIDE.owner, WIDE.prg);
const wide = analysed.wide;

check(seedAt(wide, 0x4310) === undefined, `${hex(0x4310)} is NOT seeded into the wide payload — the engine loads there`);
check(seedAt(wide, 0x1000) === undefined, `${hex(0x1000)} is NOT seeded into it either — the $1000 family loads there`);
check(/engine/.test(scopeAt(wide, 0x4310)?.detail ?? ""), `…${hex(0x4310)} is out of scope, naming the window that does claim it`);
check(/loads inside this payload's window/.test(scopeAt(wide, 0x1000)?.detail ?? ""), `…and so is ${hex(0x1000)}`);
check(refusals(wide).filter((r) => r.reason === "owned_by_other").length === 0, "…and neither is a refusal");
check(seedAt(wide, 0x0b00) !== undefined, `${hex(0x0b00)} — inside the wide payload's window and inside nobody else's — IS seeded: nothing it owns was lost`);
check(seedAt(analysed.engine, 0x4310) !== undefined, `…and the engine, whose own window it is, seeds ${hex(0x4310)} itself`);
check(wide.codeSeedReport?.outOfScope?.length >= 2, `the report counts what the window kept out (${wide.codeSeedReport?.outOfScope?.length})`);

// ======================================================================== §6.3
console.log("\n§6.3 — an ambiguous address names its claimants\n");
const graph = Graph.open(proj);
const card = claimantsCard(graph, 0x1000);
check(card !== null && card.claimants.length === MODULES.length, `${hex(0x1000)} answers with ${card?.claimants.length} claimants (the six modules)`);
check(MODULES.every((m) => card.claimants.some((c) => c.owner === m.owner)), "…each of them named, with its owner");
check(card.claimants.every((c) => /\$[0-9A-F]{4}-\$[0-9A-F]{4}/.test(c.window)), "…each with the window it occupies");
check(card.superseded.some((s) => s.owner === "wide"), "…and the wide payload is NOT one of them: something loads inside its window here");
check(/no single answer/.test(card.note), "…the answer says outright that it has no single answer");
check(claimantsCard(graph, 0x4310)?.claimants.length === 1, `${hex(0x4310)} has exactly one claimant — the engine`);

// ======================================================================== §6.4
console.log("\n§6.4 — with a capture, residency decides\n");
// The capture: memory holds mod_c's image. This is the same `ByteSource` the live
// runtime implements (`src/symbols/live-bytes.ts`), handed in instead of a daemon.
const imageOf = (m) => readFileSync(m.prg);
const captureOf = (m) => ({
  read: async (_space, _lens, addrs) => {
    const buf = imageOf(m);
    const out = new Map();
    for (const a of addrs) {
      const off = a - m.load + 2;
      out.set(a, off >= 2 && off < buf.length ? buf[off] : 0xff);
    }
    return out;
  },
});
const byBytes = await windowResidency({ projectDir: proj, store: graph.store, address: 0x1000, space: "ram", bytes: captureOf(MODULES[2]) });
check(byBytes.resident?.owner === "mod_c", `the bytes in memory name mod_c (got ${byBytes.resident?.owner ?? "nobody"})`);
check(byBytes.resident?.by === "bytes", "…decided by the bytes, not by anything else");
check(/code bytes around/.test(byBytes.resident?.evidence ?? ""), "…and the evidence says how many bytes were held against memory");
const foreign = await windowResidency({ projectDir: proj, store: graph.store, address: 0x1000, space: "ram", bytes: { read: async (_s, _l, addrs) => new Map(addrs.map((a) => [a, 0xee])) } });
check(foreign.resident === undefined && /ambiguous|nothing says/.test(foreign.ambiguous ?? ""), "a capture that matches nobody names no payload — no match, never a wrong one");

// ======================================================================== §6.5
console.log("\n§6.5 — where no capture exists, the reading decides\n");
analysed.loader = analyze(LOADER.owner, LOADER.prg);
// The loader calls one routine from three sites with three positions — the shape
// that makes it a loader at all. Each position is a different module's first
// sector, so the code alone names three of the six claimants.
const media = [
  { owner: "mod_c", track: 18, sector: 1 },
  { owner: "mod_a", track: 19, sector: 4 },
  { owner: "mod_b", track: 20, sector: 7 },
];
const threeNamed = await windowResidency({ projectDir: proj, store: graph.store, address: 0x1000, space: "ram", media });
check(threeNamed.resident === undefined, "a loader that loads three of the claimants into one window settles nothing by itself");
check(threeNamed.evidence.filter((e) => e.loadCall).length === 3, "…and says which three its calls name");

// Naming the CALL is what settles it: that site puts that payload there.
const atSite = await windowResidency({ projectDir: proj, store: graph.store, address: 0x1000, space: "ram", media, loadCall: MOD_C_LOAD_CALL });
check(atSite.resident?.owner === "mod_c", `the load call at ${hex(0x0304)} — track 18, sector 1 — settles the window (got ${atSite.resident?.owner ?? "nobody"})`);
check(atSite.resident?.by === "reading", "…decided by the reading, with no capture anywhere near it");
check(/track 18 sector 1/.test(atSite.resident?.evidence ?? ""), "…with that call recorded as the evidence");
check(/\$0304/.test(atSite.resident?.evidence ?? "") || /\$0300/.test(atSite.resident?.evidence ?? ""), "…naming where in the code it is");

// And where the code names only one of the claimants, no call has to be picked.
const onlyOne = await windowResidency({ projectDir: proj, store: graph.store, address: 0x1000, space: "ram", media: [{ owner: "mod_c", track: 18, sector: 1 }, { owner: "mod_a", track: 31, sector: 9 }] });
check(onlyOne.resident?.owner === "mod_c" && onlyOne.resident?.by === "reading", "…and where only one claimant's sector is named by any load call, that one is the context");

// ======================================================================== §6.6
console.log("\n§6.6 — neither available is SAID, not guessed\n");
const neither = await windowResidency({ projectDir: proj, store: graph.store, address: 0x1000, space: "ram" });
check(neither.resident === undefined, "no capture and no load call names nobody");
check(neither.claimants.length === MODULES.length, "…the claimants are all still named");
check(/ambiguous/.test(neither.ambiguous ?? ""), "…and the answer says the window is ambiguous");
check(MODULES.every((m) => (neither.ambiguous ?? "").includes(m.owner)), "…listing every one of them, so the caller can name one");
check(formatWindowResidency(neither).join("\n").includes("Ambiguous:"), "…and the printed answer carries it too");

// ======================================================================== §6.7
console.log("\n§6.7 — a project with no recorded window behaves as before\n");
// (a) the same graph with the `window` attribute stripped from every payload
// record: derived from the load address and the extent, the answers are identical.
const derivedProj = mkdtempSync(join(tmpdir(), "c64re-867-derived-"));
mkdirSync(join(derivedProj, "analysis"), { recursive: true });
writeGraph(derivedProj, {
  nodes: nodes.map((n) => {
    if (n.kind !== "payload") return n;
    const attrs = JSON.parse(n.attrs);
    delete attrs.payload.window;
    return { ...n, attrs: JSON.stringify(attrs) };
  }),
  edges,
}, GRAPH_DDL);
const derivedGraph = Graph.open(derivedProj);
const before = esmWindows.loadWindows(graph.store).map((w) => `${w.owner} ${w.start}-${w.end}`).join("|");
const after = esmWindows.loadWindows(derivedGraph.store).map((w) => `${w.owner} ${w.start}-${w.end}`).join("|");
check(before === after, "a payload record with no window answers with the same window, derived from the load address and the extent");
derivedGraph.close();

// (b) a project the window model knows nothing about: the Spec 838 subtraction
// still decides, and nothing is dropped.
const bare = mkdtempSync(join(tmpdir(), "c64re-867-bare-"));
mkdirSync(join(bare, "analysis"), { recursive: true });
const bareOwner = "resident";
writePrg(bare, bareOwner, 0xc000, 0xc07f, [ROUTINE(0xc000, 0x51), ROUTINE(0xc010, 0x52)]);
writeGraph(bare, {
  nodes: [
    // one routine each and NOTHING else: no payload record, no segment, and the
    // other owner has no window either — the model has nothing to say here.
    { id: `${SLUG}:ram/${bareOwner}:routine:c000`, layer: "generated", kind: "routine", space: "ram", owner: bareOwner, address: 0xc000, endAddress: 0xc005, name: "Wc000" },
    { id: `${SLUG}:ram:addr:c010`, layer: "generated", kind: "addr", space: "ram", owner: null, address: 0xc010, endAddress: null },
    { id: `${SLUG}:ram:addr:c050`, layer: "generated", kind: "addr", space: "ram", owner: null, address: 0xc050, endAddress: null },
    { id: `${SLUG}:ram/other:label:c050`, layer: "generated", kind: "label", space: "ram", owner: "other", address: 0xc050, endAddress: null, name: "Lc050" },
  ],
  edges: [
    { from: `${SLUG}:ram/caller:routine:8000`, type: "CALLS", to: `${SLUG}:ram:addr:c010`, key: "src:8003", owner: "caller" },
    { from: `${SLUG}:ram/caller:routine:8000`, type: "CALLS", to: `${SLUG}:ram:addr:c050`, key: "src:8006", owner: "caller" },
    { from: `${SLUG}:ram:addr:c050`, type: "RESOLVES_TO", to: `${SLUG}:ram/other:label:c050`, producer: "826r" },
  ],
}, GRAPH_DDL);
const bareSeeds = loadCodeSeeds({ projectDir: bare, owner: bareOwner, lo: 0xc000, hi: 0xc07f });
check(bareSeeds.status === "ok" && bareSeeds.window.source === "analysed-range", "with nothing recorded, the window is the range being analysed and says so");
check(bareSeeds.seeds.some((s) => s.address === 0xc010), "…the cross-overlay call is seeded exactly as before");
check(bareSeeds.skipped.some((s) => s.address === 0xc050), "…and Spec 838's subtraction still decides where no window exists for the other owner");
check(bareSeeds.outOfScope.length === 0, "…nothing is out of scope, because no window claims anything here");

// ============================================================ the two twins
console.log("\nOne model, two implementations — ESM and CommonJS must agree\n");
const esmList = esmWindows.loadWindows(graph.store);
const db = new DatabaseSync(join(proj, "knowledge", "graph.sqlite"), { readOnly: true });
const cjsList = cjsWindows.loadWindows(db);
const key = (w) => `${w.owner}:${w.space}:${w.bank}:${w.start}-${w.end}:${w.source}`;
check(esmList.map(key).join("|") === cjsList.map(key).join("|"), `both read the same ${esmList.length} windows out of one graph`);
let agree = true;
for (const a of [0x0300, 0x0b00, 0x1000, 0x1180, 0x4310, 0x4400, 0x50ff, 0xc000]) {
  const l = esmWindows.claimantsAt(esmList, { address: a }).claimants.map((w) => w.owner).join(",");
  const r = cjsWindows.claimantsAt(cjsList, { address: a }).claimants.map((w) => w.owner).join(",");
  if (l !== r) { agree = false; fail(`the twins disagree at ${hex(a)}: "${l}" vs "${r}"`); }
}
check(agree, "…and they name the same claimants at every address asked");
db.close();
graph.close();

console.log("");
console.log(`${failCount === 0 ? "GREEN" : "RED"}  Spec 867 window: ${pass} pass, ${failCount} fail.`);
process.exit(failCount === 0 ? 0 : 1);
