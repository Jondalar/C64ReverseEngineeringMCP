#!/usr/bin/env node
// Spec 902 — `c64re down` / `up` / `status`, the process ledger, the hold, the platform layer.
//
// Acceptance (spec §4), end to end, on a state directory, ports and daemons of this run's own:
//   A  the whole shutdown: a daemon started by an MCP tool, the UI, a C64 Ultimate bridge on a fake
//      device, a sandbox — `down` ends all of them, ps/lsof show nothing, the selection is gone
//   B  down stays down: a tool call, an MCP restart and the UI dev server start nothing and answer
//      with the hold; `up` starts the daemon again and clears the hold
//   C  a foreign process on the runtime port survives and is named; the exit code is non-zero
//   D  a record whose pid now belongs to a different command is not signalled, only dropped
//   E  a runtime without daemon/shutdown is still ended (and the report says how)
//   F  the grace: a hard stop is used only after it; the Windows order (ask, wait, stop) is walked
//      on this machine too (C64RE_DOWN_ASK_FIRST=1) and through the layer's own fakes
//   G  --project and --keep: partial downs end part and write no hold
//   H  the UI's shutdown request is local-only; a bridge answers daemon/shutdown
//   I  no process C64RE starts opens a console window; the parsers read what Windows prints
//
// The daemon is the real trx64-daemon when there is one (C64RE_RUNTIME_BIN, or the sibling build) and
// scripts/lib/stub-daemon-902.mjs always — the Windows CI job has no TRX64 binary and runs the
// same acceptance on the stub. NOTHING here touches :4312, the user's state directory or a daemon it
// did not start: every port is the OS's choice, every state directory a temp one.
//
//   npm run e2e:902
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { request } from "node:http";
import { startFakeUltimate } from "./lib/fake-ultimate.mjs";
import { startMcp } from "./lib/mcp-stdio.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
let pass = 0, failCount = 0;
const check = (c, m, d = "") => { c ? pass++ : failCount++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${!c && d !== "" ? `  (${String(d).slice(0, 600)})` : ""}`); };
const head = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000, step = 100) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(step); } return !!(await f()); };
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);

if (!existsSync(join(ROOT, "dist/cli.js"))) { console.log("FAIL  dist is not built (npm run build)"); process.exit(1); }

// ── the sandbox of this run ────────────────────────────────────────────────────────────────────
const SANDBOX = mkdtempSync(join(tmpdir(), "c64re-902-"));
const PROJ = join(SANDBOX, "proj");
const PROJ2 = join(SANDBOX, "proj2");
mkdirSync(PROJ, { recursive: true });
mkdirSync(PROJ2, { recursive: true });
let stateN = 0;
const freshState = () => { const d = join(SANDBOX, `state${++stateN}`); mkdirSync(d, { recursive: true }); return d; };
process.env.C64RE_STATE_DIR = freshState();
process.env.C64RE_PROCESS_ROLE = "the e2e";
process.env.C64RE_C64U_VIDEO_PORT = "0";
process.env.C64RE_C64U_AUDIO_PORT = "0";
for (const k of ["C64RE_RUNTIME_BACKEND", "C64RE_PROJECT_DIR", "C64RE_RUNTIME_AUTOSTART", "C64RE_RUNTIME_ENDPOINT", "C64RE_DOWN_ASK_FIRST", "C64RE_DOWN_GRACE_MS", "C64RE_STARTED_BY", "C64RE_GATE_STEP", "C64RE_UI_PORTS"]) delete process.env[k];

const { ProjectKnowledgeService } = await dist("project-knowledge/service.js");
new ProjectKnowledgeService(PROJ).initProject({ name: "902" });
new ProjectKnowledgeService(PROJ2).initProject({ name: "902-other" });
const { platformProc, PlatformProc, parsePosixPs, parseWindowsProcs, parseLsof, parseSs, parseNetTcp, parseNetstat, graceMs } = await dist("runtime/platform-proc.js");
const ledger = await dist("runtime/process-ledger.js");
const holdMod = await dist("runtime/hold.js");
const stateMod = await dist("runtime/c64u-bridge/state.js");

// ── the runtimes this run can use ───────────────────────────────────────────────────────────────
const STUB = join(ROOT, "scripts/lib/stub-daemon-902.mjs");
const siblingExe = join(ROOT, "..", "TRX64", "target", "release", IS_WIN ? "trx64-daemon.exe" : "trx64-daemon");
const REAL = process.env.C64RE_RUNTIME_BIN && !/\.m?js$/.test(process.env.C64RE_RUNTIME_BIN) ? process.env.C64RE_RUNTIME_BIN
  : existsSync(siblingExe) ? siblingExe : undefined;

/** Everything a test needs from one state directory: the env of children, `c64re …` as a process, the ledger as a test sees it. */
function world(label, { bin, mode = "normal", env = {} } = {}) {
  const state = freshState();
  const e = {
    ...process.env,
    C64RE_STATE_DIR: state,
    C64RE_RUNTIME_BIN: bin ?? STUB,
    STUB_DAEMON_MODE: mode,
    C64RE_RUNTIME_IDLE_EXIT: "0",
    ...env,
  };
  const w = { label, state, env: e, ports: {} };
  w.cli = (args, extra = {}) => new Promise((res) => {
    const p = spawn(process.execPath, [join(ROOT, "dist/cli.js"), ...args], { env: { ...e, ...extra }, cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    const t = Date.now();
    p.once("exit", (code) => res({ code, out, err, ms: Date.now() - t }));
  });
  w.ledgerRecords = () => {
    const dir = join(state, "processes");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
  };
  w.holdExists = () => existsSync(join(state, "hold.json"));
  w.selectionExists = () => existsSync(join(state, "runtime-selection.json"));
  return w;
}

const listening = async (port) => (await platformProc.listenersOn(port)).length > 0;
async function ping(port) {
  const { WebSocket } = await import("ws");
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?av=0`);
    const t = setTimeout(() => { try { ws.terminate(); } catch { /* */ } res(undefined); }, 3000);
    ws.once("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })));
    ws.once("error", () => { clearTimeout(t); res(undefined); });
    ws.on("message", (d) => { try { const m = JSON.parse(String(d)); if (m.id === 1) { clearTimeout(t); ws.terminate(); res(m.result); } } catch { /* */ } });
  });
}
const httpGet = (port, path) => new Promise((res) => {
  const r = request({ host: "127.0.0.1", port, path, timeout: 3000 }, (x) => { x.resume(); x.on("end", () => res(x.statusCode)); });
  r.once("error", () => res(undefined)); r.once("timeout", () => { r.destroy(); res(undefined); }); r.end();
});
const rawPost = (port, path, headers) => new Promise((res) => {
  const r = request({ host: "127.0.0.1", port, path, method: "POST", headers, timeout: 3000 }, (x) => { x.resume(); x.on("end", () => res(x.statusCode)); });
  r.once("error", () => res(undefined)); r.once("timeout", () => { r.destroy(); res(undefined); }); r.end();
});

