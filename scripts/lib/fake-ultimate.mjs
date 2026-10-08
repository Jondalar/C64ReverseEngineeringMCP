// Spec 889 — a fake Ultimate, in process, for the backend's smoke.
//
// It stands in for a C64 Ultimate running the TRX64 core and trxmon: an HTTP server with the
// REST routes the backend uses (and /v1/info), a UDP ident responder, and a WebSocket
// JSON-RPC server answering like trxmon (rpc.c): ping with or without `capabilities`,
// -32601 with the app's own reason sentences, ONE client at a time (a second gets -32001
// "port N is held by <peer>" and close 1013), PAUSED on start, `debug/break_add` without `pc`
// adding at $0000, `debug/break_del` without `id` deleting ALL.
//
// Everything binds 127.0.0.1 on ports the OS chose. It talks to nothing else, ever.

import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const listen = (srv, port = 0) => new Promise((res, rej) => { srv.once("error", rej); srv.listen(port, "127.0.0.1", () => res(srv.address().port)); });

export async function startFakeUltimate(opts = {}) {
  const o = {
    trx64: true,                 // false: a stock device (no trx64 field)
    core: "TRX2",
    board: "C64U",
    trxmonRunning: true,
    capabilities: "none",        // "none" | "object" | "array" | "gaps" (object missing some methods)
    runtimeVersion: "trx64-runtime/2",
    backend: "c64u",
    password: undefined,         // REST password
    manifestRest: true,          // false: /v1/apps/trxmon:run answers 403 (an old install)
    startPaused: true,
    trxmonPath: "/Flash/apps/trxmon.u2a",
    ...opts,
  };

  const sim = {
    requests: [],      // every REST request: {method, path, query, bodySha, bodyLen, json}
    rpcLog: [],        // every RPC request: {method, params}
    runState: "paused",
    stop: null,
    breakpoints: [],   // {num, addr}
    nextBp: 1,
    heldPeer: undefined,
    clients: 0,
    refused: 0,
    trxmonRunning: false,
    rpcPort: undefined,
    streams: { video: null, audio: null }, // the `ip=host:port` each stream was last started to (null: stopped)
  };
  const APP_METHODS = [
    "ping", "session/create", "session/list", "session/close", "session/state", "session/run", "session/read_memory",
    "debug/state", "debug/pause", "debug/continue", "debug/run", "debug/step", "debug/break_add", "debug/break_del", "debug/break_list",
    "monitor/exec", "monitor/state", "trxmon/quit",
    "checkpoint/list", "checkpoint/capture", "checkpoint/restore", "checkpoint/pin", "checkpoint/unpin",
    "mark/set", "mark/list", "mark/drop", "mark/goto",
    "transport/status", "transport/frame", "transport/goto", "transport/pause", "transport/play", "transport/toggle",
    "runtime/reverse_step", "runtime/who_wrote", "runtime/crash_triage", "runtime/set_reverse_depth",
  ];
  const NOTIFS = ["debug/running", "debug/paused", "debug/stopped", "debug/breakpoint_hit", "debug/observer_hit"];

  // ---- the app's WebSocket JSON-RPC (one client) ----------------------------------------
  let wss;
  const clients = new Set();
  const notify = (method, params) => { for (const c of clients) { try { c.send(JSON.stringify({ jsonrpc: "2.0", method, params })); } catch { /* gone */ } } };
  const debugState = () => ({
    runState: sim.runState, pc: 0x0810, cycles: 123456, frame: 7,
    breakpoints: sim.breakpoints.map((b) => ({ num: b.num, addr: b.addr })),
    stop: sim.runState === "paused" ? (sim.stop ?? null) : null, controlOwner: "human",
  });
  const NOT_OFFERED = [
    [["sandbox/", "runtime/candidate_", "runtime/scenario_", "runtime/overlay_run", "runtime/promote_branch", "runtime/snapshot_tree", "vic/", "recorder/", "vsf/", "session/model", "audio/", "batch/", "session/set_pacing", "session/turbo", "runtime/find_cheat", "runtime/component_diff"], ": not on C64 Ultimate hardware; use a local TRX64 sandbox"],
    [["media/", "session/load_prg", "runtime/run_prg", "session/type", "session/key_down", "session/key_up", "session/release_keys", "session/joystick_", "session/pot_", "session/screenshot", "session/frame_indices", "session/reset", "session/power", "session/drive", "device/", "runtime/swap_disk_and_continue", "runtime/render_screen"], ": media, machine and input are the Ultimate's REST API (/v1/...), not trxmon"],
    [["trace/", "debug/memory_access_map"], ": the trace store and its analyses are host-side"],
  ];
  const notOffered = (m) => {
    for (const [prefixes, why] of NOT_OFFERED) if (prefixes.some((p) => m.startsWith(p))) return { code: -32601, message: m + why };
    return { code: -32601, message: "method not found: " + m };
  };

  function rpc(method, params) {
    switch (method) {
      case "ping": {
        const r = { runtime_version: o.runtimeVersion, version: "trxmon 0.1", backend: o.backend, project: null };
        if (o.capabilities === "object") r.capabilities = { methods: APP_METHODS, notifications: NOTIFS };
        else if (o.capabilities === "array") r.capabilities = [...APP_METHODS, ...NOTIFS];
        else if (o.capabilities === "gaps") r.capabilities = { methods: APP_METHODS.filter((m) => m !== "runtime/who_wrote" && m !== "transport/toggle"), notifications: NOTIFS };
        if (o.capabilities !== "none") r.build = { trxmon_git: "abc1234", firmware_git: "def5678", firmware_version: "3.15" };
        return { result: r };
      }
      case "session/state": return { result: { c64Cycles: 123456, runState: sim.runState, powered: true, mode: "hardware", backend: "c64u", cpu: { pc: 0x0810, a: 1, x: 2, y: 3, sp: 0xf6, flags: 0x20, cycles: 123456 }, model: "c64-pal", controlOwner: "human", streamPump: false } };
      case "session/create": return { result: { sessionId: "shared", mode: "hardware", diskPath: "", c64Cycles: 123456, pc: 0x0810, trace: null, attached: true, model: "c64-pal" } };
      case "session/list": return { result: [{ sessionId: "shared", mode: "hardware", diskPath: "", c64Cycles: 123456 }] };
      case "session/close": return { result: { existed: true, released: [] } };
      case "session/read_memory": {
        const addr = Number(params.addr ?? 0), len = Number(params.length ?? params.len ?? 1);
        if (len > 32768) return { error: { code: -32602, message: "read_memory: 32768 bytes is the cap" } };
        return { result: { addr, length: len, lens: params.lens ?? "cpu", bytes: Array.from({ length: len }, (_, i) => (addr + i) & 0xff), c64Cycles: 123456 } };
      }
      case "debug/state": return { result: debugState() };
      case "debug/pause": { const was = sim.runState === "running"; sim.runState = "paused"; sim.stop = { reason: "pause", pc: 0x0810, cycles: 1 }; if (was) notify("debug/paused", { stop: sim.stop }); return { result: debugState() }; }
      case "debug/continue": case "debug/run": { const was = sim.runState === "paused"; sim.runState = "running"; sim.stop = null; if (was) notify("debug/running", {}); return { result: debugState() }; }
      case "debug/step": sim.stop = { reason: "step", pc: 0x0813, cycles: 3 }; notify("debug/stopped", { stop: sim.stop }); return { result: debugState() };
      case "debug/break_add": { const pc = Number(params.pc ?? 0); const num = sim.nextBp++; sim.breakpoints.push({ num, addr: pc }); return { result: { num, breakpoints: sim.breakpoints.map((b) => ({ ...b })) } }; }
      case "debug/break_del": {
        if (params.id !== undefined) sim.breakpoints = sim.breakpoints.filter((b) => b.num !== Number(params.id));
        else sim.breakpoints = [];
        return { result: { deleted: true, breakpoints: sim.breakpoints.map((b) => ({ ...b })) } };
      }
      case "debug/break_list": return { result: { breakpoints: sim.breakpoints.map((b) => ({ ...b })) } };
      case "monitor/exec": {
        // the monitor's run-control verbs act on the machine and are announced, as rpc.c does
        const cmd = String(params.command ?? "").trim();
        if (cmd === "pause") { const was = sim.runState === "running"; sim.runState = "paused"; sim.stop = { reason: "pause", pc: 0x0810, cycles: 1 }; if (was) notify("debug/paused", { stop: sim.stop }); }
        else if (cmd === "run") { const was = sim.runState === "paused"; sim.runState = "running"; sim.stop = null; if (was) notify("debug/running", {}); }
        return { result: { text: `ok: ${params.command ?? ""}`, output: `ok: ${params.command ?? ""}`, spans: [] } };
      }
      case "monitor/state": return { result: { mode: "hardware" } };
      case "checkpoint/list": return { result: { checkpoints: [] } };
      case "trxmon/quit": setTimeout(() => sim.stopTrxmon(), 10); return { result: { ok: true } };
      default:
        if (method.startsWith("mark/") || method.startsWith("transport/") || method.startsWith("checkpoint/") || method.startsWith("runtime/")) {
          if (APP_METHODS.includes(method)) return { result: { ok: true, method } };
        }
        return { error: notOffered(method) };
    }
  }

  async function startRpc() {
    wss = new WebSocketServer({ port: sim.rpcPort ?? 0, host: "127.0.0.1" });
    await new Promise((res, rej) => { wss.once("listening", res); wss.once("error", rej); });
    sim.rpcPort = wss.address().port;
    wss.on("connection", (ws, req) => {
      const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
      if (clients.size >= 1) {
        sim.refused++;
        const msg = `port ${sim.rpcPort} is held by ${sim.heldPeer} (trxmon serves one RPC connection at a time)`;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: msg } }));
        ws.close(1013, msg);
        return;
      }
      clients.add(ws); sim.clients = clients.size; sim.heldPeer = peer;
      ws.on("close", () => { clients.delete(ws); sim.clients = clients.size; if (!clients.size) sim.heldPeer = undefined; });
      ws.on("message", (data) => {
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        sim.rpcLog.push({ method: m.method, params: m.params ?? {} });
        const r = rpc(m.method, m.params ?? {});
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...(r.error ? { error: r.error } : { result: r.result }) }));
      });
    });
    sim.trxmonRunning = true;
    sim.runState = o.startPaused ? "paused" : "running";
    sim.stop = o.startPaused ? { reason: "pause", pc: 0x0810, cycles: 0 } : null;
  }
  sim.startTrxmon = async () => { if (!sim.trxmonRunning) await startRpc(); };
  sim.stopTrxmon = () => {
    if (!sim.trxmonRunning) return;
    for (const c of clients) { try { c.terminate(); } catch { /* gone */ } }
    clients.clear(); sim.clients = 0; sim.heldPeer = undefined;
    wss.close(); sim.trxmonRunning = false;
  };
  /** A person at the machine: RUN/STOP. */
  sim.personPauses = () => { sim.runState = "paused"; sim.stop = { reason: "pause", pc: 0x0900, cycles: 99 }; notify("debug/paused", { stop: sim.stop }); };
  sim.personBreaks = () => { sim.runState = "paused"; sim.stop = { reason: "breakpoint", pc: 0xc000, cycles: 99, breakpointId: 1 }; notify("debug/breakpoint_hit", { stop: sim.stop }); };

  // ---- REST ---------------------------------------------------------------------------------
  const http = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://x");
      const query = Object.fromEntries(url.searchParams);
      const rec = { method: req.method, path: url.pathname, query, bodyLen: body.length, bodySha: body.length ? sha256(body) : undefined, contentType: req.headers["content-type"], password: req.headers["x-password"] };
      if ((req.headers["content-type"] ?? "").includes("json") && body.length) { try { rec.json = JSON.parse(body.toString()); } catch { /* invalid */ } }
      sim.requests.push(rec);
      const send = (code, obj) => { const b = JSON.stringify({ ...obj, errors: obj.errors ?? [] }); res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) }); res.end(b); };
      if (o.password && req.headers["x-password"] !== o.password) return send(403, { errors: ["Forbidden."] });
      const p = url.pathname;
      const key = `${req.method} ${p}`;
      if (key === "GET /v1/info") {
        const info = { product: "Ultimate 64-II (fake)", firmware_version: "3.15", git_commit_hash: "5ee21b65", fpga_version: "125", core_version: "1.01", hostname: "fake-ultimate", ...(o.password ? { password_protected: true } : {}) };
        if (o.trx64) info.trx64 = { core: o.core, caps: "0x1", board: o.board, ...(sim.trxmonRunning ? { rpc: sim.rpcPort } : {}) };
        return send(200, info);
      }
      const startApp = async () => {
        if (sim.trxmonRunning) return send(423, { errors: ["Could not obtain lock of subsystem"] });
        await sim.startTrxmon();
        return send(200, { app: "trxmon", action: query.action ?? "serve", exit_code: 0, output: "" });
      };
      if (key === "PUT /v1/apps:run_file") {
        if (query.app !== o.trxmonPath) return send(404, { errors: ["Cannot open file"] });
        return void startApp();
      }
      if (key === "PUT /v1/apps/trxmon:run") {
        if (!o.manifestRest) return send(403, { errors: ["App 'trxmon' cannot be started over REST"] });
        return void startApp();
      }
      if (["POST /v1/runners:load_prg", "POST /v1/runners:run_prg", "POST /v1/runners:run_crt"].includes(key)) return send(200, {});
      if (req.method === "POST" && /^\/v1\/drives\/[ab]:mount$/.test(p)) return send(200, {});
      if (req.method === "PUT" && /^\/v1\/drives\/[ab]:(remove|on|off|reset)$/.test(p)) return send(200, {});
      if (key === "GET /v1/drives") return send(200, { drives: [{ a: { enabled: true, bus_id: 8, type: "1541", rom: "1541.rom", image_file: "disk.d64", image_path: "/Temp" } }, { b: { enabled: false, bus_id: 9, type: "1541", rom: "1541.rom", image_file: "", image_path: "" } }] });
      if (req.method === "PUT" && /^\/v1\/machine:(reset|reboot|poweroff)$/.test(p)) return send(200, {});
      if (key === "POST /v1/machine:input") {
        const ev = rec.json?.events;
        if (!Array.isArray(ev) || ev.length < 1 || ev.length > 64) return send(400, { errors: ["`events` must contain 1..64 entries."] });
        return send(200, { keyboard: { inputs: [] }, joysticks: [{ port: 1, inputs: [] }, { port: 2, inputs: [] }] });
      }
      // §4c: the stream enable. A unicast start replaces the target; stopping a stopped stream is fine.
      const sm = /^\/v1\/streams\/(video|audio):(start|stop)$/.exec(p);
      if (req.method === "PUT" && sm) {
        const [, name, verb] = sm;
        if (o.streamsRefuse) return send(o.streamsRefuse, { errors: ["streams are refused by this fake"] });
        const finish = () => {
          if (verb === "start") {
            if (!/^[^:]+:\d+$/.test(query.ip ?? "")) return send(400, { errors: ["`ip` must be host:port"] });
            sim.streams[name] = query.ip;
          } else sim.streams[name] = null;
          return send(200, {});
        };
        return o.streamsDelayMs ? void setTimeout(finish, o.streamsDelayMs) : void finish();
      }
      return send(404, { errors: [`no such route in the fake: ${key}`] });
    });
  });
  sim.restPort = await listen(http);

  // ---- UDP ident ----------------------------------------------------------------------------
  const udp = createSocket("udp4");
  await new Promise((res, rej) => { udp.once("error", rej); udp.bind(0, "127.0.0.1", res); });
  sim.identPort = udp.address().port;
  sim.identRequests = [];
  udp.on("message", (msg, rinfo) => {
    const s = msg.toString();
    sim.identRequests.push(s);
    if (!s.startsWith("json")) return;
    const j = { product: "Ultimate 64-II (fake)", firmware_version: "3.15", fpga_version: "125", core_version: "1.01", hostname: "fake-ultimate", menu_header: "fake", your_string: s.slice(4, 36) };
    if (o.password) j.password_protected = true;
    if (o.trx64) j.trx64 = { core: o.core, caps: "0x1", board: o.board, ...(sim.trxmonRunning ? { rpc: sim.rpcPort } : {}) };
    udp.send(JSON.stringify(j), rinfo.port, rinfo.address);
  });

  if (o.trxmonRunning) await startRpc();

  sim.stop = sim.stop ?? null;
  sim.close = async () => {
    sim.stopTrxmon();
    await new Promise((r) => http.close(() => r()));
    http.closeAllConnections?.();
    await new Promise((r) => udp.close(() => r()));
  };
  return sim;
}
