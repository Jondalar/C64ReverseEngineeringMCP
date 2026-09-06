#!/usr/bin/env node
// Spec 825 D1 — GET /api/graph/subgraph, smoke-covered BEFORE a line of TSX
// (DOCTRINE rule 6). Boots the real workspace HTTP server on a temp project
// with TWO analysis owners, and holds the route to the contract:
//   - the body IS `c64re graph subgraph --json`, byte for byte (823 D7)
//   - nodes sorted by id, edges sorted by (from, to, type, origin, layer)
//   - every edge endpoint is IN `nodes`; a platform endpoint is synthesised
//     with platform:true and the platform KB's name
//   - Σ n over the collapsed edges == counts.rows == a direct COUNT(*) on
//     knowledge/graph.sqlite for the scope
//   - scope=focus:<ref>&depth=1 yields exactly the node set of
//     /api/graph/edges?ref=<ref>&direction=both&depth=1
//   - owner: and bank: scopes partition the `all` set
//   - a second seed (818 idempotence) yields a byte-identical body
//   - 400 (bad scope) / 404 (unknown verb, unknown subsystem) / 405 (POST)
//
// Exit 0 = pass, 1 = fail.   npm run smoke:825-routes

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const server = join(ROOT, "dist/workspace-ui/server.js");
const cli = join(ROOT, "dist/cli.js");
const pipeline = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(server) || !existsSync(cli) || !existsSync(pipeline)) { console.error("dist missing — run npm run build"); process.exit(2); }
const { DatabaseSync } = await import(join(ROOT, "dist/platform-kb/sqlite-quiet.js"));

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const PORT = 4329;
const projectDir = mkdtempSync(join(tmpdir(), "c64re-825-routes-"));
mkdirSync(join(projectDir, "knowledge"), { recursive: true });
mkdirSync(join(projectDir, "analysis"), { recursive: true });
writeFileSync(join(projectDir, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "p825", name: "s825", slug: "s825", rootPath: projectDir, status: "active", createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" }));

const srv = spawn(process.execPath, [server, "--port", String(PORT), "--project", projectDir, "--api-only"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
srv.stdout.on("data", (b) => { log += b; });
srv.stderr.on("data", (b) => { log += b; });
const tcpUp = (port, ms = 800) => new Promise((r) => { const s = createConnection({ host: "127.0.0.1", port }); const d = (v) => { try { s.destroy(); } catch { /* already gone */ } r(v); }; const t = setTimeout(() => d(false), ms); s.once("connect", () => { clearTimeout(t); d(true); }); s.once("error", () => { clearTimeout(t); d(false); }); });
const waitTcp = async (port, ms = 45000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await tcpUp(port)) return true; await new Promise((r) => setTimeout(r, 300)); } return false; };
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body, text }; };
const pd = `projectDir=${encodeURIComponent(projectDir)}`;
const graphCli = (...a) => execFileSync(process.execPath, [cli, "graph", ...a, "--project", projectDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** the analysis + seed pass, run twice by the idempotence check */
function analyzeAndSeed(stem, org, bytes) {
  const image = new Uint8Array(0x40).fill(0xea);
  for (const [at, run] of bytes) image.set(run, at);
  const prg = new Uint8Array(image.length + 2);
  prg[0] = org & 0xff; prg[1] = (org >> 8) & 0xff; prg.set(image, 2);
  const prgPath = join(projectDir, "analysis", `${stem}.prg`);
  const analysisPath = join(projectDir, "analysis", `${stem}_analysis.json`);
  writeFileSync(prgPath, prg);
  execFileSync(process.execPath, [pipeline, "analyze-prg", prgPath, analysisPath, org.toString(16)], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: projectDir } });
}

