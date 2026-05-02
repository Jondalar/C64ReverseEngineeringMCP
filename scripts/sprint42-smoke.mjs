// Spec 049 (Sprint 42) — phase-gate smoke. Tests the
// phaseGatedHandler wrapper in isolation against a fixture project.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";
import { phaseGatedHandler } from "../dist/server-tools/phase-gate-handler.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint42-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Phase Gate Smoke", description: "" });

  // Register a phase-3 artifact
  writeFileSync(join(root, "x.prg"), Buffer.alloc(64));
  const a = service.saveArtifact({
    kind: "prg",
    scope: "input",
    title: "x.prg",
    path: "x.prg",
  });
  service.advanceArtifactPhase(a.id, 2);
  service.advanceArtifactPhase(a.id, 3);

  // Mock inner handler
  let innerCalls = 0;
  const inner = async () => {
    innerCalls += 1;
    return { content: [{ type: "text", text: "ok" }] };
  };

  const ctx = { projectDir: () => root };
  const wrapped = phaseGatedHandler("save_finding", ctx, inner);

  // Without gate enabled → fall through allow
  let r = await wrapped({ artifact_id: a.id });
  assert.equal(innerCalls, 1, "no gate flag → allow");

  // Enable gate
  service.saveProjectProfile({ phaseGateStrict: true });

  // save_finding is phase-5 tool against a phase-3 artifact (skip > 1) → refuse
  r = await wrapped({ artifact_id: a.id });
  const text = r.content[0].text;
  assert.match(text, /Phase Gate Refused/, "refused output present");
  assert.match(text, /save_finding/);
  assert.match(text, /agent_advance_phase/);
  assert.equal(innerCalls, 1, "inner not called when refused");

  // Tool that is allowed (analyze_prg = phase 3 ↔ artifact phase 3) → allow
  const wrappedAnalyze = phaseGatedHandler("analyze_prg", ctx, inner);
  await wrappedAnalyze({ artifact_id: a.id });
  assert.equal(innerCalls, 2, "phase-allowed tool → inner runs");

  // No artifact context → fall through allow
  await wrapped({});
  assert.equal(innerCalls, 3, "no artifact resolved → allow");

  console.log("sprint 42 smoke test passed");
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
