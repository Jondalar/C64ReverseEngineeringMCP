// Bug 32 — noise matcher 3-fix cluster smoke.
// (a) range-form parser, (b) segment-confirmation coverage,
// (c) per-artifact strict intersect.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint54-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Bug 32 Smoke", description: "" });

  // Two source PRGs (different artifacts) with overlapping address ranges.
  const prgA = join(root, "a.prg");
  const prgB = join(root, "b.prg");
  writeFileSync(prgA, Buffer.from([0xa1, 0xa1, 0xa1, 0xa1]));
  writeFileSync(prgB, Buffer.from([0xb2, 0xb2, 0xb2, 0xb2]));
  const artA = service.saveArtifact({
    kind: "prg", scope: "input", title: "A", path: prgA, role: "analysis-target",
  });
  const artB = service.saveArtifact({
    kind: "prg", scope: "input", title: "B", path: prgB, role: "analysis-target",
  });

  // Analysis JSONs with confirmed/rejected segments. Both at the same
  // address range to test per-artifact strict intersect (c).
  const analysisADir = join(root, "analysis", "a");
  const analysisBDir = join(root, "analysis", "b");
  mkdirSync(analysisADir, { recursive: true });
  mkdirSync(analysisBDir, { recursive: true });
  const analysisAPath = join(analysisADir, "a_analysis.json");
  const analysisBPath = join(analysisBDir, "b_analysis.json");
  writeFileSync(analysisAPath, JSON.stringify({
    segments: [
      { start: 0x5000, end: 0x58fe, kind: "sprite", confirmed: true },
    ],
  }, null, 2));
  writeFileSync(analysisBPath, JSON.stringify({
    segments: [
      { start: 0x5000, end: 0x58fe, kind: "unknown" },
      // No confirmed/rejected → not coverage.
    ],
  }, null, 2));
  service.saveArtifact({
    kind: "other", scope: "analysis", title: "A analysis", path: analysisAPath,
    format: "json", role: "analysis-json", sourceArtifactIds: [artA.id],
  });
  service.saveArtifact({
    kind: "other", scope: "analysis", title: "B analysis", path: analysisBPath,
    format: "json", role: "analysis-json", sourceArtifactIds: [artB.id],
  });

  // ---- Test (a): range-form question parses both ends ----
  // Static-analysis question covering full sprite bank range, linked to A.
  const qFull = service.saveOpenQuestion({
    kind: "validation",
    title: "Unknown 2303-byte block at $5000-$58FE",
    source: "static-analysis",
    addressRange: { start: 0x5000, end: 0x58fe },
    artifactIds: [artA.id],
  });
  // Static-analysis question covering same range but linked to B.
  const qB = service.saveOpenQuestion({
    kind: "validation",
    title: "Unknown 2303-byte block at $5000-$58FE",
    source: "static-analysis",
    addressRange: { start: 0x5000, end: 0x58fe },
    artifactIds: [artB.id],
  });
  // Question with NO addressRange but range-form title.
  const qByTitle = service.saveOpenQuestion({
    kind: "validation",
    title: "Unknown 256-byte block at $5100-$51FF",
    source: "static-analysis",
    artifactIds: [artA.id],
  });

  // Run sweep — A's question should close (segment-confirmed coverage),
  // B's question should remain open (segment uncovered for B),
  // qByTitle should close (range parsed from title).
  const result = service.archivePhase1Noise({});
  assert.equal(result.questionsAnswered, 2, `expected 2 questions answered (qFull + qByTitle); got ${result.questionsAnswered}`);

  const qFullAfter = service.listOpenQuestions().find((q) => q.id === qFull.id);
  const qBAfter = service.listOpenQuestions().find((q) => q.id === qB.id);
  const qByTitleAfter = service.listOpenQuestions().find((q) => q.id === qByTitle.id);
  assert.equal(qFullAfter.status, "answered", "A-linked question must close");
  assert.equal(qBAfter.status, "open", "B-linked question must remain open (no coverage)");
  assert.equal(qByTitleAfter.status, "answered", "title-range question must close");

  // ---- Test (b): segment-rejected also counts as coverage ----
  // Add a rejected segment and a question pointing at it (different range).
  writeFileSync(analysisAPath, JSON.stringify({
    segments: [
      { start: 0x5000, end: 0x58fe, kind: "sprite", confirmed: true },
      { start: 0x7000, end: 0x78ef, kind: "charset", rejected: true },
    ],
  }, null, 2));
  const qRejected = service.saveOpenQuestion({
    kind: "validation",
    title: "Unknown 1264-byte block at $7000-$78EF",
    source: "static-analysis",
    addressRange: { start: 0x7000, end: 0x78ef },
    artifactIds: [artA.id],
  });
  const r2 = service.archivePhase1Noise({});
  assert.equal(r2.questionsAnswered, 1, `expected rejected segment to close 1 question; got ${r2.questionsAnswered}`);
  const qRejAfter = service.listOpenQuestions().find((q) => q.id === qRejected.id);
  assert.equal(qRejAfter.status, "answered");
  assert.match(qRejAfter.answerSummary ?? "", /segment-rejected/);

  // ---- Test (c): per-artifact scope opt narrows sweep ----
  const qScopedB = service.saveOpenQuestion({
    kind: "validation",
    title: "Unknown 256-byte block at $5300-$53FF",
    source: "static-analysis",
    addressRange: { start: 0x5300, end: 0x53ff },
    artifactIds: [artA.id],
  });
  // Run scoped to B — should NOT touch A-linked question.
  const r3 = service.archivePhase1Noise({ artifactId: artB.id });
  assert.equal(r3.questionsAnswered, 0, "artifact-scope to B must skip A-linked question");
  const qScopedBAfter = service.listOpenQuestions().find((q) => q.id === qScopedB.id);
  assert.equal(qScopedBAfter.status, "open", "scoped-out question untouched");

  // Run scoped to A — should close it now.
  const r4 = service.archivePhase1Noise({ artifactId: artA.id });
  assert.equal(r4.questionsAnswered, 1);

  console.log("Sprint 54 smoke (Bug 32 noise matcher 3-fix) OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
