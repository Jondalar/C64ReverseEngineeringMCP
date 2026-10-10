// C64RE #63 — a plain bounded runtime_session_run advances the machine whether or not a UI
// client is attached to the daemon's A/V stream.
//
// Two daemons of our own (never the shared one), both with the stream hub (the shared UI
// session's configuration): one with no A/V subscriber (the hub exists, its pump thread does
// not — the case that returned "The machine did not advance" for a run the daemon had
// accepted), one with a subscriber (the live capped run). Both must advance ~the budget, and
// the first must say it does not run through a pump. Needs a TRX64 daemon (the sibling build,
// or C64RE_TRX64_BIN).
//
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }
const bin = process.env.C64RE_TRX64_BIN || join(ROOT, "..", "TRX64", "target", "release", "trx64-daemon");
if (!existsSync(bin)) { console.error(`no daemon at ${bin} — set C64RE_TRX64_BIN`); process.exit(2); }
// Run it against the pinned release daemon AND a fixed build: both must advance (an older daemon
// reports a pump it does not have; the client has to notice and run blocking).

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (url) => new Promise((res, rej) => { const w = new WebSocket(url); w.once("open", () => res(w)); w.once("error", rej); });

async function scenario(port, withViewer) {
  const daemon = spawn(bin, ["--port", String(port)], { stdio: "ignore" });
  let viewer, server;
  try {
    for (let i = 0; i < 50; i++) { try { (await open(`ws://127.0.0.1:${port}?av=0`)).close(); break; } catch { await sleep(200); } }
    if (withViewer) { viewer = await open(`ws://127.0.0.1:${port}`); await sleep(300); }
    const proj = mkdtempSync(join(tmpdir(), "c64re-run-adv-"));
    server = spawn(process.execPath, [cli], {
      cwd: tmpdir(),
      env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${port}`, C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = ""; const pending = new Map();
    server.stdout.on("data", (d) => {
      buf += d.toString(); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    });
    let nextId = 1;
    const rpc = (method, params, ms = 120000) => new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, ms);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const call = async (name, args) => {
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.error) throw new Error(`${name}: ${r.error.message}`);
      return (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    };
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-session-run-advance", version: "1" } });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await call("project_init", { project_dir: proj, name: "session-run-advance" });
    await call("agent_onboard", { project_dir: proj });
    const started = await call("runtime_session_start", { project_dir: proj });
    const sid = /session[^\n]*?([A-Za-z0-9_-]{4,})/i.exec(started)?.[1];
    const sidArg = process.env.C64RE_SESSION_ID || "shared";
    const label = withViewer ? "with an A/V subscriber" : "without an A/V subscriber";
    for (let i = 1; i <= 2; i++) {
      const t = await call("runtime_session_run", { session_id: sidArg, max_instructions: 1_000_000, cycle_budget: 1_000_000 });
      const m = /Advanced (\d+) cycles/.exec(t);
      check(m && +m[1] >= 1_000_000, `${label}: bounded run ${i} advances the budget`, (m ? m[0] : t.slice(0, 160)));
      check(withViewer ? /live-streamed/.test(t) : !/live-streamed/.test(t) && !/did not advance/.test(t), `${label}: run ${i} took the ${withViewer ? "live pump" : "blocking"} path`, (/\(Runtime[^)]*\)/.exec(t) ?? [""])[0]);
    }
    void sid;
  } finally {
    viewer?.close(); server?.kill(); daemon.kill();
  }
}

try {
  console.log("C64RE #63 — a bounded runtime_session_run advances, with and without a UI client\n");
  await scenario(47721, false);
  await scenario(47722, true);
} finally { /* daemons killed per scenario */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
