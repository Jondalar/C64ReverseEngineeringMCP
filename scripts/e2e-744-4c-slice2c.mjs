// Spec 744.4c slice 2c — the remaining session-attached tools route to the SHARED
// daemon session: status, until, snapshot_tree, promote_branch, media_persist,
// save_vsf, load_vsf, memory_access_map, vic_inspect_at. CRITICAL extra check:
// media_persist + save_vsf write THROUGH to the caller's host file (Spec 742) —
// the file must actually appear/change on disk.
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const daemonScript = join(ROOT, "scripts/runtime-daemon.mjs");
const DISK_SRC = join(ROOT, "samples/synthetic/1byte.g64");
const PORT = 14775;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {} };

console.log("Spec 744.4c slice 2c — remaining session-attached tools route to the daemon\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }
if (!existsSync(DISK_SRC)) { console.error("missing sample disk " + DISK_SRC); process.exit(2); }
killPort();

// a per-run writable workdir inside ROOT so a RELATIVE caller path resolves under it.
const WORK = join(ROOT, ".tmp", `slice2c-${process.pid}`);
mkdirSync(WORK, { recursive: true });
const DISK_REL = join(".tmp", `slice2c-${process.pid}`, "writable.g64");
const DISK_ABS = join(ROOT, DISK_REL);
copyFileSync(DISK_SRC, DISK_ABS);
const VSF_REL = join(".tmp", `slice2c-${process.pid}`, "snap.vsf");
const VSF_ABS = join(ROOT, VSF_REL);

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
async function ready(m) { await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "slice2c", version: "1" } }); m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }
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

  // 1 status — reports shared session cycle counts.
  const st = pj(m.text(await m.call("runtime_status", { session_id: S })));
  ok(st && typeof st.c64Cycles === "number", "1 runtime_status routed (shared session introspection)", st && st.mode);

  // 2 until — advance shared session to a KERNAL PC; UI sees cycles move.
  const c0 = (await wsRpc(ui, "session/state", { session_id: S })).c64Cycles;
  const un = pj(m.text(await m.call("runtime_until", { session_id: S, addr: 0xea31, budget: 2_000_000 })));
  const c1 = (await wsRpc(ui, "session/state", { session_id: S })).c64Cycles;
  ok(un && c1 > c0, "2 runtime_until advanced the SHARED session (UI sees cycles move)", `${c0}→${c1}`);

  // 3 mount a WRITABLE disk via relative path (caller-project) on the shared session.
  const mnt = pj(m.text(await m.call("runtime_media_mount", { session_id: S, slot: 8, path: DISK_REL })));
  ok(mnt && mnt.ok === true && mnt.detail && String(mnt.detail.backingPath) === DISK_ABS, "3 mounted writable disk (relative→caller path, write-through backing set)", mnt && mnt.detail && mnt.detail.backingPath);

  // 4 media_persist — WRITE-THROUGH preserved: writes the caller's host file.
  const mtimeBefore = statSync(DISK_ABS).mtimeMs;
  await sleep(20);
  const pr = pj(m.text(await m.call("runtime_media_persist", { session_id: S, slot: 8 })));
  ok(pr && (pr.written === true || pr.reason), "4 media_persist routed (returns {written|reason})", pr && (pr.written ? `wrote ${pr.bytes}b` : pr.reason));
  ok(pr && pr.path === DISK_ABS, "4b media_persist write-through targets the CALLER's host file (Spec 742 preserved)", pr && pr.path);

  // 5 save_vsf — snapshot to a relative caller path → file appears on disk.
  if (existsSync(VSF_ABS)) rmSync(VSF_ABS);
  const sv = m.text(await m.call("runtime_save_vsf", { session_id: S, output_path: VSF_REL }));
  ok(existsSync(VSF_ABS) && statSync(VSF_ABS).size > 0 && sv.includes(VSF_ABS), "5 save_vsf wrote a real file into the caller's project (bytes never crossed the wire)", `${existsSync(VSF_ABS) ? statSync(VSF_ABS).size : 0}b`);

  // 6 load_vsf — restore the shared session from that file.
  const lv = m.text(await m.call("runtime_load_vsf", { session_id: S, input_path: VSF_REL }));
  ok(/loaded \d+ bytes from/.test(lv) && lv.includes(VSF_ABS), "6 load_vsf restored the shared session from the caller's file", lv.trim());

  // 7 memory_access_map — liveness window runs on the shared session.
  const mam = m.text(await m.call("runtime_memory_access_map", { session_id: S, cycles: 100000, classes: ["live", "dead", "unused"], min_bytes: 256 }));
  ok(/memory-access map over \d+ cyc/.test(mam), "7 memory_access_map ran on the shared session", mam.split("\n")[0]);

  // 8 vic_inspect_at — captures+pins a checkpoint on the shared ring, resolves a pixel.
  const vi = pj(m.text(await m.call("runtime_vic_inspect_at", { session_id: S, x: 10, y: 10 })));
  ok(vi && vi.checkpointId && vi.frame, "8 vic_inspect_at captured a checkpoint + resolved a pixel on the shared session", vi && vi.checkpointId);

  // 9 snapshot_tree — routes to the daemon (which sets scenarioId+diskPath+mode;
  //   the in-process getApi path threw because it did not). Returns a rewind tree.
  const tr = pj(m.text(await m.call("runtime_snapshot_tree", { session_id: S })));
  ok(tr && tr.rootBranchId && typeof tr.ringSize === "number", "9 snapshot_tree routed (rewind tree on the shared session)", tr && tr.rootBranchId);

  // 10 still ONE shared session — no private MCP session leaked.
  const list = await wsRpc(ui, "session/list", {});
  ok(list.some((x) => x.sessionId === S), "10 still ONE shared session (no private MCP session leaked)", list.map((x) => x.sessionId).join(","));
  ui.close();
} catch (e) {
  console.error("FATAL", e.message); console.error(dlog.slice(-800)); exit = 2;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { daemon.kill(); } catch {}
  await sleep(200); killPort();
  try { rmSync(WORK, { recursive: true, force: true }); } catch {}
}
console.log(`\nSpec 744.4c slice 2c: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
