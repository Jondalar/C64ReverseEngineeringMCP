#!/usr/bin/env node
// Spec 902 D5 — the gate's leak step, proved. A clean run passes; a smoke that leaves a server running
// fails the step, which names the smoke; what it left is ended afterwards. All in a state directory
// and on ports of this run's own.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${!c && d ? `  (${String(d).slice(0, 500)})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

const SANDBOX = mkdtempSync(join(tmpdir(), "c64re-902leak-"));
const PROJ = join(SANDBOX, "proj"); mkdirSync(PROJ);
const state = join(SANDBOX, "state"); mkdirSync(state);
const env = { ...process.env, C64RE_STATE_DIR: state, C64RE_STARTED_BY: "smoke", C64RE_RUNTIME_BIN: join(ROOT, "scripts/lib/stub-daemon-902.mjs"), C64RE_RUNTIME_IDLE_EXIT: "0" };
delete env.C64RE_RUNTIME_ENDPOINT; delete env.C64RE_PROJECT_DIR;
const node = (args, extra = {}) => spawnSync(process.execPath, args, { env: { ...env, ...extra }, encoding: "utf8", cwd: tmpdir() });
let leakedPid;
try {
  console.log("Spec 902 D5 — the leak step\n");
  check(node(["scripts/check-leaks.mjs", "--baseline"].map((a) => (a.startsWith("scripts") ? join(ROOT, a) : a))).status === 0, "the baseline step runs");
  const clean = node([join(ROOT, "scripts/check-leaks.mjs")]);
  check(clean.status === 0 && /nothing a smoke started is still running/.test(clean.stdout), "a clean run passes", clean.stdout + clean.stderr);

  const leaky = node([join(ROOT, "scripts/lib/leaky-smoke-902.mjs"), PROJ], { C64RE_GATE_STEP: "A smoke that forgets its server (test)" });
  const started = (() => { try { return JSON.parse(leaky.stdout.trim().split("\n").pop()); } catch { return undefined; } })();
  check(leaky.status === 0 && started?.started === "spawned", "a deliberately leaking smoke starts a daemon and exits without ending it", leaky.stdout + leaky.stderr);
  await sleep(300);
  const listing = node([join(ROOT, "dist/cli.js"), "status", "--json"]);
  leakedPid = JSON.parse(listing.stdout).processes.find((p) => p.record.kind === "daemon")?.record.pid;
  check(!!leakedPid && alive(leakedPid), "…and the daemon is running, in the ledger as a smoke's");

  const r = node([join(ROOT, "scripts/check-leaks.mjs")]);
  check(r.status === 1, "the leak step FAILS", `${r.status} ${r.stdout}`);
  check(/A smoke that forgets its server \(test\)/.test(r.stderr) && new RegExp(`daemon pid ${leakedPid}`).test(r.stderr), "…and names the smoke and what it left", r.stderr);
  await sleep(500);
  check(!alive(leakedPid), "…and ends what it found, so the leak does not pile up");
  const again = node([join(ROOT, "scripts/check-leaks.mjs")]);
  check(again.status === 0, "the next run is clean again", again.stderr);

  // not a smoke's: a process the owner started is not this step's business
  const mineEnv = { C64RE_STARTED_BY: "cli" };
  const keep = node([join(ROOT, "scripts/lib/leaky-smoke-902.mjs"), PROJ], mineEnv);
  const kp = JSON.parse(keep.stdout.trim().split("\n").pop());
  await sleep(300);
  const notSmoke = node([join(ROOT, "scripts/check-leaks.mjs")]);
  check(notSmoke.status === 0, "a daemon the owner started (not a smoke) is not a leak", notSmoke.stderr);
  node([join(ROOT, "dist/cli.js"), "down"]);
  void kp;
} finally {
  node([join(ROOT, "dist/cli.js"), "down"]);
  if (leakedPid && alive(leakedPid)) { try { process.kill(leakedPid, "SIGKILL"); } catch { /* */ } }
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
