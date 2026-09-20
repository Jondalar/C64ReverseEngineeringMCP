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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const descriptions = new Map();
const server = { tool: (name, desc, schema, handler) => { descriptions.set(name, desc); schemas.set(name, schema); handlers.set(name, handler); } };
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

// ------------- 7. zero page and the stack are output, and are reported as such
//
// The core's write-map starts at $0200 — right for a depack harvest, wrong for
// everything else. A run that demonstrably executed `INC $011C` and `STY $2D` was
// answered with "Written runs: 0 — this run stored nothing above $01FF" and a
// window over $011B-$0122 printed as eight holes; the byte the caller needed was
// reachable only through `include_observed`, which called it "residue / loaded
// input, NOT this run's output". 6502 code keeps its state in zero page.
{
  const runnerSrc = readFileSync(join(ROOT, "src/sandbox/sandbox-runner-realcore.ts"), "utf8");
  check(/"--instr-cap", "0"/.test(runnerSrc),
    "7 the engine takes a pre-run image of the low pages — the same set-up, zero instructions");
  check(/lowRuns\.filter\(\(r\) => r\.hi < LOW_END\)/.test(runnerSrc),
    "7b …and merges those runs into the one write-map the caller reads");

  const toolSrc = readFileSync(join(ROOT, "src/server-tools/sandbox.ts"), "utf8");
  check(!/stored nothing above \$01FF/.test(toolSrc),
    "7c the empty answer no longer excuses itself with the $01FF floor");
  check(!/residue \/ loaded input, NOT this run's output/.test(toolSrc),
    "7d include_observed no longer calls this run's own stores residue");
  check(/AND this run's own stores/.test(toolSrc),
    "7e …it says what the raw window actually holds");

  const schema = schemas.get("sandbox_6502_run");
  check(/Zero page and the stack count as output/.test(descriptions.get("sandbox_6502_run") ?? ""),
    "7f the tool description says zero page counts as output, so a caller knows before running");
  check(!/never output of this run/.test(schema?.include_observed?.description ?? ""),
    "7g …and include_observed's own description drops the claim it could not keep",
    schema?.include_observed?.description?.slice(0, 80));
}

