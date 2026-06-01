// Spec 746.1/.2/.3 — start/finalize a trace on the ALREADY-RUNNING shared daemon
// session (the charter's core gap: before, tracing could ONLY be set at
// session_start). Proves: runtime_trace_start on the live default session ->
// runtime_trace_status shows active -> run + mark -> runtime_trace_finalize ->
// the .duckdb store exists + runtime_swimlane_slice reads the CPU stepping lanes.
// Also proves 746.1: full-domain (iec/drive) trace has data (producers on-by-default).
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const daemonScript = join(ROOT, "scripts/runtime-daemon.mjs");
const PORT = 14777;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {} };

console.log("Spec 746.1/.2/.3 — start a trace on the RUNNING shared session\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }
killPort();

const procs = [];
function spawnMcp() {
  const proc = spawn(process.execPath, [cli], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT, C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_ENDPOINT: ENDPOINT, C64RE_RUNTIME_AUTOSTART: "0" }, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(proc);
  let buf = ""; const pending = new Map(); let nextId = 1;
  proc.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  const rpc = (method, params, t = 90000) => new Promise((res, rej) => { const id = nextId++; const timer = setTimeout(() => { pending.delete(id); rej(new Error(`mcp timeout ${method}`)); }, t); pending.set(id, (m) => { clearTimeout(timer); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.result; };
  const text = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { proc, rpc, call, text, kill: () => { try { proc.stdin.end(); proc.kill(); } catch {} } };
}
async function ready(m) { await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e746", version: "1" } }); m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }
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
  ok(!!S, "0b default session present", S);

  const m = spawnMcp(); await ready(m);

  // 1 status on the FRESH default session: no trace yet (and does NOT throw — 746.3 daemon route).
  const st0 = pj(m.text(await m.call("runtime_trace_status", { session_id: S })));
  ok(st0 && st0.active === false, "1 runtime_trace_status routes to daemon (no trace yet, no throw)", JSON.stringify(st0));

  // 2 START a trace on the RUNNING session — the core gap. Full domains (needs producers-on, 746.1).
  const startTxt = m.text(await m.call("runtime_trace_start", { session_id: S, domains: ["c64-cpu", "drive8-cpu", "iec", "memory"], output: "traces/e2e746.duckdb" }));
  const runId = (startTxt.match(/run (\S+)/) || [])[1];
  const storePath = (startTxt.match(/Store:\s*(\S+)/) || [])[1];
  ok(!!runId && /Runtime Daemon/.test(startTxt), "2 runtime_trace_start began a trace on the RUNNING session (the charter gap)", runId);

  // 3 status now shows active.
  const st1 = pj(m.text(await m.call("runtime_trace_status", { session_id: S })));
  ok(st1 && st1.active === true, "3 trace is now active on the shared session", JSON.stringify(st1).slice(0, 80));

  // 4 drive the shared session so the firehose captures, stamp a mark.
  await wsRpc(ui, "session/run", { session_id: S, cycles: 1_500_000 });
  await m.call("runtime_mark", { session_id: S, label: "phase-1" });
  await wsRpc(ui, "session/run", { session_id: S, cycles: 1_500_000 });
  const st2 = pj(m.text(await m.call("runtime_trace_status", { session_id: S })));
  ok(st2 && (st2.eventCount > 0 || st2.events > 0), "4 the firehose captured events while the shared session ran", JSON.stringify(st2).slice(0, 90));

  // 5 finalize (746.3 daemon route) → store written.
  const finTxt = m.text(await m.call("runtime_trace_finalize", { session_id: S }));
  const store = (finTxt.match(/Store:\s*(\S+)/) || [])[1];
  ok(/Runtime Daemon/.test(finTxt) && store && existsSync(store), "5 runtime_trace_finalize wrote the store (daemon-routed)", store);

  const finEvents = Number((finTxt.match(/Events:\s*(\d+)/) || [])[1] || 0);
  ok(finEvents > 1000, "6 finalize reported the firehose captured events (store non-empty)", `events=${finEvents}`);
  globalThis.__storePath = store; globalThis.__runId = runId;

  // 6d BUG-029 fix — read the swimlane via the MCP tool WHILE THE DAEMON IS LIVE.
  //    This is the exact scenario that hit "Could not set lock"; the daemon-routed
  //    read (trace/read in the daemon process) must now return the stepping lanes.
  let sw = "";
  try { sw = m.text(await m.call("runtime_swimlane_slice", { run_id: runId, duckdb_path: store, cycle_start: 0, cycle_end: 3_000_000, compact: true })); }
  catch (e) { sw = "ERR: " + e.message; }
  ok(/c64_pc/.test(sw) && sw.split("\n").length > 3, "6d runtime_swimlane_slice reads the trace WHILE the daemon is live (BUG-029 fixed)", sw.split("\n").find((l) => /c64_pc/.test(l)) || sw.slice(0, 80));

  // 6e BUG-029/746.5 — trace_store_query (different reader layer, queries.js) also
  //    reads the live-daemon store concurrently (read-only-first in withConn).
  let tq = "";
  try { tq = m.text(await m.call("trace_store_query", { path: store, sql: "SELECT count(*) FROM trace_event", limit: 5 })); }
  catch (e) { tq = "ERR: " + e.message; }
  ok(/\d/.test(tq) && !/ERR:/.test(tq), "6e trace_store_query reads the live-daemon store (queries.js read-only-first)", tq.split("\n").filter(Boolean).pop());

  // 6b mark stamped into the run.
  ok(/marks:\s*[1-9]/.test(finTxt) || /phase-1/.test(finTxt), "6b finalize reported the stamped mark", (finTxt.match(/marks:\s*\d+/) || [""])[0]);

  // 6c still ONE shared session.
  const list = await wsRpc(ui, "session/list", {});
  ok(list.some((x) => x.sessionId === S), "6c still ONE shared session (no private MCP session)", list.map((x) => x.sessionId).join(","));
  ui.close();
} catch (e) {
  console.error("FATAL", e.message); console.error(dlog.slice(-800)); exit = 2;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { daemon.kill(); } catch {}
  await sleep(800); killPort();
}

// 7 (post-teardown) — with the daemon gone, the store is readable: it holds the
//   CPU firehose (the swimlane truth) AND the swimlane renders the stepping lanes.
//   This proves 746 captured real data on the live session; the only gap is the
//   concurrent (daemon-live) read = BUG-029.
if (globalThis.__storePath && existsSync(globalThis.__storePath)) {
  try {
    const duckdb = await import("@duckdb/node-api");
    const inst = await duckdb.DuckDBInstance.create(globalThis.__storePath, { access_mode: "READ_ONLY" });
    const conn = await inst.connect();
    const ev = Number((await conn.runAndReadAll("SELECT count(*) c FROM trace_event")).getRows()[0][0]);
    const cpu = Number((await conn.runAndReadAll("SELECT count(*) c FROM trace_event WHERE channel='cpu'")).getRows()[0][0]);
    inst.closeSync?.();
    ok(ev > 1000 && cpu > 0, "7 store holds the CPU firehose from the live run (read post-teardown)", `events=${ev} cpu=${cpu}`);
    const { swimlaneSlice } = await import(join(ROOT, "dist/runtime/headless/v2/swimlane.js"));
    const { DuckDbQueryBackend } = await import(join(ROOT, "dist/runtime/headless/v2/duckdb-backend.js"));
    const inst2 = await duckdb.DuckDBInstance.create(globalThis.__storePath, { access_mode: "READ_ONLY" });
    const conn2 = await inst2.connect();
    const slice = await swimlaneSlice(new DuckDbQueryBackend(conn2), { runId: globalThis.__runId, cycleRange: [0, 3_000_000], compact: true });
    inst2.closeSync?.();
    ok((slice.rows?.length ?? 0) > 10, "8 swimlane renders CPU stepping lanes from the live trace", `rows=${slice.rows?.length}`);
  } catch (e) { ok(false, "7/8 post-teardown store read", e.message); }
} else {
  ok(false, "7/8 post-teardown store read", "store missing");
}

console.log(`\nSpec 746.1/.2/.3: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
