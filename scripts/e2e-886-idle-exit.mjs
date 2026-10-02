// Spec 886 / TRX64 887 — the auto-started runtime ends itself when nobody uses it.
//
// All on a port of its own, never :4312. The window is 3 s instead of 600 so the run is
// short; the rule is the same.
//   1. a daemon with --idle-exit 3 and no client ends itself: exit 0, the line says so;
//   2. requests hold it; an open connection that sends nothing does NOT (the MCP keeps
//      one socket for its whole life, and an open Claude window must not hold a machine);
//   3. daemon/keep_alive {seconds} holds it past the window, {null} holds it for good;
//   4. through the MCP: the autostart arms the clock (status says "ends itself in …"), the
//      daemon ends, the next tool call starts a fresh one and its answer SAYS so, and
//      runtime_keep_alive forever is reported as kept alive.
// Needs a TRX64 daemon that carries Spec 887.
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }
const { resolveDaemonSpawn } = await import(join(ROOT, "dist/runtime/resolve-daemon-spawn.js"));

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.E2E_886_PORT || 4387);
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
const listener = () => { try { return Number(execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`).toString().trim().split("\n")[0]) || 0; } catch { return 0; } };
const killPort = () => { const p = listener(); if (p) try { process.kill(p, "SIGKILL"); } catch {} };
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(200); } return cond(); };

const proj = mkdtempSync(join(tmpdir(), "c64re-886-"));
const { ProjectKnowledgeService } = await import(join(ROOT, "dist/project-knowledge/service.js"));
new ProjectKnowledgeService(proj).initProject({ name: "886" });

const plan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: proj, port: String(PORT) });
if (plan.mode === "none") { console.log("FAIL  no TRX64 daemon found"); process.exit(1); }
const startDaemon = (idle) => {
  const d = spawn(plan.cmd, [...plan.args, "--headless", "--idle-exit", String(idle)], { stdio: ["ignore", "pipe", "pipe"] });
  d.log = ""; d.stdout.on("data", (b) => { d.log += b; }); d.stderr.on("data", (b) => { d.log += b; });
  d.exited = new Promise((res) => d.once("exit", (code) => res(code)));
  return d;
};
const connect = async () => {
  for (let i = 0; i < 100; i++) {
    try { return await new Promise((res, rej) => { const w = new WebSocket(ENDPOINT); w.once("open", () => res(w)); w.once("error", rej); }); } catch { await sleep(150); }
  }
  throw new Error("daemon never answered");
};
let rid = 1;
const rpc = (w, method, params = {}) => new Promise((res, rej) => {
  const id = rid++;
  const on = (data, bin) => { if (bin) return; const m = JSON.parse(data.toString()); if (m.id === id) { w.off("message", on); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  w.on("message", on);
  w.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
});
const alive = (d) => d.exitCode === null;

console.log("Spec 886 — the auto-started runtime ends itself when nobody uses it\n");
killPort();
try {
  // ── 1: nobody at all ──────────────────────────────────────────────────────────────
  {
    const d = startDaemon(3);
    await until(() => /idle exit armed: 3 s/.test(d.log), 15000);
    check(/idle exit armed: 3 s/.test(d.log), "1 --idle-exit 3 is armed and says so");
    const code = await Promise.race([d.exited, sleep(15000).then(() => "still running")]);
    check(code === 0 && /idle for 3 s — exiting/.test(d.log), "1b with nobody there it ends itself — exit 0, one line", `exit=${code}`);
  }

  // ── 2: requests hold it; a silent connection does not ────────────────────────────
  {
    const d = startDaemon(3);
    const w = await connect();
    for (let i = 0; i < 6; i++) { await rpc(w, "ping"); await sleep(1000); }
    check(alive(d), "2 a ping every second holds it past the 3 s window");
    const st = await rpc(w, "ping");
    check(st?.idleExit?.armedSeconds === 3 && typeof st.idleExit.deadlineMs === "number",
      "2b ping reports the clock: armed 3 s, a deadline", JSON.stringify(st?.idleExit));
    const code = await Promise.race([d.exited, sleep(10000).then(() => "still running")]);
    check(code === 0, "2c an open connection that sends nothing does not hold it", `exit=${code}`);
    try { w.terminate(); } catch {}
  }

  // ── 3: keep_alive ───────────────────────────────────────────────────────────────────
  {
    const d = startDaemon(3);
    const w = await connect();
    const k = await rpc(w, "daemon/keep_alive", { seconds: 8 });
    check(k?.armed === true && typeof k.keptAliveUntilMs === "number", "3 keep_alive {seconds: 8} is accepted", JSON.stringify(k));
    w.terminate();
    await sleep(5500);
    check(alive(d), "3b it holds past the 3 s window");
    const code = await Promise.race([d.exited, sleep(10000).then(() => "still running")]);
    check(code === 0, "3c and ends when the keep-alive runs out", `exit=${code}`);

    const d2 = startDaemon(3);
    const w2 = await connect();
    const k2 = await rpc(w2, "daemon/keep_alive", { seconds: null });
    check(k2?.keptForever === true && k2.deadlineMs === null, "3d keep_alive {seconds: null} = never on idle", JSON.stringify(k2));
    w2.terminate();
    await sleep(6000);
    check(alive(d2), "3e it is still there long after the window");
    d2.kill("SIGKILL"); await d2.exited;
  }

  // ── 4: through the MCP ──────────────────────────────────────────────────────────────
  {
    const mcp = spawn(process.execPath, [cli], {
      cwd: tmpdir(),
      env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_ENDPOINT: ENDPOINT, C64RE_RUNTIME_AUTOSTART: "1", C64RE_RUNTIME_IDLE_EXIT: "3", C64RE_FULL_TOOLS: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = ""; const pend = new Map(); let n = 1;
    mcp.stdout.on("data", (b) => { buf += b; let nl; while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); let m; try { m = JSON.parse(l); } catch { continue; } if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
    const call = (method, params) => new Promise((res) => { const id = n++; pend.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
    const tool = async (name, args) => ((await call("tools/call", { name, arguments: args })).result?.content ?? []).map((c) => c.text).join("\n");
    try {
      await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-886", version: "1" } });
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      await tool("agent_onboard", { project_dir: proj });
      const s1 = await tool("runtime_session_status", { session_id: "shared" });
      check(/Idle exit: ends itself in 1 min if nothing happens/.test(s1), "4 the auto-started runtime reports its idle exit", (/Idle exit:[^\n]*/.exec(s1) ?? [s1.slice(0, 160)])[0]);
      const first = listener();
      const gone = await until(() => listener() === 0, 15000);
      check(gone, "4b with the MCP quiet (its socket open, nothing sent) the runtime ends itself");
      const s2 = await tool("runtime_session_status", { session_id: "shared" });
      check(/^NOTE: the runtime had ended/.test(s2) && listener() > 0 && listener() !== first,
        "4c the next call starts a fresh runtime, and its answer says so first", s2.split("\n")[0].slice(0, 120));
      const s3 = await tool("runtime_session_status", { session_id: "shared" });
      check(!/^NOTE:/.test(s3), "4d …once, not on every answer after it");
      const k = await tool("runtime_keep_alive", { forever: true });
      check(/kept alive — it does not end on its own/.test(k), "4e runtime_keep_alive forever is reported as kept alive", k.slice(0, 120));
      await sleep(6000);
      check(listener() > 0, "4f and it is still there after the window");
    } finally {
      mcp.stdin.end(); mcp.kill();
    }
  }
} catch (e) {
  check(false, "harness", e.message);
} finally {
  killPort();
  rmSync(proj, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} e2e-886 idle exit: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
