#!/usr/bin/env node
// Spec 858 smoke — the runtime serves the project you are looking at.
//
// Runs against its OWN sandbox daemon on a separate port, never the shared one on 4312:
// switching projects ends a session, and the shared session belongs to the human. The
// sandbox is born with a budget and killed at the end either way (doctrine rule 2).
//
// Drives exactly the calls the UI requester makes — `ping`, `project/set` with `dry_run`,
// `project/set` for real, the `project/changed` broadcast, and the two pickers
// (`media/recent`, `media/list_paths`) — then the MCP side: `runtime_session_status` must
// report a mismatch for the project the daemon was moved away from, and agreement for the
// one it serves.
//
//   node scripts/smoke-858-project-switch.mjs        (needs `npm run build:mcp` and a
//                                                    TRX64 release daemon with project/set)

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON = process.env.TRX64_DAEMON_BIN || join(ROOT, "../TRX64/target/release/trx64-daemon");
const PORT = Number(process.env.SMOKE_858_PORT || 4398);
const ENDPOINT = `ws://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (cond, msg, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};

if (!existsSync(DAEMON)) {
  console.log(`FAIL  no TRX64 daemon at ${DAEMON} — build it (cargo build -p trx64-daemon --release) or set TRX64_DAEMON_BIN`);
  process.exit(1);
}

const base = mkdtempSync(join(tmpdir(), "c64re-858-"));
const A = join(base, "alpha"), B = join(base, "beta");
mkdirSync(A); mkdirSync(B);
writeFileSync(join(A, "alpha.d64"), Buffer.alloc(174_848));
writeFileSync(join(B, "beta.d64"), Buffer.alloc(174_848));
// Both are C64RE projects, so the MCP side resolves them (the marker is what it looks for).
for (const d of [A, B]) {
  mkdirSync(join(d, "knowledge"));
  writeFileSync(join(d, "knowledge", "phase-plan.json"), "{}\n");
}
const rA = realpathSync(A), rB = realpathSync(B);

const daemon = spawn(DAEMON, ["--project", A, "--port", String(PORT), "--headless"], { stdio: ["ignore", "pipe", "pipe"] });
let daemonLog = "";
daemon.stderr.on("data", (d) => { daemonLog += d.toString(); });
const budget = setTimeout(() => { console.log("FAIL  sandbox budget (90 s) exhausted"); daemon.kill("SIGKILL"); process.exit(1); }, 90_000);

const connect = async (deadlineMs) => {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await new Promise((res, rej) => {
        const ws = new WebSocket(ENDPOINT);
        ws.once("open", () => res(ws));
        ws.once("error", rej);
      });
    } catch (e) {
      if (Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
};

/** The daemon's project, asked on a fresh connection. */
const pingProject = async () => {
  const p = await connect(5_000);
  const v = await new Promise((res) => {
    p.on("message", (d, bin) => { if (!bin) { const m = JSON.parse(d.toString()); if (m.id === 1) res(m); } });
    p.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }));
  });
  p.close();
  return v.result?.project;
};

let mcp;
try {
  console.log("Spec 858 — the runtime serves the project you are looking at\n");
  const ws = await connect(15_000);
  const notes = [];
  const pending = new Map();
  let nextId = 1;
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) notes.push(msg);
  });
  const call = (method, params = {}) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  const ok = async (method, params) => {
    const r = await call(method, params);
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  };
  const recent = async () => (await ok("media/recent")).map((e) => e.path);

  // ── the daemon names its project ────────────────────────────────────────────────────
  const ping = await ok("ping");
  check(ping.project === A || ping.project === rA, "ping names the project the daemon was started for", ping.project);

  // ── the requester's question: a dry run changes nothing ─────────────────────────────
  const dry = await ok("project/set", { path: B, dry_run: true });
  check(dry.same === false && dry.changed === false, "a different project is reported, and nothing changes");
  check(dry.current === rA && dry.requested === rB, "on canonical paths", `${dry.current} → ${dry.requested}`);
  check((await ok("ping")).project !== rB, "the dry run left the daemon where it was");
  const inA = await recent();
  check(inA.some((p) => p.endsWith("/alpha.d64")) && !inA.some((p) => p.endsWith("/beta.d64")),
    "the picker shows the daemon's project — this is the empty-dropdown situation", inA.join(", "));

  // ── the requester's answer: switch ──────────────────────────────────────────────────
  const moved = await ok("project/set", { path: B });
  check(moved.changed === true && moved.project === rB && moved.previous === rA, "the daemon moves", JSON.stringify(moved));
  await new Promise((r) => setTimeout(r, 200));
  const changed = notes.find((n) => n.method === "project/changed");
  check(changed?.params?.project === rB && changed?.params?.previous === rA, "every client is told (project/changed)");
  const inB = await recent();
  check(inB.some((p) => p.endsWith("/beta.d64")) && !inB.some((p) => p.endsWith("/alpha.d64")),
    "the picker follows the move", inB.join(", "));
  const roots = await ok("media/list_paths");
  check(roots.find((r) => r.label === "project")?.path === rB, "the media browser's project root follows too");
  const same = await ok("project/set", { path: B });
  check(same.changed === false && same.same === true, "asking again for the same project is a no-op");
  ws.close();

  // ── the MCP side reports and never switches ─────────────────────────────────────────
  mcp = spawn(process.execPath, [join(ROOT, "dist/cli.js")], {
    cwd: tmpdir(),
    // No C64RE_PROJECT_DIR: it would outrank the tool's project_dir, and the point is to
    // ask about two different projects from one server.
    env: (({ C64RE_PROJECT_DIR: _drop, ...rest }) => ({ ...rest, C64RE_RUNTIME_ENDPOINT: ENDPOINT, C64RE_FULL_TOOLS: "" }))(process.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const mpending = new Map();
  mcp.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && mpending.has(m.id)) { mpending.get(m.id)(m); mpending.delete(m.id); }
    }
  });
  let mid = 1;
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = mid++;
    const t = setTimeout(() => { mpending.delete(id); rej(new Error(`timeout ${method}`)); }, 30_000);
    mpending.set(id, (m) => { clearTimeout(t); res(m); });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-858", version: "0" } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const status = async (project_dir) => {
    const r = await rpc("tools/call", { name: "runtime_session_status", arguments: { session_id: "shared", project_dir } });
    return (r.result?.content ?? []).map((c) => c.text).join("\n") || JSON.stringify(r.error ?? r);
  };
  const away = await status(A);
  check(/projectMismatch/.test(away) && away.includes(rB), "runtime_session_status reports the mismatch for the project the daemon left",
    away.split("\n").find((l) => l.startsWith("Project:")) ?? away.slice(0, 200));
  check(await pingProject() === rB, "and asking did not move the daemon back");
  const here = await status(B);
  check(/the runtime serves this project/.test(here), "and agreement for the project it serves",
    here.split("\n").find((l) => l.startsWith("Project:")) ?? here.slice(0, 200));
} catch (e) {
  fail++;
  console.log(`  FAIL  ${e instanceof Error ? e.message : String(e)}`);
  if (daemonLog) console.log(daemonLog.split("\n").slice(-15).join("\n"));
} finally {
  clearTimeout(budget);
  mcp?.kill();
  daemon.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-858: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