const reaper = [];            // child processes of this run, killed in the end whatever happened
const reapPids = new Set();   // pids found in a ledger, ended in the end whatever happened
function track(p) { reaper.push(p); return p; }
async function sweep(w) {
  for (const r of w.ledgerRecords()) reapPids.add(r.pid);
}

// A runtime for the whole of A and B, once with the stub and once with the real daemon.
async function acceptance(label, bin, extraEnv = {}) {
  head(`A/B  the whole shutdown, and down stays down — ${label}`);
  const sim = await startFakeUltimate({ capabilities: "object" });
  const RT = await freePort();
  const HTTP = await freePort();
  const VITE = await freePort();
  const w = world(label, { bin, env: {
    C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${RT}`, C64RE_UI_PORTS: `${HTTP},${VITE}`, C64RE_PROJECT_DIR: PROJ, ...extraEnv,
  } });
  let mcp, ui, sandbox;
  const savedEnv = { ...process.env };
  Object.assign(process.env, w.env); // this process starts the sandbox: it needs the same state directory and runtime
  try {
    // an MCP tool starts the daemon
    mcp = startMcp({ root: ROOT, env: { ...w.env } });
    const st0 = await mcp.call("runtime_session_status", { session_id: "shared" });
    check(await until(() => listening(RT), 30000), "an MCP tool call starts the daemon", st0.slice(0, 200));
    const daemonRec = w.ledgerRecords().find((r) => r.kind === "daemon" && r.port === RT);
    check(!!daemonRec && daemonRec.startedBy === "mcp", "…and it is in the ledger: kind daemon, port, started by mcp", JSON.stringify(daemonRec));
    check(!!daemonRec && !!daemonRec.start && daemonRec.command.length > 0, "…with the OS's start time and its command line as the OS reports it", JSON.stringify(daemonRec));

    // the UI
    ui = track(spawn(process.execPath, [join(ROOT, "dist/cli.js"), "ui", "--project", PROJ, "--port", String(HTTP)], { env: w.env, stdio: ["ignore", "pipe", "pipe"] }));
    let uiOut = ""; ui.stdout.on("data", (d) => { uiOut += d; }); ui.stderr.on("data", (d) => { uiOut += d; });
    check(await until(async () => (await httpGet(HTTP, "/api/health")) === 200, 30000), "the UI comes up (HTTP)", uiOut.slice(-300));
    await until(() => w.ledgerRecords().some((r) => r.kind === "ui-server"), 10000);
    const kinds = new Set(w.ledgerRecords().map((r) => r.kind));
    check(kinds.has("ui") && kinds.has("ui-server"), "the launcher and the workspace server are both in the ledger", [...kinds].join(","));

    // a C64 Ultimate (fake) selected
    await mcp.call("agent_onboard", { project_dir: PROJ });
    const sel = await mcp.call("runtime_backend", { action: "select", backend: "c64u", host: `127.0.0.1:${sim.restPort}` });
    check(/Selected: C64 Ultimate/.test(sel), "a C64 Ultimate is selected (a fake device)", sel.slice(0, 200));
    const bridgeRec = w.ledgerRecords().find((r) => r.kind === "bridge");
    check(!!bridgeRec && !!bridgeRec.port && bridgeRec.device === `127.0.0.1:${sim.restPort}`, "the bridge records itself: kind bridge, port, device", JSON.stringify(bridgeRec));
    check(w.selectionExists(), "runtime-selection.json exists");

    // a sandbox
    const { SandboxSession } = await dist("reel/sandbox-session.js");
    sandbox = await SandboxSession.start({ budgetMs: 180_000, projectDir: PROJ });
    const sbRec = w.ledgerRecords().find((r) => r.kind === "sandbox");
    check(!!sbRec && sbRec.port === sandbox.port && sbRec.startedBy === "sandbox", "a sandbox is in the ledger: kind sandbox, its own port, started by sandbox", JSON.stringify(sbRec));

    // status says what runs
    const status = await w.cli(["status"]);
    check(status.code === 0 && /daemon/.test(status.out) && /bridge/.test(status.out) && /ui-server/.test(status.out) && /sandbox/.test(status.out) && /selection: C64 Ultimate/.test(status.out), "`c64re status` lists daemon, bridge, UI, sandbox and the selection", status.out.slice(0, 700));
    const ps = await mcp.call("project_status", { project_dir: PROJ });
    check(/Running \(c64re status\)/.test(ps) && /bridge/.test(ps) && /hold: none/.test(ps), "project_status carries the same section", ps.split("\n").filter((l) => /Running|bridge|hold/.test(l)).join(" | "));

    // down
    const before = w.ledgerRecords();
    const ports = [RT, HTTP, bridgeRec.port, sandbox.port];
    const down = await w.cli(["down"]);
    console.log(down.out.split("\n").map((l) => `        ${l}`).join("\n"));
    check(down.code === 0, "`c64re down` exits 0", `${down.code} ${down.err.slice(0, 200)}`);
    for (const kind of ["ui", "ui-server", "bridge", "sandbox", "daemon"]) {
      check(new RegExp(`(ended|gone) .*${kind} pid \\d+`).test(down.out), `the report lists the ${kind}`);
    }
    check(before.every((r) => !alive(r.pid)), "every process of the ledger is gone (kill -0)", before.map((r) => `${r.kind}:${r.pid}:${alive(r.pid)}`).join(" "));
    const stillListening = [];
    for (const p of ports) if (await listening(p)) stillListening.push(p);
    check(stillListening.length === 0, "nothing listens on the runtime, UI, bridge or sandbox port (lsof / netstat)", stillListening.join(","));
    check(!w.selectionExists(), "runtime-selection.json is gone");
    check(w.ledgerRecords().length === 0, "the ledger is empty");
    check(w.holdExists(), "the hold is written");
    if (!IS_WIN) {
      const psOut = await new Promise((res) => { const p = spawn("ps", ["-axo", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] }); let o = ""; p.stdout.on("data", (d) => { o += d; }); p.on("close", () => res(o)); });
      const left = psOut.split("\n").filter((l) => l.includes(w.state) || l.includes(`--port ${RT}`) || l.includes(`--port ${bridgeRec.port}`));
      check(left.length === 0, "ps shows no process with this run's state directory or ports on its command line", left.join(" | ").slice(0, 300));
    }
    check(down.out.includes("hold written"), "the report says the hold is written");

    // B: down stays down
    head(`B  down stays down — ${label}`);
    const tool = await mcp.call("runtime_session_status", { session_id: "shared" });
    check(/C64RE is shut down \(since .* by c64re down\)/.test(tool) && /c64re up/.test(tool), "a runtime tool answers with the hold message", tool.slice(0, 250));
    await sleep(800);
    check(!(await listening(RT)), "…and started nothing");
    mcp.stop();
    await sleep(300);
    const mcp2 = startMcp({ root: ROOT, env: { ...w.env } });
    await sleep(2500);
    check(!(await listening(RT)) && w.ledgerRecords().filter((r) => r.kind === "daemon").length === 0, "an MCP server restart starts nothing (its eager start is held)");
    const onb = await mcp2.call("agent_onboard", { project_dir: PROJ });
    check(/c64re up/.test(onb), "agent_onboard's runtime probe reports the hold, with the way out", onb.split("\n").filter((l) => /shut down|c64re up/.test(l)).join(" | ").slice(0, 300));
    const onboard = await mcp2.call("runtime_session_status", { session_id: "shared" });
    check(/C64RE is shut down/.test(onboard), "…and its first runtime call is held too");
    mcp2.stop();

    const vite = track(spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(VITE), "--strictPort", "--host", "127.0.0.1"], { cwd: join(ROOT, "ui"), env: w.env, stdio: ["ignore", "pipe", "pipe"] }));
    let viteOut = ""; vite.stdout.on("data", (d) => { viteOut += d; }); vite.stderr.on("data", (d) => { viteOut += d; });
    check(await until(() => listening(VITE), 60000), "the UI dev server comes up", viteOut.slice(-300));
    await until(() => w.ledgerRecords().some((r) => r.kind === "ui-dev"), 10000);
    await sleep(1500);
    check(!(await listening(RT)), "…and it starts no runtime (the hold stands)", viteOut.slice(-300));
    check(w.ledgerRecords().some((r) => r.kind === "ui-dev" && r.port === VITE), "…and it is in the ledger as ui-dev");

    // up
    const up = await w.cli(["up", "--project", PROJ]);
    check(up.code === 0 && /hold cleared/.test(up.out) && /started|already running/.test(up.out), "`c64re up` starts the daemon and clears the hold", up.out + up.err.slice(0, 200));
    check(await listening(RT) && !w.holdExists(), "…the daemon answers and the hold file is gone");
    const upRec = w.ledgerRecords().find((r) => r.kind === "daemon" && r.port === RT);
    check(!!upRec && upRec.startedBy === "cli", "…recorded as started by cli", JSON.stringify(upRec));

    // the selection of a C64U clears a hold too
    const down2 = await w.cli(["down"]);
    check(down2.code === 0 && w.holdExists() && !(await listening(VITE)) && !(await listening(RT)), "a second `down` ends the dev server and the daemon", down2.out.slice(0, 600));
    const sel2 = await (async () => { const m = startMcp({ root: ROOT, env: { ...w.env } }); await m.call("agent_onboard", { project_dir: PROJ }); const r = await m.call("runtime_backend", { action: "select", backend: "c64u", host: `127.0.0.1:${sim.restPort}` }); return { m, r }; })();
    check(/Selected: C64 Ultimate/.test(sel2.r) && !w.holdExists(), "selecting a C64 Ultimate clears the hold", sel2.r.slice(0, 200));
    sel2.m.stop();
    const ses = startMcp({ root: ROOT, env: { ...w.env } });
    await ses.call("agent_onboard", { project_dir: PROJ });
    await w.cli(["down"]);
    const held = await ses.call("runtime_session_status", { session_id: "shared" });
    check(/C64RE is shut down/.test(held) && w.holdExists(), "(down again: held)");
    const started = await ses.call("runtime_session_start", { project_dir: PROJ });
    check(!w.holdExists() && await until(() => listening(RT), 40000), "runtime_session_start is an explicit start: it clears the hold and starts the daemon", started.slice(0, 250));
    ses.stop();
    const fin = await w.cli(["down"]);
    check(fin.code === 0 && !(await listening(RT)), "the last `down` leaves nothing", fin.out.slice(0, 300));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    try { await sandbox?.close(); } catch { /* */ }
    try { mcp?.stop(); } catch { /* */ }
    await sweep(w);
    await w.cli(["down"]).catch(() => undefined);
    await sim.close().catch(() => undefined);
  }
}

try {
  await acceptance("the stand-in runtime", STUB);
  // the Windows order (ask through each process's own channel, wait, then stop) on this machine too
  if (!IS_WIN) await acceptance("the stand-in runtime, in the Windows order", STUB, { C64RE_DOWN_ASK_FIRST: "1" });
  if (REAL) await acceptance(`the real runtime (${REAL})`, REAL);
  if (REAL && !IS_WIN) await acceptance("the real runtime, in the Windows order", REAL, { C64RE_DOWN_ASK_FIRST: "1" });
  if (!REAL) console.log("\n  (no trx64-daemon binary — the real-runtime half of A/B is skipped; the stand-in ran the same acceptance)");

  // ═══ C ═══ a foreign process on the runtime port
  head("C  a foreign process on the runtime port");
  {
    const RT = await freePort();
    const w = world("foreign", { env: { C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${RT}`, C64RE_UI_PORTS: `${await freePort()}` } });
    const foreign = track(spawn(process.execPath, ["-e", `require('net').createServer().listen(${RT}, '127.0.0.1'); setInterval(()=>{}, 1000)`], { stdio: "ignore" }));
    check(await until(() => listening(RT), 5000), "a foreign process listens on the runtime port");
    const d = await w.cli(["down"]);
    check(d.code === 1, "`down` exits non-zero", `${d.code}`);
    check(alive(foreign.pid), "the foreign process survived");
    check(new RegExp(`FOREIGN .*pid ${foreign.pid}.*listens on :${RT}`).test(d.out) && /not started by C64RE, not touched/.test(d.out), "…and is named in the report with its pid and port", d.out);
    check(/LEFT: 1 thing/.test(d.out), "the report counts what is left");
    foreign.kill("SIGKILL");
  }

  // ═══ D ═══ a stale record: the pid belongs to something else
  head("D  a record whose pid now belongs to a different command");
  {
    const w = world("stale", { env: { C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${await freePort()}`, C64RE_UI_PORTS: `${await freePort()}` } });
    const other = track(spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" }));
    const info = await platformProc.info(other.pid);
    mkdirSync(join(w.state, "processes"), { recursive: true });
    const base = { v: 1, kind: "daemon", port: 59999, startedBy: "mcp", startedAt: new Date().toISOString() };
    writeFileSync(join(w.state, "processes", `${other.pid}.json`), JSON.stringify({ ...base, pid: other.pid, start: info.start, command: "trx64-daemon --port 59999 (a command it never had)" }));
    // …and a record of a pid that is gone
    const gone = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((r) => gone.once("exit", r));
    writeFileSync(join(w.state, "processes", `${gone.pid}.json`), JSON.stringify({ ...base, pid: gone.pid, start: "Thu Jan  1 00:00:00 1970", command: "gone" }));
    const d = await w.cli(["down"]);
    check(alive(other.pid), "the process the pid now belongs to was NOT signalled", d.out);
    check(/dropped .*now belongs to a different command; not signalled/.test(d.out), "…it is dropped as stale, and the report says why", d.out);
    check(/gone .*had already ended/.test(d.out), "a record whose pid is gone is removed");
    check(w.ledgerRecords().length === 0, "both records are removed from the ledger");
    check(d.code === 0, "…and that is not a failure", `${d.code}`);
    other.kill("SIGKILL");
  }

  // ═══ E/F ═══ ending a runtime that cannot be asked, and the grace
  const runtimeMode = async (title, mode, extra, expect) => {
    const RT = await freePort();
    const w = world(title, { mode, env: { C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${RT}`, C64RE_UI_PORTS: `${await freePort()}`, C64RE_PROJECT_DIR: PROJ, ...extra } });
    const up = await w.cli(["up", "--project", PROJ]);
    if (up.code !== 0) { check(false, `${title}: up`, up.out + up.err); return; }
    const rec = w.ledgerRecords().find((r) => r.kind === "daemon");
    const t0 = Date.now();
    const d = await w.cli(["down", "--json"]);
    let rep; try { rep = JSON.parse(d.out); } catch { rep = undefined; }
    const line = rep?.lines?.find((l) => l.kind === "daemon");
    await expect({ d, rep, line, rec, RT, ms: Date.now() - t0, w });
    if (rec && alive(rec.pid)) { try { process.kill(rec.pid, "SIGKILL"); } catch { /* */ } }
  };

  head("E  a runtime from before daemon/shutdown");
  await runtimeMode("old runtime", "old", {}, async ({ d, line, rec, RT }) => {
    check(d.code === 0 && !!line && !alive(rec.pid) && !(await listening(RT)), "it is ended anyway", d.out.slice(0, 400));
    check(IS_WIN ? line.how === "forced" : line.how === "term", `…by ${IS_WIN ? "the hard stop after the ask was refused" : "SIGTERM"}, and the report says so`, line?.detail);
  });
  if (!IS_WIN) {
    await runtimeMode("old runtime, asked first", "old", { C64RE_DOWN_ASK_FIRST: "1", C64RE_DOWN_GRACE_MS: "800" }, async ({ d, line, rec, RT }) => {
      check(d.code === 0 && line?.how === "forced" && !alive(rec.pid), "in the Windows order (ask, wait, hard stop) it is ended after the grace", d.out.slice(0, 400));
      check(/no daemon\/shutdown/.test(line?.detail ?? ""), "…and the report says the runtime has no daemon/shutdown", line?.detail);
    });
  }
  await runtimeMode("runtime with daemon/shutdown", "normal", { C64RE_DOWN_ASK_FIRST: "1" }, async ({ d, line, rec, RT }) => {
    check(d.code === 0 && line?.how === "asked" && !alive(rec.pid), "asked first, a runtime that answers ends itself, with no hard stop", d.out.slice(0, 400));
    check(/persisted: cartridge none, disks none/.test(line?.detail ?? ""), "…and the report carries what the runtime says it wrote back", line?.detail);
  });

  head("F  the grace: a hard stop only after it");
  await runtimeMode("stubborn, asked first", "stubborn", { C64RE_DOWN_ASK_FIRST: "1", C64RE_DOWN_GRACE_MS: "1500" }, async ({ d, line, rec, RT }) => {
    check(d.code === 0 && line?.how === "forced" && !alive(rec.pid), "a runtime that accepts the request and does not end is stopped hard", d.out.slice(0, 400));
    check(line?.ms >= 1500, "…not before the grace was over", `${line?.ms} ms`);
  });
  if (!IS_WIN) {
    await runtimeMode("stubborn, signalled", "stubborn", { C64RE_DOWN_GRACE_MS: "1500" }, async ({ d, line, rec }) => {
      check(d.code === 0 && line?.how === "forced" && !alive(rec.pid) && line.ms >= 1500, "SIGTERM first, SIGKILL only after the grace", `${line?.how} ${line?.ms}`);
    });
  }
  check(graceMs({}) === 5000 && graceMs({ C64RE_DOWN_GRACE_MS: "250" }) === 250, "the default grace is 5 s");

  // the Windows order, walked through the layer's own fakes on this machine
  {
    const clock = { t: 0 };
    const calls = [];
    const aliveSet = new Set([501]);
    const mk = (platform, onExec) => new PlatformProc(
      platform,
      async (file, args) => { calls.push([file, ...args].join(" ")); return onExec ? onExec(file, args) : { stdout: "", code: 0 }; },
      () => clock.t, async (ms) => { clock.t += ms; },
      (pid, sig) => { if (sig === 0 && !aliveSet.has(pid)) { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; } if (sig === "SIGKILL") aliveSet.delete(pid); },
      false,
    );
    const win = mk("win32", (file, args) => { if (file === "taskkill") aliveSet.delete(501); return { stdout: "", code: 0 }; });
    let asked = false;
    const r = await win.end(501, { graceMs: 5000, ask: async () => { asked = true; return true; } });
    check(asked && r.how === "forced" && r.ms >= 5000, "Windows layer: asks first, waits the full grace, then stops hard", `${JSON.stringify(r)} ${calls.join(" | ")}`);
    check(calls.length === 1 && calls[0] === "taskkill /PID 501 /T /F", "…with `taskkill /PID <pid> /T /F` (the tree, forced) and nothing else", calls.join(" | "));
    aliveSet.add(502); calls.length = 0; clock.t = 0;
    const r2 = await win.end(502, { graceMs: 5000, ask: async () => { setTimeout(() => {}, 0); aliveSet.delete(502); return true; } });
    check(r2.how === "asked" && calls.length === 0, "Windows layer: a process that ends when asked is never taken with taskkill", `${JSON.stringify(r2)} ${calls.join("|")}`);
    aliveSet.add(503); clock.t = 0; calls.length = 0;
    const sigs = [];
    const posix2 = new PlatformProc("linux", async () => ({ stdout: "", code: 0 }), () => clock.t, async (ms) => { clock.t += ms; },
      (pid, sig) => { if (sig !== 0) sigs.push(sig); if (sig === 0 && !aliveSet.has(pid)) { const e = new Error("x"); e.code = "ESRCH"; throw e; } if (sig === "SIGKILL") aliveSet.delete(pid); }, false);
    const r3 = await posix2.end(503, { graceMs: 5000, ask: async () => { throw new Error("POSIX does not ask"); } });
    check(r3.how === "forced" && sigs.join(",") === "SIGTERM,SIGKILL" && r3.ms >= 5000, "POSIX layer: SIGTERM, the grace, SIGKILL — and it does not ask", `${JSON.stringify(r3)} ${sigs}`);
  }

  // ═══ G ═══ partial downs
  head("G  --project and --keep");
  {
    const RT1 = await freePort(), RT2 = await freePort();
    const base = { C64RE_UI_PORTS: `${await freePort()}` };
    const w = world("partial", { env: { ...base, C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${RT1}`, C64RE_PROJECT_DIR: PROJ } });
    const u1 = await w.cli(["up", "--project", PROJ]);
    const u2 = await w.cli(["up", "--project", PROJ2], { C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${RT2}`, C64RE_PROJECT_DIR: PROJ2 });
    check(u1.code === 0 && u2.code === 0 && await listening(RT1) && await listening(RT2), "two daemons, two projects", u1.out + u2.out + u1.err + u2.err);
    const only = await w.cli(["down", "--project", PROJ]);
    check(only.code === 0 && !(await listening(RT1)) && await listening(RT2), "`down --project A` ends A's daemon and leaves B's", only.out);
    check(!w.holdExists(), "…and writes no hold");
    const keep = await w.cli(["down", "--keep", "daemon"]);
    check(keep.code === 0 && await listening(RT2) && /kept .*daemon/.test(keep.out) && !w.holdExists(), "`down --keep daemon` leaves the daemon running and writes no hold", keep.out);
    const bad = await w.cli(["down", "--keep", "everything"]);
    check(bad.code === 1 && /not one of/.test(bad.err), "an unknown --keep is refused", bad.err);
    const rest = await w.cli(["down"]);
    check(rest.code === 0 && !(await listening(RT2)), "a full `down` ends the rest", rest.out);
  }

  // ═══ H ═══ the UI's shutdown request, and a bridge's daemon/shutdown
  head("H  the shutdown requests are local");
  {
    const HTTP = await freePort();
    const w = world("ui-request", { env: { C64RE_RUNTIME_AUTOSTART: "0", C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${await freePort()}` } });
    const srv = track(spawn(process.execPath, [join(ROOT, "dist/workspace-ui/server.js"), "--port", String(HTTP), "--project", PROJ, "--api-only"], { env: { ...w.env, C64RE_STARTED_BY: "cli" }, stdio: "ignore" }));
    check(await until(async () => (await httpGet(HTTP, "/api/health")) === 200, 20000), "a workspace server on a free port");
    check((await httpGet(HTTP, "/api/shutdown")) === 403, "GET /api/shutdown is refused");
    check((await rawPost(HTTP, "/api/shutdown", { "content-length": "0" })) === 403, "POST without the shutdown header is refused");
    check((await rawPost(HTTP, "/api/shutdown", { "x-c64re-shutdown": "1", host: "evil.example", "content-length": "0" })) === 403, "POST naming a foreign Host is refused (DNS rebinding)");
    check((await rawPost(HTTP, "/api/shutdown", { "x-c64re-shutdown": "1", origin: "http://evil.example", "content-length": "0" })) === 403, "POST from a foreign Origin is refused");
    check(alive(srv.pid), "…and the server is still running after all four");
    check((await rawPost(HTTP, "/api/shutdown", { "x-c64re-shutdown": "1", "content-length": "0" })) === 200, "a local POST with the header is accepted");
    check(await until(() => !alive(srv.pid), 5000), "…and the server ends, its record with it", `${w.ledgerRecords().length} records`);
    check(w.ledgerRecords().length === 0, "the record of a server that ended itself is gone");

    const sim = await startFakeUltimate({ capabilities: "object" });
    const BP = await freePort();
    const bridge = track(spawn(process.execPath, [join(ROOT, "dist/cli.js"), "c64u-bridge", "--device", `127.0.0.1:${sim.restPort}`, "--port", String(BP), "--project", PROJ], { env: { ...w.env, C64RE_STARTED_BY: "cli" }, stdio: ["ignore", "pipe", "pipe"] }));
    check(await until(() => listening(BP), 20000), "a bridge on a free port (by hand: no idle exit)");
    await until(() => w.ledgerRecords().some((r) => r.kind === "bridge"), 10000);
    const { wsShutdown } = await dist("runtime/process-end.js");
    const a = await wsShutdown(BP);
    check(a.accepted && a.persisted && a.persisted.cartridge === null && a.persisted.disks.length === 0 && a.trace === null, "the bridge answers daemon/shutdown in the runtime's shape", JSON.stringify(a));
    check(await until(() => !alive(bridge.pid), 8000) && !(await listening(BP)), "…and the bridge process ends");
    check(await until(() => w.ledgerRecords().length === 0, 3000), "…and its record is gone");
    await sim.close();
  }

  // ═══ I ═══ no console window, and what Windows prints
  head("I  no console window; the parsers read what the OS prints");
  {
    const lay = readFileSync(join(ROOT, "src/runtime/platform-proc.ts"), "utf8");
    check(/detached: true, windowsHide: true, shell: false/.test(lay) && /\.\.\.opts, windowsHide: true, shell: false/.test(lay), "spawnDetached / spawnHidden set windowsHide and never a shell");
    const offenders = [];
    const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); if (n.isDirectory()) walk(f); else if (/\.ts$/.test(n.name)) scan(f); } };
    const scan = (f) => {
      if (f.endsWith("platform-proc.ts")) return;
      const t = readFileSync(f, "utf8");
      for (const m of t.matchAll(/(^|[^\w.])spawn\(/g)) {
        const around = t.slice(m.index, m.index + 600);
        if (!/windowsHide:\s*true/.test(around)) offenders.push(`${f.slice(ROOT.length + 1)}:${t.slice(0, m.index).split("\n").length}`);
      }
      if (/shell:\s*true/.test(t) && !f.endsWith("project-knowledge/service.ts")) offenders.push(`${f.slice(ROOT.length + 1)} uses shell: true`);
    };
    walk(join(ROOT, "src"));
    scan(join(ROOT, "ui/vite.config.ts"));
    check(offenders.length === 0, "every spawn() under src/ and the vite plugin is hidden on Windows, none through a shell", offenders.join(", "));
    const procs = parsePosixPs("  101 Sat Oct 10 12:00:00 2026 /usr/bin/node /x/dist/cli.js ui --project /p\n 7 Tue Oct  6 03:04:05 2026 trx64-daemon --port 4312\n");
    check(procs.get(101)?.start === "Sat Oct 10 12:00:00 2026" && procs.get(101).command === "/usr/bin/node /x/dist/cli.js ui --project /p" && procs.get(7).start === "Tue Oct  6 03:04:05 2026", "ps -o lstart,command is read into start time and command line");
    const wp = parseWindowsProcs('[{"pid":1234,"start":"2026-10-10T10:00:00.1234567Z","cmd":"\\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" C:\\\\c64re\\\\dist\\\\cli.js ui"},{"pid":9,"start":"2026-10-10T10:00:01Z","cmd":null}]');
    check(wp.get(1234)?.command === '"C:\\Program Files\\nodejs\\node.exe" C:\\c64re\\dist\\cli.js ui' && wp.get(9)?.command === "" && parseWindowsProcs('{"pid":5,"start":"s","cmd":"c"}').get(5)?.command === "c" && parseWindowsProcs("").size === 0, "Get-CimInstance Win32_Process JSON (one, many, none, no command line)");
    check(parseLsof("p100\ncnode\nn127.0.0.1:4312\nn*:4310\np200\ncx\nn[::1]:5000\n").map((l) => `${l.pid}:${l.port}`).join(",") === "100:4312,100:4310,200:5000", "lsof -F output");
    check(parseSs('LISTEN 0 511 127.0.0.1:4312 0.0.0.0:* users:(("node",pid=77,fd=19))\n').map((l) => `${l.pid}:${l.port}`).join() === "77:4312", "ss -ltnp output");
    check(parseNetTcp('[{"LocalAddress":"127.0.0.1","LocalPort":4312,"OwningProcess":88},{"LocalAddress":"::","LocalPort":4310,"OwningProcess":99}]').map((l) => `${l.pid}:${l.port}`).join() === "88:4312,99:4310" && parseNetTcp('{"LocalAddress":"::","LocalPort":1,"OwningProcess":2}').length === 1, "Get-NetTCPConnection JSON");
    check(parseNetstat("  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:4312         0.0.0.0:0              LISTENING       1234\r\n  TCP    [::]:4310              [::]:0                 LISTENING       5678\r\n  TCP    10.0.0.2:5555          1.2.3.4:443            ESTABLISHED     9\r\n").map((l) => `${l.pid}:${l.port}`).join() === "1234:4312,5678:4310", "netstat -ano output (the fallback)");
    const fallback = new PlatformProc("win32", async (file) => (file === "powershell.exe" ? { stdout: "", code: 1 } : { stdout: "  TCP    127.0.0.1:4312   0.0.0.0:0   LISTENING   42\r\n", code: 0 }));
    check((await fallback.listeners()).map((l) => l.pid).join() === "42", "Windows listeners fall back to netstat when PowerShell has no answer");
    const cmds = [];
    const winInfo = new PlatformProc("win32", async (file, args) => { cmds.push([file, ...args]); return { stdout: '{"pid":5,"start":"s","cmd":"c"}', code: 0 }; });
    await winInfo.info(5);
    check(cmds[0][0] === "powershell.exe" && cmds[0].includes("-NoProfile") && /Get-CimInstance Win32_Process/.test(cmds[0].join(" ")) && !/wmic/i.test(cmds.join(" ")), "Windows identity is Get-CimInstance through `powershell.exe -NoProfile` (no wmic)");
    check((await new PlatformProc("win32", async () => ({ stdout: "", code: 0 })).info(5)) === undefined, "a pid the OS cannot read is not ours");
    const me = await platformProc.info(process.pid);
    check(!!me && me.command.includes("e2e-902-down") && !!me.start, "the real layer reads this very process: start time, and a command line that names this script", JSON.stringify(me));
    const mine = await platformProc.listeners();
    check(Array.isArray(mine), "the real layer lists listeners");
  }
} finally {
  for (const p of reaper) { try { p.kill("SIGKILL"); } catch { /* */ } }
  for (const pid of reapPids) { try { process.kill(pid, "SIGKILL"); } catch { /* */ } }
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${failCount === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
