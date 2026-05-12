import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";
import { runSetup } from "../dist/setup-cli.js";
import { requiredPhasesFor, visiblePhasesFor } from "../dist/agent-orchestrator/workflows.js";
import { nextStepError } from "../dist/server-tools/error-helpers.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint39-smoke-"));

try {
  // Spec 046: workflow templates required-phase math
  assert.deepEqual(requiredPhasesFor("bugfix", "analyst"), [1, 5, 7]);
  assert.deepEqual(requiredPhasesFor("targeted-routine", "analyst"), [3, 4, 5]);
  assert.deepEqual(requiredPhasesFor("cracker-only", "cracker", "asset"), [1, 2, 3]);
  assert.deepEqual(requiredPhasesFor("cracker-only", "cracker", "loader"), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...visiblePhasesFor("bugfix")].sort(), [1, 5, 7]);
  assert.equal(visiblePhasesFor(undefined).size, 7);

  // Spec 044: setup writes CLAUDE.md marker block
  await runSetup(["claude", "--project", root]);
  const claudePath = join(root, "CLAUDE.md");
  assert.ok(existsSync(claudePath), "CLAUDE.md created");
  const text = readFileSync(claudePath, "utf8");
  assert.match(text, /c64re-setup-start/);
  assert.match(text, /c64re_whats_next/);

  // Idempotent: re-run leaves the same content
  const before = readFileSync(claudePath, "utf8");
  await runSetup(["claude", "--project", root]);
  const after = readFileSync(claudePath, "utf8");
  assert.equal(after, before, "setup is idempotent");

  // Spec 046: start_re_workflow via service
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "WF Smoke", description: "" });
  const profile = service.saveProjectProfile({ workflow: "bugfix" });
  assert.equal(profile.workflow, "bugfix");

  // Spec 045: nextStepError shape
  const err = nextStepError("test_tool", "something missing", "do_this()");
  const errText = err.content[0].text;
  assert.match(errText, /Recommended next action: do_this\(\)/);
  assert.match(errText, /test_tool/);

  console.log("sprint 39 smoke test passed");
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
