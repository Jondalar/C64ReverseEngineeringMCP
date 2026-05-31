// Spec 744.4b — REAL shared authority across the actual product surfaces. One node
// process (dist/cli.js with C64RE_RUNTIME_WS set) hosts BOTH the MCP stdio server
// AND the Live runtime WS server, sharing the runtimeSessions singleton. Proves:
//   - a session created via MCP stdio is visible + controllable over the real WS
//   - a WS debug/run|pause changes the SAME run-state/cycles MCP status reads
//   - the WS-side default session (booted by the host) is visible to MCP
// i.e. the LLM (MCP) and the human (WS) operate on the same session ids — not mirrors.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const DISK = join(ROOT, "samples/synthetic/1byte.g64");
const WS_PORT = 14732;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("Spec 744.4b — MCP stdio + Live WS share ONE authority in ONE process\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }

const proc = spawn(process.execPath, [cli], {
  cwd: ROOT,
  env: { ...process.env, C64RE_PROJECT_DIR: ROOT, C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_WS: String(WS_PORT) },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = ""; proc.stderr.on("data", (d) => { stderr += d.toString(); });

// ---- MCP stdio client ----
let buf = ""; const pending = new Map();
proc.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
let mid = 1;
const mrpc = (method, params, t = 30000) => new Promise((res, rej) => { const id = mid++; const timer = setTimeout(() => { pending.delete(id); rej(new Error(`mcp timeout ${method}`)); }, t); pending.set(id, (m) => { clearTimeout(timer); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const mcall = async (name, args) => { const r = await mrpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.result; };
const mtext = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const cyclesOf = (t) => { const m = t.match(/cycles=(\d+)/); return m ? Number(m[1]) : NaN; };
const runStateOf = (t) => { const m = t.match(/run.?state[:=]\s*(\w+)/i); return m ? m[1] : (/running/i.test(t) ? "running" : "paused"); };

// ---- WS client ----
function wsRpc(ws, method, params, id) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`ws timeout ${method}`)), 15000);
    const onMsg = (data, isBin) => { if (isBin) return; let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id === id) { clearTimeout(timer); ws.off("message", onMsg); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

let exit = 0;
try {
  // wait for the host to print the WS-up line (or fail)
  for (let i = 0; i < 60 && !/hosting Live runtime WS/.test(stderr); i++) await sleep(150);
  ok(/hosting Live runtime WS/.test(stderr), "MCP process co-hosts the Live runtime WS", (stderr.match(/hosting[^\n]*/) || [""])[0]);

  // MCP handshake + create a session through MCP.
  await mrpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-744-4b", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const start = await mcall("runtime_session_start", { disk_path: DISK, write_protected: true });
  const mcpSid = (mtext(start).match(/Session:\s*(\S+)/) || [])[1];
  ok(!!mcpSid, "MCP runtime_session_start created a session", mcpSid);

  // WS connects to the SAME process and lists sessions → MCP session is visible.
  let ws;
  for (let i = 0; i < 40; i++) { try { ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`); await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); }); break; } catch { await sleep(150); } }
  ok(!!ws && ws.readyState === WebSocket.OPEN, "WS client connected to the co-hosted port");
  const list = await wsRpc(ws, "session/list", {}, 1);
  const ids = (list?.sessions ?? list ?? []).map((s) => s.sessionId ?? s.session_id ?? s.id ?? s);
  ok(ids.includes(mcpSid), "WS session/list shows the MCP-created session (MCP→UI visibility)", ids.join(","));

  // WS reads the same session state.
  const wsState = await wsRpc(ws, "session/state", { session_id: mcpSid }, 2);
  const mcpCyc0 = cyclesOf(mtext(await mcall("runtime_session_status", { session_id: mcpSid })));
  ok(typeof wsState.c64Cycles === "number" && wsState.c64Cycles === mcpCyc0,
    "WS and MCP read the SAME cycle counter for the session", `ws=${wsState.c64Cycles} mcp=${mcpCyc0}`);

  // WS drives the session (Live Run) → MCP status sees the run-state + advance.
  await wsRpc(ws, "debug/run", { session_id: mcpSid }, 3);
  await sleep(600);
  const mcpAfterRun = mtext(await mcall("runtime_session_status", { session_id: mcpSid }));
  ok(cyclesOf(mcpAfterRun) > mcpCyc0, "WS debug/run advanced the SAME session MCP reads (UI→MCP control)", `${mcpCyc0} → ${cyclesOf(mcpAfterRun)}`);
  await wsRpc(ws, "debug/pause", { session_id: mcpSid }, 4);
  await sleep(200);
  const mcpAfterPause = cyclesOf(mtext(await mcall("runtime_session_status", { session_id: mcpSid })));
  await sleep(400);
  const mcpStillPaused = cyclesOf(mtext(await mcall("runtime_session_status", { session_id: mcpSid })));
  ok(mcpStillPaused === mcpAfterPause, "WS debug/pause stopped the session MCP reads (no further advance)", `${mcpAfterPause} == ${mcpStillPaused}`);

  // The WS-side default session (booted by the host) is visible to MCP.
  const defId = ids.find((x) => x !== mcpSid);
  if (defId) {
    const defStatus = mtext(await mcall("runtime_session_status", { session_id: defId }));
    ok(/cycles=\d+/.test(defStatus), "MCP can status the WS-booted default session (UI→MCP visibility)", defId);
  } else {
    ok(false, "a WS-side default session exists for MCP to see", "none in list");
  }

  await mcall("runtime_session_close", { session_id: mcpSid });
  ws.close();
} catch (e) {
  console.error("FATAL", e.message); console.error(stderr.slice(-800)); exit = 2;
} finally {
  proc.stdin.end(); proc.kill();
}

console.log(`\nSpec 744.4b: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
