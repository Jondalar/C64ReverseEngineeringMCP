import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";
import { repairProject } from "../dist/project-knowledge/repair.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint36-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Sprint 36 Smoke", description: "" });

  // R6: question source defaults
  const q1 = service.saveOpenQuestion({ kind: "test", title: "Manual question", source: "human-review" });
  assert.equal(q1.source, "human-review");

  const q2 = service.saveOpenQuestion({ kind: "test", title: "Default source" });
  assert.equal(q2.source, "untagged");

  // R6: backfill repair
  const repaired = repairProject(root, { mode: "safe", operations: ["backfill-question-source"] });
  const after = service.listOpenQuestions();
  const stillUntagged = after.filter((q) => !q.source || q.source === "untagged");
  assert.equal(stillUntagged.length, 0, "backfill tagged all untagged questions");

  // R9: emitNextStepTask
  const path1 = join(root, "build/sample.asm");
  const task = service.emitNextStepTask({
    producedByTool: "analyze_prg",
    artifactIds: ["artifact-1"],
    title: "Run disasm_prg on sample",
    autoCloseHint: { kind: "file-exists", path: "build/sample.asm" },
  });
  assert.equal(task.autoSuggested, true);
  assert.equal(task.kind, "auto-suggested");

  // R9: dedup — same title same artifact = same id
  const task2 = service.emitNextStepTask({
    producedByTool: "analyze_prg",
    artifactIds: ["artifact-1"],
    title: "Run disasm_prg on sample",
    autoCloseHint: { kind: "file-exists", path: "build/sample.asm" },
  });
  assert.equal(task2.id, task.id, "dedup by title");

  // R9: cascade-suppress — different title same artifact same tool closes prior
  const task3 = service.emitNextStepTask({
    producedByTool: "analyze_prg",
    artifactIds: ["artifact-1"],
    title: "Different next step",
  });
  const taskRefreshed = service.listTasks().find((t) => t.id === task.id);
  assert.equal(taskRefreshed?.status, "done", "cascade closed prior task");

  // R9: auto-close-checker — file-exists hint becomes true
  service.emitNextStepTask({
    producedByTool: "disasm_prg",
    artifactIds: ["artifact-2"],
    title: "Write annotations",
    autoCloseHint: { kind: "file-exists", path: "annotations.json" },
  });
  writeFileSync(join(root, "annotations.json"), "{}");
  const closed = service.closeCompletedAutoTasks();
  assert.ok(closed.closed >= 1, "auto-close fired on file-exists");

  console.log("sprint 36 smoke test passed");
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
