// Spec 744.4c — Runtime Daemon acceptance (docs/runtime-daemon-solution-design.md §84-97).
// Proves the product topology: ONE stable daemon owns the runtime; the LLM (MCP) and
// the human (UI WS) are BOTH clients of it, share the same session, and neither an
// MCP reconnect nor a browser reload resets the runtime.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const daemonScript = join(ROOT, "scripts/runtime-daemon.mjs");
const DISK = join(ROOT, "samples/synthetic/1byte.g64");
const PORT = 14744;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("Spec 744.4c — Runtime Daemon: MCP + UI are clients of ONE stable runtime\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }

const procs = [];
function spawnMcp() {
  const proc = spawn(process.execPath, [cli], {
    cwd: ROOT,
    env: { ...process.env, C64RE_PROJECT_DIR: ROOT, C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_ENDPOINT: ENDPOINT },
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  let buf = ""; const pending = new Map(); let nextId = 1; let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  proc.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  const rpc = (method, params, t = 30000) => new Promise((res, rej) => { const id = nextId++; const timer = setTimeout(() => { pending.delete(id); rej(new Error(`mcp timeout ${method}`)); }, t); pending.set(id, (m) => { clearTimeout(timer); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.result; };
  const text = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { proc, rpc, call, text, stderr: () => stderr, kill: () => { try { proc.stdin.end(); proc.kill(); } catch {} } };
}
async function mcpReady(m) { await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-744-4c", version: "1" } }); m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }
const cyc = (t) => { const m = t.match(/cycles=(\d+)/); return m ? Number(m[1]) : NaN; };

async function wsConnect() { for (let i = 0; i < 60; i++) { try { const ws = new WebSocket(ENDPOINT); await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); }); return ws; } catch { await sleep(150); } } throw new Error("ws connect failed"); }
function wsRpc(ws, method, params, id) { return new Promise((res, rej) => { const timer = setTimeout(() => rej(new Error(`ws timeout ${method}`)), 15000); const onMsg = (data, isBin) => { if (isBin) return; let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id === id) { clearTimeout(timer); ws.off("message", onMsg); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; ws.on("message", onMsg); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }); }

// ---- spawn the daemon ----
const daemon = spawn(process.execPath, [daemonScript, "--project", ROOT, "--port", String(PORT)], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT }, stdio: ["ignore", "pipe", "pipe"] });
let dlog = ""; daemon.stdout.on("data", (d) => { dlog += d.toString(); }); daemon.stderr.on("data", (d) => { dlog += d.toString(); });

let exit = 0; let wsId = 1;
try {
  for (let i = 0; i < 120 && !/runtime authority ready/.test(dlog); i++) await sleep(250);
  ok(/runtime authority ready/.test(dlog), "1+ Runtime Daemon started + authority ready", (dlog.match(/endpoint[^\n]*/) || [""])[0]);

  // ---- MCP client #1 ----
  const mcp1 = spawnMcp();
  await mcpReady(mcp1);
  const start = mcp1.text(await mcp1.call("runtime_session_start", { disk_path: DISK, write_protected: true }));
  const S = (start.match(/Session:\s*(\S+)/) || [])[1];
  ok(!!S && /Runtime Daemon/.test(start), "4 MCP creates a session IN THE DAEMON", S);

  // ---- UI sees the MCP session ----
  const ui = await wsConnect();
  const list = await wsRpc(ui, "session/list", {}, wsId++);
  const ids = (list || []).map((s) => s.sessionId);
  ok(ids.includes(S), "4 UI session/list shows the MCP-created session (MCP→UI)", ids.join(","));
  const uiState = await wsRpc(ui, "session/state", { session_id: S }, wsId++);
  const mcpCyc0 = cyc(mcp1.text(await mcp1.call("runtime_session_status", { session_id: S })));
  ok(uiState.c64Cycles === mcpCyc0, "4 UI + MCP read the SAME cycle counter (one machine)", `ui=${uiState.c64Cycles} mcp=${mcpCyc0}`);

  // ---- UI drives, MCP sees ----
  await wsRpc(ui, "debug/run", { session_id: S }, wsId++);
  await sleep(700);
  const mcpAfterRun = cyc(mcp1.text(await mcp1.call("runtime_session_status", { session_id: S })));
  ok(mcpAfterRun > mcpCyc0, "5 UI debug/run advanced the SAME session MCP reads (UI→MCP)", `${mcpCyc0} → ${mcpAfterRun}`);
  await wsRpc(ui, "debug/pause", { session_id: S }, wsId++);

  // ---- UI-side default session visible/controllable from MCP ----
  const defId = ids.find((x) => x !== S);
  ok(!!defId && /cycles=\d+/.test(mcp1.text(await mcp1.call("runtime_session_status", { session_id: defId }))),
    "6 MCP can status the UI-booted default session (UI→MCP)", defId || "none");

  // ---- MCP reconnect must NOT reset the session ----
  mcp1.kill();
  await sleep(400);
  const mcp2 = spawnMcp();
  await mcpReady(mcp2);
  const afterReconnect = mcp2.text(await mcp2.call("runtime_session_status", { session_id: S }));
  ok(/cycles=\d+/.test(afterReconnect) && cyc(afterReconnect) >= mcpAfterRun,
    "7 MCP reconnect (new MCP process) still sees the session — NOT reset", `cycles=${cyc(afterReconnect)}`);

  // ---- browser reload must NOT reset the session ----
  ui.close();
  await sleep(200);
  const ui2 = await wsConnect();
  const list2 = (await wsRpc(ui2, "session/list", {}, wsId++) || []).map((s) => s.sessionId);
  ok(list2.includes(S), "8 browser reload (new WS connection) still sees the session — NOT reset", list2.join(","));
  ui2.close();

  // ---- no product path creates IntegratedSession outside the daemon ----
  const headless = readFileSync(join(ROOT, "src/server-tools/headless.ts"), "utf8");
  const startHandler = headless.slice(headless.indexOf('"runtime_session_start"'), headless.indexOf('"runtime_session_run"'));
  const daemonBranchFirst = startHandler.indexOf("isDaemonMode()") < startHandler.indexOf("runtimeSessions.start(");
  ok(daemonBranchFirst, "9 runtime_session_start routes to the daemon BEFORE any in-process create (no private session)");

  await mcp2.call("runtime_session_close", { session_id: S });
  mcp2.kill();
} catch (e) {
  console.error("FATAL", e.message); console.error(dlog.slice(-800)); exit = 2;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { daemon.kill(); } catch {}
}

console.log(`\nSpec 744.4c: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
