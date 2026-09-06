#!/usr/bin/env node
// Spec 824 — the Graph tab, at bundle + source level (no browser):
//   - ONE shell: the v1 bundle carries the Graph tab; /v3.html stays retired (smoke-product-ui check 9)
//   - the panel reads only the /api/graph/* routes (five in 824, six since 825's
//     bulk `subgraph` — amended by Spec 825 D1, which owns the list from here)
//   - the neighbourhood is drawn by the ONE sigma canvas (825 D3 retired 824's
//     lane SVG: it failed at 80 edges, measured)
//   - the listing scrolls its active row into view (D5.1)
//   - the dependency list is frozen: 824 added none, and 825 added exactly the
//     five graphology/sigma names plus graphology-types (D2) — nothing else
//
// Exit 0 = pass, 1 = fail.   npm run smoke:824   (after npm run ui:build)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const dist = join(ROOT, "ui/dist/assets");
if (!existsSync(dist)) { console.error("ui/dist not built — run npm run ui:build"); process.exit(2); }
const js = readdirSync(dist).filter((f) => /^index-.*\.js$/.test(f)).map((f) => readFileSync(join(dist, f), "utf8")).join("\n");
const css = readdirSync(dist).filter((f) => /^index-.*\.css$/.test(f)).map((f) => readFileSync(join(dist, f), "utf8")).join("\n");

// vite emits template-literal strings: {id:`graph`,label:`Graph`,phases:[…]}
check(/[`"']graph[`"'],label:[`"']Graph[`"']/.test(js), "bundle carries the Graph tab (one shell)");
check(!existsSync(join(ROOT, "ui/dist/v3.html")), "/v3.html stays retired — no second entry");
for (const route of ["/api/graph/overview", "/api/graph/node", "/api/graph/edges", "/api/graph/find", "/api/graph/subgraph"]) check(js.includes(route), `panel calls ${route}`);
check(!/\/api\/graph\/(?!overview|node|edges|find|path|subgraph)/.test(js), "panel calls no route outside the six (825 D1 added the bulk projection)");
check(/\.graph-panel\{/.test(css) && /\.graph-canvas\{/.test(css) && /\.graph-explorer\{/.test(css), "graph CSS bundled (panel, canvas, explorer grid)");
check(/flow-node-rect/.test(js) && /flow-svg/.test(js), "FlowPanel's SVG vocabulary is still in the bundle (the Flow tab kept it; 825 D3 took the Graph tab off it)");

const src = readFileSync(join(ROOT, "ui/src/components/graph-panel.tsx"), "utf8");
check(!/from "d3|from "cytoscape|from "dagre|from "reactflow|from "vis-|from "sigma/.test(src), "the panel imports no graph library — graph-canvas.tsx owns sigma (825 D2)");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
// Spec 825 D2 — the frozen list grows by EXACTLY these six names and nothing else.
const frozen = ["react", "react-dom", "@types/react", "@types/react-dom", "@vitejs/plugin-react", "vite"];
const allowed825 = ["sigma", "graphology", "graphology-layout", "graphology-layout-forceatlas2", "graphology-communities-louvain", "graphology-types"];
check(frozen.every((d) => deps.includes(d)) && allowed825.every((d) => deps.includes(d)), "dependency list frozen: 824's names plus exactly 825's six");
check(!deps.some((d) => /^(d3|cytoscape|dagre|reactflow|vis-network)/.test(d) || d.startsWith("@react-sigma/") || d.startsWith("@sigma/") || (/sigma|graphology/.test(d) && !allowed825.includes(d))), "no graph-rendering dependency outside 825's six");

const app = readFileSync(join(ROOT, "ui/src/App.tsx"), "utf8");
check(/scrollIntoView\(\{ block: "center" \}\)/.test(app) && /tr\.active-row/.test(app), "ListingPanel scrolls the active row into view (D5.1)");
check(/case "graph": return true/.test(app), "cockpitToolAvailable knows the graph tab");
check(/handleSelectEntity\(entityId, "listing"\); setActiveTab\("listing"\)/.test(app), "click → handleSelectEntity(…, \"listing\") + tab switch (D5.1)");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 824 UI: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
