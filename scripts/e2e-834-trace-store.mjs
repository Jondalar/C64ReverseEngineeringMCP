#!/usr/bin/env node
// Spec 834 §3 (D1 + D2) — the seven trace-store readers find their project, and
// no longer answer from the process cwd.
//
// `resolveStorePath` used to ask `context.projectDir(undefined, false)` — nothing
// to walk up from — and then resolve a relative store path against
// `proj ?? process.cwd()`. The cwd fallback was explicit and commented, which
// made it the honest one of the three shapes in the spec, but it predates the
// tool-matrix rule (no default tool may be `broken-cwd-coupled`) and Spec 827
// moved a capture OUT of the project into a per-user data root — so resolving a
// relative store path against the cwd answers a question nobody asks any more.
//
// What this gate pins:
//   D1  each of the seven declares `project_dir` and resolves `project_dir ?? path`
//       (the `disk-g64.ts` / Spec 833 shape).
//   D2  the cwd fallback is REMOVED, not re-pointed. A relative path is resolved
//       against the project the caller named, through the three places a store can
//       really be after 827 — `<project>/<input>`, `<trace dir>/<input>`, and the
//       `<project>/runtime/traces.json` pointer file — and each candidate is
//       PROBED, so what comes back is a store that exists, not a plausible path.
//       When nothing resolves, the failure names the pointer file and the trace dir.
//   plus the branches that must survive: an ABSOLUTE path (the only flow that runs
//       in practice — `defaultTraceOut` composes one and `headless.ts` hands it
//       back as `absOut`), the `.c64retrace` recovery branch, and the directory
//       branch.
//
// Hermetic on purpose:
//   * C64RE_PROJECT_DIR is DELETED before anything imports, so the environment
//     cannot rescue a missing hint;
//   * the cwd is moved to a temp directory inside no project, and a DECOY store
//     is planted there under the exact name the tests ask for — the old code
//     would have returned it;
//   * C64RE_TRACE_DIR points the 827 per-user root at a temp directory, so the
//     gate never writes into the real one;
//   * no daemon, no capture, no DuckDB: resolution happens entirely on this side
//     of the bridge, before any read, so it is decided here and checked here.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:834-trace-store

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// Before anything else: the two fallbacks this resolver used to lean on are gone.
delete process.env.C64RE_PROJECT_DIR;
const neutralCwd = mkdtempSync(join(tmpdir(), "c64re-834-cwd-"));
process.chdir(neutralCwd);
// The 827 per-user root, redirected into a temp dir for the duration.
process.env.C64RE_TRACE_DIR = mkdtempSync(join(tmpdir(), "c64re-834-traceroot-"));

let pass = 0;
let failCount = 0;
const ok = (m, d = "") => { pass += 1; console.log(`  PASS  ${m}${d ? `  (${d})` : ""}`); };
const fail = (m, d = "") => { failCount += 1; console.log(`  FAIL  ${m}${d ? `  (${d})` : ""}`); };
const check = (c, m, d = "") => (c ? ok(m, d) : fail(m, d));

console.log("Spec 834 §3 — the seven trace-store readers, and the cwd fallback that is gone\n");

// ------------------------------------------------------------------ the world

const { resolveProjectDir } = await import(join(ROOT, "dist/project-root.js"));
const { resolveStorePath, registerTraceStoreTools } = await import(join(ROOT, "dist/server-tools/trace-store.js"));
const { traceDirForProject, tracePointerPath, recordTracePointer } = await import(join(ROOT, "dist/trace/trace-location.js"));

const project = mkdtempSync(join(tmpdir(), "c64re-834-project-"));
mkdirSync(join(project, "knowledge"), { recursive: true });
writeFileSync(join(project, "knowledge", "phase-plan.json"), JSON.stringify({ phases: [] }));

// Where 827 puts this project's captures.
const traceDir = traceDirForProject(project);
mkdirSync(traceDir, { recursive: true });

// A FAKE store: nothing here is opened, it only has to exist at a path, so that a
// wrong root shows up as a path that is not this one.
const fakeStore = (path) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "not a real duckdb — Spec 834 gate"); return path; };

const inTraceDir = fakeStore(join(traceDir, "live_a.duckdb"));            // the normal 827 landing place
const inProject = fakeStore(join(project, "traces", "mine.duckdb"));      // deliberately kept inside the project
const dirStore = fakeStore(join(project, "traces", "trace.duckdb"));      // the directory branch
const orphan = join(traceDir, "orphan.duckdb");                          // missing index …
const orphanLog = fakeStore(join(traceDir, "orphan.c64retrace"));        // … beside its authority
const elsewhere = mkdtempSync(join(tmpdir(), "c64re-834-elsewhere-"));   // a C64RE_TRACE_DIR that is no longer set
const faraway = fakeStore(join(elsewhere, "faraway.duckdb"));

