// A sandbox daemon does not outlive the process that started it.
//
// The budget used to be a timer in the caller, so a caller that died — killed, crashed,
// its session closed — left the daemon running with parent PID 1 (a reel daemon ran for a
// day, 2026-10-01). Now a keeper between the two holds the budget and watches the caller.
//   1. a child process starts a sandbox, reports the daemon's pid and its scratch dir, and
//      is SIGKILLed — nothing of its own runs after that;
//   2. the daemon must be gone within a few seconds, and its scratch dir with it;
//   3. a sandbox whose budget runs out while its caller is alive ends too.
// Needs a TRX64 daemon (the sibling release build, or TRX64_DAEMON_BIN).
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = pathToFileURL(join(ROOT, "dist/reel/sandbox-session.js")).href;
if (!existsSync(fileURLToPath(mod))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 200)); } return cond(); };
const daemonPidOn = (port) => {
  try { return Number(execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0]) || null; } catch { return null; }
};

console.log("A sandbox daemon does not outlive its caller\n");

// ── 1+2: the caller is killed outright ─────────────────────────────────────────────
const caller = spawn(process.execPath, ["--input-type=module", "-e", `
  const { SandboxSession } = await import(${JSON.stringify(mod)});
  const s = await SandboxSession.start({ budgetMs: 600000 });
  console.log(JSON.stringify({ port: s.port, scratch: s.ownTmp }));
  setInterval(() => {}, 1000);
`], { stdio: ["ignore", "pipe", "inherit"] });
const started = await new Promise((res) => caller.stdout.once("data", (b) => res(JSON.parse(b.toString()))));
const daemon = daemonPidOn(started.port);
check(!!daemon && alive(daemon), "the sandbox daemon is up and listening", `pid ${daemon}, port ${started.port}`);
check(!!started.scratch && existsSync(started.scratch), "…with its scratch dir", started.scratch);

caller.kill("SIGKILL");
const gone = await until(() => !alive(daemon), 8000);
check(gone, "the caller SIGKILLed → the daemon ends within seconds, not never", gone ? "gone" : `pid ${daemon} still alive`);
const cleaned = await until(() => !existsSync(started.scratch), 4000);
check(cleaned, "…and its scratch dir is removed", started.scratch);
if (!gone && daemon) try { process.kill(daemon, "SIGKILL"); } catch {}

// ── 3: the budget, with the caller alive ───────────────────────────────────────────
const { SandboxSession } = await import(mod);
const s = await SandboxSession.start({ budgetMs: 3000 });
const d2 = daemonPidOn(s.port);
const ended = await until(() => !alive(d2), 12000);
check(ended && /budget/.test(s.ended ?? ""), "a budget that runs out ends the daemon, and the session says why", s.ended ?? "still running");
await s.close();

console.log(`\n${fail === 0 ? "GREEN" : "RED"} sandbox orphan: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
