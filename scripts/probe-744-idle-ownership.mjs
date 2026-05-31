// Spec 744.4 / 744.3 — MCP runtime mode is idle-bounded. Through the REAL MCP stdio
// server: runtime_session_start (with and without trace_out) must NOT leave an
// autonomous run loop — after a short idle wait with no run call, the cycle counter
// does not advance. runtime_session_close releases. (744.3 added the close tool but
// the real idle-safety is that start/run never schedule a background loop; this probe
// enforces it on the actual tool/server path, not a unit shortcut.)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const DISK = join(ROOT, "samples/synthetic/1byte.g64");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 744.4 — MCP runtime is idle-bounded (no autonomous runloop)\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }

const proc = spawn(process.execPath, [cli], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: ROOT, C64RE_FULL_TOOLS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
let stderr = ""; proc.stderr.on("data", (d) => { stderr += d.toString(); });
let buf = ""; const pending = new Map();
proc.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
let nextId = 1;
const rpc = (method, params, t = 30000) => new Promise((res, rej) => { const id = nextId++; const timer = setTimeout(() => { pending.delete(id); rej(new Error(`timeout ${method}`)); }, t); pending.set(id, (m) => { clearTimeout(timer); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const callTool = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.result; };
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const cyclesOf = (statusText) => { const m = statusText.match(/cycles=(\d+)/); return m ? Number(m[1]) : NaN; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let exit = 0;
try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe-744-idle", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  async function idleCheck(label, startArgs) {
    const start = await callTool("runtime_session_start", startArgs);
    const startText = textOf(start);
    const sid = (startText.match(/Session:\s*(\S+)/) || [])[1];
    ok(!!sid, `${label}: session started`, sid || startText.slice(0, 60));
    const c0 = cyclesOf(textOf(await callTool("runtime_session_status", { session_id: sid })));
    await sleep(1500);                      // idle: no run call in flight
    const c1 = cyclesOf(textOf(await callTool("runtime_session_status", { session_id: sid })));
    ok(Number.isFinite(c0) && c1 === c0, `${label}: cycles do NOT advance while idle (no background loop)`, `${c0} → ${c1}`);
    const closed = textOf(await callTool("runtime_session_close", { session_id: sid }));
    ok(/closed|released/i.test(closed), `${label}: runtime_session_close releases the session`, closed.split("\n")[0]);
    // after close, the session is gone
    const gone = textOf(await callTool("runtime_session_close", { session_id: sid }));
    ok(/not open|already closed|no-op/i.test(gone), `${label}: second close is a no-op (session released)`);
  }

  await idleCheck("no-trace", { disk_path: DISK, write_protected: true });
  await idleCheck("with-trace", { disk_path: DISK, write_protected: true, trace_out: "analysis/runs/idle-probe.duckdb", trace_domains: ["c64-cpu"] });
} catch (e) {
  console.error("FATAL", e.message); console.error(stderr.slice(-600)); exit = 2;
} finally {
  proc.stdin.end(); proc.kill();
}

console.log(`\nSpec 744.4 idle: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
