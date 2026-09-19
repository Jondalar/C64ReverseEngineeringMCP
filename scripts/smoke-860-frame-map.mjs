#!/usr/bin/env node
// Spec 860 smoke — the frozen frame as a view.
//
// Runs against its OWN sandbox daemon on a separate port, never the shared one on 4312
// (doctrine rule 2): it boots the machine, freezes it, and asks for lines of the frozen
// picture. The sandbox is born with a budget and killed at the end either way.
//
// Injects a raster split through the monitor — at line $80 the charset flips to $1800, the
// border goes red mid-line and sprite 0 moves down; at the top of the frame all three flip
// back — then drives what the VIC view does: `vic/inspect/open`, `vic/frame_map`. The map
// must name the objects on both sides of the split with their bytes, the split itself, the
// multiplexed sprite and the mid-line store; the MCP tool must answer the same.
//
//   node scripts/smoke-860-frame-map.mjs     (needs `npm run build:mcp` and a TRX64
//                                            release daemon with vic/frame_map)

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON = process.env.TRX64_DAEMON_BIN || join(ROOT, "../TRX64/target/release/trx64-daemon");
const PORT = Number(process.env.SMOKE_860_PORT || 4396);
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

const base = mkdtempSync(join(tmpdir(), "c64re-860-"));
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
  console.log("Spec 860 — the frozen frame as a view\n");
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
  const hexb = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const mon = (S, command) => ok("monitor/exec", { session_id: S, command });

  const S = (await ok("session/list"))[0]?.sessionId ?? "shared";
  await ok("session/run", { session_id: S, cycles: 3_000_000 }); // READY
  const prog = [
    0x78, 0xA9, 0x7F, 0x8D, 0x0D, 0xDC,
    0xA9, 0x80, 0xCD, 0x12, 0xD0, 0xD0, 0xFB,
    0xA9, 0x17, 0x8D, 0x18, 0xD0,
    0xA9, 0x02, 0x8D, 0x20, 0xD0,
    0xA9, 0xA0, 0x8D, 0x01, 0xD0,
    0xA9, 0x10, 0xCD, 0x12, 0xD0, 0xD0, 0xFB,
    0xA9, 0x15, 0x8D, 0x18, 0xD0,
    0xA9, 0x0E, 0x8D, 0x20, 0xD0,
    0xA9, 0x3C, 0x8D, 0x01, 0xD0,
    0x4C, 0x06, 0xC0,
  ];
  await mon(S, `wr c000 ${hexb(prog)}`);
  await mon(S, `wr 0340 ${hexb(new Array(63).fill(0xff))}`);
  await mon(S, "wr 07f8 0d");
  await mon(S, "wr 065d 08 05 0c 0c 0f"); // HELLO on row 15, column 5 ($0400 + 605)
  await mon(S, "wr io d000 80 3c");
  await mon(S, "wr io d015 01");
  await mon(S, "r pc=c000");
  await ok("session/run", { session_id: S, cycles: 3 * 19_656 });
  await ok("checkpoint/capture", { session_id: S });
  await ok("session/run", { session_id: S, cycles: 3 * 19_656 + 4_321 });

  const open = await ok("vic/inspect/open", { session_id: S });
  const cp = open.checkpointId;
  const clkBefore = (await ok("session/state", { session_id: S })).c64Cycles;
  const fm = await ok("vic/frame_map", { session_id: S, checkpoint_id: cp });

  check(fm.frame.which === "displayed" && fm.frame.verified === true, "the frame on screen, replayed and verified", JSON.stringify(fm.frame.verified));
  check(fm.cells.length === 312 && fm.cells[51].length === 63, "the grid is 312 lines × 63 cycles");
  const disp = fm.objects.filter((o) => o.kind === "display");
  check(disp.some((o) => o.dataBase === 0x1000 && o.rom && o.y < 128 - 16), "above the split: an object in the ROM charset $1000");
  const hello = disp.find((o) => o.dataBase === 0x1800);
  check(hello && hello.cells === 5 && hello.ranges.screen[0].addr === 0x065d && hello.ranges.screen[0].length === 5,
    "below it: HELLO, five cells, screen $065d+5, charset $1800", hello?.label ?? "missing");
  const s0 = fm.objects.filter((o) => o.kind === "sprite" && o.sprite === 0);
  check(s0.length === 2 && s0.every((o) => o.h === 21 && o.ranges.sprite[0].addr === 0x0340), "sprite 0: two appearances of 21 lines, data at $0340");
  const t = fm.techniques;
  const split = t.find((x) => x.rule === "split");
  check(split && /\$D018 \$15→\$17/.test(split.detail) && [128, 129].includes(split.lines[0]), "the split is named, with its line and register", split?.detail ?? "missing");
  check(t.some((x) => x.rule === "multiplexer"), "the multiplexer is named");
  check(t.some((x) => x.rule === "mid_line" && /\$D020/.test(x.detail)), "the mid-line border store is named");
  check(!t.some((x) => ["fli", "fld", "linecrunch", "dma_delay"].includes(x.rule)), "and nothing that is not there", t.map((x) => x.rule).join(","));
  const w = fm.writes.find((x) => x.reg === 0x20 && x.line === 128);
  check(w && w.midLine && w.x != null, "the $D020 store sits at the pixel it lands on", w ? `cycle ${w.cycle}, x ${w.x}` : "missing");
  check((await ok("session/state", { session_id: S })).c64Cycles === clkBefore, "the live machine did not move");
  const slim = await ok("vic/frame_map", { session_id: S, checkpoint_id: cp, include_cells: false });
  check(slim.cells === undefined && slim.objects.length === fm.objects.length, "include_cells:false leaves the grid out and nothing else");
  ws.close();

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
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-860", version: "0" } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tools = (await rpc("tools/list", {})).result?.tools ?? [];
  check(tools.some((x) => x.name === "runtime_vic_frame_map"), "runtime_vic_frame_map is in the default tool surface");
  const r = await rpc("tools/call", { name: "runtime_vic_frame_map", arguments: { session_id: S, checkpoint_id: cp } });
  const text = (r.result?.content ?? []).map((c) => c.text).join("");
  let parsed = null; try { parsed = JSON.parse(text); } catch {}
  check(parsed && parsed.cells === undefined && parsed.techniques.some((x) => x.rule === "split"),
    "the MCP tool answers the same map, without the grid by default", parsed ? parsed.techniques.map((x) => x.rule).join(",") : text.slice(0, 160));
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

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-860: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
