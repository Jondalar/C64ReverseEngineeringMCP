#!/usr/bin/env node
// Spec 833 D5 — a default tool that can find its project, and the gate that sees it.
//
// `sandbox_6502_run` resolved its project with `context.projectDir(undefined, true)`:
// no hint. The resolver then has nothing to walk up from and depends on
// C64RE_PROJECT_DIR or on the process cwd happening to sit inside a project —
// the cwd coupling no DEFAULT tool may have. Every other path-taking tool passes
// a hint (`project_dir ?? image_path` in disk-g64.ts); this one had the
// information all along, in `loads[]`, and threw it away.
//
// Hermetic on purpose:
//   * C64RE_PROJECT_DIR is DELETED from this process before anything imports,
//     so the environment fallback cannot rescue a missing hint;
//   * the cwd is moved to a neutral temp directory that is inside no project,
//     so the cwd fallback cannot either;
//   * the project is a temp directory with a knowledge/phase-plan.json marker;
//   * no daemon, no trx64cli, no ROMs — the tool's project resolution happens
//     entirely on this side of the bridge, before any core runs, so it is
//     decided here and can be checked here. The run itself is never asserted on.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:833-sandbox

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

// Before anything else: the two fallbacks this tool used to lean on are removed.
delete process.env.C64RE_PROJECT_DIR;
const neutralCwd = mkdtempSync(join(tmpdir(), "c64re-833-cwd-"));
process.chdir(neutralCwd);

let pass = 0;
let failCount = 0;
const ok = (m, d = "") => { pass += 1; console.log(`  PASS  ${m}${d ? `  (${d})` : ""}`); };
const fail = (m, d = "") => { failCount += 1; console.log(`  FAIL  ${m}${d ? `  (${d})` : ""}`); };
const check = (c, m, d = "") => (c ? ok(m, d) : fail(m, d));

console.log("Spec 833 D5 — sandbox_6502_run finds its project\n");

const { resolveProjectDir } = await import(pathToFileURL(join(ROOT, "dist/project-root.js")).href);
const { registerSandboxTools } = await import(pathToFileURL(join(ROOT, "dist/server-tools/sandbox.js")).href);
const { DEFAULT_TOOLS } = await import(pathToFileURL(join(ROOT, "dist/server-tools/tier-tools.js")).href);
const { collectToolInventory } = await import(pathToFileURL(join(ROOT, "dist/server.js")).href);
const { pathParamsOf } = await import(pathToFileURL(join(ROOT, "scripts/lib/schema-path-walk.mjs")).href);

