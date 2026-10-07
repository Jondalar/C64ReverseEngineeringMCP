#!/usr/bin/env node
// Spec 889 §2 / §4 / §4c — the C64 Ultimate in the workbench: backend wiring, the server's relay,
// the selection API behind the UI's selector, and the page's own client code.
//
// Hermetic: a fake Ultimate (REST, ident, the app's one-client WS), a stand-in for the emulator's
// WS, a UDP sender on 127.0.0.1, and the workbench server as a child process on a free port.
// Nothing here contacts a device or any LAN host, binds :4312, or touches a daemon it did not start.
//
//   A  wiring: streams start on select (not waited for), relayed as the UI's binary frames,
//      audio/start carries the rate, screenshot from the stream, paused = notification, re-arm
//      after a reset, stop on deselect and on a switch (the fixed ports are free first), env
//      overrides, a refusing device, a failing select leaves the old streams alone
//   B  the workbench server: /api/config, devices, select (asks first), start-monitor, REST password
//   C  the relay WebSocket: calls, refusals by name, notifications, video, audio gated by audio/start,
//      stream/paused, a late page gets the last frame, other origins refused, monitor over the backend
//   D  the page's own WsClient (esbuild bundle, real WebSocket) against the real server: the emulator
//      path unchanged, a switch via restart(), the path back
//   E  the password: in no reply, no file, no log, no browser storage
//   F  the UI source and the built bundle carry the selector, the dialog and the paused marker
//
// Exit 0 = pass, 1 = fail.   npm run smoke:889-ui
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { startFakeUltimate } from "./lib/fake-ultimate.mjs";
import { AudioGen, VideoGen, col, udpSender } from "./lib/stream-datagrams.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (c, m, d = "") => { c ? pass++ : failCount++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${!c && d !== "" ? `  (${String(d).slice(0, 300)})` : ""}`); };
const head = (t) => console.log(`\n── ${t}`);
const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(15); } return !!(await f()); };
const rejects = async (p) => { try { await p; return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); } };

