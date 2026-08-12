// Spec 724.3 guard — ONE project path, resolved once, no cwd fallback. Static
// source scan + a safe resolver assert (NO server start, never touches a live
// session).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// Maps to the surviving 724A guard requirements:
//   (i)  HTTP projectDir == runtime projectDir → checks 1, 6, 7, 9
//   (ii) the resolver has no cwd fallback      → checks 1b, 8
console.log("Spec 724A — probe-workspace-single\n");

const server = stripComments(read("src/workspace-ui/server.ts"));
const workspace = read("scripts/workspace.mjs");

// 1. server.ts resolves the project via the shared resolver, with NO cwd default.
ok(/resolveProjectDir\s*\(/.test(server), "1 server.ts uses resolveProjectDir");
ok(!/projectDir:\s*process\.cwd\(\)/.test(server) && !/:\s*process\.cwd\(\),?\s*$/m.test(server.split("apiOnly")[0] ?? server),
  "1b server.ts has no process.cwd() projectDir default");

// 2-5. RETIRED (Spec 806) — these asserted properties of the TS runtime's WS server
//      and its in-repo daemon entry: the repo-`samples/` scan being --dev-samples
//      gated, projectDir coming from the ctor rather than the env, the ctor
//      requiring it, and the entry carrying no post-723 dead runtime keys. Both
//      files went with the emulator; the runtime daemon is a separate binary that
//      takes --project on its argv and has no repo-samples scan to gate.
// 6. The unified workspace bootstrap uses the shared resolver + starts both backends.
ok(/resolveProjectDir/.test(workspace) && /server\.js/.test(workspace) && /resolveDaemonSpawn/.test(workspace),
  "6 workspace bootstrap resolves once + starts HTTP + the runtime daemon");

// 7. The unified bootstrap passes the SAME --project to both children.
ok(/--project["',\s]+projectDir/.test(workspace.replace(/\s+/g, " ")) || /childArgs\s*=\s*\[\s*"--project"/.test(workspace),
  "7 workspace passes one resolved --project to HTTP + WS");

// 8. resolver: hard error without a project (NO cwd fallback) + resolves with --project.
const m = await import(`${ROOT}/dist/workspace-ui/resolve-project-dir.js`);
let threw = false;
try { m.resolveProjectDir([], {}); } catch { threw = true; }
ok(threw, "8 resolveProjectDir throws without --project/env (no cwd fallback)");
ok(m.resolveProjectDir(["--project", ROOT], {}) === ROOT, "8b resolveProjectDir resolves --project");

// 9. HTTP resolves the project via the shared module; the runtime daemon is handed
//    the SAME resolved absolute path on its argv (check 7), so they cannot drift.
ok(/resolve-project-dir/.test(server), "9 HTTP imports the shared resolve-project-dir module");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} workspace-single: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