// 7h. …and the real core proves it, where the binary is present.
{
  const { resolveTrx64Cli } = await import(pathToFileURL(join(ROOT, "dist/sandbox/trx64cli.js")).href);
  if (!existsSync(resolveTrx64Cli())) {
    console.log(`  SKIP  7h the real core confirms it  (no trx64cli at ${resolveTrx64Cli()})`);
  } else {
    // LDA #$42 / STA $2D / INC $011C / RTS — one zero-page store, one stack-page store.
    const r = await callRun({
      project_dir: project,
      loads: [{ hex_bytes: "a942852dee1c0160", address: "0800" }],
      initial_pc: "0800",
      max_steps: 100,
      return_memory_ranges: [{ start: "011B", end: "0122" }],
    });
    check(/\$002D-\$002D \(1 byte\)/.test(r.out), "7h `STY $2D` is in the written runs", r.out.split("\n").find((l) => /Written runs/.test(l)));
    check(/\$011C-\$011C \(1 byte\)/.test(r.out), "7i `INC $011C` is too — the stack page is not machinery here");
    check(/Zero page \+ stack: 2 bytes changed/.test(r.out),
      "7j the answer names the low-memory total separately, with its method",
      r.out.split("\n").find((l) => /Zero page/.test(l)));
    check(/pre-run image/.test(r.out), "7k …and states the limit of that method rather than hiding it");
    check(/Memory \$011B-\$0122 \(8 bytes, 7 never written/.test(r.out),
      "7l a window over the stack page shows the changed byte and holes the other seven",
      r.out.split("\n").find((l) => /Memory \$011B/.test(l)));
    check(!/8 never written/.test(r.out), "7m …not all eight, which is what it used to say");
  }
}

// ------------------- 8. the depacker doors take a project_dir and mean it
//
// `suggest_depacker` had none, and passed `input_path` to the resolver come what
// may. A relative path the server's cwd knows nothing about is not a hint: the
// resolver joined it to the MCP repo, walked up, found the repo's own marker and
// refused with "Resolved to the MCP repo itself" — while the session had onboarded
// into the project holding that very file. Because a hint was always supplied, the
// sole-onboarded-project fallback never got asked.
{
  const { registerCompressionTools } = await import(pathToFileURL(join(ROOT, "dist/server-tools/compression.js")).href);
  const cSchemas = new Map();
  const cHandlers = new Map();
  registerCompressionTools({ tool: (name, _d, schema, handler) => { cSchemas.set(name, schema); cHandlers.set(name, handler); } }, context);

  for (const name of ["suggest_depacker", "try_depack"]) {
    check(!!cSchemas.get(name)?.project_dir, `8 ${name} declares an optional project_dir`);
  }

  const callTool = async (name, args) => { hints.length = 0; return { out: textOf(await cHandlers.get(name)(args)), hint: hints[0], calls: hints.length }; };

  const explicit = await callTool("suggest_depacker", { project_dir: project, input_path: "payloads/blob.bin" });
  check(explicit.hint === project, "8b an explicit project_dir is what the resolver gets", String(explicit.hint));
  check(!RESOLVER_FAILED.test(explicit.out), "8c …and the door resolves", explicit.out.split("\n")[0]);

  const abs = await callTool("suggest_depacker", { input_path: join(project, "payloads", "blob.bin") });
  check(abs.hint === join(project, "payloads", "blob.bin"), "8d an absolute input path is still a usable hint", String(abs.hint));
  check(!RESOLVER_FAILED.test(abs.out), "8e …and still resolves");

  const rel = await callTool("suggest_depacker", { input_path: "analysis/disk/CRAZY3/02_p1.prg" });
  check(rel.hint === undefined,
    "8f a relative path the cwd knows nothing about is NOT handed to the resolver as a hint", String(rel.hint));
  check(/Pass project_dir=/.test(rel.out), "8g …and the refusal names the parameter that settles it", rel.out.split("\n")[0]);
  check(/was not used as a hint/.test(rel.out) && /02_p1\.prg/.test(rel.out),
    "8h …and says which path it declined to guess from");
  check(!/Resolved to the MCP repo itself/.test(rel.out),
    "8i it no longer resolves to the MCP repo and blames the caller for it");

  const tryRel = await callTool("try_depack", { input_path: "analysis/disk/CRAZY3/02_p1.prg", format: "rle" });
  check(tryRel.hint === undefined && /Pass project_dir=/.test(tryRel.out),
    "8j try_depack, which had the same line, behaves the same way", tryRel.out.split("\n")[0]);
}

// ---------------------------------------------------------------------- tidy up
for (const d of [project, loose]) rmSync(d, { recursive: true, force: true });
process.chdir(dirname(ROOT));
rmSync(neutralCwd, { recursive: true, force: true });

// ---------------------------------------------------------------- Spec 834
// sandbox_depack DECLARED `project_dir` and resolved with no hint, so the
// parameter a caller passed was read by nobody. Same tool family, same gate.
const depackSrc = readFileSync(join(ROOT, "src/server-tools/sandbox-depack.ts"), "utf8");
check(/ctx\.projectDir\(args\.project_dir \?\? args\.input_path/.test(depackSrc),
  "834 sandbox_depack resolves `project_dir ?? input_path` — the parameter it declares is finally read");
check(!/ctx\.projectDir\(\s*undefined/.test(depackSrc),
  "834 sandbox_depack no longer resolves hintless");
const portSrc = readFileSync(join(ROOT, "scripts/e2e-mcp-path-portability.mjs"), "utf8");
check(!/"sandbox_depack"/.test(portSrc),
  "834 it left the KNOWN_HINTLESS allowlist — the list shrank, the only direction it may move");

console.log(`\n${failCount === 0 ? "GREEN" : "RED"} e2e:833-sandbox: ${pass} pass, ${failCount} fail.`);
process.exit(failCount === 0 ? 0 : 1);
