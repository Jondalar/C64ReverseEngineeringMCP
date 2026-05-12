// Spec 052 (Sprint 45) — auto-resolution smoke for Pfade A + B + C.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint45-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Q-Resolve Smoke", description: "" });

  // Setup: 1 entity, 1 high-confidence finding, 1 auto-resolvable
  // question pointing at that entity.
  const e = service.saveEntity({ kind: "routine", name: "screen_clear" });

  const q1 = service.saveOpenQuestion({
    kind: "classification",
    title: "Is $1000 routine a screen clear?",
    description: "Loops 1000 times writing $20 — likely screen clear.",
    autoResolvable: true,
    entityIds: [e.id],
    confidence: 0.5,
    source: "static-analysis",
  });
  assert.equal(q1.status, "open");

  // Pfad A: high-confidence finding -> auto-close
  const f = service.saveFinding({
    kind: "classification",
    title: "screen_clear identified at $1000",
    summary: "STA $0400-$07E7 with index Y",
    confidence: 0.9,
    entityIds: [e.id],
  });
  const q1After = service.listOpenQuestions().find((q) => q.id === q1.id);
  assert.equal(q1After.status, "answered", "high-confidence finding auto-closed Pfad A question");
  assert.equal(q1After.answeredByFindingId, f.id);

  // Low-confidence finding → resolution-pending
  const e2 = service.saveEntity({ kind: "routine", name: "loop_a" });
  const q2 = service.saveOpenQuestion({
    kind: "classification",
    title: "Loop at $2000 — what?",
    autoResolvable: true,
    entityIds: [e2.id],
  });
  const f2 = service.saveFinding({
    kind: "observation",
    title: "Loop spotted",
    confidence: 0.5,
    entityIds: [e2.id],
  });
  const q2After = service.listOpenQuestions().find((q) => q.id === q2.id);
  assert.equal(q2After.status, "resolution-pending", "low-confidence finding → pending");
  assert.match(q2After.answerSummary, /Proposed/);

  // Confirm flow: accept → answered, reject → open
  const accepted = service.confirmQuestionResolution(q2.id, true);
  assert.equal(accepted.status, "answered");
  // Restore for reject test
  service.saveOpenQuestion({ id: q2.id, kind: q2.kind, title: q2.title, status: "resolution-pending" });
  const rejected = service.confirmQuestionResolution(q2.id, false);
  assert.equal(rejected.status, "open");
  assert.match(rejected.answerSummary ?? "", /rejected/);

  // Pfad B: phase-reached
  writeFileSync(join(root, "x.prg"), Buffer.alloc(64));
  const a = service.saveArtifact({ kind: "prg", scope: "input", title: "x", path: "x.prg" });
  const q3 = service.saveOpenQuestion({
    kind: "classification",
    title: "Will be answered when phase 5 reached",
    autoResolvable: true,
    autoResolveHint: { kind: "phase-reached", artifactId: a.id, phase: 5 },
  });
  assert.equal(q3.status, "open");
  // Advance to phase 5 (with evidence since we skip 1->5)
  service.advanceArtifactPhase(a.id, 5, "ok");
  const q3After = service.listOpenQuestions().find((q) => q.id === q3.id);
  assert.equal(q3After.status, "answered", "phase-reached resolved Pfad B question");

  // Pfad C: annotation-applied
  const q4 = service.saveOpenQuestion({
    kind: "classification",
    title: "Resolved when annotations cover $1234",
    autoResolvable: true,
    autoResolveHint: { kind: "annotation-applied", artifactId: a.id, address: 0x1234 },
  });
  service.resolveQuestionsForAnnotation(a.id, [0x1234]);
  const q4After = service.listOpenQuestions().find((q) => q.id === q4.id);
  assert.equal(q4After.status, "answered");

  // propose API returns sensible candidates
  const proposals = service.proposeQuestionResolutions();
  assert.ok(Array.isArray(proposals));

  // Sweep is idempotent
  const sweep1 = service.sweepQuestionResolutions();
  const sweep2 = service.sweepQuestionResolutions();
  assert.equal(sweep2.autoResolved, 0, "second sweep makes no new changes");
  void sweep1;

  console.log("sprint 45 smoke test passed");
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
