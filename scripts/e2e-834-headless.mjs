#!/usr/bin/env node
// Spec 834 §2 (D1 + D3) — the six headless runtime tools find their project.
//
// `runtime_session_start`, `runtime_loader_lens`, `runtime_load_prg`,
// `runtime_run_prg`, `runtime_render_screen` and `runtime_recorder_dump` all
// resolved their project with NO hint — and each resolution sat in a try/catch,
// so a wrong or missing root did not fail: the tool quietly worked against the
// wrong project, or against none. `prg_path`, `media_path`, `capture_path` and
// the output path sat in the same argument object, unused for this.
//
// D1: the hint is `project_dir ?? <the call's own path>`, the shape disk-g64.ts
//     has always had and Spec 833 gave the two sandbox tools.
// D3: the catch around "which project am I in" is gone. It is not the
//     daemon-is-absent failure DOCTRINE rule 1 asks a tool to survive and
//     report — those are different failures, and only one of them is normal.
//
// Hermetic on purpose, the same way e2e-833-sandbox is:
//   * C64RE_PROJECT_DIR is DELETED from this process before anything imports,
//     so the environment fallback cannot rescue a missing hint;
//   * the cwd is moved to a neutral temp directory inside no project, so the
//     cwd fallback cannot either;
//   * the project is a temp directory with a knowledge/phase-plan.json marker;
//   * the runtime daemon MAY NOT BE RUNNING here and that must not change what
//     this gate can decide, so `runtimeDaemon.call` is stubbed: nothing connects,
//     nothing is spawned, and every assertion is about the RESOLUTION and the
//     already-absolute path handed over the bridge — never about a successful run.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:834-headless

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

// Before anything else: the two fallbacks these tools leaned on are removed.
delete process.env.C64RE_PROJECT_DIR;
const neutralCwd = mkdtempSync(join(tmpdir(), "c64re-834-cwd-"));
process.chdir(neutralCwd);

let pass = 0;
let failCount = 0;
const ok = (m, d = "") => { pass += 1; console.log(`  PASS  ${m}${d ? `  (${d})` : ""}`); };
const fail = (m, d = "") => { failCount += 1; console.log(`  FAIL  ${m}${d ? `  (${d})` : ""}`); };
const check = (c, m, d = "") => (c ? ok(m, d) : fail(m, d));

console.log("Spec 834 §2 — the six headless runtime tools find their project\n");

const { resolveProjectDir } = await import(pathToFileURL(join(ROOT, "dist/project-root.js")).href);
const { registerHeadlessTools } = await import(pathToFileURL(join(ROOT, "dist/server-tools/headless.js")).href);
const { runtimeDaemon } = await import(pathToFileURL(join(ROOT, "dist/runtime/daemon-client.js")).href);
const { DEFAULT_TOOLS } = await import(pathToFileURL(join(ROOT, "dist/server-tools/tier-tools.js")).href);

