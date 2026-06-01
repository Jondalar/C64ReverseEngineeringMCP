// Spec 746.4 — checkpoint ring (scrub/rewind) MCP tools on the SHARED daemon
// session. Proves: the LLM can list the auto-captured keyframes, capture one now,
// pin it (evict-exempt), restore (REWIND the shared session — the UI would see the
// same jump), unpin. All on the same session the human drives (744.4c).
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const daemonScript = join(ROOT, "scripts/runtime-daemon.mjs");
const PORT = 14778;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {} };

console.log("Spec 746.4 — checkpoint ring (scrub/rewind) tools on the shared session\n");
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
async function ready(m) { await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cp746", version: "1" } }); m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }
let wsId = 1;
const wsRpc = (ws, method, params) => new Promise((res, rej) => { const id = wsId++; const t = setTimeout(() => rej(new Error("ws timeout " + method)), 30000); const on = (data, isBin) => { if (isBin) return; let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id === id) { clearTimeout(t); ws.off("message", on); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; ws.on("message", on); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });

const daemon = spawn(process.execPath, [daemonScript, "--project", ROOT, "--port", String(PORT)], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT }, stdio: ["ignore", "pipe", "pipe"] });
let dlog = ""; daemon.stdout.on("data", (d) => dlog += d); daemon.stderr.on("data", (d) => dlog += d);
const pj = (t) => { try { return JSON.parse(t); } catch { return null; } };

let exit = 0;
try {
  for (let i = 0; i < 150 && !/runtime authority ready/.test(dlog); i++) await sleep(200);
  ok(/runtime authority ready/.test(dlog), "0 daemon ready");
  const ui = await new Promise((res, rej) => { const w = new WebSocket(ENDPOINT); w.once("open", () => res(w)); w.once("error", rej); });
  const S = (await wsRpc(ui, "session/list", {}))[0]?.sessionId;
  ok(!!S, "0b default session", S);
  const m = spawnMcp(); await ready(m);

  // 1 list — empty/early ring is fine; tool routes + returns stats (no throw).
  const l0 = pj(m.text(await m.call("runtime_checkpoint_list", { session_id: S })));
  ok(l0 && l0.stats && Array.isArray(l0.checkpoints), "1 runtime_checkpoint_list routes to the shared ring (stats present)", `count=${l0?.stats?.count}`);

  // advance the shared session so a capture has real state.
  await wsRpc(ui, "session/run", { session_id: S, cycles: 1_000_000 });

  // 2 capture NOW — returns a ref with an id.
  const cap = pj(m.text(await m.call("runtime_checkpoint_capture", { session_id: S })));
  const cpId = cap?.ref?.id;
  ok(!!cpId, "2 runtime_checkpoint_capture made a keyframe on the shared session", cpId);

  // 3 it shows up in the list.
  const l1 = pj(m.text(await m.call("runtime_checkpoint_list", { session_id: S })));
  ok(l1.checkpoints.some((c) => c.id === cpId), "3 the captured checkpoint is in the ring", `count=${l1.stats.count}`);

  // 4 pin it → pinned in stats.
  const pin = pj(m.text(await m.call("runtime_checkpoint_pin", { session_id: S, id: cpId })));
  ok(pin && pin.ref && pin.ref.pinned === true, "4 runtime_checkpoint_pin marks it evict-exempt", `pinned=${pin?.stats?.pinnedCount}`);

  // 5 advance further, then RESTORE (rewind) — cycles jump back to the checkpoint's.
  await wsRpc(ui, "session/run", { session_id: S, cycles: 1_000_000 });
  const before = (await wsRpc(ui, "session/state", { session_id: S })).c64Cycles;
  const res = pj(m.text(await m.call("runtime_checkpoint_restore", { session_id: S, id: cpId })));
  const after = (await wsRpc(ui, "session/state", { session_id: S })).c64Cycles;
  ok(res && after < before, "5 runtime_checkpoint_restore REWOUND the shared session (cycles jumped back)", `${before} -> ${after}`);

  // 6 unpin works.
  const unpin = pj(m.text(await m.call("runtime_checkpoint_unpin", { session_id: S, id: cpId })));
  ok(unpin && unpin.ref && unpin.ref.pinned === false, "6 runtime_checkpoint_unpin releases it", `pinned=${unpin?.stats?.pinnedCount}`);

  // 7 a SECOND MCP sees the same ring (shared).
  const m2 = spawnMcp(); await ready(m2);
  const l2 = pj(m2.text(await m2.call("runtime_checkpoint_list", { session_id: S })));
  ok(l2 && l2.checkpoints.some((c) => c.id === cpId), "7 a SECOND MCP sees the same checkpoint ring (shared session)", cpId);
  ui.close();
} catch (e) {
  console.error("FATAL", e.message); console.error(dlog.slice(-700)); exit = 2;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { daemon.kill(); } catch {}
  await sleep(200); killPort();
}
console.log(`\nSpec 746.4: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
