#!/usr/bin/env node
// Spec 821 — the gate that runs against a REAL `.c64retrace`, not one it wrote itself
// (precedent: e2e-750-real.mjs). There is no checked-in capture: `traces/` is
// gitignored and a capture names the media it ran. So this one reads what is on
// this machine and SKIPS LOUDLY otherwise.
//
//   C64RE_821_CAPTURE=/path/run.c64retrace          the capture (TRX64: trx64cli … --trace run.c64retrace --trace-domains c64-cpu,memory)
//   C64RE_821_ANALYSIS=/path/<image>_analysis.json   optional — seeds 819's routines first, so pcs resolve to routines
//   C64RE_821_CAPTURE_LARGE=/path/big.c64retrace     optional — a second, larger capture for the RSS-does-not-scale check
//
// Without the env, the two local working files this repo's own gates left behind are
// used when present (`traces/e2e746.c64retrace` 42 MB, `traces/leak-gate.c64retrace`
// 266 MB) — they are not fixtures and are never committed.
//
// Exit 0 = pass (or skipped), 1 = fail.   npm run e2e:821-real

import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

process.env.C64RE_RUNTIME_ENDPOINT = "ws://127.0.0.1:1";
process.env.C64RE_RUNTIME_AUTOSTART = "0";
const ROOT = resolve(import.meta.dirname, "..");
const local = (p) => (existsSync(join(ROOT, p)) ? join(ROOT, p) : undefined);
const CAPTURE = process.env.C64RE_821_CAPTURE ?? local("traces/e2e746.c64retrace");
const ANALYSIS = process.env.C64RE_821_ANALYSIS;
const LARGE = process.env.C64RE_821_CAPTURE_LARGE ?? local("traces/leak-gate.c64retrace");

if (!CAPTURE || !existsSync(CAPTURE)) {
  console.log("  SKIPPED — no real capture on this machine.");
  console.log("  Mint one, isolated, no daemon:");
  console.log("    trx64cli --rom-dir <roms> boot --disk <image> --cycles 30000000 \\");
  console.log("      --trace run.c64retrace --trace-domains c64-cpu,memory --dump /tmp/x.c64re");
  console.log("  then: C64RE_821_CAPTURE=run.c64retrace [C64RE_821_ANALYSIS=<image>_analysis.json] npm run e2e:821-real");
  console.log("  A capture names the media it ran and is never committed (traces/ is gitignored).");
  console.log("\nGREEN  821 real-trace: skipped (no capture).");
  process.exit(0);
}

const { runtimeDaemon } = await import(join(ROOT, "dist/runtime/daemon-client.js"));
let traceReadCalls = 0;
runtimeDaemon.traceRead = async () => { traceReadCalls += 1; throw new Error("trace/read must not be called"); };
const { importRuntimeTrace } = await import(join(ROOT, "dist/knowledge-graph/producers/runtime.js"));
const { seedControlFlow } = await import(join(ROOT, "dist/knowledge-graph/producers/control-flow.js"));
const { GraphStore } = await import(join(ROOT, "dist/knowledge-graph/store.js"));
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));
const { pointerTargets, unexplained, irqHandlers, runs } = await import(join(ROOT, "dist/knowledge-graph/query-runtime.js"));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ""}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
};
const mb = (b) => (b / 1048576).toFixed(1);

