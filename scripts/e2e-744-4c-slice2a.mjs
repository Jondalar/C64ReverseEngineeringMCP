// Spec 744.4c slice 2a — the debug/step + monitor analysis tools route to the
// SHARED Runtime Daemon, not a private in-process session. Proves: an MCP using
// runtime_monitor_registers / monitor_memory / monitor_disasm / step_into /
// breakpoint_* operates on the SAME daemon session the UI sees, and breakpoint
// state is shared across two separate MCP processes (= one shared machine).
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const daemonScript = join(ROOT, "scripts/runtime-daemon.mjs");
const PORT = 14772;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {} };

console.log("Spec 744.4c slice 2a — debug/step + monitor tools route to the shared daemon\n");
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
async function ready(m) { await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "slice2a", version: "1" } }); m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }
let wsId = 1;
const wsRpc = (ws, method, params) => new Promise((res, rej) => { const id = wsId++; const t = setTimeout(() => rej(new Error("ws timeout " + method)), 30000); const on = (data, isBin) => { if (isBin) return; let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id === id) { clearTimeout(t); ws.off("message", on); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; ws.on("message", on); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });

const daemon = spawn(process.execPath, [daemonScript, "--project", ROOT, "--port", String(PORT)], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT }, stdio: ["ignore", "pipe", "pipe"] });
let dlog = ""; daemon.stdout.on("data", (d) => dlog += d); daemon.stderr.on("data", (d) => dlog += d);

let exit = 0;
try {
  for (let i = 0; i < 150 && !/runtime authority ready/.test(dlog); i++) await sleep(200);
  ok(/runtime authority ready/.test(dlog), "0 daemon ready");

  const ui = await new Promise((res, rej) => { const w = new WebSocket(ENDPOINT); w.once("open", () => res(w)); w.once("error", rej); });
  const S = (await wsRpc(ui, "session/list", {}))[0]?.sessionId;
  ok(!!S, "0b default session present", S);
  await wsRpc(ui, "session/run", { session_id: S, cycles: 500_000 });
  const uiState = await wsRpc(ui, "session/state", { session_id: S });
  const uiPc = uiState.cpu.pc;

  const mcp1 = spawnMcp(); await ready(mcp1);

  const regTxt = mcp1.text(await mcp1.call("runtime_monitor_registers", { session_id: S }));
  const reg = JSON.parse(regTxt);
  ok(reg.pc === uiPc, "1 monitor_registers reads the SAME PC as the UI (shared session)", `mcp=$${reg.pc?.toString(16)} ui=$${uiPc.toString(16)}`);

  const memTxt = mcp1.text(await mcp1.call("runtime_monitor_memory", { session_id: S, start: 0xfffc, end: 0xffff }));
  ok(/bytes from \$fffc-\$ffff/.test(memTxt) && /[0-9a-f]{2} [0-9a-f]{2}/.test(memTxt), "2 monitor_memory returns hex bytes (TypedArray normalized over RPC)", memTxt.split("\n")[0]);

  const disTxt = mcp1.text(await mcp1.call("runtime_monitor_disasm", { session_id: S, addr: 0xfce2, count: 3 }));
  ok(disTxt.trim().length > 0, "3 monitor_disasm returns lines", JSON.stringify(disTxt.split("\n")[0]));

  const before = (await wsRpc(ui, "session/state", { session_id: S })).cpu.pc;
  const stepTxt = mcp1.text(await mcp1.call("runtime_step_into", { session_id: S }));
  const after = (await wsRpc(ui, "session/state", { session_id: S })).cpu.pc;
  ok(/stepped to PC=\$/.test(stepTxt) && after !== before, "4 step_into advances the SHARED session's PC (UI observes the move)", `${before.toString(16)}→${after.toString(16)}`);

  await mcp1.call("runtime_breakpoint_add", { session_id: S, id: "bp-slice2a", pc: 0xe5cd, action: "halt" });
  const mcp2 = spawnMcp(); await ready(mcp2);
  const listTxt = mcp2.text(await mcp2.call("runtime_breakpoint_list", { session_id: S }));
  ok(/bp-slice2a/.test(listTxt), "5 a SECOND MCP sees the breakpoint MCP#1 added (shared daemon state)");
  const rmTxt = mcp2.text(await mcp2.call("runtime_breakpoint_remove", { session_id: S, id: "bp-slice2a" }));
  ok(/removed bp-slice2a/.test(rmTxt), "6 breakpoint_remove works across MCPs", rmTxt);

  const listAfter = await wsRpc(ui, "session/list", {});
  ok(listAfter.some((x) => x.sessionId === S), "7 still ONE shared session (no private MCP-side session leaked)", listAfter.map((x) => x.sessionId).join(","));
  ui.close();
} catch (e) {
  console.error("FATAL", e.message); console.error(dlog.slice(-600)); exit = 2;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { daemon.kill(); } catch {}
  await sleep(200); killPort();
}
console.log(`\nSpec 744.4c slice 2a: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
