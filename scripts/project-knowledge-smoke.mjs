import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const root = mkdtempSync(join(tmpdir(), "c64re-knowledge-smoke-"));

try {
  const service = new ProjectKnowledgeService(root);
  service.initProject({
    name: "Smoke Workspace",
    description: "Smoke test workspace for project knowledge layer.",
    tags: ["smoke"],
  });

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

  console.log("project-knowledge smoke test passed");
  console.log(root);
} finally {
  rmSync(root, { recursive: true, force: true });
}
