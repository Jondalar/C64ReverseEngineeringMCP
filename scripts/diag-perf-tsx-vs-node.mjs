// DECISIVE perf measurement: daemon throughput under node/dist vs tsx-from-src.
// Spawns each on its own port, runs debug/run (live loop), measures cycles
// advanced over a fixed wall-clock window → cycles/sec. Real C64 PAL ≈ 985_248 Hz
// (= 50 fps). If node hits ~1MHz and tsx is far below, tsx-from-src is the 4fps cause.
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, existsSync } from "node:fs";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = (p) => { try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {} };
let wsId = 1;
const rpc = (ws, method, params) => new Promise((res, rej) => { const id = wsId++; const t = setTimeout(() => rej(new Error("timeout " + method)), 60000); const on = (data, isBin) => { if (isBin) return; let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id === id) { clearTimeout(t); ws.off("message", on); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; ws.on("message", on); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });

async function measure(label, cmd, args, port) {
  killPort(port);
  const d = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; d.stdout.on("data", (x) => log += x); d.stderr.on("data", (x) => log += x);
  const out = { label, port };
  try {
    for (let i = 0; i < 200 && !/runtime authority ready/.test(log); i++) await sleep(200);
    out.ready = /runtime authority ready/.test(log);
    if (!out.ready) { out.logTail = log.slice(-600); return out; }
    const ws = await new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
    const S = (await rpc(ws, "session/list", {}))[0]?.sessionId;
    // warm up JIT for 1.5s of live run first, THEN measure a 4s window.
    await rpc(ws, "debug/run", { session_id: S });
    await sleep(1500);
    const c0 = (await rpc(ws, "session/state", { session_id: S })).c64Cycles;
    const tStart = process.hrtime.bigint();
    await sleep(4000);
    const c1 = (await rpc(ws, "session/state", { session_id: S })).c64Cycles;
    const tEnd = process.hrtime.bigint();
    await rpc(ws, "debug/pause", { session_id: S }).catch(() => {});
    const secs = Number(tEnd - tStart) / 1e9;
    const cps = (c1 - c0) / secs;
    out.cyclesPerSec = Math.round(cps);
    out.realtimeRatio = +(cps / 985248).toFixed(3);     // 1.0 = full real-time (50fps)
    out.estFps = +(50 * cps / 985248).toFixed(1);        // implied fps at PAL
    ws.close();
  } catch (e) { out.error = e.message; out.logTail = log.slice(-600); }
  finally { try { d.kill(); } catch {} await sleep(300); killPort(port); }
  return out;
}

const results = [];
// node/dist (only if built)
const distEntry = join(ROOT, "dist/runtime/headless/daemon/run.js");
if (existsSync(distEntry)) results.push(await measure("node-dist", process.execPath, [distEntry, "--project", ROOT, "--port", "14770"], 14770));
else results.push({ label: "node-dist", skipped: "dist not built" });
// tsx-from-src
const tsx = join(ROOT, "node_modules/.bin/tsx");
const srcEntry = join(ROOT, "src/runtime/headless/daemon/run.ts");
results.push(await measure("tsx-src", tsx, [srcEntry, "--project", ROOT, "--port", "14771"], 14771));

writeFileSync(join(ROOT, ".tmp/perf-tsx-vs-node.json"), JSON.stringify(results, null, 2));
console.log("WROTE .tmp/perf-tsx-vs-node.json");
