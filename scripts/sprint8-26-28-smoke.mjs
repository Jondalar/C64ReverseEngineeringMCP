import { mkdtempSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint-8-26-28-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "8/26/28 Smoke", description: "" });

  // Bug 18 fix smoke: AddressRange accepts > 0xffff
  const e = service.saveEntity({
    kind: "code-segment",
    name: "cart-bank-entity",
    addressRange: { start: 0x12000, end: 0x12fff, bank: 9 },
  });
  assert.equal(e.addressRange?.start, 0x12000);

  // Sprint 26: scenarios
  const s = service.saveRuntimeScenario({
    title: "Story 2 robots",
    target: { kind: "disk", artifactId: "art-1" },
    startMedia: [],
    breakpoints: [{ pc: 0x1998 }],
    stopCondition: { kind: "frame-count", value: 600 },
    expectedMilestone: "WT subentry loaded",
    tags: [],
  });
  assert.ok(s.id);
  // Two runs, diff
  const baseline = service.recordRuntimeEventSummary({
    scenarioId: s.id,
    target: { kind: "disk", artifactId: "art-1" },
    events: [
      { capturedAt: new Date().toISOString(), pc: 0x1998, fileKey: "WT", destinationStart: 0xc000, success: true },
      { capturedAt: new Date().toISOString(), pc: 0x1998, fileKey: "AM", destinationStart: 0xd000, success: true },
    ],
    hashes: { WT: "aaa", AM: "bbb" },
    reachedMilestone: true,
  });
  const candidate = service.recordRuntimeEventSummary({
    scenarioId: s.id,
    target: { kind: "disk", artifactId: "art-1" },
    events: [
      { capturedAt: new Date().toISOString(), pc: 0x1998, fileKey: "AM", destinationStart: 0xd100, success: true },
      // WT missing
      { capturedAt: new Date().toISOString(), pc: 0x1998, fileKey: "ZZ", destinationStart: 0xe000, success: true },
    ],
    hashes: { AM: "bbb-changed", ZZ: "zzz" },
    reachedMilestone: false,
  });
  const diff = service.diffRuntimeRuns(baseline.runId, candidate.runId);
  assert.ok(diff);
  assert.equal(diff.missingLoads.length, 1, "WT missing in candidate");
  assert.equal(diff.extraLoads.length, 1, "ZZ extra in candidate");
  assert.equal(diff.diffPayloadHash.length, 1, "AM hash differs");
  assert.equal(diff.diffDestination.length, 1, "AM destination differs");

  // Sprint 28: build pipeline
  const pipeline = service.saveBuildPipeline({
    title: "EF build",
    steps: [
      { id: "assemble", title: "Assemble", command: "make asm", inputArtifactIds: [], outputArtifactIds: [], sideEffects: [], evidence: [] },
      { id: "pack", title: "Pack", command: "make pack", inputArtifactIds: [], outputArtifactIds: [], sideEffects: [], evidence: [] },
    ],
    tags: [],
  });
  const run = service.startBuildRun(pipeline.id, "record");
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[0].status, "pending");
  const updated = service.recordBuildStepResult(run.id, { stepId: "assemble", status: "ok", exitCode: 0 });
  assert.equal(updated.steps[0].status, "ok");
  assert.equal(updated.status, "running");
  service.recordBuildStepResult(run.id, { stepId: "pack", status: "ok", exitCode: 0 });
  const after = service.listBuildRuns(pipeline.id)[0];
  assert.equal(after.status, "ok");

  // Sprint 28 follow-up: run_build_pipeline orchestrator
  const orchPipeline = service.saveBuildPipeline({
    title: "Echo pipeline",
    steps: [
      { id: "echo-ok", title: "Echo ok", command: "echo ok", inputArtifactIds: [], outputArtifactIds: [], sideEffects: [], evidence: [] },
      { id: "exit-zero", title: "Exit 0", command: "exit 0", inputArtifactIds: [], outputArtifactIds: [], sideEffects: [], evidence: [] },
    ],
    tags: [],
  });
  const orchRun = service.runBuildPipeline(orchPipeline.id);
  assert.equal(orchRun.status, "ok");
  assert.equal(orchRun.steps.length, 2);
  assert.equal(orchRun.steps[0].status, "ok");
  assert.equal(orchRun.steps[0].exitCode, 0);

  // Failing pipeline: stops at first failed step
  const failPipeline = service.saveBuildPipeline({
    title: "Failing pipeline",
    steps: [
      { id: "fail", title: "Fail", command: "exit 1", inputArtifactIds: [], outputArtifactIds: [], sideEffects: [], evidence: [] },
      { id: "after", title: "After", command: "echo after", inputArtifactIds: [], outputArtifactIds: [], sideEffects: [], evidence: [] },
    ],
    tags: [],
  });
  const failRun = service.runBuildPipeline(failPipeline.id);
  assert.equal(failRun.steps[0].status, "failed");
  assert.equal(failRun.steps[1].status, "pending", "stopped at first failure");

  console.log("sprint 8/26/28 smoke test passed");
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
