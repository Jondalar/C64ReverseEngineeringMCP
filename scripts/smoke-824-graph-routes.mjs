#!/usr/bin/env node
// Spec 824 D1 — the five GET /api/graph/* routes, smoke-covered BEFORE a line
// of TSX (rule 6). Boots the real workspace HTTP server on a temp project:
//   - before any seed: 404 { error, next } naming the product step
//   - after analyze + seed: find / node / edges / path / overview answer 200
//   - the body of /api/graph/find IS `c64re graph find --json` (823 D7, once more)
//   - a missing arg is 400 { error }; an unknown verb is 404
//
// Exit 0 = pass, 1 = fail.   npm run smoke:824-routes

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const server = join(ROOT, "dist/workspace-ui/server.js");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(server) || !existsSync(cli)) { console.error("dist missing — run npm run build:mcp"); process.exit(2); }

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const PORT = 4327;
const projectDir = mkdtempSync(join(tmpdir(), "c64re-824-routes-"));
mkdirSync(join(projectDir, "knowledge"), { recursive: true });
mkdirSync(join(projectDir, "analysis"), { recursive: true });
writeFileSync(join(projectDir, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "p824", name: "s824", slug: "s824", rootPath: projectDir, status: "active", createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" }));

const srv = spawn(process.execPath, [server, "--port", String(PORT), "--project", projectDir, "--api-only"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
srv.stdout.on("data", (b) => { log += b; });
srv.stderr.on("data", (b) => { log += b; });
const tcpUp = (port, ms = 800) => new Promise((r) => { const s = createConnection({ host: "127.0.0.1", port }); const d = (v) => { try { s.destroy(); } catch {} r(v); }; const t = setTimeout(() => d(false), ms); s.once("connect", () => { clearTimeout(t); d(true); }); s.once("error", () => { clearTimeout(t); d(false); }); });
const waitTcp = async (port, ms = 45000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await tcpUp(port)) return true; await new Promise((r) => setTimeout(r, 300)); } return false; };
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body, text }; };
const pd = `projectDir=${encodeURIComponent(projectDir)}`;

try {
  check(await waitTcp(PORT), `workspace HTTP up on :${PORT}`);

  const empty = await get(`/api/graph/overview?${pd}`);
  check(empty.status === 404 && Array.isArray(empty.body?.next) && empty.body.next.includes("analyze_prg"), "no graph yet → 404 with next[] naming the product step");

  // analyze + seed the fixture ($1000: jsr $1020 ; lda $D011 ; sta $D011 ; jsr $FFD2 ; rts   $1020: rts)
  const image = new Uint8Array(0x40).fill(0xea);
  image.set([0x20, 0x20, 0x10, 0xad, 0x11, 0xd0, 0x8d, 0x11, 0xd0, 0x20, 0xd2, 0xff, 0x60], 0);
  image.set([0x60], 0x20);
  const prg = new Uint8Array(image.length + 2); prg[0] = 0x00; prg[1] = 0x10; prg.set(image, 2);
  const prgPath = join(projectDir, "analysis", "fixture.prg");
  const analysisPath = join(projectDir, "analysis", "fixture_analysis.json");
  writeFileSync(prgPath, prg);
  execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prgPath, analysisPath, "1000"], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: projectDir } });
  execFileSync(process.execPath, [cli, "graph", "seed", "--project", projectDir], { stdio: ["ignore", "pipe", "pipe"] });

  const find = await get(`/api/graph/find?${pd}&q=%241000`);
  check(find.status === 200 && find.body.hits?.some((h) => h.id === "s824:ram/fixture:routine:1000"), "GET /api/graph/find?q=$1000 → the routine id");
  const cliFind = execFileSync(process.execPath, [cli, "graph", "find", "$1000", "--project", projectDir, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  check(cliFind.trim() === find.text.trim(), "route body == `c64re graph find --json` byte for byte");

  const node = await get(`/api/graph/node?${pd}&ref=s824%3Aram%2Ffixture%3Aroutine%3A1000`);
  check(node.status === 200 && node.body.generatedLabel === "W1000" && node.body.rom?.some((r) => /CHROUT/.test(r)), "GET /api/graph/node → card with label and ROM use");

  const edges = await get(`/api/graph/edges?${pd}&ref=%24D011&direction=in&kind=writes`);
  check(edges.status === 200 && edges.body.edges?.some((e) => e.evidence?.instruction === "sta $D011"), 'GET /api/graph/edges?ref=$D011&direction=in&kind=writes → "sta $D011"');

  const path = await get(`/api/graph/path?${pd}&from=%241000&to=CHROUT`);
  check(path.status === 200 && path.body.paths?.length === 1, "GET /api/graph/path?from=$1000&to=CHROUT → one path");

  const ov = await get(`/api/graph/overview?${pd}`);
  check(ov.status === 200 && ov.body.sections?.some((s) => s.id === "rom" && s.count >= 1), "GET /api/graph/overview → sections with rom use");

  const bad = await get(`/api/graph/find?${pd}`);
  check(bad.status === 400 && typeof bad.body.error === "string", "missing q → 400 { error }");
  const unknown = await get(`/api/graph/nope?${pd}`);
  check(unknown.status === 404 && Array.isArray(unknown.body.routes), "unknown verb → 404 with the route list");
  check(!/ExperimentalWarning/.test(log), "server log carries no ExperimentalWarning");
} catch (error) {
  fail(`route smoke failed: ${error.message}\n${log.slice(-600)}`);
} finally {
  srv.kill();
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 824 routes: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
