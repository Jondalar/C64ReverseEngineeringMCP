#!/usr/bin/env node
// A stand-in for trx64-daemon, for the shutdown acceptance when no TRX64 binary is present (the
// Windows CI job has none). It speaks the part of the wire the process lifecycle touches: `ping`
// and `daemon/shutdown`. Arguments are the daemon's (--project <dir> --port <p> [--idle-exit s]);
// C64RE_RUNTIME_BIN may point at this script (the resolver runs a .mjs with node).
//
//   STUB_DAEMON_MODE=normal      daemon/shutdown answers the TRX64 902 shape, closes, exits 0
//   STUB_DAEMON_MODE=old         a runtime from before 902: no daemon/shutdown (-32601), SIGTERM kills it
//   STUB_DAEMON_MODE=stubborn    accepts daemon/shutdown and SIGTERM and does not end (only a hard stop does)
import { WebSocketServer } from "ws";

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(arg("--port"));
const project = arg("--project") ?? null;
const mode = process.env.STUB_DAEMON_MODE ?? "normal";

const wss = new WebSocketServer({ host: "127.0.0.1", port });
wss.on("listening", () => console.error(`[stub-daemon] ${mode} listening on ${port}`));
wss.on("error", (e) => { console.error(`[stub-daemon] ${e.message}`); process.exit(e.code === "EADDRINUSE" ? 0 : 1); });

let ending = false;
function end(reason) {
  if (ending || mode === "stubborn") return;
  ending = true;
  for (const c of wss.clients) { try { c.close(1001, reason); } catch { /* */ } }
  wss.close();
  setTimeout(() => process.exit(0), 100);
}
if (mode === "stubborn") for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { /* will not end */ });
else if (mode !== "old") for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => end(s));

wss.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(String(data)); } catch { return; }
    const reply = (o) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...o }));
    if (m.method === "ping") return reply({ result: { runtime_version: "trx64-runtime/2", version: `stub-${mode}`, project, idleExit: { armedSeconds: 0, deadlineMs: null, holding: null, keptAliveUntilMs: null, keptForever: false } } });
    if (m.method === "daemon/shutdown" && mode !== "old") {
      reply({ result: { ok: true, persisted: { cartridge: null, disks: [] }, trace: null, exitCode: 0 } });
      setTimeout(() => end("request"), 50);
      return;
    }
    reply({ error: { code: -32601, message: `method not found: ${m.method}` } });
  });
});
