#!/usr/bin/env node
// Spec 804 smoke — the monitor with names, end to end, against a sandbox runtime.
//
// Its OWN daemon on its own port, never the shared one on 4312 (doctrine rule 2), born
// with a budget and killed at the end either way. Between the MCP server and that daemon
// sits a recording relay, so the smoke can assert the EXACT command string the runtime
// received — the substitution rule's contract — rather than trusting C64RE's own report.
//
//   node scripts/smoke-804-monitor.mjs   (needs `npm run build` and a TRX64 release daemon
//                                         with monitor spans: TRX64_DAEMON_BIN=…)

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { buildFixture804, startMcp } from "./lib/fixture-804.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON = process.env.TRX64_DAEMON_BIN || join(ROOT, "../TRX64/target/release/trx64-daemon");
const PORT = Number(process.env.SMOKE_804_PORT || 4398);
const RELAY = PORT + 1;

let pass = 0, fail = 0;
const check = (cond, msg, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};

if (!existsSync(DAEMON)) {
  console.log(`FAIL  no TRX64 daemon at ${DAEMON} — build it (cargo build -p trx64-daemon --release) or set TRX64_DAEMON_BIN`);
  process.exit(1);
}

console.log("Spec 804 — the monitor with names, against a sandbox runtime\n");
const { dir, paths } = await buildFixture804(ROOT);

const daemon = spawn(DAEMON, ["--project", dir, "--port", String(PORT), "--headless"], { stdio: ["ignore", "pipe", "pipe"] });
let daemonLog = "";
daemon.stderr.on("data", (d) => { daemonLog += d.toString(); });
const budget = setTimeout(() => { console.log("FAIL  sandbox budget (150 s) exhausted"); daemon.kill("SIGKILL"); process.exit(1); }, 150_000);

// ---- the recording relay: every request the runtime receives, verbatim
const received = [];
const relay = new WebSocketServer({ port: RELAY });
relay.on("connection", (client) => {
  const upstream = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const queue = [];
  upstream.on("open", () => { for (const m of queue.splice(0)) upstream.send(m); });
  upstream.on("message", (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }); });
  upstream.on("close", () => client.close());
  client.on("message", (data) => {
    const text = data.toString();
    try { received.push(JSON.parse(text)); } catch { /* not json */ }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text); else queue.push(text);
  });
  client.on("close", () => upstream.close());
});

