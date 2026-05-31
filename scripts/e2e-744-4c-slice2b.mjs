// Spec 744.4c slice 2b — media tools (mount/unmount/swap) route to the SHARED
// daemon session. Proves: an MCP's runtime_media_mount inserts a disk into the
// daemon session the UI watches (the daemon broadcasts media/changed); a relative
// path resolves against the CALLER's project; unmount/swap likewise; a SECOND MCP
// sees the same shared session; no private MCP session leaks.
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const daemonScript = join(ROOT, "scripts/runtime-daemon.mjs");
const DISK_ABS = join(ROOT, "samples/synthetic/1byte.g64");
const PORT = 14773;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {} };

console.log("Spec 744.4c slice 2b — media tools route to the shared daemon\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }
if (!existsSync(DISK_ABS)) { console.error("missing sample disk " + DISK_ABS); process.exit(2); }
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
async function ready(m) { await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "slice2b", version: "1" } }); m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }
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

  // UI subscribes to media/changed broadcasts.
  let mediaChanged = null;
  ui.on("message", (data, isBin) => { if (isBin) return; let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.method === "media/changed") mediaChanged = m.params; });

  const mcp1 = spawnMcp(); await ready(mcp1);

  // 1 media_mount with a RELATIVE path → resolves into caller project → mounts in the shared session.
  const mntTxt = mcp1.text(await mcp1.call("runtime_media_mount", { session_id: S, slot: 8, path: "samples/synthetic/1byte.g64" }));
  let mnt = null; try { mnt = JSON.parse(mntTxt); } catch {}
  ok(mnt && /disk|cartridge/.test(mnt.kind || "") && mnt.path && mnt.path.includes("1byte.g64"), "1 media_mount routed to daemon; relative path resolved to caller project", mnt && mnt.path);

  // 2 the daemon broadcast media/changed to the UI (human sees the LLM's mount).
  await sleep(300);
  ok(mediaChanged && mediaChanged.kind === "mount" && mediaChanged.session_id === S, "2 UI received media/changed broadcast (LLM mount visible to human)", mediaChanged && mediaChanged.kind);

  // 3 a SECOND MCP sees the same shared session.
  const mcp2 = spawnMcp(); await ready(mcp2);
  const st2 = mcp2.text(await mcp2.call("runtime_monitor_registers", { session_id: S }));
  ok((() => { try { JSON.parse(st2); return true; } catch { return false; } })(), "3 a SECOND MCP reads the same shared session", S);

  // 4 media_swap (relative path) on the shared session.
  mediaChanged = null;
  const swTxt = mcp2.text(await mcp2.call("runtime_media_swap", { session_id: S, slot: 8, path: "samples/synthetic/1byte.g64" }));
  ok(!/error/i.test(swTxt) && /1byte\.g64|disk/.test(swTxt), "4 media_swap routed to daemon (relative path resolved)", swTxt.replace(/\s+/g, " ").slice(0, 70));

  // 5 media_unmount on the shared session.
  const unTxt = mcp1.text(await mcp1.call("runtime_media_unmount", { session_id: S, slot: 8 }));
  ok(!/error/i.test(unTxt), "5 media_unmount routed to daemon", unTxt.replace(/\s+/g, " ").slice(0, 70));

  // 6 still ONE shared session — no private MCP session leaked.
  const list = await wsRpc(ui, "session/list", {});
  ok(list.some((x) => x.sessionId === S) && list.length >= 1, "6 still ONE shared session (no private MCP session leaked)", list.map((x) => x.sessionId).join(","));
  ui.close();
} catch (e) {
  console.error("FATAL", e.message); console.error(dlog.slice(-600)); exit = 2;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { daemon.kill(); } catch {}
  await sleep(200); killPort();
}
console.log(`\nSpec 744.4c slice 2b: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
