#!/usr/bin/env node
// The 822.2 cut-over has to leave a project with STRUCTURE, not just prose.
//
// Measured on a peer project (Wasteland_2, 2026-09-21): `graph_edges` answered
// nothing for 24 of its 25 owners. Every one of them had the cut-over's rows —
// segments, entry points, the human labels out of the annotation files — and not
// one control-flow edge. The listing said `jmp $09B8  // area_record_subptr` in
// plain text and the graph had no JUMPS_TO for it and no `addr:09b8` node at all.
// The one owner that DID answer was the one artifact the session had re-analysed
// after the cut, because `seedControlFlowForArtifact()` has exactly one caller —
// `importAnalysisArtifact()`. `cutover.ts` never ran the producers at all.
//
// So: a project whose `_analysis.json` files are already on disk, cut over the
// way `agent_onboard` cuts one over, must come out with 819 control flow and 820
// memory access under every owner those files name. And it must do that on a
// budget, because a cut-over is the FIRST thing a session does and a project with
// twenty analyses must not turn that into a two-minute stall.
//
// Hermetic: a temp project, a synthetic PRG through the real bundled pipeline, the
// legacy JSON stores written by hand. No fixture repo, no ROMs, no runtime.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:822-cutover-seed

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { GraphStore } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));
const { ProjectKnowledgeService } = await import(join(ROOT, "dist/project-knowledge/service.js"));

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const info = (msg) => console.log(`  info  ${msg}`);
const head = (n, title) => console.log(`\n── ${n}. ${title}`);

const SLUG = "s060";
const dirs = [];

/**
 * A project in exactly the shape `agent_onboard` finds one in before the cut:
 * the five legacy JSON stores live in knowledge/, the graph does not exist yet,
 * and the analyses are already on disk from an earlier session.
 */
function legacyProject(label, owners) {
  const dir = mkdtempSync(join(tmpdir(), `c64re-822seed-${label}-`));
  dirs.push(dir);
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  mkdirSync(join(dir, "session"), { recursive: true });
  mkdirSync(join(dir, "analysis"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({
    schemaVersion: 1, id: "project-060", name: "cut-over seed gate", slug: SLUG, rootPath: dir, status: "active",
  }, null, 2));
  // The five stores the cut-over folds in. Small but real: one hand entity with an
  // address, so the human layer has something to lose if the seed misbehaves.
  const store = (items) => JSON.stringify({ schemaVersion: 1, items }, null, 2);
  writeFileSync(join(dir, "knowledge", "entities.json"), store([{
    id: "entity-hand-1", kind: "routine", name: "hand_named_entry", summary: "named by hand before the cut",
    addressRange: { start: 0x1000, end: 0x1010 }, artifactIds: [], tags: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }]));
  writeFileSync(join(dir, "knowledge", "findings.json"), store([{
    id: "finding-hand-1", kind: "observation", title: "the entry writes $D011", summary: "read off the listing",
    tags: [], evidence: [], status: "open", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }]));
  writeFileSync(join(dir, "knowledge", "relations.json"), store([]));
  writeFileSync(join(dir, "knowledge", "open-questions.json"), store([]));
  writeFileSync(join(dir, "knowledge", "labels.user.json"), store([]));

  for (const owner of owners) writeAnalysis(dir, owner);
  return dir;
}

/**
 * The 819 fixture image, one per owner, through the real pipeline:
 *   $1000 entry:  jsr $1020 ; jsr $FFD2 ; ldx #3 ; loop: dex ; bne loop ; sta $D011 ; jmp $1040
 *   $1020 sub:    lda #1 ; rts
 *   $1040 tail:   jsr $3000 (OUTSIDE the image) ; rts
 * so the graph owes us CALLS, CALLS_ROM, BRANCHES_TO, JUMPS_TO and an ownerless
 * `addr:3000` — the whole shape the peer's project was missing.
 */
function writeAnalysis(dir, owner) {
  const image = new Uint8Array(0x1100).fill(0xea);
  const put = (addr, bytes) => image.set(bytes, addr - 0x1000);
  put(0x1000, [0x20, 0x20, 0x10, 0x20, 0xd2, 0xff, 0xa2, 0x03, 0xca, 0xd0, 0xfd, 0x8d, 0x11, 0xd0, 0x4c, 0x40, 0x10]);
  put(0x1020, [0xa9, 0x01, 0x60]);
  put(0x1040, [0x20, 0x00, 0x30, 0x60]);
  const prg = new Uint8Array(image.length + 2);
  prg[0] = 0x00; prg[1] = 0x10; prg.set(image, 2);
  const prgPath = join(dir, "analysis", `${owner}.prg`);
  const analysisPath = join(dir, "analysis", `${owner}_analysis.json`);
  writeFileSync(prgPath, prg);
  execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prgPath, analysisPath, "1000"],
    { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: dir } });
  return analysisPath;
}

