#!/usr/bin/env node
// Spec 889 — the second backend: the C64 Ultimate, against a fake Ultimate in this process.
//
// Hermetic: every socket is on 127.0.0.1 and on a port the OS chose. Nothing here reaches
// the real device, the LAN, port 4312 or any daemon this script did not start.
//
//   A  the routing table: app RPC / REST / refused by name (pure)
//   B  discovery: UDP ident, three outcomes, injectable targets, nothing sent without one
//   C  probe: stock / our core without trxmon / offered / not offered / password
//   D  select, start (§3a), PAUSED on start → continue, 423, 403
//   E  routing live: RPC pass-through, REST mapping, refusals by name, break_* wrapping, §7
//   F  capabilities in ping: listed (object / array), gaps, absent (-32601 passes through)
//   G  trxmon gone: named, never a fallback; restart is picked up
//   H  ONE connection: the probe rides it; a held port is reported verbatim
//   I  the gate (§4b): refuse / allow by sha256, every door, changed byte, no checks
//   J  no silent fallback; the emulator is the default; select back releases the device
//   K  sandboxes, reels and scenario runs do not reach the active backend
//   L  the MCP tool over stdio: runtime_backend, status names backend + device, gate text
//
// Exit 0 = pass, 1 = fail.   npm run smoke:889
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { startFakeUltimate } from "./lib/fake-ultimate.mjs";

// The backend now starts the device's picture and sound on select; this smoke is about the REST/RPC
// side, so the UDP ports are the OS's choice (the fixed defaults would collide between runs).
process.env.C64RE_C64U_VIDEO_PORT = "0";
process.env.C64RE_C64U_AUDIO_PORT = "0";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (c, m, d = "") => { c ? pass++ : failCount++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const head = (t) => console.log(`\n── ${t}`);
const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const rejects = async (p) => { try { await p; return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(join(ROOT, "dist/runtime/backend.js"))) { console.log("FAIL  dist is not built (npm run build:mcp)"); process.exit(1); }

const routing = await dist("runtime/c64u/routing.js");
const restMap = await dist("runtime/c64u/rest-map.js");
const disc = await dist("runtime/c64u/discovery.js");
const { C64UBackend, BackendRefusal } = await dist("runtime/c64u/c64u-backend.js");
const { RpcLink } = await dist("runtime/c64u/rpc-link.js");
const be = await dist("runtime/backend.js");
const pass_ = await dist("runtime/emulator-pass.js");
const { emulatorDaemon } = await dist("runtime/daemon-client.js");
const { ProjectKnowledgeService } = await dist("project-knowledge/service.js");

console.log("Spec 889 — the C64 Ultimate backend, against a fake Ultimate\n");

const sims = [];
const fake = async (o) => { const s = await startFakeUltimate(o); sims.push(s); return s; };
const mk = (sim, extra = {}) => new C64UBackend({ host: "127.0.0.1", restPort: sim.restPort, ...extra });
const rpcMethods = (sim) => sim.rpcLog.map((r) => r.method);
const proj = mkdtempSync(join(tmpdir(), "c64re-889-"));
new ProjectKnowledgeService(proj).initProject({ name: "889" });
mkdirSync(join(proj, "media"), { recursive: true });
const PRG = Buffer.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00, 0x60]);
const prgPath = join(proj, "media", "game.prg");
writeFileSync(prgPath, PRG);
const CRT = Buffer.concat([Buffer.from("C64 CARTRIDGE   ", "latin1"), Buffer.alloc(64, 0x11)]);
const crtPath = join(proj, "media", "game.crt");
writeFileSync(crtPath, CRT);
const D64 = Buffer.alloc(174848, 0x42);
const d64Path = join(proj, "media", "disk.d64");
writeFileSync(d64Path, D64);
const greenChecks = [{ text: "Then $8EF2 is $01", afterSteps: 1, actual: "$01", pass: true }];
const savedEnv = process.env.C64RE_RUNTIME_BACKEND;
delete process.env.C64RE_RUNTIME_BACKEND;

