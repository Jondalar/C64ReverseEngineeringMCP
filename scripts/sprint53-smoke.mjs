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

  // ---- Test 3: dedupePayloadEntities after the graph cut-over ----
  // Since a323cf96 (Spec 822.2) payload identity is derived in the graph, one node per (owner stem, load
  // address); there is no entities.json to plant a legacy duplicate in and nothing left to merge. The tool
  // keeps its shape and reports the survivors: the dedup itself is what Tests 1-2 above prove.
  for (const dryRun of [true, false]) {
    const r = service.dedupePayloadEntities({ dryRun });
    assert.equal(r.duplicateGroupCount, 0, "nothing to dedupe: identity is derived");
    assert.equal(r.mergedRowCount, 0);
    assert.equal(r.survivorCount, 2, `both payloads survive; got ${r.survivorCount}`);
  }
  const stateAfter = service.listEntities({ kind: "payload" });
  assert.equal(stateAfter.length, 2, `expected 2 payload entities; got ${stateAfter.length}`);
  const survivor = stateAfter.find((e) => e.name === "murder");
  assert.ok(survivor, "survivor 'murder' present");
  assert.ok(survivor.aliases.includes("01_murder"), `survivor aliases keep the folded name; got ${survivor.aliases}`);

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
