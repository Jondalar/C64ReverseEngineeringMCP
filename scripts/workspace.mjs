#!/usr/bin/env node
// Spec 724.3 — ONE workspace bootstrap. Resolves the project dir ONCE and
// starts both backends with it:
//   - HTTP (knowledge API + UI)  : dist/workspace-ui/server.js  (:4310)
//   - WS   (live runtime)        : the runtime daemon binary     (:4312)
// Usage: npm run workspace -- --project <dir> [--dev-samples] [--port <http>]
// No cwd fallback — a project path is required (usable outside the C64RE repo).

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { resolveProjectDir, hasDevSamples } = await import(
  pathToFileURL(`${repoRoot}/dist/workspace-ui/resolve-project-dir.js`)
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

// Probe before spawn — one machine per process, so a SECOND daemon on the same
// port is a startup crash (AddrInUse), not a safe no-op. Reuse whatever is
// already listening; only spawn our own when nothing answers.
function tcpUp(host, port, timeoutMs = 800) {
  return new Promise((resolveTcp) => {
    const s = createConnection({ host, port });
    const done = (v) => { try { s.destroy(); } catch {} resolveTcp(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => { clearTimeout(t); done(true); });
    s.once("error", () => { clearTimeout(t); done(false); });
  });
}
function parseEndpoint(url) {
  const m = /^wss?:\/\/([^/:]+):(\d+)/.exec(url || "");
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

const explicitEndpoint = process.env.C64RE_RUNTIME_ENDPOINT || process.env.C64RE_RUNTIME_WS;
const wsEndpoint = parseEndpoint(explicitEndpoint) ?? { host: "127.0.0.1", port: 4312 };
const wsIsLocal = wsEndpoint.host === "127.0.0.1" || wsEndpoint.host === "localhost";

if (!wsIsLocal) {
  // Explicit remote endpoint: nothing to spawn here, just trust it.
  console.log(`[workspace] Live runtime WS is the Runtime Daemon (${explicitEndpoint}); not starting a standalone WS.`);
} else if (await tcpUp(wsEndpoint.host, wsEndpoint.port)) {
  // Spec 744.4c — product shared authority: a daemon is already listening
  // (e.g. an MCP session started it, or a previous workspace run). Do NOT
  // also spawn a second one here — that is a SECOND runtime authority in a
  // separate process, and it panics on the port conflict.
  console.log(`[workspace] Live runtime WS: reusing daemon already listening on ${wsEndpoint.host}:${wsEndpoint.port}; not starting a second one.`);
} else {
  // Nothing answering — start one so the Live tab works without a manual
  // `npm run runtime:daemon` step first.
  // Spec 757 — ONE WS-start path: the Runtime Daemon entry.
  // Spec 771.1 — the shared resolver locates the daemon binary (C64RE_RUNTIME_BIN /
  // C64RE_TRX64_BIN / the sibling release build). Spec 806: there is no second tier,
  // so `mode === "none"` means "not built" and the run stops with that message.
  const { resolveDaemonSpawn } = await import(
    pathToFileURL(`${repoRoot}/dist/runtime/resolve-daemon-spawn.js`)
  );
  const plan = resolveDaemonSpawn({ repoRoot, projectDir, port: String(wsEndpoint.port) });
  if (plan.warn) console.warn(`[workspace] ${plan.warn}`);
  if (plan.mode === "none") {
    console.error("[workspace] no runtime daemon entry found");
    shutdown();
  } else {
    console.log(`[workspace] WS backend = ${plan.mode} (starting fresh on :${wsEndpoint.port})`);
    start("ws", plan.cmd, plan.args);
  }
}
