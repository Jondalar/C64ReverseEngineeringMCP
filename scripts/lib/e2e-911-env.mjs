// Shared by the feature-run gates: a private TMPDIR that is removed on exit (sandbox scratch included),
// the command line door, and the check that no daemon of the run outlives it.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, processesMatching } from "./e2e-906-harness.mjs";

/** Point TMPDIR at a directory of this run's own; it and everything under it goes at exit. */
export function privateTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.TMPDIR = dir;
  const gone = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } };
  process.on("exit", gone);
  return { dir, gone };
}

/** `c64re scenario run …` as a child: its exit code and what it printed. */
export function runCli(args, { env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, "dist/cli.js"), "scenario", "run", ...args], {
    encoding: "utf8", cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Machines of this run's own that are still alive: sandbox daemons keep their scratch in the run's TMPDIR. */
export function liveMachines(tmp) {
  return processesMatching("trx64-daemon").filter((p) => p.command.includes(tmp) && p.command.includes("c64re-reel-") && !/^\S*node\b/.test(p.command));
}

export const jsonOf = (out) => JSON.parse(out.slice(out.indexOf("{")));

/** The same, asynchronously — so the test can look at the machines while it runs. */
export function runCliAsync(args, { env = {} } = {}) {
  const child = spawn(process.execPath, [join(ROOT, "dist/cli.js"), "scenario", "run", ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => { stdout += b; });
  child.stderr.on("data", (b) => { stderr += b; });
  const done = new Promise((res) => child.once("close", (code) => res({ code, stdout, stderr })));
  return { child, done };
}
