#!/usr/bin/env node
// scripts/probe-721-loaderpath.mjs
//
// Spec 721 — what a RUNTIME TRACE adds to the Sequence / Loader-Path views.
//
// The load-sequence view + loader path are built from PERSISTED entities,
// relations and findings (linked per stage by artifactId). So "does a trace
// improve the loader path" reduces to: does resolving an on-screen asset WITH a
// runtime trace persist MORE/RICHER knowledge than without?
//
// Same on-screen sprite, two runs, two throwaway projects:
//   NO TRACE  → runtime_generated → store gains a VisualElement + MemoryRange and
//               a "no static origin" finding. No loader stage, no source.
//   DuckDB TRACE → derived_asset → the trace writer PC becomes a Routine (the
//               loader stage), with writes/reads + derived-from + contains edges
//               back to the packed bytes on the medium. The loader path is now
//               causal: stage $C000 depacks sprite from medium $1000 → RAM $2000.
//
// Real motm bytes are the packed source. Asserts the WITH-trace delta.

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const MOTM = "/Users/alex/Development/C64/Cracking/Murder/motm.g64";

let resolveVisualOrigin, resolveVisibleNodeAt, persistAssetJoin, ProjectKnowledgeService,
    openTraceRunStore, closeTraceRunStore, loadTraceChainSourceFromDuckDb;
try {
  ({ resolveVisualOrigin } = await import("../dist/runtime/headless/inspect/asset-origin.js"));
  ({ resolveVisibleNodeAt } = await import("../dist/runtime/headless/inspect/vic-inspect.js"));
  ({ persistAssetJoin } = await import("../dist/workspace-ui/asset-join-persist.js"));
  ({ ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js"));
  ({ openTraceRunStore, closeTraceRunStore } = await import("../dist/runtime/headless/trace/trace-run-store.js"));
  ({ loadTraceChainSourceFromDuckDb } = await import("../dist/runtime/headless/inspect/asset-join-tracedb.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first"); console.error(e?.message ?? e); process.exit(1);
}

let passes = 0; const failures = [];
const gate = (n, ok, d) => { if (ok) { passes++; console.log(`  PASS  ${n}${d ? ` (${d})` : ""}`); } else { failures.push(n); console.log(`  FAIL  ${n}${d ? ` (${d})` : ""}`); } };
const sha = (b) => createHash("sha256").update(b).digest("hex");

if (!existsSync(MOTM)) { console.error(`motm.g64 missing: ${MOTM}`); process.exit(1); }
const motm = new Uint8Array(readFileSync(MOTM));

console.log("Spec 721 — runtime-trace delta on the loader path (motm corpus)");

// Real motm bytes = the PACKED source loaded to $8000; the on-screen sprite at
// $2000 is the UNPACKED result (no verbatim match → exact path can't see it).
const packed = motm.subarray(0x2000, 0x2000 + 40);
const unpacked = new Uint8Array(64).map((_, i) => (i * 91 + 5) & 0xff);
const packedCandidate = {
  id: "motm_packed_sprite", artifactId: "motm", kind: "sprite",
  source: { mediumRef: "motm.g64", offset: 0x1000, length: 40 },
  format: "sprite-exomizer", preview: { hash: sha(packed) }, confidence: 1,
};

function makeCp() {
  const regs = new Array(0x40).fill(0);
  regs[0x18] = 0x14; regs[0x15] = 0x01; regs[0x00] = 88; regs[0x01] = 80; regs[0x27] = 0x01;
  const ram = new Uint8Array(65536);
  ram[0x07f8] = 0x80;
  ram.set(unpacked, 0x2000);   // on-screen sprite = unpacked
  ram.set(packed, 0x8000);     // depack source in RAM
  return { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };
}
const cp = makeCp();
const node = resolveVisibleNodeAt(cp, 100, 70);

// snapshot what a project store gained from one persist.
const snapshot = (svc) => ({
  routines: svc.listEntities({ kind: "routine" }).length,
  rels: svc.listRelations().map((r) => r.kind),
});

// ---- NO TRACE: static loader path ----
const dirNo = mkdtempSync(join(tmpdir(), "c64re-721-lp-notrace-"));
const svcNo = new ProjectKnowledgeService(dirNo);
const oNo = resolveVisualOrigin(cp, node, [packedCandidate], { artifactId: "motm" });
persistAssetJoin(svcNo, oNo.knowledge, { artifactId: "motm" });
const snapNo = snapshot(svcNo);
gate("NO TRACE: classification is runtime_generated", oNo.result.classification === "runtime_generated", oNo.result.classification);
gate("NO TRACE: no loader-stage routine entity", snapNo.routines === 0, `${snapNo.routines} routines`);
gate("NO TRACE: only a maps-to edge (no causal chain)", snapNo.rels.every((k) => k === "maps-to"), snapNo.rels.join(","));

// ---- DuckDB TRACE: causal loader path ----
const store = await openTraceRunStore(":memory:");
let snapTr, oTr;
try {
  const ev = (op, addr, pc) => `('r1', 0, 0, 'io', 't', 'io-row', '{"op":"${op}","addr":${addr},"value":0,"pc":${pc}}')`;
  const rows = [ev("write", 0x2000, 0xc000)];
  for (let a = 0x8000; a < 0x8028; a++) rows.push(ev("read", a, 0xc000)); // loader $C000 reads packed source $8000..$8027
  await store.conn.run(`INSERT INTO trace_event VALUES ${rows.join(", ")}`);
  const source = await loadTraceChainSourceFromDuckDb(store, "r1");

  const dirTr = mkdtempSync(join(tmpdir(), "c64re-721-lp-trace-"));
  const svcTr = new ProjectKnowledgeService(dirTr);
  oTr = resolveVisualOrigin(cp, node, [packedCandidate], { artifactId: "motm" }, source);
  persistAssetJoin(svcTr, oTr.knowledge, { artifactId: "motm" });
  snapTr = snapshot(svcTr);
} finally { await closeTraceRunStore(store); }

gate("TRACE: classification upgrades to derived_asset", oTr.result.classification === "derived_asset", oTr.result.classification);
gate("TRACE: writer PC = loader stage $c000", JSON.stringify(oTr.result.chain).includes("49152"));
gate("TRACE: adds a loader-stage routine entity", snapTr.routines >= 1, `${snapTr.routines} routines`);
gate("TRACE: adds writes/reads attribution edges", snapTr.rels.includes("writes") && snapTr.rels.includes("reads"), snapTr.rels.join(","));
gate("TRACE: adds derived-from + contains (source on medium)", snapTr.rels.includes("derived-from") && snapTr.rels.includes("contains"));
gate("TRACE: strictly richer than no-trace", snapTr.rels.length > snapNo.rels.length && snapTr.routines > snapNo.routines, `rels ${snapNo.rels.length}→${snapTr.rels.length}, routines ${snapNo.routines}→${snapTr.routines}`);

console.log("---");
console.log(`  DELTA  no-trace:  ${snapNo.rels.length} edges [${snapNo.rels.join(",")}], ${snapNo.routines} loader routine(s)`);
console.log(`  DELTA  with-trace: ${snapTr.rels.length} edges [${snapTr.rels.join(",")}], ${snapTr.routines} loader routine(s)`);
console.log(`  evidence (trace): ${oTr.result.evidence}`);
if (failures.length === 0) { console.log(`GREEN 721 loader-path: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 721 loader-path: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