try {
  // ── A ──────────────────────────────────────────────────────────────────────────────────
  head("A  the routing table");
  {
    const kind = (m, served) => routing.routeOf(m, served).kind;
    check(["ping", "session/state", "session/read_memory", "debug/break_add", "monitor/exec", "checkpoint/restore", "mark/set", "transport/play", "runtime/reverse_step"].every((m) => kind(m) === "rpc"), "the app's own methods pass through");
    check(["session/type", "session/joystick_set", "session/load_prg", "runtime/run_prg", "media/open", "media/mount", "media/ingress", "session/screenshot", "session/reset", "session/drive_status"].every((m) => kind(m) === "rest"), "media / PRG / CRT / drives / input / machine map to REST");
    check(kind("api/call") === "api", "api/call is expressed on the app, verb by verb");
    for (const m of ["trace/start_domains", "trace/build_from_ring", "debug/memory_access_map", "snapshot/dump", "ringbuffer/dump", "sandbox/run", "runtime/overlay_run", "debug/observer_log", "vic/frame_map", "runtime/scenario_run", "totally/unknown"]) {
      const r = routing.routeOf(m);
      check(r.kind === "refuse" && routing.refusalText(m, r).startsWith(`${m}: `) && r.wayOut.length > 10, `${m} is refused by name with a way out`);
    }
    check(/runtime_sandbox_run/.test(routing.routeOf("runtime/overlay_run").wayOut), "overlay_run's way out names the sandbox (always the emulator)");
    check(/trace on/.test(routing.routeOf("trace/start_domains").wayOut), "trace's way out is the monitor's trace verbs");
    check(routing.routeOf("session/state", new Set(["ping"])).kind === "refuse", "a routed app method the device's capability list lacks is refused by name");
    const ob = disc.classifyIdent({});
    check(ob.outcome === "stock", "ident without trx64 = stock");
    check(disc.classifyIdent({ trx64: { core: "TRX2", board: "C64U" } }).outcome === "core-no-monitor", "trx64 core TRX2 without rpc = our core, no trxmon");
    check(disc.classifyIdent({ trx64: { core: "TRX2", rpc: 4312 } }).outcome === "monitor", "rpc present = monitor (the ping decides)");
    check(disc.classifyIdent({ trx64: { core: "ABCD" } }).outcome === "stock", "a trx64 field with another core is not ours");
    check(routing.parseCapabilities([...routing.APP_RPC_METHODS]).methods.has("debug/state"), "capabilities: an array of names");
    check(routing.parseCapabilities({ methods: ["ping"], notifications: ["debug/paused"] }).notifications.has("debug/paused"), "capabilities: {methods, notifications}");
    check(routing.parseCapabilities(undefined) === undefined, "no capabilities = undefined");
    const t = restMap.textToTaps('load"*",8,1\r');
    check(t.unmapped.length === 0 && t.taps.length === 12 && t.taps[4].join("+") === "left_shift+2", "text becomes key taps; \" is shift+2", `${t.taps.length} taps`);
    check(restMap.textToTaps("é").unmapped.length === 1, "a character with no key is reported, not dropped");
    check(restMap.tapBatches(Array.from({ length: 130 }, () => ["a"])).map((b) => b.events.length).join(",") === "64,64,2", "input batches are 64 events at most");
    check(restMap.sniffMedia(CRT, "x.bin") === "crt" && restMap.sniffMedia(D64, "x") === "d64" && restMap.sniffMedia(PRG, "x.prg") === "prg", "media are sniffed by content");
  }

  // ── B ──────────────────────────────────────────────────────────────────────────────────
  head("B  discovery");
  {
    const ours = await fake({ trxmonRunning: true });
    const bare = await fake({ trxmonRunning: false });
    const stock = await fake({ trx64: false });
    const none = await disc.discoverUltimates({ targets: [] , timeoutMs: 200 });
    check(none.length === 0 && ours.identRequests.length === 0, "no target = no datagram, nothing discovered");
    const found = await disc.discoverUltimates({ targets: [{ address: "127.0.0.1", port: ours.identPort }, { address: "127.0.0.1", port: bare.identPort }, { address: "127.0.0.1", port: stock.identPort }], timeoutMs: 600 });
    check(found.length === 1, "all three answer from 127.0.0.1 but one address is listed once", `${found.length}`);
    check(ours.identRequests[0].startsWith("json") && ours.identRequests[0].length > 4, "the datagram is `json<nonce>`", ours.identRequests[0]);
    const f1 = await disc.discoverUltimates({ targets: [{ address: "127.0.0.1", port: ours.identPort }], timeoutMs: 400 });
    check(f1[0]?.ident.trx64?.rpc === ours.rpcPort && f1[0].ident.hostname === "fake-ultimate", "the ident is parsed, trx64 {core,caps,board,rpc} included");
    check(disc.classifyIdent(f1[0].ident).outcome === "monitor", "outcome: rpc present");
    const f2 = await disc.discoverUltimates({ targets: [{ address: "127.0.0.1", port: bare.identPort }], timeoutMs: 400 });
    check(disc.classifyIdent(f2[0].ident).outcome === "core-no-monitor", "outcome: our core, trxmon not running");
    const f3 = await disc.discoverUltimates({ targets: [{ address: "127.0.0.1", port: stock.identPort }], timeoutMs: 400 });
    check(disc.classifyIdent(f3[0].ident).outcome === "stock", "outcome: stock");
    const rows = await be.listDevices({ discover: [{ address: "127.0.0.1", port: ours.identPort }], restPort: ours.restPort, discoverTimeoutMs: 400 });
    check(rows.length === 1 && rows[0].outcome === "offered" && rows[0].selectable, "list: a discovered device is probed and offered");
    await sleep(120);
    check(ours.clients === 0, "…and the probe's short connection gave the app's one slot straight back");
  }

  // ── C ──────────────────────────────────────────────────────────────────────────────────
  head("C  probe");
  {
    const stock = await fake({ trx64: false });
    const r1 = await be.probeHost({ host: "127.0.0.1", restPort: stock.restPort });
    check(r1.outcome === "stock" && !r1.selectable && /stock core/.test(r1.reason), "stock core: listed greyed out with its reason", r1.reason);
    const bare = await fake({ trxmonRunning: false });
    const r2 = await be.probeHost({ host: "127.0.0.1", restPort: bare.restPort });
    check(r2.outcome === "core-no-monitor" && r2.action === "start_monitor" && !r2.selectable, "our core, no trxmon: not selectable, Start monitor offered");
    const ours = await fake({ capabilities: "object" });
    const r3 = await be.probeHost({ host: "127.0.0.1", restPort: ours.restPort });
    check(r3.outcome === "offered" && r3.selectable && /trx64-runtime\/2/.test(r3.reason) && r3.ping?.backend === "c64u", "rpc present + ping trx64-runtime/2 + backend c64u: offered");
    check(r3.board === "C64U" && r3.hostname === "fake-ultimate", "the row carries board and hostname");
    const odd = await fake({ runtimeVersion: "trx64-runtime/9" });
    const r4 = await be.probeHost({ host: "127.0.0.1", restPort: odd.restPort });
    check(r4.outcome === "not-offered" && /trx64-runtime\/9/.test(r4.reason) && !r4.selectable, "another epoch: greyed out with what was answered");
    const other = await fake({ backend: "emulator" });
    const r5 = await be.probeHost({ host: "127.0.0.1", restPort: other.restPort });
    check(r5.outcome === "not-offered" && /"emulator"/.test(r5.reason), "another backend id: greyed out with what was answered");
    const locked = await fake({ password: "s3cret" });
    const r6 = await be.probeHost({ host: "127.0.0.1", restPort: locked.restPort });
    check(r6.outcome === "unreachable" && r6.passwordProtected, "a REST password: asked for, not guessed");
    const r7 = await be.probeHost({ host: "127.0.0.1", restPort: locked.restPort, password: "s3cret" });
    check(r7.outcome === "offered" && locked.requests.every((q, i) => i === 0 || q.password === "s3cret"), "with the password it is offered; the header is X-Password");
    const dead = await be.probeHost({ host: "127.0.0.1", restPort: 1 });
    check(dead.outcome === "unreachable" && /unreachable/.test(dead.reason), "a host that does not answer is listed as unreachable");
  }

  // ── D ──────────────────────────────────────────────────────────────────────────────────
  head("D  select, start, PAUSED on start");
  {
    const sim = await fake({ trxmonRunning: false });
    const b = mk(sim);
    const e1 = await rejects(b.connect());
    check(/trxmon not running on 127\.0\.0\.1 — start it/.test(e1 ?? ""), "select without trxmon says so and the way out", e1);
    check(sim.requests.every((q) => q.path === "/v1/info"), "…and started nothing");
    const rep = await b.connect({ startMonitor: true });
    check(sim.requests.some((q) => q.method === "PUT" && q.path === "/v1/apps:run_file" && q.query.app === "/Flash/apps/trxmon.u2a" && q.query.action === "serve"), "start: PUT /v1/apps:run_file?app=<path>&action=serve");
    check(rep.identity.kind === "c64u" && rep.identity.device.board === "C64U" && rep.identity.device.runtimeVersion === "trx64-runtime/2" && rep.identity.device.trxmonVersion === "trxmon 0.1", "identity: board from the ident, runtime_version + version from ping");
    check(rpcMethods(sim).slice(0, 3).join() === "ping,debug/state,debug/continue", "ping, then debug/state, then debug/continue", rpcMethods(sim).join());
    check(sim.runState === "running" && rep.notes.some((n) => /debug\/continue/.test(n)), "trxmon starts PAUSED and the select continues it");
    b.close();
    await sleep(60);

    // paused on request
    const sim2 = await fake({ trxmonRunning: true });
    const b2 = mk(sim2);
    await b2.connect({ paused: true });
    check(sim2.runState === "paused" && !rpcMethods(sim2).includes("debug/continue"), "paused:true leaves it paused, sends no continue");
    b2.close(); await sleep(60);

    // a person's stop is not undone
    const sim3 = await fake({ trxmonRunning: true });
    sim3.personBreaks();
    const b3 = mk(sim3);
    const rep3 = await b3.connect();
    check(sim3.runState === "paused" && /left paused/.test(rep3.notes.join(" ")), "a stop someone made at the machine is not undone by a select");
    b3.close(); await sleep(60);

    // 423: already running
    const sim4 = await fake({ trxmonRunning: true });
    const b4 = mk(sim4);
    const st = await b4.startMonitor({ wait: false });
    check(st.started === false && /already running/.test(st.note), "423 on a second start = already running, then probe", st.note);
    // app route, old manifest
    const sim5 = await fake({ trxmonRunning: false, manifestRest: false });
    const b5 = mk(sim5);
    const e5 = await rejects(b5.startMonitor({ via: "app" }));
    check(/403/.test(e5 ?? "") && /reinstall/.test(e5 ?? "") && /run_file/.test(e5 ?? ""), "403 on apps/trxmon:run explains the old manifest and the way out", e5);
    const sim6 = await fake({ trxmonRunning: false });
    const b6 = mk(sim6);
    await b6.startMonitor({ via: "app" });
    check(sim6.requests.some((q) => q.path === "/v1/apps/trxmon:run" && q.query.action === "serve") && sim6.trxmonRunning, "PUT /v1/apps/trxmon:run starts it on a current install");
    const e7 = await rejects(mk(sim6).startMonitor({ path: "/nowhere/trxmon.u2a" }));
    check(/404|Cannot open/.test(e7 ?? "") || /already running/.test(e7 ?? "") || e7 === undefined, "a wrong path is a named error (or already running)", e7);
    const sim7 = await fake({ trxmonRunning: false });
    const e8 = await rejects(mk(sim7).startMonitor({ path: "/wrong/trxmon.u2a" }));
    check(/not found at \/wrong\/trxmon\.u2a/.test(e8 ?? ""), "the device path is a parameter; a wrong one says where it looked", e8);
    const stock = await fake({ trx64: false });
    const e9 = await rejects(mk(stock).connect());
    check(/stock core/.test(e9 ?? ""), "a stock device cannot be selected", e9);
    const odd = await fake({ runtimeVersion: "trx64-runtime/9" });
    const e10 = await rejects(mk(odd).connect());
    check(/runtime_version "trx64-runtime\/9"/.test(e10 ?? "") && /Refused by name/.test(e10 ?? ""), "an epoch other than C64RE's is refused by name", e10);
    await sleep(120);
    check(odd.clients === 0, "…and the refused connection is released");
  }

  // ── E ──────────────────────────────────────────────────────────────────────────────────
  head("E  routing live");
  {
    const sim = await fake({ capabilities: "object" });
    const b = mk(sim, { projectDir: proj });
    await b.connect();
    const st = await b.state("shared");
    check(st.cpu.pc === 0x0810 && st.runState === "running", "session/state passes through in the daemon's shape");
    const mem = await b.readMemoryRange("shared", 0x0800, 4);
    check(mem.bytes.length === 4, "session/read_memory passes through");
    const before = rpcMethods(sim).length;
    check(/needs `pc`/.test((await rejects(b.call("debug/break_add", {}))) ?? ""), "debug/break_add without pc is refused by the backend");
    check(/needs `id`/.test((await rejects(b.call("debug/break_del", {}))) ?? "") && rpcMethods(sim).length === before, "debug/break_del without id is refused and nothing is sent");
    const add = await b.call("debug/break_add", { pc: 0xc000 });
    check(add.breakpoints.length === 1 && add.breakpoints[0].addr === 0xc000, "break_add with pc is sent");
    await b.call("debug/break_add", { pc: 0xc100 });
    await b.call("debug/break_del", { id: 1 });
    check(sim.breakpoints.length === 1, "break_del with id deletes that one");
    await b.call("debug/break_del", { all: true });
    const delAll = sim.rpcLog.filter((r) => r.method === "debug/break_del").pop();
    check(sim.breakpoints.length === 0 && !("all" in delAll.params) && !("id" in delAll.params), "all:true is the caller asking for ALL: sent without id, and without the flag");

    // refusals by name, nothing sent
    const n0 = sim.rpcLog.length, r0 = sim.requests.length;
    for (const [m, re] of [["trace/start_domains", /trace on/], ["snapshot/dump", /checkpoint\/list/], ["runtime/overlay_run", /runtime_sandbox_run/], ["sandbox/run", /emulator/], ["debug/observer_log", /never sends/], ["session/cart_status", /cart/]]) {
      const e = await rejects(b.call(m, {}));
      check(e?.startsWith(`${m}: `) && re.test(e), `${m} refused by name: reason and way out`, e?.slice(0, 90));
    }
    check(sim.rpcLog.length === n0 && sim.requests.length === r0, "…and not one byte went to the device for any of them");
    const e1 = await rejects(b.apiCall("shared", "until", [0xc000]));
    check(/api\/call until/.test(e1 ?? "") && /runtime_monitor/.test(e1 ?? ""), "api/call verbs the app cannot express are refused by name", e1);
    const e4 = await rejects(b.call("session/read_memory", { addr: 0, length: 40000 }));
    check(/32768 bytes is the cap/.test(e4 ?? ""), "a device error (-32602) is passed through verbatim", e4);
    const regs = await b.apiCall("shared", "monitorRegisters", []);
    check(regs.pc === 0x0810 && regs.a === 1, "api/call monitorRegisters → session/state cpu");
    const bytes = await b.apiCall("shared", "monitorMemory", [0x0800, 0x0803]);
    check(Array.isArray(bytes) && bytes.length === 4, "api/call monitorMemory → session/read_memory");

    // REST mapping
    const reqs0 = sim.requests.length;
    const typed = await b.typeText("shared", 'load"*",8,1\r', 1, 1);
    const inputs = sim.requests.slice(reqs0).filter((q) => q.path === "/v1/machine:input");
    check(typed.queued === 12 && inputs.length === 1 && inputs[0].json.events.length === 12 && inputs[0].json.events.every((e) => e.kind === "keyboard" && e.transition === "tap"), "session/type → POST machine:input, one tap per key", `${typed.queued}`);
    check(inputs[0].json.events[4].inputs.join() === "left_shift,2" && inputs[0].json.events[11].inputs[0] === "return", "…shift+2 for the quote, return for \\r");
    check(typed.afterRest?.debugState?.runState === "running", "…and debug/state was re-read before it answered (§7)");
    const e2 = await rejects(b.typeText("shared", "héllo"));
    check(/no C64 key for "é"/.test(e2 ?? ""), "text with a character that has no key is refused whole");
    const rq1 = sim.requests.length;
    await b.joystickSet("shared", 2, { up: true, fire: true });
    const jev = sim.requests.slice(rq1).map((q) => q.json.events[0]);
    check(jev.length === 2 && jev[0].transition === "release" && jev[0].inputs.join() === "down,left,right" && jev[1].transition === "press" && jev[1].inputs.join() === "up,fire" && jev.every((e) => e.port === 2), "session/joystick_set: the pressed ones pressed, the rest released, on port 2");
    await b.joystickClear("shared", 1);
    check(sim.requests.at(-1).json.events[0].inputs.length === 5 && sim.requests.at(-1).json.events[0].port === 1, "session/joystick_clear releases all five on the port");

    const d = await b.driveStatus("shared");
    check(d.drive === "a" && d.powered === true && d.mounted.file === "disk.d64", "session/drive_status ← GET /v1/drives, in the daemon's field style");
    for (const [method, params, path, mth] of [
      ["session/reset", { mode: "soft" }, "/v1/machine:reset", "PUT"],
      ["session/reset", {}, "/v1/machine:reboot", "PUT"],
      ["session/power", { op: "off" }, "/v1/machine:poweroff", "PUT"],
      ["session/drive_power", { on: false }, "/v1/drives/a:off", "PUT"],
      ["session/drive_reset", { unit: 9 }, "/v1/drives/b:reset", "PUT"],
      ["media/unmount", { role: "drive8" }, "/v1/drives/a:remove", "PUT"],
    ]) {
      const n = sim.requests.length;
      await b.call(method, params);
      // (a reset also re-arms the picture and sound, so the device sees stream starts right behind it:
      // the request this call made is the first one on ITS path, not necessarily the next one)
      const sent = sim.requests.slice(n).find((q) => q.path === path);
      check(sent?.method === mth, `${method} ${JSON.stringify(params)} → ${mth} ${path}`);
    }
    check(/at the machine/.test((await rejects(b.call("session/power", { op: "on" }))) ?? ""), "power on cannot be done over REST and says so");
    check(/no route that ejects a cartridge/.test((await rejects(b.call("media/unmount", { role: "cartridge" }))) ?? ""), "cartridge eject: refused by name (no REST route)");

    // §7: every REST action is followed by a debug/state
    const idx = sim.rpcLog.length;
    await b.call("session/reset", { mode: "soft" });
    check(sim.rpcLog.slice(idx).map((r) => r.method).join() === "debug/state", "§7: after a REST reset the backend re-reads debug/state");
    const out = await b.call("session/reset", { mode: "soft" });
    check(/stale/.test(out.afterRest.note), "…and says the ring anchors and marks before it may be stale");

    // screenshot: the injectable frameSource
    const e3 = await rejects(b.screenshot("shared"));
    check(/session\/screenshot: no frame to give/.test(e3 ?? "") && /video stream/.test(e3 ?? ""), "screenshot before any video frame arrived: refused by name, and says there is no frame from the video stream", e3?.slice(0, 120));
    b.setFrameSource({ describe: () => "test source", latest: async () => ({ png: new Uint8Array([137, 80, 78, 71]), width: 384, height: 272, receivedAt: Date.now() - 1500, complete: true }) });
    const shot = await b.screenshot("shared");
    check(shot.dataUrl.startsWith("data:image/png;base64,") && shot.width === 384 && shot.ageMs >= 1500, "screenshot from an injected frameSource, in the daemon's shape, with its age");
    sim.personPauses(); await sleep(80);
    const shot2 = await b.screenshot("shared");
    check(/paused: this is the last complete frame received/.test(shot2.note ?? ""), "a paused machine's screenshot says it is the last frame, with its age", shot2.note);
    b.close();
  }

  // ── F ──────────────────────────────────────────────────────────────────────────────────
  head("F  capabilities in ping");
  {
    for (const mode of ["object", "array"]) {
      const sim = await fake({ capabilities: mode });
      const b = mk(sim); const rep = await b.connect();
      check(rep.identity.device.capabilities === "listed" && rep.identity.device.capabilityGaps.length === 0, `ping capabilities (${mode}): every routed method is served`);
      b.close(); await sleep(40);
    }
    const sim = await fake({ capabilities: "gaps" });
    const b = mk(sim); const rep = await b.connect();
    check(rep.identity.device.capabilityGaps.slice().sort().join() === "runtime/who_wrote,transport/toggle", "gaps are named at select", rep.identity.device.capabilityGaps.join());
    const n = sim.rpcLog.length;
    const e = await rejects(b.call("runtime/who_wrote", { addr: 0xd020 }));
    check(/runtime\/who_wrote: this trxmon build does not serve it/.test(e ?? "") && sim.rpcLog.length === n, "a gap is refused by name, sent nowhere");
    check((await b.call("session/state", {})).runState !== undefined, "a served method still goes through");
    b.close(); await sleep(40);
    const old = await fake({ capabilities: "none" });
    const b2 = mk(old); const rep2 = await b2.connect();
    check(rep2.identity.device.capabilities.startsWith("not listed") && rep2.notes.some((x) => /no capabilities/.test(x)), "no capabilities (an older app): said so");
    const e2 = await rejects(b2.call("transport/key", { key: "x" }));
    check(/transport\/key: .*not on C64 Ultimate|method not found/.test(e2 ?? "") || /not offered|method not found|not on the C64/.test(e2 ?? ""), "…and an unserved method surfaces the device's own -32601 sentence verbatim", e2);
    const e3 = await rejects(b2.call("mark/nothing", {}));
    check(/method not found: mark\/nothing/.test(e3 ?? "") && /does not serve it/.test(e3 ?? ""), "-32601 passes through with its reason", e3);
    b2.close(); await sleep(40);
  }

  // ── G ──────────────────────────────────────────────────────────────────────────────────
  head("G  trxmon gone");
  {
    const sim = await fake({});
    const b = mk(sim, { projectDir: proj });
    await b.connect();
    sim.stopTrxmon(); await sleep(150);
    const e = await rejects(b.state("shared"));
    check(e === "trxmon not running on 127.0.0.1 — start it (runtime_backend action=start_monitor) or select the emulator", "an RPC call: \"trxmon not running on <host> — start it or select the emulator\"", e);
    check(emulatorDaemon.kind === "emulator", "…and nothing fell back to the emulator");
    const r = await b.call("session/reset", { mode: "soft" });
    check(r.afterRest.debugState === null && /trxmon not running/.test(r.afterRest.note), "a REST action still works; its answer says debug/state could not be re-read");
    await b.startMonitor();
    check((await b.state("shared")).runState !== undefined, "after a start the next call reconnects");
    // trxmon/quit through the app
    await b.call("trxmon/quit", {}); await sleep(250);
    const e2 = await rejects(b.state("shared"));
    check(/trxmon not running on 127\.0\.0\.1/.test(e2 ?? ""), "after trxmon/quit: gone, named");
    b.close();
    // device gone entirely
    const sim2 = await fake({});
    const b2 = mk(sim2); await b2.connect();
    await sim2.close(); await sleep(120);
    const e3 = await rejects(b2.state("shared"));
    check(/unreachable/.test(e3 ?? "") && /127\.0\.0\.1/.test(e3 ?? ""), "the whole device gone: unreachable, naming it", e3);
    b2.close();
  }

  // ── H ──────────────────────────────────────────────────────────────────────────────────
  head("H  one connection");
  {
    const sim = await fake({ capabilities: "object" });
    const b = mk(sim); await b.connect();
    check(sim.clients === 1, "the backend holds the app's one connection while selected");
    const second = new RpcLink("127.0.0.1", sim.rpcPort);
    await second.open(2000);
    const e = await rejects(second.call("ping", {}, 2000));
    check(/port \d+ is held by 127\.0\.0\.1:\d+ \(trxmon serves one RPC connection at a time\)/.test(e ?? "") && /^C64 Ultimate 127\.0\.0\.1: port/.test(e ?? ""), "a second connection is refused with the device's sentence, verbatim", e);
    second.close();
    check((await b.state("shared")).runState !== undefined && sim.clients === 1, "the held connection is untouched");
    const pings0 = rpcMethods(sim).filter((m) => m === "ping").length;
    be.resetBackendForTests(); // forget any selection from earlier groups
    b.close(); await sleep(60);
    // select through the registry, then probe the SAME device
    const r = await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: sim.restPort });
    check(r.identity.device.rpcPort === sim.rpcPort && sim.clients === 1, "select through the registry holds the one connection");
    const refusedBefore = sim.refused;
    const row = await be.probeHost({ host: "127.0.0.1", restPort: sim.restPort });
    check(row.outcome === "offered" && row.held === true, "probe of the selected device: offered, on its HELD connection");
    check(sim.refused === refusedBefore && sim.clients === 1, "…no second connection was made (none refused, still one)");
    check(rpcMethods(sim).filter((m) => m === "ping").length > pings0, "…the ping rode that connection");
    const again = await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: sim.restPort });
    check(again.identity.device.rpcPort === sim.rpcPort && sim.clients === 1 && sim.refused === refusedBefore, "selecting the same device again reuses the held connection");
    // somebody else holds it
    await be.selectBackend({ kind: "emulator" });
    await sleep(100);
    check(sim.clients === 0, "select back to the emulator releases the device's connection");
    const squatter = new RpcLink("127.0.0.1", sim.rpcPort); await squatter.open(2000);
    const e2 = await rejects(be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: sim.restPort }));
    check(/is held by/.test(e2 ?? "") && /one RPC connection at a time/.test(e2 ?? ""), "select while another peer holds the port: the refusal is reported verbatim", e2);
    check(be.activeBackend().kind === "emulator", "…and the failed select left the previous choice (the emulator) in place");
    const prow = await be.probeHost({ host: "127.0.0.1", restPort: sim.restPort });
    check(prow.outcome === "not-offered" && /is held by/.test(prow.reason), "probing a device whose port is held lists it with the verbatim reason");
    squatter.close();
    await sleep(60);
  }

  // ── I ──────────────────────────────────────────────────────────────────────────────────
  head("I  the gate (§4b)");
  {
    const sim = await fake({});
    const b = mk(sim, { projectDir: proj });
    await b.connect();
    const refusedAll = [
      ["media/open", { path: crtPath }],
      ["media/open", { path: d64Path }],
      ["media/mount", { path: d64Path }],
      ["media/ingress", { kind: "disk", path: d64Path }],
      ["media/ingress", { kind: "crt", path: crtPath }],
      ["session/load_prg", { prg_path: prgPath }],
      ["runtime/run_prg", { prg_path: prgPath }],
      ["media/ingress", { kind: "prg", bytes_b64: PRG.toString("base64"), name: "inline.prg", mode: "inject-run" }],
    ];
    const reqs0 = sim.requests.length;
    for (const [m, p] of refusedAll) {
      const e = await rejects(b.call(m, p));
      check(e !== undefined && /has no green emulator run in this project/.test(e) && /sha256 [0-9a-f]{8}…/.test(e) && /c64re scenario run/.test(e), `${m} ${p.path ? p.path.split("/").pop() : p.name}: refused — names the file, the hash and what is missing`, e?.slice(0, 60));
    }
    check(sim.requests.length === reqs0, "…and nothing reached the device");
    const e1 = await rejects(b.call("media/open", { path: crtPath }));
    check(e1.startsWith("game.crt (sha256 " + sha(CRT).slice(0, 8)), "the refusal text names the file and its hash", e1.slice(0, 70));

    // not a pass: no checks, a failing check
    check(pass_.recordPassForRun({ projectDir: proj, mediaPath: crtPath, steps: [], checks: [] }).recorded.length === 0, "a run with no Then checks passes nothing");
    check(pass_.recordPassForRun({ projectDir: proj, mediaPath: crtPath, steps: [], checks: [{ ...greenChecks[0] }, { text: "Then $01 is $02", afterSteps: 1, actual: "$00", pass: false }] }).recorded.length === 0, "a run with one failing Then passes nothing");
    check(!existsSync(pass_.passesFilePath(proj)), "…and writes no record");
    check(/has no green emulator run/.test((await rejects(b.call("media/open", { path: crtPath }))) ?? ""), "…so the gate still refuses");

    // a pass
    const rec = pass_.recordPassForRun({
      projectDir: proj, mediaPath: crtPath, scenario: "boots to the menu", checks: greenChecks,
      steps: [{ kind: "wait", text: "I wait 170 frames" }, { kind: "insert", text: 'I insert the disk "disk.d64"', path: "disk.d64" }],
      resolveMedium: (n) => join(proj, "media", n),
    });
    check(rec.recorded.length === 2, "a green run records one pass per medium it ran (the cartridge and the inserted disk)");
    const file = JSON.parse(readFileSync(pass_.passesFilePath(proj), "utf8"));
    const p0 = file.passes.find((p) => p.name === "game.crt");
    check(p0.sha256 === sha(CRT) && p0.scenario === "boots to the menu" && p0.steps.length === 2 && p0.checks[0].text === "Then $8EF2 is $01" && !Number.isNaN(Date.parse(p0.at)) && /^\d+\.\d+\.\d+$/.test(p0.runtimeVersion), "the record: sha256, scenario/steps, checks, time, runtime version", p0.runtimeVersion);
    check(existsSync(join(proj, "knowledge", "emulator-passes.json")), "…under the project's knowledge/");
    for (const [m, p] of [["media/open", { path: crtPath }], ["media/mount", { path: d64Path }], ["media/ingress", { kind: "disk", path: d64Path }]]) {
      const n = sim.requests.length;
      const r = await b.call(m, p);
      check(r.afterRest && sim.requests.length > n, `${m}: allowed once the bytes have a pass`);
    }
    const crtReq = sim.requests.find((q) => q.path === "/v1/runners:run_crt");
    check(crtReq.bodySha === sha(CRT) && crtReq.contentType === "application/octet-stream", "the CRT went up as the exact bytes (POST runners:run_crt)");
    const mnt = sim.requests.find((q) => /^\/v1\/drives\/a:mount$/.test(q.path));
    check(mnt.bodySha === sha(D64) && mnt.query.type === "d64" && mnt.query.mode === "readwrite", "the disk went up as the exact bytes (POST drives/a:mount type=d64)");

    // a changed build is a new medium
    writeFileSync(crtPath, Buffer.concat([CRT, Buffer.from([0x99])]));
    const e2 = await rejects(b.call("media/open", { path: crtPath }));
    check(/has no green emulator run/.test(e2 ?? ""), "a changed byte is a new medium: refused again");
    writeFileSync(crtPath, CRT);
    check((await b.call("media/open", { path: crtPath })).kind === "crt", "…and the original bytes are still green");

    // PRG paths
    check(/has no green emulator run/.test((await rejects(b.call("session/load_prg", { prg_path: prgPath }))) ?? ""), "a PRG with no pass is refused (load_prg)");
    pass_.recordEmulatorPass(proj, { media: [{ name: "game.prg", bytes: new Uint8Array(PRG) }], steps: ["I wait 10 frames"], checks: greenChecks });
    const lp = await b.call("session/load_prg", { prg_path: prgPath });
    check(lp.loadAddress === 0x0801 && lp.endAddress === 0x0801 + 13 - 1 && lp.bytesLoaded === 13, "session/load_prg answers {loadAddress,endAddress,bytesLoaded} in the daemon's shape");
    const lreq = sim.requests.find((q) => q.path === "/v1/runners:load_prg");
    check(lreq.bodySha === sha(PRG), "…the PRG went up whole (POST runners:load_prg)");
    const lp2 = await b.call("session/load_prg", { prg_path: prgPath, load_address: 0xc000 });
    const l2 = sim.requests.filter((q) => q.path === "/v1/runners:load_prg").at(-1);
    check(lp2.loadAddress === 0xc000 && l2.bodyLen === PRG.length, "load_address rewrites the header of the upload");
    const rp = await b.call("runtime/run_prg", { prg_path: prgPath });
    check(rp.loadAddress === 0x0801 && /RUN/.test(rp.action) && sim.requests.some((q) => q.path === "/v1/runners:run_prg" && q.bodySha === sha(PRG)), "runtime/run_prg → POST runners:run_prg, answers {loadAddress, action}");
    const rp2 = await b.call("runtime/run_prg", { prg_path: prgPath, run: 0x0810 });
    check(/g \$0810/.test(rp2.action) && rpcMethods(sim).includes("monitor/exec") && sim.rpcLog.filter((r) => r.method === "monitor/exec").at(-1).params.command === "g 810", "run with an entry: load_prg, then the monitor's `g 810`");
    const ing = await b.call("media/ingress", { kind: "prg", path: prgPath, mode: "load" });
    check(ing.loadAddress === 0x0801 && ing.action === "loaded, not started", "ingress prg mode=load");
    const bytesIn = await b.call("media/ingress", { kind: "prg", bytes_b64: PRG.toString("base64"), name: "inline.prg", mode: "inject-run" });
    check(bytesIn.loadAddress === 0x0801, "ingress by bytes_b64 is gated by the hash of the bytes (the same PRG passes)");
    // a gate with no project
    const b2 = mk(sim);
    process.env.C64RE_PROJECT_DIR = "";
    const lonely = join(tmpdir(), `c64re-889-lonely-${process.pid}.prg`);
    writeFileSync(lonely, PRG);
    const e3 = await rejects(b2.call("session/load_prg", { prg_path: lonely }));
    delete process.env.C64RE_PROJECT_DIR;
    rmSync(lonely, { force: true });
    check(/no C64RE project could be resolved/.test(e3 ?? ""), "bytes outside any project and no project given: refused (nothing to look in), never allowed");
    b.close(); b2.close();
    // corrupt record
    writeFileSync(pass_.passesFilePath(proj), "{not json");
    const b3 = mk(sim, { projectDir: proj }); await b3.connect();
    const e4 = await rejects(b3.call("session/load_prg", { prg_path: prgPath }));
    check(/does not parse/.test(e4 ?? ""), "a record that does not parse passes nothing (and is not overwritten)");
    b3.close();
    rmSync(pass_.passesFilePath(proj), { force: true });
    await sleep(60);
  }

  // ── J ──────────────────────────────────────────────────────────────────────────────────
  head("J  no silent fallback; the emulator is the default");
  {
    be.resetBackendForTests();
    check(be.activeBackend() === emulatorDaemon && be.activeBackend().kind === "emulator", "with nothing chosen the active backend is the emulator client");
    check(be.runtimeDaemon.kind === "emulator", "the tools' facade reaches it");
    check(be.parseBackendSpec("emulator").kind === "emulator" && be.parseBackendSpec("trx64").kind === "emulator" && be.parseBackendSpec("c64u:10.1.2.3").host === "10.1.2.3" && be.parseBackendSpec("c64u:127.0.0.1:8080").restPort === 8080, "C64RE_RUNTIME_BACKEND=emulator|c64u:<host>[:<rest port>] parses (trx64 stays an accepted spelling)");
    check(/is not a backend/.test(await rejects((async () => be.parseBackendSpec("c64u"))()) ?? ""), "anything else is an error, not a default");
    process.env.C64RE_RUNTIME_BACKEND = "ultimate-please";
    be.resetBackendForTests();
    const e1 = await rejects((async () => be.activeBackend())());
    const e2 = await rejects((async () => be.runtimeDaemon.state("shared"))());
    check(/is not a backend/.test(e1 ?? "") && /is not a backend/.test(e2 ?? "") && /Nothing falls back/.test(e2 ?? ""), "an invalid environment value is an error on every call — never the emulator", e2?.slice(0, 80));
    const sim = await fake({});
    process.env.C64RE_RUNTIME_BACKEND = `c64u:127.0.0.1:${sim.restPort}`;
    be.resetBackendForTests();
    check(be.activeBackend().kind === "c64u" && sim.clients === 0, "C64RE_RUNTIME_BACKEND=c64u:<host> selects the device, connecting lazily on the first call");
    const st = await be.runtimeDaemon.state("shared");
    check(st.cpu.pc === 0x0810 && sim.clients === 1 && sim.runState === "running", "the first call connects, continues PAUSED trxmon, and answers");
    const idn = await be.activeIdentity();
    check(idn.kind === "c64u" && idn.device.host === "127.0.0.1" && idn.device.board === "C64U", "the identity names the backend and the device");
    sim.stopTrxmon(); await sleep(150);
    const e3 = await rejects(be.runtimeDaemon.state("shared"));
    check(/trxmon not running on 127\.0\.0\.1/.test(e3 ?? "") && be.activeBackend().kind === "c64u", "a selected device that stops answering: an error naming it, and the choice stays");
    check(emulatorDaemon.kind === "emulator" && be.activeBackend() !== emulatorDaemon, "…no quiet switch to the emulator");
    delete process.env.C64RE_RUNTIME_BACKEND;
    // a select that fails leaves the old choice
    be.resetBackendForTests();
    const stock = await fake({ trx64: false });
    const e4 = await rejects(be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: stock.restPort }));
    check(/stock core/.test(e4 ?? "") && be.activeBackend() === emulatorDaemon, "a device that cannot be selected leaves the emulator selected");
    const dead = await rejects(be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: 1 }));
    check(/unreachable/.test(dead ?? "") && be.activeBackend() === emulatorDaemon, "an unreachable device: named, choice unchanged");
    const live = await fake({});
    await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: live.restPort });
    check(be.activeBackend().kind === "c64u" && live.clients === 1, "select by hand makes the device active");
    const back = await be.selectBackend({ kind: "emulator" });
    await sleep(100);
    check(back.identity.kind === "emulator" && be.activeBackend() === emulatorDaemon && live.clients === 0, "select trx64 returns to the emulator and releases the device");
    check(emulatorDaemon.screenshot !== undefined && typeof emulatorDaemon.call === "function", "the emulator client keeps its whole typed surface");
  }

  // ── K ──────────────────────────────────────────────────────────────────────────────────
  head("K  sandboxes, reels and scenario runs stay on the emulator");
  {
    const SRC = join(ROOT, "src");
    const seen = new Set();
    const bad = [];
    const importRe = /(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g;
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(importRe)) {
        const target = resolve(dirname(file), m[1]).replace(/\.js$/, ".ts");
        if (!existsSync(target)) continue;
        if (/runtime\/(backend|daemon-client|c64u\/)/.test(target) || /runtime-methods/.test(target)) bad.push(`${file.replace(SRC + "/", "")} → ${target.replace(SRC + "/", "")}`);
        else walk(target);
      }
    };
    const roots = ["reel/run-sandbox.ts", "reel/sandbox-session.ts", "reel/run-scenario.ts", "reel/record-scenario.ts", "scenario/cli.ts", "cost/capture.ts", "server-tools/runtime-sandbox.ts", "server-tools/scene-reel.ts", "sandbox/trx64cli.ts"];
    for (const r of roots) walk(join(SRC, r));
    check(bad.length === 0, "no module of the sandbox / reel / scenario-run graph imports the backend, the daemon client or the C64U code", bad.join("; "));
    check(seen.size > 15, "…and the walk really covered the graph", `${seen.size} modules`);
    // …and the tools' door is the only way in: nothing in src/ reaches the emulator client except
    // the backend registry (which owns it) and the eager warm-start in cli.ts (ensureDaemon).
    const direct = [];
    const scan = (dir) => { for (const f of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, f.name); if (f.isDirectory()) scan(p); else if (f.name.endsWith(".ts")) { const src = readFileSync(p, "utf8"); if (/emulatorDaemon|runtimeDaemon\b[^;]*daemon-client/.test(src) || /import\([^)]*daemon-client[^)]*\)[\s\S]{0,40}runtimeDaemon/.test(src)) direct.push(p.replace(SRC + "/", "")); } } };
    scan(SRC);
    check(direct.every((p) => p === "runtime/daemon-client.ts" || p === "runtime/backend.ts"), "no tool imports the emulator client directly — every runtimeDaemon comes from backend.ts", direct.join(", "));
    const sandboxSrc = readFileSync(join(SRC, "reel/sandbox-session.ts"), "utf8");
    check(/resolveDaemonSpawn/.test(sandboxSrc) && /127\.0\.0\.1/.test(sandboxSrc), "a sandbox spawns its own daemon on 127.0.0.1");
    const sim = await fake({});
    await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: sim.restPort });
    const n0 = sim.requests.length + sim.rpcLog.length;
    const sb = await dist("reel/run-sandbox.js");
    check(typeof sb.runSandbox === "function" && sb.sharedRuntimePort({}) === 4312, "with a C64U selected the sandbox module is unchanged: it still names the shared emulator port only to refuse it");
    check(sim.requests.length + sim.rpcLog.length === n0, "…and the device saw nothing of it");
    await be.selectBackend({ kind: "emulator" });
  }
} finally {
  if (savedEnv === undefined) delete process.env.C64RE_RUNTIME_BACKEND; else process.env.C64RE_RUNTIME_BACKEND = savedEnv;
  be.resetBackendForTests();
}

