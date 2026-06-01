// Spec 746.x — TRACE MEMORY-LEAK gate (the "Sobald der Trace läuft kackt der
// Headless Service ab" bug). The live run loop (runtime-controller.tick) runs
// runFor every frame but, before this fix, NEVER drained the trace. The binary
// trace worker — which writes the .c64retrace authority AND recycles the 1 MiB
// chunk buffers — is ONLY fed by drain(); so the sync CPU firehose grew
// pendingSend + fresh 1 MiB allocs unbounded (~15 MiB/s @PAL, ~140 MiB/s @warp),
// measured 113→3417 MiB in 24s, → OOM → the shared daemon died mid-trace
// ("Session/Verbindung weg"), reproducibly when a disk was loaded/swapped while
// traced (event burst on top of the climb).
//
// This gate starts a FULL-domain trace on the live daemon session, free-runs at
// WARP (worst case, fastest leak), swaps a disk MID-TRACE (the exact user
// trigger), and proves:
//   1. the daemon SURVIVES 20s of warp tracing + a disk swap (no OOM/crash),
//   2. RSS STABILISES (late-phase growth ~flat) instead of climbing linearly,
//   3. the worker is actually FED — the .c64retrace authority grows on disk
//      (proves the drain streams events out, they are not silently dropped),
//   4. trace stop is clean and the daemon stays responsive afterwards.
//
// Runs on its OWN daemon/port — never 4312 (the human's live session).
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const daemonScript = join(ROOT, "scripts/runtime-daemon.mjs");
const PROJECT = "/tmp/c64re-leak-gate";
const PORT = 14778;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
const DISK = join(ROOT, "samples/POLARBEAR.d64"); // disk-swap-mid-trace = the user trigger

// Thresholds. Without the fix: ~140 MiB/s @warp → ~2800 MiB delta over 20s and a
// crash. With the fix the firehose streams out + buffers recycle → RSS plateaus.
const LATE_GROWTH_MAX_MIB = 500;  // rss(end) - rss(mid): a leak keeps climbing here
const PEAK_DELTA_MAX_MIB = 1200;  // rss(peak) - rss(baseline): leak would be > 2500

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {} };
const rssMiB = (pid) => { try { return Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024); } catch { return -1; } };

let wsId = 1;
const wsRpc = (ws, method, params, to = 30000) => new Promise((res, rej) => {
  const id = wsId++; const t = setTimeout(() => rej(new Error("ws timeout " + method)), to);
  const on = (data, isBin) => { if (isBin) return; let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id === id) { clearTimeout(t); ws.off("message", on); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  ws.on("message", on); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
});

console.log("Spec 746.x — trace memory-leak gate (live warp trace + disk swap must NOT OOM the daemon)\n");
if (!existsSync(DISK)) { console.error(`missing test disk ${DISK}`); process.exit(2); }
killPort();
try { rmSync(PROJECT, { recursive: true, force: true }); } catch {}
mkdirSync(PROJECT, { recursive: true });

const daemon = spawn(process.execPath, [daemonScript, "--project", PROJECT, "--port", String(PORT)], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: PROJECT }, stdio: ["ignore", "pipe", "pipe"] });
let dlog = ""; daemon.stdout.on("data", (d) => dlog += d); daemon.stderr.on("data", (d) => dlog += d);

