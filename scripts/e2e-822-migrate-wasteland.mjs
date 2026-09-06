#!/usr/bin/env node
// Spec 822 — human knowledge + migration of the JSON store, against a TEMP COPY
// of Wasteland_EF (knowledge/*.json, the 16 *_annotations.json, one _analysis.json
// for the 819 re-seed). The original is never opened for writing.
//
//   - dry run leaves no graph behind; the real run produces the §5 numbers as
//     re-measured (the spec's first estimates are corrected in §"Built")
//   - the $0031 node: ONE behaves_like claim, 58 evidence rows, the newest run's value + score
//   - every legacy id in migration_log exactly once; second run = zero created|merged|folded,
//     identical canonical dump (818 generated + human + every 822 table)
//   - human invariant: sha256 over the human layer equal across a 819 re-seed of one artifact;
//     a rename through the door survives the next re-seed, generated twin present
//   - conflict rule: human name in find(), generated name via layer=generated
//   - searchAnnotations (FTS5), subsystem door + query, annotations() with the D8 doc join, answerQuestion
//   - 2 × 200 concurrent save_finding through the door → 400 rows; 822.2: the same through the SERVICE after the cut-over
//   - 822.2: opening a legacy copy as a project cuts it over (files → _legacy-822/, timeline, projections answer, second open no-op)
//   - PENDING (loud, exit 0) without the fixture — the smoke-740 shape
//
// Exit 0 = pass, 1 = fail.   npm run e2e:822

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WASTELAND = process.env.C64RE_WASTELAND_EF ?? "/Users/alex/Development/C64/Cracking/Wasteland_EF";

console.log("Spec 822 — human knowledge integration + migration, Wasteland_EF acceptance\n");
// 822.2 cut a project over on open: the six stores then live in knowledge/_legacy-822/.
// The gate tests the migration, so it rebuilds the PRE-cut-over layout in its temp copy
// from whichever place still has the files.
const LEGACY_DIR = "_legacy-822";
const legacySource = (f) => (existsSync(join(WASTELAND, "knowledge", f)) ? join(WASTELAND, "knowledge", f) : join(WASTELAND, "knowledge", LEGACY_DIR, f));
if (!existsSync(legacySource("entities.json"))) {
  console.log(`PENDING — Wasteland_EF fixture not present at ${WASTELAND} (set C64RE_WASTELAND_EF). 0 pass, 0 fail. NOT green, NOT run.`);
  process.exit(0);
}

const { migrateProject } = await import(join(ROOT, "dist/knowledge-graph/migrate/migrate.js"));
const { canonicalDump822, humanLayerHash } = await import(join(ROOT, "dist/knowledge-graph/migrate/schema-822.js"));
const { nameNode, assignSubsystem, answerQuestion, linkNodes } = await import(join(ROOT, "dist/knowledge-graph/migrate/human.js"));
const { searchAnnotations, annotations, subsystem, resolveLayer, findWithLayer } = await import(join(ROOT, "dist/knowledge-graph/query-human.js"));
const { GraphStore, graphPath } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));
const { seedControlFlow } = await import(join(ROOT, "dist/knowledge-graph/producers/control-flow.js"));

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const info = (msg) => console.log(`  info  ${msg}`);
const eq = (actual, expected, what) => check(actual === expected, `${what} = ${actual}${actual === expected ? "" : ` (expected ${expected})`}`);

// ---------------------------------------------------------------- 0. the temp copy

