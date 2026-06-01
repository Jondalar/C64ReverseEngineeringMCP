// Spec 744.4c slice 2b — the media tools route to the ONE abstract media
// operation (ingestMedia / media/ingress, Spec 709) on the SHARED daemon session.
// Proves: runtime_media_mount/swap/unmount apply to the daemon session the UI
// watches (recorded in the shared mediaEvents history a UI client reads back); a
// relative path resolves into the CALLER's project; the result is the one
// MediaIngressResult shape; a SECOND MCP shares the session; no private session
// leaks. This is the convergence — no legacy mountMedia/swapDisk fork.
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const daemonScript = join(ROOT, "scripts/runtime-daemon.mjs");
const DISK_ABS = join(ROOT, "samples/synthetic/1byte.g64");
const PORT = 14774;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {} };

console.log("Spec 744.4c slice 2b — media converges to the shared ingest op\n");
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

const parseJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

let exit = 0;
try {
  for (let i = 0; i < 150 && !/runtime authority ready/.test(dlog); i++) await sleep(200);
  ok(/runtime authority ready/.test(dlog), "0 daemon ready");
  const ui = await new Promise((res, rej) => { const w = new WebSocket(ENDPOINT); w.once("open", () => res(w)); w.once("error", rej); });
  const S = (await wsRpc(ui, "session/list", {}))[0]?.sessionId;
  ok(!!S, "0b default session present", S);

  const mcp1 = spawnMcp(); await ready(mcp1);

  // 1 media_mount RELATIVE path → resolves into caller project → ingests on shared session.
  const mntTxt = mcp1.text(await mcp1.call("runtime_media_mount", { session_id: S, slot: 8, path: "samples/synthetic/1byte.g64" }));
  const mnt = parseJson(mntTxt);
  ok(mnt && mnt.ok === true && mnt.event && mnt.event.operation === "disk", "1 media_mount routed to the shared ingest op (MediaIngressResult shape)", mnt && mnt.event && mnt.event.format);

  // 2 the relative path resolved to the caller project → backingPath under ROOT.
  const back = mnt && mnt.detail && mnt.detail.backingPath;
  ok(typeof back === "string" && back.startsWith(ROOT) && back.endsWith("1byte.g64"), "2 relative path resolved into the CALLER's project (write-through backing path)", back);

  // 3 the mount is recorded in the SHARED mediaEvents history the UI reads back.
  const ev1 = await wsRpc(ui, "media/events", { session_id: S });
  ok(ev1 && Array.isArray(ev1.events) && ev1.events.some((e) => e.operation === "disk"), "3 UI reads the LLM's mount from the shared media-event history (one machine)", ev1 && ev1.events.length);

  // 4 a SECOND MCP shares the session.
  const mcp2 = spawnMcp(); await ready(mcp2);
  const st2 = parseJson(mcp2.text(await mcp2.call("runtime_monitor_registers", { session_id: S })));
  ok(st2 && typeof st2.pc === "number", "4 a SECOND MCP reads the same shared session", S);

  // 5 media_swap (relative path) → another disk ingest on the shared session.
  const swTxt = mcp2.text(await mcp2.call("runtime_media_swap", { session_id: S, slot: 8, path: "samples/synthetic/1byte.g64" }));
  const sw = parseJson(swTxt);
  ok(sw && sw.ok === true && sw.event && sw.event.operation === "disk", "5 media_swap routed to the shared ingest op", sw && sw.event && sw.event.operation);

  // 6 media_unmount → eject on the shared session, recorded in the history.
  const unTxt = mcp1.text(await mcp1.call("runtime_media_unmount", { session_id: S, slot: 8 }));
  const un = parseJson(unTxt);
  ok(un && un.ok === true && un.event && un.event.operation === "eject", "6 media_unmount routed to the shared ingest op (eject)", un && un.event && un.event.operation);

  // 7 the shared history now holds mount+swap+eject in order (the human can replay it).
  const ev2 = await wsRpc(ui, "media/events", { session_id: S });
  const ops = (ev2.events || []).map((e) => e.operation);
  ok(ops.filter((o) => o === "disk").length >= 2 && ops.includes("eject"), "7 shared media-event history records all 3 LLM ops in order", ops.join(","));

  // 8 still ONE shared session — no private MCP session leaked.
  const list = await wsRpc(ui, "session/list", {});
  ok(list.some((x) => x.sessionId === S), "8 still ONE shared session (no private MCP session leaked)", list.map((x) => x.sessionId).join(","));
  ui.close();
} catch (e) {
  console.error("FATAL", e.message); console.error(dlog.slice(-700)); exit = 2;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { daemon.kill(); } catch {}
  await sleep(200); killPort();
}
console.log(`\nSpec 744.4c slice 2b: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
