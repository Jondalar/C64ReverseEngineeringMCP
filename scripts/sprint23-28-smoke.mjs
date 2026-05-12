import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprints-23-28-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Sprints 23-28 Smoke", description: "Smoke test." });

  // Sprint 23: project profile.
  const profile = service.saveProjectProfile({
    goals: ["Ship EF port"],
    nonGoals: ["Annotate every byte"],
    destructiveOperations: [{ commandPattern: "rm -rf*", warning: "Wipes data." }],
    build: { command: "make", outputs: ["out/game.crt"] },
  });
  assert.equal(profile.goals.length, 1);
  assert.equal(service.getProjectProfile()?.goals[0], "Ship EF port");

  // Sprint 24: patch recipes (requires a target artifact).
  const targetPath = "build/loader.bin";
  mkdirSync(join(root, "build"), { recursive: true });
  writeFileSync(join(root, targetPath), Buffer.from([0xa9, 0x00, 0x8d, 0x21, 0xd0, 0x60]));
  const target = service.saveArtifact({
    kind: "raw",
    scope: "input",
    title: "Loader",
    path: targetPath,
  });
  const recipe = service.savePatchRecipe({
    title: "Skip prompt",
    reason: "Bypass /0 disk swap.",
    targetArtifactId: target.id,
    targetFileOffset: 0,
    expectedBytes: "a9 00",
    replacementBytes: "a9 ff",
    evidence: [],
    tags: [],
  });
  assert.equal(recipe.status, "draft");
  const apply = service.applyPatchRecipe(recipe.id);
  assert.equal(apply.ok, true, apply.reason);
  const patched = readFileSync(join(root, targetPath));
  assert.equal(patched[1], 0xff, "patched second byte");

  // Sprint 25: constraint checker.
  const region = service.registerResourceRegion({
    kind: "ram-range",
    name: "live-code",
    start: 0x0c23,
    end: 0x0fff,
    attributes: { protected: true },
    tags: [],
  });
  const op = service.registerOperation({
    kind: "overlay-copy",
    triggeredBy: "loader",
    affects: [region.id],
    preconditions: [],
    evidence: [],
  });
  const violations = service.verifyConstraints();
  assert.ok(violations.some((v) => v.severity === "error"), "protected-region violation fires");

  // Sprint 27: anti-pattern + doc render.
  service.saveAntiPattern({
    title: "Do not trust memory snapshots without trace",
    reason: "Snapshots reflect one moment; runtime trace gives the truth.",
    severity: "warn",
    appliesTo: { commandPattern: "vice_monitor_memory*" },
    tags: ["bug-5"],
    evidence: [],
  });
  const docs = service.renderDocs("all");
  assert.ok(docs.written.some((p) => p.endsWith("FINDINGS.md")), "FINDINGS.md rendered");
  assert.ok(docs.written.some((p) => p.endsWith("ANTI_PATTERNS.md")), "ANTI_PATTERNS.md rendered");
  assert.ok(docs.written.some((p) => p.endsWith("PROJECT_PROFILE.md")), "PROJECT_PROFILE.md rendered");
  for (const path of docs.written) assert.ok(existsSync(path), `doc exists at ${path}`);
  const profileText = readFileSync(docs.written.find((p) => p.endsWith("PROJECT_PROFILE.md")), "utf8");
  assert.match(profileText, /Ship EF port/);

  console.log("sprints 23-28 smoke test passed");
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