const t0 = process.hrtime.bigint();
const project = mkdtempSync(join(tmpdir(), "c64re-822-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
for (const f of readdirSync(join(WASTELAND, "knowledge"))) {
  if (!f.endsWith(".json") && f !== "notes.md") continue;
  copyFileSync(join(WASTELAND, "knowledge", f), join(project, "knowledge", f));
}
// the six stores a cut-over project keeps under _legacy-822/ go back to the root of the copy
for (const f of ["entities.json", "findings.json", "relations.json", "open-questions.json", "labels.user.json", "flows.json"]) {
  if (!existsSync(join(project, "knowledge", f)) && existsSync(join(WASTELAND, "knowledge", LEGACY_DIR, f))) copyFileSync(join(WASTELAND, "knowledge", LEGACY_DIR, f), join(project, "knowledge", f));
}
function findFiles(dir, suffix, out = [], depth = 0) {
  if (depth > 8) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".") || entry === "knowledge") continue;
    const p = join(dir, entry);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) findFiles(p, suffix, out, depth + 1);
    else if (entry.endsWith(suffix)) out.push(p);
  }
  return out.sort();
}
const annotationFiles = findFiles(WASTELAND, "_annotations.json");
for (const src of annotationFiles) {
  const dst = join(project, relative(WASTELAND, src));
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}
const OWNER = "block2_engine_0200";
const analysisSrc = findFiles(WASTELAND, `${OWNER}_analysis.json`)[0];
let analysisPath;
if (analysisSrc) {
  analysisPath = join(project, relative(WASTELAND, analysisSrc));
  mkdirSync(dirname(analysisPath), { recursive: true });
  copyFileSync(analysisSrc, analysisPath);
}
// a hand-written 740.1 cache with one doc section at $25C1 — the D8 join is computed from it, never from the JSON store
mkdirSync(join(project, "knowledge", ".cache"), { recursive: true });
writeFileSync(join(project, "knowledge", ".cache", "project-search-index.json"), JSON.stringify({
  version: 1, projectDir: project, counts: {}, sourcesRead: [], warnings: [],
  records: [{ id: "doc:cartography#area-load", kind: "doc_section", title: "Area load orchestrator", summary: "", snippet: "$25C1 assembles an area from the descriptor record", tags: [], artifactIds: [], entityIds: [], relationIds: [], sourcePath: "docs/CODE_CARTOGRAPHY.md", sourceAnchor: "area-load", addrTokens: ["25c1"] }],
}));
const slug = JSON.parse(readFileSync(join(project, "knowledge", "project.json"), "utf8")).slug;
const mtimes = Object.fromEntries(["entities", "findings", "relations", "open-questions", "flows", "labels.user"].map((f) => [f, statSync(join(project, "knowledge", `${f}.json`)).mtimeMs]));
info(`temp copy ${project} (${annotationFiles.length} annotation files, slug ${slug}) in ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms`);

// ---------------------------------------------------------------- 1. dry run, then the migration

const dry = migrateProject({ projectDir: project, dryRun: true });
const dryActions = Object.values(dry.stores).reduce((a, s) => a + s.created + s.merged + s.folded + s.skipped, 0);
check(!existsSync(graphPath(project)) && dryActions > 40000, `dry run leaves no graph.sqlite behind (${dry.ms.toFixed(0)} ms, ${dryActions} actions computed then rolled back)`);

const m1 = migrateProject({ projectDir: project });
info(`migration ${m1.ms.toFixed(0)} ms, run ${m1.runId}, text index ${m1.textIndex}, cutover ${m1.cutoverAt}`);
const S = m1.stores;
const line = (name, s) => `${name.padEnd(15)} total=${String(s.total).padStart(5)} created=${String(s.created).padStart(5)} merged=${String(s.merged).padStart(5)} folded=${String(s.folded).padStart(4)} skipped=${String(s.skipped).padStart(3)} already=${String(s.already).padStart(5)} ctx-by-stem=${s.ctxByStem}`;
for (const [k, v] of Object.entries(S)) info(line(k, v));
info(`generated 822 nodes by kind ${JSON.stringify(m1.nodesByKind)}`);
info(`graph ${JSON.stringify(m1.graph)}`);
for (const f of m1.files) info(`  file ${f.stem.padEnd(40)} owner=${f.owner.padEnd(26)} r=${f.routines} l=${f.labels} s=${f.segments} dropped=${f.dropped}`);

// the §5 numbers, re-measured 2026-09-06 on the real store (the truth the spec's estimates are corrected to)
eq(S.entities.total, 22848, "entities read");
eq(S.entities.created + S.entities.merged + S.entities.folded, 22848, "entities logged (created+merged+folded)");
eq(S.entities.folded, 5, "entities folded to prose (no address: 4 traces + save descriptor)");
eq(S.findings.total, 9680, "findings read");
eq(S.findings.folded, 204, "annotation-mirror findings folded (Spec 055)");
eq(S.relations.total, 7671, "relations read");
eq(S["open-questions"].total, 3652, "questions read");
eq(S["open-questions"].folded, 3640, "heuristic questions folded into claims.validation");
eq(S.flows.skipped, 69, "flows skipped-regenerable");
eq(S.labels.total, 0, "user labels (none in this store)");
eq(m1.files.length, 16, "annotation files imported");
eq(m1.files.reduce((a, f) => a + f.routines, 0), 456, "annotation routines read");
eq(m1.files.reduce((a, f) => a + f.labels, 0), 2191, "annotation labels read");
eq(m1.files.reduce((a, f) => a + f.segments, 0), 369, "annotation segments read");