try {
  check(await waitTcp(PORT), `workspace HTTP up on :${PORT}`);

  const empty = await get(`/api/graph/subgraph?${pd}`);
  check(empty.status === 404 && Array.isArray(empty.body?.next) && empty.body.next.includes("analyze_prg"), "no graph yet → 404 with next[] naming the product step");

  // two owners, so `owner:` is a partition and not a rename of `all`
  analyzeAndSeed("fixture", 0x1000, [[0x00, [0x20, 0x20, 0x10, 0xad, 0x11, 0xd0, 0x8d, 0x11, 0xd0, 0x20, 0xd2, 0xff, 0x60]], [0x20, [0x60]]]);
  analyzeAndSeed("second", 0x2000, [[0x00, [0x20, 0x10, 0x20, 0xad, 0x12, 0xd0, 0x20, 0xd2, 0xff, 0x60]], [0x10, [0x60]]]);
  graphCli("seed");

  // ---- 1. the body IS the CLI's --json
  const all = await get(`/api/graph/subgraph?${pd}&scope=all`);
  check(all.status === 200 && all.body.counts?.nodes > 0, `GET /api/graph/subgraph?scope=all → 200 (${all.body?.counts?.nodes} nodes, ${all.body?.counts?.edges} edges, ${all.body?.counts?.rows} rows)`);
  const cliAll = graphCli("subgraph", "--scope", "all", "--json");
  check(cliAll === all.text, "route body == `c64re graph subgraph --scope all --json` byte for byte");

  // ---- 2. sorting is stable and by id
  const sortedNodes = [...all.body.nodes].map((n) => n.id).every((id, i, xs) => i === 0 || xs[i - 1] < id);
  check(sortedNodes, "nodes sorted by id, strictly ascending (no duplicate ids)");
  const edgeKey = (e) => [e.from, e.to, e.type, e.origin, e.layer].join(" ");
  const sortedEdges = all.body.edges.map(edgeKey).every((k, i, xs) => i === 0 || xs[i - 1] < k);
  check(sortedEdges, "edges sorted by (from, to, type, origin, layer), strictly ascending — the collapse key is unique");

  // ---- 3. no edge points at a node that is not in `nodes`
  const ids = new Set(all.body.nodes.map((n) => n.id));
  const orphanEnds = all.body.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
  check(orphanEnds.length === 0, `every edge endpoint is in nodes (${orphanEnds.length} orphan ends)`);

  // ---- 4. platform endpoints synthesised, with the KB's name
  const platform = all.body.nodes.filter((n) => n.platform);
  const chrout = all.body.nodes.find((n) => n.id === "c64:rom:ffd2");
  const d011 = all.body.nodes.find((n) => n.id === "c64:io:d011");
  check(platform.length > 0 && platform.every((n) => ["zp", "ram", "io", "rom"].includes(n.kind) && n.dangling === false), `${platform.length} platform endpoints synthesised with a platform kind`);
  check(Boolean(chrout) && /CHROUT/.test(chrout.label ?? "") && chrout.platform === true, "c64:rom:ffd2 carries the platform KB's name (CHROUT), platform: true");
  check(Boolean(d011) && d011.kind === "io" && d011.platform === true, "c64:io:d011 is an io node from the KB, not a dangling reference");
  check(all.body.nodes.every((n) => !(n.platform && n.dangling)), "no node is platform and dangling at once");

  // ---- 5. Σ n == counts.rows == a direct COUNT(*) on the store
  const db = new DatabaseSync(join(projectDir, "knowledge", "graph.sqlite"), { readOnly: true });
  const storeRows = Number(db.prepare("SELECT COUNT(*) AS n FROM edges").get().n);
  const sigma = all.body.edges.reduce((a, e) => a + e.n, 0);
  check(sigma === all.body.counts.rows, `Σ n over collapsed edges == counts.rows (${sigma})`);
  check(sigma === storeRows, `Σ n == SELECT COUNT(*) FROM edges (${storeRows})`);
  check(all.body.counts.nodes === all.body.nodes.length && all.body.counts.edges === all.body.edges.length, "counts.nodes / counts.edges agree with the arrays");

  // ---- 6. focus:<ref>&depth=1 == the 823 edges walk
  const ref = "s825:ram/fixture:routine:1000";
  const enc = encodeURIComponent(ref);
  const focus = await get(`/api/graph/subgraph?${pd}&scope=focus%3A${enc}&depth=1`);
  const walk = await get(`/api/graph/edges?${pd}&ref=${enc}&direction=both&depth=1&limit=200`);
  check(focus.status === 200 && walk.status === 200, "focus scope and the 823 edges walk both answer 200");
  const walkIds = new Set([ref, ...walk.body.edges.flatMap((e) => [e.from.id ?? e.from, e.to.id ?? e.to])]);
  const focusIds = new Set(focus.body.nodes.map((n) => n.id));
  const missing = [...walkIds].filter((i) => !focusIds.has(i));
  const extra = [...focusIds].filter((i) => !walkIds.has(i));
  check(missing.length === 0 && extra.length === 0, `scope=focus:${ref}&depth=1 node set == /api/graph/edges?…&depth=1 node set (${focusIds.size} nodes)`);
  check(focus.body.edges.reduce((a, e) => a + e.n, 0) === focus.body.counts.rows, "focus scope: Σ n == counts.rows");

  // ---- 7. owner: and bank: partition the all set
  const owners = ["fixture", "second"];
  const scoped = {};
  for (const o of owners) scoped[o] = (await get(`/api/graph/subgraph?${pd}&scope=owner%3A${o}`)).body;
  const coreOf = (body, o) => new Set(body.nodes.filter((n) => n.owner === o).map((n) => n.id));
  const cores = owners.map((o) => coreOf(scoped[o], o));
  check(owners.every((o) => scoped[o].nodes.every((n) => ids.has(n.id))), "every owner scope's node set ⊆ the `all` node set");
  check(cores[0].size > 0 && cores[1].size > 0 && [...cores[0]].every((i) => !cores[1].has(i)), `owner cores are disjoint (${cores[0].size} + ${cores[1].size})`);
  const ownedInAll = new Set(all.body.nodes.filter((n) => n.owner !== null && owners.includes(n.owner)).map((n) => n.id));
  const unionCores = new Set([...cores[0], ...cores[1]]);
  check(ownedInAll.size === unionCores.size && [...ownedInAll].every((i) => unionCores.has(i)), `the owner cores cover every owned node in \`all\` (${ownedInAll.size}) — a partition of the owned half`);
  for (const o of owners) {
    const core = cores[owners.indexOf(o)];
    const rows = Number(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE from_id IN (SELECT id FROM nodes WHERE owner = ?) OR to_id IN (SELECT id FROM nodes WHERE owner = ?)").get(o, o).n);
    const sig = scoped[o].edges.reduce((a, e) => a + e.n, 0);
    check(sig === scoped[o].counts.rows && sig === rows, `scope=owner:${o} — Σ n == counts.rows == COUNT(*) for the scope (${rows}), core ${core.size}`);
  }
  const bankScope = await get(`/api/graph/subgraph?${pd}&scope=bank%3A0`);
  check(bankScope.status === 200 && bankScope.body.nodes.every((n) => ids.has(n.id)), "scope=bank:0 answers 200 and stays inside the `all` set");
  check(all.body.nodes.filter((n) => n.bank !== null).length === 0 && bankScope.body.nodes.filter((n) => n.bank === 0).length === 0, "no banked node in this fixture — bank: is empty, not wrong");

  // ---- 8. kinds= is a filter on both ends
  const routines = await get(`/api/graph/subgraph?${pd}&scope=all&kinds=routine`);
  check(routines.status === 200 && routines.body.nodes.every((n) => n.kind === "routine") && routines.body.edges.every((e) => routines.body.nodes.some((n) => n.id === e.from) && routines.body.nodes.some((n) => n.id === e.to)), "kinds=routine drops every other kind AND the edges that would dangle");

  // ---- 9. idempotence: a second seed yields a byte-identical body
  const beforeHash = all.text;
  graphCli("seed");
  const again = await get(`/api/graph/subgraph?${pd}&scope=all`);
  check(again.text === beforeHash, "a second seed (818 idempotence) yields a byte-identical subgraph body");
  db.close();

  // ---- 10. the error rules
  const badScope = await get(`/api/graph/subgraph?${pd}&scope=nonsense`);
  check(badScope.status === 400 && typeof badScope.body.error === "string", "an unparseable scope → 400 { error }");
  const noSub = await get(`/api/graph/subgraph?${pd}&scope=subsystem%3Anope`);
  check(noSub.status === 404 && /subsystem/.test(noSub.body.error ?? ""), "scope=subsystem:<unknown> → 404 { error }");
  const noFocus = await get(`/api/graph/subgraph?${pd}&scope=focus%3Anot_a_node_anywhere`);
  check(noFocus.status === 404, "scope=focus:<unresolvable> → 404");
  const unknown = await get(`/api/graph/nope?${pd}`);
  check(unknown.status === 404 && Array.isArray(unknown.body.routes) && unknown.body.routes.length === 6 && unknown.body.routes.includes("subgraph"), "unknown verb → 404 naming SIX routes");
  const post = await fetch(`http://127.0.0.1:${PORT}/api/graph/subgraph?${pd}`, { method: "POST" });
  check(post.status === 405 && post.headers.get("allow") === "GET", "POST /api/graph/subgraph → 405 with Allow: GET (read-only, D9)");
  check(!/ExperimentalWarning/.test(log), "server log carries no ExperimentalWarning");
} catch (error) {
  fail(`subgraph route smoke failed: ${error.message}\n${error.stack ?? ""}\n${log.slice(-600)}`);
} finally {
  srv.kill();
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 825 subgraph route: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
