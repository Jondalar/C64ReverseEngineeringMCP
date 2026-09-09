#!/usr/bin/env node
// Spec 832 — D5 (machine output is not human debt) and D6 (an id may not assert
// a fact it no longer holds).
//
// Hermetic: one temp project, the knowledge service and the registration-delta
// library called directly. No daemon, no ROMs, no network, no media — both
// defects are decided on this side of the wire, so they can be checked here.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:832-ids

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 832 — D5 tool output is not debt, D6 an id does not describe\n");

const { ProjectKnowledgeService } = await import(join(ROOT, "dist/project-knowledge/service.js"));
const { scanRegistrationDelta, listCandidateFiles, toolOwnerOf } =
  await import(join(ROOT, "dist/lib/registration-delta.js"));
const { auditProject } = await import(join(ROOT, "dist/project-knowledge/audit.js"));

const project = mkdtempSync(join(tmpdir(), "c64re-832-"));
const service = new ProjectKnowledgeService(project);
service.initProject({ name: "Spec 832 fixture", description: "D5 + D6", tags: ["e2e"] });

// =====================================================================  D6
// An id identifies; it does not describe. The reporter typed $3E73 for $3E83,
// corrected it, and the id went on claiming 3e73 for ever.

const ARTIFACT = "artifact-ultima-vi-boot-abc123";
const STALE = (0x3e73).toString(16); // "3e73"
const FIXED = (0x3e83).toString(16); // "3e83"

const first = service.declareLoaderEntryPoint({
  artifactId: ARTIFACT,
  address: 0x3e73,
  kind: "sector-load",
  name: "chunk_read",
});
check(!first.id.includes(STALE), `a new id carries NO address (${first.id})`);
check(first.id.startsWith("loader-ep-"), "…and keeps the loader-ep prefix, so nothing that reads the shape breaks");
check(first.id.includes("artifact-ultima-vi-boot"), "…and is derived from the ARTIFACT, which does not change under it");

// The correction: same record, right address.
const corrected = service.declareLoaderEntryPoint({
  id: first.id,
  artifactId: ARTIFACT,
  address: 0x3e83,
  kind: "sector-load",
  name: "chunk_read",
});
check(corrected.id === first.id, "re-declaring with the id returns the SAME record, id untouched");
check(corrected.address === 0x3e83, "the address field is corrected");
check(!corrected.id.includes(STALE) && !corrected.id.includes(FIXED),
  `no address, stale or current, appears anywhere in the id (${corrected.id})`);
check(service.listLoaderEntryPoints(ARTIFACT).length === 1, "…and no second record was minted by the correction");

const persisted = service.listLoaderEntryPoints(ARTIFACT)[0];
check(persisted.id === first.id && persisted.address === 0x3e83,
  "the stored record agrees: one id, the corrected address");

// Two entry points on ONE artifact must still be two records.
const second = service.declareLoaderEntryPoint({
  artifactId: ARTIFACT,
  address: 0x4000,
  kind: "dispatch",
  name: "dispatch_trampoline",
});
check(second.id !== first.id, `two entry points on one artifact get different ids (${second.id})`);
check(service.listLoaderEntryPoints(ARTIFACT).length === 2, "…and both are stored");
check(!second.id.includes((0x4000).toString(16)), "the second id carries no address either");

// A pre-832 id — the address baked in — must survive verbatim. Rewriting ids
// would break every stored reference, which is exactly what D6 refuses to do.
const LEGACY = "loader-ep-artifact-legacy-3e73-abc123";
const legacy = service.declareLoaderEntryPoint({
  id: LEGACY,
  artifactId: "artifact-legacy-xyz",
  address: 0x3e73,
  kind: "init",
});
check(legacy.id === LEGACY, "an existing id supplied by the caller is preserved VERBATIM");
const legacyAgain = service.declareLoaderEntryPoint({
  id: LEGACY,
  artifactId: "artifact-legacy-xyz",
  address: 0x3e83,
  kind: "init",
});
check(legacyAgain.id === LEGACY && legacyAgain.address === 0x3e83,
  "…and keeps its shape across a correction — a legacy id is not rewritten");

// =====================================================================  D5
// 4 101 sector dumps a tool wrote are not 4 101 things a human must register.

