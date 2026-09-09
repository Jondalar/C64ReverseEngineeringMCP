#!/usr/bin/env node
// Spec 834 §4 / D1 — `runtime_scene_reel` finds its project, and the gate that sees it.
//
// The defect: `context.projectDir()` — no hint, and not in a try/catch — while
// `feature_path`, `out_path` and `media_path` sat right there in the arguments.
// The resolver then has nothing to walk up from and falls back to
// C64RE_PROJECT_DIR or to the process cwd happening to sit inside a project: the
// cwd coupling no DEFAULT tool may have. It is the closest twin to the
// `sandbox_6502_run` defect Spec 833 D5 fixed, and it fails LOUDLY rather than
// quietly against the wrong project — which makes it the least bad of the three
// shapes, not a smaller job. A tool that cannot start outside a project when the
// caller handed it three usable paths is broken.
//
// The precedence under test, and why it is this one (stated in scene-reel.ts):
//   feature_path → media_path → out_path.
// The first two are INPUTS that already exist; `out_path` is an OUTPUT that need
// not exist yet, whose directory need not exist either, and whose own contract is
// "absolute, or relative to the project dir" — deriving that same project dir
// from it is circular. It is last, and present only because it is the one
// argument that is required, so the hint is never `undefined`.
//
// Hermetic on purpose, exactly as e2e-833-sandbox.mjs:
//   * C64RE_PROJECT_DIR is DELETED from this process before anything imports,
//     so the environment fallback cannot rescue a missing hint;
//   * the cwd is moved to a neutral temp directory inside no project, so the cwd
//     fallback cannot either;
//   * the project is a temp directory with a knowledge/phase-plan.json marker;
//   * no daemon, no trx64cli, no ROMs. Every scenario here is deliberately
//     step-less, so the handler stops at "the scenario does not parse" — AFTER
//     the project is resolved and BEFORE a private machine is ever spawned. The
//     assertion is on the RESOLUTION, never on a successful reel.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:834-scene-reel

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

// Before anything else: the two fallbacks this tool used to lean on are removed.
delete process.env.C64RE_PROJECT_DIR;
const neutralCwd = mkdtempSync(join(tmpdir(), "c64re-834-cwd-"));
process.chdir(neutralCwd);

let pass = 0;
let failCount = 0;
const ok = (m, d = "") => { pass += 1; console.log(`  PASS  ${m}${d ? `  (${d})` : ""}`); };
const fail = (m, d = "") => { failCount += 1; console.log(`  FAIL  ${m}${d ? `  (${d})` : ""}`); };
const check = (c, m, d = "") => (c ? ok(m, d) : fail(m, d));

console.log("Spec 834 §4 — runtime_scene_reel finds its project\n");

const { resolveProjectDir } = await import(pathToFileURL(join(ROOT, "dist/project-root.js")).href);
const { registerSceneReelTool } = await import(pathToFileURL(join(ROOT, "dist/server-tools/scene-reel.js")).href);
const { DEFAULT_TOOLS } = await import(pathToFileURL(join(ROOT, "dist/server-tools/tier-tools.js")).href);
const { collectToolInventory } = await import(pathToFileURL(join(ROOT, "dist/server.js")).href);
const { pathParamsOf } = await import(pathToFileURL(join(ROOT, "scripts/lib/schema-path-walk.mjs")).href);

// ------------------------------------------------------------ the temp project
// A scenario with no When drives no machine: it parses far enough to be read and
// then stops. That is deliberate — this gate decides project resolution, which
// happens strictly before the runtime is asked for anything at all.
const STEPLESS = ["Scenario: paperwork only", "  Given a bare machine", "  Then the reel has at least 5 screens", ""].join("\n");

