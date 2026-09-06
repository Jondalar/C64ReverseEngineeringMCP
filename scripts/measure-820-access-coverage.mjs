#!/usr/bin/env node
// Spec 820 — access-graph coverage over the field corpus (analysis/tmp/spec-816).
// A trend line, not a verdict: per report, the direct / indirect / hardware / ZP
// edge counts and the share of INDIRECT accesses that got a D3 resolution.
//
//   node scripts/measure-820-access-coverage.mjs [--json <out>]

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { seedControlFlow } = await import(join(ROOT, "dist/knowledge-graph/producers/control-flow.js"));
const { seedMemoryAccess } = await import(join(ROOT, "dist/knowledge-graph/producers/memory-access.js"));

const corpus = join(ROOT, "analysis/tmp/spec-816");
if (!existsSync(corpus)) { console.error("analysis/tmp/spec-816 absent — run npm run measure:816 first"); process.exit(2); }
const files = readdirSync(corpus).filter((f) => f.endsWith("_analysis.json") || f.endsWith(".analysis.json")).map((f) => join(corpus, f)).sort();

const project = mkdtempSync(join(tmpdir(), "c64re-820-measure-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
writeFileSync(join(project, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "m", name: "measure", slug: "m820", rootPath: project }));

const rows = [];
for (const f of files) {
  const owner = f.replace(/^.*\//, "").replace(/(_analysis|\.analysis)\.json$/, "").toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
  seedControlFlow({ projectDir: project, analysisPath: f, owner });
  const r = seedMemoryAccess({ projectDir: project, analysisPath: f, owner });
  const e = r.edges;
  const direct = (e.READS ?? 0) + (e.WRITES ?? 0);
  const indirect = (e.READS_INDIRECT ?? 0) + (e.WRITES_INDIRECT ?? 0);
  rows.push({ owner, direct, indirect, hardware: e.USES_HARDWARE ?? 0, zp: e.USES_ZP ?? 0, data: e.REFERENCES_DATA ?? 0, resolved: r.indirectResolved, resolvedPct: indirect ? (100 * r.indirectResolved) / indirect : 0, ms: r.ms });
}

console.log("## Spec 820 — access-graph coverage\n");
console.log(`${"report".padEnd(46)} ${"direct".padStart(7)} ${"indir".padStart(6)} ${"hw".padStart(5)} ${"zp".padStart(6)} ${"data".padStart(5)} ${"resolved".padStart(9)}   ms`);
for (const r of rows) console.log(`${r.owner.padEnd(46)} ${String(r.direct).padStart(7)} ${String(r.indirect).padStart(6)} ${String(r.hardware).padStart(5)} ${String(r.zp).padStart(6)} ${String(r.data).padStart(5)} ${`${r.resolved}/${r.indirect}`.padStart(9)}   ${r.ms.toFixed(0)}`);
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
console.log(`\n→ ${rows.length} reports: ${sum("direct")} direct, ${sum("indirect")} indirect (${sum("resolved")} resolved by a same-routine construction = ${(100 * sum("resolved") / Math.max(1, sum("indirect"))).toFixed(1)} %), ${sum("hardware")} hardware, ${sum("zp")} zp, ${sum("data")} data refs`);

const jsonIndex = process.argv.indexOf("--json");
if (jsonIndex >= 0) {
  const out = resolve(process.argv[jsonIndex + 1]);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`);
  console.log(`wrote ${out}`);
}