let store = GraphStore.open(project, { readOnly: true });
let db = store.db;
const q1 = (sql, ...p) => Number(db.prepare(sql).get(...p).n);
const G = m1.graph;
eq(G.generatedNodes822, 4989, "generated nodes from the JSON (4,612 analysis + 377 manifest/inventory)");
eq(q1("SELECT COUNT(*) AS n FROM nodes WHERE layer='generated' AND producer='822' AND kind='addr'"), 363, "shared addr nodes (RAM behaviour, 363 addresses)");
eq(m1.nodesByKind.entry, 2684, "entry nodes under their owners (8,176 entry-point entities)");
eq(m1.nodesByKind.segment, 1565, "segment nodes under their owners (9,208 segment entities)");
eq(q1("SELECT COUNT(*) AS n FROM nodes WHERE layer='generated' AND producer='822' AND kind='chip'"), 128, "chip nodes (256 chips over 2 cart images → 128 crt/<bank> nodes)");
eq(q1("SELECT COUNT(*) AS n FROM nodes WHERE layer='generated' AND producer='822' AND kind='bank'"), 64, "bank nodes");
eq(q1("SELECT COUNT(*) AS n FROM nodes WHERE layer='generated' AND producer='822' AND kind='payload'"), 185, "payload nodes (183 area assets + 4 disk files → 2: prodos, 2.0 twice each)");
eq(q1("SELECT COUNT(*) AS n FROM nodes WHERE layer='generated' AND producer='822' AND kind IN ('routine','label')"), 0, "822 never writes generated routine/label rows (819's ids)");
eq(G.claims, 1189, "claims from analysis-import findings (363 behaves_like + 824 segment_kind + 2 display_transfer)");
eq(q1("SELECT COUNT(*) AS n FROM evidence WHERE target_table='claims'"), 9421, "evidence rows under claims (one per analysis-import finding)");
eq(q1("SELECT COUNT(*) AS n FROM evidence WHERE target_table='nodes'"), 22843, "evidence rows under nodes (one per entity that became a node)");
eq(G.generatedEdges822, 2595, "generated edges (7,398 maps-to/precedes → 2,467 + 256 contains → 128)");
eq(q1("SELECT COUNT(*) AS n FROM evidence WHERE target_table='edges'"), 7666, "evidence rows under edges (7,671 − 5 folded)");
eq(G.humanNodes, 1913, "human nodes (18 from hand entities + 1,895 distinct (owner,address) rows from the 16 files)");
eq(q1("SELECT COUNT(*) AS n FROM nodes WHERE layer='human' AND kind='routine'"), 317, "human routine nodes (316 distinct (owner,start) from the files + 1 hand routine; 271 distinct by address alone)");
eq(q1("SELECT COUNT(*) AS n FROM nodes WHERE layer='human' AND kind='label'"), 1341, "human label nodes (distinct (owner,address); 1,085 by address alone)");
eq(q1("SELECT COUNT(*) AS n FROM nodes WHERE layer='human' AND kind='segment'"), 238, "human segment nodes (distinct (owner,start); 225 by address alone)");
eq(G.humanEdges, 12, "human edges (17 hand relations − 5 whose endpoint is prose: 4 traces + the save descriptor)");
eq(q1("SELECT COUNT(*) AS n FROM annotations WHERE kind LIKE 'finding:%' AND layer='human'"), 49, "hand-saved findings → human annotations");
eq(q1("SELECT COUNT(*) AS n FROM annotations WHERE kind LIKE 'finding:%' AND layer='generated'"), 3, "manifest findings → generated prose (6 findings, 3 distinct titles; each legacy id in evidence)");
eq(q1("SELECT COUNT(*) AS n FROM evidence WHERE target_table='annotations' AND legacy_id LIKE 'finding-%' AND legacy_id NOT LIKE '%#%'"), 55, "every prose finding keeps its legacy id as an evidence row (49 + 6)");
eq(q1("SELECT COUNT(*) AS n FROM annotations WHERE kind='entity'"), 22, "hand entity summaries → entity annotations (26 with an address, 4 duplicate payload ids)");
eq(q1("SELECT COUNT(*) AS n FROM annotations WHERE kind LIKE 'entity:%'"), 5, "address-less hand entities → prose");
eq(q1("SELECT COUNT(*) AS n FROM annotations WHERE kind LIKE 'relation:%'"), 5, "relations with a prose endpoint → prose");
eq(q1("SELECT COUNT(*) AS n FROM annotations WHERE kind='routine'"), 316, "routine annotations (name + comment, one per file routine node)");
eq(q1("SELECT COUNT(*) AS n FROM annotations WHERE kind='label'"), 24, "label annotations (only the 40 labels with a comment, 24 distinct (owner,address))");
eq(q1("SELECT COUNT(*) AS n FROM annotations WHERE kind='segment'"), 190, "segment annotations (segments with a label or comment)");
eq(G.questions, 12, "questions kept as rows (11 static-analysis + 1 human)");
eq(q1("SELECT COUNT(*) AS n FROM questions WHERE layer='human'"), 1, "the one human question");
eq(q1("SELECT COUNT(*) AS n FROM migration_log WHERE legacy_store='open-questions' AND note='answered'"), 55, "answered heuristic questions folded (answeredByFindingId)");
eq(q1("SELECT COUNT(*) AS n FROM claims WHERE validation='answered'"), 8, "distinct claims those 55 answers validate");
eq(S.entities.ctxByStem, 1097, "entities whose owner is a stem, not a payload (11 rebuild-check / drive-code analyses; ctx-by-stem, OQ1)");

