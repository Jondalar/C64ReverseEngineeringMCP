#!/usr/bin/env node
// Spec 825 §5 — the explorer, at bundle + source + unit level (no browser):
//   - the sigma/graphology code is a SEPARATE chunk (D2, lazy): a workspace that
//     never opens the Graph tab downloads what it downloaded before 825
//   - index-*.js carries the six /api/graph/* route strings
//   - package.json = 824's frozen list + exactly the five D2 runtime names and
//     graphology-types, each pinned to an exact version
//   - graph-canvas.tsx is the ONLY file importing sigma; the two lib files
//     import graphology and touch no DOM
//   - the four layouts, run in node on the 823 fixture's own `subgraph --json`:
//     Layers bands in the D3 order and x monotone in address inside a band;
//     Address x IS the address and every bank gets its own lane; Radial ring ==
//     BFS distance with the focus at the origin; the Force seed is identical
//     across two runs; Louvain sees CODE edges only; and applying every lens
//     leaves every position untouched (D5)
//
// Exit 0 = pass, 1 = fail.   npm run smoke:825

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tsImport } from "tsx/esm/api";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

console.log("Spec 825 — the graph explorer\n");

// ------------------------------------------------------------------ bundle
const dist = join(ROOT, "ui/dist/assets");
if (!existsSync(dist)) { console.error("ui/dist not built — run npm run ui:build"); process.exit(2); }
const files = readdirSync(dist).filter((f) => f.endsWith(".js"));
const indexFiles = files.filter((f) => /^index-.*\.js$/.test(f));
const indexJs = indexFiles.map((f) => readFileSync(join(dist, f), "utf8")).join("\n");
const lazyFiles = files.filter((f) => !/^index-.*\.js$/.test(f));
const lazyJs = lazyFiles.map((f) => readFileSync(join(dist, f), "utf8")).join("\n");

// sigma's own marker strings: they must live OUTSIDE index-*.js
// markers that only sigma's OWN code carries (a settings key the panel passes
// by name would false-positive; these are internals)
const sigmaMark = /WEBGL_lose_context|nodeProgramClasses|zoomToSizeRatioFunction/;
check(sigmaMark.test(lazyJs), `sigma lives in a lazy chunk (${lazyFiles.length} non-index chunks: ${lazyFiles.map((f) => f.replace(/-[A-Za-z0-9_-]{6,}\.js$/, "")).join(", ")})`);
check(!sigmaMark.test(indexJs), "index-*.js carries NO sigma code — the Graph tab pays for the renderer, nobody else does");
check(!/graphology/.test(indexJs) || !/MultiDirectedGraph|InvalidArgumentsGraphError/.test(indexJs), "index-*.js carries no graphology runtime");
const routes = ["/api/graph/overview", "/api/graph/node", "/api/graph/edges", "/api/graph/find", "/api/graph/subgraph"];
for (const r of routes) check(indexJs.includes(r), `index-*.js calls ${r}`);
check(!/\/api\/graph\/(?!overview|node|edges|find|path|subgraph)/.test(indexJs), "the panel calls no route outside the six");

