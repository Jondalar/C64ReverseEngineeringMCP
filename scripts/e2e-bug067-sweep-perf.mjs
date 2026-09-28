#!/usr/bin/env node
// BUG-067 — the closed-loop sweep archives once, and reads once.
//
// A covered analysis-import hypothesis was re-saved through the importer per finding and
// came out still `active`, so every sweep archived the same findings again, each at the
// price of a full import run. And the question sweep re-read every question in the
// project — each read loading the whole migration ledger — once per finding.
//
//   1. a covered generated claim is archived: status, superseded_by, validation answered
//   2. a second sweep archives nothing, and neither sweep adds an import run
//   3. the human layer is untouched by the archive
//   4. a question sweep over many findings reads the questions a constant number of times
//      and never loads the whole ledger
//   5. an artifact-scoped closed loop does not run the project-wide passes, and its
//      footer counts what the project holds
//   6. the per-finding door still resolves a question it overlaps (Spec 052)
//
// Hermetic: a temp project, a synthetic analysis JSON, no media, no runtime.
// Exit 0 = pass, 1 = fail.   npm run e2e:bug067

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";
import { KnowledgeRecords } from "../dist/knowledge-graph/records.js";
import { runAndFormatClosedLoopSweep } from "../dist/server-tools/closed-loop-sweep.js";

let pass = 0;
let failCount = 0;
const check = (cond, msg) => { if (cond) { pass += 1; console.log(`  PASS  ${msg}`); } else { failCount += 1; console.log(`  FAIL  ${msg}`); } };

// Count what the sweep asks of SQLite and of the record layer.
const prepared = [];
const origPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) { prepared.push(sql); return origPrepare.call(this, sql); };
const calls = {};
const count = (proto, name, label) => {
  const orig = proto[name];
  proto[name] = function (...a) { calls[label] = (calls[label] ?? 0) + 1; return orig.apply(this, a); };
};
count(KnowledgeRecords.prototype, "listOpenQuestions", "listOpenQuestions");
count(ProjectKnowledgeService.prototype, "archivePhase1Noise", "archivePhase1Noise");
count(ProjectKnowledgeService.prototype, "sweepQuestionResolutions", "sweepQuestionResolutions");
const reset = () => { prepared.length = 0; for (const k of Object.keys(calls)) delete calls[k]; };
const wholeLedgerReads = () => prepared.filter((s) => /FROM migration_log(?!\s+WHERE\s+legacy_store\s*=)/u.test(s) && /^\s*SELECT/iu.test(s)).length;

