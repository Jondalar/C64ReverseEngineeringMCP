import { resolve } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const projectRoot = resolve("examples/polarbear-in-space-example");
const service = new ProjectKnowledgeService(projectRoot);
const artifacts = service.listArtifacts();

const analysisArtifact = artifacts.find((artifact) => artifact.role === "analysis-json");
const crtManifestArtifact = artifacts.find((artifact) => artifact.role === "crt-manifest");
const diskManifestArtifact = artifacts.find((artifact) => artifact.role === "disk-manifest");

if (!analysisArtifact || !crtManifestArtifact || !diskManifestArtifact) {
  throw new Error("Polarbear example is missing one or more required artifacts.");
}

const analysisImport = service.importAnalysisArtifact(analysisArtifact.id);
const crtImport = service.importManifestArtifact(crtManifestArtifact.id);
const diskImport = service.importManifestArtifact(diskManifestArtifact.id);
const views = service.buildAllViews();

console.log(`Refreshed example at ${projectRoot}`);
console.log(`Analysis import: ${analysisImport.importedEntityCount} entities, ${analysisImport.importedFindingCount} findings, ${analysisImport.importedRelationCount} relations, ${analysisImport.importedFlowCount} flows, ${analysisImport.importedOpenQuestionCount} open questions`);
console.log(`CRT import: ${crtImport.importedEntityCount} entities, ${crtImport.importedFindingCount} findings, ${crtImport.importedRelationCount} relations`);
console.log(`Disk import: ${diskImport.importedEntityCount} entities, ${diskImport.importedFindingCount} findings, ${diskImport.importedRelationCount} relations`);
console.log(`Views: ${views.projectDashboard.path}, ${views.memoryMap.path}, ${views.diskLayout.path}, ${views.cartridgeLayout.path}, ${views.loadSequence.path}, ${views.flowGraph.path}, ${views.annotatedListing.path}`);