const css = readdirSync(dist).filter((f) => /^index-.*\.css$/.test(f)).map((f) => readFileSync(join(dist, f), "utf8")).join("\n");
check(/\.graph-canvas\{|\.graph-canvas\s*\{/.test(css) && /\.graph-explorer/.test(css) && /\.graph-dock/.test(css), "explorer CSS bundled (canvas, explorer grid, dock)");

// ------------------------------------------------------------- dependencies
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const D2_RUNTIME = ["sigma", "graphology", "graphology-layout", "graphology-layout-forceatlas2", "graphology-communities-louvain"];
const D2_DEV = ["graphology-types"];
const frozen824 = ["react", "react-dom", "@types/react", "@types/react-dom", "@vitejs/plugin-react", "vite"];
check(frozen824.every((d) => d in deps), "824's frozen list is still there, untouched");
check(D2_RUNTIME.every((d) => d in (pkg.dependencies ?? {})), `the five D2 runtime dependencies are present (${D2_RUNTIME.join(", ")})`);
check(D2_DEV.every((d) => d in (pkg.devDependencies ?? {})), "graphology-types is a devDependency, types only");
const unpinned = [...D2_RUNTIME, ...D2_DEV].filter((d) => !/^\d+\.\d+\.\d+/.test(String(deps[d] ?? "")));
check(unpinned.length === 0, `every 825 dependency is pinned to an exact version (${[...D2_RUNTIME, ...D2_DEV].map((d) => `${d}@${deps[d]}`).join(" ")})`);
const forbidden = Object.keys(deps).filter((d) => /^(d3|cytoscape|dagre|reactflow|vis-network)/.test(d) || d.startsWith("@react-sigma/") || d.startsWith("@sigma/"));
check(forbidden.length === 0, "no @react-sigma/core, no @sigma/node-* programs, no second graph library");

// ------------------------------------------------------------------ source
const canvas = readFileSync(join(ROOT, "ui/src/components/graph-canvas.tsx"), "utf8");
const panel = readFileSync(join(ROOT, "ui/src/components/graph-panel.tsx"), "utf8");
const layoutsSrc = readFileSync(join(ROOT, "ui/src/lib/graph-layouts.ts"), "utf8");
const commsSrc = readFileSync(join(ROOT, "ui/src/lib/graph-communities.ts"), "utf8");
const uiFiles = [];
const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) uiFiles.push(p); } };
walk(join(ROOT, "ui/src"));
const importsSigma = uiFiles.filter((f) => /(?:from|import\()\s*["']sigma["']/.test(readFileSync(f, "utf8")));
check(importsSigma.length === 1 && importsSigma[0].endsWith("graph-canvas.tsx"), `graph-canvas.tsx is the only file importing sigma (${importsSigma.map((f) => f.replace(ROOT + "/", "")).join(", ") || "none"})`);
check(/import\("sigma"\)/.test(canvas), "sigma is behind a dynamic import() — vite emits it as its own chunk (D2)");
check(!/from ["']@react-sigma|from ["']@sigma\//.test(canvas), "no React binding, no node-program package");
for (const [name, src] of [["graph-layouts.ts", layoutsSrc], ["graph-communities.ts", commsSrc]]) {
  check(/from ["']graphology/.test(src), `${name} imports graphology`);
  check(!/\bdocument\b|\bwindow\b|\bHTMLElement\b|from ["']react["']|from ["']sigma["']/.test(src), `${name} touches no DOM, no React, no sigma — pure, testable in node`);
}
check(/nodeReducer/.test(canvas) && /edgeReducer/.test(canvas), "the canvas applies the lenses through sigma's nodeReducer / edgeReducer (D5)");
// sigma OWNS the `type` attribute (it picks the render program with it): a store
// edge type in there is "could not find a suitable program for edge type READS".
check(/edgeType: e\.type/.test(canvas) && /type: "arrow"/.test(canvas), "the store's edge type is stored as `edgeType` — sigma keeps `type` for its render program");
// sigma's camera is y-UP; the layouts are written in screen orientation so the
// D3 band order reads top to bottom. The flip lives at the render boundary.
check(/setNodeAttribute\(id, "y", -p\.y\)/.test(canvas), "the canvas flips y for sigma's y-up camera — the Layers bands read top to bottom on screen");
check(!/-p\.y|-\s*y/.test(layoutsSrc.replace(/\/\*[\s\S]*?\*\//g, "")), "the layouts themselves stay in D3's screen orientation");
check(!/\(attrs as \{ type\?/.test(layoutsSrc + commsSrc), "the pure libs read `edgeType`, not sigma's `type`");
const reducerBodies = canvas.slice(canvas.indexOf("export function reduceNode"));
check(!/\bres\.(x|y)\s*=/.test(reducerBodies) && !/setNodeAttribute\([^)]*["'](x|y)["']/.test(reducerBodies), "no reducer assigns x or y — a lens cannot move a node (D5)");
// 824 survivors
check(/Open in source/.test(panel) && /sourceJump/.test(panel) && /onJumpToSource/.test(panel), "824.2's \"Open in source\" survives");
check(/Open in Annotated Listing/.test(panel) && /onJumpToListing/.test(panel), "824's listing jump survives");
check(/graph-chip/.test(panel) && /graph-search/.test(panel) && /graph-depth/.test(panel), "824's chips, search and depth survive");
check(/Dock source/.test(panel) && /<AsmView/.test(panel), "D8: the same AsmView, docked beside the canvas");
check(!/flow-node-rect/.test(panel), "the lane SVG is retired — one renderer, not two (D3)");

// ---------------------------------------------------- the fixture subgraph
// The 823 fixture, seeded and projected by the real aggregate — the unit tests
// below run on exactly what the route ships.
const cli = join(ROOT, "dist/cli.js");
const pipeline = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cli) || !existsSync(pipeline)) { console.error("dist missing — run npm run build"); process.exit(2); }
const projectDir = mkdtempSync(join(tmpdir(), "c64re-825-ui-"));
mkdirSync(join(projectDir, "knowledge"), { recursive: true });
mkdirSync(join(projectDir, "analysis"), { recursive: true });
writeFileSync(join(projectDir, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "p825u", name: "s825u", slug: "s825u", rootPath: projectDir, status: "active", createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" }));
const seedOne = (stem, org, runs) => {
  const image = new Uint8Array(0x40).fill(0xea);
  for (const [at, bytes] of runs) image.set(bytes, at);
  const prg = new Uint8Array(image.length + 2);
  prg[0] = org & 0xff; prg[1] = (org >> 8) & 0xff; prg.set(image, 2);
  const prgPath = join(projectDir, "analysis", `${stem}.prg`);
  writeFileSync(prgPath, prg);
  execFileSync(process.execPath, [pipeline, "analyze-prg", prgPath, join(projectDir, "analysis", `${stem}_analysis.json`), org.toString(16)], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: projectDir } });
};
seedOne("fixture", 0x1000, [[0x00, [0x20, 0x20, 0x10, 0xad, 0x11, 0xd0, 0x8d, 0x11, 0xd0, 0x20, 0xd2, 0xff, 0x60]], [0x20, [0x60]]]);
seedOne("second", 0x2000, [[0x00, [0x20, 0x10, 0x20, 0xad, 0x12, 0xd0, 0x20, 0xd2, 0xff, 0x60]], [0x10, [0x60]]]);
execFileSync(process.execPath, [cli, "graph", "seed", "--project", projectDir], { stdio: ["ignore", "pipe", "pipe"] });
const body = JSON.parse(execFileSync(process.execPath, [cli, "graph", "subgraph", "--scope", "all", "--project", projectDir, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
check(body.nodes.length > 0 && body.edges.length > 0, `fixture subgraph: ${body.nodes.length} nodes, ${body.edges.length} edges`);

// ------------------------------------------------------------------- units
const layouts = await tsImport("../ui/src/lib/graph-layouts.ts", import.meta.url);
const comms = await tsImport("../ui/src/lib/graph-communities.ts", import.meta.url);
const { default: Graphology } = await import("graphology");
const addr = (a) => parseInt(String(a).replace("$", ""), 16);

function buildModel(nodes, edges) {
  const g = new Graphology({ multi: false, type: "directed" });
  for (const n of nodes) g.addNode(n.id, { ...n, address: addr(n.address), end: n.end ? addr(n.end) : null });
  for (const e of edges) { if (g.hasNode(e.from) && g.hasNode(e.to) && !g.hasEdge(e.from, e.to)) g.addEdge(e.from, e.to, { edgeType: e.type, type: "arrow", origin: e.origin, layer: e.layer, n: e.n }); }
  return g;
}
const model = buildModel(body.nodes, body.edges);

// --- Layers
check(JSON.stringify(layouts.LAYER_BANDS) === JSON.stringify(["entry", "routine", "label", "addr", "zp", "io", "rom"]), "Layers bands are in the D3 order: entry · routine · label · addr · zp · io · rom");
const layersPos = layouts.layersLayout(model);
const perBand = new Map();
model.forEachNode((id, a) => { const b = layouts.bandOf(a); perBand.set(b, [...(perBand.get(b) ?? []), { id, address: a.address }]); });
let monotoneFails = 0;
let bandOrderFails = 0;
for (const [band, list] of perBand) {
  const sorted = [...list].sort((x, y) => x.address - y.address || (x.id < y.id ? -1 : 1));
  for (let i = 1; i < sorted.length; i += 1) if (layersPos[sorted[i].id].x < layersPos[sorted[i - 1].id].x) monotoneFails += 1;
  for (const n of list) if (Math.floor(layersPos[n.id].y / layouts.LAYERS_BAND_HEIGHT) !== band) bandOrderFails += 1;
}
check(monotoneFails === 0, `Layers: x is monotone in address inside every band (${perBand.size} bands populated)`);
check(bandOrderFails === 0, "Layers: y puts every node in its own band, bands stacked in the D3 order");

// --- Address
const addressPos = layouts.addressLayout(model);
let xFails = 0;
model.forEachNode((id, a) => { if (addressPos[id].x !== a.address) xFails += 1; });
check(xFails === 0, "Address: x IS the address, literally ($0000–$FFFF, no scaling)");
// a banked model, so "a lane per bank" is actually exercised
const bankedNodes = body.nodes.map((n, i) => (n.owner ? { ...n, bank: i % 2 === 0 ? 7 : 9 } : n));
const banked = buildModel(bankedNodes, body.edges);
const lanes = layouts.addressLanes(banked);
check(lanes.some((l) => l.id === "bank:7") && lanes.some((l) => l.id === "bank:9"), `Address: one lane per bank in the scope (${lanes.map((l) => l.id).join(", ")})`);
const bankedPos = layouts.addressLayout(banked);
const laneUsage = new Map();
banked.forEachNode((id, a) => { if (a.bank === null || a.bank === undefined) return; const lane = layouts.laneOfY(bankedPos[id].y, lanes.length); laneUsage.set(a.bank, (laneUsage.get(a.bank) ?? new Set()).add(lane)); });
check([...laneUsage.values()].every((s) => s.size === 1) && new Set([...laneUsage.entries()].map(([, s]) => [...s][0])).size === laneUsage.size, "Address: each bank's nodes sit in exactly one lane, and no two banks share one");

// --- Radial
const focusId = body.nodes.find((n) => n.kind === "routine")?.id ?? body.nodes[0].id;
const rings = layouts.radialRings(model, { focus: focusId });
const radialPos = layouts.radialLayout(model, { focus: focusId });
check(radialPos[focusId].x === 0 && radialPos[focusId].y === 0, `Radial: the focus (${focusId}) sits at the origin`);
// an independent BFS over the same model
const want = new Map([[focusId, 0]]);
let frontier = [focusId];
for (let d = 1; frontier.length; d += 1) {
  const next = [];
  for (const id of frontier) model.forEachEdge(id, (_e, _a, s, t) => { const other = s === id ? t : s; if (want.has(other)) return; want.set(other, d); next.push(other); });
  frontier = next;
}
let maxRing = 0;
for (const v of want.values()) maxRing = Math.max(maxRing, v);
let ringFails = 0;
model.forEachNode((id) => { const expect = want.has(id) ? want.get(id) : maxRing + 1; if (rings[id] !== expect) ringFails += 1; });
check(ringFails === 0, `Radial: every ring index equals the BFS hop distance from the focus (max ring ${maxRing})`);

// --- Force seed is deterministic
const a1 = JSON.stringify(layouts.seedLayout(model));
const a2 = JSON.stringify(layouts.seedLayout(buildModel(body.nodes, body.edges)));
check(a1 === a2, "Force: the circular seed is byte-identical across two runs — the simulation starts in the same place");

// --- Louvain sees CODE edges only
function synthetic(withHub) {
  const g = new Graphology({ multi: false, type: "directed" });
  const ids = [];
  for (let i = 0; i < 6; i += 1) { const id = `p:ram/x:routine:${(0x1000 + i).toString(16)}`; ids.push(id); g.addNode(id, { kind: "routine", address: 0x1000 + i, end: null, bank: null, owner: "x", label: `W${i}`, name: null, layers: ["generated"], platform: false, dangling: false, degree: 2 }); }
  // two CALLS triangles, no edge between them
  for (const [a, b] of [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3]]) g.addEdge(ids[a], ids[b], { edgeType: "CALLS", type: "arrow", origin: "static", layer: "generated", n: 1 });
  if (withHub) {
    g.addNode("c64:zp:00fb", { kind: "zp", address: 0xfb, end: null, bank: null, owner: null, label: null, name: null, layers: ["generated"], platform: true, dangling: false, degree: 6 });
    for (const id of ids) g.addEdge(id, "c64:zp:00fb", { edgeType: "USES_ZP", type: "arrow", origin: "static", layer: "generated", n: 1 });
  }
  return { g, ids };
}
const plain = synthetic(false);
const hubbed = synthetic(true);
const cPlain = comms.communities(plain.g);
const cHub = comms.communities(hubbed.g);
const same = plain.ids.every((id) => cPlain.assignment[id] === cHub.assignment[id]);
const twoGroups = new Set(plain.ids.map((id) => cPlain.assignment[id])).size === 2;
check(twoGroups, "Louvain: two CALLS triangles are two communities");
check(same, "Louvain sees CODE edges only — a shared USES_ZP hub does not change the partition (D4)");
check(JSON.stringify(comms.communities(plain.g).assignment) === JSON.stringify(cPlain.assignment), "Louvain is seeded — the same graph colours the same way twice");
check(JSON.stringify(comms.CODE_EDGE_TYPES) === JSON.stringify(["CALLS", "JUMPS_TO", "BRANCHES_TO", "CONTAINS"]), "the code-edge set is CALLS · JUMPS_TO · BRANCHES_TO · CONTAINS, and nothing from memory");
check(!/setNodeAttribute|setEdgeAttribute|fetch\(/.test(commsSrc.replace(/code\.setEdgeAttribute[^\n]*\n/g, "")), "the community pass never writes back to the project graph (D9)");

// --- D5: a lens moves nothing
const before = {};
for (const v of ["force", "layers", "radial", "address"]) before[v] = JSON.stringify(layouts.layoutFor(v, model, { focus: focusId }));
model.forEachNode((id) => model.setNodeAttribute(id, "hidden", true));
model.forEachEdge((e) => model.setEdgeAttribute(e, "hidden", true));
let lensFails = 0;
for (const v of ["force", "layers", "radial", "address"]) if (JSON.stringify(layouts.layoutFor(v, model, { focus: focusId })) !== before[v]) lensFails += 1;
check(lensFails === 0, "D5: hiding every node and every edge changes not one position, in any of the four views");

// --- the reducers themselves, run in node on a fake graph (they are pure)
const canvasMod = await tsImport("../ui/src/components/graph-canvas.tsx", import.meta.url);
const fakeGraph = {
  hasNode: (id) => ["a", "b"].includes(id),
  neighbors: () => ["b"],
  extremities: () => ["a", "b"],
  getNodeAttribute: (n, k) => (k === "kind" ? (n === "a" ? "routine" : "entry") : null),
};
const baseLens = { hiddenKinds: new Set(), hiddenFamilies: new Set(), hiddenEdgeTypes: new Set(canvasMod.DEFAULT_HIDDEN_EDGE_TYPES), origin: "any", bank: null };
const st = (lens) => ({ focus: null, lens, isolate: null, hovered: null });
const nodeAttrs = { kind: "entry", bank: null, platform: false, name: null, label: "W1000" };
check(canvasMod.reduceNode("a", nodeAttrs, st({ ...baseLens, hiddenKinds: new Set(["entry"]) }), fakeGraph).hidden === true, "reduceNode: a hidden kind hides the node");
check(canvasMod.reduceNode("a", nodeAttrs, st(baseLens), fakeGraph).hidden === undefined, "reduceNode: an allowed kind is visible");
const edgeAttrs = { edgeType: "CALLS", types: ["CALLS"], origin: "static", layer: "generated", n: 1 };
check(canvasMod.reduceEdge("e", edgeAttrs, st({ ...baseLens, hiddenFamilies: new Set(["code"]) }), fakeGraph).hidden === true, "reduceEdge: the Code chip hides a CALLS edge");
check(canvasMod.reduceEdge("e", { ...edgeAttrs, edgeType: "MAPS_TO", types: ["MAPS_TO"] }, st(baseLens), fakeGraph).hidden === true, "reduceEdge: MAPS_TO is hidden by default (D5)");
check(canvasMod.reduceEdge("e", edgeAttrs, st({ ...baseLens, origin: "runtime" }), fakeGraph).hidden === true, "reduceEdge: origin=runtime hides a static edge");
check(canvasMod.reduceEdge("e", edgeAttrs, st({ ...baseLens, hiddenKinds: new Set(["entry"]) }), fakeGraph).hidden === true, "reduceEdge: an edge whose endpoint the lens hides is hidden too");
for (const r of [canvasMod.reduceNode("a", nodeAttrs, st(baseLens), fakeGraph), canvasMod.reduceEdge("e", edgeAttrs, st(baseLens), fakeGraph)]) {
  check(r.x === undefined && r.y === undefined, "a reducer never returns an x or a y — a lens cannot move anything (D5)");
}
check(JSON.stringify(canvasMod.DEFAULT_HIDDEN_KINDS) === JSON.stringify(["entry", "segment"]), "D5 default lenses: entry and segment nodes start hidden");

// --- §10: the Address lane stack stays a stack of BANDS, whatever the bank count
check(layouts.addressLaneHeight(4) === layouts.ADDRESS_MAX_LANE_HEIGHT, "a four-lane project keeps the generous 4096-tall band it always had");
const wide = layouts.addressLaneHeight(60) * 60;
check(wide <= layouts.ADDRESS_SPAN, `sixty banks stack to ${Math.round(wide)} — inside the 65 536 address axis, so the map reads wider than it is tall`);
check(layouts.addressRowHeight(60) * layouts.ADDRESS_ROWS_PER_LANE < layouts.addressLaneHeight(60), "the rows inside a lane fit inside that lane, at any bank count");
check(layouts.laneOfY(layouts.addressLaneHeight(60) * 7 + 1, 60) === 7, "laneOfY still inverts the y, with the lane count it was drawn at");

// --- §10: the palette must survive sigma's own colour parser
//
// This is the gate the first build did not have. `communityColor` returned
// `hsl(...)`, sigma 3's parseColor understands hex / rgb / rgba / named only,
// and every unparsed colour becomes {r:0,g:0,b:0} — 13 060 black nodes on a
// near-black panel. A palette is a render CONTRACT, so it is checked against
// the renderer, not against taste.
const { parseColor } = await import("sigma/utils");
const isBlack = (c) => { const p = parseColor(c); return p.r === 0 && p.g === 0 && p.b === 0; };
const palette = [...comms.HUMAN_COLORS, ...comms.COMPUTED_COLORS, comms.UNCOLORED_COLOR];
check(palette.length >= 16, `the palette has ${palette.length} colours: ${comms.HUMAN_COLORS.length} human + ${comms.COMPUTED_COLORS.length} computed + the uncoloured slate`);
check(palette.every((c) => /^#[0-9a-f]{6}$/i.test(c)), "every palette colour is hex — the one notation sigma, CSS and a swatch all read the same way");
check(palette.every((c) => !isBlack(c)), "sigma's parseColor renders no palette colour black (the §10 defect, as a gate)");
check(isBlack("hsl(200, 58%, 62%)"), "…and the reason: sigma parses an hsl() string to BLACK, silently");
for (const id of ["human:sub:loader", "computed:0", "computed:7", ""]) {
  check(!isBlack(comms.communityColor(id)) || id === "", `communityColor(${JSON.stringify(id)}) = ${comms.communityColor(id)} is drawable`);
}
check(comms.communityColor("computed:3") === comms.communityColor("computed:3"), "communityColor is stable for an id");
check(comms.HUMAN_COLORS.every((c) => !comms.COMPUTED_COLORS.includes(c)), "the human ramp and the computed ramp share no colour — named vs guessed is legible without reading");
check(comms.communityColor("") === comms.UNCOLORED_COLOR, "a node in no community gets the scaffolding colour, not a community one");

// --- §10: the uncoloured half is demoted, not just recoloured
check(comms.nodeSize(40, false) < comms.nodeSize(40, true) * 0.6, "a node outside every community is drawn markedly smaller (D4)");
check(comms.nodeSize(0, true) < comms.nodeSize(4000, true), "size still carries degree");
check(comms.nodeSize(4000, true) <= 16, "and it is capped, so one hub cannot own the canvas");

// --- §10: the legend carries the swatch, and it travels ON the group
check(cPlain.groups.every((g) => /^#[0-9a-f]{6}$/i.test(g.color)), "every community group carries its own hex swatch for the legend");
check(!/from "\.\.\/lib\/graph-communities/.test(panel.replace(/import type[^;]*;/g, "")), "graph-panel.tsx imports graph-communities TYPE-ONLY — a value import would drag Louvain into index-*.js");
check(/graph-legend-swatch/.test(panel), "the legend draws the swatch: colour is the community axis (D4)");

// --- §10: labels belong to the focus set, not to every platform node
check(canvas.includes("labelRenderedSizeThreshold: 15"), "the label threshold is raised: at fit zoom on 13 000 nodes, sigma prints none");
check(/labelColor:\s*\{\s*color:\s*"#/.test(canvas), "labels have an explicit light colour — sigma's default is #000 on a near-black panel");
check(!/data\.platform === true && \(data\.name/.test(canvas), "no blanket forceLabel for platform nodes (that was most of the text soup)");
check(canvasMod.displayLabel({ address: 0x0328, name: "Vector to Kernal STOP Routine, and then some more", label: null }).length <= 6 + 1 + canvasMod.MAX_LABEL_CHARS, "a c64ref heading is truncated for the canvas; the full text stays in the node card");
check(canvasMod.displayLabel({ address: 0x1000, name: null, label: null }) === "$1000", "a node with no name still shows its address");

// --- switching views never re-fetches: the layouts take a graph, not a URL
check(!/fetch\(|\/api\//.test(layoutsSrc), "graph-layouts.ts has no fetch and no route — switching views re-positions, it cannot re-load");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 825 explorer: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
