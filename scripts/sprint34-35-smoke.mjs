import { mkdtempSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";
import { buildWorkerPrompt, isToolAllowedInPhase, phaseForTool } from "../dist/agent-orchestrator/phase-tools.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint-34-35-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Phases Smoke", description: "" });

  // Register a synthetic artifact in phase 1.
  const a = service.saveArtifact({ kind: "raw", scope: "input", title: "T1", path: "raw.bin" });
  assert.equal(a.phase, undefined, "phase defaults to undefined (treated as 1)");

  // Advance to phase 2.
  const a2 = service.advanceArtifactPhase(a.id, 2);
  assert.equal(a2.phase, 2);

  // Skip to 5 without evidence -> throws.
  let threw = false;
  try { service.advanceArtifactPhase(a.id, 5); } catch { threw = true; }
  assert.ok(threw, "skipping phases without evidence is refused");

  // Skip to 5 with evidence -> ok.
  const a5 = service.advanceArtifactPhase(a.id, 5, "phase 3+4 done out of band");
  assert.equal(a5.phase, 5);

  // Backward refused.
  let threwBack = false;
  try { service.advanceArtifactPhase(a.id, 3); } catch { threwBack = true; }
  assert.ok(threwBack, "moving backward is refused");

  // Freeze.
  const frozen = service.freezeArtifactAtPhase(a.id, "level data");
  assert.equal(frozen.phaseFrozen, true);
  assert.equal(frozen.phaseFrozenReason, "level data");

  // Worker prompt builder.
  const prompt = buildWorkerPrompt({ phase: 4, artifactId: a.id, artifactTitle: "T1" });
  assert.match(prompt, /Phase 4/);
  assert.match(prompt, /Segment Analysis/);
  assert.match(prompt, /inspect_address_range/);
  assert.match(prompt, /Hand-off contract/);

  // phaseForTool + isToolAllowedInPhase.
  assert.equal(phaseForTool("analyze_prg"), 3);
  assert.equal(phaseForTool("save_finding"), 5);
  assert.equal(phaseForTool("agent_propose_next"), "agnostic");
  const ok = isToolAllowedInPhase("disasm_prg", 3, true);
  assert.equal(ok.allowed, true);
  const skip = isToolAllowedInPhase("save_finding", 2, true);
  assert.equal(skip.allowed, false);
  assert.match(skip.reason, /phase 5/);
  // Save_open_question is allowed in phase 4 (not just 5+) — it can also be agnostic.
  const agnostic = isToolAllowedInPhase("agent_onboard", 1, true);
  assert.equal(agnostic.allowed, true);

  console.log("sprint 34/35 smoke test passed");
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
