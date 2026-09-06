#!/usr/bin/env node
// Spec 825 §5 — the numbers, on a real project. NOT a gate: it measures, it
// never fails a build, and it skips LOUDLY when the project is not there.
//
// Everything here is READ-ONLY: the graph store is opened read-only by
// `Graph.open`, the aggregate only SELECTs, and the community pass never
// writes back (D9). Nothing seeds, nothing migrates, nothing is created.
//
//   npm run measure:825 [-- --project <dir>]
// Default project: /Users/alex/Development/C64/Cracking/Wasteland_EF

import { gzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const argProject = argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : undefined;
const projectDir = resolve(argProject ?? process.env.C64RE_PROJECT_DIR ?? "/Users/alex/Development/C64/Cracking/Wasteland_EF");

if (!existsSync(join(projectDir, "knowledge", "graph.sqlite"))) {
  console.log(`SKIP  measure:825 — no knowledge/graph.sqlite under ${projectDir}`);
  console.log("      Point it at a seeded project:  npm run measure:825 -- --project <dir>");
  process.exit(0);
}
if (!existsSync(join(ROOT, "dist/knowledge-graph/cards.js"))) { console.error("dist missing — run npm run build:mcp"); process.exit(2); }

const ms = (f) => { const t = process.hrtime.bigint(); const v = f(); return [v, Number(process.hrtime.bigint() - t) / 1e6]; };
const fmtMs = (v) => `${v.toFixed(1)} ms`;
const fmtBytes = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} kB`);

const { Graph } = await import(pathToFileURL(join(ROOT, "dist/knowledge-graph/query.js")).href);
const { subgraph } = await import(pathToFileURL(join(ROOT, "dist/knowledge-graph/cards.js")).href);
const { formatSubgraph } = await import(pathToFileURL(join(ROOT, "dist/knowledge-graph/format.js")).href);
const layouts = await tsImport("../ui/src/lib/graph-layouts.ts", import.meta.url);
const comms = await tsImport("../ui/src/lib/graph-communities.ts", import.meta.url);
const { default: Graphology } = await import("graphology");
const { default: forceAtlas2 } = await import("graphology-layout-forceatlas2");

console.log(`Spec 825 — explorer measurements\nproject: ${projectDir}\n`);

const graph = Graph.open(projectDir); // read-only by default (818)
const rows = [];
try {
  // ---- the route body
  const [sub, aggMs] = ms(() => subgraph(graph, { scope: "all" }));
  const [text, fmtMsTaken] = ms(() => `${JSON.stringify(formatSubgraph(sub).json, null, 2)}\n`);
  const bytes = Buffer.byteLength(text, "utf8");
  rows.push(["subgraph scope=all", `${fmtMs(aggMs)} aggregate + ${fmtMs(fmtMsTaken)} serialize`]);
  const [gz] = ms(() => gzipSync(Buffer.from(text, "utf8")).length);
  rows.push(["subgraph body", `${fmtBytes(bytes)} (${bytes} bytes) raw · ${fmtBytes(gz)} gzipped  — D7 target: under 3 MB, under 1 s`]);
  rows.push(["nodes", String(sub.counts.nodes)]);
  rows.push(["edges (collapsed)", String(sub.counts.edges)]);
  rows.push(["edge rows behind them", String(sub.counts.rows)]);
  rows.push(["collapse ratio", `${(sub.counts.rows / Math.max(1, sub.counts.edges)).toFixed(2)} rows per drawn edge`]);
  rows.push(["platform endpoints", String(sub.nodes.filter((n) => n.platform).length)]);
  rows.push(["dangling endpoints", String(sub.nodes.filter((n) => n.dangling).length)]);
  rows.push(["subsystems", String(sub.subsystems.length)]);

  // ---- the in-memory model
  const addr = (a) => parseInt(String(a).replace("$", ""), 16);
  const [model, modelMs] = ms(() => {
    const g = new Graphology({ multi: false, type: "directed" });
    for (const n of sub.nodes) g.addNode(n.id, { ...n, address: addr(n.address), end: n.end ? addr(n.end) : null });
    for (const e of sub.edges) if (g.hasNode(e.from) && g.hasNode(e.to) && !g.hasEdge(e.from, e.to)) // `edgeType`, not `type`: sigma owns `type`, and the pure libs read `edgeType`.
      g.addEdge(e.from, e.to, { edgeType: e.type, type: "arrow", origin: e.origin, layer: e.layer, n: e.n });
    return g;
  });
  rows.push(["graphology model", `${fmtMs(modelMs)} (${model.order} nodes, ${model.size} drawn edges)`]);

  // ---- communities (D4)
  const [community, commMs] = ms(() => comms.communities(model));
  const human = community.groups.filter((g) => g.kind === "human");
  const computed = community.groups.filter((g) => g.kind === "computed");
  rows.push(["communities", `${fmtMs(commMs)} · ${community.groups.length} total (${human.length} human, ${computed.length} computed, ${computed.filter((g) => g.size > 1).length} of them bigger than one node)`]);
  rows.push(["uncoloured nodes", `${community.uncolored} — no code edge at all, drawn grey`]);
  rows.push(["modularity", community.modularity === null ? "n/a (nothing to partition)" : community.modularity.toFixed(4)]);
  rows.push(["biggest computed", computed.slice(0, 3).map((g) => `${g.size} (${g.top.join(", ")})`).join(" · ") || "(none)"]);

  // ---- the four projections
  const [, seedMs] = ms(() => layouts.seedLayout(model));
  rows.push(["Force seed (circular)", fmtMs(seedMs)]);
  const [, layersMs] = ms(() => layouts.layersLayout(model));
  rows.push(["Layers layout", fmtMs(layersMs)]);
  const [, addressMs] = ms(() => layouts.addressLayout(model));
  rows.push(["Address layout", `${fmtMs(addressMs)} (${layouts.addressLanes(model).length} lanes)`]);
  const focus = sub.nodes.find((n) => n.kind === "routine")?.id ?? sub.nodes[0]?.id ?? null;
  const [, radialMs] = ms(() => layouts.radialLayout(model, { focus }));
  rows.push(["Radial layout", `${fmtMs(radialMs)} (focus ${focus ?? "none"})`]);

  // ---- ForceAtlas2, 300 iterations, synchronously (the browser runs it in a worker)
  const seeded = layouts.seedLayout(model);
  for (const [id, p] of Object.entries(seeded)) { model.setNodeAttribute(id, "x", p.x); model.setNodeAttribute(id, "y", p.y); }
  const settings = forceAtlas2.inferSettings(model);
  const [, fa2Ms] = ms(() => forceAtlas2(model, { iterations: 300, settings }));
  rows.push(["ForceAtlas2 ×300", `${fmtMs(fa2Ms)} (${(fa2Ms / 300).toFixed(2)} ms/iteration, single-threaded)`]);

  // ---- what the neighbourhood that broke 824's lanes looks like now
  const fanout = sub.nodes.map((n) => ({ id: n.id, degree: n.degree })).sort((a, b) => b.degree - a.degree)[0];
  if (fanout) rows.push(["widest fan-out", `${fanout.degree} rows on ${fanout.id}`]);
} finally {
  graph.close();
}

const w = Math.max(...rows.map(([k]) => k.length));
for (const [k, v] of rows) console.log(`  ${k.padEnd(w)}  ${v}`);
console.log("");
