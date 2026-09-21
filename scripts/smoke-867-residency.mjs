#!/usr/bin/env node
// Spec 867 §6.4 smoke — residency against a real machine.
//
// The hermetic gate (`npm run e2e:867-window`) hands the byte-match a capture it
// built itself. This one takes the bytes out of a running C64: it loads one of six
// payloads that all live at $1000 into a sandbox runtime, asks who is in the
// window, loads a different one over it and asks again. The answer must follow the
// memory, and must refuse to name anybody when the memory holds neither.
//
// The runtime is a SANDBOX of this smoke's own, on a free port, ended by this smoke
// — never the shared session (doctrine rule 2).
//
//   TRX64_DAEMON_BIN=<trx64-daemon> node scripts/smoke-867-residency.mjs
//   (needs `npm run build`)

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { resolveDaemonSpawn } = await import("../dist/runtime/resolve-daemon-spawn.js");
const DAEMON = process.env.TRX64_DAEMON_BIN || process.env.C64RE_TRX64_BIN
  || resolveDaemonSpawn({ repoRoot: ROOT, projectDir: tmpdir(), port: "1" }).cmd;

const { GRAPH_DDL } = await import("../dist/knowledge-graph/schema.js");
const { Graph } = await import("../dist/knowledge-graph/query.js");
const { windowResidency } = await import("../dist/symbols/window-residency.js");
const { liveByteSource } = await import("../dist/symbols/live-bytes.js");
const { buildFixture, analyze, MODULES } = await import("./lib/fixture-867.mjs");

let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => { cond ? pass++ : failCount++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

if (!existsSync(DAEMON)) {
  console.log(`FAIL  no runtime daemon at ${DAEMON} — set TRX64_DAEMON_BIN`);
  process.exit(1);
}
console.log(`Spec 867 §6.4 — residency, against a real machine  (runtime: ${DAEMON})\n`);

const cleanups = [];
const budget = setTimeout(() => { console.log("FAIL  smoke budget (300 s) exhausted"); for (const c of cleanups) try { c(); } catch {} process.exit(1); }, 300_000);

const proj = mkdtempSync(join(tmpdir(), "c64re-867-smoke-"));
cleanups.push(() => rmSync(proj, { recursive: true, force: true }));
buildFixture(proj, GRAPH_DDL);
for (const m of MODULES) analyze(proj, m.owner, m.prg);

async function rpc(endpoint, deadlineMs = 20_000) {
  const until = Date.now() + deadlineMs;
  let ws;
  for (;;) {
    try { ws = await new Promise((res, rej) => { const w = new WebSocket(endpoint); w.once("open", () => res(w)); w.once("error", rej); }); break; }
    catch (e) { if (Date.now() > until) throw e; await sleep(200); }
  }
  const pending = new Map();
  let id = 1;
  ws.on("message", (data, bin) => {
    if (bin) return;
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const call = (method, params = {}) => new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }));
  });
  return { call, close: () => ws.close() };
}

const port = await freePort();
const daemon = spawn(DAEMON, ["--project", proj, "--port", String(port), "--headless"], { stdio: ["ignore", "pipe", "pipe"] });
cleanups.push(() => daemon.kill("SIGKILL"));

const graph = Graph.open(proj);
cleanups.push(() => graph.close());
try {
  const R = await rpc(`ws://127.0.0.1:${port}`);
  cleanups.push(() => R.close());
  const session = (await R.call("session/list"))[0]?.sessionId ?? "integrated-1";
  const bytes = liveByteSource((method, params) => R.call(method, params), session);
  const ask = () => windowResidency({ projectDir: proj, store: graph.store, address: 0x1000, space: "ram", bytes });

  const before = await ask();
  check(before.claimants.length === MODULES.length, `the window at $1000 has ${before.claimants.length} claimants before anything is loaded`, before.claimants.join(","));
  check(before.resident === undefined, "…and with none of them in memory, nobody is named — no match, never a wrong one");

  for (const owner of ["mod_c", "mod_e"]) {
    const m = MODULES.find((x) => x.owner === owner);
    await R.call("session/load_prg", { session_id: session, prg_path: m.prg, source: "llm" });
    await sleep(200);
    const r = await ask();
    check(r.resident?.owner === owner, `with ${owner}'s bytes in the machine, the window names ${owner}`, r.resident?.owner ?? r.ambiguous ?? "nobody");
    check(r.resident?.by === "bytes", "…decided by the bytes the runtime handed over");
    const mine = r.evidence.find((e) => e.owner === owner);
    check((mine?.matched ?? 0) >= 4 && mine?.matched === mine?.compared, "…every compared code byte matched", `${mine?.matched}/${mine?.compared}`);
    const others = r.evidence.filter((e) => e.owner !== owner && e.resident === true);
    check(others.length === 0, "…and no other claimant is called resident", others.map((e) => e.owner).join(",") || "none");
  }
} catch (error) {
  check(false, `the smoke could not reach the runtime: ${error instanceof Error ? error.message : String(error)}`);
}

clearTimeout(budget);
for (const c of cleanups) { try { c(); } catch { /* the smoke is ending anyway */ } }
console.log("");
console.log(`${failCount === 0 ? "GREEN" : "RED"}  Spec 867 residency smoke: ${pass} pass, ${failCount} fail.`);
process.exit(failCount === 0 ? 0 : 1);
