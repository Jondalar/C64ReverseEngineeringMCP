#!/usr/bin/env node
// Spec 824 — the Graph tab, at bundle + source level (no browser):
//   - ONE shell: the v1 bundle carries the Graph tab; /v3.html stays retired (smoke-product-ui check 9)
//   - the panel reads only the five /api/graph/* routes
//   - the neighbourhood reuses FlowPanel's SVG vocabulary (flow-svg / flow-node-* classes), no graph library
//   - the listing scrolls its active row into view (D5.1)
//   - the dependency list is frozen: no new runtime dependency for 824
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
for (const route of ["/api/graph/overview", "/api/graph/node", "/api/graph/edges", "/api/graph/find"]) check(js.includes(route), `panel calls ${route}`);
check(!/\/api\/graph\/(?!overview|node|edges|find|path)/.test(js), "panel calls no route outside the five");
check(/\.graph-panel\{/.test(css) && /\.graph-lane-node\.dimmed\{/.test(css), "graph CSS bundled (panel, dimmed lane nodes)");
check(/flow-node-rect/.test(js) && /flow-svg/.test(js), "neighbourhood reuses FlowPanel's SVG classes");

const src = readFileSync(join(ROOT, "ui/src/components/graph-panel.tsx"), "utf8");
check(!/from "d3|from "cytoscape|from "dagre|from "reactflow|from "vis-/.test(src), "no graph library imported");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
const frozen = ["react", "react-dom", "@types/react", "@types/react-dom", "@vitejs/plugin-react", "vite"];
check(frozen.every((d) => deps.includes(d)) && !deps.some((d) => /d3|cytoscape|dagre|reactflow|vis-network|sigma/.test(d)), "dependency list frozen: no graph-rendering dependency added");

const app = readFileSync(join(ROOT, "ui/src/App.tsx"), "utf8");
check(/scrollIntoView\(\{ block: "center" \}\)/.test(app) && /tr\.active-row/.test(app), "ListingPanel scrolls the active row into view (D5.1)");
check(/case "graph": return true/.test(app), "cockpitToolAvailable knows the graph tab");
check(/handleSelectEntity\(entityId, "listing"\); setActiveTab\("listing"\)/.test(app), "click → handleSelectEntity(…, \"listing\") + tab switch (D5.1)");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 824 UI: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