const connect = async (url, deadlineMs) => {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await new Promise((res, rej) => { const ws = new WebSocket(url); ws.once("open", () => res(ws)); ws.once("error", rej); });
    } catch (e) {
      if (Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
};

let mcp;
let ui;
try {
  // Boot the sandbox machine directly (not through the relay: setup is not under test).
  const ws = await connect(`ws://127.0.0.1:${PORT}`, 15_000);
  const pending = new Map();
  let nextId = 1;
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  const S = (await call("session/list"))[0]?.sessionId ?? "shared";
  await call("session/run", { session_id: S, cycles: 2_500_000 });

  mcp = startMcp(ROOT, { C64RE_PROJECT_DIR: dir, C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${RELAY}`, C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "" });
  const tools = await mcp.init();
  for (const t of ["runtime_monitor", "runtime_monitor_disasm", "runtime_resolve_pc"]) {
    check(tools.some((x) => x.name === t), `${t} is in the default tool surface`);
  }
  const mon = async (command) => (await mcp.tool("runtime_monitor", { session_id: S, command })).text;
  const monFull = (command) => mcp.tool("runtime_monitor", { session_id: S, command });
  const sentCommands = () => received.filter((m) => m.method === "monitor/exec").map((m) => m.params.command);

  console.log("[output — names at the runtime's spans]");
  await mon(`load "${paths.alpha}"`);
  const d = await mon("d 1000 1012");
  check(/^\$1000  alpha_main\[u\] {9}20 10 10/mu.test(d), "d: the instruction's own address is named, in the 20-wide label column", d.split("\n").slice(0, 2).join(" / "));
  check(/JSR \$1010\s+; set_border\[u\]/u.test(d), "d: the JSR target is named in the annotation column, the number stays", d.split("\n")[0]);
  check(/^\$1010  set_border\[u\]\s+a9 01/mu.test(d), "d: the routine's own line is named");
  const m = await mon("m 1000 101f");
  check(/; \+\$00 alpha_main\[u\], \+\$10 set_border\[u\]$/u.test(m.split("\n")[0]), "m: a dump row carries its names in the annotation column", m.split("\n")[0]);
  const dFull = await monFull("d 1000 1002");
  const mFull = await monFull("m 1000 101f");
  check(/; .*\[u\]/u.test(dFull.text) && /; \+\$00 .*\[u\]/u.test(mFull.text) && dFull.structured === undefined && mFull.structured === undefined,
    "two verbs, one decoration: both replies carry their names in the text, and nothing hides it behind a structured half", `${dFull.text.split("\n")[0]} / ${mFull.text.split("\n")[0]}`);

  console.log("\n[input — names in, the exact string the runtime received]");
  const before = sentCommands().length;
  await mon("a 1100 jmp set_border");
  await mon(""); // an empty line leaves assemble mode
  const sentA = sentCommands().slice(before);
  check(sentA.includes("a 1100 jmp $1010"), "`a 1100 jmp set_border` reached the runtime as `a 1100 jmp $1010`", JSON.stringify(sentA));
  const mem = await mcp.tool("runtime_monitor_memory", { session_id: S, start: 0x1100, end: 0x1102 });
  check(/4c 10 10/u.test(mem.text), "…and the machine holds JMP $1010 there", mem.text.split("\n")[1]);
  const before2 = sentCommands().length;
  await mon("a 1103 lda abc");
  await mon("");
  const sentB = sentCommands().slice(before2);
  check(sentB.includes("a 1103 lda abc"), "`a 1103 lda abc` reached the runtime unchanged (numeric parse wins)", JSON.stringify(sentB));
  const mem2 = await mcp.tool("runtime_monitor_memory", { session_id: S, start: 0x1103, end: 0x1105 });
  check(/ad bc 0a/u.test(mem2.text), "…and assembled LDA $0ABC", mem2.text.split("\n")[1]);
  const before3 = sentCommands().length;
  const unk = await mon("m no_such_name");
  check(sentCommands().slice(before3).includes("m no_such_name") && /error/iu.test(unk), "an unknown name goes through as typed and the runtime refuses it", unk.split("\n").pop());

  console.log("\n[structured surfaces]");
  const dis = (await mcp.tool("runtime_monitor_disasm", { session_id: S, addr: 0x1000, count: 3 })).text;
  check(/; \$1000=alpha_main\[u\]/u.test(dis) && /\$1010=set_border\[u\]/u.test(dis), "runtime_monitor_disasm names addr and target from the numeric fields", dis.split("\n")[0]);
  const rp = JSON.parse((await mcp.tool("runtime_resolve_pc", { session_id: S, pc: 0x1010 })).text);
  check(rp.name === "set_border[u]" && rp.payload === "alpha", "runtime_resolve_pc answers from the graph", `${rp.name} · ${rp.payload}`);
  check(!received.some((m) => m.method === "runtime/call" && /^resolvePcs?$/u.test(String(m.params?.op))), "…and never asks the runtime's resolvePc");

  console.log("\n[the workbench monitor — POST /api/monitor/exec]");
  const uiPort = PORT + 2;
  ui = spawn(process.execPath, [join(ROOT, "dist/workspace-ui/server.js"), "--api-only", "--port", String(uiPort), "--project", dir], {
    env: { ...process.env, C64RE_WS_PORT: String(RELAY) }, stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${uiPort}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  const post = async (command) => (await fetch(`http://127.0.0.1:${uiPort}/api/monitor/exec`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: S, command }),
  })).json();
  const ud = await post("d 1000 1000");
  const first = (ud.names ?? [])[0];
  check(first?.name?.name === "alpha_main" && first.start === 0 && first.end === 5 && ud.output?.startsWith("$1000"),
    "the workbench gets the runtime's text + the name at the span (the UI renders it there)", JSON.stringify(first?.name));
  const beforeUi = sentCommands().length;
  const ua = await post("a 1106 jsr set_border");
  await post("");
  check(ua.sent === "a 1106 jsr $1010" && sentCommands().slice(beforeUi).includes("a 1106 jsr $1010"), "the workbench substitutes the same way", ua.sent);

  console.log("\n[residency on the live machine]");
  await mon(`load "${paths.beta}"`);
  const d2 = await mon("d 1000 1000");
  check(/^\$1000  beta_main\[u\]/mu.test(d2) && !/alpha_main/u.test(d2), "beta loaded over alpha: the same address is now beta_main[u]", d2);
  await mon("f 1000 1015 00");
  const d3 = await mon("d 1000 1000");
  check(!/</u.test(d3), "wiped: no name at all (no match, no name)", d3);
  await mon("device drive8");
  const dd = await mon("d 1000 1002");
  check(!/</u.test(dd), "device drive8: the drive's listing gets no C64 name", dd.split("\n")[0]);
  await mon("device c64");

  console.log("\n[a trace — residency per row]");
  // Stage beta at $3100, alpha at $1000; a copy loop at $2000 calls alpha's $1010,
  // copies beta over it, then calls beta's $1010. The trace records the writes.
  await mon(`load "${paths.alpha}"`);
  await mon(`load "${paths.beta}" 3100`);
  for (const [addr, instr] of [["2000", "jsr $1010"], ["2003", "ldx #$15"], ["2005", "lda $3100,x"], ["2008", "sta $1000,x"], ["200b", "dex"], ["200c", "bpl $2005"], ["200e", "jsr $1010"], ["2011", "jmp $2011"]]) {
    await mon(`a ${addr} ${instr}`);
    await mon("");
  }
  await mon("r pc=2000");
  const on = await mon("trace on c64-cpu memory");
  await call("session/run", { session_id: S, cycles: 3000 });
  const off = await mon("trace off");
  const runId = (on.match(/trace on: (\S+)/u) ?? [])[1];
  const store = (off.match(/evidence: (\S+)/u) ?? [])[1];
  check(!!runId && !!store, "a trace was captured", `${runId} · ${store}`);
  if (runId && store) {
    const duck = store.endsWith(".duckdb") ? store : store.replace(/\.c64retrace$/u, ".duckdb");
    const q = await mcp.tool("runtime_query_events", { run_id: runId, family: "cpu_step", duckdb_path: duck, pc_start: 0x1010, pc_end: 0x1010, limit: 100 });
    let rows = [];
    try { rows = JSON.parse(q.text.slice(q.text.indexOf("\n") + 1)); } catch { /* reported below */ }
    const at1010 = rows.filter((r) => r.pc === 0x1010);
    check(at1010.length >= 2, "the trace has both calls of $1010", `${at1010.length} rows · ${q.text.slice(0, 120)}`);
    check(at1010[0]?.pcName?.text === "set_border[u]", "the row before the copy names alpha's routine", at1010[0]?.pcName?.text);
    check(at1010[at1010.length - 1]?.pcName?.text === "set_background[u]", "the row after it names beta's — one address, two names, by row", at1010[at1010.length - 1]?.pcName?.text);
  }
  ws.close();
} catch (e) {
  fail++;
  console.log(`  FAIL  ${e instanceof Error ? e.stack : String(e)}`);
  if (daemonLog) console.log(daemonLog.split("\n").slice(-15).join("\n"));
  if (mcp) console.log(mcp.stderr().split("\n").slice(-15).join("\n"));
} finally {
  clearTimeout(budget);
  mcp?.close();
  ui?.kill();
  relay.close();
  daemon.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-804-monitor: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
