#!/usr/bin/env node
// Spec 889 §11 — the C64U bridge: the facade as a daemon of its own, against a fake Ultimate.
//
// Hermetic: the fake Ultimate (REST, ident, the app's ONE-client WS) on 127.0.0.1, the bridge as the
// real `c64re c64u-bridge` process (or the detached one C64RE starts on select), an MCP stdio server,
// and plain WebSocket clients standing in for the browser. Nothing here contacts a device or any LAN
// host, binds :4312, or touches a daemon it did not start; every port is the OS's choice and the
// machine-wide state (selection, bridge registry) lives in a directory of this run.
//
//   A  the process: `c64u-bridge --device`, the daemon's ping plus backend/device identity, no idle
//      exit when started by hand, :4312 refused, plain HTTP, foreign origins
//   B  co-drive: ONE bridge, the MCP server and a browser-like client on it, the device sees exactly one
//      connection; same state; a pause by one is seen by the other; project/set; notifications to all
//   C  picture and sound reach A/V subscribers (audio after audio/start), never `?av=0`
//   D  one bridge per device: a second start attaches; select attaches; leaving stops it
//   E  the gate (§4b) holds for a raw WebSocket client: project from project/set, passes from that project
//   K  keys and media from the workbench: key_down/up/release_keys → machine:input, disks/CRT/PRG upload, the gate text, eject
//   F  idle exit (Spec 886's rules): requests and A/V viewers hold it, keep_alive, then it ends — streams
//      stopped, the device's connection released
//   G  one selection for every process: a switch by either is followed by the other and announced
//   H  the REST password: stdin, never argv, never a file
//   I  a bridge that ended: a process that used it starts it again, a fresh process does not
//
// Exit 0 = pass, 1 = fail.   npm run smoke:889-bridge
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startFakeUltimate } from "./lib/fake-ultimate.mjs";
import { startMcp } from "./lib/mcp-stdio.mjs";
import { AudioGen, VideoGen, udpSender } from "./lib/stream-datagrams.mjs";
import { distLoader, reapBridges } from "./lib/bridge-harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (c, m, d = "") => { c ? pass++ : failCount++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${!c && d !== "" ? `  (${String(d).slice(0, 400)})` : ""}`); };
const head = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(20); } return !!(await f()); };
const rejects = async (p) => { try { await p; return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const dist = distLoader(ROOT);
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const udpFree = (port) => new Promise((res) => { const s = createSocket("udp4"); s.once("error", () => res(false)); s.bind(port, "0.0.0.0", () => s.close(() => res(true))); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

if (!existsSync(join(ROOT, "dist/cli.js"))) { console.log("FAIL  dist is not built (npm run build:mcp)"); process.exit(1); }

const SANDBOX = mkdtempSync(join(tmpdir(), "c64re-889br-"));
const STATE = join(SANDBOX, "state");
const PROJ = join(SANDBOX, "proj");
const OTHER_PROJ = join(SANDBOX, "other");
for (const d of [STATE, PROJ, OTHER_PROJ, join(PROJ, "media")]) mkdirSync(d, { recursive: true });
process.env.C64RE_STATE_DIR = STATE;
process.env.C64RE_C64U_VIDEO_PORT = "0";
process.env.C64RE_C64U_AUDIO_PORT = "0";
process.env.C64RE_PROCESS_ROLE = "the smoke";
delete process.env.C64RE_RUNTIME_BACKEND;
delete process.env.C64RE_PROJECT_DIR;
const { ProjectKnowledgeService } = await dist("project-knowledge/service.js");
new ProjectKnowledgeService(PROJ).initProject({ name: "889br" });
new ProjectKnowledgeService(OTHER_PROJ).initProject({ name: "889br-other" });
const be = await dist("runtime/backend.js");
const launch = await dist("runtime/c64u-bridge/launch.js");
const state = await dist("runtime/c64u-bridge/state.js");
const pass_ = await dist("runtime/emulator-pass.js");
const idleMod = await dist("runtime/idle-exit.js");

const PRG = Buffer.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00, 0x60]);
const prgPath = join(PROJ, "media", "game.prg");
writeFileSync(prgPath, PRG);

console.log("Spec 889 §11 — the C64U bridge\n");
const sims = [];
const fake = async (o) => { const s = await startFakeUltimate(o); sims.push(s); return s; };
const procs = [];

/** A client of a bridge, the way a browser (or the daemon's MCP client) is one: JSON-RPC text, binary frames, notifications. */
async function wsClient(endpoint, { av = true, headers } = {}) {
  const ws = new WebSocket(av ? endpoint : `${endpoint}/?av=0`, { headers });
  ws.binaryType = "arraybuffer";
  const c = { ws, notes: [], bins: [], pending: new Map(), nid: 1, closed: undefined };
  ws.on("message", (d, isBin) => {
    if (isBin) { c.bins.push(new Uint8Array(d)); return; }
    const m = JSON.parse(d.toString());
    if (m.id != null && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); m.error ? p.rej(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.res(m.result); }
    else if (m.method) c.notes.push(m);
  });
  ws.on("close", (code, reason) => { c.closed = { code, reason: reason.toString() }; });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  c.call = (method, params = {}) => new Promise((res, rej) => { const id = c.nid++; c.pending.set(id, { res, rej }); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
  c.close = () => { try { ws.close(); } catch { /* */ } };
  return c;
}

/** `c64re c64u-bridge …` as a child process; resolves with the first stdout line. */
function runBridgeCli(args, { env = {}, stdin } = {}) {
  const proc = spawn(process.execPath, [join(ROOT, "dist/cli.js"), "c64u-bridge", ...args], {
    env: { ...process.env, ...env }, stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
  procs.push(proc);
  let out = "", err = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { err += d; });
  if (stdin !== undefined) proc.stdin.end(stdin);
  const exited = new Promise((r) => proc.once("exit", (code) => r(code)));
  const first = async (ms = 20000) => { await until(() => out.includes("\n"), ms); try { return JSON.parse(out.split("\n")[0]); } catch { return undefined; } };
  return { proc, first, exited, get out() { return out; }, get err() { return err; } };
}
const ping = (endpoint) => launch.pingBridge(endpoint, 3000);

try {
  // ═══ A ═══════════════════════════════════════════════════════════════════════════════════════
  head("A  the process");
  const sim = await fake({ capabilities: "object" });
  const PORT = await freePort();
  const cli = runBridgeCli(["--device", `127.0.0.1:${sim.restPort}`, "--port", String(PORT), "--project", PROJ]);
  const line = await cli.first();
  check(line?.c64u_bridge === "listening" && line.endpoint === `ws://127.0.0.1:${PORT}` && line.pid === cli.proc.pid, "`c64re c64u-bridge --device <host>:<restport> --port <p>` listens on that port and says where", JSON.stringify(line));
  const EP = `ws://127.0.0.1:${PORT}`;
  check(await until(async () => (await ping(EP))?.bridge?.state === "ready"), "it connects to the device in the background; ping says when it is ready");
  const p0 = await ping(EP);
  check(p0.runtime_version === "trx64-runtime/2" && p0.backend === "c64u" && typeof p0.version === "string" && /^c64u-bridge /.test(p0.version), "ping answers like the daemon's (runtime_version trx64-runtime/2) plus backend c64u", JSON.stringify({ rv: p0.runtime_version, b: p0.backend, v: p0.version }));
  check(p0.device?.host === "127.0.0.1" && p0.device.board === "C64U" && p0.device.firmwareVersion === "3.15" && p0.device.trxmonVersion === "trxmon 0.1" && p0.device.capabilities === "listed" && p0.label === "C64 Ultimate 127.0.0.1", "…and the device identity: host, ident trx64 object, firmware, trxmon, capabilities", JSON.stringify(p0.device)?.slice(0, 200));
  check(p0.idleExit?.armedSeconds === 0 && p0.idleExit.deadlineMs === null, "started by hand there is no idle exit unless one is given (ping.idleExit)");
  check(p0.project === PROJ, "ping names the project the gate looks in (--project)", String(p0.project));
  const reg = state.readBridgeEntry("127.0.0.1", sim.restPort);
  check(reg?.pid === cli.proc.pid && reg.endpoint === EP, "the registry names the bridge (port, pid) so a second start finds it");
  check(sim.clients === 1 && sim.refused === 0, "the device sees ONE app connection");

  const bad = runBridgeCli(["--device", `127.0.0.1:${sim.restPort}`, "--port", "4312"]);
  check(await bad.exited !== 0 && /emulator daemon's port/.test(bad.err), ":4312 is refused, by name — the bridge never takes the emulator's port", bad.err.trim().slice(0, 120));
  const noDev = runBridgeCli([]);
  check(await noDev.exited !== 0 && /--device <host>/.test(noDev.err), "no --device is an error that says what to give");
  const http = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.status);
  check(http === 426, "plain HTTP on the port answers 426, as the app's port does");
  const evil = await new Promise((res) => {
    const ws = new WebSocket(EP, { headers: { Origin: "http://evil.example" } });
    ws.on("unexpected-response", (_q, rs) => res(rs.statusCode)); ws.on("open", () => { ws.close(); res("open"); }); ws.on("error", () => res("error"));
  });
  check(evil === 403 || evil === "error", "a page of another origin cannot open the bridge (it could otherwise drive the machine)", String(evil));
  const local = await new Promise((res) => { const ws = new WebSocket(EP, { headers: { Origin: "http://localhost:4310" } }); ws.on("open", () => { ws.close(); res(true); }); ws.on("error", () => res(false)); });
  check(local === true, "…while the workbench's own origin (localhost / 127.0.0.1, any port) can");

  // ═══ B ═══════════════════════════════════════════════════════════════════════════════════════
  head("B  co-drive: the assistant and the browser on ONE bridge");
  const sel = await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: sim.restPort }, { projectDir: PROJ });
  check(sel.notes.some((n) => /attached to the C64U bridge already running/.test(n)) && sel.identity.device.host === "127.0.0.1", "select ATTACHES to the running bridge (no second one is started)", sel.notes[0]);
  const mcp = startMcp({ root: ROOT, env: { C64RE_STATE_DIR: STATE, C64RE_PROJECT_DIR: PROJ, C64RE_RUNTIME_AUTOSTART: "0" } });
  procs.push(mcp.proc);
  await mcp.call("agent_onboard", { project_dir: PROJ });
  const browser = await wsClient(EP);
  const watcher = await wsClient(EP, { av: false });
  const st0 = await mcp.call("runtime_session_status", { session_id: "shared" });
  check(/^Runtime session status \(C64 Ultimate\)/.test(st0) && st0.includes(`through the C64U bridge at ${EP}`) && /PC=\$0810/.test(st0) && /Run state: running/.test(st0), "the MCP server follows the shared selection and reaches the device THROUGH the bridge", st0.split("\n").slice(0, 2).join(" | "));
  const bs = await browser.call("session/state", { session_id: "shared" });
  check(bs.cpu.pc === 0x0810 && bs.runState === "running" && bs.backend === "c64u" && bs.idleExit && bs.idleExit.armedSeconds === 0, "the browser-like client sees the same machine in the daemon's shape (session/state, with idleExit)", JSON.stringify(bs).slice(0, 160));
  check(sim.clients === 1 && sim.refused === 0, "…the device still sees exactly ONE connection, with both clients and the selection attached", `clients=${sim.clients} refused=${sim.refused}`);
  // a pause by the browser is seen by the assistant …
  await browser.call("debug/pause", { session_id: "shared" });
  const st1 = await mcp.call("runtime_session_status", { session_id: "shared" });
  check(/Run state: paused/.test(st1), "a pause by the browser is what the assistant reads next", st1.split("\n").find((l) => /Run state/.test(l)));
  check(await until(() => watcher.notes.some((n) => n.method === "debug/paused")) && browser.notes.some((n) => n.method === "debug/paused"), "…and every client is told (notifications go to all, `?av=0` clients too)");
  // … and a pause by the assistant by the browser
  await browser.call("debug/continue", { session_id: "shared" });
  const before = browser.notes.length;
  const paused = await mcp.call("runtime_monitor", { session_id: "shared", command: "pause" });
  check(!/error/i.test(paused) && await until(() => browser.notes.slice(before).some((n) => n.method === "debug/paused")), "a pause by the assistant (runtime_monitor `pause`) reaches the browser as debug/paused", paused.slice(0, 120));
  check(/Run state: paused/.test(await mcp.call("runtime_session_status", { session_id: "shared" })) && (await browser.call("session/state", { session_id: "shared" })).runState === "paused", "…both read the machine as paused");
  await mcp.call("runtime_monitor", { session_id: "shared", command: "run" });
  check(await until(() => browser.notes.slice(before).some((n) => n.method === "debug/running")), "…and when the assistant runs it again the browser is told (debug/running)");
  check(sim.clients === 1 && sim.refused === 0, "…one connection at the device throughout", `clients=${sim.clients} refused=${sim.refused}`);
  // project/set
  const dry = await browser.call("project/set", { path: OTHER_PROJ, dry_run: true });
  check(dry.same === false && dry.changed === false && dry.requested.endsWith("other") && dry.current !== null, "project/set dry_run: the daemon's shape — same, current, requested; nothing moved", JSON.stringify(dry));
  await mcp.call("agent_onboard", { project_dir: OTHER_PROJ });
  const st2 = await mcp.call("runtime_session_status", { session_id: "shared", project_dir: OTHER_PROJ });
  check(/projectMismatch — the C64U bridge is bound to .*not this one/.test(st2), "the assistant's status reports a project mismatch the way it does for the daemon", st2.slice(0, 500));
  const moved = await browser.call("project/set", { path: OTHER_PROJ });
  check(moved.changed === true && moved.project.endsWith("other") && await until(() => watcher.notes.some((n) => n.method === "project/changed" && n.params.project.endsWith("other"))), "project/set moves the bridge and tells every client (project/changed)");
  await browser.call("project/set", { path: PROJ });
  const err1 = await rejects(browser.call("project/set", { path: join(SANDBOX, "nope") }));
  check(/project\/set: .*nope/.test(err1 ?? ""), "project/set of a directory that is not there is refused by name", err1);

  // ═══ C ═══════════════════════════════════════════════════════════════════════════════════════
  head("C  picture and sound reach A/V subscribers");
  const status = await browser.call("bridge/status");
  const vp = status.streams.status.ports.video, ap = status.streams.status.ports.audio;
  check(await until(() => sim.streams.video !== null && sim.streams.audio !== null), "the bridge asked the device to send picture and sound to its UDP ports");
  const tx = await udpSender();
  const vic = new VideoGen();
  for (const d of vic.frame(1)) await tx.send(vp, d);
  check(await until(() => browser.bins.some((b) => b[0] === 0x01)), "a video frame reaches the A/V subscriber as the daemon's 0x01 frame ([type u8][seq u32 LE][payload])");
  const f = browser.bins.find((b) => b[0] === 0x01);
  const fdv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  check(f.length === 5 + 58 + 384 * 272 && fdv.getUint16(5, true) === 384 && fdv.getUint16(7, true) === 272 && f[9] === 1, "…384x272, palette-indexed, the payload the Live tab draws");
  const ag = new AudioGen();
  await tx.send(ap, ag.packet(500)); await sleep(150);
  check(!browser.bins.some((b) => b[0] === 0x02), "audio is NOT pushed to a subscriber that did not ask for it");
  const as = await browser.call("audio/start", { session_id: "shared" });
  check(as.ok === true && as.sampleRate === 48003.07 && as.channels === 2, "audio/start answers with the device's rate 48,003.07 Hz — the one thing the browser sees differently from the emulator", JSON.stringify(as));
  await tx.send(ap, ag.packet(600));
  check(await until(() => browser.bins.some((b) => b[0] === 0x02)), "after audio/start the subscriber gets 0x02 audio");
  await browser.call("audio/stop", { session_id: "shared" });
  const na = browser.bins.filter((b) => b[0] === 0x02).length;
  await tx.send(ap, ag.packet(700)); await sleep(150);
  check(browser.bins.filter((b) => b[0] === 0x02).length === na, "…and none after audio/stop");
  check(watcher.bins.length === 0, "a `?av=0` client (the assistant's kind) receives no video and no audio at all");
  check(await until(() => browser.notes.some((n) => n.method === "stream/paused" && n.params.paused === true), 3000), "no video for a quarter second → stream/paused {paused:true}, to all clients");
  const lateB = await wsClient(EP);
  check(await until(() => lateB.notes.some((n) => n.method === "stream/paused" && n.params.paused === true) && lateB.bins.some((b) => b[0] === 0x01)), "a client that connects while paused gets stream/paused and the last frame at once");
  lateB.close();
  const pg = await browser.call("bridge/status");
  check(pg.bridge.avClients >= 1 && pg.bridge.clients >= 2, "bridge/status counts clients and A/V subscribers");
  await tx.close();

  // ═══ D ═══════════════════════════════════════════════════════════════════════════════════════
  head("D  one bridge per device");
  const second = runBridgeCli(["--device", `127.0.0.1:${sim.restPort}`]);
  const sl = await second.first();
  check(sl?.c64u_bridge === "already-running" && sl.endpoint === EP && sl.pid === cli.proc.pid && await second.exited === 0, "a second `c64u-bridge --device` finds the running bridge, says where it is, and exits 0", JSON.stringify(sl));
  const ens = await launch.ensureBridge({ host: "127.0.0.1", restPort: sim.restPort });
  check(ens.attached === true && ens.endpoint === EP, "C64RE's start (ensureBridge) attaches to it the same way");
  check(sim.clients === 1 && sim.refused === 0, "…and the device never saw a second connection", `clients=${sim.clients} refused=${sim.refused}`);
  const row = await be.probeHost({ host: "127.0.0.1", restPort: sim.restPort });
  check(row.outcome === "offered" && row.held === true && sim.refused === 0, "a probe of that device asks the bridge (it pings on the held connection) — no second connection", row.reason);
  // a method the device cannot serve: refused by name, through the bridge
  const ref = await rejects(browser.call("runtime/overlay_run", {}));
  check(/runtime\/overlay_run: no overlay on C64 Ultimate hardware/.test(ref ?? ""), "a method the device cannot serve is refused by name by the bridge, with the way out", ref);
  check(/needs `pc`/.test((await rejects(browser.call("debug/break_add", {}))) ?? ""), "the bridge's own protections apply to every client (break_add without pc)");
  browser.ws.send("{nope");
  await sleep(150);
  check(browser.ws.readyState === WebSocket.OPEN && (await browser.call("session/list")).length === 1, "a frame that is not JSON is answered with a parse error and does not end the connection");

  // ═══ E ═══════════════════════════════════════════════════════════════════════════════════════
  head("E  the gate (§4b) for a raw WebSocket client");
  const reqs0 = sim.requests.length;
  const g1 = await rejects(browser.call("session/load_prg", { path: prgPath }));
  check(/game\.prg \(sha256 [0-9a-f]{8}…\) has no green emulator run in this project/.test(g1 ?? "") && /c64re scenario run/.test(g1 ?? ""), "no pass: the raw client's load_prg is refused by name — file, hash, what is missing", g1);
  for (const [m, p] of [["media/open", { path: prgPath }], ["runtime/run_prg", { prg_path: prgPath }], ["media/ingress", { kind: "prg", bytes_b64: PRG.toString("base64"), name: "x.prg", mode: "inject-run" }]]) {
    check(/has no green emulator run/.test((await rejects(browser.call(m, p))) ?? ""), `${m}: refused for the raw client too`);
  }
  check(sim.requests.length === reqs0, "…and nothing reached the device");
  pass_.recordEmulatorPass(PROJ, { media: [{ name: "game.prg", bytes: new Uint8Array(PRG) }], steps: ["I wait 10 frames"], checks: [{ text: "Then $8EF2 is $01", afterSteps: 1, actual: "$01", pass: true }] });
  const g2 = await browser.call("session/load_prg", { path: prgPath });
  check(g2.loadAddress === 0x0801 && sim.requests.some((q) => q.path === "/v1/runners:load_prg"), "the pass is read from the bound project's knowledge/emulator-passes.json: allowed once the bytes have one (recorded AFTER the bridge started)");
  writeFileSync(prgPath, Buffer.concat([PRG, Buffer.from([0x99])]));
  check(/has no green emulator run/.test((await rejects(browser.call("session/load_prg", { path: prgPath }))) ?? ""), "a changed byte is a new medium: refused again");
  writeFileSync(prgPath, PRG);
  await browser.call("project/set", { path: OTHER_PROJ });
  check(/has no green emulator run in this project/.test((await rejects(browser.call("session/load_prg", { path: prgPath }))) ?? ""), "project/set moves the gate with it: the other project has no pass for these bytes");
  await browser.call("project/set", { path: PROJ });
  check((await browser.call("session/load_prg", { path: prgPath })).loadAddress === 0x0801, "…and back");

  // ═══ K ═══════════════════════════════════════════════════════════════════════════════════════
  head("K  keys and media from the workbench, over the daemon wire");
  const inputBodies = (from) => sim.requests.slice(from).filter((q) => q.path === "/v1/machine:input").map((q) => q.json);
  let n0 = sim.requests.length;
  // a press and its release in the same turn share a request and keep their order
  await Promise.all([
    browser.call("session/key_down", { session_id: "shared", key: "A" }),
    browser.call("session/key_down", { session_id: "shared", key: "L_SHIFT" }),
    browser.call("session/key_up", { session_id: "shared", key: "A" }),
    browser.call("session/key_up", { session_id: "shared", key: "L_SHIFT" }),
  ]);
  let ib = inputBodies(n0);
  const evs = ib.flatMap((b) => b.events);
  check(evs.length === 4 && evs.map((e) => `${e.transition}:${e.inputs[0]}`).join() === "press:a,press:left_shift,release:a,release:left_shift" && evs.every((e) => e.kind === "keyboard"),
    "session/key_down|key_up → machine:input press/release, in the order sent", JSON.stringify(evs));
  check(ib.length <= 2, "…calls of one turn are batched into few requests", String(ib.length));
  const keyMap = { RETURN: "return", DEL: "inst_del", SPACE: "space", RUN_STOP: "run_stop", C_EQ: "commodore", CTRL: "ctrl", LARROW: "arrow_left", UP_ARROW: "arrow_up", R_SHIFT: "right_shift", HOME: "clr_home", CRSR_DN: "cursor_up_down", CRSR_RT: "cursor_left_right", POUND: "pound", F1: "f1", F3: "f3", F5: "f5", F7: "f7", "+": "plus", "-": "minus", "*": "star", "/": "slash", "=": "equals", ":": "colon", ";": "semicolon", ",": "comma", ".": "period", "@": "at", Z: "z", 0: "0" };
  n0 = sim.requests.length;
  await Promise.all(Object.keys(keyMap).map((k) => browser.call("session/key_down", { key: k })));
  const mapped = inputBodies(n0).flatMap((b) => b.events).map((e) => e.inputs[0]);
  check(mapped.join() === Object.values(keyMap).join(), "every key id the Live tab sends maps to the firmware's key name", mapped.join());
  n0 = sim.requests.length;
  await browser.call("session/key_down", { key: "RESTORE" }); await browser.call("session/key_up", { key: "RESTORE" });
  const rs = inputBodies(n0).flatMap((b) => b.events);
  check(rs.length === 1 && rs[0].inputs[0] === "restore" && rs[0].transition === "tap", "RESTORE is tapped on key_down (the firmware takes it as an edge only); key_up sends nothing", JSON.stringify(rs));
  // more than 64 events: split in order, none lost
  n0 = sim.requests.length;
  await browser.call("session/release_keys", { session_id: "shared" });
  const rel = inputBodies(n0);
  check(rel.length === 1 && rel[0].events.every((e) => e.transition === "release") && rel[0].events.flatMap((e) => e.inputs).length === Object.keys(keyMap).length && rel[0].events.every((e) => e.inputs.length <= 8),
    "session/release_keys → release of the keys this bridge holds (8 per event), keys only", JSON.stringify(rel).slice(0, 200));
  n0 = sim.requests.length;
  await browser.call("session/joystick_set", { port: 2, up: true });
  await browser.call("session/release_keys", { session_id: "shared" });
  check(inputBodies(n0).length === 1 && inputBodies(n0)[0].events.every((e) => e.kind === "joystick"), "…and nothing with no key held (a joystick another client holds is not touched)");
  // order across many events: 70 taps in one turn → 64 + 6, in order
  n0 = sim.requests.length;
  await Promise.all(Array.from({ length: 70 }, (_, i) => browser.call(i % 2 ? "session/key_up" : "session/key_down", { key: "B" })));
  const seq = inputBodies(n0);
  check(seq.length >= 2 && seq.every((b) => b.events.length <= 64) && seq.flatMap((b) => b.events).length === 70 && seq.flatMap((b) => b.events).every((e, i) => e.transition === (i % 2 ? "release" : "press")), "70 events in a burst: never more than 64 per request, all there, the order kept", seq.map((b) => b.events.length).join());
  await browser.call("session/key_up", { key: "B" });
  // unmapped: refused by name, nothing sent
  n0 = sim.requests.length;
  const uk = await rejects(browser.call("session/key_down", { key: "F13" }));
  check(/session\/key_down: no key "F13"/.test(uk ?? "") && inputBodies(n0).length === 0, "an unmapped key is refused by name, nothing is sent", uk);
  const uk2 = await rejects(browser.call("session/key_up", { key: "" }));
  check(/session\/key_up: no key ""/.test(uk2 ?? ""), "…an empty one too", uk2);
  // joystick: order across calls
  n0 = sim.requests.length;
  await Promise.all([browser.call("session/joystick_set", { port: 2, up: true }), browser.call("session/joystick_set", { port: 2, up: false, fire: true }), browser.call("session/joystick_clear", { port: 2 })]);
  const jb = inputBodies(n0).flatMap((b) => b.events).filter((e) => e.transition === "press");
  check(jb.length === 2 && jb[0].inputs.join() === "up" && jb[1].inputs.join() === "fire", "joystick calls keep their order on the wire (one queue with the keys)", JSON.stringify(jb));

  // ── media: the picker's lists are this machine's files ──
  const D64B = Buffer.alloc(174848, 0x42), G64B = Buffer.concat([Buffer.from("GCR-1541", "latin1"), Buffer.alloc(300, 0x33)]);
  const D81B = Buffer.alloc(819200, 0x81), CRTB = Buffer.concat([Buffer.from("C64 CARTRIDGE   ", "latin1"), Buffer.alloc(64, 0x11)]);
  const PROJR = realpathSync(PROJ);
  const med = (n) => join(PROJR, "media", n);
  writeFileSync(med("a.d64"), D64B); writeFileSync(med("b.g64"), G64B); writeFileSync(med("c.d81"), D81B); writeFileSync(med("x.crt"), CRTB);
  const roots = await browser.call("media/list_paths");
  check(Array.isArray(roots) && roots.some((r) => r.label === "project" && r.path === PROJR && r.exists === true), "media/list_paths names the bound project", JSON.stringify(roots));
  const br = await browser.call("media/browse", { path: join(PROJ, "media") });
  check(br.entries.map((e) => `${e.name}:${e.type}`).join() === "a.d64:d64,b.g64:g64,c.d81:d81,game.prg:prg,x.crt:crt", "media/browse lists d64/g64/d81/crt/prg", br.entries.map((e) => e.name).join());
  const rc0 = await browser.call("media/recent");
  check(rc0.some((r) => r.path === med("a.d64") && r.type === "d64") && !rc0.some((r) => r.type === "prg"), "media/recent lists the project's images");

  // the gate: refused naming file + sha, reaches the client, nothing sent
  n0 = sim.requests.length;
  const gk = await rejects(browser.call("media/mount", { session_id: "shared", slot: 8, path: med("a.d64") }));
  check(/^a\.d64 \(sha256 [0-9a-f]{8}…\) has no green emulator run in this project/.test(gk ?? "") && sim.requests.length === n0, "a disk without a pass: the refusal names file and sha256, nothing reaches the device", gk);
  const gu = await rejects(browser.call("media/ingress", { session_id: "shared", kind: "disk", name: "dropped.d64", bytes_b64: D64B.toString("base64"), unit: 9 }));
  check(/^dropped\.d64 \(sha256 /.test(gu ?? ""), "…a dropped file (bytes + name) too", gu);
  const PRG2 = Buffer.concat([PRG, Buffer.from([0x60])]);
  const gp = await rejects(browser.call("runtime/run_prg", { session_id: "shared", name: "drop.prg", bytes_b64: PRG2.toString("base64") }));
  check(/^drop\.prg \(sha256 /.test(gp ?? ""), "…and a dropped PRG, named", gp);
  pass_.recordEmulatorPass(PROJ, { media: [
    { name: "a.d64", bytes: new Uint8Array(D64B) }, { name: "b.g64", bytes: new Uint8Array(G64B) }, { name: "c.d81", bytes: new Uint8Array(D81B) },
    { name: "x.crt", bytes: new Uint8Array(CRTB) }, { name: "drop.prg", bytes: new Uint8Array(PRG2) },
  ], steps: ["I wait 10 frames"], checks: [{ text: "Then $8EF2 is $01", afterSteps: 1, actual: "$01", pass: true }] });
  const sha = (b) => pass_.sha256Hex(new Uint8Array(b));
  const mountCall = (extra) => { n0 = sim.requests.length; return browser.call("media/mount", { session_id: "shared", ...extra }).then((r) => ({ r, req: sim.requests.slice(n0).find((q) => /:mount$/.test(q.path)) })); };
  const m1 = await mountCall({ slot: 8, path: med("a.d64") });
  check(m1.req.method === "POST" && m1.req.path === "/v1/drives/a:mount" && m1.req.query.type === "d64" && m1.req.query.mode === "readwrite" && m1.req.bodySha === sha(D64B) && m1.req.contentType === "application/octet-stream" && m1.r.slot === 8 && m1.r.mountedPath === med("a.d64"), "d64 → POST drives/a:mount?type=d64&mode=readwrite with the file as the body (slot 8)", JSON.stringify(m1.req));
  const m2 = await mountCall({ slot: 9, path: med("b.g64") });
  check(m2.req.path === "/v1/drives/b:mount" && m2.req.query.type === "g64" && m2.req.bodySha === sha(G64B), "g64 into slot 9 → drives/b:mount?type=g64", JSON.stringify(m2.req));
  const m3 = await mountCall({ slot: 9, path: med("c.d81"), write_protected: true });
  check(m3.req.path === "/v1/drives/b:mount" && m3.req.query.type === "d81" && m3.req.query.mode === "readonly", "d81 → type=d81, write_protected → mode=readonly", JSON.stringify(m3.req.query));
  const ds8 = await browser.call("session/drive_status", { unit: 8 }), ds9 = await browser.call("session/drive_status", { unit: 9 });
  check(ds8.mounted?.file === "a.d64" && ds8.mounted.path === med("a.d64") && ds8.kinds.includes("d81") && ds9.mounted === null, "the drive panel's status carries the name the person gave (the fake device reports drive b empty, so null there)", JSON.stringify([ds8.mounted, ds9.mounted]));
  const dropped = await browser.call("media/ingress", { session_id: "shared", kind: "disk", name: "a.d64", bytes_b64: D64B.toString("base64"), unit: 9 });
  check(dropped.slot === 9 && dropped.drive === "b" && dropped.event.format === "d64" && /drive 9/.test(dropped.message), "a dropped disk goes to the chosen drive and answers in the ingress shape", JSON.stringify(dropped).slice(0, 160));
  n0 = sim.requests.length;
  const cr = await browser.call("media/ingress", { session_id: "shared", kind: "crt", name: "x.crt", bytes_b64: CRTB.toString("base64") });
  const crReq = sim.requests.slice(n0).find((q) => q.path === "/v1/runners:run_crt");
  check(crReq?.method === "POST" && crReq.bodySha === sha(CRTB) && cr.started === true && /STARTS/.test(cr.message), "a cartridge → POST runners:run_crt (upload) and the answer says it STARTS", cr.message);
  const cr2 = await browser.call("media/mount", { session_id: "shared", slot: 0, path: med("x.crt") });
  check(cr2.started === true, "the Inspector's CART row (mount slot 0) starts it the same way");
  n0 = sim.requests.length;
  const rp = await browser.call("runtime/run_prg", { session_id: "shared", name: "drop.prg", bytes_b64: PRG2.toString("base64") });
  check(sim.requests.slice(n0).some((q) => q.method === "POST" && q.path === "/v1/runners:run_prg" && q.bodySha === sha(PRG2)) && rp.loadAddress === 0x0801, "a PRG → POST runners:run_prg (upload)");
  n0 = sim.requests.length;
  const ej = await browser.call("media/unmount", { session_id: "shared", slot: 9 });
  const ej8 = await browser.call("media/unmount", { session_id: "shared", slot: 8 });
  check(sim.requests.slice(n0).filter((q) => /:remove$/.test(q.path)).map((q) => `${q.method} ${q.path}`).join() === "PUT /v1/drives/b:remove,PUT /v1/drives/a:remove" && ej.drive === "b" && ej8.drive === "a", "eject → PUT drives/{a|b}:remove");
  check(/cartridge/.test((await rejects(browser.call("media/unmount", { session_id: "shared", slot: 0 }))) ?? ""), "ejecting the cartridge is refused by name (the device has no route)");
  const rcAfter = await browser.call("media/recent");
  check(rcAfter[0].path === med("x.crt") || rcAfter.slice(0, 4).some((r) => r.path === med("c.d81")), "media/recent puts what was mounted first");

  const sim2 = await fake({});
  const noProj = runBridgeCli(["--device", `127.0.0.1:${sim2.restPort}`, "--port", String(await freePort())], { env: { C64RE_PROJECT_DIR: "" } });
  const npl = await noProj.first();
  await until(async () => (await ping(npl.endpoint))?.bridge?.state === "ready");
  const npc = await wsClient(npl.endpoint, { av: false });
  const g3 = await rejects(npc.call("session/load_prg", { path: prgPath }));
  check(/no C64RE project could be resolved/.test(g3 ?? "") && (await npc.call("ping")).project === null, "a bridge with no project set refuses media and PRG doors by name (never allows)", g3);
  const mv = await npc.call("project/set", { path: PROJ });
  check(mv.changed === true && (await npc.call("session/load_prg", { path: prgPath })).loadAddress === 0x0801, "project/set gives it one; then the same bytes pass");
  npc.close();
  noProj.proc.kill("SIGTERM");
  await noProj.exited;

  // ═══ G (before F: uses the running bridge) ════════════════════════════════════════════════════
  head("G  one selection for every C64RE process");
  const rec = state.readSelection();
  check(rec?.kind === "c64u" && rec.endpoint === EP && rec.device.host === "127.0.0.1" && rec.bridgePid === cli.proc.pid && !JSON.stringify(rec).includes("password"), "the selection is one file under the state directory: kind, device, bridge endpoint, pid — no secret");
  // the assistant switches to the emulator; this process follows and is told
  const swBack = await mcp.call("runtime_backend", { action: "select", backend: "emulator" });
  check(/Selected: Emulator/.test(swBack), "the MCP server selects the emulator");
  check(await until(async () => !alive(cli.proc.pid) || cli.proc.exitCode !== null, 8000), "…the bridge is stopped (leaving a C64U ends its bridge)");
  idleMod.takeFreshRuntimeNotice();
  await sleep(300); // (the selection is read at most every 250 ms)
  be.activeBackend(); // (this process follows on its next call)
  const nowSel = be.currentSelection();
  check(nowSel.kind === "emulator" && /the assistant \(MCP\)/.test(nowSel.by ?? ""), "this process follows the switch on its next call (currentSelection: emulator, by the assistant)", JSON.stringify(nowSel));
  const stBefore = be.activeBackend().kind;
  check(stBefore === "emulator", "…activeBackend() is the emulator client");
  check(sim.clients === 0 && sim.streams.video === null && sim.streams.audio === null, "…the device's app connection is released and its streams are stopped");
  check(await udpFree(vp) && await udpFree(ap), "…and the UDP ports are free again");
  check(browser.closed !== undefined && browser.closed.code === 1001, "…connected clients are closed with 1001 (the page reconnects to whatever /api/config names)", JSON.stringify(browser.closed));
  // this process selects the device again; the assistant follows
  const re = await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: sim.restPort }, { projectDir: PROJ });
  const newReg = state.readBridgeEntry("127.0.0.1", sim.restPort);
  check(re.notes.every((n) => !/attached/.test(n)) && newReg && newReg.pid !== cli.proc.pid, "select starts a bridge (detached) when none runs", re.notes.join(" | ").slice(0, 160));
  const st3 = await mcp.call("runtime_session_status", { session_id: "shared" });
  check(/Runtime session status \(C64 Ultimate\)/.test(st3) && st3.includes(newReg.endpoint), "…and the assistant's next call is on the C64 Ultimate, through the NEW bridge", st3.split("\n").slice(0, 2).join(" | "));
  const notice = await mcp.call("runtime_session_status", { session_id: "shared" });
  check(sim.clients === 1 && sim.refused === 0, "…one connection at the device", `clients=${sim.clients} refused=${sim.refused}`);
  void notice;
  browser.close(); watcher.close();

  // ═══ F ═══════════════════════════════════════════════════════════════════════════════════════
  head("F  idle exit");
  await be.selectBackend({ kind: "emulator" });
  await mcp.call("runtime_session_status", { session_id: "shared" }).catch(() => undefined); // let it notice
  const simI = await fake({});
  const h = await launch.ensureBridge({ host: "127.0.0.1", restPort: simI.restPort, projectDir: PROJ, idleExit: 3 });
  check(h.attached === false && h.ping.idleExit?.armedSeconds === 3, "C64RE starts the bridge DETACHED with an idle window (ping.idleExit.armedSeconds)", JSON.stringify(h.ping.idleExit));
  const hpid = h.pid;
  const view = await wsClient(h.endpoint);           // an A/V subscriber
  await sleep(4500);
  check(alive(hpid), "an A/V subscriber HOLDS the idle clock (Spec 886 rules): still up after longer than the window");
  const ping2 = await ping(h.endpoint);
  check(ping2.idleExit.holding === "subscriber" && ping2.idleExit.deadlineMs === null, "…ping says what holds it", JSON.stringify(ping2.idleExit));
  view.close();
  const rpcOnly = await wsClient(h.endpoint, { av: false });
  await sleep(2000);
  await rpcOnly.call("session/list");
  await sleep(2000);
  check(alive(hpid), "a request restarts the window (an RPC-only client holds nothing but its requests count)");
  const ka = await rpcOnly.call("daemon/keep_alive", { seconds: 6 });
  check(ka.armed === true && ka.keptAliveUntilMs > Date.now(), "daemon/keep_alive holds it for N s", JSON.stringify(ka));
  await sleep(4500);
  check(alive(hpid), "…and it was still up after the window");
  const kf = await rpcOnly.call("daemon/keep_alive", { seconds: null });
  check(kf.keptForever === true, "daemon/keep_alive null = never on idle");
  await rpcOnly.call("daemon/keep_alive", { seconds: 0 });
  rpcOnly.close();
  check(await until(() => !alive(hpid), 9000), "with nothing holding it the bridge ends itself after the window");
  check(simI.clients === 0 && simI.streams.video === null && simI.streams.audio === null, "…on the way out it stopped the device's streams and released the device's connection");
  check(state.readBridgeEntry("127.0.0.1", simI.restPort) === undefined, "…and left the registry");

  // ═══ I ═══════════════════════════════════════════════════════════════════════════════════════
  head("I  a bridge that ended");
  // `be` (this process) selected nothing alive now; select the device, kill the bridge hard, then ask
  await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: simI.restPort }, { projectDir: PROJ });
  const r1 = state.readBridgeEntry("127.0.0.1", simI.restPort);
  const s1 = await be.runtimeDaemon.state("shared");
  check(s1.cpu.pc === 0x0810, "(a bridge is selected and answers)");
  process.kill(r1.pid, "SIGKILL");
  await until(() => !alive(r1.pid), 3000);
  await sleep(300); // the device sees the dropped connection
  const s2 = await be.runtimeDaemon.state("shared");
  const r2 = state.readBridgeEntry("127.0.0.1", simI.restPort);
  check(s2.cpu.pc === 0x0810 && r2.pid !== r1.pid && simI.clients === 1, "a process that used the device starts its bridge again (the bridge ended; the device kept its state)", `old ${r1.pid} new ${r2?.pid}`);
  check(/the C64U bridge for 127\.0\.0\.1 had ended/.test(idleMod.takeFreshRuntimeNotice() ?? ""), "…and the answer carries a notice that it did");
  // a FRESH process with a stale record: not abandoned to a dead bridge, and not made to use the device
  process.kill(r2.pid, "SIGKILL");
  await until(() => !alive(r2.pid), 3000);
  be.resetBackendForTests();
  check(be.activeBackend().kind === "emulator" && be.currentSelection().kind === "emulator", "a fresh process finds the record of a bridge that is gone and uses the emulator (the default); it never picks a stale device");
  rmSync(state.selectionFile(), { force: true });
  await sleep(500);

  // ═══ H ═══════════════════════════════════════════════════════════════════════════════════════
  head("H  the REST password");
  const PW = "hunter2-889-bridge-secret";
  const locked = await fake({ password: PW });
  const hp = await launch.ensureBridge({ host: "127.0.0.1", restPort: locked.restPort, password: PW, projectDir: PROJ });
  check(hp.ping.bridge.state === "ready" && locked.requests.some((q) => q.password === PW), "a bridge started with a password (handed over on stdin) talks to the device with it");
  const argv = spawnSync("ps", ["-o", "args=", "-p", String(hp.pid)]).stdout.toString();
  check(argv.includes("c64u-bridge") && !argv.includes(PW), "the password is not in the bridge's command line", argv.trim().slice(0, 160));
  const found = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); let s; try { s = statSync(p); } catch { continue; } if (s.isDirectory()) walk(p); else if (s.size < 64 * 1024 * 1024 && readFileSync(p).includes(PW)) found.push(p); } };
  walk(SANDBOX);
  check(found.length === 0, "…and in no file under the state directory, the project or the logs", found.join(", "));
  const hc = await wsClient(hp.endpoint, { av: false });
  const stp = JSON.stringify(await hc.call("bridge/status")) + JSON.stringify(await hc.call("ping"));
  check(!stp.includes(PW), "…and in no answer the bridge gives");
  hc.close();
  const cliPw = runBridgeCli(["--device", `127.0.0.1:${locked.restPort}`, "--password-stdin", "--port", String(await freePort())], { stdin: PW + "\n", env: {} });
  const clPwLine = await cliPw.first();
  check(clPwLine?.c64u_bridge === "already-running", "(a second hand start with a password finds the first)");
  await launch.shutdownBridge(hp.endpoint);
  check(await until(() => !alive(hp.pid), 5000), "(stopped on request: bridge/shutdown answers after the streams and the device connection are released)");
  void cliPw;

  // ═══ J ═══════════════════════════════════════════════════════════════════════════════════════
  head("J  two devices, two bridges; a switch frees the fixed ports first");
  const P1 = await freePort(), P2 = await freePort();
  process.env.C64RE_C64U_VIDEO_PORT = String(P1);
  process.env.C64RE_C64U_AUDIO_PORT = String(P2);
  const A = await fake(), B = await fake();
  await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: A.restPort }, { projectDir: PROJ });
  const ra = state.readBridgeEntry("127.0.0.1", A.restPort);
  check(await until(() => A.streams.video?.endsWith(`:${P1}`) && A.streams.audio?.endsWith(`:${P2}`)), "the fixed UDP ports from the environment are the ones the device is told");
  const stock = await fake({ trx64: false });
  const errS = await rejects(be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: stock.restPort }));
  check(/stock core|cannot be selected/.test(errS ?? "") && be.currentSelection().restPort === A.restPort && A.streams.video !== null && alive(ra.pid), "a device that cannot be selected leaves the old choice AND its bridge and streams running", errS);
  const rb = await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: B.restPort }, { projectDir: PROJ });
  check(await until(() => B.streams.video?.endsWith(`:${P1}`) && B.streams.audio?.endsWith(`:${P2}`) && A.streams.video === null), "a switch to another device stops the old bridge (its streams), THEN the new one binds the same fixed ports", JSON.stringify({ A: A.streams, B: B.streams, notes: rb.notes }));
  check(await until(() => !alive(ra.pid)) && A.clients === 0, "…and the old device's connection is released");
  await be.selectBackend({ kind: "emulator" });
  check(B.streams.video === null && await udpFree(P1) && await udpFree(P2), "back to the emulator: stopped, ports free");
  process.env.C64RE_C64U_VIDEO_PORT = "0"; process.env.C64RE_C64U_AUDIO_PORT = "0";
  mcp.stop();
} finally {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  await reapBridges(STATE);
  for (const s of sims) { try { await s.close(); } catch { /* */ } }
  await sleep(200);
  rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 889 bridge: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
