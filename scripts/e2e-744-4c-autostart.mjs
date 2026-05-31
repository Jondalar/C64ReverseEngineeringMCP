// Spec 744.4c — the human never starts the backend by hand. When C64RE_RUNTIME_ENDPOINT
// is set but no daemon is up, the MCP AUTO-STARTS it (detached). The daemon outlives
// the MCP process, so an MCP reconnect attaches to the same running runtime.
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const DISK = join(ROOT, "samples/synthetic/1byte.g64");
const PORT = 14746;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = () => new Promise((res) => { const w = new WebSocket(ENDPOINT); const t = setTimeout(() => { w.terminate(); res(false); }, 1500); w.once("open", () => { clearTimeout(t); w.close(); res(true); }); w.once("error", () => { clearTimeout(t); res(false); }); });
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} | xargs kill -9`, { stdio: "ignore" }); } catch { /* none */ } };

console.log("Spec 744.4c — MCP auto-starts the Runtime Daemon (no manual backend)\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }
killPort(); // ensure clean

const procs = [];
function spawnMcp() {
  const proc = spawn(process.execPath, [cli], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT, C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_ENDPOINT: ENDPOINT }, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(proc);
  let buf = ""; const pending = new Map(); let nextId = 1;
  proc.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  const rpc = (method, params, t = 60000) => new Promise((res, rej) => { const id = nextId++; const timer = setTimeout(() => { pending.delete(id); rej(new Error(`mcp timeout ${method}`)); }, t); pending.set(id, (m) => { clearTimeout(timer); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.result; };
  const text = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { proc, rpc, call, text, kill: () => { try { proc.stdin.end(); proc.kill(); } catch {} } };
}
async function ready(m) { await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "autostart", version: "1" } }); m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }

let exit = 0;
try {
  ok(!(await portOpen()), "0 no daemon running on the endpoint at start");

  // MCP #1 — no daemon up; runtime_session_start must auto-start it.
  const mcp1 = spawnMcp();
  await ready(mcp1);
  const start = mcp1.text(await mcp1.call("runtime_session_start", { disk_path: DISK, write_protected: true }));
  const S = (start.match(/Session:\s*(\S+)/) || [])[1];
  ok(!!S && /Runtime Daemon/.test(start), "1 MCP auto-started the daemon + created a session (no manual backend)", S);
  ok(await portOpen(), "2 the daemon is now listening on the endpoint");

  // Kill the MCP — the detached daemon must SURVIVE.
  mcp1.kill();
  await sleep(800);
  ok(await portOpen(), "3 daemon SURVIVES the MCP exit (detached — not tied to MCP lifetime)");

  // A reconnecting MCP attaches to the SAME running daemon/session.
  const mcp2 = spawnMcp();
  await ready(mcp2);
  const st = mcp2.text(await mcp2.call("runtime_session_status", { session_id: S }));
  ok(/cycles=\d+/.test(st), "4 reconnecting MCP attaches to the SAME daemon + sees the session", S);
  await mcp2.call("runtime_session_close", { session_id: S });
  mcp2.kill();
} catch (e) {
  console.error("FATAL", e.message); exit = 2;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  await sleep(200);
  killPort(); // the detached daemon
}

console.log(`\nSpec 744.4c autostart: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
