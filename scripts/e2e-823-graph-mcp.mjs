#!/usr/bin/env node
// Spec 823 — the graph MCP surface, end-to-end through the REAL server over
// stdio JSON-RPC with the DEFAULT tool surface, on a project OUTSIDE the repo.
//
//   - the five graph_* tools are listed on the default surface
//   - a synthesized PRG is analyzed and seeded (819 + 820) through the CLI
//   - graph_find → ids round-trip into graph_node and graph_edges
//   - graph_edges answers callers / writers with instruction evidence
//   - graph_path finds entry → CHROUT; graph_overview has entries + hardware
//   - every reply ends with a ```json block; the block equals `c64re graph … --json` byte-for-byte (D7)
//   - no absolute path, no rowid, no runtime brand leaks into any reply
//   - graph-tools.ts imports nothing but knowledge-graph/*, zod, safe-handler, types (D1, thin by gate)
//   - stderr of the server carries no ExperimentalWarning
//
// Exit 0 = pass, 1 = fail.   npm run e2e:823

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run npm run build:mcp"); process.exit(2); }

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

// ---------------------------------------------------------------- D1: thin by gate

const src = readFileSync(join(ROOT, "src/server-tools/graph-tools.ts"), "utf8");
const imports = [...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
const allowed = (i) => i.startsWith("../knowledge-graph/") || i === "zod" || i === "./safe-handler.js" || i === "./types.js" || i.startsWith("@modelcontextprotocol/");
check(imports.every(allowed), `graph-tools.ts imports only knowledge-graph/*, zod, safe-handler, types (${imports.length} imports)`);
check(!imports.some((i) => /node:fs|node:sqlite|project-knowledge/.test(i)), "graph-tools.ts imports no fs, no sqlite, no project-knowledge");

// ---------------------------------------------------------------- project + seed

const projectDir = mkdtempSync(join(tmpdir(), "c64re-e2e-823-"));
check(!projectDir.startsWith(ROOT), "project dir is outside the C64RE repo");

// The project is initialized through the REAL door (project_init) once the
// server is up; the fixture is analyzed and seeded after that.
function seedFixture() {
  mkdirSync(join(projectDir, "analysis"), { recursive: true });
  // $1000: jsr $1020 ; lda $D011 ; and #$7f ; sta $D011 ; jsr $FFD2 ; ldx #3 ; loop: dex ; bne loop ; rts   $1020: lda #1 ; sta $D020 ; rts
  const image = new Uint8Array(0x100).fill(0xea);
  image.set([0x20, 0x20, 0x10, 0xad, 0x11, 0xd0, 0x29, 0x7f, 0x8d, 0x11, 0xd0, 0x20, 0xd2, 0xff, 0xa2, 0x03, 0xca, 0xd0, 0xfd, 0x60], 0);
  image.set([0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60], 0x20);
  const prg = new Uint8Array(image.length + 2); prg[0] = 0x00; prg[1] = 0x10; prg.set(image, 2);
  const prgPath = join(projectDir, "analysis", "fixture.prg");
  const analysisPath = join(projectDir, "analysis", "fixture_analysis.json");
  writeFileSync(prgPath, prg);
  execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prgPath, analysisPath, "1000"], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: projectDir } });
  const seedOut = execFileSync(process.execPath, [cli, "graph", "seed", "--project", projectDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  check(/819: routines=/.test(seedOut), "c64re graph seed ran 819 + 820 on the fixture");
}

// ---------------------------------------------------------------- the server over stdio

const proc = spawn(process.execPath, [cli], { cwd: tmpdir(), env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_FULL_TOOLS: "" }, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
proc.stderr.on("data", (d) => { stderr += d.toString(); });
let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
let nextId = 1;
const rpc = (method, params, timeoutMs = 20000) => new Promise((res, rej) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`timeout ${method}`)); }, timeoutMs);
  pending.set(id, (m) => { clearTimeout(timer); res(m); });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const notify = (method, params) => proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
