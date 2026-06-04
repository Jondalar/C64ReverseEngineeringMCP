#!/usr/bin/env node
// Spec 724.3 — ONE workspace bootstrap. Resolves the project dir ONCE and
// starts both backends with it:
//   - HTTP (knowledge API + UI)  : dist/workspace-ui/server.js  (:4310)
//   - WS   (live runtime)        : dist/runtime/headless/daemon/run.js  (:4312)
// Usage: npm run workspace -- --project <dir> [--dev-samples] [--port <http>]
// No cwd fallback — a project path is required (usable outside the C64RE repo).

import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { resolveProjectDir, hasDevSamples } = await import(
  `${repoRoot}/dist/workspace-ui/resolve-project-dir.js`
);

const argv = process.argv.slice(2);
// Resolve once (throws with a clear message if no --project / C64RE_PROJECT_DIR).
const projectDir = resolveProjectDir(argv, process.env);
const devSamples = hasDevSamples(argv);
const httpPortIdx = argv.indexOf("--port");
const httpPort = httpPortIdx >= 0 && argv[httpPortIdx + 1] ? argv[httpPortIdx + 1] : "4310";

console.log(`[workspace] projectDir = ${projectDir}${devSamples ? " (+dev-samples)" : ""}`);
console.log(`[workspace] HTTP :${httpPort}  WS :4312`);

// Both children get the SAME resolved absolute projectDir via --project, so the
// HTTP knowledge API and the WS runtime can never drift to different projects.
const childArgs = ["--project", projectDir, ...(devSamples ? ["--dev-samples"] : [])];

const children = [];
function start(label, cmd, args) {
  const c = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], cwd: repoRoot });
  c.stdout.on("data", (b) => process.stdout.write(`[${label}] ${b}`));
  c.stderr.on("data", (b) => process.stderr.write(`[${label}] ${b}`));
  c.on("exit", (code) => {
    console.error(`[workspace] ${label} exited (code ${code}) — shutting down`);
    shutdown();
  });
  children.push(c);
  return c;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) { try { c.kill("SIGINT"); } catch {} }
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start("http", "node", [`${repoRoot}/dist/workspace-ui/server.js`, "--port", httpPort, ...childArgs]);

// Spec 744.4c — product shared authority: when C64RE_RUNTIME_ENDPOINT is set, the
// Live runtime WS is the separate process-stable Runtime Daemon (`npm run
// runtime:daemon`). Do NOT also spawn the standalone WS here — that would be a
// SECOND runtime authority in a separate process (and a :4312 port conflict).
// Without it this is the standalone dev path (UI without the daemon/MCP).
if (process.env.C64RE_RUNTIME_ENDPOINT || process.env.C64RE_RUNTIME_WS) {
  console.log(`[workspace] Live runtime WS is the Runtime Daemon (${process.env.C64RE_RUNTIME_ENDPOINT ?? "co-host"}); not starting a standalone WS. Run \`npm run runtime:daemon\`.`);
} else {
  // Spec 757 — ONE WS-start path: the Runtime Daemon entry (the same WsServer),
  // not a second standalone bootstrap. Was scripts/start-v3-server.mjs (retired).
  start("ws", "node", [`${repoRoot}/dist/runtime/headless/daemon/run.js`, "--port", "4312", ...childArgs]);
}