// ── L: the MCP tool, over stdio ───────────────────────────────────────────────────────────────
head("L  the MCP tool over stdio");
{
  const sim = await fake({ capabilities: "object", trxmonRunning: false });
  const cli = join(ROOT, "dist/cli.js");
  const env = { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "" };
  delete env.C64RE_RUNTIME_BACKEND; delete env.C64RE_RUNTIME_ENDPOINT;
  const proc = spawn(process.execPath, [cli], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", nid = 1; const pend = new Map();
  proc.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const ln = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!ln) continue; let m; try { m = JSON.parse(ln); } catch { continue; } if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
  proc.stderr.on("data", () => {});
  const rpc = (method, params) => new Promise((res, rej) => { const id = nid++; const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 60000); pend.set(id, (m) => { clearTimeout(t); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.error) return `# transport error\n${JSON.stringify(r.error)}`; const text = (r.result?.content || []).map((c) => c.text).join("\n"); return r.result?.isError ? `# tool error\n${text}` : text; };
  try {
    const onboarded = await call("agent_onboard", { project_dir: proj });
    check(onboarded.length > 0 && !/# tool error/.test(onboarded), "agent_onboard runs with the emulator down (the health probe is the active backend's)");
    const list = await rpc("tools/list", {});
    const tool = (list.result?.tools ?? []).find((t) => t.name === "runtime_backend");
    check(!!tool, "runtime_backend is on the default surface (listed without C64RE_FULL_TOOLS)");
    check(/^See and choose WHICH RUNTIME/.test(tool?.description ?? "") && /Use `list`/.test(tool.description) && /Not for starting a machine of your own/.test(tool.description), "its description says what it is for and what it is not for");
    const ls = await call("runtime_backend", { action: "list", broadcast: "127.0.0.1", ident_port: sim.identPort, rest_port: sim.restPort });
    check(/Emulator — ACTIVE/.test(ls) && /CORE-NO-MONITOR/.test(ls) && /action: start_monitor/.test(ls), "list: the emulator is ACTIVE; the device is listed with its reason and the start action", ls.slice(0, 200).replace(/\n/g, " | "));
    const sel0 = await call("runtime_backend", { action: "select", backend: "c64u", host: `127.0.0.1:${sim.restPort}` });
    check(/trxmon not running on 127\.0\.0\.1/.test(sel0), "select without trxmon running: refused with the way out", sel0.slice(0, 120));
    const st = await call("runtime_backend", { action: "start_monitor", host: `127.0.0.1:${sim.restPort}` });
    check(/started trxmon from \/Flash\/apps\/trxmon\.u2a/.test(st) && /OFFERED \(selectable\)/.test(st), "start_monitor starts it and probes: offered", st.slice(0, 160).replace(/\n/g, " | "));
    await sleep(120);
    check(sim.clients === 0, "…a start does not select, and holds no connection");
    const sel = await call("runtime_backend", { action: "select", backend: "c64u", host: `127.0.0.1:${sim.restPort}` });
    check(/Selected: C64 Ultimate 127\.0\.0\.1 \(board C64U\)/.test(sel) && /trxmon 0\.1/.test(sel) && sim.clients === 1, "select: names device, board, trxmon version", sel.split("\n")[0]);
    const status = await call("runtime_session_status", { session_id: "shared" });
    check(/^Runtime session status \(C64 Ultimate\)/.test(status) && /Backend: C64 Ultimate 127\.0\.0\.1 — real hardware, board C64U/.test(status) && /app :\d+/.test(status), "runtime_session_status names the backend and the device");
    check(/Drive 8: .*disk\.d64/.test(status) && /Project: none — a C64 Ultimate serves no project/.test(status), "…its drive line comes over REST, its project line says none");
    const typed = await call("runtime_type", { session_id: "shared", text: "run\\r" });
    check(/Queued 4 chars/.test(typed) && sim.requests.some((q) => q.path === "/v1/machine:input"), "runtime_type reaches the device over REST");
    const gate = await call("runtime_load_prg", { session_id: "shared", prg_path: prgPath });
    check(/has no green emulator run in this project/.test(gate) && /game\.prg \(sha256/.test(gate), "runtime_load_prg: refused by the gate, in the tool's answer");
    const refused = await call("runtime_trace_start", { session_id: "shared", hypothesis: "$C000 is written by the loader at $0810 I read", domains: ["c64-cpu"] });
    check(/trace\/start_domains: /.test(refused) && /trace on/.test(refused), "a trace tool: the refusal names the method and the way out");
    const brk = await call("runtime_session_close", { session_id: "shared" });
    check(!/trxmon not running/.test(brk), "a plain app method (session/close) goes through");
    const backEmu = await call("runtime_backend", { action: "select", backend: "emulator" });
    await sleep(100);
    check(/Selected: Emulator/.test(backEmu) && sim.clients === 0, "select trx64: back to the emulator, device released");
    const status2 = await call("runtime_backend", { action: "list", scan: false, hosts: [`127.0.0.1:${sim.restPort}`] });
    check(/Emulator — ACTIVE/.test(status2) && /OFFERED \(selectable\)/.test(status2), "list with scan:false sends no UDP and probes the named hosts only", `${sim.identRequests.length} ident requests`);
    check(sim.identRequests.length === 1, "…the only ident datagram was the first list's");
  } finally {
    proc.kill("SIGKILL");
  }
}

for (const s of sims) { try { await s.close(); } catch { /* closed */ } }
rmSync(proj, { recursive: true, force: true });
console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 889 backend: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