// THE DECOY: same file name, sitting in the cwd. The removed fallback resolved
// exactly to this.
const decoy = fakeStore(join(neutralCwd, "live_a.duckdb"));
fakeStore(join(neutralCwd, "faraway.duckdb"));

// The 827 pointer file: the only record of where the `elsewhere` capture went.
recordTracePointer(project, { runId: "run-elsewhere", duckdbPath: faraway, retracePath: faraway.replace(/\.duckdb$/, ".c64retrace"), startedAt: "2026-09-09T10:00:00.000Z" });
recordTracePointer(project, { runId: "run-42", duckdbPath: inTraceDir, startedAt: "2026-09-09T10:05:00.000Z" });

check(!existsSync(join(neutralCwd, "knowledge")), "the cwd is inside no project", neutralCwd);
check(process.env.C64RE_PROJECT_DIR === undefined, "C64RE_PROJECT_DIR is not set");
check(existsSync(decoy), "a decoy store with the SAME name sits in the cwd", decoy);
check(existsSync(tracePointerPath(project)), "the 827 pointer file exists", tracePointerPath(project));
check(!traceDir.startsWith(`${project}/`), "the 827 trace dir is OUTSIDE the project — the premise of D2", traceDir);

// The REAL resolver, recording every hint it is handed. A hint of `undefined` IS
// the defect this spec is about.
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

const threw = (fn) => { try { fn(); return undefined; } catch (e) { return e.message; } };

// --------------------------------------------------------- A. the absolute flow
// The only flow that runs in practice. It must not have changed at all, and it
// must not ask for a project — a capture under the per-user data root has no
// project marker above it to walk up to.
console.log("\n--- A. the absolute path (the flow that actually runs) ---");

let before = hints.length;
check(resolveStorePath(inTraceDir, context) === inTraceDir, "an absolute store path resolves unchanged", inTraceDir);
check(hints.length === before, "…and asks for no project at all while doing it", `${hints.length - before} projectDir call(s)`);

check(resolveStorePath(faraway, context) === faraway, "an absolute path OUTSIDE the project resolves — 827's whole point", faraway);
check(resolveStorePath(join(project, "traces", "mine.duckdb"), context) === inProject, "an absolute path INSIDE the project still resolves");

before = hints.length;
check(resolveStorePath(join(project, "traces"), context) === dirStore, "the DIRECTORY branch: <dir>/trace.duckdb", dirStore);
check(resolveStorePath(orphan, context) === orphan, "the .c64retrace RECOVERY branch: a missing .duckdb beside an existing log passes through", orphan);
check(hints.length === before, "neither branch asks for a project either");

check(/directory has no trace\.duckdb/.test(threw(() => resolveStorePath(traceDir, context)) ?? ""),
  "a directory without trace.duckdb still fails with its own message");
check(/trace store path not found/.test(threw(() => resolveStorePath(join(traceDir, "nope.duckdb"), context)) ?? ""),
  "a missing absolute path with no .c64retrace still fails with its own message");

// ------------------------------------------------- B. relative, against a project
console.log("\n--- B. a relative path resolves against the PROJECT, never the cwd ---");

before = hints.length;
const relTraceDir = resolveStorePath("live_a.duckdb", context, project);
check(relTraceDir === inTraceDir, "a relative name finds the capture in the 827 trace dir", relTraceDir);
check(relTraceDir !== decoy, "…and NOT the identically-named decoy in the cwd", `decoy=${decoy}`);
check(hints[hints.length - 1] === project, "the named project_dir is the hint the resolver got", String(hints[hints.length - 1]));
check(hints.length === before + 1, "one project resolution, not one per candidate");

check(resolveStorePath("traces/mine.duckdb", context, project) === inProject,
  "a store the caller deliberately kept INSIDE the project still resolves");
check(resolveStorePath("traces", context, project) === dirStore,
  "the directory branch works on a relative path too");
check(resolveStorePath("orphan.duckdb", context, project) === orphan,
  "the .c64retrace recovery branch works on a relative path too");

// The pointer file is the only thing that knows about `elsewhere`: not under the
// project, not under the current trace dir. A resolver that composed a plausible
// path instead of probing a real one cannot answer this.
const viaPointer = resolveStorePath("faraway.duckdb", context, project);
check(viaPointer === faraway, "the 827 pointer file is consulted — a capture outside BOTH the project and the current trace dir is found", viaPointer);
check(viaPointer !== join(neutralCwd, "faraway.duckdb"), "…and not the same-named decoy in the cwd");
check(!existsSync(join(traceDir, "faraway.duckdb")) && !existsSync(join(project, "faraway.duckdb")),
  "…which is the only way it could have been found: nothing of that name is under the project or the trace dir");
