#!/usr/bin/env node
// Issue #28 — one spelling of a path in knowledge/artifacts.json, whoever writes it.
//
// The store has two writers: the MCP server, which stored `relativePath` with `/`, and the
// pipeline registrar, which stored whatever `path.relative` answered — `\` on Windows. The
// registrar skips a file already registered by comparing `relativePath` with `===`, so on
// Windows a file the server had registered was registered a second time in the other
// spelling.
//
// Cases 1 and 2 are only meaningful where `path.relative` answers with `\`, which is why
// this runs on the Windows runner as well as here. Cases 3 and 4 plant what a Windows store
// written before the fix holds, so they bite on every platform.
//
// Hermetic: a temp project, the built server and pipeline, no ROMs, no runtime.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => pathToFileURL(join(ROOT, "dist", p)).href;
const { ProjectKnowledgeService } = await import(dist("project-knowledge/service.js"));
const { auditProject } = await import(dist("project-knowledge/audit.js"));
const REGISTRAR = join(ROOT, "dist", "pipeline", "lib", "artifact-register.cjs");

let pass = 0, fail = 0;
const check = (ok, what, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};

console.log(`Issue #28 — relativePath spelling  (platform: ${process.platform})\n`);

const proj = realpathSync(mkdtempSync(join(tmpdir(), "c64re-relpath-")));
process.on("exit", () => { try { rmSync(proj, { recursive: true, force: true }); } catch {} });
mkdirSync(join(proj, "knowledge"), { recursive: true });
writeFileSync(join(proj, "knowledge", "phase-plan.json"), "{}\n");
mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
const file = (n) => join(proj, "artifacts", "prg", `${n}_analysis.json`);
for (const n of ["a", "b", "c"]) writeFileSync(file(n), `{"name":"${n}"}\n`);
const want = (n) => `artifacts/prg/${n}_analysis.json`;

const storePath = join(proj, "knowledge", "artifacts.json");
const rows = () => JSON.parse(readFileSync(storePath, "utf8")).items;
const rowsFor = (n) => rows().filter((r) => r.relativePath.replace(/\\/g, "/") === want(n));

// The registrar reads process.cwd(), so it runs where a pipeline child runs: in the project.
function register(n) {
  const script = `require(${JSON.stringify(REGISTRAR)}).registerCliArtifact({
    kind: "analysis-run", scope: "analysis", title: ${JSON.stringify(`${n} analysis`)},
    path: ${JSON.stringify(file(n))}, producedByTool: "e2e-relpath-spelling" });`;
  const r = spawnSync(process.execPath, ["-e", script], { cwd: proj, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`registrar for ${n} exited ${r.status}: ${r.stderr}`);
}

console.log("1. the registrar writes `/`");
register("a");
{
  const [row] = rowsFor("a");
  check(Boolean(row) && row.relativePath === want("a"), "a registration is stored as artifacts/prg/…", row?.relativePath);
}

console.log("\n2. a file the server registered is not registered again by the pipeline");
new ProjectKnowledgeService(proj).saveArtifact({
  kind: "analysis-run", scope: "analysis", title: "b analysis", path: file("b"), producedByTool: "e2e-server",
});
register("b");
check(rowsFor("b").length === 1, "one row for b, not one per writer", `${rowsFor("b").length} row(s)`);

console.log("\n3. a Windows store written before the fix heals when read");
{
  const store = JSON.parse(readFileSync(storePath, "utf8"));
  for (const r of store.items) if (r.relativePath === want("a")) r.relativePath = "artifacts\\prg\\a_analysis.json";
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
}
check(rows().some((r) => r.relativePath.includes("\\")), "(planted: the store now holds a `\\` row)");
const seen = new ProjectKnowledgeService(proj).listArtifacts().find((r) => r.relativePath.replace(/\\/g, "/") === want("a"));
check(seen?.relativePath === want("a"), "the server reads it in the one spelling", seen?.relativePath);
register("a");
check(rowsFor("a").length === 1, "and the registrar does not register it a second time", `${rowsFor("a").length} row(s)`);
register("c");
check(!rows().some((r) => r.relativePath.includes("\\")), "the next write stores the old row healed",
  rows().map((r) => r.relativePath).join(", "));

console.log("\n4. a file registered twice is reported, not merged");
const clean = auditProject(proj);
check(!clean.findings.some((f) => f.id === "duplicate-artifact-registrations"), "no finding while every file has one row");
{
  const store = JSON.parse(readFileSync(storePath, "utf8"));
  const c = store.items.find((r) => r.relativePath === want("c"));
  store.items.push({ ...c, id: `${c.id}-again`, relativePath: "artifacts\\prg\\c_analysis.json" });
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
}
const dup = auditProject(proj).findings.find((f) => f.id === "duplicate-artifact-registrations");
check(Boolean(dup) && dup.paths.some((p) => p.includes("-again")), "the audit names the second record and the first",
  dup?.paths?.[0]);
check(rows().length === 4, "and nothing was removed on its behalf", `${rows().length} rows`);

console.log(`\n${fail ? "RED " : "GREEN"}  issue #28 relativePath spelling: ${pass} pass, ${fail} fail.`);
process.exit(fail ? 1 : 0);
