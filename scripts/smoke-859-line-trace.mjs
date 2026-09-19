#!/usr/bin/env node
// Spec 859 smoke — the raster line as the VIC saw it.
//
// Runs against its OWN sandbox daemon on a separate port, never the shared one on 4312
// (doctrine rule 2): it boots the machine, freezes it, and asks for lines of the frozen
// picture. The sandbox is born with a budget and killed at the end either way.
//
// Drives exactly what the Inspect overlay does — `vic/inspect/open`, then `vic/line_trace`
// for the clicked line — and then the MCP side, `runtime_vic_line_trace`, which must answer
// the same record and must be visible in the default tool surface.
//
//   node scripts/smoke-859-line-trace.mjs     (needs `npm run build:mcp` and a TRX64
//                                             release daemon with vic/line_trace)

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON = process.env.TRX64_DAEMON_BIN || join(ROOT, "../TRX64/target/release/trx64-daemon");
const PORT = Number(process.env.SMOKE_859_PORT || 4399);
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

const base = mkdtempSync(join(tmpdir(), "c64re-859-"));
mkdirSync(join(base, "knowledge"));
writeFileSync(join(base, "knowledge", "phase-plan.json"), "{}\n");

const daemon = spawn(DAEMON, ["--project", base, "--port", String(PORT), "--headless"], { stdio: ["ignore", "pipe", "pipe"] });
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

let mcp;
try {
  console.log("Spec 859 — the raster line as the VIC saw it\n");
  const ws = await connect(15_000);
  const pending = new Map();
  let nextId = 1;
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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

  const S = (await ok("session/list"))[0]?.sessionId ?? "shared";
  // Boot to READY: text mode, 25 bad lines, the CPU in the KERNAL's input loop.
  await ok("session/run", { session_id: S, cycles: 3_000_000 });
  await ok("checkpoint/capture", { session_id: S });
  await ok("session/run", { session_id: S, cycles: 3 * 19_656 + 4_321 });

  const open = await ok("vic/inspect/open", { session_id: S });
  const cp = open.checkpointId;
  const clkBefore = (await ok("session/state", { session_id: S })).c64Cycles;

  // ── the overlay's click: line 51 ($33) is the first bad line of a text screen ─────
  const t = await ok("vic/line_trace", { session_id: S, checkpoint_id: cp, from: 51, to: 52 });
  check(t.frame.which === "displayed" && t.frame.verified === true,
    "the frame on screen was replayed and reproduces the frozen picture", JSON.stringify({ which: t.frame.which, verified: t.frame.verified }));
  const [l51, l52] = t.lines;
  check(l51.line === 51 && l51.cycles.length === 63 && l51.cycles[0].c === 1 && l51.cycles[62].c === 63,
    "a line is 63 cycles, numbered 1..63");
  check(l51.badLine === true && l52.badLine === false, "line 51 is a bad line, 52 is not");
  const cAcc = l51.cycles.filter((c) => c.phi2.k === "c").length;
  const ba = l51.cycles.filter((c) => c.ba).length;
  check(cAcc === 40 && ba === 43, "the bad line: 40 c-accesses, BA down for 43 cycles", `c=${cAcc} ba=${ba}`);
  const stalls = l51.cycles.filter((c) => c.ba && c.cpu.length === 0).length;
  check(stalls > 30, "the CPU stalls through the bad line", `${stalls} cycles`);
  check(l52.cycles.every((c) => !c.ba), "no BA on a plain text line without sprites");
  check(l51.instructions.length > 0 && l51.instructions.every((i) => typeof i.text === "string" && i.text.length > 0),
    "the instructions that ran on the line are there, disassembled", l51.instructions.slice(0, 3).map((i) => i.text).join(" · "));
  const clkAfter = (await ok("session/state", { session_id: S })).c64Cycles;
  check(clkAfter === clkBefore, "the live machine did not move", `${clkBefore} → ${clkAfter}`);
  const again = await ok("vic/line_trace", { session_id: S, checkpoint_id: cp, from: 200, to: 200 });
  check(again.frame.startClk === t.frame.startClk, "a second line answers from the same recorded frame");
  ws.close();

  // ── the MCP side: the same record, visible by default ──────────────────────────────
  mcp = spawn(process.execPath, [join(ROOT, "dist/cli.js")], {
    cwd: base,
    env: { ...process.env, C64RE_PROJECT_DIR: base, C64RE_RUNTIME_ENDPOINT: ENDPOINT, C64RE_FULL_TOOLS: "" },
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
    const tm = setTimeout(() => { mpending.delete(id); rej(new Error(`timeout ${method}`)); }, 30_000);
    mpending.set(id, (m) => { clearTimeout(tm); res(m); });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-859", version: "0" } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tools = (await rpc("tools/list", {})).result?.tools ?? [];
  check(tools.some((x) => x.name === "runtime_vic_line_trace"), "runtime_vic_line_trace is in the default tool surface");
  const r = await rpc("tools/call", { name: "runtime_vic_line_trace", arguments: { session_id: S, line: 51, checkpoint_id: cp } });
  const text = (r.result?.content ?? []).map((c) => c.text).join("");
  let parsed = null; try { parsed = JSON.parse(text); } catch {}
  check(parsed?.lines?.[0]?.badLine === true && parsed.lines[0].cycles.length === 63,
    "the MCP tool answers the same line", parsed ? `verified=${parsed.frame?.verified}` : text.slice(0, 160));
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

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-859: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