check(resolveStorePath("run-elsewhere", context, project) === faraway,
  "the pointer also answers the run id that runtime_trace_finalize printed");

// ------------------------------------------------------- C. the removed fallback
console.log("\n--- C. no cwd fallback, and a failure that says where captures are ---");

const noProject = threw(() => resolveStorePath("live_a.duckdb", context));
check(noProject !== undefined, "a relative path with no project_dir and no env FAILS — it no longer answers from the cwd");
check(existsSync(decoy), "…while the decoy the old code would have returned is still sitting right there", decoy);
check(/runtime\/traces\.json/.test(noProject ?? ""), "the failure names the 827 pointer file");
check((noProject ?? "").includes(process.env.C64RE_TRACE_DIR), "the failure names the trace dir the captures live under");
check(/project_dir/.test(noProject ?? ""), "…and says what to pass");

const noMatch = threw(() => resolveStorePath("never_captured.duckdb", context, project));
check((noMatch ?? "").includes(tracePointerPath(project)), "with a project named, the failure names THAT project's pointer file");
check((noMatch ?? "").includes(traceDir), "…and THAT project's trace dir");
check((noMatch ?? "").includes(faraway), "…and lists the captures the pointer file knows, so the caller stops guessing");
check((noMatch ?? "").includes(join(project, "never_captured.duckdb")) && (noMatch ?? "").includes(join(traceDir, "never_captured.duckdb")),
  "…and shows every place it looked");
check(!(noMatch ?? "").includes(neutralCwd), "the cwd is not among the places it looked");

// ------------------------------------------------------------ D. the seven tools
console.log("\n--- D. all seven readers declare project_dir and pass `project_dir ?? path` ---");

const SEVEN = [
  ["trace_store_info", {}],
  ["trace_store_query", { sql: "SELECT 1" }],
  ["trace_store_top_pcs", { cpu: "c64", hypothesis: "$C000 — the loader stages its buffer there; read it in the disassembly" }],
  ["trace_store_bus_find", { addr: "$DD00" }],
  ["trace_store_anchor_list", {}],
  ["trace_store_anchor_find", { name: "entry" }],
  ["trace_memory_map", { hypothesis: "$C000 — the loader stages its buffer there; read it in the disassembly" }],
];

const handlers = new Map();
const schemas = new Map();
registerTraceStoreTools({ tool: (name, _desc, schema, handler) => { schemas.set(name, schema); handlers.set(name, handler); } }, context);

const textOf = (res) => (res?.content ?? []).map((c) => c.text ?? "").join("\n");

for (const [name, extra] of SEVEN) {
  const schema = schemas.get(name);
  check(typeof handlers.get(name) === "function", `${name} is registered`);
  check(schema && "project_dir" in schema, `${name} declares project_dir`);
  check(schema && schema.project_dir?.isOptional?.() === true, `${name}: project_dir is optional`);

  // named project_dir → the hint is the project, and resolution gets far enough
  // to fail INSIDE it (never at the daemon: the path never resolves).
  hints.length = 0;
  const named = textOf(await handlers.get(name)({ ...extra, project_dir: project, path: "never_captured.duckdb" }));
  check(hints[0] === project, `${name}: project_dir is passed to the resolver`, String(hints[0]));
  check(named.includes(tracePointerPath(project)), `${name}: the error names the pointer file`);

  // no project_dir → the hint is the tool's own path argument (D1's shape), which
  // outside a project resolves to nothing rather than to the cwd.
  hints.length = 0;
  const hintless = textOf(await handlers.get(name)({ ...extra, path: "live_a.duckdb" }));
  check(hints[0] === "live_a.duckdb", `${name}: without project_dir the hint is the store path itself`, String(hints[0]));
  check(/no project could be resolved/.test(hintless), `${name}: it fails instead of answering from the cwd`);
  check(!hintless.includes(decoy), `${name}: the cwd decoy is never returned`);
}

// ------------------------------------------------------------- E. the source itself
console.log("\n--- E. the fallback is removed, not re-pointed ---");

const src = readFileSync(join(ROOT, "src/server-tools/trace-store.ts"), "utf8");
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
check(!code.some((l) => /process\.cwd\(\)/.test(l)), "no process.cwd() left in trace-store.ts");
// The same rule e2e-mcp-path-portability applies file-granular: a hintless
// resolution anywhere in the file re-arms the defect for all seven tools.
check(!code.some((l) => /\.projectDir\(\s*(\)|undefined)/.test(l)),
  "no hintless context.projectDir() left — the seven can leave KNOWN_HINTLESS");

console.log("\n--- report ---");
console.log(`project:    ${project}`);
console.log(`trace dir:  ${traceDir}`);
console.log(`pointer:    ${tracePointerPath(project)}`);
console.log(`neutral cwd + decoy: ${decoy}`);
console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 834 §3: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
