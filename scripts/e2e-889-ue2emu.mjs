#!/usr/bin/env node
// Spec 889 — the C64U bridge against the UE2 emulator (a whole Ultimate in software).
//
// Spec 889 §11: the device is reached through the bridge (`c64re c64u-bridge`, started by the select as
// C64RE starts it), by this process, by an MCP stdio server and by a browser-like WebSocket client —
// together, on the one connection trxmon serves.
//
// NOT in gates.yml: it needs the emulator binary, the TRX firmware and trxmon.u2a, which
// live outside this repo. It SKIPS LOUDLY when any is missing — a check that quietly
// asserts nothing is worse than one that is absent.
//
// It starts `ue2emu` headless with its own flash image in a temp directory, `--net user`,
// and host forwards for REST (guest 80), the app (guest 4312) and the ident (guest UDP 64)
// on FREE ports of 127.0.0.1. trxmon.u2a sits on a `--usb-dir` volume, so it is
// `/Usb0/trxmon.u2a` on the device. Nothing here touches the LAN, port 4312 on this machine
// or a daemon this script did not start; the emulator is killed on the way out.
//
//   1  UDP ident (hostfwd) → trx64 {core TRX2, board C64U}; no rpc: our core, no trxmon
//   2  probe: core-no-monitor + start_monitor; REST start from the device path; probe: offered
//   3  select: ping trx64-runtime/2 / backend c64u, PAUSED on start → continue
//   4  RPC pass-through: session/state, read_memory, monitor/exec, break_add/del wrapping,
//      pause/step/continue, checkpoint/list, runtime/reverse_step; refusals by name
//   5  REST: text typed on the keyboard reaches BASIC (read back from screen RAM)
//   6  the gate: a PRG with no pass is refused, with a pass it runs on the device
//      (run_prg → $C000 written) — the exact bytes went over REST
//   7  trxmon/quit → "trxmon not running", REST still answers, no fallback
//   8  picture and sound (Spec 889 §4c): select starts the device's video and audio streams to this
//      host on free UDP ports (guest → host through the `--net user` NAT, the host as the guest
//      sees it is 10.0.2.2); frames arrive as the UI's binary frames, a screenshot of the BASIC
//      screen is the READY. colours (border light blue, background blue), audio arrives at the
//      device's 48,003 Hz. Section 8 is reported as it happens: if the NAT cannot deliver
//      guest → host UDP, the check says what the streams status and the counters showed.
//
//   UE2EMU_DIR=/path/to/u64-emulator node scripts/e2e-889-ue2emu.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMU = process.env.UE2EMU_DIR ?? "/Users/alex/Development/u64-emulator";
const bin = join(EMU, "target/release/ue2emu");
const elf = join(EMU, "run/trx/ultimate-f2a26eae.elf");
const u2a = join(EMU, "run/trx/trxmon-f2a26eae.u2a");
const roms = join(EMU, "firmware/1541ultimate/roms");
const missing = [bin, elf, u2a, join(roms, "chars.bin")].filter((p) => !existsSync(p));
if (missing.length) {
  console.log(`Spec 889 — against the UE2 emulator\n\n  SKIPPED — missing: ${missing.join(", ")}\n  (set UE2EMU_DIR to a u64-emulator checkout with a release build and run/trx/*)`);
  process.exit(0);
}
if (!existsSync(join(ROOT, "dist/runtime/backend.js"))) { console.error("dist is not built — npm run build:mcp"); process.exit(2); }

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const head = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const rejects = async (p) => { try { await p; return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);
const { startMcp } = await import(pathToFileURL(join(ROOT, "scripts/lib/mcp-stdio.mjs")).href);
const { reapBridges } = await import(pathToFileURL(join(ROOT, "scripts/lib/bridge-harness.mjs")).href);

const work = mkdtempSync(join(tmpdir(), "c64re-889-ue2-"));
// the machine-wide state (selection, bridge registry) lives in this run's directory
process.env.C64RE_STATE_DIR = join(work, "state");
delete process.env.C64RE_RUNTIME_BACKEND;
const usb = join(work, "usb");
mkdirSync(usb);
copyFileSync(u2a, join(usb, "trxmon.u2a"));
writeFileSync(join(work, "smoke.cfg"), "[User Interface Settings]\nNavigation Style=Quick Search\n[U64 Specific Settings]\nSystem Mode=PAL\n");
const restPort = await freePort(), rpcPort = await freePort(), udpPort = await freePort();
// §4c: the device sends to this host through slirp: 10.0.2.2 is the host as the guest sees it, and
// the datagrams come out of the NAT from an address that is not the forward's, so no source filter.
const videoUdp = await freePort(), audioUdp = await freePort();
process.env.C64RE_C64U_RECEIVER_HOST = process.env.C64RE_C64U_RECEIVER_HOST ?? "10.0.2.2";
process.env.C64RE_C64U_STREAM_SOURCE = process.env.C64RE_C64U_STREAM_SOURCE ?? "any";
process.env.C64RE_C64U_VIDEO_PORT = String(videoUdp);
process.env.C64RE_C64U_AUDIO_PORT = String(audioUdp);

console.log("Spec 889 — the C64U backend against the UE2 emulator\n");
console.log(`  emulator: ${bin}\n  forwards: REST 127.0.0.1:${restPort}→80, app :${rpcPort}→4312, ident udp :${udpPort}→64\n  work dir: ${work}`);
const log = [];
const emu = spawn(bin, [
  "run", "--headless", "--board", "c64u", "--trx-io", "--firmware", elf, "--roms", roms,
  "--flash", join(work, "flash.bin"), "--c64-roms", "--settings", join(work, "smoke.cfg"),
  "--usb-dir", usb, "--usb-dir-work", join(work, "usbwork"),
  "--net", "user", "--web-port", "0",
  "--hostfwd", `tcp:127.0.0.1:${restPort}:80,tcp:127.0.0.1:${rpcPort}:4312,udp:127.0.0.1:${udpPort}:64`,
  "--monitor-dir", work, "--max-seconds", "600",
], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
emu.stdout.on("data", (d) => log.push(d.toString()));
emu.stderr.on("data", (d) => log.push(d.toString()));
const stopEmu = async () => { try { emu.kill("SIGTERM"); } catch { /* gone */ } await sleep(500); try { emu.kill("SIGKILL"); } catch { /* gone */ } };

const be = await dist("runtime/backend.js");
const disc = await dist("runtime/c64u/discovery.js");
const pass_ = await dist("runtime/emulator-pass.js");
const state = await dist("runtime/c64u-bridge/state.js");
const { ProjectKnowledgeService } = await dist("project-knowledge/service.js");
const proj = join(work, "proj");
mkdirSync(proj);
new ProjectKnowledgeService(proj).initProject({ name: "ue2" });

try {
  head("1  the device boots and answers (UDP ident, REST)");
  let info;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${restPort}/v1/info`, { signal: AbortSignal.timeout(3000) }); if (r.ok) { info = await r.json(); break; } } catch { /* still booting */ }
    if (emu.exitCode !== null) break;
    await sleep(1000);
  }
  check(!!info, "GET /v1/info answers through the forward", info ? `${info.product} ${info.firmware_version}` : log.join("").slice(-300));
  if (!info) throw new Error("the emulated device never answered");
  check(info.trx64?.core === "TRX2" && info.trx64.board === "C64U" && info.trx64.rpc === undefined, "/v1/info: trx64 {core TRX2, board C64U}, no rpc", JSON.stringify(info.trx64));
  const found = await disc.discoverUltimates({ targets: [{ address: "127.0.0.1", port: udpPort }], timeoutMs: 4000 });
  check(found.length === 1 && found[0].ident.trx64?.core === "TRX2", "the UDP ident answers with the same trx64 field", found[0] ? found[0].ident.hostname : "no answer");

  head("2  probe, start trxmon over REST");
  const p1 = await be.probeHost({ host: "127.0.0.1", restPort });
  check(p1.outcome === "core-no-monitor" && p1.action === "start_monitor" && !p1.selectable, "probe: our core, trxmon not running — Start monitor offered", p1.reason);
  const e1 = await rejects(be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort }, { rpcPort }));
  check(/trxmon not running on 127\.0\.0\.1 — start it/.test(e1 ?? ""), "select without trxmon: refused with the way out");
  const st = await be.startMonitorOn({ host: "127.0.0.1", restPort, trxmonPath: "/Usb0/trxmon.u2a" });
  check(st.started === true && /\/Usb0\/trxmon\.u2a/.test(st.note), "PUT /v1/apps:run_file?app=/Usb0/trxmon.u2a&action=serve", st.note);
  const p2 = await be.probeHost({ host: "127.0.0.1", restPort, rpcPort });
  check(p2.outcome === "offered" && p2.selectable && p2.ping?.backend === "c64u", "probe: offered — ping answered trx64-runtime/2, backend c64u", p2.reason);
  const st2 = await be.startMonitorOn({ host: "127.0.0.1", restPort, trxmonPath: "/Usb0/trxmon.u2a" });
  check(st2.started === false && /already running/.test(st2.note), "a second start is 423 = already running", st2.note);

  head("3  select, PAUSED on start");
  const sel = await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort }, { rpcPort, projectDir: proj });
  check(sel.identity.device.runtimeVersion === "trx64-runtime/2" && /^trxmon /.test(sel.identity.device.trxmonVersion ?? "") && sel.identity.device.board === "C64U", "identity: board C64U, trx64-runtime/2, trxmon version", `${sel.identity.device.trxmonVersion}; ${sel.identity.device.capabilities}`);
  const d = be.runtimeDaemon;
  const d_ = d;
  const s0 = await d.state("shared");
  check(s0.runState === "running" && sel.notes.some((n) => /debug\/continue/.test(n)), "trxmon started paused; select continued it", sel.notes.join(" | "));
  check(s0.cpu && typeof s0.cpu.pc === "number" && s0.backend === "c64u" && s0.model === "c64-pal", "session/state in the daemon's shape (cpu, backend c64u, model)");

  head("3b picture and sound (§4c), to a browser-like client of the bridge");
  {
    const bridgeEp = state.readBridgeEntry("127.0.0.1", restPort).endpoint;
    // the page's kind of client: an A/V subscriber of the bridge's WS
    const msgs = { video: [], audio: [], notes: [] };
    const t0 = Date.now();
    const page = new WebSocket(bridgeEp);
    page.binaryType = "arraybuffer";
    let pid = 1; const pendingP = new Map();
    page.on("message", (d, isBin) => {
      if (isBin) { const u = new Uint8Array(d); if (u[0] === 0x01) msgs.video.push({ at: Date.now(), n: u.length, data: u }); else if (u[0] === 0x02) msgs.audio.push({ at: Date.now(), n: u.length }); return; }
      const m = JSON.parse(d.toString());
      if (m.id != null && pendingP.has(m.id)) { pendingP.get(m.id)(m); pendingP.delete(m.id); }
      else if (m.method === "stream/paused") msgs.notes.push({ at: Date.now() - t0, ...m.params });
    });
    await new Promise((res, rej) => { page.once("open", res); page.once("error", rej); });
    const pcall = (method, params = {}) => new Promise((res, rej) => { const id = pid++; pendingP.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); page.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
    const as = await pcall("audio/start", { session_id: "shared" });
    check(as.sampleRate === 48003.07 && as.channels === 2, "audio/start (the browser's call) answers with the device's rate 48,003.07 Hz", JSON.stringify(as));
    check(sel.notes.some((n) => /picture and sound: listening on UDP \d+ \(video\) \/ \d+ \(audio\)/.test(n)), "select opened the UDP receivers", sel.notes.find((n) => /picture and sound/.test(n)) ?? "");
    const bstat = async () => (await pcall("bridge/status"));
    const settle = Date.now() + 30_000;
    while (Date.now() < settle) { const sx = (await bstat()).streams?.status?.streams; if (sx?.video.phase === "running" && sx?.audio.phase === "running") break; await sleep(300); }
    const ss = await bstat();
    const sv = ss.streams?.status?.streams;
    console.log(`  streams after the start: video ${sv?.video.phase}${sv?.video.failure ? ` (${sv.video.failure.message})` : ""}, audio ${sv?.audio.phase}${sv?.audio.failure ? ` (${sv.audio.failure.message})` : ""}; told ${sv?.video.target} / ${sv?.audio.target}`);
    check(sv?.video.phase === "running" && sv?.audio.phase === "running", "the device accepted both stream starts (PUT streams/video:start, audio:start)", JSON.stringify(sv));
    const waited = await (async () => { const end = Date.now() + 25_000; while (Date.now() < end && (msgs.video.length < 5 || msgs.audio.length < 20)) await sleep(250); return Date.now() - t0; })();
    const st0 = (await bstat()).streams.status;
    console.log(`  after ${waited} ms: ${msgs.video.length} video frames, ${msgs.audio.length} audio buffers; foreign datagrams ${st0.foreignDatagrams}; video ${JSON.stringify(st0.video)}; audio ${JSON.stringify(st0.audio)}`);
    check(msgs.video.length >= 5, "video frames arrive through the NAT (guest → host UDP), at the browser", `${msgs.video.length} frames; receivedAnyVideo=${st0.receivedAnyVideo}`);
    if (msgs.video.length >= 5) {
      const v = msgs.video.at(-1).data;
      const w = v[5 + 0] | (v[5 + 1] << 8), h = v[5 + 2] | (v[5 + 3] << 8);
      check(v[0] === 0x01 && w === 384 && (h === 272 || h === 240) && v.length === 5 + 58 + w * h, "…as the UI's frames: 0x01, 384 x 272 (PAL), palette-indexed", `${w}x${h}`);
      const fi = await d_.call("session/frame_indices", { session_id: "shared" });
      const idx = Buffer.from(fi.indices, "base64");
      const hist = new Array(16).fill(0); for (const c of idx) hist[c & 15]++;
      const order = hist.map((n, i) => [i, n]).sort((a, c) => c[1] - a[1]);
      const frac = (hist[6] + hist[14]) / idx.length;
      console.log(`  colour histogram (index:share): ${order.filter(([, n]) => n).slice(0, 5).map(([i, n]) => `${i}:${(100 * n / idx.length).toFixed(1)}%`).join(" ")}`);
      check(order[0][0] === 6 && order[1][0] === 14 && frac > 0.95, "the screenshot is the BASIC screen: blue (6) background and light blue (14) border/text make up the picture", `blue+lightblue ${(100 * frac).toFixed(1)}%`);
      const shot = await d_.call("session/screenshot", { session_id: "shared" });
      check(shot.dataUrl.startsWith("data:image/png;base64,") && shot.width === 384 && shot.frame >= 0 && shot.ageMs < 5000, "session/screenshot answers with a PNG, the frame number and its age", `age ${shot.ageMs} ms, frame ${shot.frame}, complete ${shot.complete}`);
    }
    check(msgs.audio.length >= 20, "audio buffers arrive through the NAT, at the browser", `${msgs.audio.length} buffers`);
    if (msgs.audio.length >= 20) {
      // a steady window, not the burst that was buffered while the streams were starting
      const w0 = Date.now(), n0 = msgs.audio.length;
      await sleep(5000);
      const w1 = Date.now();
      const inWin = msgs.audio.slice(n0).filter((m) => m.at >= w0 && m.at <= w1);
      const frames = inWin.reduce((n, m) => n + (m.n - 5) / 4, 0);
      const hz = frames / ((w1 - w0) / 1000);
      const st1 = (await bstat()).streams.status;
      console.log(`  audio: ${inWin.length} buffers in ${w1 - w0} ms → ${hz.toFixed(0)} Hz (device nominal 48003.07); lost ${st1.audio.packets_lost}, concealed ${st1.audio.packets_concealed}`);
      check(hz > 48003.07 * 0.97 && hz < 48003.07 * 1.03, "audio packets arrive at about 48,003 Hz (±3 % over a 5 s window)", `${hz.toFixed(0)} Hz`);
    }
    console.log(`  paused notifications seen: ${JSON.stringify(msgs.notes)}`);

    head("3c the assistant and the browser on ONE bridge, one connection at the device");
    const mcpState = process.env.C64RE_STATE_DIR;
    const mcp = startMcp({ root: ROOT, env: { C64RE_STATE_DIR: mcpState, C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_C64U_VIDEO_PORT: String(videoUdp + 0), C64RE_C64U_AUDIO_PORT: String(audioUdp + 0) } });
    try {
      await mcp.call("agent_onboard", { project_dir: proj });
      const stM = await mcp.call("runtime_session_status", { session_id: "shared" });
      check(/Runtime session status \(C64 Ultimate\)/.test(stM) && stM.includes(`through the C64U bridge at ${bridgeEp}`) && /Run state: running/.test(stM), "an MCP server follows the shared selection onto the same bridge", stM.split("\n").slice(0, 2).join(" | "));
      const shared = (await bstat()).bridge;
      check(shared.clients >= 2 && shared.state === "ready", "the assistant (RPC-only) and the browser (A/V subscriber) are both clients of the one bridge", JSON.stringify({ clients: shared.clients, av: shared.avClients, pid: shared.pid }));
      const nBefore = msgs.notes.length;
      const mon = await mcp.call("runtime_monitor", { session_id: "shared", command: "r" });
      check(/AC XR YR SP/.test(mon), "the assistant's monitor verb (r) answers from the device", mon.slice(0, 100));
      const reg = await pcall("session/read_memory", { session_id: "shared", addr: 0x0400, length: 4, lens: "ram" });
      check(reg.bytes.length === 4, "…while the browser reads memory on the same connection");
      void nBefore;
    } finally { mcp.stop(); }
    page.close();
  }

  head("4  the app's RPC through the backend");
  const mem = await d.readMemoryRange("shared", 0x0000, 4);
  check(mem.bytes?.length === 4 && mem.bytes[0] === 0x2f && mem.bytes[1] === 0x37, "session/read_memory: the processor port $2F/$37", JSON.stringify(mem.bytes));
  const mon = await d.monitorExec("shared", "r");
  check(typeof mon.output === "string" && /ADDR AC XR YR SP/.test(mon.output), "monitor/exec r → the monitor's register text");
  const e2 = await rejects(d.call("debug/break_add", {}));
  check(/needs `pc`/.test(e2 ?? ""), "break_add without pc: refused by the backend, nothing sent");
  const add = await d.call("debug/break_add", { pc: 0xc000 });
  check(add.breakpoints?.some((b) => b.addr === 0xc000), "break_add pc=$C000 on the device");
  check(/needs `id`/.test((await rejects(d.call("debug/break_del", {}))) ?? ""), "break_del without id: refused");
  const del = await d.call("debug/break_del", { all: true });
  check(del.breakpoints?.length === 0, "break_del all:true deletes them on request");
  const pz = await d.pause("shared");
  check(pz.runState === "paused" && pz.stop?.reason === "pause", "debug/pause");
  const sp = await d.call("debug/step", {});
  check(sp.stop?.reason === "step" && sp.pc !== pz.pc, "debug/step moves the PC", `${pz.pc} → ${sp.pc}`);
  const rs = await d.call("runtime/reverse_step", {});
  check(typeof rs.pc === "number" && rs.stepsTaken === 1, "runtime/reverse_step (the ring)", `pc ${rs.pc}`);
  const cps = await d.checkpointList("shared");
  check(Array.isArray(cps.checkpoints) && cps.checkpoints.length > 0, "checkpoint/list: the device's ring has anchors", `${cps.checkpoints.length}`);
  const res = await d.resume("shared");
  check(res.runState === "running", "debug/continue");
  const regs = await d.apiCall("shared", "monitorRegisters", []);
  check(typeof regs.pc === "number", "api/call monitorRegisters → session/state cpu");
  for (const m of ["trace/start_domains", "snapshot/dump", "runtime/overlay_run", "sandbox/run"]) {
    const e = await rejects(d.call(m, {}));
    check(e?.startsWith(`${m}: `) && / — /.test(e), `${m}: refused by name, with the way out`);
  }
  const s1 = await be.activeIdentity();
  check(s1.kind === "c64u" && /127\.0\.0\.1/.test(s1.label), "the identity names the device");

  head("5  REST: typing reaches BASIC");
  await d.pause("shared");
  const ty = await d.typeText("shared", "print 6*7\r");
  check(ty.queued === 10 && ty.afterRest?.debugState?.runState === "paused", "session/type: 10 taps, and debug/state re-read after it (§7)", `${ty.queued}`);
  await d.resume("shared");
  await sleep(4000);
  const scr = await d.readMemoryRange("shared", 0x0400, 1000);
  const text = Buffer.from(scr.bytes ?? []).toString("latin1");
  const rows = []; for (let r = 0; r < 25; r++) rows.push(Array.from((scr.bytes ?? []).slice(r * 40, r * 40 + 40), (c) => String.fromCharCode(c < 32 ? c + 64 : c)).join("").trimEnd());
  check(rows.some((r) => /PRINT 6\*7/.test(r)) && rows.some((r) => /^\s*42\s*$/.test(r)), "screen RAM shows PRINT 6*7 and its answer 42", rows.filter((r) => r.trim()).join(" / ").slice(0, 120));
  void text;

  head("6  the gate, on a real (emulated) device");
  const stub = [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];
  const PRG = Buffer.from([...stub, 0x78, 0xa9, 0x5a, 0x8d, 0x00, 0xc0, 0x4c, 0x13, 0x08]); // SEI · $C000 := $5A · JMP *
  const prgPath = join(proj, "input", "mark.prg");
  mkdirSync(join(proj, "input"), { recursive: true });
  writeFileSync(prgPath, PRG);
  const eg = await rejects(d.runPrg("shared", prgPath));
  check(/mark\.prg \(sha256 [0-9a-f]{8}…\) has no green emulator run in this project/.test(eg ?? ""), "run_prg of a PRG with no pass: refused, names file + hash", eg?.slice(0, 80));
  const before = await d.readMemoryRange("shared", 0xc000, 1);
  check(before.bytes[0] !== 0x5a, "…and $C000 is untouched on the device", `$${before.bytes[0].toString(16)}`);
  pass_.recordEmulatorPass(proj, { media: [{ name: "mark.prg", bytes: new Uint8Array(PRG) }], steps: ["I wait 20 frames"], checks: [{ text: "Then $C000 is $5A", afterSteps: 1, actual: "$5a", pass: true }] });
  const run = await d.runPrg("shared", prgPath);
  check(run.loadAddress === 0x0801 && /RUN/.test(run.action), "with a recorded pass the PRG runs: POST runners:run_prg", run.action);
  await sleep(3000);
  const after = await d.readMemoryRange("shared", 0xc000, 1);
  check(after.bytes[0] === 0x5a, "$C000 = $5A on the device: the exact bytes ran", `$${after.bytes[0].toString(16)}`);

  head("7  trxmon gone");
  await d.call("trxmon/quit", {});
  await sleep(1500);
  const eq = await rejects(d.state("shared"));
  check(/^trxmon not running on 127\.0\.0\.1 — start it/.test(eq ?? ""), "after trxmon/quit: \"trxmon not running on <host> — start it or select the emulator\"", eq);
  const dr = await d.driveStatus("shared");
  check(dr.drive === "a", "REST still answers (drive status)");
  check(be.activeBackend().kind === "c64u", "…and nothing fell back to the emulator");
  const re = await be.startMonitorOn({ host: "127.0.0.1", restPort, trxmonPath: "/Usb0/trxmon.u2a" });
  await sleep(1500);
  const again = await rejects(d.state("shared"));
  check(re.started === true && again === undefined, "start again: the next call reconnects", again ?? "");
} catch (e) {
  check(false, "harness", e instanceof Error ? e.stack : String(e));
} finally {
  try { await be.selectBackend({ kind: "emulator" }); } catch { /* released */ }
  await reapBridges(join(work, "state"));
  await stopEmu();
  if (fail) console.log(`\n  emulator console tail:\n${log.join("").split("\n").slice(-15).map((l) => "    " + l).join("\n")}\n  kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "GREEN" : "RED"}  Spec 889 UE2: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