const counts = (dir) => {
  const s = GraphStore.open(dir, { readOnly: true });
  try {
    const n = (sql, ...p) => Number(s.db.prepare(sql).get(...p).n);
    return {
      edges819: n("SELECT COUNT(*) AS n FROM edges WHERE producer = '819'"),
      edges820: n("SELECT COUNT(*) AS n FROM edges WHERE producer = '820'"),
      owners819: n("SELECT COUNT(DISTINCT owner) AS n FROM edges WHERE producer = '819'"),
      jumps: n("SELECT COUNT(*) AS n FROM edges WHERE type = 'JUMPS_TO'"),
      addrNodes: n("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'addr'"),
      human: n("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'human'"),
      migrations: n("SELECT COUNT(*) AS n FROM migration_runs WHERE dry_run = 0"),
    };
  } finally { s.close(); }
};

// ─────────────────────────────────────── 1. one owner: the cut-over builds structure

{
  head(1, "opening a legacy project cuts it over AND seeds the producers");
  const dir = legacyProject("one", ["fixture"]);
  const t0 = process.hrtime.bigint();
  new ProjectKnowledgeService(dir);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  check(existsSync(join(dir, "knowledge", "_legacy-822", "entities.json")), "the legacy stores moved under knowledge/_legacy-822/");
  const c = counts(dir);
  info(`after the cut-over (${ms.toFixed(0)} ms): ${JSON.stringify(c)}`);

  check(c.edges819 > 0, `the graph holds 819 control-flow edges (${c.edges819})`);
  check(c.edges820 > 0, `the graph holds 820 memory-access edges (${c.edges820})`);
  check(c.jumps > 0, `JUMPS_TO exists — the edge the peer's \`jmp $09B8\` never produced (${c.jumps})`);
  check(c.human > 0, `the human layer the migration wrote is still there (${c.human} rows)`);

  const g = Graph.open(dir);
  try {
    const entry = `${SLUG}:ram/fixture:routine:1000`;
    const callees = g.callees(entry);
    check(callees.some((e) => e.type === "CALLS" && e.to === `${SLUG}:ram/fixture:routine:1020`),
      "graph_edges answers for the entry: CALLS $1000 → $1020");
    check(callees.some((e) => e.type === "CALLS_ROM" && e.to === "c64:rom:ffd2"),
      "CALLS_ROM → c64:rom:ffd2 (the platform join works after a cut-over too)");
    const jmp = g.edgesOutOf(entry).find((e) => e.type === "JUMPS_TO");
    check(Boolean(jmp) && jmp.to.endsWith(":1040"), `JUMPS_TO → …:1040 (${jmp?.to})`);
    const outside = g.resolve(`${SLUG}:ram:addr:3000`);
    check(!outside.dangling && outside.kind === "addr",
      "the ownerless addr node for the out-of-image target exists (the peer had none at all)");
    // 826.0 T2 and 826 ran too — a seed that stops after 819 is half a structure.
    const s = GraphStore.open(dir, { readOnly: true });
    const sig = Number(s.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type = 'SIGNATURE'").get().n);
    s.close();
    check(sig > 0, `826 signatures ran in the same pass (${sig})`);
  } finally { g.close(); }
}

// ─────────────────────────────────────── 2. every owner, not just the last one

{
  head(2, "every analysis on disk is seeded, not one of them");
  const owners = ["alpha", "beta", "gamma"];
  const dir = legacyProject("many", owners);
  new ProjectKnowledgeService(dir);
  const c = counts(dir);
  info(`three owners: ${JSON.stringify(c)}`);
  check(c.owners819 === owners.length,
    `819 edges exist under all ${owners.length} owners (${c.owners819})`);
  const s = GraphStore.open(dir, { readOnly: true });
  const seen = s.db.prepare("SELECT DISTINCT owner FROM edges WHERE producer = '819' ORDER BY owner").all().map((r) => r.owner);
  s.close();
  check(owners.every((o) => seen.includes(o)), `owners seeded: ${seen.join(", ")}`);
}

// ─────────────────────────────────────── 3. idempotent, and the second open is cheap

{
  head(3, "a second open re-runs neither the migration nor the seed");
  const dir = legacyProject("again", ["fixture"]);
  new ProjectKnowledgeService(dir);
  const before = counts(dir);
  const s1 = GraphStore.open(dir, { readOnly: true });
  const dumpA = s1.canonicalDump("generated");
  s1.close();

  const t0 = process.hrtime.bigint();
  new ProjectKnowledgeService(dir);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const after = counts(dir);
  const s2 = GraphStore.open(dir, { readOnly: true });
  const dumpB = s2.canonicalDump("generated");
  s2.close();
  check(after.migrations === before.migrations, `no second migration run (${after.migrations})`);
  check(dumpA === dumpB, `the generated dump is byte-identical after a second open (${dumpA.length} bytes, ${ms.toFixed(0)} ms)`);
  check(ms < 2000, `and the second open costs ${ms.toFixed(0)} ms — the seed does not run again`);
}

// ─────────────────────────────────────── 4. the budget: a cut-over is never the stall

{
  head(4, "the seed runs on a budget and says what it did not reach");
  const owners = ["alpha", "beta", "gamma"];
  const dir = legacyProject("budget", owners);
  // A budget of one file: the cut-over must still complete, the graph must still
  // be usable, and the project must be TOLD what is left and how to finish it.
  process.env.C64RE_CUTOVER_SEED_MAX_FILES = "1";
  try {
    new ProjectKnowledgeService(dir);
  } finally {
    delete process.env.C64RE_CUTOVER_SEED_MAX_FILES;
  }
  const c = counts(dir);
  info(`with the budget capped at one file: ${JSON.stringify(c)}`);
  check(existsSync(join(dir, "knowledge", "_legacy-822", "entities.json")), "the cut-over itself still completed");
  check(c.owners819 === 1, `exactly one owner was seeded under the cap (${c.owners819})`);
  const timeline = readFileSync(join(dir, "session", "timeline.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const note = timeline.find((e) => /cut-over/i.test(e.title ?? ""));
  check(Boolean(note) && /c64re graph seed/.test(JSON.stringify(note)),
    "the timeline note names `c64re graph seed` as the way to finish the rest");
}

// ─────────────────────────────────────── 5. a broken analysis does not break the cut-over

{
  head(5, "a producer that throws leaves the cut-over that already happened alone");
  const dir = legacyProject("broken", ["fixture"]);
  writeFileSync(join(dir, "analysis", "corrupt_analysis.json"), "{ this is not json");
  let threw;
  try { new ProjectKnowledgeService(dir); } catch (e) { threw = e; }
  check(threw === undefined, `opening the project did not throw (${threw?.message?.slice(0, 80) ?? "clean"})`);
  check(existsSync(join(dir, "knowledge", "_legacy-822", "entities.json")), "the legacy stores still moved");
  const c = counts(dir);
  check(c.edges819 > 0, `and the analysis that IS readable was still seeded (${c.edges819} edges)`);
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
console.log(`\n${failCount ? "RED" : "GREEN"}  cut-over seed: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
