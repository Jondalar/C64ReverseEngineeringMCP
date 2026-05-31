// Spec 744.4b hardening — a fresh external project, launched per its .mcp.json,
// gets the co-hosted Live WS by default. Generates a .mcp.json (from the repo's
// mcp-config-example.json) for a temp project OUTSIDE the repo, inspects it, then
// launches the c64-re server exactly as that config specifies (its env, incl.
// C64RE_RUNTIME_WS) and proves the MCP process co-hosts the WS and both surfaces
// see the same authority — i.e. the install template is product-correct.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const WS_PORT = 14733;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("Spec 744.4b — fresh external project launched from .mcp.json co-hosts the WS\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }

// --- 1. The shipped example template carries C64RE_RUNTIME_WS (so new installs get it).
const example = JSON.parse(readFileSync(join(ROOT, "mcp-config-example.json"), "utf8"));
ok(example.mcpServers?.["c64-re"]?.env?.C64RE_RUNTIME_WS === "4312",
  "mcp-config-example.json sets C64RE_RUNTIME_WS=4312 by default",
  String(example.mcpServers?.["c64-re"]?.env?.C64RE_RUNTIME_WS));

// --- 2. Generate a real .mcp.json for a temp project OUTSIDE the repo from the template.
const proj = mkdtempSync(join(tmpdir(), "c64re-install-"));
ok(!proj.startsWith(ROOT), "temp project is outside the repo", proj);
const cfg = JSON.parse(JSON.stringify(example));
cfg.mcpServers["c64-re"].env.C64RE_PROJECT_DIR = proj;
cfg.mcpServers["c64-re"].env.C64RE_RUNTIME_WS = String(WS_PORT);
writeFileSync(join(proj, ".mcp.json"), JSON.stringify(cfg, null, 2));
const launch = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8")).mcpServers["c64-re"];
ok(!!launch.env.C64RE_RUNTIME_WS, "generated .mcp.json carries C64RE_RUNTIME_WS (UI-share on by default)");

// --- 3. Launch the c64-re server with the config's env (the MCP host's launch).
const proc = spawn(process.execPath, [cli], {
  cwd: ROOT,
  env: { ...process.env, ...launch.env, C64RE_FULL_TOOLS: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = ""; proc.stderr.on("data", (d) => { stderr += d.toString(); });
let buf = ""; const pending = new Map();
proc.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
let mid = 1;
const mrpc = (method, params, t = 30000) => new Promise((res, rej) => { const id = mid++; const timer = setTimeout(() => { pending.delete(id); rej(new Error(`mcp timeout ${method}`)); }, t); pending.set(id, (m) => { clearTimeout(timer); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const mcall = async (name, args) => { const r = await mrpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.result; };
const mtext = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
function wsRpc(ws, method, params, id) {
  return new Promise((res, rej) => { const timer = setTimeout(() => rej(new Error(`ws timeout ${method}`)), 15000); const onMsg = (data, isBin) => { if (isBin) return; let m; try { m = JSON.parse(data.toString()); } catch { return; } if (m.id === id) { clearTimeout(timer); ws.off("message", onMsg); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; ws.on("message", onMsg); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
}

let exit = 0;
try {
  // MCP must respond fast even though it co-hosts the WS (no startup block).
  const t0 = Date.now();
  await mrpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "install", version: "1" } });
  ok(Date.now() - t0 < 8000, "MCP responds to initialize quickly (co-host does not block startup)", `${Date.now() - t0}ms`);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  for (let i = 0; i < 40 && !/hosting Live runtime WS/.test(stderr); i++) await sleep(150);
  ok(/hosting Live runtime WS/.test(stderr), "MCP launched from .mcp.json co-hosts the Live WS by default", (stderr.match(/hosting[^\n]*/) || [""])[0]);

  let ws;
  for (let i = 0; i < 40; i++) { try { ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`); await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); }); break; } catch { await sleep(150); } }
  ok(!!ws && ws.readyState === WebSocket.OPEN, "UI WS connects to the same process");
  const list = await wsRpc(ws, "session/list", {}, 1);
  const ids = (list?.sessions ?? list ?? []).map((s) => s.sessionId ?? s.session_id ?? s.id ?? s);
  ok(ids.length >= 1, "WS sees the co-hosted default session", ids.join(","));
  const st = mtext(await mcall("runtime_session_status", { session_id: ids[0] }));
  ok(/cycles=\d+/.test(st), "MCP can status the WS-visible session by id (one shared authority)", ids[0]);
  ws.close();
} catch (e) {
  console.error("FATAL", e.message); console.error(stderr.slice(-600)); exit = 2;
} finally {
  proc.stdin.end(); proc.kill();
}

console.log(`\nSpec 744.4b install: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
