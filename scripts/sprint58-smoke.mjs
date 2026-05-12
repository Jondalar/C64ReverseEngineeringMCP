// Bug 26 / Spec 058 follow-up — backfill_internal_flags + view-builder
// heuristic-fallback smoke.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint58-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Bug 26 backfill smoke", description: "" });

  // Simulate legacy state: write artifacts + entities directly with no
  // internal flag, even though the path matches the heuristic.
  const fs = await import("node:fs");
  const annPath = join(root, "analysis/disk/motm/01_murder_annotations.json");
  fs.mkdirSync(join(root, "analysis/disk/motm"), { recursive: true });
  writeFileSync(annPath, "{}");

  const artStore = JSON.parse(fs.readFileSync(join(root, "knowledge/artifacts.json"), "utf8"));
  artStore.items.push({
    id: "artifact-legacy-annotations",
    kind: "other",
    scope: "knowledge",
    title: "01 murder annotations",
    path: annPath,
    relativePath: "analysis/disk/motm/01_murder_annotations.json",
    role: "annotations",
    status: "active",
    confidence: 1,
    sourceArtifactIds: [],
    entityIds: [],
    evidence: [],
    tags: [],
    versions: [],
    loadContexts: [],
    // intentionally NO internal flag
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(join(root, "knowledge/artifacts.json"), JSON.stringify(artStore, null, 2));

  const entStore = JSON.parse(fs.readFileSync(join(root, "knowledge/entities.json"), "utf8"));
  entStore.items.push({
    id: "entity-legacy-annotations",
    kind: "payload",
    name: "01 Murder Annotations",
    summary: "",
    status: "active",
    confidence: 1,
    evidence: [],
    artifactIds: ["artifact-legacy-annotations"],
    relatedEntityIds: [],
    payloadLoadAddress: 0x0801,
    payloadFormat: "raw",
    payloadSourceArtifactId: "artifact-legacy-annotations",
    payloadAsmArtifactIds: [],
    aliases: [],
    mediumSpans: [],
    tags: [],
    // intentionally NO internal flag
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(join(root, "knowledge/entities.json"), JSON.stringify(entStore, null, 2));

  // ---- Test 1: backfill_internal_flags dry run ----
  const dry = service.backfillInternalFlags({ dryRun: true });
  assert.equal(dry.artifactsUpdated, 1, `dry: 1 artifact backfilled; got ${dry.artifactsUpdated}`);
  assert.equal(dry.entitiesUpdated, 1, `dry: 1 entity backfilled; got ${dry.entitiesUpdated}`);
  // Dry-run must not mutate.
  const artBefore = service.listArtifacts().find((a) => a.id === "artifact-legacy-annotations");
  assert.equal(artBefore.internal, undefined, "dry-run preserves undefined flag");

  // ---- Test 2: apply backfill ----
  const applied = service.backfillInternalFlags({ dryRun: false });
  assert.equal(applied.artifactsUpdated, 1);
  assert.equal(applied.entitiesUpdated, 1);
  const artAfter = service.listArtifacts().find((a) => a.id === "artifact-legacy-annotations");
  assert.equal(artAfter.internal, true, "artifact flag set");
  const entAfter = service.listEntities().find((e) => e.id === "entity-legacy-annotations");
  assert.equal(entAfter.internal, true, "entity flag inherited from primary artifact");

  // Idempotent: second run should be a no-op.
  const second = service.backfillInternalFlags({ dryRun: false });
  assert.equal(second.artifactsUpdated, 0);
  assert.equal(second.entitiesUpdated, 0);

  console.log("Sprint 58 smoke (backfill_internal_flags) OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
