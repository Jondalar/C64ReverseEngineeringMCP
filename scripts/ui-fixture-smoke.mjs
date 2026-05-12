#!/usr/bin/env node
// Verify the UI smoke fixture bootstraps cleanly and produces expected
// counts. Spawns scripts/bootstrap-ui-fixture.mjs as a child process so
// the smoke also exercises the script entry point.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";
import { auditProject } from "../dist/project-knowledge/audit.js";

const FIXTURE = resolve("fixtures/ui-smoke-project");

const result = spawnSync(process.execPath, ["scripts/bootstrap-ui-fixture.mjs", FIXTURE], { encoding: "utf8" });
if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  throw new Error(`bootstrap exited with ${result.status}`);
}

assert.equal(existsSync(resolve(FIXTURE, "knowledge", "project.json")), true);
assert.equal(existsSync(resolve(FIXTURE, "views", "project-dashboard.json")), true);
assert.equal(existsSync(resolve(FIXTURE, "artifacts", "generated", "sample_disasm.asm")), true);

const service = new ProjectKnowledgeService(FIXTURE);
const status = service.getProjectStatus();
assert.equal(status.counts.entities >= 1, true, `entities=${status.counts.entities}`);
assert.equal(status.counts.openQuestions >= 5, true, `openQuestions=${status.counts.openQuestions}`);
assert.equal(status.counts.tasks >= 1, true, `tasks=${status.counts.tasks}`);
assert.equal(status.counts.checkpoints >= 1, true, `checkpoints=${status.counts.checkpoints}`);

const audit = auditProject(FIXTURE, { includeFileScan: true });
assert.notEqual(audit.severity, "high", `audit severity=${audit.severity}\n${JSON.stringify(audit.findings, null, 2)}`);
assert.equal(audit.counts.nestedKnowledgeStores, 0);
assert.equal(audit.counts.brokenArtifactPaths, 0);
assert.equal(audit.counts.missingArtifacts, 0);

console.log("ui-fixture smoke passed");
console.log("counts:", status.counts);
console.log("audit severity:", audit.severity);
