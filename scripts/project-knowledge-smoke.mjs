import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditProject } from "../dist/project-knowledge/audit.js";
import { repairProject } from "../dist/project-knowledge/repair.js";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";
import { resolveProjectDir } from "../dist/project-root.js";

const root = mkdtempSync(join(tmpdir(), "c64re-knowledge-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({
    name: "Smoke Workspace",
    description: "Smoke test workspace for project knowledge layer.",
    tags: ["smoke"],
  });

  const nestedMediaDir = join(root, "media");
  mkdirSync(nestedMediaDir, { recursive: true });
  const nestedImagePath = join(nestedMediaDir, "smoke.g64");
  writeFileSync(nestedImagePath, new Uint8Array([0x47, 0x36, 0x34]));
  assert.equal(resolveProjectDir({
    cwd: process.cwd(),
    repoDir: process.cwd(),
    hintPath: nestedImagePath,
    requireWritable: true,
  }), root);

  const originalCwd = process.cwd();
  process.chdir(nestedMediaDir);
  try {
    mkdirSync(join(root, "analysis", "disk"), { recursive: true });
    writeFileSync(join(root, "analysis", "disk", "nested-cwd.json"), "{}\n");
    const nestedCwdArtifact = service.saveArtifact({
      kind: "other",
      scope: "analysis",
      title: "Nested CWD artifact",
      path: "analysis/disk/nested-cwd.json",
      role: "generic-json",
      format: "json",
    });
    assert.equal(nestedCwdArtifact.relativePath, "analysis/disk/nested-cwd.json");
  } finally {
    process.chdir(originalCwd);
  }

  const analysisPath = join(root, "analysis", "smoke_analysis.json");
  writeFileSync(analysisPath, `${JSON.stringify({
    binaryName: "smoke.prg",
    entryPoints: [
      { address: 0x080d, source: "basic_sys", reason: "BASIC SYS target", symbol: "main_entry" },
    ],
    segments: [
      {
        kind: "code",
        start: 0x080d,
        end: 0x08ff,
        score: { confidence: 0.95, reasons: ["Reachable from BASIC SYS entry."] },
        xrefs: [
          { sourceAddress: 0x0810, targetAddress: 0x4000, type: "read", confidence: 0.84 },
        ],
      },
      {
        kind: "lookup_table",
        start: 0x4000,
        end: 0x40ff,
        score: { confidence: 0.72, reasons: ["Indexed reads suggest a table."] },
      },
    ],
    codeSemantics: {
      ramHypotheses: [
        {
          start: 0x2000,
          end: 0x20ff,
          kind: "state_block",
          confidence: 0.67,
          labelHint: "player_state",
          reasons: ["Dense direct writes indicate mutable state."],
        },
      ],
      displayStates: [
        {
          start: 0x0900,
          end: 0x0910,
          screenAddress: 0x0400,
          charsetAddress: 0x2000,
          confidence: 0.7,
          reasons: ["Screen and charset setup observed."],
        },
      ],
      displayTransfers: [
        {
          start: 0x0a00,
          end: 0x0a10,
          sourceAddress: 0x4000,
          destinationAddress: 0xd800,
          role: "color",
          confidence: 0.64,
          reasons: ["Indexed copy into color RAM."],
        },
      ],
    },
  }, null, 2)}\n`);

  const artifact = service.saveArtifact({
    kind: "other",
    scope: "analysis",
    title: "Smoke analysis",
    path: analysisPath,
    role: "analysis-json",
    format: "json",
    producedByTool: "smoke-test",
  });

  const imported = service.importAnalysisArtifact(artifact.id);
  assert.equal(imported.importedEntityCount > 0, true);
  assert.equal(imported.importedFindingCount > 0, true);
  assert.equal(imported.importedRelationCount > 0, true);
  assert.equal(imported.importedFlowCount > 0, true);
  assert.equal(imported.importedOpenQuestionCount > 0, true);

  const allViews = service.buildAllViews();

  assert.equal(allViews.projectDashboard.view.counts.artifacts >= 1, true);
  assert.equal(allViews.memoryMap.view.regions.length >= 1, true);
  assert.equal(allViews.annotatedListing.view.entries.length >= 2, true);
  assert.equal(allViews.loadSequence.view.items.length >= 1, true);
  assert.equal(allViews.flowGraph.view.nodes.length >= 2, true);
  assert.equal(allViews.flowGraph.view.edges.length >= 1, true);
  assert.equal(service.listOpenQuestions().length >= 1, true);
  assert.equal(service.listRelations().length >= 1, true);

  const cleanAudit = auditProject(root);
  assert.equal(cleanAudit.severity, "ok", JSON.stringify(cleanAudit, null, 2));
  assert.equal(cleanAudit.counts.nestedKnowledgeStores, 0);
  assert.equal(cleanAudit.counts.staleViews, 0);

  const nestedKnowledge = join(root, "media", "knowledge");
  mkdirSync(nestedKnowledge, { recursive: true });
  writeFileSync(join(nestedKnowledge, "entities.json"), `${JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), items: [] }, null, 2)}\n`);
  const fragmentedAudit = auditProject(root);
  assert.equal(fragmentedAudit.severity, "high");
  assert.equal(fragmentedAudit.counts.nestedKnowledgeStores, 1);
  rmSync(nestedKnowledge, { recursive: true, force: true });

  service.saveTask({
    kind: "smoke",
    title: "Smoke stale-view task",
    status: "open",
  });
  const staleAudit = auditProject(root);
  assert.equal(staleAudit.counts.staleViews > 0, true);

  const repairDryRun = repairProject(root, { mode: "dry-run", operations: ["build-views"] });
  assert.equal(repairDryRun.executed.length, 0);
  assert.equal(repairDryRun.planned.includes("build-views all workspace views"), true);

  const repairSafe = repairProject(root, { mode: "safe", operations: ["build-views"] });
  assert.equal(repairSafe.executed.includes("built all workspace views"), true);
  assert.equal(repairSafe.after?.counts.staleViews, 0);

  const fragmentRoot = mkdtempSync(join(tmpdir(), "c64re-knowledge-merge-"));
  try {
    const fragmentService = new ProjectKnowledgeService(fragmentRoot);
    fragmentService.initProject({ name: "Merge fixture", description: "merge-fragments smoke", tags: ["smoke"] });

    const nestedDir = join(fragmentRoot, "media", "knowledge");
    mkdirSync(nestedDir, { recursive: true });
    const ts = new Date().toISOString();
    const childUnique = {
      schemaVersion: 1,
      updatedAt: ts,
      items: [
        {
          id: "task_merge_unique",
          kind: "smoke",
          title: "Unique nested task",
          status: "open",
          priority: "medium",
          confidence: 0.5,
          evidence: [],
          entityIds: [],
          artifactIds: [],
          questionIds: [],
          createdAt: ts,
          updatedAt: ts,
        },
      ],
    };
    writeFileSync(join(nestedDir, "tasks.json"), `${JSON.stringify(childUnique, null, 2)}\n`);

    const conflictTask = fragmentService.saveTask({ kind: "smoke", title: "Root task that will collide" });
    const childConflict = {
      schemaVersion: 1,
      updatedAt: ts,
      items: [
        {
          id: conflictTask.id,
          kind: "smoke",
          title: "Conflicting nested task",
          status: "open",
          priority: "medium",
          confidence: 0.5,
          evidence: [],
          entityIds: [],
          artifactIds: [],
          questionIds: [],
          createdAt: ts,
          updatedAt: ts,
        },
      ],
    };
    writeFileSync(join(nestedDir, "open-questions.json"), `${JSON.stringify({ schemaVersion: 1, updatedAt: ts, items: [] }, null, 2)}\n`);
    const tasksPath = join(fragmentRoot, "knowledge", "tasks.json");
    writeFileSync(tasksPath, `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: ts,
      items: [conflictTask, ...(childConflict.items.filter((item) => item.id !== conflictTask.id))],
    }, null, 2)}\n`);

    const mergeDryRun = repairProject(fragmentRoot, { mode: "dry-run", operations: ["merge-fragments"] });
    assert.equal(mergeDryRun.planned.some((line) => line.includes("merge-fragments") && line.includes("tasks.json")), true);
    assert.equal(mergeDryRun.executed.length, 0);

    const mergeSafe = repairProject(fragmentRoot, { mode: "safe", operations: ["merge-fragments"] });
    const mergedTasks = new ProjectKnowledgeService(fragmentRoot).listTasks();
    assert.equal(mergedTasks.some((task) => task.id === "task_merge_unique"), true);
    assert.equal(mergeSafe.executed.some((line) => line.includes("merged 1 record(s)")), true);
  } finally {
    rmSync(fragmentRoot, { recursive: true, force: true });
  }

  const registerRoot = mkdtempSync(join(tmpdir(), "c64re-knowledge-register-"));
  try {
    const registerService = new ProjectKnowledgeService(registerRoot);
    registerService.initProject({ name: "Register fixture", description: "register-artifacts smoke", tags: ["smoke"] });
    const stagedDir = join(registerRoot, "artifacts", "extracted");
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(join(stagedDir, "stray.prg"), new Uint8Array([0x01, 0x08, 0x0b, 0x08]));

    const dryRun = repairProject(registerRoot, { mode: "dry-run", operations: ["register-artifacts"] });
    assert.equal(dryRun.planned.some((line) => line.includes("artifacts/extracted/stray.prg")), true);
    assert.equal(dryRun.executed.length, 0);

    const safe = repairProject(registerRoot, { mode: "safe", operations: ["register-artifacts"] });
    assert.equal(safe.executed.some((line) => line.includes("registered artifacts/extracted/stray.prg")), true);

    const registered = new ProjectKnowledgeService(registerRoot).listArtifacts();
    assert.equal(registered.some((artifact) => artifact.relativePath === "artifacts/extracted/stray.prg"), true);
  } finally {
    rmSync(registerRoot, { recursive: true, force: true });
  }

  const importRoot = mkdtempSync(join(tmpdir(), "c64re-knowledge-import-"));
  try {
    const importService = new ProjectKnowledgeService(importRoot);
    importService.initProject({ name: "Import fixture", description: "import-analysis smoke", tags: ["smoke"] });
    const analysisDir = join(importRoot, "analysis");
    mkdirSync(analysisDir, { recursive: true });
    const importAnalysisPath = join(analysisDir, "import_analysis.json");
    writeFileSync(importAnalysisPath, `${JSON.stringify({
      binaryName: "import.prg",
      entryPoints: [{ address: 0x0810, source: "basic_sys", reason: "entry", symbol: "entry" }],
      segments: [{
        kind: "code",
        start: 0x0810,
        end: 0x08ff,
        score: { confidence: 0.9, reasons: ["entry"] },
      }],
    }, null, 2)}\n`);
    const analysisArtifact = importService.saveArtifact({
      kind: "analysis-run",
      scope: "analysis",
      title: "Import analysis",
      path: importAnalysisPath,
      role: "analysis-json",
      format: "json",
    });

    const dryRun = repairProject(importRoot, { mode: "dry-run", operations: ["import-analysis"] });
    assert.equal(dryRun.planned.some((line) => line.includes("import-analysis") && line.includes(analysisArtifact.id)), true);
    assert.equal(dryRun.executed.length, 0);

    const safe = repairProject(importRoot, { mode: "safe", operations: ["import-analysis"] });
    assert.equal(safe.executed.some((line) => line.startsWith(`imported ${analysisArtifact.id}`)), true);
    assert.equal(safe.after?.counts.unimportedAnalysisArtifacts, 0);
  } finally {
    rmSync(importRoot, { recursive: true, force: true });
  }

  console.log("project-knowledge smoke test passed");
  console.log(root);
} finally {
  rmSync(root, { recursive: true, force: true });
}