const project = mkdtempSync(join(tmpdir(), "c64re-834-proj-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
writeFileSync(join(project, "knowledge", "phase-plan.json"), JSON.stringify({ phases: [] }));
mkdirSync(join(project, "scenarios"), { recursive: true });
mkdirSync(join(project, "media"), { recursive: true });
writeFileSync(join(project, "scenarios", "reel.feature"), STEPLESS, "utf8");
// The medium only has to EXIST at a path; nothing here mounts it.
writeFileSync(join(project, "media", "side1.g64"), Buffer.from([0x47, 0x43, 0x52]));
const inProjectFeature = join(project, "scenarios", "reel.feature");
const inProjectMedia = join(project, "media", "side1.g64");

// A second, LOOSE directory inside no project at all — the negative control.
const loose = mkdtempSync(join(tmpdir(), "c64re-834-loose-"));
writeFileSync(join(loose, "stray.feature"), STEPLESS, "utf8");
writeFileSync(join(loose, "stray.g64"), Buffer.from([0x47, 0x43, 0x52]));
const looseFeature = join(loose, "stray.feature");
const looseMedia = join(loose, "stray.g64");

// Output paths that DO NOT EXIST, and whose directories do not exist either —
// which is the normal state of an output before the tool writes it.
const outInProject = join(project, "reels", "never-written", "reel.gif");
const outInLoose = join(loose, "reels", "never-written", "reel.gif");
check(!existsSync(outInProject) && !existsSync(dirname(outInProject)), "an out_path is a file that does not exist yet, in a directory that does not either");

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
registerSceneReelTool(server, context);

const reel = handlers.get("runtime_scene_reel");
check(typeof reel === "function", "runtime_scene_reel is registered");

const textOf = (res) => (res?.content ?? []).map((c) => c.text ?? "").join("\n");
// The resolver's own failure message. Its ABSENCE is what proves the project was
// found. What would happen after — a private machine, a daemon that may not be
// running here — is not this gate's business and is never asserted on.
const RESOLVER_FAILED = /requires a valid project directory/;
// Where every call in this gate stops: past resolution, short of the runtime.
const STOPPED_BEFORE_THE_MACHINE = /does not parse/;

async function callReel(args) {
  hints.length = 0;
  const out = textOf(await reel(args));
  return { out, hint: hints[0], calls: hints.length, resolverFailed: RESOLVER_FAILED.test(out) };
}

// --------------------------------------------- 1. explicit project_dir is used
{
  const r = await callReel({ project_dir: project, feature_path: inProjectFeature, out_path: outInProject });
  check(r.hint === project, "1 an explicit project_dir is the hint the resolver gets", String(r.hint));
  check(!r.resolverFailed, "1b the project resolves with no C64RE_PROJECT_DIR and a cwd outside it",
    r.resolverFailed ? r.out.split("\n")[0] : "resolved");
  check(STOPPED_BEFORE_THE_MACHINE.test(r.out), "1c …and the call stopped past resolution, before any machine was asked for");
  check(!/c64re-834-cwd-/.test(r.out), "1d nothing was resolved against the process cwd");
}

// ----------------------- 2. no project_dir: the tool's own feature_path is used
{
  const r = await callReel({ feature_path: inProjectFeature, out_path: outInProject });
  check(r.hint === inProjectFeature, "2 without project_dir the feature_path is the hint", String(r.hint));
  check(r.hint !== undefined, "2b the hint is never `undefined` — the defect's own signature");
  check(!r.resolverFailed, "2c the project is found by walking up from the feature file",
    r.resolverFailed ? r.out.split("\n")[0] : "resolved");
}

// ------------- 3. an inline feature has no feature_path: media_path stands in
{
  const r = await callReel({ feature: STEPLESS, media_path: inProjectMedia, out_path: outInProject });
  check(r.hint === inProjectMedia, "3 with the scenario inline, media_path is the hint", String(r.hint));
  check(!r.resolverFailed, "3b the project is found by walking up from the medium",
    r.resolverFailed ? r.out.split("\n")[0] : "resolved");
}

// ------------------------- 4. inline feature, no medium: out_path, last resort
{
  const r = await callReel({ feature: STEPLESS, out_path: outInProject });
  check(r.hint === outInProject, "4 with neither, the required out_path is the hint — never `undefined`", String(r.hint));
  check(!r.resolverFailed, "4b …and it still resolves, by walking up through directories nobody has created yet",
    r.resolverFailed ? r.out.split("\n")[0] : "resolved");
}

// ------------------------------------------------- 5. the precedence, asserted
// feature_path beats both of the others: the two losers point OUT of the project,
// so if either won, the resolution would fail and say so.
{
  const r = await callReel({ feature_path: inProjectFeature, media_path: looseMedia, out_path: outInLoose });
  check(r.hint === inProjectFeature, "5 feature_path outranks media_path and out_path", String(r.hint));
  check(!r.resolverFailed, "5b …proven by the run resolving while both losers point outside any project");
}
// media_path beats out_path.
{
  const r = await callReel({ feature: STEPLESS, media_path: inProjectMedia, out_path: outInLoose });
  check(r.hint === inProjectMedia, "5c media_path outranks out_path", String(r.hint));
  check(!r.resolverFailed, "5d …proven the same way");
}

// -------------- 6. an OUTPUT that does not exist yet is not walked up from
// The mirror of case 5: the two existing inputs are outside any project and the
// out_path points deep inside one. If out_path were the hint — or a fallback
// after a hint that failed — this would resolve. It must not: the tool would
// then be deriving the project from a file it has not written, in a directory
// that does not exist, whose own contract is "relative to the project dir".
{
  const r = await callReel({ feature_path: looseFeature, media_path: looseMedia, out_path: outInProject });
  check(r.hint === looseFeature, "6 the hint is still the input path, not the output", String(r.hint));
  check(r.resolverFailed, "6b an out_path inside a project does NOT rescue an input outside one",
    r.out.split("\n").find((l) => /Resolved projectDir/.test(l)) ?? r.out.split("\n")[0]);
  check(/c64re-834-loose-/.test(r.out) && !/c64re-834-proj-/.test(r.out),
    "6c the failure names the input path it was given, not the project the output happened to sit in");
  check(r.calls === 1, "6d and it asked the resolver exactly once — no second, hintless try", `calls=${r.calls}`);
}

// ------------------- 7. neither env nor cwd can stand in for a missing project
{
  const r = await callReel({ feature: STEPLESS, out_path: join(loose, "reel.gif") });
  check(r.hint === join(loose, "reel.gif"), "7 a path outside any project is still passed as the hint");
  check(r.resolverFailed, "7b it FAILS rather than falling back to C64RE_PROJECT_DIR or the cwd",
    r.out.split("\n").find((l) => /Resolved projectDir/.test(l)) ?? r.out.split("\n")[0]);
  check(!/c64re-834-cwd-/.test(r.out), "7c the failure names the hint path, not a cwd that happened to be handy");
  check(/hint path/.test(r.out), "7d …and it says the hint is where it looked");
}

// ------------------------------- 8. the schema says so, in the usual wording
{
  const schema = schemas.get("runtime_scene_reel");
  check(!!schema?.project_dir, "8 the tool declares an optional project_dir like every other path-taking tool");
  check(schema?.project_dir?.safeParse(undefined).success === true, "8b …and it is optional");
  const described = schema?.project_dir?.description ?? "";
  check(/walking up/.test(described) && /knowledge\/phase-plan\.json/.test(described),
    "8c …with the same description wording as disk-g64.ts and the sandbox fix", described);
  check(/feature_path/.test(described) && /media_path/.test(described) && /out_path/.test(described),
    "8d …and it names the precedence a caller gets when they omit it", described);
  check(schema?.out_path?.safeParse(undefined).success === false,
    "8e out_path is REQUIRED — which is what makes a hint always available");
  check(DEFAULT_TOOLS.has?.("runtime_scene_reel") ?? [...DEFAULT_TOOLS].includes("runtime_scene_reel"),
    "8f runtime_scene_reel is still in DEFAULT_TOOLS (unchanged by this spec)");
}

// --------------------- 9. the portability gate's own walk sees what it must
{
  const inv = collectToolInventory();
  const row = inv.find((t) => t.name === "runtime_scene_reel");
  check(!!row?.schema, "9 the live inventory carries the tool's input schema");
  const paths = pathParamsOf(row?.schema ?? {}).map((p) => p.path);
  check(paths.includes("project_dir"), "9b the walk sees the new top-level project_dir", paths.join(","));
  for (const p of ["feature_path", "media_path", "out_path"]) {
    check(paths.includes(p), `9c the walk still sees ${p} — the paths that now supply the hint`);
  }
}

// ------------------------------- 10. the source, in the shape Spec 834 D1 names
{
  const src = readFileSync(join(ROOT, "src/server-tools/scene-reel.ts"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l));
  // The portability gate's own rule, applied here so a regression is caught by
  // the spec's gate and not only by the file-granular sweep.
  check(!code.some((l) => /\.projectDir\(\s*(\)|undefined)/.test(l)),
    "10 scene-reel.ts contains no hintless projectDir call at all — the gate is file-granular");
  check(/projectDir\(project_dir \?\? feature_path \?\? media_path \?\? out_path\)/.test(src),
    "10b it resolves `project_dir ?? feature_path ?? media_path ?? out_path`, the D1 shape");
  check(/OUTPUT/.test(src) && /circular/.test(src),
    "10c and a comment says why the output path is last");
}

// ---------------------------------------------------------------------- tidy up
for (const d of [project, loose]) rmSync(d, { recursive: true, force: true });
process.chdir(dirname(ROOT));
rmSync(neutralCwd, { recursive: true, force: true });

console.log(`\n${failCount === 0 ? "GREEN" : "RED"} e2e:834-scene-reel: ${pass} pass, ${failCount} fail.`);
process.exit(failCount === 0 ? 0 : 1);