const write = (rel, body) => {
  const abs = join(project, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  return rel;
};

// What extract_g64_sectors writes: analysis/g64/<image>/track-N/*.bin.
const sectors = [];
for (let s = 0; s < 17; s += 1) {
  sectors.push(write(`analysis/g64/dungeon/track-32/sector-${String(s).padStart(2, "0")}.bin`, Buffer.alloc(256)));
}
// The manifest the tool writes to STAND FOR the bulk — still ordinary debt.
const manifest = write("analysis/g64/dungeon/track-32/track-metadata.json", "{}\n");
// A carved payload (Spec 832 §6 names analysis/carved as tool-owned).
const carved = write("analysis/carved/block-3e83.prg", Buffer.from([0x00, 0x30, 0xa9, 0x00]));
// And a file a HUMAN dropped, in a directory no tool owns.
const stray = write("analysis/scratch/hand-notes.prg", Buffer.from([0x01, 0x08, 0x60]));
const strayDoc = write("docs/by-hand.md", "# a note somebody left\n");

const delta = scanRegistrationDelta(project, 500);

check(delta.toolOutputCount === sectors.length + 1,
  `the ${sectors.length} sector dumps + the carved block are TOOL OUTPUT (${delta.toolOutputCount})`);
check(sectors.every((rel) => delta.toolOutput.includes(rel)), "every sector dump is listed as tool output");
check(delta.toolOutput.includes(carved), "the carved block is listed as tool output");
check(delta.toolOutputByDir["analysis/g64"] === sectors.length,
  `tool output is attributed to the directory that owns it (analysis/g64 = ${delta.toolOutputByDir["analysis/g64"]})`);
check(delta.toolOutputByDir["analysis/carved"] === 1, "…and analysis/carved is attributed separately");

check(!delta.unregistered.some((rel) => sectors.includes(rel)),
  "NOT ONE sector dump is counted as an unregistered file — that count stood at 4 101 for ever");
check(!delta.unregistered.includes(carved), "…nor is the carved block");
check(delta.unregistered.includes(stray),
  "a stray hand-dropped file in a non-tool directory IS still reported (analysis/scratch/hand-notes.prg)");
check(delta.unregistered.includes(strayDoc), "…and so is a hand-written note under docs/");
check(delta.unregistered.includes(manifest),
  "the run's MANIFEST stays actionable debt — it is the artifact that stands for the bulk");

check(delta.totalCandidates >= delta.unregisteredCount + delta.toolOutputCount,
  "the total still counts every file scanned — the count stays visible, it is not hidden");

// The catch-up tool must still SEE tool output: an operator's explicit glob is
// how a tool-owned directory gets registered on purpose.
const candidates = listCandidateFiles(project);
check(sectors.every((rel) => candidates.includes(rel)) && candidates.includes(carved),
  "register_existing_files still enumerates tool output, so an explicit glob can register it");

// The classifier itself, on the two shapes it has to tell apart.
check(toolOwnerOf("analysis/g64/dungeon/track-32/sector-00.bin")?.tool === "extract_g64_sectors",
  "toolOwnerOf names the tool that wrote the file");
check(toolOwnerOf("analysis/g64/dungeon/track-32/track-metadata.json") === undefined,
  "…and refuses to claim the manifest inside a tool-owned directory");
check(toolOwnerOf("analysis/scratch/hand-notes.prg") === undefined,
  "…and claims nothing outside a tool-owned directory");

// The audit is where the reporter met this. Two findings, addressed to two
// different readers — and the debt one is NOT deleted.
const audit = auditProject(project, { includeFileScan: true, registrationSampleLimit: 500 });
const debt = audit.findings.find((f) => f.id === "unregistered-files");
const toolFinding = audit.findings.find((f) => f.id === "tool-output-files");
check(debt !== undefined, "the unregistered-files finding still exists — hiding it was never the fix");
check(debt && !debt.paths.some((p) => sectors.includes(p)), "…and no sector dump appears in it");
check(debt && debt.paths.includes(stray), "…while the hand-dropped file does");
check(toolFinding !== undefined, "a separate tool-output-files finding reports the machine's side");
check(toolFinding?.severity === "low", "…at low severity: it is a fact about the project, not a defect");
check(toolFinding?.paths.some((p) => p.startsWith("analysis/g64/**")),
  "…summarised per owning directory, not as 4 101 individual lines");
check(/manifest/i.test(toolFinding?.suggestedFix ?? ""),
  "…and its advice is the one thing that IS actionable: register the manifest");
check(audit.counts.toolOutputFiles === delta.toolOutputCount,
  `counts.toolOutputFiles carries the number (${audit.counts.toolOutputFiles})`);
check(audit.counts.unregisteredFiles === delta.unregisteredCount,
  "counts.unregisteredFiles is now the human-actionable number only");

rmSync(project, { recursive: true, force: true });
console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 832 D5+D6: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
