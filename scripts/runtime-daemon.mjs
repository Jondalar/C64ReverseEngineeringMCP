#!/usr/bin/env node
// Spec 744.4c — `npm run runtime:daemon` entry. Foreground launch of the runtime
// daemon. The MCP also AUTO-STARTS it (detached) when a runtime tool is first
// used, so you normally never run this by hand; it is here for an explicit
// foreground launch and for the e2e harnesses that want their OWN daemon on
// their OWN port (one machine per process — never the shared :4312 one).
//
// Spec 806 — the daemon is a separate BINARY now, not an in-repo TypeScript
// entry. `resolveDaemonSpawn` is the one place that decides which binary and
// with what argv, so this wrapper asks it rather than hard-coding a path; a
// missing binary is an actionable setup error, never a silent downgrade.
//
// Usage: npm run runtime:daemon -- --project <dir> [--port 4312]
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const argv = process.argv.slice(2);

const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const projectDir = resolvePath(arg("--project", process.env.C64RE_PROJECT_DIR ?? process.cwd()));
const port = arg("--port", "4312");

const { resolveDaemonSpawn } = await import(`${repoRoot}/dist/runtime/resolve-daemon-spawn.js`);
const { runtimeSetupRecipe } = await import(`${repoRoot}/dist/runtime/setup-recipe.js`);

const plan = resolveDaemonSpawn({ repoRoot, projectDir, port });
if (plan.mode === "none") {
  console.error(runtimeSetupRecipe("no runtime daemon binary found"));
  process.exit(1);
}
if (plan.warn) console.warn(`[daemon] ${plan.warn}`);

// Spec 902 D1 — a daemon this script starts is in the process ledger, so `c64re down` ends it.
const { registerProcess, unregisterProcess, childEnv } = await import(`${repoRoot}/dist/runtime/process-ledger.js`);
const child = spawn(plan.cmd, plan.args, { stdio: "inherit", windowsHide: true, env: childEnv("cli") });
if (child.pid) await registerProcess({ pid: child.pid, kind: "daemon", port: Number(port), project: projectDir, startedBy: "cli" });
child.on("exit", (code, signal) => { if (child.pid) unregisterProcess(child.pid); process.exit(signal ? 1 : (code ?? 0)); });
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
}
