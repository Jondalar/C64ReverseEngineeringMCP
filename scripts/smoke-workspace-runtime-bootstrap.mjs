// BUG-010 — `npm run workspace` must bring up BOTH backends for one project:
// the HTTP/UI server AND the Headless Runtime WS server, with a live session the
// Live tab can connect to. This boots the workspace bootstrap (scripts/
// workspace.mjs) against a temp project, then proves:
//   - HTTP /api/config is up and reports the runtime WS URL,
//   - /api/runtime-status says the runtime backend is reachable,
//   - the WS server has a session (session/list non-empty),
//   - that session advances (session/state cycle > 0 → frame-ready path).
// Also proves the negative: HTTP alone → /api/runtime-status reachable=false +
// an actionable hint (so the Live tab can show why, not spin on "connecting").
//
// No emulator-fidelity assertion, no VICE.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-010 — workspace bootstrap starts HTTP + runtime WS for one project\n");

const HTTP_PORT = 4318; // off the defaults to avoid clashing with a running UI
const WS_PORT = 4312;   // the runtime WS default the UI connects to
const projectDir = mkdtempSync(join(tmpdir(), "c64re-bug010-"));

function tcpUp(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => { clearTimeout(t); done(true); });
    s.once("error", () => { clearTimeout(t); done(false); });
  });
}
async function waitTcp(port, ms = 40000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await tcpUp(port)) return true; await new Promise((r) => setTimeout(r, 300)); }
  return false;
}
async function getJson(path) {
  const r = await fetch(`http://127.0.0.1:${HTTP_PORT}${path}`);
  return { status: r.status, body: await r.json() };
}
function wsCall(method, params, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`ws timeout ${method}`)); }, timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    ws.on("message", (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.id === id) { clearTimeout(timer); ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// make sure no stale WS owns the port.
const staleWs = await tcpUp(WS_PORT);
if (staleWs) { console.log(`  (port ${WS_PORT} already in use — a stale runtime backend is running; this smoke needs it free)`); }

const child = spawn("node", [join(ROOT, "scripts/workspace.mjs"), "--project", projectDir, "--port", String(HTTP_PORT)], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (b) => { log += b.toString(); });
child.stderr.on("data", (b) => { log += b.toString(); });

let exitCode = 0;
try {
  const httpUp = await waitTcp(HTTP_PORT);
  ok(httpUp, "1 workspace bootstrap brought up the HTTP server", httpUp ? `:${HTTP_PORT}` : log.slice(-300));
  const wsUp = await waitTcp(WS_PORT);
  ok(wsUp, "2 workspace bootstrap brought up the runtime WS server", wsUp ? `:${WS_PORT}` : log.slice(-300));
  if (!httpUp || !wsUp) throw new Error("backends did not both start");

  const cfg = await getJson("/api/config");
  ok(cfg.status === 200 && cfg.body.runtimeWsUrl === `ws://127.0.0.1:${WS_PORT}`, "3 /api/config reports the runtime WS url", cfg.body.runtimeWsUrl);

  const rs = await getJson("/api/runtime-status");
  ok(rs.status === 200 && rs.body.reachable === true, "4 /api/runtime-status: runtime backend reachable", `reachable=${rs.body.reachable}`);

  const sessions = await wsCall("session/list", {});
  ok(Array.isArray(sessions) && sessions.length > 0, "5 runtime WS has a live session (Live tab can connect)", `sessions=${sessions.length}`);
  const sid = sessions[0]?.sessionId;
  ok(!!sid && sid !== "(none)", "5b session id is real (not (none))", sid);

  const st = await wsCall("session/state", { session_id: sid });
  ok((st?.c64Cycles ?? 0) > 0, "6 session has advanced (cycle > 0 → frame-ready path)", `cycle=${st?.c64Cycles}`);

  console.log(`\n--- report ---`);
  console.log(`project: ${projectDir}`);
  console.log(`one command (npm run workspace) → HTTP :${HTTP_PORT} + runtime WS :${WS_PORT} + session ${sid} (cycle ${st?.c64Cycles}).`);
  console.log(`Live tab connects to a real session; if the WS is down /api/runtime-status returns an actionable hint.`);
} catch (e) {
  ok(false, "harness", e.message + (log ? " | log: " + log.slice(-300) : ""));
  exitCode = 1;
} finally {
  try { child.kill("SIGINT"); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  try { child.kill("SIGKILL"); } catch {}
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} BUG-010 workspace runtime bootstrap: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : (exitCode || 1));
