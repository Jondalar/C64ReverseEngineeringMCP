#!/usr/bin/env node
// scripts/smoke-710-evidence-persist.mjs
//
// Spec 710.3/710.5 — UI/API persistence gate: a FrozenInspectEvidence record
// persists into the ONE project knowledge store via persistInspectEvidence →
// ProjectKnowledgeService.saveArtifact (the same call the workspace HTTP
// endpoint /api/vic-inspect-evidence makes). No HTTP server / no live UI needed.
//
// Exit 0 = PASS, 1 = FAIL.

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let ProjectKnowledgeService, persistInspectEvidence;
try {
  ({ ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js"));
  ({ persistInspectEvidence } = await import("../dist/workspace-ui/inspect-evidence-persist.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

let passes = 0;
const failures = [];
const gate = (name, ok, detail) => {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
};

console.log("Spec 710.3/710.5 — inspect-evidence persistence gate");

const root = mkdtempSync(join(tmpdir(), "c64re-710-persist-"));
try {
  const service = new ProjectKnowledgeService(root);

  const evidence = {
    checkpointId: "cp_test_0",
    mediaState: { kind: "none" },
    frame: {
      mode: "standard_text", bankBase: 0, screenBase: 0x400, charBase: 0x1000,
      charRomShadow: true, bitmapBase: 0, colorBase: 0xd800,
      regs: new Array(0x40).fill(0), border: 0, background: 6,
      displayWidth: 320, displayHeight: 200,
    },
    selectedNodes: [{
      type: "text_cell", pixel: { x: 4, y: 9 }, cell: { col: 0, row: 1, index: 40 },
      mode: "standard_text", value: 0x2a, colorIndex: 1,
      refs: [
        { kind: "screen_ram", addr: 0x428, length: 1, value: 0x2a },
        { kind: "charset", addr: 0x1150, length: 8, note: "char ROM shadow" },
      ],
    }],
  };

  const artifact = persistInspectEvidence(service, root, { evidence, name: "test cell", notes: "smoke" });

  gate("artifact persisted with kind=other scope=session", artifact?.kind === "other" && artifact?.scope === "session", `kind=${artifact?.kind} scope=${artifact?.scope}`);
  gate("tags include vic-inspect + spec-710", Array.isArray(artifact?.tags) && artifact.tags.includes("vic-inspect") && artifact.tags.includes("spec-710"), `tags=${artifact?.tags?.join(",")}`);
  gate("title carries the given name", typeof artifact?.title === "string" && artifact.title.includes("test cell"), artifact?.title);
  gate("path under knowledge/inspect-evidence/", typeof artifact?.path === "string" && artifact.path.replace(/\\/g, "/").includes("knowledge/inspect-evidence/"), artifact?.path);

  // backing file durable + parses back to the evidence (path derived from id)
  const backing = join(root, "knowledge", "inspect-evidence", `${artifact.id}.json`);
  gate("backing JSON file exists", existsSync(backing));
  if (existsSync(backing)) {
    const parsed = JSON.parse(readFileSync(backing, "utf8"));
    gate("backing file round-trips the evidence (checkpointId + name)", parsed.checkpointId === "cp_test_0" && parsed.name === "test cell" && parsed.selectedNodes?.length === 1);
  }

  // artifact registered durably in knowledge/artifacts.json
  const artifactsJson = join(root, "knowledge", "artifacts.json");
  gate("knowledge/artifacts.json written", existsSync(artifactsJson));
  if (existsSync(artifactsJson)) {
    const store = JSON.parse(readFileSync(artifactsJson, "utf8"));
    const items = store.artifacts ?? store.items ?? (Array.isArray(store) ? store : []);
    gate("artifact record present in the store (durable)", JSON.stringify(items).includes(artifact.id), `id=${artifact.id}`);
  }

  // malformed record rejected
  let threw = false;
  try { persistInspectEvidence(service, root, { evidence: { bogus: true } }); } catch { threw = true; }
  gate("malformed evidence record rejected", threw);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 710.3 evidence persist: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 710.3 evidence persist: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