const root = mkdtempSync(join(tmpdir(), "c64re-bug067-"));
try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "BUG-067", description: "" });
  mkdirSync(join(root, "analysis"), { recursive: true });

  // 40 RAM hypotheses at $3000.. — each becomes a generated `behaves_like` claim.
  const N = 40;
  const ramHypotheses = Array.from({ length: N }, (_, i) => ({
    start: 0x3000 + i * 4, end: 0x3000 + i * 4 + 1, kind: "table", confidence: 0.5, reasons: ["synthetic"],
  }));
  const analysisPath = join(root, "analysis", "game_analysis.json");
  writeFileSync(analysisPath, `${JSON.stringify({
    binaryName: "game.prg",
    entryPoints: [{ address: 0x3000, source: "manual", reason: "synthetic" }],
    segments: [{ kind: "code", start: 0x2000, end: 0x20ff, score: { confidence: 0.9, reasons: ["synthetic"] } }],
    codeSemantics: { ramHypotheses },
  }, null, 2)}\n`);
  const aj = service.saveArtifact({ kind: "other", scope: "analysis", title: "game analysis", path: analysisPath, role: "analysis-json", format: "json" });
  service.importAnalysisArtifact(aj.id);

  const claimIds = () => service.listFindings().filter((f) => f.id.startsWith("claim:") && f.kind === "hypothesis" && f.addressRange && f.addressRange.start >= 0x3000 && f.addressRange.end < 0x3100);
  const hyps = claimIds();
  check(hyps.length === N, `${N} generated hypothesis claims imported (got ${hyps.length})`);

  // A routine that covers them all — the closed loop's coverage.
  const routine = service.saveFinding({ kind: "classification", title: "table_walker $3000-$30FF", confidence: 0.95, addressRange: { start: 0x3000, end: 0x30ff }, tags: ["routine", "annotation"] });

  const db = () => new DatabaseSync(join(root, "knowledge", "graph.sqlite"), { readOnly: true });
  const q = (sql, ...a) => { const d = db(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  const humanBefore = JSON.stringify(q("SELECT * FROM nodes WHERE layer = 'human' ORDER BY id")) + JSON.stringify(q("SELECT id, title, body, status, attrs FROM annotations WHERE layer = 'human' ORDER BY id"));
  const runsBefore = q("SELECT COUNT(*) AS n FROM migration_runs")[0].n;

  // 1 + 2: archive once, then nothing.
  const first = service.archivePhase1Noise({});
  check(first.findingsArchived === N, `first sweep archives the ${N} covered claims (got ${first.findingsArchived})`);
  const rows = q("SELECT status, superseded_by, validation FROM claims WHERE node_id IN (SELECT id FROM nodes WHERE address BETWEEN 12288 AND 12543) AND claim = 'behaves_like' AND layer = 'generated'");
  check(rows.length === N && rows.every((r) => r.status === "archived"), `every covered claim row is status=archived (${rows.filter((r) => r.status === "archived").length}/${rows.length})`);
  check(rows.every((r) => r.superseded_by === routine.id), "superseded_by names the covering routine");
  check(rows.every((r) => r.validation === "answered"), "validation flipped to answered");
  const second = service.archivePhase1Noise({});
  check(second.findingsArchived === 0, `second sweep archives 0 (got ${second.findingsArchived})`);
  check(q("SELECT COUNT(*) AS n FROM migration_runs")[0].n === runsBefore, "no import run was minted by either sweep");

  // 3: the human layer is exactly what it was.
  const humanAfter = JSON.stringify(q("SELECT * FROM nodes WHERE layer = 'human' ORDER BY id")) + JSON.stringify(q("SELECT id, title, body, status, attrs FROM annotations WHERE layer = 'human' ORDER BY id"));
  check(humanAfter === humanBefore, "the human layer is untouched by the archive");

  // 4: the question sweep reads the questions a constant number of times.
  for (let i = 0; i < 3; i += 1) service.saveOpenQuestion({ kind: "validation", title: `Is ${i} real?`, autoResolvable: true, entityIds: [`nobody-${i}`] });
  const findingsN = service.listFindings().length;
  reset();
  service.sweepQuestionResolutions({});
  check(findingsN >= N && (calls.listOpenQuestions ?? 0) <= 2, `sweep over ${findingsN} findings read the questions ${calls.listOpenQuestions ?? 0}× (≤ 2)`);
  check(wholeLedgerReads() === 0, `no whole-ledger read during the sweep (${wholeLedgerReads()})`);
  reset();
  service.archivePhase1Noise({});
  check(wholeLedgerReads() === 0, `no whole-ledger read during the archive (${wholeLedgerReads()})`);

  // 5: the artifact-scoped closed loop runs its passes once, scoped.
  reset();
  const footer = runAndFormatClosedLoopSweep(service, { artifactId: aj.id });
  check(calls.archivePhase1Noise === 1 && calls.sweepQuestionResolutions === 1, `scoped closed loop ran each pass once (archive ${calls.archivePhase1Noise}, questions ${calls.sweepQuestionResolutions})`);
  check(new RegExp(`\\[scope=artifact:${aj.id}; project holds ${N} archived, \\d+ answered\\]`).test(footer), `footer counts what the project holds: ${footer}`);

  // 6: Spec 052 in-band resolution still works through the one-load path.
  const entity = service.saveEntity({ kind: "routine", name: "bug067_target" });
  const question = service.saveOpenQuestion({ kind: "validation", title: "What does bug067_target do?", autoResolvable: true, entityIds: [entity.id] });
  service.saveFinding({ kind: "confirmation", title: "bug067_target clears the table", confidence: 0.9, entityIds: [entity.id] });
  const after = service.listOpenQuestions().find((x) => x.id === question.id);
  check(after?.status === "answered", `an overlapping high-confidence finding answers its question (status ${after?.status})`);
} catch (error) {
  failCount += 1;
  console.log(`  FAIL  threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\ne2e:bug067 — ${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
