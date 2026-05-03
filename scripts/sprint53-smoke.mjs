// Spec 060 / Bug 31 — payload entity dedup + aliases + dedupePayloadEntities smoke.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint53-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Bug 31 Smoke", description: "" });

  // Register a real-ish source artifact for the payloads to point at.
  const prgPath = join(root, "fake.prg");
  writeFileSync(prgPath, Buffer.from([0x00, 0x10, 0x00, 0x00]));
  const sourceArtifact = service.saveArtifact({
    kind: "prg",
    scope: "input",
    title: "Fake PRG",
    path: prgPath,
    role: "analysis-target",
  });

  // ---- Test 1: hash-based dedup folds duplicate name into aliases[] ----
  const a = service.saveEntity({
    kind: "payload",
    name: "murder",
    payloadLoadAddress: 0x0801,
    payloadFormat: "prg",
    payloadSourceArtifactId: sourceArtifact.id,
    payloadContentHash: "deadbeef",
  });
  const b = service.saveEntity({
    kind: "payload",
    name: "01_murder",
    payloadLoadAddress: 0x0801,
    payloadFormat: "prg",
    payloadSourceArtifactId: sourceArtifact.id,
    payloadContentHash: "deadbeef",
  });
  assert.equal(b.id, a.id, "hash dedup must reuse existing entity id");
  assert.deepEqual(b.aliases, ["01_murder"], "second name folds into aliases[]");
  assert.equal(b.name, "murder", "survivor keeps original name");

  // ---- Test 2: source+load fallback when hash absent ----
  const c = service.saveEntity({
    kind: "payload",
    name: "bonus",
    payloadLoadAddress: 0x4000,
    payloadSourceArtifactId: sourceArtifact.id,
  });
  const d = service.saveEntity({
    kind: "payload",
    name: "02_bonus",
    payloadLoadAddress: 0x4000,
    payloadSourceArtifactId: sourceArtifact.id,
  });
  assert.equal(d.id, c.id, "(source, load) fallback must dedup");
  assert.deepEqual(d.aliases, ["02_bonus"]);

  // Total payload entities should be 2.
  const all = service.listEntities({ kind: "payload" });
  assert.equal(all.length, 2, `expected 2 payload entities, got ${all.length}`);

  // ---- Test 3: dedupePayloadEntities migration collapses legacy duplicates ----
  // Simulate legacy state: write a sibling entity directly that bypasses
  // the new saveEntity dedup.
  const fs = await import("node:fs");
  const entitiesPath = join(root, "knowledge", "entities.json");
  const store = JSON.parse(fs.readFileSync(entitiesPath, "utf8"));
  store.items.push({
    id: "entity-payload-legacy-zzzz",
    kind: "payload",
    name: "16_dad",
    summary: "legacy prefixed copy",
    status: "active",
    confidence: 1,
    evidence: [],
    artifactIds: [sourceArtifact.id],
    relatedEntityIds: [],
    payloadLoadAddress: 0x0801,
    payloadFormat: "prg",
    payloadSourceArtifactId: sourceArtifact.id,
    payloadContentHash: "deadbeef",
    payloadAsmArtifactIds: [],
    aliases: [],
    mediumSpans: [],
    tags: ["pipeline-cli", "payload"],
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(entitiesPath, JSON.stringify(store, null, 2));

  // Add a finding referencing the legacy duplicate.
  service.saveFinding({
    kind: "observation",
    title: "Legacy finding",
    entityIds: ["entity-payload-legacy-zzzz"],
  });

  const dryRun = service.dedupePayloadEntities({ dryRun: true });
  assert.equal(dryRun.duplicateGroupCount, 1, `expected 1 dup group dry-run; got ${dryRun.duplicateGroupCount}`);
  assert.equal(dryRun.mergedRowCount, 1);
  // Dry-run: state unchanged.
  const stateAfterDry = service.listEntities({ kind: "payload" });
  assert.equal(stateAfterDry.length, 3);

  const applied = service.dedupePayloadEntities({ dryRun: false });
  assert.equal(applied.duplicateGroupCount, 1);
  assert.equal(applied.referenceRemapCounts.findings, 1, "finding entity ref must remap");

  const stateAfter = service.listEntities({ kind: "payload" });
  assert.equal(stateAfter.length, 2, `expected 2 after dedupe; got ${stateAfter.length}`);
  const survivor = stateAfter.find((e) => e.name === "murder");
  assert.ok(survivor, "survivor 'murder' present");
  assert.ok(survivor.aliases.includes("16_dad"), `survivor aliases include legacy name; got ${survivor.aliases}`);
  assert.ok(survivor.aliases.includes("01_murder"));

  // Finding should now reference survivor.
  const findings = service.listFindings();
  const updated = findings.find((f) => f.title === "Legacy finding");
  assert.deepEqual(updated.entityIds, [survivor.id], `finding remapped; got ${updated.entityIds}`);

  // ---- Test 4: manifest-internal classification ----
  // Register an internal artifact (manifest.json), then a payload pointing at it.
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, "{}");
  const manifestArtifact = service.saveArtifact({
    kind: "manifest",
    scope: "generated",
    title: "manifest.json",
    path: manifestPath,
    role: "disk-manifest",
    format: "json",
  });
  assert.equal(manifestArtifact.internal, true, "manifest artifact auto-classified internal");

  const manifestPayload = service.saveEntity({
    kind: "payload",
    name: "manifest.json",
    payloadLoadAddress: 0x0a7b,
    payloadSourceArtifactId: manifestArtifact.id,
  });
  assert.equal(manifestPayload.internal, true, "payload entity inherits internal from source");

  console.log("Sprint 53 smoke (Bug 31 payload dedup + aliases) OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
