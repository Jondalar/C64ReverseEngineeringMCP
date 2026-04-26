// Rebuild the polarbear-in-space example with real game binaries.
// Reads samples/POLARBEAR.d64 (gitignored), extracts the largest PRG, runs
// the full analyze + disasm + reports pipeline, then re-imports knowledge
// via ProjectKnowledgeService and rebuilds all views.
//
// The output overwrites examples/polarbear-in-space-example/. Inputs and
// generated artifacts get larger (~250 KB) — commit at your discretion.
//
// Run from repo root after `npm run build`:
//   node scripts/refresh-polarbear-real.mjs

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const SAMPLE_D64 = join(REPO_ROOT, "samples", "POLARBEAR.d64");
const EXAMPLE_ROOT = join(REPO_ROOT, "examples", "polarbear-in-space-example");

if (!existsSync(SAMPLE_D64)) {
  console.error(`samples/POLARBEAR.d64 not found at ${SAMPLE_D64}`);
  process.exit(1);
}

const { extractDiskImage } = await import(join(REPO_ROOT, "dist", "disk-extractor.js"));
const { ProjectKnowledgeService } = await import(join(REPO_ROOT, "dist", "project-knowledge", "service.js"));

// 1) Replace the stub D64 with the real one.
const realD64 = join(EXAMPLE_ROOT, "input", "disk", "polarbear-in-space.d64");
copyFileSync(SAMPLE_D64, realD64);
console.log(`Copied real D64 → ${realD64}`);

// 2) Extract the disk into artifacts/extracted/polarbear-disk/.
const extractDir = join(EXAMPLE_ROOT, "artifacts", "extracted", "polarbear-disk");
const manifest = extractDiskImage(realD64, extractDir);
console.log(`Extracted ${manifest.files.length} files to ${extractDir}`);

// 3) Pick the largest PRG file as the analysis target.
const mainFile = [...manifest.files].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
if (!mainFile) {
  throw new Error("Disk extract produced no files.");
}
const mainAbsPath = join(extractDir, mainFile.relativePath);
console.log(`Selected main PRG: ${mainFile.relativePath} (${mainFile.sizeBytes} B, load=$${(mainFile.loadAddress ?? 0).toString(16).toUpperCase()})`);

// 4) Copy main PRG into input/prg/ as the canonical example PRG.
const realPrg = join(EXAMPLE_ROOT, "input", "prg", "polarbear-in-space.prg");
copyFileSync(mainAbsPath, realPrg);
console.log(`Copied main PRG → ${realPrg}`);

// 5) Run analyze-prg + disasm-prg + reports via the bundled pipeline CLI.
function runPipeline(args) {
  const cliPath = join(REPO_ROOT, "dist", "pipeline", "cli.cjs");
  execFileSync(process.execPath, [cliPath, ...args], { stdio: "inherit" });
}

const analysisJson = join(EXAMPLE_ROOT, "analysis", "polarbear-in-space_analysis.json");
const generatedAsm = join(EXAMPLE_ROOT, "artifacts", "generated-src", "polarbear-in-space_disasm.asm");
const ramReport = join(EXAMPLE_ROOT, "artifacts", "reports", "polarbear-in-space_RAM_STATE_FACTS.md");
const pointerReport = join(EXAMPLE_ROOT, "artifacts", "reports", "polarbear-in-space_POINTER_TABLE_FACTS.md");

console.log("Running analyze-prg...");
runPipeline(["analyze-prg", realPrg, analysisJson]);
console.log("Running disasm-prg...");
runPipeline(["disasm-prg", realPrg, generatedAsm, "", analysisJson]);
console.log("Running ram-report...");
runPipeline(["ram-report", analysisJson, ramReport]);
console.log("Running pointer-report...");
runPipeline(["pointer-report", analysisJson, pointerReport]);

// 6) Refresh project knowledge: re-import analysis + manifest, rebuild views.
const service = new ProjectKnowledgeService(EXAMPLE_ROOT);
const artifacts = service.listArtifacts();
const analysisArtifact = artifacts.find((artifact) => artifact.role === "analysis-json");
const diskManifestArtifact = artifacts.find((artifact) => artifact.role === "disk-manifest");
if (!analysisArtifact || !diskManifestArtifact) {
  throw new Error("Polarbear example is missing the analysis-json or disk-manifest artifact.");
}

const analysisImport = service.importAnalysisArtifact(analysisArtifact.id);
const diskImport = service.importManifestArtifact(diskManifestArtifact.id);
const views = service.buildAllViews();

console.log("");
console.log("Knowledge refresh complete.");
console.log(`  Analysis import: ${analysisImport.importedEntityCount} entities, ${analysisImport.importedFindingCount} findings, ${analysisImport.importedRelationCount} relations, ${analysisImport.importedFlowCount} flows, ${analysisImport.importedOpenQuestionCount} open questions`);
console.log(`  Disk import: ${diskImport.importedEntityCount} entities, ${diskImport.importedFindingCount} findings, ${diskImport.importedRelationCount} relations`);
console.log(`  Views rebuilt:`);
console.log(`    project dashboard: ${views.projectDashboard.path}`);
console.log(`    memory map:        ${views.memoryMap.path}`);
console.log(`    disk layout:       ${views.diskLayout.path}`);
console.log(`    cartridge layout:  ${views.cartridgeLayout.path}`);
console.log(`    load sequence:     ${views.loadSequence.path}`);
console.log(`    flow graph:        ${views.flowGraph.path}`);
console.log(`    annotated listing: ${views.annotatedListing.path}`);

// 7) Quick sanity check against /api/graphics logic.
const reportRaw = JSON.parse(readFileSync(analysisJson, "utf8"));
const segs = reportRaw.segments ?? [];
const tally = {};
for (const s of segs) tally[s.kind] = (tally[s.kind] ?? 0) + 1;
console.log("  segment kind tally:", tally);

const graphicsKinds = new Set(["sprite", "charset", "charset_source", "bitmap", "hires_bitmap", "multicolor_bitmap", "bitmap_source", "screen_ram", "screen_source", "color_source"]);
const graphicsCount = segs.filter((s) => graphicsKinds.has(s.kind)).length;
console.log(`  graphics segments visible to /api/graphics: ${graphicsCount}`);
