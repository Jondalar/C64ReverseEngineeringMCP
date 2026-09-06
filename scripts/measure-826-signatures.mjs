#!/usr/bin/env node
// Spec 826 §5 — measure the signatures on Wasteland_EF (read-only: the graph
// there belongs to another session; this script never seeds or writes it).
// Without the project, or without 826 rows in it, it says so and measures
// the §5 fixture instead — so the numbers printed are always real numbers.
//
//   npm run measure:826            [C64RE_MEASURE_PROJECT=<dir> overrides the project]

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { Graph } = await import(join(ROOT, "dist/knowledge-graph/query.js"));
const { argsDomain, formatArgs, formatSignature, signatureOf } = await import(join(ROOT, "dist/knowledge-graph/query-signatures.js"));

const WASTELAND = process.env.C64RE_MEASURE_PROJECT ?? "/Users/alex/Development/C64/Cracking/Wasteland_EF";

async function buildFixture() {
  const { seedControlFlow } = await import(join(ROOT, "dist/knowledge-graph/producers/control-flow.js"));
  const { seedMemoryAccess } = await import(join(ROOT, "dist/knowledge-graph/producers/memory-access.js"));
  const { resolveAddresses } = await import(join(ROOT, "dist/knowledge-graph/producers/resolve.js"));
  const { seedSignatures } = await import(join(ROOT, "dist/knowledge-graph/producers/signatures.js"));
  const project = mkdtempSync(join(tmpdir(), "c64re-826-measure-"));
  mkdirSync(join(project, "knowledge"), { recursive: true });
  mkdirSync(join(project, "analysis"), { recursive: true });
  writeFileSync(join(project, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "p", name: "Spec 826 fixture", slug: "s826", rootPath: project }));
  const image = new Uint8Array(0x200).fill(0xea);
  const put = (addr, bytes) => image.set(bytes, addr - 0x1000);
  put(0x1000, [0xa9, 0x01, 0xa2, 0x12, 0xa0, 0x05, 0x20, 0x00, 0x11, 0xb0, 0x05, 0x85, 0xfc, 0x20, 0xd2, 0xff, 0x60]);
  put(0x1020, [0xa9, 0x02, 0xa2, 0x13, 0xa0, 0x00, 0x20, 0x00, 0x11, 0x60]);
  put(0x1030, [0xa9, 0x03, 0x20, 0x00, 0x11, 0x60]);
  put(0x1100, [0x85, 0xf3, 0x86, 0xf4, 0x84, 0xf5, 0xa5, 0xf3, 0xc9, 0x03, 0xf0, 0x04, 0xb1, 0xf4, 0x18, 0x60, 0x38, 0x60]);
  put(0x1140, [0x48, 0x8a, 0x48, 0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x68, 0xaa, 0x68, 0x60]);
  put(0x1160, [0xa9, 0x11, 0x48, 0xa9, 0x7f, 0x48, 0x60]);
  put(0x1180, [0x60]);
  put(0x1190, [0xa9, 0x07, 0x8d, 0xa1, 0x11, 0x20, 0xa0, 0x11, 0x60]);
  put(0x11a0, [0xa9, 0x00, 0x60]);
  put(0x11b0, [0x68, 0x68, 0x60]);
  put(0x11c0, [0x20, 0x00, 0x30, 0x60]);
  const prg = new Uint8Array(image.length + 2);
  prg[0] = 0x00; prg[1] = 0x10; prg.set(image, 2);
  const prgPath = join(project, "analysis", "fixture.prg");
  const analysisPath = join(project, "analysis", "fixture_analysis.json");
  writeFileSync(prgPath, prg);
  execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prgPath, analysisPath, "1000,1020,1030,1100,1140,1160,1180,1190,11a0,11b0,11c0"], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: project } });
  seedControlFlow({ projectDir: project, analysisPath });
  seedMemoryAccess({ projectDir: project, analysisPath });
  resolveAddresses(project);
  const r = seedSignatures({ projectDir: project });
  console.log(`  seed  fixture: routines=${r.routines} signed=${r.signed} partial=${r.partial} passes=${r.passes} dispatches=${r.dispatches} ${r.ms.toFixed(1)} ms`);
  return project;
}