// every legacy id exactly once
const legacyTotal = S.entities.total + S.findings.total + S.relations.total + S["open-questions"].total + S.flows.total + S.labels.total + S.annotations.total;
eq(G.migrationLog, legacyTotal, "migration_log rows = legacy records read (each exactly once)");
eq(q1("SELECT COUNT(*) AS n FROM (SELECT legacy_store, legacy_id FROM migration_log GROUP BY 1,2 HAVING COUNT(*) > 1)"), 0, "no legacy id logged twice");

// $0031 (D5)
const a31 = `${slug}:ram:addr:0031`;
const c31 = db.prepare("SELECT * FROM claims WHERE node_id = ? AND claim = 'behaves_like'").all(a31);
const e31 = db.prepare("SELECT * FROM evidence WHERE target_table = 'claims' AND target_key = ? ORDER BY captured_at DESC").all(`${a31}|behaves_like`);
check(c31.length === 1, `$0031: one behaves_like claim (value ${c31[0]?.value}, score ${c31[0]?.score})`);
eq(e31.length, 58, "$0031: evidence rows");
const newest = e31[0] ? JSON.parse(e31[0].attrs) : {};
check(c31[0] && c31[0].value === newest.value && c31[0].score === newest.score && c31[0].updated_at === e31[0].captured_at, `$0031: the claim carries the NEWEST run's value/score (${newest.value} ${newest.score} @ ${e31[0]?.captured_at})`);
check(c31[0] && db.prepare("SELECT 1 FROM nodes WHERE id = ? AND layer = 'generated'").get(a31), "$0031: the shared addr node exists");
const hexKeys = db.prepare("SELECT id FROM nodes WHERE producer = '822'").all().filter((r) => !/^[a-z0-9\-]+:(ram|crt|drv)(\/[a-z0-9_.\-]+)?:[a-z_]+:[0-9a-f]{4}$/.test(r.id) && !/^[a-z0-9\-]+:sub:/.test(r.id));
eq(hexKeys.length, 0, "every 822 id obeys the 818 grammar");
store.close();

// ---------------------------------------------------------------- 2. idempotence

store = GraphStore.open(project, { readOnly: true });
const dumpA = store.canonicalDump("generated") + store.canonicalDump("human") + canonicalDump822(store.db);
const hashHumanA = humanLayerHash(store.db);
store.close();
const m2 = migrateProject({ projectDir: project });
const actions2 = Object.values(m2.stores).reduce((a, s) => a + s.created + s.merged + s.folded + s.skipped, 0);
eq(actions2, 0, `second run: created|merged|folded|skipped actions (${m2.ms.toFixed(0)} ms)`);
eq(Object.values(m2.stores).reduce((a, s) => a + s.already, 0), legacyTotal, "second run: every legacy id reported already");
store = GraphStore.open(project, { readOnly: true });
const dumpB = store.canonicalDump("generated") + store.canonicalDump("human") + canonicalDump822(store.db);
check(dumpA === dumpB, `second run: identical canonical dump (${dumpA.length} bytes, 818 generated + human + 822 tables)`);
check(humanLayerHash(store.db) === hashHumanA, `human layer hash unchanged by the re-run (${hashHumanA.slice(0, 16)})`);
for (const [f, t] of Object.entries(mtimes)) if (statSync(join(project, "knowledge", `${f}.json`)).mtimeMs !== t) fail(`knowledge/${f}.json was written by the migration`);
ok("knowledge/*.json untouched by both runs (mtime)");
store.close();

// ---------------------------------------------------------------- 3. human invariant across a 819 re-seed

