#!/usr/bin/env node
// scripts/probe-721-j3.mjs
//
// Spec 721.J3 — knowledge result: AssetJoinResult → relation chain
// (VisualElement→MemoryRange→Routine→ArtifactRange→MediaRegion) + annotation
// proposals (routine + data labels) with evidence refs. Pure mapping is gated
// deterministically; the summary finding persists durably into a temp
// ProjectKnowledgeStore (same store, no new model).

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let assetJoinToKnowledge, ProjectKnowledgeService;
try {
  ({ assetJoinToKnowledge } = await import("../dist/runtime/headless/inspect/asset-join-knowledge.js"));
  ({ ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

let passes = 0; const failures = [];
const gate = (name, ok, detail) => {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
};
const rel = (k, fromKind, toKind) => k.relations.find((r) => r.relation === fromKind && r.from.kind && (!toKind || r.to.kind === toKind));
const hasRel = (k, fromKind, relation, toKind) => k.relations.some((r) => r.from.kind === fromKind && r.relation === relation && r.to.kind === toKind);

console.log("Spec 721.J3 — Visual-Origin Join → knowledge");

const ctx = { artifactId: "art", traceRef: "r1" };

// ---- exact_asset ----
{
  const r = { classification: "exact_asset", memoryRange: { addr: 0x2000, length: 64 }, ramHash: "deadbeef0000", candidate: { id: "asset_sprite_0", artifactId: "art", kind: "sprite", source: { fileRef: "title.prg", offset: 0x2000, length: 64 }, format: "sprite-24x21", confidence: 1 }, evidence: "RAM $2000..+64 == asset_sprite_0" };
  const k = assetJoinToKnowledge(r, ctx);
  gate("exact: VisualElement maps-to MemoryRange", hasRel(k, "VisualElement", "maps-to", "MemoryRange"));
  gate("exact: MemoryRange derived-from ArtifactRange", hasRel(k, "MemoryRange", "derived-from", "ArtifactRange"));
  gate("exact: data label annotation (verbatim) w/ evidence", k.annotations.some((a) => a.kind === "label" && /verbatim/.test(a.comment) && a.evidence.length > 0));
  gate("exact: finding tagged exact_asset + addressRange", k.finding.tags.includes("exact_asset") && k.finding.addressRange?.start === 0x2000);
}

// ---- derived_asset (depack) ----
{
  const r = {
    classification: "derived_asset", memoryRange: { addr: 0x2000, length: 64 }, ramHash: "cafe0000",
    candidate: { id: "asset_packed_0", artifactId: "art", kind: "sprite", source: { mediumRef: "title.d64", offset: 0x1000, length: 40 }, format: "sprite-exomizer", confidence: 1 },
    chain: { steps: [{ kind: "writer", pc: 0xc000, to: { addr: 0x2000, length: 64 } }, { kind: "depack", pc: 0xc000, from: { addr: 0x8000, length: 40 }, to: { addr: 0x2000, length: 64 }, source: "asset_packed_0" }] },
    evidence: "depack by $c000: $2000 ⇐ $8000 == asset_packed_0",
  };
  const k = assetJoinToKnowledge(r, ctx);
  gate("derived: full chain incl Routine writes + reads + MediaRegion", hasRel(k, "MemoryRange", "derived-from", "ArtifactRange") && hasRel(k, "Routine", "writes", "MemoryRange") && hasRel(k, "Routine", "reads", "ArtifactRange") && hasRel(k, "ArtifactRange", "contains", "MediaRegion"));
  gate("derived: routine annotation 'depacks …'", k.annotations.some((a) => a.kind === "routine" && /depacks/.test(a.comment) && a.addr === 0xc000));
  gate("derived: finding tagged derived_asset", k.finding.tags.includes("derived_asset"));
}

// ---- runtime_generated ----
{
  const r = { classification: "runtime_generated", memoryRange: { addr: 0x3000, length: 64 }, ramHash: "0000", evidence: "no exact match + no chain" };
  const k = assetJoinToKnowledge(r, ctx);
  gate("runtime_generated: only VisualElement→MemoryRange (no asset relations)", k.relations.length === 1 && hasRel(k, "VisualElement", "maps-to", "MemoryRange"));
  gate("runtime_generated: honest segment annotation (no static origin)", k.annotations.some((a) => a.kind === "segment" && /no static asset origin/.test(a.comment)));
  gate("runtime_generated: no candidate-bearing relations", !k.relations.some((rr) => rr.to.kind === "ArtifactRange"));
}

// ---- persist the join finding durably ----
const root = mkdtempSync(join(tmpdir(), "c64re-721-j3-"));
try {
  const svc = new ProjectKnowledgeService(root);
  const k = assetJoinToKnowledge({ classification: "exact_asset", memoryRange: { addr: 0x2000, length: 64 }, ramHash: "deadbeef", candidate: { id: "asset_sprite_0", artifactId: "art", kind: "sprite", source: { fileRef: "title.prg", offset: 0x2000, length: 64 }, format: "sprite-24x21", confidence: 1 }, evidence: "RAM == asset_sprite_0" }, ctx);
  const f = svc.saveFinding({ kind: k.finding.kind, title: k.finding.title, summary: k.finding.summary, tags: k.finding.tags, addressRange: k.finding.addressRange });
  gate("persist: saveFinding returns a record", !!f?.id);
  const fj = join(root, "knowledge", "findings.json");
  gate("persist: finding durable in findings.json", existsSync(fj) && readFileSync(fj, "utf8").includes(f.id));
  gate("persist: finding carries asset-join tags", readFileSync(fj, "utf8").includes("asset-join"));
} finally { try { rmSync(root, { recursive: true, force: true }); } catch {} }

console.log("---");
if (failures.length === 0) { console.log(`GREEN 721.J3: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 721.J3: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