const project = mkdtempSync(join(tmpdir(), "c64re-821-real-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
writeFileSync(join(project, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "r", name: "821 real", slug: "real821", rootPath: project }));

let owner;
if (ANALYSIS && existsSync(ANALYSIS)) {
  const s = seedControlFlow({ projectDir: project, analysisPath: ANALYSIS });
  owner = s.owner;
  console.log(`  info  819 seeded from ${basename(ANALYSIS)}: routines=${s.routines} labels=${s.labels} edges=${JSON.stringify(s.edges)}`);
} else {
  console.log("  info  no C64RE_821_ANALYSIS — no routines; every pc attaches to an addr node (nothing dropped, nothing attributed)");
}

const size = statSync(CAPTURE).size;
const r = importRuntimeTrace({ projectDir: project, tracePath: CAPTURE, owner, analysisPath: ANALYSIS && existsSync(ANALYSIS) ? ANALYSIS : undefined });
const totalRows = Object.values(r.rows).reduce((a, b) => a + b, 0) - r.rows.collapsedSpans;
console.log(`  info  ${basename(CAPTURE)}: ${mb(size)} MB, v${r.formatVersion}, ${r.eventCount} events, ${r.cpuSteps} steps, ${r.accesses} accesses, ${r.distinctPcs} distinct pcs`);
console.log(`  info  rows=${JSON.stringify(r.rows)} addr-nodes=${r.addrNodes} collapsed-pcs=${r.collapsedPcs} irq=${r.irqEntries} nmi=${r.nmiEntries} pc_source=${r.pcSource}`);
console.log(`  info  import ${r.ms.toFixed(0)} ms, peak RSS ${r.peakRssMb.toFixed(0)} MB (${(r.eventCount / (r.ms / 1000) / 1e6).toFixed(1)} M events/s)`);
ok("the capture imports through the streaming reader, no daemon", traceReadCalls === 0 && r.pcSource === "retire", `trace/read calls=${traceReadCalls}, pc_source=${r.pcSource}`);
ok("row count printed (OQ1 measured)", totalRows > 0, `${totalRows} rows for ${r.accesses} accesses`);

const graph = Graph.open(project);
const db = graph.store.db;
const bad = Number(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE producer='821' AND (origin<>'runtime' OR confidence<>'observed' OR layer<>'generated')").get().n);
ok("invariant: every 821 row is runtime · observed · generated", bad === 0, `${bad} violations`);

// every runtime edge's from is a routine or an addr node (nothing dropped), and a pc no routine
// contains is exactly the addr-node case
const froms = db.prepare("SELECT DISTINCT from_id FROM edges WHERE producer='821' AND type IN ('READS','WRITES')").all().map((x) => x.from_id);
const unresolved = froms.filter((id) => { const n = graph.resolve(id); return n.dangling || (n.kind !== "routine" && n.kind !== "addr"); });
ok("every runtime access edge starts at a routine or an addr node", unresolved.length === 0, `${froms.length} sources, ${r.unattributedPcs} pcs outside any routine`);
if (owner) ok("with routines seeded, most pcs resolve to a routine", r.unattributedPcs < r.distinctPcs / 2, `${r.unattributedPcs}/${r.distinctPcs} unattributed`);

// the trend: what the static side did not explain
const ux = unexplained(graph, r.runId);
const byNote = {};
for (const o of ux) byNote[o.note] = (byNote[o.note] ?? 0) + 1;
console.log(`  info  unexplained(run): ${ux.length} rows ${JSON.stringify(byNote)}`);
for (const o of ux.slice(0, 8)) console.log(`        ${o.type.padEnd(6)} pc=$${o.pc?.toString(16).toUpperCase().padStart(4, "0")} ea=$${o.ea?.toString(16).toUpperCase().padStart(4, "0")}${o.spanEnd ? `-$${o.spanEnd.toString(16).toUpperCase().padStart(4, "0")}` : ""} count=${o.count} ${o.note}`);

// pointer targets on the busiest pointer pair collapse to few spans
const busiest = db.prepare("SELECT json_extract(evidence,'$.via_zp') AS zp, COUNT(*) AS n FROM edges WHERE producer='821' AND type IN ('READS','WRITES') AND json_extract(evidence,'$.via_zp') IS NOT NULL GROUP BY zp ORDER BY n DESC LIMIT 1").get();
if (busiest) {
  const pt = pointerTargets(graph, busiest.zp).find((p) => p.runId === r.runId);
  const spans = pt?.spans ?? [];
  console.log(`  info  pointerTargets($${busiest.zp.toString(16).toUpperCase().padStart(2, "0")}): ${pt?.rows ?? 0} rows → ${spans.length} spans; first: ${spans.slice(0, 3).map((s) => `$${s.start.toString(16).toUpperCase()}-$${s.end.toString(16).toUpperCase()} (${s.count} accesses, ${s.distinct} distinct)`).join(", ")}`);
  ok("the busiest pointer pair collapses to ≤ 64 spans", spans.length > 0 && spans.length <= 64, `${spans.length}`);
} else {
  console.log("  info  no indirect access in this capture — pointerTargets not exercised");
}
const irqs = irqHandlers(graph, { run: r.runId });
console.log(`  info  irqHandlers: ${irqs.map((e) => `${e.type} → ${e.to} ×${e.evidence.count}`).join("; ") || "(none)"}`);
ok("runs() lists the run", runs(graph).some((x) => x.runId === r.runId));
graph.close();

// idempotence on the real file
const s1 = GraphStore.open(project); const h1 = s1.contentHash(); s1.close();
importRuntimeTrace({ projectDir: project, tracePath: CAPTURE, owner, analysisPath: ANALYSIS && existsSync(ANALYSIS) ? ANALYSIS : undefined });
const s2 = GraphStore.open(project); const h2 = s2.contentHash(); s2.close();
ok("importing the real capture twice yields an identical canonical dump", h1 === h2, h1.slice(0, 16));

// RSS must not scale with file size
if (LARGE && existsSync(LARGE) && LARGE !== CAPTURE) {
  const lsize = statSync(LARGE).size;
  const project2 = mkdtempSync(join(tmpdir(), "c64re-821-real-large-"));
  mkdirSync(join(project2, "knowledge"), { recursive: true });
  writeFileSync(join(project2, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "l", name: "821 large", slug: "real821l", rootPath: project2 }));
  const rl = importRuntimeTrace({ projectDir: project2, tracePath: LARGE });
  const rowsL = Object.values(rl.rows).reduce((a, b) => a + b, 0) - rl.rows.collapsedSpans;
  console.log(`  info  ${basename(LARGE)}: ${mb(lsize)} MB, ${rl.eventCount} events → ${rowsL} rows, ${rl.ms.toFixed(0)} ms, peak RSS ${rl.peakRssMb.toFixed(0)} MB`);
  const sizeRatio = lsize / size;
  const rssRatio = rl.peakRssMb / r.peakRssMb;
  ok("peak RSS does not scale with file size", rssRatio < Math.max(2, sizeRatio / 2), `size ×${sizeRatio.toFixed(1)}, RSS ×${rssRatio.toFixed(2)}`);
} else {
  console.log("  info  no second (larger) capture — RSS-vs-size not measured (C64RE_821_CAPTURE_LARGE)");
}

console.log(`\n${fails.length ? "RED" : "GREEN"}  821 real-trace: ${pass} pass, ${fails.length} fail.  project: ${project}`);
process.exit(fails.length ? 1 : 0);
