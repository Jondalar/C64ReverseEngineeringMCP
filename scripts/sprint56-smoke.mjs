// Spec 061 / UX3 — bulk re-evaluate via task queue smoke.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint56-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "UX3 Smoke", description: "" });

  // ---- TaskRecord.agentKind round-trips ----
  const task = service.saveTask({
    kind: "bulk-revaluate",
    title: "Re-evaluate 5 questions",
    description: "phase 2 work",
    status: "open",
    priority: "medium",
    questionIds: ["q1", "q2", "q3", "q4", "q5"],
    artifactIds: ["art-a"],
    agentKind: "automation",
  });
  assert.equal(task.agentKind, "automation");
  assert.equal(task.status, "open");
  assert.equal(task.kind, "bulk-revaluate");

  // ---- listTasks surfaces it ----
  const all = service.listTasks();
  const found = all.find((t) => t.id === task.id);
  assert.ok(found);
  assert.equal(found.agentKind, "automation");

  // ---- agentKind defaults to undefined for legacy ----
  const human = service.saveTask({
    kind: "bug-fix",
    title: "Investigate $1234",
  });
  assert.equal(human.agentKind, undefined);

  console.log("Sprint 56 smoke (TaskRecord.agentKind + bulk-revaluate task) OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
