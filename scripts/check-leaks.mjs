#!/usr/bin/env node
// Spec 902 D5 — the gate's leak step. After every smoke has run, nothing a smoke started is still
// running: no record in the process ledger with startedBy "smoke" whose process is alive, and no
// new listener of this repository's (a process whose command line names this checkout) since the
// baseline taken before the first step. A smoke that starts a server ends it in `finally`.
//
//   node scripts/check-leaks.mjs --baseline    first step: remember who listens now
//   node scripts/check-leaks.mjs               last step: fail, naming the smoke, for anything left
//
// The gate (scripts/gate.sh, and the workflow's job env) gives every step C64RE_STATE_DIR (its own
// directory), C64RE_STARTED_BY=smoke and C64RE_GATE_STEP (or npm names the script): the ledger
// records of the processes a smoke starts then say which smoke it was. What is found is ended, so a
// leak does not pile up on the next run, and the step still fails.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);
const { platformProc } = await dist("runtime/platform-proc.js");
const { checkLedger, unregisterProcess } = await dist("runtime/process-ledger.js");
const { stateDir } = await dist("runtime/c64u-bridge/state.js");

const baselineFile = join(stateDir(), "leak-baseline.json");
// this checkout's own processes: another session's daemon or sandbox on the machine is not this gate's leak
const mine = (cmd) => cmd.includes(ROOT);

async function listenersNow() {
  const ls = await platformProc.listeners();
  const infos = await platformProc.infoMany([...new Set(ls.map((l) => l.pid))]);
  return ls.map((l) => ({ pid: l.pid, port: l.port, command: infos.get(l.pid)?.command ?? "" })).filter((l) => l.command && mine(l.command));
}

if (process.argv.includes("--baseline")) {
  mkdirSync(dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, JSON.stringify(await listenersNow()));
  console.log(`leak baseline: ${(JSON.parse(readFileSync(baselineFile, "utf8"))).length} listener(s) of this repository already up`);
  process.exit(0);
}

const leaks = [];
const recorded = new Set();
for (const e of await checkLedger()) {
  if (e.state !== "ours") { unregisterProcess(e.record.pid); continue; }
  recorded.add(e.record.pid);
  if (e.record.startedBy !== "smoke") continue;
  leaks.push({ who: e.record.smoke ?? "(a smoke that did not say which: no gate step, no npm script)", what: `${e.record.kind} pid ${e.record.pid}${e.record.port ? ` :${e.record.port}` : ""}`, pid: e.record.pid, ledger: true });
}
const base = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : [];
const known = new Set(base.map((b) => `${b.pid}:${b.port}`));
for (const l of await listenersNow()) {
  if (known.has(`${l.pid}:${l.port}`) || recorded.has(l.pid)) continue;
  leaks.push({ who: "(unrecorded: started by something that did not use the ledger)", what: `pid ${l.pid} :${l.port}  ${l.command.slice(0, 160)}`, pid: l.pid, ledger: false });
}

if (leaks.length === 0) { console.log("nothing a smoke started is still running"); process.exit(0); }
console.error(`LEAK: ${leaks.length} thing(s) left running by the smokes`);
for (const l of leaks) console.error(`  ${l.who}\n      left ${l.what}`);
// end them: a leak must not pile up on the next run — but only what the ledger vouches for
for (const l of leaks.filter((x) => x.ledger)) { try { await platformProc.end(l.pid, { graceMs: 1500 }); } catch { /* */ } unregisterProcess(l.pid); }
console.error("A smoke that starts a server ends it in `finally` (and a test that starts the MCP server sets C64RE_RUNTIME_AUTOSTART=0).");
process.exit(1);
