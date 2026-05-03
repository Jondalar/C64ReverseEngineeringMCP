// Spec 060 / Bug 30 — saveArtifact path-first dedup + dedupeArtifactRegistry smoke.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint52-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Bug 30 Smoke", description: "" });

  // Create a fake PRG file in the project so contentHash works.
  const prgPath = join(root, "fake.prg");
  writeFileSync(prgPath, Buffer.from([0x00, 0x08, 0xa9, 0x00, 0x60]));

  // ---- Test 1: path-first dedup overrides synthetic input.id ----
  // Caller A passes no id -> first registration mints "id-A".
  const a = service.saveArtifact({
    kind: "prg",
    scope: "input",
    title: "Fake PRG (analyze)",
    path: prgPath,
    role: "analysis-target",
  });
  // Caller B passes a fresh synthetic id -> path-dedup must win, returning a.id.
  const b = service.saveArtifact({
    id: "artifact-fake-prg-fresh-id-aaaa",
    kind: "prg",
    scope: "input",
    title: "Fake PRG (disasm)",
    path: prgPath,
    role: "disasm-target",
  });
  assert.equal(b.id, a.id, "path-dedup must reuse existing id even when caller passes input.id");

  // Caller C passes neither id nor matching path but a hash that matches.
  const movedPath = join(root, "moved.prg");
  writeFileSync(movedPath, Buffer.from([0x00, 0x08, 0xa9, 0x00, 0x60])); // same bytes
  const c = service.saveArtifact({
    kind: "prg",
    scope: "input",
    title: "Fake PRG (moved)",
    path: movedPath,
    role: "moved-target",
  });
  // hash-dedup: should reuse a.id since same content as fake.prg
  assert.equal(c.id, a.id, "hash-dedup must reuse existing id when content matches");

  // Total artifacts in store should still be 1.
  const all = service.listArtifacts();
  assert.equal(all.length, 1, `expected 1 artifact after dedup, got ${all.length}`);

  // Latest record should carry the latest role write (disasm-target overwrote, then moved-target).
  // We don't assert the exact role since saveArtifact does input.role ?? existing.role
  // semantics — only that we have a single record.

  // ---- Test 2: derivedFrom bypasses path-dedup (real lineage bump) ----
  const derivative = service.saveArtifact({
    kind: "prg",
    scope: "generated",
    title: "Fake PRG patched",
    path: prgPath,
    role: "patched",
    derivedFrom: a.id,
  });
  assert.notEqual(derivative.id, a.id, "derivedFrom must mint a new artifact id");
  assert.equal(derivative.derivedFrom, a.id);
  assert.equal(derivative.lineageRoot, a.id);
  assert.equal(derivative.versionRank, 1);

  // ---- Test 3: dedupeArtifactRegistry collapses legacy duplicates ----
  // Simulate legacy state by writing the artifacts.json directly with two
  // path-duplicates (the saveArtifact fix above wouldn't permit this now).
  const legacyService = new ProjectKnowledgeService(root);
  // Read current state, append a fake duplicate of `a` with different id.
  const fs = await import("node:fs");
  const artifactsPath = join(root, "knowledge", "artifacts.json");
  const store = JSON.parse(fs.readFileSync(artifactsPath, "utf8"));
  store.items.push({
    ...store.items[0],
    id: "artifact-legacy-duplicate-zzzz",
    title: "Legacy dup",
    role: "legacy",
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(artifactsPath, JSON.stringify(store, null, 2));

  // Add a finding that references the duplicate id.
  legacyService.saveFinding({
    kind: "observation",
    title: "Legacy finding",
    artifactIds: ["artifact-legacy-duplicate-zzzz"],
  });

  const dryRun = legacyService.dedupeArtifactRegistry({ dryRun: true });
  assert.equal(dryRun.duplicateGroupCount, 1);
  assert.equal(dryRun.mergedRowCount, 1);
  // Dry-run should not modify state.
  const stateAfterDry = legacyService.listArtifacts();
  assert.equal(stateAfterDry.length, 3, `dry run must not mutate; got ${stateAfterDry.length}`);

  const applied = legacyService.dedupeArtifactRegistry({ dryRun: false });
  assert.equal(applied.duplicateGroupCount, 1);
  assert.equal(applied.mergedRowCount, 1);
  assert.equal(applied.referenceRemapCounts.findings, 1, "finding reference must remap");

  // After dedupe: original state restored to 2 (a.id and derivative.id).
  const stateAfter = legacyService.listArtifacts();
  assert.equal(stateAfter.length, 2, `expected 2 after dedupe, got ${stateAfter.length}`);
  // The finding should now reference the survivor (a.id), not the duplicate.
  const findings = legacyService.listFindings();
  const updated = findings.find((f) => f.title === "Legacy finding");
  assert.ok(updated, "finding survived");
  assert.deepEqual(updated.artifactIds, [a.id], `finding remapped to survivor; got ${updated.artifactIds}`);

  console.log("Sprint 52 smoke (Bug 30 dedup) OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
