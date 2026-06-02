// BUG-030 — a trace must SURVIVE a fastloader firehose (not abort on the
// backpressure ceiling) AND a poisoned/aborted trace must never WEDGE the session
// (stop always clears the active flag so trace_start can restart, no daemon kill).
//
// Forces a TINY ceiling (C64RE_TRACE_MAX_PENDING_CHUNKS=4) so a short run exercises
// the path that used to abort at 256 chunks.
//
//   Part A (daemon, the user's exact path): trace/start_domains on the shared
//     session → a big session/run firehose → the trace SURVIVES (the chunked
//     per-segment drain feeds the worker) → clean stop → trace_start restarts.
//   Part B (in-process, deterministic wedge): poison the writer (publish past the
//     tiny ceiling without draining) → stop() returns cleanly (aborted run, NOT a
//     throw) + isActive()===false → start() succeeds again (no "already active").
process.env.C64RE_TRACE_MAX_PENDING_CHUNKS = "4";

import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const daemonScript = join(ROOT, "scripts/runtime-daemon.mjs");
const PORT = 14793;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
const PROJECT = mkdtempSync(join(tmpdir(), "c64re-bug030-"));
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {} };
let wsId = 1;
const rpc = (ws, m, p, to = 60000) => new Promise((res, rej) => {
  const id = wsId++; const t = setTimeout(() => rej(new Error("ws timeout " + m)), to);
  const on = (d, b) => { if (b) return; let j; try { j = JSON.parse(d.toString()); } catch { return; } if (j.id === id) { clearTimeout(t); ws.off("message", on); j.error ? rej(new Error(j.error.message)) : res(j.result); } };
  ws.on("message", on); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }));
});

console.log("BUG-030 — trace survives a firehose + never wedges (tiny ceiling=4)\n");
if (!existsSync(join(ROOT, "dist/cli.js"))) { console.error("build:mcp first"); process.exit(2); }
killPort();

let exit = 0;
// ---------- Part B: in-process wedge-recovery (deterministic) ----------
try {
  const { startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
  const { RuntimeController } = await import("../dist/runtime/headless/debug/runtime-controller.js");
  const { TraceRunController } = await import("../dist/runtime/headless/trace/trace-run.js");
  const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.resetCold("pal-default");
    const reg = session.kernel.trace();
    const def = { id: "fh", version: 1, name: "fh", domains: ["c64-cpu"], triggers: [{ kind: "pc-range", domain: "c64-cpu", from: 0, to: 0xffff }], captures: [{ kind: "cpu-row", domain: "c64-cpu" }], retention: "transient" };
    const tr = new TraceRunController();
    await tr.start(def, { controller: ctrl, outputPath: join(PROJECT, "wedge.duckdb"), binary: true });
    // Poison: publish WAY past the tiny ceiling (4 chunks ≈ 4 MiB) with NO drain.
    for (let i = 0; i < 1_500_000; i++) reg.publish("cpu", i + 1, { side: 0, pc: 0xE000 + (i & 0x3ff), opcode: 0xEA });
    // stop() must NOT throw (writer is poisoned) — it aborts gracefully + clears active.
    let stopThrew = false, run = null;
    try { run = await tr.stop(); } catch { stopThrew = true; }
    ok(!stopThrew && !!run, "B1 stop() on a poisoned writer returns cleanly (no throw)", run ? `aborted=${run.aborted}` : "threw");
    ok(tr.isActive() === false, "B2 active flag cleared after the abort (no wedge)");
    // start() must succeed again — the bug was 'trace already active … no working stop'.
    let restartThrew = false;
    try { await tr.start({ ...def, id: "fh2" }, { controller: ctrl, outputPath: join(PROJECT, "wedge2.duckdb"), binary: true }); }
    catch { restartThrew = true; }
    ok(!restartThrew && tr.isActive(), "B3 trace restarts after an abort (no daemon kill needed)");
    await tr.stop().catch(() => {});
  } finally { stopIntegratedSession(sessionId); }
} catch (e) { console.error("Part B FATAL", e.stack || e.message); exit = 2; }

// ---------- Part A: daemon firehose-through-session/run survives ----------
const daemon = spawn(process.execPath, [daemonScript, "--project", PROJECT, "--port", String(PORT)], {
  cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: PROJECT, C64RE_TRACE_MAX_PENDING_CHUNKS: "4" }, stdio: ["ignore", "pipe", "pipe"],
});
let dlog = ""; daemon.stdout.on("data", (d) => dlog += d); daemon.stderr.on("data", (d) => dlog += d);
try {
  for (let i = 0; i < 150 && !/runtime authority ready/.test(dlog); i++) await sleep(200);
  const ws = await new Promise((res, rej) => { const w = new WebSocket(ENDPOINT); w.once("open", () => res(w)); w.once("error", rej); });
  const S = (await rpc(ws, "session/list", {}))[0]?.sessionId;
  ok(!!S, "A0 daemon up + session", S);
  await rpc(ws, "session/reset", { session_id: S, video: "pal-default" });
  await rpc(ws, "trace/start_domains", { session_id: S, domains: ["c64-cpu", "drive8-cpu", "iec"] });

  // The firehose: a big bounded run (3M cycles ≫ 100k drain segment). With the
  // chunked per-segment drain this stays under the 4-chunk ceiling; without it the
  // old path aborted at 256 (here 4) chunks.
  await rpc(ws, "session/run", { session_id: S, cycles: 3_000_000 }, 120000);
  const st = await rpc(ws, "trace/run/status", { session_id: S });
  ok(st && st.active === true && !st.aborted, "A1 trace SURVIVED a 3M-cycle firehose run (no backpressure abort)", JSON.stringify(st).slice(0, 90));
  // run again — still alive.
  await rpc(ws, "session/run", { session_id: S, cycles: 2_000_000 }, 120000);
  const st2 = await rpc(ws, "trace/run/status", { session_id: S });
  ok(st2 && st2.active === true && !st2.aborted, "A2 still alive after a second firehose run", JSON.stringify(st2).slice(0, 90));

  // clean stop (wait_index so the store is queryable) → no throw.
  let stopOk = false, run = null;
  try { const r = await rpc(ws, "trace/run/stop", { session_id: S, wait_index: true }, 120000); run = r?.run; stopOk = !!run; } catch (e) { dlog += "\nSTOP ERR " + e.message; }
  ok(stopOk && !run?.aborted, "A3 clean stop after the firehose (not aborted)", run ? `events=${run.eventCount} aborted=${run.aborted}` : "threw");
  ok((run?.eventCount ?? 0) > 100_000, "A4 the survived trace captured the firehose", `events=${run?.eventCount}`);

  // restart — no wedge.
  let restartOk = false;
  try { await rpc(ws, "trace/start_domains", { session_id: S, domains: ["c64-cpu"] }); restartOk = true; } catch (e) { dlog += "\nRESTART ERR " + e.message; }
  ok(restartOk, "A5 trace_start works again after stop (no 'already active' wedge)");
  await rpc(ws, "trace/run/stop", { session_id: S }).catch(() => {});
  ws.close();
} catch (e) { console.error("Part A FATAL", e.message); console.error(dlog.slice(-800)); exit = 2; }
finally { try { daemon.kill("SIGKILL"); } catch {} await sleep(400); killPort(); }

console.log(`\nBUG-030 trace-backpressure: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