// ------------------------------------------------------------ the temp project
const project = mkdtempSync(join(tmpdir(), "c64re-834-proj-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
writeFileSync(join(project, "knowledge", "phase-plan.json"), JSON.stringify({ phases: [] }));
mkdirSync(join(project, "media"), { recursive: true });
mkdirSync(join(project, "payloads"), { recursive: true });
mkdirSync(join(project, "captures"), { recursive: true });
mkdirSync(join(project, "shots"), { recursive: true });
// Files only have to EXIST at a path: nothing here is played, loaded or folded.
// A wrong project root shows up as a path that is not this one.
writeFileSync(join(project, "media", "game.d64"), Buffer.alloc(16));
writeFileSync(join(project, "payloads", "x.prg"), Buffer.from([0x01, 0x08, 0x00]));
writeFileSync(join(project, "captures", "run.c64retrace"), Buffer.alloc(16));

// A second, LOOSE directory inside no project at all — the negative control.
const loose = mkdtempSync(join(tmpdir(), "c64re-834-loose-"));
writeFileSync(join(loose, "stray.d64"), Buffer.alloc(16));
writeFileSync(join(loose, "stray.prg"), Buffer.from([0x01, 0x08, 0x00]));
writeFileSync(join(loose, "stray.c64retrace"), Buffer.alloc(16));

check(!existsSync(join(neutralCwd, "knowledge")), "the cwd is inside no project", neutralCwd);
check(process.env.C64RE_PROJECT_DIR === undefined, "C64RE_PROJECT_DIR is not set");

// --------------------------------------------------- the tools, really wired up
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

// The daemon side of the bridge, stubbed at the ONE method every typed wrapper
// funnels through. The runtime may legitimately be absent on this machine; that
// must not decide what this gate can check, so nothing connects and nothing is
// spawned. What the stub records is the thing that matters: the ABSOLUTE path
// the MCP resolved before handing it over (the daemon is project-agnostic and
// may serve several projects at once — it resolves nothing for us).
const daemonCalls = [];
runtimeDaemon.call = async (method, params = {}) => {
  daemonCalls.push({ method, params });
  switch (method) {
    case "session/create":
      return { sessionId: "sess-834", mode: "daemon", diskPath: params.disk_path ?? "", c64Cycles: 0, pc: 0x0801, trace: null, attached: false };
    case "media/open":
      return { message: `Opened: ${params.path}` };
    case "session/load_prg":
      return { loadAddress: 0x0801, endAddress: 0x08ff, bytesLoaded: 254 };
    case "runtime/run_prg":
      return { loadAddress: 0x0801, action: "typed RUN" };
    case "session/screenshot":
      // A 1x1 PNG is enough: this gate checks WHERE it is written, not what it shows.
      return { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", width: 320, height: 200 };
    case "recorder/dump":
      return { path: params.path, bytes: 4096 };
    default:
      return {};
  }
};
const seededProjects = [];
const realSetProjectDir = runtimeDaemon.setProjectDir.bind(runtimeDaemon);
runtimeDaemon.setProjectDir = (dir) => { seededProjects.push(dir); realSetProjectDir(dir); };

const handlers = new Map();
const schemas = new Map();
const server = { tool: (name, _desc, schema, handler) => { schemas.set(name, schema); handlers.set(name, handler); } };
registerHeadlessTools(server, context);

const SIX = [
  "runtime_session_start", "runtime_loader_lens", "runtime_load_prg",
  "runtime_run_prg", "runtime_render_screen", "runtime_recorder_dump",
];
for (const name of SIX) check(typeof handlers.get(name) === "function", `${name} is registered`);

const textOf = (res) => (res?.content ?? []).map((c) => c.text ?? "").join("\n");
// The resolver's own failure message. Its ABSENCE is what proves the project was
// found; what happens after — a daemon call, a substrate refusal — is not this
// gate's business and is never asserted on as a successful run.
const RESOLVER_FAILED = /requires a valid project directory/;

async function call(name, args) {
  hints.length = 0;
  daemonCalls.length = 0;
  seededProjects.length = 0;
  const out = textOf(await handlers.get(name)(args));
  return {
    out,
    hint: hints[0],
    hintCount: hints.length,
    calls: [...daemonCalls],
    seeded: [...seededProjects],
    resolverFailed: RESOLVER_FAILED.test(out),
    leakedCwd: out.includes(neutralCwd),
  };
}

// A read-derived hypothesis, so the discipline gate lets loader_lens through to
// the resolution this gate is actually about.
const HYPOTHESIS = "$C000 holds the depacked payload; the drivecode I read at $0300 stores it there";

// Each of the six, as: the tool, the argument that carries its path, a RELATIVE
// path under the project (so the resolved root is visible in what comes out the
// far side), an ABSOLUTE one inside the project, and one in the loose directory.
const CASES = [
  {
    tool: "runtime_session_start",
    param: "media_path",
    rel: join("media", "game.d64"),
    abs: join(project, "media", "game.d64"),
    stray: join(loose, "stray.d64"),
    base: {},
    // The medium the MCP resolved and handed to the daemon.
    handed: (r) => r.calls.find((c) => c.method === "media/open")?.params?.path,
  },
  {
    tool: "runtime_loader_lens",
    param: "capture_path",
    rel: join("captures", "run.c64retrace"),
    abs: join(project, "captures", "run.c64retrace"),
    stray: join(loose, "stray.c64retrace"),
    base: { hypothesis: HYPOTHESIS },
    handed: () => undefined, // no daemon leg: it reads a capture file directly
  },
  {
    tool: "runtime_load_prg",
    param: "prg_path",
    rel: join("payloads", "x.prg"),
    abs: join(project, "payloads", "x.prg"),
    stray: join(loose, "stray.prg"),
    base: { session_id: "sess-834" },
    handed: (r) => r.calls.find((c) => c.method === "session/load_prg")?.params?.prg_path,
  },
  {
    tool: "runtime_run_prg",
    param: "prg_path",
    rel: join("payloads", "x.prg"),
    abs: join(project, "payloads", "x.prg"),
    stray: join(loose, "stray.prg"),
    base: { session_id: "sess-834" },
    handed: (r) => r.calls.find((c) => c.method === "runtime/run_prg")?.params?.prg_path,
  },
  {
    tool: "runtime_render_screen",
    param: "path",
    rel: join("shots", "frame.png"),
    abs: join(project, "shots", "frame-abs.png"),
    stray: join(loose, "stray.png"),
    base: { session_id: "sess-834" },
    // The PNG is written by the MCP process itself — the output line names where.
    handed: (r) => (r.out.match(/^Output: (.+)$/m) ?? [])[1],
  },
  {
    tool: "runtime_recorder_dump",
    param: "path",
    rel: join("runtime", "dumps", "d.c64re"),
    abs: join(project, "runtime", "dumps", "d-abs.c64re"),
    stray: join(loose, "stray.c64re"),
    base: { session_id: "sess-834", seq: 1 },
    handed: (r) => r.calls.find((c) => c.method === "recorder/dump")?.params?.path,
  },
];

for (const c of CASES) {
  console.log(`\n--- ${c.tool} (${c.param}) ---`);

  // 1. an explicit project_dir is the hint, and the root it resolves to is the
  //    one the call's own relative path is resolved against.
  {
    const r = await call(c.tool, { ...c.base, project_dir: project, [c.param]: c.rel });
    check(r.hint === project, "1 an explicit project_dir is the hint the resolver gets", String(r.hint));
    check(!r.resolverFailed, "1b it resolves with no C64RE_PROJECT_DIR and a cwd outside the project",
      r.resolverFailed ? r.out.split("\n")[0] : "resolved");
    const handed = c.handed(r);
    if (handed !== undefined) {
      check(handed === join(project, c.rel), "1c the relative path was resolved against THAT project", handed);
      check(!handed.startsWith(neutralCwd), "1d …and not against the process cwd");
    }
    check(!r.leakedCwd, "1e nothing in the answer was resolved against the cwd");
  }

  // 2. no project_dir: the tool's OWN path is the hint — the parameter that sat
  //    unused in the same argument object all along.
  {
    const r = await call(c.tool, { ...c.base, [c.param]: c.abs });
    check(r.hint === c.abs, `2 without project_dir the ${c.param} is the hint`, String(r.hint));
    check(r.hint !== undefined, "2b the hint is never `undefined` — the defect's own signature");
    check(!r.resolverFailed, "2c the project is found by walking up from that path",
      r.resolverFailed ? r.out.split("\n")[0] : "resolved");
  }

  // 3 + 4. a path inside no project: neither the environment nor the cwd stands
  //    in for the missing root, and the failure is VISIBLE rather than swallowed
  //    — the call stops there instead of carrying on against a root it does not
  //    have. That last part is D3 stated as behaviour.
  {
    const r = await call(c.tool, { ...c.base, [c.param]: c.stray });
    check(r.hint === c.stray, "3 a path outside any project is still passed as the hint", String(r.hint));
    check(r.resolverFailed, "3b it FAILS rather than falling back to C64RE_PROJECT_DIR or the cwd",
      r.out.split("\n")[0] ?? "");
    check(r.out.includes(c.stray), "3c the failure names the hint it was given", "");
    check(!r.leakedCwd, "3d …and never the cwd it happened to be standing in");
    check(r.calls.length === 0, "4 the failure is not swallowed: nothing was handed onward without a root",
      r.calls.map((x) => x.method).join(",") || "no daemon call");
  }

  // 5. the schema says so, in the wording every other path-taking tool uses.
  {
    const described = schemas.get(c.tool)?.project_dir?.description ?? "";
    check(!!schemas.get(c.tool)?.project_dir, "5 the tool declares an optional project_dir");
    check(/^Project root directory\. When omitted, resolved by walking up from .+ to knowledge\/phase-plan\.json\.$/.test(described),
      "5b …with the standard wording, naming the path it walks up from", described);
    check(described.includes(c.param), `5c …and that path is its own ${c.param}`, described);
  }
}

// ------------------------- runtime_session_start: the call that carries no path
// A bare attach names no medium and no trace: nothing is resolved against a root,
// so the resolver is not asked at all. Same decision Spec 833 recorded for a
// hex_bytes-only sandbox run — asking hintlessly IS the defect, so where the
// answer is not needed the question is not put.
console.log("\n--- runtime_session_start: a bare attach ---");
{
  const r = await call("runtime_session_start", {});
  check(r.hintCount === 0, "6 a bare attach asks the resolver nothing at all",
    r.hintCount === 0 ? "resolver never called" : `called with ${String(r.hint)}`);
  check(!r.resolverFailed, "6b …so it cannot fail on a project it does not need");
  check(r.calls.some((x) => x.method === "session/create"), "6c and it still starts/attaches the session");
  check(!r.calls.some((x) => x.method === "media/open"), "6d with no medium to open");
}
// And when it DOES carry a medium, the resolved root is what seeds the daemon's
// auto-spawn base — the root is used, not merely computed.
{
  const r = await call("runtime_session_start", { media_path: join(project, "media", "game.d64") });
  check(r.seeded[0] === project, "7 the resolved project seeds the daemon spawn base", String(r.seeded[0]));
}
// trace_out is a path this call carries too — it is the hint when no medium is named.
{
  const r = await call("runtime_session_start", { trace_out: join(project, "captures", "t.duckdb") });
  check(r.hint === join(project, "captures", "t.duckdb"),
    "7b with no medium, the trace it is about to write is the hint", String(r.hint));
}

// ------------------------------------------------- the source, stated as a rule
console.log("\n--- the file, as the portability gate reads it ---");
{
  const src = readFileSync(join(ROOT, "src/server-tools/headless.ts"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l));
  // The portability gate's own rule (scripts/lib + e2e-mcp-path-portability):
  // a hintless `.projectDir()` / `.projectDir(undefined` anywhere in the file
  // makes every path-taking tool in it hintless.
  check(!code.some((l) => /\.projectDir\(\s*(\)|undefined)/.test(l)),
    "8 headless.ts has no hintless projectDir call left — the whole file, not just the six");
  // D3: the six do not wrap their resolution in a catch. The two that remain are
  // runtime_trace_start's, which is not one of the six and whose own path
  // parameter (`output`) the portability walk does not read as a path.
  const caught = code.filter((l) => /resolveHeadlessProjectDir\(context/.test(l) && /catch/.test(l));
  check(caught.every((l) => /context, output/.test(l)),
    "9 no resolution among the six is swallowed by a catch any more",
    caught.map((l) => l.trim().slice(0, 60)).join(" | ") || "none caught");
  check(caught.length === 2, "9b the only caught resolutions left are runtime_trace_start's two", String(caught.length));
  // The helper cannot be called hintlessly by accident: the hint is a parameter
  // every call site has to state.
  check(/function resolveHeadlessProjectDir\(context: ServerToolContext, hintPath: string \| undefined\)/.test(src),
    "10 the helper's hint is a required parameter, not an omittable one");
}

// The six are default tools — which is why the path-portability rule applies to
// them at all. (Tiering itself is not this spec's business; Spec 834 §7.)
for (const name of SIX) {
  check(DEFAULT_TOOLS.has?.(name) ?? [...DEFAULT_TOOLS].includes(name), `11 ${name} is in DEFAULT_TOOLS`);
}

// ---------------------------------------------------------------------- tidy up
for (const d of [project, loose]) rmSync(d, { recursive: true, force: true });
process.chdir(dirname(ROOT));
rmSync(neutralCwd, { recursive: true, force: true });

console.log(`\n${failCount === 0 ? "GREEN" : "RED"} e2e:834-headless: ${pass} pass, ${failCount} fail.`);
process.exit(failCount === 0 ? 0 : 1);
