#!/usr/bin/env node
// Spec 818 — address identity, the store, the query API. Hermetic temp project.
//
//   - the id grammar refuses what it must, naming the rule
//   - deriveId(columns) === id on every write
//   - seeding twice = byte-identical canonical dump (D6)
//   - a human row survives a re-seed; with its generated twin gone it is orphaned, kept, flagged (D5)
//   - a project edge to c64:rom:ffd2 resolves through the platform file; c64:rom:0000 comes back dangling (D7)
//   - find("$7e00") on two overlays returns two rows; find("$0031") returns the platform node
//   - `c64re graph find '$D018' --json` → JSON on stdout, EMPTY stderr (D9); timing printed
//   - knowledge/*.json mtimes unchanged (D10)
//
// Exit 0 = pass, 1 = fail.   npm run e2e:818

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { GraphStore } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));
const { deriveProjectId, parseId, IdRuleError } = await import(join(ROOT, "dist/knowledge-graph/ids.js"));

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

// ---------------------------------------------------------------- project

const project = mkdtempSync(join(tmpdir(), "c64re-818-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
writeFileSync(join(project, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "project-x", name: "Spec 818 fixture", slug: "s818", rootPath: project }, null, 2));
writeFileSync(join(project, "knowledge", "findings.json"), JSON.stringify({ items: [] }));
const mtimeBefore = statSync(join(project, "knowledge", "findings.json")).mtimeMs;

// ---------------------------------------------------------------- 1. grammar

const slug = "s818";
const ctxA = { space: "ram", owner: "main_ovl_7e00" };
const ctxB = { space: "ram", owner: "char_ranger_overlay_7e00" };
const idA = deriveProjectId({ slug, ctx: ctxA, kind: "routine", address: 0x7e00 });
const idB = deriveProjectId({ slug, ctx: ctxB, kind: "routine", address: 0x7e00 });
check(idA === "s818:ram/main_ovl_7e00:routine:7e00", `derived id ${idA}`);
check(deriveProjectId({ slug, ctx: { space: "crt", bank: 7 }, kind: "routine", address: 0x8000 }) === "s818:crt/07:routine:8000", "crt id carries the bank");
check(deriveProjectId({ slug, ctx: { space: "ram" }, kind: "addr", address: 0xc000 }) === "s818:ram:addr:c000", "addr id has no owner");

const refusals = [
  [() => deriveProjectId({ slug, ctx: { space: "ram" }, kind: "routine", address: 0x1000 }), "routine-needs-owner"],
  [() => deriveProjectId({ slug, ctx: ctxA, kind: "addr", address: 0x1000 }), "addr-no-owner"],
  [() => deriveProjectId({ slug, ctx: { space: "crt" }, kind: "routine", address: 0x8000 }), "crt-needs-bank"],
  [() => deriveProjectId({ slug: "c64", ctx: ctxA, kind: "routine", address: 0x1000 }), "slug-is-platform"],
  [() => deriveProjectId({ slug, ctx: ctxA, kind: "routine", address: 0x12345 }), "addr"],
  [() => parseId("s818:ram/x:routine:1DD2"), "addr"],
  [() => parseId("c64:reg:d018"), "pkind"],
];
for (const [fn, rule] of refusals) {
  try { fn(); fail(`refusal missing: ${rule}`); }
  catch (e) { check(e instanceof IdRuleError && e.rule === rule, `refused, rule "${rule}"`); }
}
check(parseId("c64:io:d018").form === "platform" && parseId("s818:sub:disk-loader").form === "subsystem", "parseId: platform + subsystem forms");

// ---------------------------------------------------------------- 2. seed twice, human row, dangling

function seed(store, { withB = true } = {}) {
  const nodes = [
    { parts: { slug, ctx: ctxA, kind: "routine", address: 0x7e00 }, kind: "routine", name: "W7E00", endAddress: 0x7e3f, origin: "static", confidence: "certain" },
    { parts: { slug, ctx: ctxA, kind: "label", address: 0x7e10 }, kind: "label", name: "W7E10", origin: "static", confidence: "certain" },
    { parts: { slug, ctx: { space: "ram" }, kind: "addr", address: 0xc000 }, kind: "addr", origin: "static", confidence: "inferred" },
  ];
  if (withB) nodes.push({ parts: { slug, ctx: ctxB, kind: "routine", address: 0x7e00 }, kind: "routine", name: "W7E00", origin: "static", confidence: "certain" });
  const edges = [
    { from: idA, type: "CALLS_ROM", to: "c64:rom:ffd2", evidenceKey: "src:7e02", origin: "static", confidence: "certain", evidence: { source_address: 0x7e02, instruction: "jsr $FFD2" } },
    { from: idA, type: "CALLS_ROM", to: "c64:rom:0000", evidenceKey: "src:7e05", origin: "static", confidence: "inferred", evidence: { source_address: 0x7e05 } },
    { from: idA, type: "CONTAINS", to: deriveProjectId({ slug, ctx: ctxA, kind: "label", address: 0x7e10 }), origin: "static", confidence: "certain" },
    { from: idA, type: "JUMPS_TO", to: "s818:ram:addr:c000", evidenceKey: "src:7e20", origin: "static", confidence: "inferred", evidence: { source_address: 0x7e20, instruction: "jmp $C000" } },
  ];
  store.replaceGenerated("818-fixture", "main_ovl_7e00", nodes.filter((n) => n.parts.ctx.owner !== ctxB.owner), edges);
  if (withB) store.replaceGenerated("818-fixture", ctxB.owner, nodes.filter((n) => n.parts.ctx.owner === ctxB.owner), []);
}

let store = GraphStore.open(project);
seed(store);
const dump1 = store.canonicalDump();
store.upsertHuman({ id: idA, kind: "routine", name: "print_string", attrs: { subsystem: "text" }, origin: "user", confidence: "user_asserted" });
seed(store);
const dump2 = store.canonicalDump();
check(dump1 === dump2, `seed twice → identical canonical dump (${store.contentHash().slice(0, 16)})`);
store.close();

let graph = Graph.open(project);
const a = graph.resolve(idA);
check(a.name === "print_string" && a.layers.join(",") === "generated,human" && !a.orphaned, "human name overrides generated; both layers reported");
const ffd2 = graph.callers("c64:rom:ffd2");
check(ffd2.length === 1 && ffd2[0].toNode.platform && ffd2[0].toNode.symbol === "CHROUT", "edge to c64:rom:ffd2 resolves through the platform file (CHROUT)");
const dang = graph.callees(idA).find((e) => e.to === "c64:rom:0000");
check(dang && dang.toNode.dangling === true, "c64:rom:0000 comes back DANGLING, not dropped");
const at7e00 = graph.find("$7e00");
check(at7e00.filter((n) => !n.platform).length === 2 && new Set(at7e00.map((n) => n.owner)).size >= 2, "find($7e00): two overlays, two owners");
const at31 = graph.find("$0031");
check(at31.some((n) => n.platform && n.id === "c64:zp:0031"), "find($0031) returns the platform node c64:zp:0031");
const p = graph.path(idA, "s818:ram:addr:c000");
check(p && p.length === 1 && p[0].type === "JUMPS_TO", "path(idA → addr c000) is one JUMPS_TO");
graph.close();

// remove B's generated rows and A's generated row → human row must survive, orphaned
store = GraphStore.open(project);
store.replaceGenerated("818-fixture", "main_ovl_7e00", [], []);
store.close();
graph = Graph.open(project);
const orphan = graph.resolve(idA);
check(orphan.layers.join(",") === "human" && orphan.orphaned === true && orphan.name === "print_string", "human row survives, flagged orphaned");
graph.close();

// ---------------------------------------------------------------- 3. CLI, stderr, timing

const t0 = process.hrtime.bigint();
let stdout = "";
let stderr = "";
try {
  stdout = execFileSync(process.execPath, [join(ROOT, "dist/cli.js"), "graph", "find", "$D018", "--project", project, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  stderr = String(e.stderr ?? e.message);
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
let parsed;
try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
const hits = Array.isArray(parsed) ? parsed : parsed?.hits;
check(Array.isArray(hits) && hits.some((n) => n.id === "c64:io:d018"), "CLI --json: stdout parses, contains c64:io:d018");
check(stderr === "" && !/ExperimentalWarning/.test(stdout), `CLI stderr empty, no ExperimentalWarning (${ms.toFixed(0)} ms incl. node start)`);

// in-process open + one query + close
const t1 = process.hrtime.bigint();
const g = Graph.open(project); g.find("$D018"); g.close();
const q = Number(process.hrtime.bigint() - t1) / 1e6;
check(q < 50, `open + query + close ${q.toFixed(2)} ms`);

// ---------------------------------------------------------------- 4. D10

check(statSync(join(project, "knowledge", "findings.json")).mtimeMs === mtimeBefore, "knowledge/*.json untouched (mtime)");
check(readdirSync(join(project, "knowledge")).some((f) => f === "graph.sqlite"), "graph lives at knowledge/graph.sqlite");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 818: ${pass} pass, ${failCount} fail.  project: ${project}`);
process.exit(failCount ? 1 : 0);
