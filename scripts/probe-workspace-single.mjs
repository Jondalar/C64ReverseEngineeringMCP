// Spec 724.3 guard — one project path, no cwd/samples silent fallback, no
// post-723 runtime keys in the bootstrap. Static source scan + a safe resolver
// assert (NO server start, never touches a live session).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// Maps to the four 724A guard requirements:
//   (i)   HTTP projectDir == WS projectDir  → checks 1, 6, 7, 9
//   (ii)  media picker = project media, not repo samples → checks 2, 3
//   (iii) dev samples only with --dev-samples → check 2
//   (iv)  no stale runtime key → check 5
console.log("Spec 724A — probe-workspace-single\n");

const server = stripComments(read("src/workspace-ui/server.ts"));
const wsSrvRaw = read("src/workspace-ui/ws-server.ts");
const wsSrv = stripComments(wsSrvRaw);
const bootstrap = stripComments(read("scripts/start-v3-server.mjs"));
const workspace = read("scripts/workspace.mjs");

// 1. server.ts resolves the project via the shared resolver, with NO cwd default.
ok(/resolveProjectDir\s*\(/.test(server), "1 server.ts uses resolveProjectDir");
ok(!/projectDir:\s*process\.cwd\(\)/.test(server) && !/:\s*process\.cwd\(\),?\s*$/m.test(server.split("apiOnly")[0] ?? server),
  "1b server.ts has no process.cwd() projectDir default");

// 2. ws-server media `samples/` scan is gated by devSamples (no silent cwd
//    scan). Tested on raw source (it is code, not a keyword ban).
ok(/this\.devSamples\s*&&\s*fsmod\.existsSync\(samplesDir\)/.test(wsSrvRaw),
  "2 WS samples scan gated by this.devSamples");

// 3. ws-server reads the project from this.projectDir, not process.env.
ok(!/process\.env\[?["']?C64RE_PROJECT_DIR/.test(wsSrv),
  "3 WS uses this.projectDir, not process.env.C64RE_PROJECT_DIR");

// 4. WsServer requires projectDir (ctor throws without).
ok(/requires projectDir/.test(wsSrv), "4 WsServer ctor requires projectDir");

// 5. start-v3-server carries NO post-723 removed runtime keys.
const deadKeys = /useMicrocodedCpu|drive1541|C64RE_DRIVE1541|C64RE_CYCLE_PUMPED|cycle-pumped-renderer/;
ok(!deadKeys.test(bootstrap), "5 start-v3-server has no post-723 dead runtime keys");

// 6. Both the WS bootstrap + the unified workspace use the shared resolver.
ok(/resolveProjectDir/.test(bootstrap), "6 start-v3-server uses resolveProjectDir");
ok(/resolveProjectDir/.test(workspace) && /server\.js/.test(workspace) && /start-v3-server\.mjs/.test(workspace),
  "6b workspace bootstrap resolves once + starts HTTP + WS");

// 7. The unified bootstrap passes the SAME --project to both children.
ok(/--project["',\s]+projectDir/.test(workspace.replace(/\s+/g, " ")) || /childArgs\s*=\s*\[\s*"--project"/.test(workspace),
  "7 workspace passes one resolved --project to HTTP + WS");

// 8. resolver: hard error without a project (NO cwd fallback) + resolves with --project.
const m = await import(`${ROOT}/dist/workspace-ui/resolve-project-dir.js`);
let threw = false;
try { m.resolveProjectDir([], {}); } catch { threw = true; }
ok(threw, "8 resolveProjectDir throws without --project/env (no cwd fallback)");
ok(m.resolveProjectDir(["--project", ROOT], {}) === ROOT, "8b resolveProjectDir resolves --project");

// 9. HTTP + WS resolve the project via the SAME module → identical precedence,
//    so for the same argv/env they get the SAME projectDir (req (i)).
ok(/resolve-project-dir/.test(server) && /resolve-project-dir/.test(bootstrap),
  "9 HTTP + WS import the same resolve-project-dir module");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} workspace-single: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
