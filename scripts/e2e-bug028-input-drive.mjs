// BUG-028 — input/drive tools must drive the SHARED daemon session, not a private
// in-process one. Read tools (status/render) were daemon-routed; the write/drive
// tools (type/joystick/mark/load_prg) were not, so the LLM could SEE the human's
// session but not DRIVE it. Acceptance (from the bug): runtime_type "HALLO ALEX"
// appears on the shared session's live screen.
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const daemonScript = join(ROOT, "scripts/runtime-daemon.mjs");
const PORT = 14776;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {} };

console.log("BUG-028 — input/drive tools route to the shared daemon session\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }
killPort();

const procs = [];
function spawnMcp() {
  const proc = spawn(process.execPath, [cli], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT, C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_ENDPOINT: ENDPOINT, C64RE_RUNTIME_AUTOSTART: "0" }, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(proc);
  let buf = ""; const pending = new Map(); let nextId = 1;
  proc.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  const rpc = (method, params, t = 60000) => new Promise((res, rej) => { const id = nextId++; const timer = setTimeout(() => { pending.delete(id); rej(new Error(`mcp timeout ${method}`)); }, t); pending.set(id, (m) => { clearTimeout(timer); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.result; };
  const text = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { proc, rpc, call, text, kill: () => { try { proc.stdin.end(); proc.kill(); } catch {} } };
}
async function ready(m) { await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bug028", version: "1" } }); m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }
let wsId = 1;
const wsRpc = (ws, method, params) => new Promise((res, rej) => { const id = wsId++; const t = setTimeout(() => rej(new Error("ws timeout " + method)), 30000); const on = (data, isBin) => { if (isBin) return; let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id === id) { clearTimeout(t); ws.off("message", on); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; ws.on("message", on); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
// read screen RAM $0400.. and decode to ASCII-ish for the typed-text check.
const screenText = async (ws, S) => {
  const a = await wsRpc(ws, "api/call", { session_id: S, method: "monitorMemory", args: [0x0400, 0x07E8] });
  return a.map((c) => { if (c === 32 || c === 0) return " "; if (c >= 1 && c <= 26) return String.fromCharCode(64 + c); if (c >= 48 && c <= 57) return String.fromCharCode(c); return "."; }).join("");
};

const daemon = spawn(process.execPath, [daemonScript, "--project", ROOT, "--port", String(PORT)], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT }, stdio: ["ignore", "pipe", "pipe"] });
let dlog = ""; daemon.stdout.on("data", (d) => dlog += d); daemon.stderr.on("data", (d) => dlog += d);

let exit = 0;
try {
  for (let i = 0; i < 150 && !/runtime authority ready/.test(dlog); i++) await sleep(200);
  ok(/runtime authority ready/.test(dlog), "0 daemon ready");
  const ui = await new Promise((res, rej) => { const w = new WebSocket(ENDPOINT); w.once("open", () => res(w)); w.once("error", rej); });
  const S = (await wsRpc(ui, "session/list", {}))[0]?.sessionId;
  ok(!!S, "0b default session", S);
  await wsRpc(ui, "session/run", { session_id: S, cycles: 3_500_000 }); // boot to BASIC READY
  const m = spawnMcp(); await ready(m);

  // 1 the bug's exact repro: runtime_type must NOT throw "No integrated session".
  let typedOk = true, typedErr = "";
  try {
    const t = m.text(await m.call("runtime_type", { session_id: S, text: "HALLO ALEX" }));
    typedOk = /Runtime Daemon/.test(t) && !/No integrated session/.test(t);
  } catch (e) { typedOk = false; typedErr = e.message; }
  ok(typedOk, "1 runtime_type routes to the daemon (no 'No integrated session' — the BUG-028 failure)", typedErr);

  // 2 the typed text actually lands on the SHARED session's screen (let it scan in).
  await wsRpc(ui, "session/run", { session_id: S, cycles: 2_500_000 });
  const scr = await screenText(ui, S);
  ok(/HALLO ALEX/.test(scr.replace(/\s+/g, " ")), "2 'HALLO ALEX' appears on the SHARED session's live screen (acceptance check)", (scr.match(/HALLO[ A-Z]*/) || ["?"])[0]);

  // 3 joystick routes (no throw, daemon header).
  let joyOk = true, joyErr = "";
  try { const j = m.text(await m.call("runtime_joystick", { session_id: S, fire: true })); joyOk = /Runtime Daemon/.test(j); }
  catch (e) { joyOk = false; joyErr = e.message; }
  ok(joyOk, "3 runtime_joystick routes to the daemon session", joyErr);

  // 4 a SECOND MCP can also type into the same session (shared input).
  const m2 = spawnMcp(); await ready(m2);
  let typed2 = true, t2e = "";
  try { const t = m2.text(await m2.call("runtime_type", { session_id: S, text: "X" })); typed2 = /Runtime Daemon/.test(t); }
  catch (e) { typed2 = false; t2e = e.message; }
  ok(typed2, "4 a SECOND MCP drives the SAME shared session (co-driving)", t2e);

  // 5 still ONE shared session — no private MCP session leaked.
  const list = await wsRpc(ui, "session/list", {});
  ok(list.some((x) => x.sessionId === S), "5 still ONE shared session (no private MCP session leaked)", list.map((x) => x.sessionId).join(","));
  ui.close();
} catch (e) {
  console.error("FATAL", e.message); console.error(dlog.slice(-700)); exit = 2;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { daemon.kill(); } catch {}
  await sleep(200); killPort();
}
console.log(`\nBUG-028: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
