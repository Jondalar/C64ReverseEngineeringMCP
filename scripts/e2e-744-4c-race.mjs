// Spec 744.4c — multi-trigger START RACE. Three triggers can each try to bring the
// daemon up (MCP eager start, UI dev-server, lazy tool call). When several fire at
// once the OS port-bind must pick EXACTLY ONE winner; the losers must exit cleanly
// (run.ts EADDRINUSE → exit 0) leaving no orphan session. This gate proves both:
//   Part 1 — two daemons on the same port → loser exits 0, winner keeps serving.
//   Part 2 — N MCPs starting simultaneously (eager warm-start) → exactly ONE
//            listener on the port, and every MCP shares that one daemon.
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const daemonScript = join(ROOT, "scripts/runtime-daemon.mjs");
const DISK = join(ROOT, "samples/synthetic/1byte.g64");
const PORT = 14748;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = () => new Promise((res) => { const w = new WebSocket(ENDPOINT); const t = setTimeout(() => { w.terminate(); res(false); }, 1200); w.once("open", () => { clearTimeout(t); w.close(); res(true); }); w.once("error", () => { clearTimeout(t); res(false); }); });
// LISTEN-only filter — we kill the daemon (the listener), NEVER this gate's own
// client sockets to the port (without the filter, lsof returns our connections too
// and `kill -9` would SIGKILL the gate itself mid-run → spurious exit 137).
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch { /* none */ } };
const listenerCount = () => { try { const out = execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`, { encoding: "utf8" }); return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean)).size; } catch { return 0; } };
const waitPort = async (want, ms) => { const start = Date.now(); while (Date.now() - start < ms) { if ((await portOpen()) === want) return true; await sleep(200); } return false; };

console.log("Spec 744.4c — daemon START RACE: exactly one owner, losers exit clean\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }
killPort();

const procs = [];
function spawnMcp() {
  const proc = spawn(process.execPath, [cli], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT, C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_ENDPOINT: ENDPOINT }, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(proc);
  let buf = ""; const pending = new Map(); let nextId = 1;
  proc.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  const rpc = (method, params, t = 60000) => new Promise((res, rej) => { const id = nextId++; const timer = setTimeout(() => { pending.delete(id); rej(new Error(`mcp timeout ${method}`)); }, t); pending.set(id, (m) => { clearTimeout(timer); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.result; };
  const text = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { proc, rpc, call, text, kill: () => { try { proc.stdin.end(); proc.kill(); } catch {} } };
}
async function ready(m) { await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "race", version: "1" } }); m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }

let exit = 0;
try {
  ok(!(await portOpen()), "0 clean start — no daemon on the port");

  // ---- Part 1: explicit two-daemon EADDRINUSE → loser exits 0, winner serves ----
  const dA = spawn(process.execPath, [daemonScript, "--project", ROOT, "--port", String(PORT)], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT }, stdio: ["ignore", "pipe", "pipe"] });
  let aLog = ""; dA.stdout.on("data", (d) => { aLog += d.toString(); }); dA.stderr.on("data", (d) => { aLog += d.toString(); });
  for (let i = 0; i < 120 && !/runtime authority ready/.test(aLog); i++) await sleep(200);
  ok(/runtime authority ready/.test(aLog), "1 daemon A bound the port + ready");

  const dB = spawn(process.execPath, [daemonScript, "--project", ROOT, "--port", String(PORT)], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT }, stdio: ["ignore", "pipe", "pipe"] });
  let bLog = ""; dB.stdout.on("data", (d) => { bLog += d.toString(); }); dB.stderr.on("data", (d) => { bLog += d.toString(); });
  const bExit = await new Promise((res) => { dB.once("exit", (code) => res(code)); setTimeout(() => res("timeout"), 15000); });
  ok(bExit === 0, "2 daemon B (port taken) exits CLEANLY (code 0), not a crash", `exit=${bExit}`);
  ok(/already owned|exiting cleanly/i.test(bLog), "3 daemon B logs the EADDRINUSE back-off");
  ok(await portOpen(), "4 daemon A still serving after B backed off");
  ok(listenerCount() === 1, "5 exactly ONE process owns the port", `listeners=${listenerCount()}`);
  try { dA.kill(); } catch {}
  await waitPort(false, 5000);
  killPort();

  // ---- Part 2: N MCPs start simultaneously → eager warm-start races → one owner ----
  ok(!(await portOpen()), "6 clean again before the MCP race");
  const N = 4;
  const mcps = Array.from({ length: N }, () => spawnMcp());
  await Promise.all(mcps.map(ready)); // each MCP eager-warm-starts the daemon at startup
  ok(await waitPort(true, 12000), `7 a daemon came up from the ${N}-way MCP eager race`);
  await sleep(800); // let any loser daemons finish backing off
  ok(listenerCount() === 1, "8 exactly ONE daemon owns the port (no duplicates from the race)", `listeners=${listenerCount()}`);

  // every MCP creates a session; all must live in the ONE shared daemon.
  const ids = [];
  for (const m of mcps) { const t = m.text(await m.call("runtime_session_start", { disk_path: DISK, write_protected: true })); const s = (t.match(/Session:\s*(\S+)/) || [])[1]; if (s) ids.push(s); }
  ok(ids.length === N, `9 all ${N} MCPs created a session in the daemon`, ids.join(","));
  let allShared = true;
  for (const s of ids) { const st = mcps[0].text(await mcps[0].call("runtime_session_status", { session_id: s })); if (!/cycles=\d+/.test(st)) allShared = false; }
  ok(allShared, "10 one MCP can status EVERY session — all share the single daemon");
  for (const s of ids) { try { await mcps[0].call("runtime_session_close", { session_id: s }); } catch {} }
} catch (e) {
  console.error("FATAL", e.message); exit = 2;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  await sleep(200);
  killPort();
}

console.log(`\nSpec 744.4c race: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