if (!analysisPath) {
  fail(`no ${OWNER}_analysis.json under ${WASTELAND} — the 819 re-seed half of the invariant cannot run`);
} else {
  const r1 = seedControlFlow({ projectDir: project, analysisPath, owner: OWNER });
  info(`819 seed ${OWNER}: routines=${r1.routines} labels=${r1.labels} edges=${JSON.stringify(r1.edges)} ${r1.ms.toFixed(0)} ms`);
  store = GraphStore.open(project, { readOnly: true });
  check(humanLayerHash(store.db) === hashHumanA, "human layer hash equal after the 819 re-seed of one artifact (D2)");
  const g = new Graph(store, undefined);
  // a routine the files named AND 819 discovered — both layers at one id
  const both = store.db.prepare("SELECT n.id, n.name FROM nodes n WHERE n.layer='human' AND n.kind='routine' AND n.owner=? AND EXISTS (SELECT 1 FROM nodes g WHERE g.id=n.id AND g.layer='generated' AND g.producer='819') ORDER BY n.address LIMIT 1").get(OWNER);
  check(both, `a routine both the annotation file and 819 know: ${both?.id} (${both?.name})`);
  if (both) {
    const merged = g.resolve(both.id);
    check(merged.name === both.name && merged.layers.join(",") === "generated,human", "conflict rule: the merged node answers with the human name, both layers reported");
    const gen = resolveLayer(g, both.id, "generated");
    check(gen && gen.name !== both.name && /^W[0-9A-F]{4}$/.test(gen.name ?? ""), `conflict rule: layer=generated returns the other (${gen?.name})`);
    const byName = findWithLayer(g, both.name, "human");
    check(byName.some((n) => n.id === both.id), `find("${both.name}") returns the node under its human name`);
    check(findWithLayer(g, both.name, "generated").every((n) => n.name !== both.name || n.platform), "find with layer=generated does not answer with the human name");
  }
  store.close();

  // rename through the door, re-seed, the rename survives and the generated twin is present
  const target = both?.id ?? `${slug}:ram/${OWNER}:routine:${(r1.routines && "0200") || "0200"}`;
  nameNode(project, { id: target, kind: "routine", name: "renamed_through_the_door", comment: "renamed in the 822 gate", author: "e2e-822" });
  store = GraphStore.open(project, { readOnly: true });
  const hashRenamed = humanLayerHash(store.db);
  check(hashRenamed !== hashHumanA, "the rename changed the human layer hash (the door is the only writer)");
  store.close();
  seedControlFlow({ projectDir: project, analysisPath, owner: OWNER });
  store = GraphStore.open(project, { readOnly: true });
  check(humanLayerHash(store.db) === hashRenamed, "human layer hash equal after the second re-seed");
  const g2 = new Graph(store, undefined);
  const after = g2.resolve(target);
  check(after.name === "renamed_through_the_door" && after.layers.includes("generated") && !after.orphaned, "the rename survives the re-seed; the generated row beneath it is back");
  const ann = annotations(g2, target);
  check(ann.annotations.some((a) => a.kind === "routine" && a.body === "renamed in the 822 gate" && a.producer === "human"), "the door's comment is a routine annotation with producer human");
  check(!store.db.prepare("SELECT 1 FROM nodes WHERE layer='human' AND producer IN ('819','820','821')").get(), "no human row carries a producer 819/820/821");
  store.close();
}

// ---------------------------------------------------------------- 4. query extensions

store = GraphStore.open(project, { readOnly: true });
const g3 = new Graph(store, undefined);
const s1 = searchAnnotations(g3, "fastloader", { layer: "human" });
check(s1.textIndex === "fts5", `searchAnnotations uses ${s1.textIndex} (FTS5 present in this Node's SQLite)`);
check(s1.hits.length > 0 && s1.hits.every((h) => h.layer === "human"), `searchAnnotations("fastloader", human) → ${s1.hits.length} hits, all human`);
const s2 = searchAnnotations(g3, "fastloader", { layer: "generated" });
check(s2.hits.every((h) => h.layer === "generated"), `searchAnnotations("fastloader", generated) → ${s2.hits.length} hits, all generated`);
const orch = store.db.prepare("SELECT id FROM nodes WHERE layer='human' AND name='area_load_orchestrator'").get();
check(orch && orch.id === `${slug}:ram/${OWNER}:routine:25c1`, `hand-made routine area_load_orchestrator resolved under its payload owner (${orch?.id})`);
if (orch) {
  const a = annotations(g3, orch.id);
  check(a.annotations.some((x) => x.kind === "entity" && x.legacy_id?.startsWith("entity-")), "annotations(id): the hand entity's summary is an `entity` annotation carrying the legacy id");
  check(a.docsIndex === "cache" && a.docs.length === 1 && a.docs[0].sourcePath === "docs/CODE_CARTOGRAPHY.md", "annotations(id): the 740.1 doc section at $25C1 is joined from the cache, not stored (D8)");
  const calls = g3.callees(orch.id);
  check(calls.some((e) => e.layer === "human" && e.toNode.name === "resolve_id_to_ts"), "hand relation `calls` → human CALLS edge, endpoints re-resolved by derived id");
}
const traceFold = store.db.prepare("SELECT * FROM annotations WHERE kind = 'relation:documents'").all();
check(traceFold.length === 4 && traceFold.every((r) => r.node_id && r.layer === "human"), "`documents` relations from address-less trace entities folded onto the documented node");
store.close();