if (!existsSync(join(ROOT, "dist/runtime/backend.js")) || !existsSync(join(ROOT, "dist/workspace-ui/server.js"))) { console.log("FAIL  dist is not built (npm run build:mcp)"); process.exit(1); }

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const freeUdp = () => new Promise((res, rej) => { const s = createSocket("udp4"); s.once("error", rej); s.bind(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const udpFree = (port) => new Promise((res) => { const s = createSocket("udp4"); s.once("error", () => res(false)); s.bind(port, "0.0.0.0", () => s.close(() => res(true))); });

// The sandbox: everything the server may write lives under here.
const SANDBOX = mkdtempSync(join(tmpdir(), "c64re-889ui-"));
for (const d of ["proj", "home", "tmp", "cwd"]) mkdirSync(join(SANDBOX, d), { recursive: true });
const PROJ = join(SANDBOX, "proj");

// In-process runs: the UDP ports are the OS's choice unless a section names them.
process.env.C64RE_C64U_VIDEO_PORT = "0";
process.env.C64RE_C64U_AUDIO_PORT = "0";
delete process.env.C64RE_RUNTIME_BACKEND;
delete process.env.C64RE_C64U_RECEIVER_HOST;
delete process.env.C64RE_C64U_STREAM_SOURCE;

const be = await dist("runtime/backend.js");
const { C64UBackend, DEFAULT_VIDEO_PORT, DEFAULT_AUDIO_PORT } = await dist("runtime/c64u/c64u-backend.js");
const { ProjectKnowledgeService } = await dist("project-knowledge/service.js");
new ProjectKnowledgeService(PROJ).initProject({ name: "889ui" });

console.log("Spec 889 — the C64 Ultimate in the workbench\n");

const sims = [];
const fake = async (o) => { const s = await startFakeUltimate(o); sims.push(s); return s; };
const reqs = (sim, re) => sim.requests.filter((q) => re.test(`${q.method} ${q.path}`));
const portOf = (ip) => Number(String(ip).split(":")[1]);
const vic = new VideoGen();
const sendFrame = async (tx, port, no, h = 272) => { for (const d of vic.frame(no, h)) await tx.send(port, d); };

try {
  // ═══ A ═══════════════════════════════════════════════════════════════════════════════════
  head("A  wiring: the streams belong to the selected backend");
  {
    check(DEFAULT_VIDEO_PORT === 11000 && DEFAULT_AUDIO_PORT === 11001, "UDP ports default to 11000 (video) / 11001 (audio)");
    const sim = await fake({ streamsDelayMs: 700 });
    const tx = await udpSender();
    const t0 = Date.now();
    const r = await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: sim.restPort });
    const took = Date.now() - t0;
    const b = be.activeBackend();
    check(b.kind === "c64u" && took < 600, "select returns while the device is still answering the (ARP-slow) stream starts", `${took} ms`);
    check(r.notes.some((n) => /picture and sound: listening on UDP \d+ \(video\) \/ \d+ \(audio\)/.test(n)), "…and the notes say where it listens and that the start is not waited for");
    check(b.streamStatus().running === true && b.streamStatus().status.streams.video.phase !== "idle", "the backend owns a stream receiver while selected");
    await b.streamsSettled();
    const vp = b.streamStatus().status.ports.video, ap = b.streamStatus().status.ports.audio;
    check(portOf(sim.streams.video) === vp && portOf(sim.streams.audio) === ap, "the device was told to send video and audio to the receiver's ports", JSON.stringify(sim.streams));
    check(sim.streams.video.startsWith("127.0.0.1:"), "receiverHost defaults to the local address towards the device", sim.streams.video);
    check(reqs(sim, /PUT \/v1\/streams\/video:start/).length === 1 && reqs(sim, /PUT \/v1\/streams\/audio:start/).length === 1, "one start per stream");

    // binary relay
    const bin = [];
    const off = b.onBinary((m) => bin.push(m));
    const notes = [];
    const offN = b.onNotification((n) => { if (n.method === "stream/paused") notes.push(n.params); });
    await sendFrame(tx, vp, 1);
    check(await until(() => bin.some((m) => m.kind === "video")), "a complete frame arrives as a video message");
    const v = bin.find((m) => m.kind === "video").data;
    const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
    check(v[0] === 0x01 && v.length === 5 + 58 + 384 * 272 && dv.getUint16(5, true) === 384 && dv.getUint16(7, true) === 272 && v[9] === 1, "…as the UI's own frame: type 0x01, 384x272, palette-indexed");
    let px = true;
    for (let y = 0; y < 272 && px; y += 17) for (let x = 0; x < 384; x += 13) if (v[5 + 58 + y * 384 + x] !== col(1, y, x)) { px = false; break; }
    check(px, "…with the pixels where the device put them");
    const audioTx = new AudioGen();
    await tx.send(ap, audioTx.packet(1000));
    check(await until(() => bin.some((m) => m.kind === "audio")), "an audio packet arrives as an audio message");
    const a = bin.find((m) => m.kind === "audio").data;
    check(a[0] === 0x02 && a.length === 5 + 768 && new DataView(a.buffer, a.byteOffset).getInt16(5, true) === 1000, "…type 0x02, raw s16le stereo");
    const as = await b.call("audio/start", { session_id: "shared" });
    check(as.sampleRate === 48003.07 && as.channels === 2, "audio/start answers with the device's rate 48,003.07 Hz", JSON.stringify(as));
    check((await b.call("audio/stop", { session_id: "shared" })).ok === true, "audio/stop is answered");

    // screenshot from the stream
    const shot = await b.call("session/screenshot", { session_id: "shared" });
    check(shot.dataUrl.startsWith("data:image/png;base64,") && shot.width === 384 && shot.height === 272 && shot.frame === 1 && typeof shot.ageMs === "number", "session/screenshot is the last stream frame, in the daemon's shape with its age and the device's frame counter", JSON.stringify({ w: shot.width, f: shot.frame }));
    const fi = await b.call("session/frame_indices", { session_id: "shared" });
    check(fi.width === 384 && Buffer.from(fi.indices, "base64").length === 384 * 272, "session/frame_indices is served from the same frame");

    // paused: the stream goes quiet, the last frame stays
    check(await until(() => notes.some((n) => n.paused === true), 3000), "no video for a quarter second → notification stream/paused {paused:true}");
    const pn = notes.find((n) => n.paused === true);
    check(typeof pn.ageMs === "number" && pn.ageMs >= 0, "…carrying the age of the last frame in ms", JSON.stringify(pn));
    check(b.pausedState().paused === true && b.lastVideo()?.length === v.length, "the backend keeps the paused verdict and the last frame for a page that connects late");
    await sendFrame(tx, vp, 2);
    check(await until(() => notes.some((n) => n.paused === false)), "video again → stream/paused {paused:false}");

    // rearm after a system reset
    const before = reqs(sim, /PUT \/v1\/streams\/video:start/).length;
    await b.call("session/reset", {});
    check(await until(() => reqs(sim, /PUT \/v1\/streams\/video:start/).length === before + 1 && reqs(sim, /PUT \/v1\/streams\/audio:start/).length >= 2), "a system reset re-arms: the device is asked to send again");
    await b.streamsSettled();

    // deselect: stop on the device, sockets closed
    off(); offN();
    const sel = await be.selectBackend({ kind: "emulator" });
    check(sel.identity.kind === "emulator" && sim.streams.video === null && sim.streams.audio === null, "select back to the emulator stops both streams on the device");
    check(reqs(sim, /PUT \/v1\/streams\/audio:stop/).length >= 1 && sim.requests.findIndex((q) => q.path === "/v1/streams/audio:stop") < sim.requests.findIndex((q) => q.path === "/v1/streams/video:stop"), "…audio first, then video");
    check(await udpFree(vp) && await udpFree(ap), "…and the UDP ports are free again when select returns");
    await tx.close();
    await sim.close();
  }
  {
    // switching device A → B: the fixed ports are freed BEFORE the new device binds them
    const P1 = await freeUdp(), P2 = await freeUdp();
    const A = await fake(), B = await fake();
    const s = { videoPort: P1, audioPort: P2 };
    await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: A.restPort }, { streams: s });
    const bA = be.activeBackend();
    await bA.streamsSettled();
    check(portOf(A.streams.video) === P1 && portOf(A.streams.audio) === P2, "fixed ports from the configuration are the ones the device is told");
    const stock = await fake({ trx64: false });
    const err = await rejects(be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: stock.restPort }, { streams: s }));
    check(/stock core|cannot be selected/.test(err ?? "") && be.activeBackend() === bA && A.streams.video !== null && bA.streamStatus().running, "a device that cannot be selected leaves the old choice AND its streams running", err);
    const r = await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: B.restPort }, { streams: s });
    const bB = be.activeBackend();
    await bB.streamsSettled();
    check(bB !== bA && A.streams.video === null && portOf(B.streams.video) === P1 && portOf(B.streams.audio) === P2 && !r.notes.some((n) => /unavailable/.test(n)), "a switch to another device stops the old one's streams, then the new one binds the same fixed ports", JSON.stringify({ A: A.streams, B: B.streams, notes: r.notes }));
    await be.selectBackend({ kind: "emulator" });
    check(B.streams.video === null && await udpFree(P1) && await udpFree(P2), "…and back to the emulator releases them");
  }
  {
    // env: receiver host, a port that is not one, a refusing device
    process.env.C64RE_C64U_RECEIVER_HOST = "127.0.0.9";
    const sim = await fake();
    await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: sim.restPort });
    await be.activeBackend().streamsSettled();
    check(sim.streams.video?.startsWith("127.0.0.9:"), "C64RE_C64U_RECEIVER_HOST overrides the address the device is told", sim.streams.video);
    await be.selectBackend({ kind: "emulator" });
    delete process.env.C64RE_C64U_RECEIVER_HOST;

    process.env.C64RE_C64U_VIDEO_PORT = "not-a-port";
    const r = await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: sim.restPort });
    check(be.activeBackend().kind === "c64u" && r.notes.some((n) => /picture and sound unavailable: C64RE_C64U_VIDEO_PORT/.test(n)), "a bad port in the environment does not block the select: the notes say the picture is unavailable and why");
    const e = await rejects(be.activeBackend().call("session/screenshot", { session_id: "shared" }));
    check(/session\/screenshot: no frame to give/.test(e ?? "") && /C64RE_C64U_VIDEO_PORT/.test(e ?? ""), "…and a screenshot names the cause", e);
    const e2 = await rejects(be.activeBackend().call("audio/start", { session_id: "shared" }));
    check(/audio\/start: the device's audio stream is not running here/.test(e2 ?? ""), "audio/start refuses by name when there is no stream", e2);
    process.env.C64RE_C64U_VIDEO_PORT = "0";
    await be.selectBackend({ kind: "emulator" });
    await sim.close();

    const ref = await fake({ streamsRefuse: 500 });
    await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: ref.restPort });
    const bb = be.activeBackend();
    await bb.streamsSettled();
    check(bb.kind === "c64u" && /refused by the device \(HTTP 500\)/.test(bb.streamStatus().trouble ?? ""), "a device that refuses the streams is still selected; the refusal is reported verbatim", bb.streamStatus().trouble);
    const id = await bb.describe();
    check(id.device.streams && typeof id.device.streams.trouble === "string", "describe() carries the stream state for runtime_session_status");
    await be.selectBackend({ kind: "emulator" });
    await ref.close();
    for (const s of sims.splice(0)) await s.close().catch(() => {});
  }

  // ═══ B/C/E ═══════════════════════════════════════════════════════════════════════════════════
  head("B  the workbench server: config, devices, select, start-monitor");
  const PASSWORD = "hunter2-889-secret";
  const HTTP_PORT = await freePort();
  const EMU_PORT = await freePort();
  const emuLog = [];
  const emu = new WebSocketServer({ port: EMU_PORT, host: "127.0.0.1" });
  await new Promise((r) => emu.once("listening", r));
  emu.on("connection", (ws) => {
    emuLog.push({ event: "connect" });
    ws.on("message", (d) => {
      const text = d.toString(); emuLog.push({ event: "message", text });
      let m; try { m = JSON.parse(text); } catch { return; }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { standin: "emulator", method: m.method, params: m.params ?? null } }));
    });
  });
  const EMU_URL = `ws://127.0.0.1:${EMU_PORT}`;

  let serverLog = "";
  const child = spawn(process.execPath, [join(ROOT, "dist/workspace-ui/server.js"), "--port", String(HTTP_PORT), "--project", PROJ, "--api-only"], {
    cwd: join(SANDBOX, "cwd"),
    env: { ...process.env, HOME: join(SANDBOX, "home"), TMPDIR: join(SANDBOX, "tmp"), C64RE_RUNTIME_ENDPOINT: EMU_URL, C64RE_C64U_VIDEO_PORT: "0", C64RE_C64U_AUDIO_PORT: "0", C64RE_RUNTIME_BACKEND: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { serverLog += d; });
  child.stderr.on("data", (d) => { serverLog += d; });
  const BASE = `http://127.0.0.1:${HTTP_PORT}`;
  const http = async (path, init) => {
    const r = await fetch(BASE + path, init);
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, json, text };
  };
  const post = (path, body, headers = { "Content-Type": "application/json" }) => http(path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  check(await until(async () => { try { return (await http("/api/config")).status === 200; } catch { return false; } }, 30000), "the workbench server starts on a free port");

  const dev = await fake({ password: PASSWORD, capabilities: "object" });
  const plain = await fake({ trxmonRunning: false });
  const allReplies = [];
  const remember = (r) => { allReplies.push(r.text); return r; };

  try {
    const cfg0 = remember(await http("/api/config"));
    check(cfg0.json.runtimeWsUrl === EMU_URL && cfg0.json.backend === "emulator" && cfg0.json.emulatorWsUrl === EMU_URL, "/api/config names the emulator's WS exactly as before while the emulator is selected", cfg0.text.trim());
    const st0 = remember(await http("/api/runtime-status"));
    check(JSON.stringify(Object.keys(st0.json).sort()) === JSON.stringify(["projectDir", "reachable", "wsUrl"].sort()) && st0.json.wsUrl === EMU_URL && st0.json.reachable === true, "/api/runtime-status keeps its shape and its probe of the emulator's port");
    const bv0 = remember(await http("/api/runtime/backend"));
    check(bv0.json.kind === "emulator" && bv0.json.identity.kind === "emulator" && bv0.json.runtimeWsUrl === EMU_URL, "GET /api/runtime/backend: the emulator is active");

    // devices
    const d1 = remember(await post("/api/runtime/devices", { scan: false, hosts: [`127.0.0.1:${dev.restPort}`, `127.0.0.1:${plain.restPort}`] }));
    const rowDev = d1.json.devices.find((r) => r.restPort === dev.restPort);
    const rowPlain = d1.json.devices.find((r) => r.restPort === plain.restPort);
    check(d1.json.emulator.selectable === true && d1.json.active.kind === "emulator", "devices: the emulator row is always there");
    check(rowDev.passwordProtected === true && rowDev.selectable === false && /REST password/.test(rowDev.reason), "a password-protected device is listed with its reason, not selectable yet", rowDev.reason);
    check(rowPlain.outcome === "core-no-monitor" && rowPlain.action === "start_monitor" && rowPlain.selectable === false, "our core without trxmon: offered a Start monitor action, not selectable", JSON.stringify(rowPlain));
    const d2 = remember(await post("/api/runtime/devices", { scan: false, hosts: [`127.0.0.1:${dev.restPort}`], host: "127.0.0.1", restPort: dev.restPort, password: PASSWORD }));
    check(d2.json.devices[0].outcome === "offered" && d2.json.devices[0].selectable === true, "the password, given once, makes it offered", JSON.stringify(d2.json.devices[0]));
    const d3 = remember(await post("/api/runtime/devices", { scan: false, hosts: [`127.0.0.1:${dev.restPort}`] }));
    check(d3.json.devices[0].outcome === "offered", "…and the server remembers it for the session (memory only)");
    const udpProbe = await post("/api/runtime/devices", { scan: false, hosts: ["127.0.0.1:not-a-port", "bad host;rm"] });
    remember(udpProbe);
    check(udpProbe.status === 200 && udpProbe.json.devices.length === 0, "an invalid host in the list is dropped, never probed");
    check((await post("/api/runtime/devices", "{", { "Content-Type": "application/json" })).status === 400, "a body that is not JSON is a 400");
    check((await post("/api/runtime/devices", { scan: false }, { "Content-Type": "text/plain" })).status === 415, "a POST that is not application/json is a 415 (a cross-site form cannot reach these routes)");

    // start monitor
    const sm = remember(await post("/api/runtime/backend/start-monitor", { host: "127.0.0.1", restPort: plain.restPort }));
    check(sm.status === 200 && sm.json.started === true && sm.json.device.outcome === "offered" && sm.json.device.selectable, "start-monitor starts trxmon over REST and re-probes: the row becomes offered", sm.text.slice(0, 200));
    check((await post("/api/runtime/backend/start-monitor", { host: "x y" })).status === 400, "start-monitor refuses an invalid host");

    // select asks first
    const noConfirm = remember(await post("/api/runtime/backend/select", { backend: "c64u", host: "127.0.0.1", restPort: dev.restPort, password: PASSWORD }));
    check(noConfirm.status === 409 && noConfirm.json.needsConfirm === true && /C64 Ultimate 127\.0\.0\.1/.test(noConfirm.json.to) && noConfirm.json.from, "select without confirmed:true is a 409 that names both machines", noConfirm.text.slice(0, 200));
    check(!dev.rpcLog.some((r) => r.method === "debug/continue" || r.method === "session/state"), "…and nothing was sent to the device (only probes asked)");
    check((await http("/api/config")).json.backend === "emulator", "…the selection did not change");
    check((await post("/api/runtime/backend/select", { backend: "nothing" })).status === 400 && (await post("/api/runtime/backend/select", { backend: "c64u", host: "a b" })).status === 400, "select validates backend and host");
    check((await post("/api/runtime/backend/select", { backend: "emulator" })).status === 200, "selecting what is already selected needs no confirmation");

    // the relay refuses while the emulator is selected
    const refused = await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/runtime-relay`);
      ws.on("close", (code, reason) => res({ code, reason: reason.toString() }));
      ws.on("error", () => {});
    });
    check(refused.code === 4400 && /no C64 Ultimate is selected/.test(refused.reason), "the relay refuses a page while the emulator is selected (that page goes direct)", JSON.stringify(refused));

    // ═══ D (part 1): the page's own client, emulator path, before any switch
    const { build } = await import("esbuild");
    const wsOut = await build({ entryPoints: [join(ROOT, "ui/src/workbench/ws-client.ts")], bundle: true, format: "esm", platform: "node", write: false });
    const wsFile = join(SANDBOX, "tmp", "ws-client.mjs");
    writeFileSync(wsFile, wsOut.outputFiles[0].text);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (u, i) => realFetch(String(u).startsWith("/") ? BASE + u : u, i);
    const { WsClient } = await import(pathToFileURL(wsFile).href);
    const client = new WsClient();
    const frames = [], states = [], notifs = [];
    client.onBinary(0x01, (f) => frames.push(f));
    client.onBinary(0x02, (f) => frames.push(f));
    client.onNotification("stream/paused", (p) => notifs.push(["stream/paused", p]));
    client.onNotification("debug/paused", (p) => notifs.push(["debug/paused", p]));
    client.onState((s) => states.push(s));
    head("D  the page's WsClient: the emulator path, then a switch, then back");
    client.connect();
    check(await until(() => client.getState() === "open"), "the page's client connects to the URL /api/config names (the emulator)");
    check(client.endpoint === EMU_URL, "…which is the emulator's own endpoint, not the relay", client.endpoint);
    const mark = emuLog.length;
    const r0 = await client.call("session/state", { session_id: "shared" });
    const sent = emuLog.slice(mark).find((e) => e.event === "message");
    check(r0.standin === "emulator" && sent?.text === JSON.stringify({ jsonrpc: "2.0", method: "session/state", params: { session_id: "shared" }, id: 1 }), "the call goes to the emulator as the exact JSON it always was", sent?.text);

    // ═══ select the device for real
    head("C  the relay WebSocket with the C64 Ultimate selected");
    const sel = remember(await post("/api/runtime/backend/select", { backend: "c64u", host: "127.0.0.1", restPort: dev.restPort, confirmed: true }));
    check(sel.status === 200 && sel.json.ok === true && sel.json.kind === "c64u" && sel.json.identity.device.host === "127.0.0.1", "select with confirmed:true selects the device", sel.text.slice(0, 300));
    check(sel.json.notes.some((n) => /trxmon starts the machine PAUSED/.test(n)) && sel.json.notes.some((n) => /picture and sound: listening/.test(n)), "…the notes carry the select's steps, including the streams");
    check(!JSON.stringify(sel.json).includes(PASSWORD), "…and no reply echoes the password");
    check(await until(() => dev.streams.video !== null && dev.streams.audio !== null), "the server's backend asked the device to send picture and sound");
    const VP = portOf(dev.streams.video), AP = portOf(dev.streams.audio);
    const cfg1 = remember(await http("/api/config"));
    check(cfg1.json.backend === "c64u" && cfg1.json.runtimeWsUrl === `ws://127.0.0.1:${HTTP_PORT}/runtime-relay` && cfg1.json.emulatorWsUrl === EMU_URL, "/api/config now names the relay", cfg1.text.trim());
    check((await http("/api/runtime-status")).json.backend === "c64u", "/api/runtime-status reports the device");

    // the page switches over
    client.restart();
    check(await until(() => client.getState() === "open" && client.endpoint === cfg1.json.runtimeWsUrl), "the page's client restart()s onto the relay URL", client.endpoint);
    const st = await client.call("session/state", { session_id: "shared" });
    check(st.backend === "c64u" && st.runState === "running", "a call through the relay is answered by the device's app", JSON.stringify(st));
    check(!emuLog.slice(mark).some((e) => e.event === "message" && /session\/state/.test(e.text) && e.text !== sent.text), "…and the emulator saw none of it");
    const list = await client.call("session/list");
    check(Array.isArray(list) && list[0].sessionId === "shared", "session/list through the relay");
    const refusal = await rejects(client.call("runtime/overlay_run", {}));
    check(/runtime\/overlay_run: no overlay on C64 Ultimate hardware/.test(refusal ?? ""), "a method the device cannot serve is refused by name, through the relay", refusal);
    check(/needs `pc`/.test((await rejects(client.call("debug/break_add", {}))) ?? ""), "the backend's own protections apply through the relay (break_add without pc)");
    const dbg = await client.call("debug/pause", { session_id: "shared" });
    check(dbg.runState === "paused", "debug/pause reaches the device");
    await client.call("debug/continue", { session_id: "shared" });

    // notifications
    dev.personPauses();
    check(await until(() => notifs.some(([m]) => m === "debug/paused")), "the app's notifications reach the page (debug/paused from a person at the machine)");

    // video
    const tx = await udpSender();
    await sendFrame(tx, VP, 5);
    check(await until(() => frames.some((f) => f.type === 0x01)), "video datagrams to the server's port reach the page as type 0x01 frames");
    const fr = frames.find((f) => f.type === 0x01);
    check(fr.payload.length === 58 + 384 * 272 && fr.payload[4] === 1, "…with the payload Live.tsx draws (fmt 1, palette + indices)");
    // audio only after audio/start
    const ag = new AudioGen();
    await tx.send(AP, ag.packet(777));
    await sleep(150);
    check(!frames.some((f) => f.type === 0x02), "audio is NOT sent to a page that did not ask for it");
    const asr = await client.call("audio/start", { session_id: "shared" });
    check(asr.sampleRate === 48003.07, "audio/start through the relay carries the device's sample rate");
    await tx.send(AP, ag.packet(888));
    check(await until(() => frames.some((f) => f.type === 0x02)), "after audio/start the page receives audio messages");
    await client.call("audio/stop", { session_id: "shared" });
    const nAudio = frames.filter((f) => f.type === 0x02).length;
    await tx.send(AP, ag.packet(999));
    await sleep(150);
    check(frames.filter((f) => f.type === 0x02).length === nAudio, "after audio/stop it receives none");

    // paused marker signal
    check(await until(() => notifs.some(([m, p]) => m === "stream/paused" && p.paused === true), 3000), "no video → the page gets stream/paused {paused:true}");
    const sp = notifs.find(([m, p]) => m === "stream/paused" && p.paused === true)[1];
    check(typeof sp.ageMs === "number", "…with the age of the last frame", JSON.stringify(sp));
    // a second page connecting now (paused) gets the verdict and the last frame at once
    const late = await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/runtime-relay`);
      ws.binaryType = "arraybuffer";
      const got = { notes: [], bins: 0 };
      ws.on("message", (d, isBin) => { if (isBin) got.bins++; else { try { got.notes.push(JSON.parse(d.toString())); } catch { /* */ } } });
      setTimeout(() => { ws.close(); res(got); }, 400);
    });
    check(late.notes.some((n) => n.method === "stream/paused" && n.params.paused === true) && late.bins === 1, "a page that connects while paused gets stream/paused and the last frame at once", JSON.stringify({ n: late.notes.length, b: late.bins }));
    await sendFrame(tx, VP, 6);
    check(await until(() => notifs.some(([m, p]) => m === "stream/paused" && p.paused === false)), "video again → stream/paused {paused:false}");

    // other origins are refused
    const evil = await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/runtime-relay`, { headers: { Origin: "http://evil.example" } });
      ws.on("unexpected-response", (_rq, rs) => res(rs.statusCode));
      ws.on("open", () => { ws.close(); res("open"); });
      ws.on("error", () => res("error"));
    });
    check(evil === 403 || evil === "error", "a page of another origin cannot open the relay", String(evil));
    const same = await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/runtime-relay`, { headers: { Origin: `http://127.0.0.1:${HTTP_PORT}` } });
      ws.on("open", () => { ws.close(); res(true); });
      ws.on("error", () => res(false));
    });
    check(same === true, "…while the page's own origin can");
    const other = await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/elsewhere`);
      ws.on("open", () => { ws.close(); res("open"); });
      ws.on("error", () => res("refused"));
    });
    check(other === "refused", "any other WebSocket path is refused");

    // gate through the relay, monitor through the backend
    const medium = join(PROJ, "game.prg");
    writeFileSync(medium, Buffer.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00, 0x60]));
    const gated = await rejects(client.call("session/load_prg", { path: medium }));
    check(/no green emulator run in this project|has no green/.test(gated ?? ""), "the emulator gate applies to a medium sent through the relay", gated);
    const mon = remember(await post("/api/monitor/exec", { sessionId: "shared", command: "r" }));
    check(mon.status === 200 && /ok: r/.test(mon.json.text ?? mon.json.output ?? ""), "the workbench monitor goes over the backend (no daemon WS to open)", mon.text.slice(0, 200));

    // ═══ the way back
    head("D  the way back");
    const closed = new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/runtime-relay`); ws.on("close", (c, r) => res({ code: c, reason: r.toString() })); });
    await sleep(100);
    const back = remember(await post("/api/runtime/backend/select", { backend: "emulator" }));
    check(back.status === 409, "switching back asks first as well");
    const back2 = remember(await post("/api/runtime/backend/select", { backend: "emulator", confirmed: true }));
    check(back2.status === 200 && back2.json.kind === "emulator", "…and with confirmed:true the emulator is the runtime again");
    const cl = await closed;
    check(cl.code === 4001, "connected relay pages are told to reconnect (close 4001)", JSON.stringify(cl));
    check(dev.streams.video === null && dev.streams.audio === null && await udpFree(VP) && await udpFree(AP), "the device's streams are stopped and the UDP ports are free");
    const cfg2 = remember(await http("/api/config"));
    check(cfg2.json.runtimeWsUrl === EMU_URL && cfg2.json.backend === "emulator", "/api/config names the emulator's WS again, as it was");
    client.restart();
    check(await until(() => client.getState() === "open" && client.endpoint === EMU_URL), "the page's client restart()s back onto the emulator");
    const mark2 = emuLog.length;
    const again = await client.call("session/list");
    const sent2 = emuLog.slice(mark2).find((e) => e.event === "message");
    check(again.standin === "emulator" && sent2.text.startsWith('{"jsonrpc":"2.0","method":"session/list"') && !("params" in JSON.parse(sent2.text)), "the emulator path after the round trip: the same JSON-RPC bytes as before");
    client.disconnect();
    globalThis.fetch = realFetch;
    await tx.close();

    // ═══ E: the password
    head("E  the password");
    check(allReplies.every((t) => !t.includes(PASSWORD)), "no HTTP reply of the server contained the password");
    check(!serverLog.includes(PASSWORD), "the server's output never contained it");
    const found = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        let s; try { s = statSync(p); } catch { continue; }
        if (s.isDirectory()) walk(p);
        else if (s.size < 64 * 1024 * 1024 && readFileSync(p).includes(PASSWORD)) found.push(p);
      }
    };
    walk(SANDBOX);
    check(found.length === 0, "the password is in no file under the project, home, temp or working directory", found.join(", "));
    check(dev.requests.some((q) => q.password === PASSWORD), "(control: it did reach the device, in X-Password)");
  } finally {
    child.kill("SIGTERM");
    await sleep(200);
    emu.close();
  }

  // ═══ F ═══════════════════════════════════════════════════════════════════════════════════
  head("F  the UI: source and built bundle");
  {
    const src = (p) => readFileSync(join(ROOT, p), "utf8");
    const sel = src("ui/src/workbench/components/BackendSelector.tsx");
    check(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(sel), "the selector never puts the password (or anything) in browser storage");
    check(/type="password"/.test(sel) && /autoComplete="off"/.test(sel), "the REST password is a password field, no autocomplete");
    check(/TRX64 \(emulator\)/.test(sel) && /Start monitor/.test(sel) && /Rescan/.test(sel) && /no password/.test(sel), "the selector shows the emulator row, Start monitor, Rescan and the RPC-port note");
    check(/Switch the runtime\?/.test(sel) && /id="be889-leave"[^>]*autoFocus|autoFocus[^>]*id="be889-leave"/.test(sel), "switching asks first, and the safe answer has the focus (as the project switch)");
    check(/BackendSelector/.test(src("ui/src/App.tsx")) && /restart\(\)/.test(sel), "the selector is in the top bar and restarts the page's runtime connection after a switch");
    const live = src("ui/src/workbench/tabs/Live.tsx");
    check(/onNotification\("stream\/paused"/.test(live) && /wb-screen-streampaused/.test(live) && /last frame/.test(live), "the Live tab marks a paused stream and shows the age of the last frame");
    const mc = src("ui/src/workbench/components/MachineControls.tsx");
    check(/audio\/start/.test(mc) && /setStreamRate\(rate\)/.test(mc), "MachineControls applies the stream rate from audio/start");
    const distDir = join(ROOT, "ui/dist/assets");
    if (existsSync(distDir)) {
      const js = readdirSync(distDir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(distDir, f), "utf8")).join("\n");
      check(js.includes("Switch the runtime?") && js.includes("stream/paused") && js.includes("/api/runtime/backend/select") && js.includes("Start monitor"), "the built bundle (ui:build) carries the selector, the dialog and the paused marker");
    } else console.log("  SKIP  ui/dist not built (npm run ui:build)");
  }
} finally {
  await be.selectBackend({ kind: "emulator" }).catch(() => {});
  for (const s of sims) await s.close().catch(() => {});
  rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 889 UI: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