let exit = 0;
const rssSamples = [];
try {
  for (let i = 0; i < 150 && !/runtime authority ready/.test(dlog); i++) await sleep(200);
  ok(/runtime authority ready/.test(dlog), "0 daemon ready", `pid=${daemon.pid}`);

  const ws = await new Promise((res, rej) => { const w = new WebSocket(ENDPOINT); w.once("open", () => res(w)); w.once("error", rej); });
  const S = (await wsRpc(ws, "session/list", {}))[0]?.sessionId;
  ok(!!S, "0b default session present", S);
  await wsRpc(ws, "session/reset", { session_id: S, video: "pal-default" });

  const baseline = rssMiB(daemon.pid);
  ok(baseline > 0, "1 baseline RSS sampled", `${baseline} MiB`);

  // Start a FULL-domain trace on the LIVE session, then free-run at WARP.
  const t = await wsRpc(ws, "trace/start_domains", { session_id: S, domains: ["c64-cpu", "drive8-cpu", "iec", "memory"], output: "traces/leak-gate.duckdb" });
  const outPath = t?.outputPath || "";
  const retrace = outPath.endsWith(".duckdb") ? outPath.slice(0, -".duckdb".length) + ".c64retrace" : outPath + ".c64retrace";
  ok(!!outPath, "2 trace started on the live session", outPath);

  await wsRpc(ws, "debug/run", { session_id: S, pacing: { mode: "warp" } });

  // 20s of warp tracing, sampling RSS every 2s. At ~10s swap a disk MID-TRACE.
  // A second WS proves the daemon stays RESPONSIVE while the firehose runs (the
  // real "is the session alive" check — the crash made it go silent).
  const ws2 = await new Promise((res, rej) => { const w = new WebSocket(ENDPOINT); w.once("open", () => res(w)); w.once("error", rej); });
  let swapErr = null, swapped = false, liveResponses = 0;
  for (let s = 1; s <= 10; s++) {
    await sleep(2000);
    rssSamples.push(rssMiB(daemon.pid));
    try { const l = await wsRpc(ws2, "session/list", {}, 4000); if (Array.isArray(l) && l.length) liveResponses++; } catch {}
    if (s === 5) {
      try { await wsRpc(ws, "media/swap", { session_id: S, path: DISK }); swapped = true; }
      catch (e) { swapErr = e.message; }
    }
  }
  ws2.close();
  ok(swapped, "3 disk swap executed MID-TRACE (the exact crash trigger)", swapErr ? "ERR " + swapErr : "POLARBEAR.d64");
  ok(liveResponses >= 8, "3b daemon stayed RESPONSIVE during the live trace (would go silent on the OOM path)", `${liveResponses}/10 pings answered`);

  // 4 daemon SURVIVED the whole warp-trace + swap (the headline: no OOM crash).
  const alive = (() => { try { return process.kill(daemon.pid, 0), true; } catch { return false; } })();
  ok(alive, "4 daemon SURVIVED 20s warp trace + disk swap (no OOM / no crash)", `samples=[${rssSamples.join(",")}] MiB`);

  // 5 RSS STABILISED — late-phase growth is ~flat (a leak keeps climbing here).
  const mid = rssSamples[Math.floor(rssSamples.length / 2)];
  const end = rssSamples[rssSamples.length - 1];
  const lateGrowth = end - mid;
  ok(alive && lateGrowth < LATE_GROWTH_MAX_MIB, "5 RSS stabilised — late-phase growth flat (no unbounded leak)", `mid=${mid} end=${end} Δ=${lateGrowth} MiB (<${LATE_GROWTH_MAX_MIB})`);

  // 6 peak delta bounded (leak would be > 2500 MiB over this window).
  const peak = Math.max(...rssSamples.filter((x) => x > 0));
  const peakDelta = peak - baseline;
  ok(alive && peakDelta < PEAK_DELTA_MAX_MIB, "6 peak RSS bounded (leak would blow past this)", `peak=${peak} baseline=${baseline} Δ=${peakDelta} MiB (<${PEAK_DELTA_MAX_MIB})`);

  // 7 the worker WAS fed — the .c64retrace authority grew on disk (proves the
  //   per-frame drain actually streams events out, not silently dropped).
  await wsRpc(ws, "debug/pause", { session_id: S }).catch(() => {});
  let retraceBytes = 0;
  try { retraceBytes = statSync(retrace).size; } catch {}
  ok(retraceBytes > 1_000_000, "7 .c64retrace authority grew on disk (drain streams events out)", `${retrace} = ${retraceBytes} bytes`);

  // 8 trace stop is clean + daemon stays responsive afterwards. NOTE: stop()
  //   builds the DuckDB index from the .c64retrace log (currently a synchronous,
  //   event-loop-blocking decode loop — binary-log-indexer.ts). On this 20s WARP
  //   monster (~460 MB / ~29M events) that legitimately takes tens of seconds, so
  //   we give it a generous timeout. (At realistic PAL volume it's sub-second.
  //   Off-loading the index to a worker is a separate follow-up; it is NOT the
  //   OOM bug this gate covers.)
  const t0 = rssMiB(daemon.pid); // (reuse helper just for a cheap wall marker via samples below)
  let stopOk = false, responsive = false, stopMs = 0;
  const stopStart = rssSamples.length; void stopStart; void t0;
  try {
    const begin = await wsRpc(ws, "trace/run/status", { session_id: S }, 4000).then(() => Date.now()).catch(() => Date.now());
    const r = await wsRpc(ws, "trace/run/stop", { session_id: S }, 180000); stopOk = !!r;
    stopMs = Date.now() - begin;
  } catch (e) { stopOk = false; dlog += "\nSTOP ERR " + e.message; }
  try { const l = await wsRpc(ws, "session/list", {}, 10000); responsive = Array.isArray(l) && l.length > 0; } catch {}
  ok(stopOk, "8 trace/run/stop clean (index built from the .c64retrace log)", stopOk ? `stopped in ~${stopMs} ms` : "threw");
  ok(responsive, "9 daemon responsive after stop (session/list answers)");
  ws.close();
} catch (e) {
  console.error("FATAL", e.message); console.error(dlog.slice(-1000)); exit = 2;
} finally {
  try { daemon.kill("SIGKILL"); } catch {}
  await sleep(600); killPort();
  try { rmSync(PROJECT, { recursive: true, force: true }); } catch {}
}

console.log(`\nSpec 746.x trace-leak: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