// subsystem door + query
const members = [`${slug}:ram/${OWNER}:routine:25c1`, `${slug}:ram/${OWNER}:routine:2790`];
const sub = assignSubsystem(project, { name: "area-loader", members, title: "Area loader", comment: "the load chain from orchestrator to disk locator", author: "e2e-822" });
check(sub.id === `${slug}:sub:area-loader` && sub.added === 2, `assignSubsystem → ${sub.id}, ${sub.added} CONTAINS edges`);
const sub2 = assignSubsystem(project, { name: "area-loader", members });
eq(sub2.added, 0, "assignSubsystem is idempotent (second call adds)");
check(linkNodes(project, { from: members[1], type: "calls", to: members[0], title: "gate link", author: "e2e-822" }) === true && linkNodes(project, { from: members[1], type: "CALLS", to: members[0] }) === false, "linkNodes: a human CALLS edge through the door, idempotent");
store = GraphStore.open(project, { readOnly: true });
const g4 = new Graph(store, undefined);
const view = subsystem(g4, "area-loader");
check(view && view.members.length === 2 && view.members.every((m) => m.layers.includes("human")), `subsystem("area-loader") → ${view?.members.length} members, uses ${JSON.stringify({ registers: view?.uses.registers.length, zeroPage: view?.uses.zeroPage.length, other: view?.uses.other.length })} (derived, nothing stored)`);
const humanQ = store.db.prepare("SELECT id FROM questions WHERE layer = 'human'").get();
store.close();
if (humanQ) {
  const answered = answerQuestion(project, { id: humanQ.id, answer: "drive code reads T18 sectors 12-15 and the side signature at T35/S14", answeredBy: "e2e-822" });
  check(answered.status === "answered" && answered.answered_by === "e2e-822", "answerQuestion on the migrated human question");
  store = GraphStore.open(project, { readOnly: true });
  check(humanLayerDumpHas(store.db, humanQ.id), "the answer is part of the human-layer hash input");
  store.close();
}
function humanLayerDumpHas(dbx, id) { return dbx.prepare("SELECT 1 FROM questions WHERE id = ? AND answer IS NOT NULL").get(id) !== undefined; }

// ---------------------------------------------------------------- 5. concurrency: 2 × 200 through the door, none lost

