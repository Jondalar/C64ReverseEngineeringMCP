import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint37-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Sprint 37 Smoke", description: "" });

  // Spec 037: payload disk hint
  const payload = service.saveEntity({
    kind: "payload",
    name: "T1S0 buffer",
    payloadFormat: "raw",
  });
  const tagged = service.setPayloadDiskHint(payload.id, "drive-code");
  assert.equal(tagged?.payloadDiskHint, "drive-code");
  const cleared = service.setPayloadDiskHint(payload.id, undefined);
  assert.equal(cleared?.payloadDiskHint, undefined);

  // Spec 041: relevance
  mkdirSync(join(root, "input/prg"), { recursive: true });
  writeFileSync(join(root, "input/prg/loader.prg"), Buffer.alloc(64));
  const a1 = service.saveArtifact({
    kind: "prg",
    scope: "input",
    title: "loader.prg",
    path: "input/prg/loader.prg",
  });
  const taggedArt = service.setArtifactRelevance(a1.id, "loader");
  assert.equal(taggedArt?.relevance, "loader");

  // Auto-tag proposes for matching titles
  writeFileSync(join(root, "input/prg/sprite_data.prg"), Buffer.alloc(64));
  service.saveArtifact({ kind: "prg", scope: "input", title: "sprite_data.prg", path: "input/prg/sprite_data.prg" });
  const proposals = service.proposeArtifactRelevance();
  const sprite = proposals.find((p) => p.title === "sprite_data.prg");
  assert.equal(sprite?.proposed, "asset");

  // Spec 040: quality metrics from synthetic analysis JSON
  const analysisPath = join(root, "input/prg/loader_analysis.json");
  writeFileSync(analysisPath, JSON.stringify({
    segments: [
      { kind: "code", start: 0x0801, end: 0x0900, score: { confidence: 0.95 } },
      { kind: "data", start: 0x0901, end: 0x0a00, score: { confidence: 0.7 } },
      { kind: "unknown", start: 0x0a01, end: 0x0b00, score: { confidence: 0.2 } },
    ],
  }));
  const metrics = service.computeQualityMetrics(analysisPath);
  assert.ok(metrics, "metrics computed");
  assert.equal(metrics.bytesByKind.code, 0x100);
  assert.ok(metrics.avgConfidence > 0.6 && metrics.avgConfidence < 0.7, "avg confidence around 0.62");
  assert.equal(metrics.largeUnknownCount, 1, "1 unknown >16 bytes");

  console.log("sprint 37 smoke test passed");
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
