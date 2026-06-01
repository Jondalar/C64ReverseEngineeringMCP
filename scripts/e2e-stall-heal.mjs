// Spec 746.x — daemon STALL self-heal. A wedged daemon (100% CPU, dead event loop —
// the BUG-027-B3 zombie) holds the port but never answers ping. Before this fix,
// ensureDaemon saw the port held ("already-up") and never replaced it, so no session
// came up. Now: liveness-probe (ping) detects stall → kill the wedged proc → respawn.
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
const PORT = 14799;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => { try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {} };
const listening = () => new Promise((res) => { const w = new WebSocket(ENDPOINT); const t = setTimeout(() => { w.terminate(); res(false); }, 1200); w.once("open", () => { clearTimeout(t); w.close(); res(true); }); w.once("error", () => { clearTimeout(t); res(false); }); });

console.log("Spec 746.x — daemon STALL self-heal (detect wedged daemon, kill, respawn)\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }
killPort();

let exit = 0;
const procs = [];
try {
  // 1) Spawn a FAKE STALLED daemon AS A SEPARATE PROCESS: a WS server that ACCEPTS
  //    connections (port held, socket opens) but NEVER replies (dead event loop sim).
  //    MUST be its own process — killStalledDaemon does `lsof :port | kill -9`, which
  //    would kill THIS gate if the fake server ran in-process.
  const fakeSrc = `
    import { WebSocketServer } from "ws";
    const s = new WebSocketServer({ port: ${PORT}, host: "127.0.0.1" });
    s.on("connection", () => {}); // accept, never reply
    setInterval(() => {}, 1 << 30); // keep alive
  `;
  const fake = spawn(process.execPath, ["--input-type=module", "-e", fakeSrc], { cwd: ROOT, stdio: "ignore" });
  procs.push(fake);
  for (let i = 0; i < 40 && !(await listening()); i++) await sleep(150);
  ok(await listening(), "0 fake stalled daemon (separate proc) holds the port (socket opens)");

  // 2+3) ensureDaemon must: detect stall (no pong) → kill the fake → spawn a REAL daemon.
  const { ensureDaemon } = await import(join(ROOT, "dist/server-tools/runtime-daemon-client.js"));
  const r = await ensureDaemon({ endpoint: ENDPOINT, projectDir: ROOT });
  ok(r === "spawned", "1 ensureDaemon detected the stall + spawned a replacement (not 'already-up')", `result=${r}`);

  // 4) the fake stalled server is dead now (killed). Its WS server object should be gone
  //    from the port; wait for the REAL daemon to bind + answer ping (healthy).
  let healthy = false;
  for (let i = 0; i < 80; i++) {
    await sleep(400);
    const pong = await new Promise((res) => {
      const w = new WebSocket(ENDPOINT);
      const t = setTimeout(() => { w.terminate(); res(false); }, 1000);
      w.once("open", () => { w.on("message", (d) => { try { if (JSON.parse(d.toString()).id === 42) { clearTimeout(t); w.close(); res(true); } } catch {} }); w.send(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "ping", params: {} })); });
      w.once("error", () => { clearTimeout(t); res(false); });
    });
    if (pong) { healthy = true; break; }
  }
  ok(healthy, "2 the FRESH daemon bound the freed port + answers ping (self-heal complete)");

  // 5) and it has a session (the real daemon creates the default session).
  if (healthy) {
    const got = await new Promise((res) => {
      const w = new WebSocket(ENDPOINT); let id = 1;
      const t = setTimeout(() => { w.terminate(); res(null); }, 3000);
      w.once("open", () => { w.on("message", (d) => { try { const m = JSON.parse(d.toString()); if (m.id === 1) { clearTimeout(t); w.close(); res(m.result); } } catch {} }); w.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/list", params: {} })); });
      w.once("error", () => { clearTimeout(t); res(null); });
    });
    ok(Array.isArray(got) && got.length > 0, "3 the fresh daemon has the default session (recovered fully)", got && got[0] && got[0].sessionId);
  } else {
    ok(false, "3 fresh daemon session (skipped — never healthy)");
  }
} catch (e) {
  console.error("FATAL", e.message); exit = 2;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  await sleep(200); killPort();
}
console.log(`\nSpec 746.x stall-heal: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
