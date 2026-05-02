// Spec 053 (Sprint 46) — Bug 20 phase-1 noise archive smoke.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint46-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Bug 20 Smoke", description: "" });

  // 3 hypothesis findings + 2 questions in $1000-$1FFF range
  const h1 = service.saveFinding({ kind: "hypothesis", title: "RAM region $1010 behaves like flag", confidence: 0.4, addressRange: { start: 0x1010, end: 0x1010 } });
  const h2 = service.saveFinding({ kind: "hypothesis", title: "RAM region $10A0 behaves like counter", confidence: 0.4, addressRange: { start: 0x10a0, end: 0x10a0 } });
  const h3 = service.saveFinding({ kind: "hypothesis", title: "RAM region $2000 behaves like pointer", confidence: 0.4, addressRange: { start: 0x2000, end: 0x2000 } });

  const q1 = service.saveOpenQuestion({ kind: "validation", title: "Validate: RAM region $1010 behaves like flag", source: "heuristic-phase1" });
  const q2 = service.saveOpenQuestion({ kind: "validation", title: "Validate: RAM region $2000 behaves like pointer", source: "heuristic-phase1" });

  // Routine annotation finding covering $1000-$10FF
  const routine = service.saveFinding({
    kind: "classification",
    title: "screen_clear routine $1000-$10FF",
    confidence: 0.95,
    addressRange: { start: 0x1000, end: 0x10ff },
    tags: ["routine", "annotation"],
  });

  // Dry-run preview
  const preview = service.archivePhase1Noise({ dryRun: true });
  assert.equal(preview.findingsArchived, 2, "2 of 3 hypotheses inside routine range");
  assert.equal(preview.preview[0].supersededBy, routine.id);

  // Apply
  const applied = service.archivePhase1Noise({ dryRun: false });
  assert.equal(applied.findingsArchived, 2);
  assert.equal(applied.questionsAnswered, 1, "1 of 2 questions inside routine range");

  // Verify state
  const findings = service.listFindings();
  const h1After = findings.find((f) => f.id === h1.id);
  assert.equal(h1After.status, "archived");
  assert.equal(h1After.archivedBy, routine.id);
  const h3After = findings.find((f) => f.id === h3.id);
  assert.notEqual(h3After.status, "archived", "h3 outside range stays active");

  const questions = service.listOpenQuestions();
  const q1After = questions.find((q) => q.id === q1.id);
  assert.equal(q1After.status, "answered");
  assert.equal(q1After.answeredByFindingId, routine.id);
  const q2After = questions.find((q) => q.id === q2.id);
  assert.equal(q2After.status, "open", "q2 outside range stays open");

  // mark_segment_confirmed creates a confirmation finding
  writeFileSync(join(root, "x.prg"), Buffer.alloc(64));
  const a = service.saveArtifact({ kind: "prg", scope: "input", title: "x.prg", path: "x.prg" });
  const conf = service.markSegmentConfirmed({
    artifactId: a.id,
    address: 0x5000,
    length: 0x900,
    kind: "sprite",
  });
  assert.ok(conf);
  assert.ok(conf.findingId);
  // No analysis JSON registered → segmentMatched is false but finding still saved
  assert.equal(conf.segmentMatched, false);

  console.log("sprint 46 smoke test passed");
  console.log(root);
} catch (error) {
  console.error("smoke test FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (process.exitCode === 0 || !process.exitCode) {
    rmSync(root, { recursive: true, force: true });
  }
}