const child = `
  const { recordFinding, openStore } = await import(${JSON.stringify(join(ROOT, "dist/knowledge-graph/migrate/human.js"))});
  const [project, tag] = process.argv.slice(1);
  const store = openStore(project);
  for (let i = 0; i < 200; i += 1) recordFinding(store, { kind: "observation", title: tag + " finding " + i, summary: "concurrent write " + i, tags: [tag], addressRange: { start: 0x1000 + i, end: 0x1000 + i } });
  store.close();
`;
const tC = process.hrtime.bigint();
const runs = ["conc-a", "conc-b"].map((tag) => new Promise((res) => {
  const p = spawn(process.execPath, ["--input-type=module", "-e", child, "--", project, tag], { stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; p.stderr.on("data", (d) => { err += d; });
  p.on("exit", (code) => res({ tag, code, err }));
}));
const results = await Promise.all(runs);
const msC = Number(process.hrtime.bigint() - tC) / 1e6;
for (const r of results) check(r.code === 0 && !/ExperimentalWarning/.test(r.err), `writer ${r.tag} exit ${r.code}${r.err ? ` stderr: ${r.err.slice(0, 200)}` : ""}`);
store = GraphStore.open(project, { readOnly: true });
const rowsA = Number(store.db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE tags LIKE '%conc-a%'").get().n);
const rowsB = Number(store.db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE tags LIKE '%conc-b%'").get().n);
eq(rowsA + rowsB, 400, `graph door: 2 × 200 concurrent save_finding → rows (${msC.toFixed(0)} ms both writers)`);
store.close();

// ---------------------------------------------------------------- 5b. 822.2 — the cut-over through the service
//
// A SECOND fresh copy of the legacy store, opened the way every MCP tool opens a
// project: `new ProjectKnowledgeService(dir)`. The constructor folds the legacy
// JSON into the graph, parks the files under knowledge/_legacy-822/, logs it to
// the timeline; the record projections answer with the migrated rows; a second
// open is a no-op; 2 × 200 concurrent save_finding THROUGH THE SERVICE land
// 400/400 (the JSON path this replaced lost 200 of 400 — recorded in §"Built").
{
  const { ProjectKnowledgeService } = await import(join(ROOT, "dist/project-knowledge/service.js"));
  const cut = mkdtempSync(join(tmpdir(), "c64re-822-cut-"));
  mkdirSync(join(cut, "knowledge"), { recursive: true });
  for (const f of readdirSync(join(WASTELAND, "knowledge"))) {
    if (!f.endsWith(".json") && f !== "notes.md") continue;
    copyFileSync(join(WASTELAND, "knowledge", f), join(cut, "knowledge", f));
  }
  for (const f of ["entities.json", "findings.json", "relations.json", "open-questions.json", "labels.user.json", "flows.json"]) {
    if (!existsSync(join(cut, "knowledge", f)) && existsSync(join(WASTELAND, "knowledge", LEGACY_DIR, f))) copyFileSync(join(WASTELAND, "knowledge", LEGACY_DIR, f), join(cut, "knowledge", f));
  }
  for (const src of annotationFiles) {
    const dst = join(cut, relative(WASTELAND, src));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  const legacyFiles = ["entities.json", "findings.json", "relations.json", "open-questions.json", "labels.user.json"];
  const tCut = process.hrtime.bigint();
  const svc = new ProjectKnowledgeService(cut);
  const msCut = Number(process.hrtime.bigint() - tCut) / 1e6;
  check(legacyFiles.every((f) => !existsSync(join(cut, "knowledge", f)) && existsSync(join(cut, "knowledge", "_legacy-822", f))), `opening the project cut it over: the five legacy files moved to knowledge/_legacy-822/ (${msCut.toFixed(0)} ms)`);
  check(existsSync(join(cut, "knowledge", "flows.json")) && existsSync(join(cut, "knowledge", "artifacts.json")), "flows.json and artifacts.json stay JSON (not knowledge / regenerable)");
  const cutStore = GraphStore.open(cut, { readOnly: true });
  const cutRuns = Number(cutStore.db.prepare("SELECT COUNT(*) AS n FROM migration_runs WHERE dry_run = 0").get().n);
  const cutLedger = Number(cutStore.db.prepare("SELECT COUNT(*) AS n FROM migration_log").get().n);
  const cutoverAt = cutStore.db.prepare("SELECT value FROM meta WHERE key = 'cutover_at'").get()?.value;
  const claimsN = Number(cutStore.db.prepare("SELECT COUNT(*) AS n FROM claims").get().n);
  const findingAnnN = Number(cutStore.db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE kind LIKE 'finding:%'").get().n);
  const questionsN = Number(cutStore.db.prepare("SELECT COUNT(*) AS n FROM questions").get().n);
  cutStore.close();
  eq(cutLedger, legacyTotal, "cut-over ledger = the same legacy records the migration gate read");
  check(Boolean(cutoverAt), `meta.cutover_at stamped (${cutoverAt})`);
  const timeline = readFileSync(join(cut, "session", "timeline.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check(timeline.some((e) => /Spec 822 cut-over/.test(e.title)), "the cut-over is a timeline event");
  const status = svc.getProjectStatus();
  eq(status.counts.findings, claimsN + findingAnnN, "project_status counts findings from the graph (claims + prose)");
  eq(status.counts.openQuestions, questionsN, "project_status counts open questions from the graph");
  const findings = svc.listFindings();
  check(findings.length === claimsN + findingAnnN && findings.some((f) => f.id.startsWith("claim:")) && findings.some((f) => f.id.startsWith("ann:")), `listFindings = ${findings.length} (claims as generated findings, prose as human findings)`);
  const claim31 = findings.find((f) => f.id === `claim:${slug}:ram:addr:0031|behaves_like`);
  check(claim31 && claim31.kind === "hypothesis" && claim31.tags.includes("analysis-import") && claim31.tags.includes("ram-hypothesis") && claim31.addressRange?.start === 0x31 && claim31.evidence.length === 58, `the $0031 claim projects as one hypothesis finding with 58 evidence refs (${claim31?.evidence.length})`);
  const entities = svc.listEntities();
  check(entities.length > 4000 && entities.every((e) => e.id && e.kind && e.name), `listEntities = ${entities.length} records, every one with id / kind / name`);
  const orch = entities.find((e) => e.name === "area_load_orchestrator" && e.kind === "routine");
  check(orch && orch.id === `${slug}:ram/${OWNER}:routine:25c1` && orch.kind === "routine" && orch.addressRange?.start === 0x25c1, `a hand entity keeps its kind and address under its graph id (${orch?.id})`);
  const payloads = svc.listEntities({ kind: "payload" });
  check(payloads.length >= 185 && payloads.some((p) => p.payloadSourceArtifactId), `payload entities project with their payload fields (${payloads.length})`);
  const relations = svc.listRelations();
  check(relations.length > 2000 && relations.every((r) => r.sourceEntityId && r.targetEntityId && r.kind), `listRelations = ${relations.length} edges as relation records`);
  const questions = svc.listOpenQuestions();
  check(questions.length === questionsN && questions.every((q) => q.status && q.priority), `listOpenQuestions = ${questions.length} (heuristic prompts are claim validation state, not rows)`);
  // an alias from the legacy era still resolves through the ledger
  const legacyEntity = JSON.parse(readFileSync(join(cut, "knowledge", "_legacy-822", "entities.json"), "utf8")).items.find((e) => e.name === "area_load_orchestrator" && e.kind === "routine");
  check(legacyEntity && svc.getEntity(legacyEntity.id)?.id === orch?.id, `a legacy entity id resolves to its graph node through the ledger (${legacyEntity?.id} → ${orch?.id})`);
  // second open: no second migration, nothing moved
  const t2 = process.hrtime.bigint();
  new ProjectKnowledgeService(cut);
  const ms2 = Number(process.hrtime.bigint() - t2) / 1e6;
  const s2 = GraphStore.open(cut, { readOnly: true });
  eq(Number(s2.db.prepare("SELECT COUNT(*) AS n FROM migration_runs WHERE dry_run = 0").get().n), cutRuns, `a second open runs no migration (${ms2.toFixed(0)} ms)`);
  s2.close();
  // a door write through the service, then the same 2 × 200 race THROUGH THE SERVICE
  const saved = svc.saveFinding({ kind: "observation", title: "cut-over gate finding", summary: "written through the service after the cut", addressRange: { start: 0x25c1, end: 0x25c1 }, tags: ["gate-822"] });
  check(/^ann:/.test(saved.id) && svc.listFindings().some((f) => f.id === saved.id && f.tags.includes("gate-822")), `save_finding through the service → ${saved.id}, listed back`);
  check(!legacyFiles.some((f) => existsSync(join(cut, "knowledge", f))), "no legacy JSON file reappeared after the write");
  const svcChild = `
    const { ProjectKnowledgeService } = await import(${JSON.stringify(join(ROOT, "dist/project-knowledge/service.js"))});
    const [project, tag] = process.argv.slice(1);
    const svc = new ProjectKnowledgeService(project);
    for (let i = 0; i < 200; i += 1) svc.saveFinding({ kind: "observation", title: tag + " finding " + i, tags: [tag], addressRange: { start: 0x1000 + i, end: 0x1000 + i } });
  `;
  const tS = process.hrtime.bigint();
  const sr = await Promise.all(["svc-a", "svc-b"].map((tag) => new Promise((res) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", svcChild, "--", cut, tag], { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code) => res({ tag, code, err }));
  })));
  const msS = Number(process.hrtime.bigint() - tS) / 1e6;
  for (const r of sr) check(r.code === 0 && !/ExperimentalWarning/.test(r.err), `service writer ${r.tag} exit ${r.code}${r.err ? ` stderr: ${r.err.slice(0, 200)}` : ""}`);
  const s3 = GraphStore.open(cut, { readOnly: true });
  const svcRows = Number(s3.db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE tags LIKE '%svc-a%' OR tags LIKE '%svc-b%'").get().n);
  s3.close();
  eq(svcRows, 400, `2 × 200 concurrent save_finding THROUGH THE SERVICE → rows (${msS.toFixed(0)} ms; the JSON path lost 200 of 400 here before the cut)`);
  check(msS < 20_000, `400 service writes on the 47k-record graph in ${(msS / 1000).toFixed(1)} s (< 20 s: a save projects ONE record, not the store)`);
}

// ---------------------------------------------------------------- 6. the CLI stays quiet; timing

let stderr = "";
try { execFileSync(process.execPath, [join(ROOT, "dist/cli.js"), "graph", "stats", "--project", project, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
catch (e) { stderr = String(e.stderr ?? e.message); }
check(stderr === "", "c64re graph stats on the migrated graph: stderr empty");
const total = Number(process.hrtime.bigint() - t0) / 1e6;
check(total < 180_000, `whole gate in ${(total / 1000).toFixed(1)} s`);

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 822: ${pass} pass, ${failCount} fail.  project: ${project}`);
process.exit(failCount ? 1 : 0);