function measure(projectDir, label) {
  const graph = Graph.open(projectDir);
  const db = graph.store.db;
  const t0 = process.hrtime.bigint();
  const sigRows = db.prepare("SELECT from_id, confidence, evidence FROM edges WHERE type = 'SIGNATURE' AND layer = 'generated' ORDER BY from_id").all();
  const routines = Number(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'routine' AND layer = 'generated'").get().n);
  let partial = 0;
  let unknownStack = 0;
  let unbalanced = 0;
  const inHist = new Map();
  for (const row of sigRows) {
    const s = JSON.parse(row.evidence);
    if (s.partial) partial += 1;
    if (s.stack?.unknown) unknownStack += 1;
    else if (s.stack && s.stack.balanced === false) unbalanced += 1;
    const n = Array.isArray(s.in) ? s.in.length : 0;
    inHist.set(n, (inHist.get(n) ?? 0) + 1);
  }
  const passes = db.prepare("SELECT evidence FROM edges WHERE type = 'PASSES' AND layer = 'generated'").all();
  let withImm = 0;
  for (const p of passes) {
    const args = JSON.parse(p.evidence).args ?? {};
    if (Object.values(args).some((a) => a && a.source === "imm")) withImm += 1;
  }
  const dispatches = Number(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type = 'JUMPS_TO' AND producer = '826'").get().n);
  const mostCalled = db.prepare("SELECT to_id, COUNT(*) AS n FROM edges WHERE type IN ('CALLS', 'CALLS_ROM') AND layer = 'generated' AND producer = '819' GROUP BY to_id ORDER BY n DESC, to_id LIMIT 10").all();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  console.log(`\n== ${label}: ${projectDir}`);
  console.log(`  routines ${routines} · with a signature ${sigRows.length} · partial ${partial} · unknown stack ${unknownStack} · unbalanced ${unbalanced} · rts-dispatch JUMPS_TO ${dispatches}`);
  console.log(`  |in| histogram: ${[...inHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}→${v}`).join("  ")}`);
  console.log(`  PASSES edges ${passes.length} · with ≥1 imm ${withImm}`);
  console.log(`  the ten most-called routines, their signature and argument domain:`);
  for (const row of mostCalled) {
    const n = graph.resolve(row.to_id);
    const sig = n.dangling || n.platform ? undefined : signatureOf(graph, row.to_id);
    console.log(`  - ${row.to_id} (${row.n} callers)${n.name ? ` ${n.name}` : ""}`);
    if (sig) console.log(`      ${formatSignature(sig)}`);
    const dom = argsDomain(graph, row.to_id);
    console.log(formatArgs(dom).split("\n").map((l) => `      ${l}`).join("\n"));
  }
  console.log(`  measured in ${ms.toFixed(1)} ms (query side only; the seed's own ms is printed by \`c64re graph seed\`)`);
  graph.close();
  return sigRows.length;
}

let measured = false;
if (existsSync(join(WASTELAND, "knowledge", "graph.sqlite"))) {
  const signed = measure(WASTELAND, "Wasteland_EF (read-only)");
  if (signed === 0) console.log("  note  Wasteland_EF has no 826 rows yet — this script does not seed a project it does not own; run `c64re graph seed --project <dir>` there and re-measure. Measuring the §5 fixture instead.");
  else measured = true;
} else {
  console.log(`  skip  ${WASTELAND} absent — loudly skipped. Measuring the §5 fixture instead.`);
}
if (!measured) {
  const fixture = await buildFixture();
  measure(fixture, "§5 fixture");
}