const callTool = async (name, args) => {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  return res.result;
};
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const jsonBlock = (text) => { const m = text.match(/```json\n([\s\S]*?)\n```\s*$/); return m ? JSON.parse(m[1]) : undefined; };
const rawBlock = (text) => { const m = text.match(/```json\n([\s\S]*?)\n```\s*$/); return m ? m[1] : undefined; };
const leaks = (text) => [/\/Users\//, /\/tmp\//, /\/var\/folders\//, /\browid\b/i, /\bTRX64\b/i].filter((re) => re.test(text)).map(String);

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-823", version: "0" } });
  notify("notifications/initialized", {});
  const init = await callTool("project_init", { project_dir: projectDir, name: "s823" });
  check(!/Tool Error/i.test(textOf(init)), "project_init through the MCP door");
  const slug = JSON.parse(readFileSync(join(projectDir, "knowledge", "project.json"), "utf8")).slug;
  check(slug === "s823", `project slug is ${slug}`);
  seedFixture();
  const listed = await rpc("tools/list", {});
  const names = new Set((listed.result?.tools ?? []).map((t) => t.name));
  const five = ["graph_find", "graph_node", "graph_edges", "graph_path", "graph_overview"];
  check(five.every((n) => names.has(n)), `default surface lists ${five.join(", ")}`);
  for (const t of listed.result?.tools ?? []) {
    if (!five.includes(t.name)) continue;
    check(/\bUse [a-z]/i.test(t.description) && /Not for/.test(t.description), `${t.name}: description has a Use-trigger and a Not-for pointer`);
  }

  // find → ids
  const find = textOf(await callTool("graph_find", { query: "$1000" }));
  const findJson = jsonBlock(find);
  if (!findJson) console.log(`  info  graph_find reply head: ${find.slice(0, 300).replace(/\n/g, " ⏎ ")}`);
  check(findJson && findJson.hits.some((h) => h.id === "s823:ram/fixture:routine:1000"), "graph_find($1000) returns the routine id");
  const routineId = "s823:ram/fixture:routine:1000";

  // node card
  const node = textOf(await callTool("graph_node", { ref: routineId }));
  const card = jsonBlock(node);
  check(card && card.id === routineId && card.generatedLabel === "W1000" && card.humanName === null, "graph_node: card with generated label W1000 and no human name");
  check(card && card.hardware.some((h) => /D011/.test(h)) && card.rom.some((r) => /FFD2|CHROUT/.test(r)), "graph_node: hardware D011 and rom CHROUT listed");
  check(Array.isArray(card?.next) && card.next.length > 0 && card.next.every((n) => five.includes(n.tool)), "graph_node: next[] names graph tools");

  // edges: writers of $D011, callers of CHROUT
  const writers = jsonBlock(textOf(await callTool("graph_edges", { ref: "$D011", direction: "in", kind: "writes" })));
  check(writers && writers.edges.some((e) => e.from.id === routineId && e.evidence.instruction === "sta $D011"), 'graph_edges($D011 in writes): the routine, evidence "sta $D011"');
  const callers = jsonBlock(textOf(await callTool("graph_edges", { ref: "CHROUT", direction: "in", kind: "calls_rom" })));
  check(callers && callers.edges.some((e) => e.to.id === "c64:rom:ffd2" && e.from.id === routineId), "graph_edges(CHROUT in calls_rom): the routine calls c64:rom:ffd2");
  const twoHop = jsonBlock(textOf(await callTool("graph_edges", { ref: routineId, direction: "out", kind: "calls", depth: 2 })));
  check(twoHop && twoHop.depth === 2, "graph_edges depth 2 accepted");

  // path
  const path = jsonBlock(textOf(await callTool("graph_path", { from: "$1000", to: "CHROUT" })));
  check(path && path.paths.length === 1 && path.paths[0].some((h) => h.to === "c64:rom:ffd2"), "graph_path($1000 → CHROUT): one path ending at c64:rom:ffd2");
  const noPath = jsonBlock(textOf(await callTool("graph_path", { from: "$1020", to: "CHROUT" })));
  check(noPath && noPath.paths.length === 0 && typeof noPath.frontier === "number", "graph_path with no route says so and reports the frontier");

  // overview
  const ov = jsonBlock(textOf(await callTool("graph_overview", {})));
  const sec = (id) => ov?.sections.find((s) => s.id === id);
  check(sec("entries")?.count >= 1 && sec("hardware")?.count >= 2 && sec("rom")?.count >= 1, "graph_overview: entries, hardware, rom populated");

  // every reply has a json block and no leak
  const replies = [find, node];
  for (const r of replies) check(jsonBlock(r) !== undefined, "reply ends with a ```json block");
  const allText = [find, node].join("\n");
  const leak = leaks(allText);
  check(leak.length === 0, `no path / rowid / brand leak in replies${leak.length ? ` (${leak.join(" ")})` : ""}`);

  // D7: CLI --json is byte-identical to the tool's JSON block
  const cliFind = execFileSync(process.execPath, [cli, "graph", "find", "$1000", "--project", projectDir, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  check(cliFind.trim() === rawBlock(find)?.trim(), "CLI `graph find $1000 --json` == graph_find's JSON block, byte for byte");
  const cliNode = execFileSync(process.execPath, [cli, "graph", "node", routineId, "--project", projectDir, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  check(cliNode.trim() === rawBlock(node)?.trim(), "CLI `graph node <id> --json` == graph_node's JSON block");
} catch (error) {
  fail(`server round-trip failed: ${error.message}`);
} finally {
  proc.stdin.end();
  proc.kill();
}
await new Promise((r) => setTimeout(r, 200));
check(!/ExperimentalWarning/.test(stderr), "server stderr carries no ExperimentalWarning");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 823: ${pass} pass, ${failCount} fail.  project: ${projectDir}`);
process.exit(failCount ? 1 : 0);
