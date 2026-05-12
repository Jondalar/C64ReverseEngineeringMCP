import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";
import { auditProject } from "../dist/project-knowledge/audit.js";

const root = mkdtempSync(join(tmpdir(), "c64re-lineage-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({
    name: "Lineage Smoke",
    description: "Spec 025 lineage + versions + container subentries.",
    tags: ["smoke"],
  });

  // Build a V0 -> V1 -> V2 -> V3 chain across paths via derivedFrom.
  const v0Path = "extracted/sample.bin";
  mkdirSync(join(root, "extracted"), { recursive: true });
  writeFileSync(join(root, v0Path), new Uint8Array([0x01, 0x08, 0x42, 0x42, 0x42]));
  const v0 = service.saveArtifact({
    kind: "raw",
    scope: "analysis",
    title: "V0 raw extract",
    path: v0Path,
  });

  const v1Path = "analysis/sample_disasm.asm";
  mkdirSync(join(root, "analysis"), { recursive: true });
  writeFileSync(join(root, v1Path), "; v1 non-semantic\n");
  const v1 = service.saveArtifact({
    kind: "listing",
    scope: "analysis",
    title: "V1 disasm",
    path: v1Path,
    derivedFrom: v0.id,
  });

  const v2Path = "analysis/sample_semantic.asm";
  writeFileSync(join(root, v2Path), "; v2 semantic 1.0\n");
  const v2 = service.saveArtifact({
    kind: "listing",
    scope: "analysis",
    title: "V2 semantic",
    path: v2Path,
    derivedFrom: v1.id,
    versionLabel: "semantic-1.0",
  });

  const v3Path = "analysis/sample_semantic_v15.asm";
  writeFileSync(join(root, v3Path), "; v3 semantic 1.5\n");
  const v3 = service.saveArtifact({
    kind: "listing",
    scope: "analysis",
    title: "V3 semantic 1.5",
    path: v3Path,
    derivedFrom: v2.id,
    versionLabel: "semantic-1.5",
  });

  // Lineage: all four share lineageRoot = v0.id
  assert.equal(v0.lineageRoot, v0.id, "V0 lineage root is itself");
  assert.equal(v1.lineageRoot, v0.id, "V1 inherits lineage root from V0");
  assert.equal(v2.lineageRoot, v0.id, "V2 inherits lineage root from V0");
  assert.equal(v3.lineageRoot, v0.id, "V3 inherits lineage root from V0");
  assert.equal(v0.versionRank, 0);
  assert.equal(v1.versionRank, 1);
  assert.equal(v2.versionRank, 2);
  assert.equal(v3.versionRank, 3);
  assert.equal(v3.versionLabel, "semantic-1.5");
  assert.equal(v1.versionLabel, "V1", "default label is V<rank>");

  const chain = service.getLineage(v3.id);
  assert.equal(chain.length, 4, "lineage chain has all four");
  assert.deepEqual(chain.map((c) => c.id), [v0.id, v1.id, v2.id, v3.id]);

  // Same-path overwrite: snapshot before overwrite, then save again.
  const beforeSnap = service.snapshotArtifactBeforeOverwrite(v1.id);
  assert.ok(beforeSnap, "snapshot returned a result");
  assert.ok(existsSync(beforeSnap.snapshotPath), "snapshot file exists");
  assert.equal(beforeSnap.bytes, statSync(beforeSnap.snapshotPath).size);

  // Overwrite v1 file with new content
  writeFileSync(join(root, v1Path), "; v1 RE-RUN — new bytes\n");
  const v1Again = service.saveArtifact({
    kind: "listing",
    scope: "analysis",
    title: "V1 disasm",
    path: v1Path,
    derivedFrom: v0.id,
  });
  assert.equal(v1Again.id, v1.id, "save_artifact dedups by path");
  assert.ok(v1Again.versions.length >= 1, "versions[] has prior content hash");
  assert.ok(v1Again.versions.some((v) => v.contentHash === beforeSnap.contentHash), "prior hash recorded");
  assert.notEqual(v1Again.contentHash, beforeSnap.contentHash, "current hash differs");

  // Rename version label
  const renamed = service.renameArtifactVersion(v3.id, "release-candidate");
  assert.equal(renamed?.versionLabel, "release-candidate");

  // Container sub-entries (R23): declare two children of v0
  const wt = service.saveContainerEntry({
    parentArtifactId: v0.id,
    subKey: "WT",
    containerOffset: 2,
    containerLength: 1,
    loadAddress: 0xc000,
  });
  const am = service.saveContainerEntry({
    parentArtifactId: v0.id,
    subKey: "AM",
    containerOffset: 3,
    containerLength: 2,
    status: "missing",
  });
  const all = service.listContainerEntries(v0.id);
  assert.equal(all.length, 2);
  assert.equal(all[0].subKey, "WT");
  assert.equal(all[1].subKey, "AM");
  assert.equal(all[1].status, "missing");

  // Idempotency: same parent + subKey -> same record
  const wtAgain = service.saveContainerEntry({
    parentArtifactId: v0.id,
    subKey: "WT",
    containerOffset: 2,
    containerLength: 1,
    loadAddress: 0xc100,
  });
  assert.equal(wtAgain.id, wt.id, "container entry deduped by parent+subKey");
  assert.equal(wtAgain.loadAddress, 0xc100, "field updated on second save");
  assert.equal(service.listContainerEntries(v0.id).length, 2, "still two entries");

  // Audit reports snapshot disk usage
  const audit = auditProject(root);
  assert.ok(audit.counts.snapshotFileCount >= 1, "audit counts snapshots");
  assert.ok(audit.counts.snapshotBytes > 0, "audit reports snapshot bytes");
  const snapshotFinding = audit.findings.find((f) => f.id === "snapshot-disk-usage");
  assert.ok(snapshotFinding, "snapshot-disk-usage finding present");

  // .gitignore exists in snapshots dir
  const gitignore = readdirSync(join(root, "snapshots"), { withFileTypes: true })
    .find((e) => e.name === ".gitignore");
  assert.ok(gitignore, "snapshots/.gitignore created");

  console.log("lineage-versions smoke test passed");
  console.log(root);
} catch (error) {
  console.error("smoke test FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  // intentionally leave root behind for inspection on failure
  if (process.exitCode === 0 || !process.exitCode) {
    rmSync(root, { recursive: true, force: true });
  }
}
