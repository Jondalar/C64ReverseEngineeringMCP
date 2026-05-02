import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint38-smoke-"));

try {
  // Synthetic analysis JSON with one pointer table, one large unknown,
  // one petscii_text, and frequent call target.
  const analysisPath = join(root, "sample_analysis.json");
  writeFileSync(analysisPath, JSON.stringify({
    segments: [
      { kind: "code", start: 0x0801, end: 0x09ff, score: { confidence: 0.9 } },
      { kind: "pointer_table", start: 0x0a00, end: 0x0a3f, score: { confidence: 0.85 } },
      { kind: "petscii_text", start: 0x0a40, end: 0x0a8f, score: { confidence: 0.7 } },
      { kind: "unknown", start: 0x0a90, end: 0x0bff, score: { confidence: 0.2 } },
    ],
    crossReferences: [
      { source: 0x0810, target: 0x0900, kind: "call" },
      { source: 0x0820, target: 0x0900, kind: "call" },
      { source: 0x0830, target: 0x0900, kind: "call" },
      { source: 0x0840, target: 0x0950, kind: "call" },
    ],
  }));

  const draftPath = join(root, "sample_annotations.draft.json");
  // import the propose-annotations API directly
  const { proposeAnnotations } = await import("../dist/pipeline/analysis/annotators/index.cjs");
  const draft = proposeAnnotations({ analysisJsonPath: analysisPath, outputPath: draftPath });

  assert.ok(existsSync(draftPath), "draft file written");
  assert.ok(draft.segments.some((s) => s.kind === "pointer_table"), "pointer table segment promoted");
  assert.ok(draft.segments.some((s) => s.kind === "petscii_text"), "text segment promoted");
  const routine = draft.routines.find((r) => r.address === "0900");
  assert.ok(routine, "frequent call target became a routine candidate");
  assert.equal(routine.confidence > 0.6, true);
  // 0x0a90..0x0bff = 368 bytes unknown — generates an open question
  assert.ok(draft.openQuestions.length >= 1, "large unknown produced an open question");
  assert.equal(draft.buckets.high + draft.buckets.medium + draft.buckets.low > 0, true);

  // Re-run leaves manual annotations.json untouched (none exists here, so just ensure draft overwrite is safe)
  const before = readFileSync(draftPath, "utf8");
  proposeAnnotations({ analysisJsonPath: analysisPath, outputPath: draftPath });
  const after = readFileSync(draftPath, "utf8");
  // generatedAt differs by timestamp so files differ but length within 200 bytes
  assert.ok(Math.abs(before.length - after.length) < 200, "re-run produces similar-shaped draft");

  console.log("sprint 38 smoke test passed");
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
