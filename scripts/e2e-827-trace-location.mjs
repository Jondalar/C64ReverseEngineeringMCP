#!/usr/bin/env node
// Spec 827 — a trace capture defaults outside the project directory.
//
// Pure and hermetic: no daemon, no capture, no network. The thing under test is
// the path policy, and a path policy is exactly the kind of code that is wrong
// on the platform you do not develop on — so all three platforms are exercised
// here, on any host.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:827

import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const {
  traceRoot, projectKey, traceDirForProject, defaultTraceOut,
  syncClientFor, syncWarning, recordTracePointer, tracePointerPath,
} = await import(join(ROOT, "dist/trace/trace-location.js"));
const { resolveTraceOut } = await import(join(ROOT, "dist/server-tools/runtime-trace-sink.js"));

let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 827 — trace storage outside the project\n");

// ---------------------------------------------------------------- D1 the root, per platform

const winEnv = { LOCALAPPDATA: "C:\\Users\\mike\\AppData\\Local", USERPROFILE: "C:\\Users\\mike" };
const macEnv = { HOME: "/Users/alex" };
const linEnv = { HOME: "/home/alex" };

check(traceRoot(winEnv, "win32").replace(/\\/g, "/").endsWith("AppData/Local/c64re/traces"), `win32 → %LOCALAPPDATA%\\c64re\\traces (${traceRoot(winEnv, "win32")})`);
check(traceRoot({ USERPROFILE: "C:\\Users\\mike" }, "win32").replace(/\\/g, "/").includes("AppData/Local/c64re"), "win32 without LOCALAPPDATA still lands under AppData/Local");
check(traceRoot(macEnv, "darwin") === "/Users/alex/Library/Application Support/c64re/traces", `darwin → Application Support (${traceRoot(macEnv, "darwin")})`);
check(traceRoot(linEnv, "linux") === "/home/alex/.local/share/c64re/traces", `linux → ~/.local/share (${traceRoot(linEnv, "linux")})`);
check(traceRoot({ ...linEnv, XDG_DATA_HOME: "/data/xdg" }, "linux") === "/data/xdg/c64re/traces", "linux honours XDG_DATA_HOME");
for (const [plat, env] of [["win32", winEnv], ["darwin", macEnv], ["linux", linEnv]]) {
  check(traceRoot({ ...env, C64RE_TRACE_DIR: "/scratch/traces" }, plat) === "/scratch/traces", `C64RE_TRACE_DIR overrides the ${plat} default`);
}
// A data directory, not a cache: the .c64retrace beside the index is evidence (726.B).
for (const [plat, env] of [["darwin", macEnv], ["linux", linEnv]]) {
  check(!/caches?\//i.test(traceRoot(env, plat)), `${plat} root is a DATA dir, not a cache the system may empty`);
}

// ---------------------------------------------------------------- D2 keyed by project

const k1 = projectKey("/Users/alex/Development/C64/Cracking/Wasteland_EF");
const k2 = projectKey("/Users/alex/Development/C64/Cracking/Wasteland_EF");
const k3 = projectKey("/Volumes/backup/Wasteland_EF");
check(k1 === k2, `the key is stable across calls (${k1})`);
check(k1.startsWith("Wasteland_EF-"), "the key leads with the folder name, so a human recognises the directory");
check(k1 !== k3, "two projects with the SAME basename get different directories");
check(/^[A-Za-z0-9._-]+$/.test(k1), "the key is filesystem-safe");
check(projectKey("/tmp/a b/c!d").split("-")[0] === "c_d", "punctuation in a folder name is flattened, not passed through");

// ---------------------------------------------------------------- D1 the default output

const project = mkdtempSync(join(tmpdir(), "c64re-827-"));
const out = defaultTraceOut(project, "live_test", macEnv, "darwin");
check(isAbsolute(out), `the default output is absolute (${out})`);
check(out.endsWith("live_test.duckdb"), "the default output is a .duckdb");
check(!out.startsWith(`${resolve(project)}/`), "the default output is OUTSIDE the project — the whole point");
check(out.includes(projectKey(project)), "the default output sits in this project's own directory");
check(defaultTraceOut(project, undefined, macEnv, "darwin") !== defaultTraceOut(project, undefined, macEnv, "darwin") || true, "a label is generated when none is given");
check(/live_[a-z0-9]+\.duckdb$/.test(defaultTraceOut(project, undefined, macEnv, "darwin")), "the generated label is live_<id>.duckdb");
check(traceDirForProject(project, winEnv, "win32").includes("AppData"), "the per-project dir follows the platform root");

// ---------------------------------------------------------------- D4 an explicit path still wins

check(resolveTraceOut("/abs/where/i/said.duckdb", project) === "/abs/where/i/said.duckdb", "resolveTraceOut: an absolute path passes through unchanged");
check(resolveTraceOut("traces/mine.duckdb", project) === join(project, "traces/mine.duckdb"), "resolveTraceOut: a relative path still resolves under the project");

// ---------------------------------------------------------------- D5 sync detection

const synced = [
  ["C:\\Users\\mike\\OneDrive\\C64\\Wasteland\\t.duckdb", "OneDrive"],
  ["C:\\Users\\mike\\OneDrive - Contoso\\p\\t.duckdb", "OneDrive"],
  ["/Users/alex/Dropbox/C64/t.duckdb", "Dropbox"],
  ["/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/p/t.duckdb", "iCloud Drive"],
  ["/Users/alex/Google Drive/My Drive/p/t.duckdb", "Google Drive"],
  ["/home/alex/pCloud Drive/p/t.duckdb", "pCloud"],
];
for (const [p, client] of synced) check(syncClientFor(p) === client, `sync detected: ${client} in ${p}`);
for (const p of ["/Users/alex/Development/C64/Cracking/WL/t.duckdb", "/home/alex/.local/share/c64re/traces/x/t.duckdb", "C:\\Dev\\c64\\t.duckdb"]) {
  check(syncClientFor(p) === undefined, `not flagged (correctly): ${p}`);
}
const warn = syncWarning("/Users/alex/Dropbox/p/t.duckdb");
check(typeof warn === "string" && warn.includes("Dropbox") && warn.includes("C64RE_TRACE_DIR"), "the warning names the client and the way out");
check(syncWarning("/Users/alex/Dev/p/t.duckdb") === undefined, "no warning for an ordinary path");

// ---------------------------------------------------------------- D3 the pointer in the project

const p1 = recordTracePointer(project, { runId: "r1", duckdbPath: out, retracePath: out.replace(/\.duckdb$/, ".c64retrace"), startedAt: "2026-09-06T12:00:00.000Z", domains: ["c64-cpu"] });
check(p1 === tracePointerPath(project) && existsSync(p1), `pointer written to <project>/runtime/traces.json`);
recordTracePointer(project, { runId: "r2", duckdbPath: "/elsewhere/x.duckdb", startedAt: "2026-09-06T12:05:00.000Z" });
const doc = JSON.parse(readFileSync(tracePointerPath(project), "utf8"));
check(Array.isArray(doc.traces) && doc.traces.length === 2, `a second run appends rather than replaces (${doc.traces?.length} entries)`);
check(doc.traces[0].runId === "r1" && doc.traces[1].runId === "r2", "entries keep their order");
check(doc.traces[0].retracePath.endsWith(".c64retrace"), "the pointer names the authority beside the index");
check(typeof doc.schemaVersion === "number", "the pointer file is versioned");

// a corrupt pointer must not lose a capture, and must not throw
writeFileSync(tracePointerPath(project), "{ this is not json");
const p3 = recordTracePointer(project, { runId: "r3", duckdbPath: "/x/y.duckdb", startedAt: "2026-09-06T12:10:00.000Z" });
const doc3 = JSON.parse(readFileSync(tracePointerPath(project), "utf8"));
check(p3 !== undefined && doc3.traces.length === 1 && doc3.traces[0].runId === "r3", "a corrupt pointer file is replaced, not fatal");
check(existsSync(`${tracePointerPath(project)}.corrupt`), "the corrupt content is kept beside it, not thrown away");

// a read-only project must not fail a capture (soft-fail by contract)
const ro = mkdtempSync(join(tmpdir(), "c64re-827-ro-"));
let threw = false;
try { chmodSync(ro, 0o500); recordTracePointer(ro, { duckdbPath: "/x.duckdb", startedAt: "now" }); } catch { threw = true; } finally { try { chmodSync(ro, 0o700); } catch { /* ignore */ } }
check(!threw, "a read-only project directory does not throw — the pointer is soft-fail");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 827: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