// ------------------------------------------------------------ the temp project
const project = mkdtempSync(join(tmpdir(), "c64re-833-proj-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
writeFileSync(join(project, "knowledge", "phase-plan.json"), JSON.stringify({ phases: [] }));
mkdirSync(join(project, "payloads"), { recursive: true });
// A one-instruction blob: BRK. Nothing here executes it; it only has to EXIST at
// a path, so that a wrong project root shows up as a path that is not this one.
writeFileSync(join(project, "payloads", "blob.bin"), Buffer.from([0x00]));
writeFileSync(join(project, "payloads", "blob.prg"), Buffer.from([0x00, 0x10, 0x00]));

// A second, LOOSE directory that is inside no project at all — the negative control.
const loose = mkdtempSync(join(tmpdir(), "c64re-833-loose-"));
writeFileSync(join(loose, "stray.bin"), Buffer.from([0x00]));

check(!existsSync(join(neutralCwd, "knowledge")), "the cwd is inside no project", neutralCwd);
check(process.env.C64RE_PROJECT_DIR === undefined, "C64RE_PROJECT_DIR is not set");

// --------------------------------------------------- the tool, really wired up
// The context uses the REAL resolver — it is the thing under test — and records
// the hint every call was made with. A hint of `undefined` IS the defect.
const hints = [];
const context = {
  projectDir: (hintPath, requireWritable = false) => {
    hints.push(hintPath);
    return resolveProjectDir({ cwd: process.cwd(), repoDir: ROOT, hintPath, requireWritable });
  },
  toolsDir: () => join(ROOT, "pipeline"),
  readTextFile: (p) => p,
  cliResultToContent: (r) => ({ content: [{ type: "text", text: `${r.stdout}${r.stderr}` }] }),
  tryRegisterKnowledgeArtifacts: () => ({}),
};

const handlers = new Map();
const schemas = new Map();
const server = { tool: (name, _desc, schema, handler) => { schemas.set(name, schema); handlers.set(name, handler); } };
registerSandboxTools(server, context);

const run = handlers.get("sandbox_6502_run");
check(typeof run === "function", "sandbox_6502_run is registered");

const textOf = (res) => (res?.content ?? []).map((c) => c.text ?? "").join("\n");
// The resolver's own failure message. Its ABSENCE is what proves the project was
// found; what happens after — a real core run, or trx64cli missing — is not this
// gate's business and is never asserted on.
const RESOLVER_FAILED = /requires a valid project directory/;

async function callRun(args) {
  hints.length = 0;
  const out = textOf(await run(args));
  return { out, hint: hints[0], resolverFailed: RESOLVER_FAILED.test(out) };
}

// --------------------------------------------- 1. explicit project_dir is used
{
  const r = await callRun({
    project_dir: project,
    loads: [{ raw_path: "payloads/blob.bin", address: "1000" }],
    initial_pc: "1000",
    max_steps: 1,
  });
  check(r.hint === project, "1 an explicit project_dir is the hint the resolver gets", String(r.hint));
  check(!r.resolverFailed, "1b the project resolves with no C64RE_PROJECT_DIR and a cwd outside it",
    r.resolverFailed ? r.out.split("\n")[0] : "resolved");
  check(!/c64re-833-cwd-/.test(r.out), "1c the load path was NOT resolved against the process cwd");
}

// --------------------------- 2. no project_dir: the first load path is the hint
{
  const r = await callRun({
    loads: [{ raw_path: join(project, "payloads", "blob.bin"), address: "1000" }],
    initial_pc: "1000",
    max_steps: 1,
  });
  check(r.hint === join(project, "payloads", "blob.bin"),
    "2 without project_dir the FIRST load path is the hint", String(r.hint));
  check(r.hint !== undefined, "2b the hint is never `undefined` — the defect's own signature");
  check(!r.resolverFailed, "2c the project is found by walking up from that load path",
    r.resolverFailed ? r.out.split("\n")[0] : "resolved");
}

// 2d. a prg_path load hints just the same, and an entry with no path is skipped
//     over rather than ending the search at the first entry.
{
  const r = await callRun({
    loads: [
      { hex_bytes: "00", address: "0900" },
      { prg_path: join(project, "payloads", "blob.prg") },
    ],
    initial_pc: "1000",
    max_steps: 1,
  });
  check(r.hint === join(project, "payloads", "blob.prg"),
    "2d a hex_bytes entry is skipped and the first REAL path becomes the hint", String(r.hint));
}

// ------------------- 3. neither env nor cwd can stand in for a missing project
{
  const r = await callRun({
    loads: [{ raw_path: join(loose, "stray.bin"), address: "1000" }],
    initial_pc: "1000",
    max_steps: 1,
  });
  check(r.hint === join(loose, "stray.bin"), "3 a path outside any project is still passed as the hint");
  check(r.resolverFailed, "3b it FAILS rather than falling back to C64RE_PROJECT_DIR or the cwd",
    r.out.split("\n")[0] ?? "");
  check(!/c64re-833-cwd-/.test(r.out) || /requires a valid project directory/.test(r.out),
    "3c the failure names the hint path, not a cwd that happened to be handy");
}

// ------------------------------- 4. a hex_bytes-only run needs no project at all
// Decision (recorded in sandbox.ts): a loads[] made only of hex_bytes carries no
// path, and such a run needs no project either — every byte is inline, and a
// project root is only ever used to resolve a RELATIVE path. So the root is
// resolved on FIRST USE rather than up front. The old eager call made a
// self-contained run fail outside a project for a filesystem it never touches;
// with no hint available it was also the one shape that could not be fixed by
// passing one. Not asking is the fix.
{
  const r = await callRun({
    loads: [{ hex_bytes: "EAEA00", address: "1000" }],
    initial_pc: "1000",
    max_steps: 1,
  });
  check(r.hint === undefined, "4 a hex_bytes-only run asks the resolver nothing at all",
    hints.length === 0 ? "resolver never called" : `called with ${String(r.hint)}`);
  check(hints.length === 0, "4b …so it cannot fail on a project it does not need");
  check(!r.resolverFailed, "4c and it does not report a project error", r.out.split("\n")[0] ?? "");
}

// -------------------------------- 5. the schema says so, in the usual wording
{
  const schema = schemas.get("sandbox_6502_run");
  check(!!schema?.project_dir, "5 the tool declares an optional project_dir like every other path-taking tool");
  const described = schema?.project_dir?.description ?? "";
  check(/walking up/.test(described) && /loads\[\]/.test(described),
    "5b …and its description says where the hint comes from when it is omitted", described);
  check(DEFAULT_TOOLS.has?.("sandbox_6502_run") ?? [...DEFAULT_TOOLS].includes("sandbox_6502_run"),
    "5c sandbox_6502_run is still in DEFAULT_TOOLS (unchanged by this spec — §8)");
}

// ------------------ 6. the portability gate's own walk sees the nested params
// Asserted against the walk itself, not by side effect: the gate could go green
// for a dozen reasons that have nothing to do with it looking inside `loads[]`.
{
  const inv = collectToolInventory();
  const row = inv.find((t) => t.name === "sandbox_6502_run");
  check(!!row?.schema, "6 the live inventory carries each tool's input schema");
  const found = pathParamsOf(row?.schema ?? {});
  const paths = found.map((p) => p.path);
  check(paths.includes("loads[].prg_path"), "6b the walk finds loads[].prg_path", paths.join(","));
  check(paths.includes("loads[].raw_path"), "6c the walk finds loads[].raw_path");
  check(found.filter((p) => p.path.startsWith("loads[]")).every((p) => p.nested),
    "6d …and marks them NESTED, which is why a top-level-only rule never saw them");
  check(paths.includes("project_dir"), "6e the walk still sees the top-level project_dir");

  // The hole, stated as the walk's own before/after: a top-level-only view of
  // this schema finds no load path whatsoever.
  const topLevelOnly = found.filter((p) => !p.nested).map((p) => p.path);
  check(!topLevelOnly.some((p) => /prg_path|raw_path/.test(p)),
    "6f a top-level-only view of the same schema finds no load path at all", topLevelOnly.join(","));
}

// ---------------------------------------------------------------------- tidy up
for (const d of [project, loose]) rmSync(d, { recursive: true, force: true });
process.chdir(dirname(ROOT));
rmSync(neutralCwd, { recursive: true, force: true });

console.log(`\n${failCount === 0 ? "GREEN" : "RED"} e2e:833-sandbox: ${pass} pass, ${failCount} fail.`);
process.exit(failCount === 0 ? 0 : 1);
