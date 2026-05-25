#!/usr/bin/env node
// scripts/probe-721-persist.mjs
//
// Spec 721.J3 (persistence) — persistAssetJoin writes a Visual-Origin Join
// knowledge result into the ONE project store (entities + link_entities chain +
// finding) and it reads back. motm corpus, throwaway project dir (never a live
// store). Idempotent: persisting the same node-chain folds (deterministic ids),
// it does not duplicate.

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOTM = "/Users/alex/Development/C64/Cracking/Murder/motm.g64";

let resolveVisualOrigin, extractSpriteCandidates, resolveVisibleNodeAt, persistAssetJoin, ProjectKnowledgeService;
try {
  ({ resolveVisualOrigin } = await import("../dist/runtime/headless/inspect/asset-origin.js"));
  ({ extractSpriteCandidates } = await import("../dist/runtime/headless/inspect/asset-extract.js"));
  ({ resolveVisibleNodeAt } = await import("../dist/runtime/headless/inspect/vic-inspect.js"));
  ({ persistAssetJoin } = await import("../dist/workspace-ui/asset-join-persist.js"));
  ({ ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first"); console.error(e?.message ?? e); process.exit(1);
}

let passes = 0; const failures = [];
const gate = (n, ok, d) => { if (ok) { passes++; console.log(`  PASS  ${n}${d ? ` (${d})` : ""}`); } else { failures.push(n); console.log(`  FAIL  ${n}${d ? ` (${d})` : ""}`); } };

if (!existsSync(MOTM)) { console.error(`motm.g64 missing: ${MOTM}`); process.exit(1); }
const motm = new Uint8Array(readFileSync(MOTM));

console.log("Spec 721.J3 — persist Visual-Origin Join into the project store");

// exact_asset knowledge for a real motm sprite candidate, planted + resolved.
const cands = extractSpriteCandidates(motm, { artifactId: "motm", mediumRef: "g64" });
const c = [...cands].sort((a, b) => b.confidence - a.confidence)[0];
const block = motm.subarray(c.source.offset, c.source.offset + 64);
const regs = new Array(0x40).fill(0);
regs[0x18] = 0x14; regs[0x15] = 0x01; regs[0x00] = 88; regs[0x01] = 80; regs[0x27] = 0x01;
const ram = new Uint8Array(65536); ram[0x07f8] = 0x80; ram.set(block.subarray(0, 64), 0x2000);
const cp = { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };
const node = resolveVisibleNodeAt(cp, 100, 70);
const o = resolveVisualOrigin(cp, node, cands, { artifactId: "motm" });
gate("knowledge is exact_asset with a chain", o.result.classification === "exact_asset" && o.knowledge.relations.length >= 3, `${o.knowledge.relations.length} edges`);

const dir = mkdtempSync(join(tmpdir(), "c64re-721-persist-"));
const svc = new ProjectKnowledgeService(dir);

// persist once.
const r1 = persistAssetJoin(svc, o.knowledge, { artifactId: "motm" });
gate("persist returns entity ids", r1.entityIds.length >= 4, `${r1.entityIds.length}`);
gate("persist returns one relation per chain edge", r1.relationIds.length === o.knowledge.relations.length, `${r1.relationIds.length}/${o.knowledge.relations.length}`);
gate("persist returns a finding id", typeof r1.findingId === "string" && r1.findingId.length > 0);

// read back from a FRESH service instance (proves it hit disk, not memory).
const svc2 = new ProjectKnowledgeService(dir);
const ents = svc2.listEntities();
const rels = svc2.listRelations();
const finds = svc2.listFindings();
gate("entities persisted to disk", r1.entityIds.every((id) => ents.some((e) => e.id === id)), `${ents.length} total`);
gate("relations persisted to disk", r1.relationIds.every((id) => rels.some((x) => x.id === id)), `${rels.length} total`);
gate("relation chain has derived-from + contains (asset origin)", rels.some((x) => x.kind === "derived-from") && rels.some((x) => x.kind === "contains"));
gate("finding persisted to disk + links the chain", finds.some((f) => f.id === r1.findingId && (f.relationIds?.length ?? 0) === r1.relationIds.length));

// idempotent: persist the same chain again → deterministic ids fold, no dupes.
const before = svc2.listEntities().length;
const r2 = persistAssetJoin(svc2, o.knowledge, { artifactId: "motm" });
const after = new ProjectKnowledgeService(dir).listEntities().length;
gate("idempotent: re-persist folds entities (no duplicate nodes)", after === before && r2.entityIds.length === r1.entityIds.length, `${before}→${after}`);

console.log("---");
if (failures.length === 0) { console.log(`GREEN 721.J3 persist: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 721.J3 persist: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
