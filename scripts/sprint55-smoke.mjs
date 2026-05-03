// Bug 33 — manifest-importer hash + aggregator-skip + backfill smoke.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";
import { importManifestKnowledge } from "../dist/project-knowledge/manifest-import.js";

const root = mkdtempSync(join(tmpdir(), "c64re-sprint55-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({ name: "Bug 33 Smoke", description: "" });

  // ---- Test (a) Fix B: aggregator skip prevents false-merge ----
  // Two distinct PRGs at $4000, both sourced from same manifest.
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, "{}");
  const manifestArt = service.saveArtifact({
    kind: "manifest", scope: "generated", title: "manifest.json",
    path: manifestPath, role: "disk-manifest", format: "json",
  });
  assert.equal(manifestArt.kind, "manifest");

  // Two payload entities sharing srcArt + loadAddress but DIFFERENT content.
  const e1 = service.saveEntity({
    kind: "payload",
    name: "ab",
    payloadLoadAddress: 0x4000,
    payloadSourceArtifactId: manifestArt.id,
    payloadContentHash: "hash_ab",
  });
  const e2 = service.saveEntity({
    kind: "payload",
    name: "baby",
    payloadLoadAddress: 0x4000,
    payloadSourceArtifactId: manifestArt.id,
    payloadContentHash: "hash_baby",
  });
  assert.notEqual(e1.id, e2.id, "different content hashes must produce different entities");

  // Now register a third entity at $4000 + same manifest BUT no hash.
  // Pre-Bug 33: would false-merge into e1 via fallback. Post-Bug 33:
  // aggregator skip kicks in — entity stays solo.
  const e3 = service.saveEntity({
    kind: "payload",
    name: "chr1",
    payloadLoadAddress: 0x4000,
    payloadSourceArtifactId: manifestArt.id,
    // intentionally no payloadContentHash
  });
  assert.notEqual(e3.id, e1.id, "aggregator-source no-hash entity must not collapse into e1");
  assert.notEqual(e3.id, e2.id, "aggregator-source no-hash entity must not collapse into e2");

  // ---- Test (b) Fix A: manifest-import populates payloadContentHash ----
  // Build a real manifest with two file entries pointing at on-disk PRGs.
  const prg1Path = join(root, "01_a.prg");
  const prg2Path = join(root, "02_b.prg");
  writeFileSync(prg1Path, Buffer.from([0x11, 0x22, 0x33]));
  writeFileSync(prg2Path, Buffer.from([0xaa, 0xbb, 0xcc]));
  const realManifestPath = join(root, "real_manifest.json");
  writeFileSync(realManifestPath, JSON.stringify({
    format: "d64",
    diskName: "TEST",
    files: [
      { index: 0, name: "01_a", relativePath: "01_a.prg", type: "PRG", loadAddress: 0x4000, sizeBytes: 3 },
      { index: 1, name: "02_b", relativePath: "02_b.prg", type: "PRG", loadAddress: 0x4000, sizeBytes: 3 },
    ],
  }, null, 2));
  const realManifestArt = service.saveArtifact({
    kind: "manifest", scope: "generated", title: "real_manifest.json",
    path: realManifestPath, role: "disk-manifest", format: "json",
  });
  const imported = importManifestKnowledge(realManifestArt);
  assert.ok(imported, "manifest must parse");
  assert.equal(imported.entities.length, 2);
  for (const ent of imported.entities) {
    assert.ok(ent.payloadContentHash, `entity ${ent.name} must have payloadContentHash`);
    assert.equal(ent.payloadContentHash.length, 64, "sha256 hex is 64 chars");
  }
  assert.notEqual(
    imported.entities[0].payloadContentHash,
    imported.entities[1].payloadContentHash,
    "different files must produce different hashes",
  );

  // ---- Test (c): backfill_payload_content_hashes (direct) ----
  // Register a directly-linked PRG entity without hash.
  const prgDirect = join(root, "direct.prg");
  writeFileSync(prgDirect, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  const directArt = service.saveArtifact({
    kind: "prg", scope: "input", title: "direct", path: prgDirect, role: "analysis-target",
  });
  // Force-create entity with NO hash (bypass dedup by using new id).
  const fs = await import("node:fs");
  const entitiesPath = join(root, "knowledge", "entities.json");
  const eStore = JSON.parse(fs.readFileSync(entitiesPath, "utf8"));
  eStore.items.push({
    id: "entity-direct-test",
    kind: "payload",
    name: "direct",
    summary: "",
    status: "active",
    confidence: 1,
    evidence: [],
    artifactIds: [directArt.id],
    relatedEntityIds: [],
    payloadLoadAddress: 0x0801,
    payloadFormat: "prg",
    payloadSourceArtifactId: directArt.id,
    payloadAsmArtifactIds: [],
    aliases: [],
    mediumSpans: [],
    tags: [],
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(entitiesPath, JSON.stringify(eStore, null, 2));

  const dry = service.backfillPayloadContentHashes({ dryRun: true });
  assert.equal(dry.updated, 1, `dry: 1 backfilled; got ${dry.updated}`);
  // dry-run must not touch state
  const beforeApply = service.listEntities({ kind: "payload" }).find((e) => e.id === "entity-direct-test");
  assert.equal(beforeApply.payloadContentHash, undefined);

  const applied = service.backfillPayloadContentHashes({ dryRun: false });
  assert.equal(applied.updated, 1);
  const afterApply = service.listEntities({ kind: "payload" }).find((e) => e.id === "entity-direct-test");
  assert.ok(afterApply.payloadContentHash, "hash backfilled on entity");
  assert.equal(afterApply.payloadContentHash.length, 64);

  // direct backfill should NOT touch manifest-sourced entities (e1/e2/e3).
  const e1After = service.listEntities({ kind: "payload" }).find((e) => e.id === e1.id);
  assert.equal(e1After.payloadContentHash, "hash_ab", "manifest-sourced entity untouched by direct backfill");

  // ---- Test (d): backfill_manifest_payload_hashes (manifest re-parse) ----
  // First, simulate legacy state: clear hashes from real-manifest entities.
  const eStore2 = JSON.parse(fs.readFileSync(entitiesPath, "utf8"));
  // Add the entities that real_manifest WOULD have created if importManifestArtifact were called.
  // Use stableId pattern matching manifest-import.
  for (let i = 0; i < imported.entities.length; i++) {
    const id = imported.entities[i].id;
    eStore2.items.push({
      id,
      kind: "disk-file",
      name: imported.entities[i].name,
      summary: "",
      status: "active",
      confidence: 1,
      evidence: [],
      artifactIds: [realManifestArt.id],
      relatedEntityIds: [],
      payloadLoadAddress: 0x4000,
      payloadFormat: "prg",
      payloadSourceArtifactId: realManifestArt.id,
      // intentionally NO payloadContentHash (legacy state)
      payloadAsmArtifactIds: [],
      aliases: [],
      mediumSpans: [],
      tags: ["manifest-import", "disk-file", "payload", "PRG"],
      createdAt: "2099-01-01T00:00:00.000Z",
      updatedAt: "2099-01-01T00:00:00.000Z",
    });
  }
  fs.writeFileSync(entitiesPath, JSON.stringify(eStore2, null, 2));

  const mDry = service.backfillManifestPayloadHashes({ dryRun: true });
  assert.equal(mDry.manifestsScanned, 2, "both manifests scanned");
  assert.equal(mDry.updated, 2, `dry: 2 manifest-sourced backfilled; got ${mDry.updated}`);

  const mApplied = service.backfillManifestPayloadHashes({ dryRun: false });
  assert.equal(mApplied.updated, 2);
  for (const ent of imported.entities) {
    const after = service.listEntities().find((e) => e.id === ent.id);
    assert.ok(after.payloadContentHash, `manifest entity ${ent.name} hash backfilled`);
    assert.equal(after.payloadContentHash, ent.payloadContentHash);
  }

  console.log("Sprint 55 smoke (Bug 33 manifest hash + aggregator skip + backfill) OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
