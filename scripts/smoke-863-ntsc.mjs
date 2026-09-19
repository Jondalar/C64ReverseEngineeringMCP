#!/usr/bin/env node
// Spec 863 smoke — the C64RE half: the switch, the project's model, nothing assumes a PAL
// frame, and the VIC view on an NTSC frame. One item per acceptance line (§7):
//
//   §7.1  the switch the Live tab makes (`switchMachineModel` → `session/model`) moves a
//         RUNNING program to NTSC at the next frame; the confirmation says what it keeps;
//         cancelling sends nothing.
//   §7.2  `runtime_session_start { model: "c64-ntsc" }` starts an NTSC machine; a project's
//         `machine.model` makes the workspace launcher start the runtime as NTSC.
//   §7.3  a scenario recorded on PAL refuses to run on NTSC, naming both; `hold_frames: 60`
//         on NTSC holds 60 × 17 095 cycles.
//   §7.4  the VIC view's geometry, fed a real NTSC frame: 65 cycles × 263 lines, the window
//         wrapped where the recorder says.
//
// Every runtime here is a sandbox of this smoke's own, on a free port — never the shared
// one (doctrine rule 2). Each ends with the smoke.
//
//   TRX64_DAEMON_BIN=<trx64-daemon with C64 models> node scripts/smoke-863-ntsc.mjs
//   (needs `npm run build`)

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { resolveDaemonSpawn } = await import("../dist/runtime/resolve-daemon-spawn.js");
const DAEMON = process.env.TRX64_DAEMON_BIN || process.env.C64RE_TRX64_BIN
  || resolveDaemonSpawn({ repoRoot: ROOT, projectDir: tmpdir(), port: "1" }).cmd;
// Everything this smoke spawns through C64RE's own resolver (sandboxes, the workspace)
// uses the same binary.
process.env.C64RE_TRX64_BIN = DAEMON;
delete process.env.C64RE_RUNTIME_BIN;
delete process.env.C64RE_RUNTIME_BIN_ARGS;

const mm = await import("../dist/runtime/machine-model.js");
const fg = await import("../dist/runtime/frame-geometry.js");
const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");
const { projectMachineModel } = await import("../dist/project-knowledge/machine-model.js");
const { parseFeature } = await import("../dist/project-knowledge/scenario-gherkin.js");
const { runScenario } = await import("../dist/reel/run-scenario.js");

let pass = 0, fail = 0;
const check = (cond, msg, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const PAL = 19_656;
const NTSC = 17_095;

if (!existsSync(DAEMON)) {
  console.log(`FAIL  no runtime daemon at ${DAEMON} — set TRX64_DAEMON_BIN to a build with C64 models`);
  process.exit(1);
}
console.log(`Spec 863 — NTSC, the C64RE half  (runtime: ${DAEMON})\n`);

const cleanups = [];
const budget = setTimeout(() => { console.log("FAIL  smoke budget (420 s) exhausted"); for (const c of cleanups) try { c(); } catch {} process.exit(1); }, 420_000);

/** A JSON-RPC client over one WebSocket, collecting notifications. */
async function rpc(endpoint, deadlineMs = 20_000) {
  const until = Date.now() + deadlineMs;
  let ws;
  for (;;) {
    try {
      ws = await new Promise((res, rej) => { const w = new WebSocket(endpoint); w.once("open", () => res(w)); w.once("error", rej); });
      break;
    } catch (e) { if (Date.now() > until) throw e; await sleep(200); }
  }
  const pending = new Map();
  const notes = [];
  let id = 1;
  ws.on("message", (data, bin) => {
    if (bin) return;
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) notes.push(m);
  });
  const call = (method, params = {}) => new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }));
  });
  return { call, notes, close: () => ws.close() };
}

// The pure half — the confirmation text, the rows, the geometry functions, the parser —
// is `scripts/e2e-863-model.mjs` (hermetic, in CI). This one needs a runtime.

// ── a project remembers its model ─────────────────────────────────────────────────────
const proj = mkdtempSync(join(tmpdir(), "c64re-863-proj-"));
cleanups.push(() => rmSync(proj, { recursive: true, force: true }));
{
  console.log("the project's model:");
  const svc = new ProjectKnowledgeService(proj);
  svc.initProject({ name: "863 smoke" });
  check(projectMachineModel(proj) === "c64-pal", "project_init stamps c64-pal into a project it creates");
  svc.initProject({ name: "863 smoke", machineModel: "c64-ntsc" });
  check(projectMachineModel(proj) === "c64-ntsc", "  and machine_model changes it later");
  svc.initProject({ name: "863 smoke" });
  check(projectMachineModel(proj) === "c64-ntsc", "  a re-init without it keeps the project's value");
  const raw = JSON.parse(readFileSync(join(proj, "knowledge", "project.json"), "utf8"));
  check(raw.machine?.model === "c64-ntsc", "  stored as knowledge/project.json → machine.model");
  const plan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: proj, port: "4999" });
  const i = plan.args.indexOf("--model");
  check(i >= 0 && plan.args[i + 1] === "c64-ntsc" && plan.modelFrom === "project",
    "§7.2 the daemon spawn plan carries --model from the project", plan.args.join(" "));
  const plan2 = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: proj, port: "4999", model: "c64-paln" });
  check(plan2.args[plan2.args.indexOf("--model") + 1] === "c64-paln", "  a caller's model wins over the project's");
}

// ── the shared-machine stand-in: a runtime of our own, started PAL ───────────────────
const port = await freePort();
const endpoint = `ws://127.0.0.1:${port}`;
const daemon = spawn(DAEMON, ["--project", proj, "--port", String(port), "--headless", "--model", "c64-pal"], { stdio: ["ignore", "pipe", "pipe"] });
let daemonLog = "";
daemon.stderr.on("data", (d) => { daemonLog += d.toString(); });
cleanups.push(() => daemon.kill("SIGKILL"));

let mcp;
try {
  const R = await rpc(endpoint);
  const S = (await R.call("session/list"))[0]?.sessionId ?? "integrated-1";
  const state = () => R.call("session/state", { session_id: S });
  const peek = async (addr) => {
    const r = await R.call("session/read_memory", { session_id: S, ranges: [{ addr, len: 1, lens: "ram" }] });
    return Buffer.from(r.chunks[0].bytes, "base64")[0];
  };
  check((await state()).model === "c64-pal", "the runtime starts as the model it was asked for (c64-pal)");

  // ── the scenario list names the recorded model (the Export tab's seconds) ─────────
  console.log("\nthe scenario list names the model a scenario was recorded on:");
  await R.call("runtime/scenario_save", { scenario: { id: "rec-ntsc", diskPath: "", mode: "true-drive", cycleBudget: 60 * NTSC, inputs: [], model: "c64-ntsc" } });
  await R.call("runtime/scenario_save", { scenario: { id: "plain", diskPath: "", mode: "true-drive", cycleBudget: 50 * PAL, inputs: [] } });
  const summaries = await R.call("runtime/scenario_list", {});
  const recS = summaries.find((x) => x.id === "rec-ntsc");
  const plainS = summaries.find((x) => x.id === "plain");
  check(recS?.model === "c64-ntsc" && plainS && plainS.model === null,
    "runtime/scenario_list carries `model` (null when a scenario names none)", JSON.stringify({ rec: recS?.model, plain: plainS?.model }));
  const running = mm.machineIdentity(await state());
  const allRows = (await R.call("session/models", { session_id: S })).models;
  const d = mm.scenarioDuration(recS.cycleBudget, recS.model, allRows, running);
  check(d.text === "1.0s on c64-ntsc" && running.model === "c64-pal",
    "  the Export tab's seconds use the recorded machine's clock, not the running PAL one", d.text);
  await R.call("runtime/scenario_delete", { id: "rec-ntsc" });
  await R.call("runtime/scenario_delete", { id: "plain" });

  // ── §7.2 — through the MCP, as an agent does ──────────────────────────────────────
  console.log("\n§7.2 — runtime_session_start { model }:");
  mcp = spawn(process.execPath, [join(ROOT, "dist/cli.js")], {
    cwd: proj,
    env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_ENDPOINT: endpoint, C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanups.push(() => mcp.kill("SIGKILL"));
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
  const mrpc = (method, params) => new Promise((res, rej) => {
    const i = mid++;
    const tm = setTimeout(() => { mpending.delete(i); rej(new Error(`timeout ${method}`)); }, 240_000);
    mpending.set(i, (m) => { clearTimeout(tm); res(m); });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method, params })}\n`);
  });
  const tool = async (name, args) => {
    const r = await mrpc("tools/call", { name, arguments: args });
    return (r.result?.content ?? []).map((c) => c.text).join("\n") || JSON.stringify(r.error ?? r);
  };
  await mrpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-863", version: "0" } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tools = (await mrpc("tools/list", {})).result?.tools ?? [];
  const start = tools.find((t) => t.name === "runtime_session_start");
  check(!!start?.inputSchema?.properties?.model && !start.inputSchema.properties.pal,
    "runtime_session_start takes `model` (the `pal` flag is gone)");
  check(!!tools.find((t) => t.name === "runtime_sandbox_run")?.inputSchema?.properties?.model, "runtime_sandbox_run takes `model`");

  const started = await tool("runtime_session_start", { model: "c64-ntsc" });
  const st1 = await state();
  check(st1.model === "c64-ntsc" && st1.cyclesPerFrame === NTSC && st1.linesPerFrame === 263,
    "§7.2 runtime_session_start { model: \"c64-ntsc\" } starts an NTSC machine", `${st1.model} ${st1.cyclesPerLine}×${st1.linesPerFrame}`);
  check(/Machine: c64-ntsc/.test(started) && /was c64-pal; it SWITCHED to c64-ntsc at the frame boundary/.test(started),
    "  and says so: switched at the frame boundary, nothing restarted", started.split("\n").find((l) => /SWITCHED/.test(l)));
  const refused = await tool("runtime_session_start", { model: "c64c-pal" });
  check(/6526A/.test(refused) && (await state()).model === "c64-ntsc", "  a model the runtime cannot run is refused by name, nothing changes", refused.slice(0, 100));
  const status = await tool("runtime_session_status", { session_id: S });
  check(/Machine: c64-ntsc .*17095 cycles\/frame/.test(status), "runtime_session_status says which C64 it is", status.split("\n").find((l) => /Machine/.test(l)));
  const mon = await tool("runtime_monitor", { session_id: S, command: "model" });
  check(/c64-ntsc/.test(mon) && /c64c-pal/.test(mon), "the monitor's `model` verb is reachable through runtime_monitor");

  // ── §7.3 — hold_frames counts the machine's frames ────────────────────────────────
  console.log("\n§7.3 — hold_frames on NTSC:");
  await R.call("debug/pause", { session_id: S });
  await R.call("session/run", { session_id: S, cycles: 150 * NTSC });
  const c0 = (await state()).c64Cycles;
  const held = await tool("runtime_joystick", { session_id: S, fire: true, hold_frames: 60 });
  const c1 = (await state()).c64Cycles;
  const drift = c1 - c0 - 60 * NTSC;
  check(drift >= 0 && drift < 16, "§7.3 hold_frames: 60 on NTSC holds 60 × 17 095 cycles", `${c1 - c0} cycles, +${drift} of instruction granularity`);
  const m = held.match(/cycles (\d+) → (\d+) \((\d+)\)/);
  check(m && Number(m[3]) - 60 * NTSC >= 0 && Number(m[3]) - 60 * NTSC < 16 && /of 17095 cycles/.test(held),
    "  and the tool reports the window it held, in cycles", m?.[0]);

  // ── §7.1 — the switch the Live tab makes, on a running program ────────────────────
  console.log("\n§7.1 — the Live-tab switch:");
  // Back to PAL — a switch keeps the running program, so a PAL BOOT takes the power button
  // after it (the owner: a model changes only at a frame boundary, never by a power cycle).
  await tool("runtime_session_start", { model: "c64-pal" });
  await R.call("session/power", { session_id: S, op: "off" });
  await R.call("session/power", { session_id: S, op: "on" });
  await R.call("debug/pause", { session_id: S });
  await R.call("session/run", { session_id: S, cycles: 150 * PAL });
  await R.call("session/type", { session_id: S, text: "1 POKE1024,PEEK(162):GOTO1\rRUN\r" });
  // 30 keys at the pace the KERNAL takes them (its buffer drains once a jiffy): ~250 frames.
  await R.call("session/run", { session_id: S, cycles: 400 * PAL });
  const detected = await peek(0x02a6);
  const a0 = await peek(1024);
  await R.call("session/run", { session_id: S, cycles: 2 * PAL });
  check((await peek(1024)) !== a0 && detected === 1, "a BASIC program is running on PAL (the KERNAL detected PAL: $02A6 = 1)");

  // Cancel: the confirmation is built and nothing is sent.
  const rows = (await R.call("session/models", { session_id: S })).models;
  const ntscRow = mm.findModelRow(rows, "c64-ntsc");
  const asked = mm.switchConfirmation("c64-pal", ntscRow);
  check(!!asked.title && (await state()).model === "c64-pal", "§7.1 asking (and cancelling) changes nothing — the machine is still PAL");
  check(mm.modelChoices(rows).some((c) => c.disabled && /needs/.test(c.label)) && mm.modelChoices(rows).length === rows.length,
    "  the selector lists every row of session/models, the unrunnable ones disabled", `${rows.length} rows`);

  const hellosBefore = R.notes.filter((n) => n.method === "av/hello").length;
  const r = await mm.switchMachineModel((meth, p) => R.call(meth, p), S, "c64-ntsc");
  const kept = r.kept ?? {};
  check(r.from === "c64-pal" && r.model === "c64-ntsc" && r.switched === true, "§7.1 the switch goes through session/model", `${r.from} → ${r.model}`);
  check(kept.cpu && kept.ram && kept.cia && kept.sid, "  at the frame boundary, keeping CPU, RAM, CIAs and SID", JSON.stringify(kept));
  check(r.switchedAt?.rasterLine === 0, "  the VIC continues at line 0", JSON.stringify(r.switchedAt));
  const st2 = await state();
  check(st2.model === "c64-ntsc" && st2.cyclesPerFrame === NTSC, "  session/state.model is c64-ntsc afterwards");
  const a1 = await peek(1024);
  await R.call("session/run", { session_id: S, cycles: 3 * NTSC });
  check((await peek(1024)) !== a1, "  and the program is still running");
  check((await peek(0x02a6)) === 1, "  with the standard it detected at boot ($02A6 still 1 — a power-cycle would make it 0)");
  await sleep(200);
  const hello = R.notes.filter((n) => n.method === "av/hello").slice(hellosBefore).pop();
  check(hello?.params?.model === "c64-ntsc" && hello.params.canvas?.height === 247,
    "  every client is told (av/hello → the UI's model, canvas 384×247)", JSON.stringify(hello?.params?.canvas));

  // ── §7.4 — the VIC view on an NTSC frame ──────────────────────────────────────────
  console.log("\n§7.4 — the VIC view's geometry on an NTSC frame:");
  await R.call("checkpoint/capture", { session_id: S });
  await R.call("session/run", { session_id: S, cycles: 3 * NTSC + 4321 });
  const open = await R.call("vic/inspect/open", { session_id: S });
  const fm = await R.call("vic/frame_map", { session_id: S, checkpoint_id: open.checkpointId, include_cells: true });
  const h = fm.frame;
  check(h.cyclesPerLine === 65 && h.linesPerFrame === 263 && h.displayWindow?.wraps === true,
    "the recorder's header says 65 × 263 with a wrapped window", `${h.model} ${h.cyclesPerLine}×${h.linesPerFrame} window ${h.displayWindow?.firstLine}..${h.displayWindow?.lastLine}`);
  const g = fg.frameGeometry(h, fm.geometry.cycleX);
  check(g.cyclesPerLine === 65 && g.linesPerFrame === 263 && g.width === 384 && g.height === 247,
    "§7.4 the view draws 65 cycles × 263 lines on a 384×247 picture");
  check(fm.cells.length === 263 && fm.cells.every((row) => row.length === 65), "  the cell grid it draws from is 263 lines of 65 cycles");
  check(g.firstDrawn > 0 && g.blankLeft + g.blankRight + (g.lastDrawn - g.firstDrawn + 1) === 65,
    "  the blanking columns come from cycleX, not from 1–14 and 63", `drawn ${g.firstDrawn}..${g.lastDrawn}, blank ${g.blankLeft}+${g.blankRight}`);
  const cols = new Set(Array.from({ length: 65 }, (_, i) => fg.cycleColumn(g, fm.geometry.cycleX, i + 1, 4).x));
  check(cols.size === 65, "  every one of the 65 cycles has its own column");
  const rowsShown = Array.from({ length: g.height }, (_, r0) => g.lineOfRow(r0));
  check(rowsShown[0] === h.displayWindow.firstLine && rowsShown.at(-1) === h.displayWindow.lastLine - 263 && rowsShown.includes(0),
    "  the wrapped window is drawn where the recorder puts it: the last rows are raster lines 0..11", `rows 0..246 = lines ${rowsShown[0]}..262, 0..${rowsShown.at(-1)}`);
  const lt = await R.call("vic/line_trace", { session_id: S, checkpoint_id: open.checkpointId, from: 5, to: 5 });
  const l5 = lt.lines[0];
  const drew = l5.cycles.filter((c) => c.fbX - g.fbOrigin.x >= 0 && c.fbX - g.fbOrigin.x < g.width).map((c) => c.fbLine);
  check(l5.cycles.length === 65 && drew.length > 0 && drew.every((r0) => r0 === g.fbRowOfLine(5)),
    "  the line strip: line 5 is 65 cycles and its pixels land in the row the geometry says (268, the bottom)", `fbLine ${[...new Set(drew)].join(",")}`);
  await R.call("vic/inspect/close", { session_id: S, checkpoint_id: open.checkpointId }).catch(() => {});
  R.close();

  // ── §7.3 — a PAL recording does not replay on NTSC ────────────────────────────────
  console.log("\n§7.3 — a scenario recorded on PAL, asked to run on NTSC:");
  const recorded = parseFeature([
    "Scenario: boot",
    "  # model: c64-pal",
    "  Given a bare machine",
    "  When I wait 150 frames",
    '  And I capture "ready"',
    "  Then the reel has at least 1 screens",
  ].join("\n")).scenarios[0];
  let refusal = "";
  try { await runScenario(recorded, { model: "c64-ntsc", budgetMs: 120_000 }); } catch (e) { refusal = e.message; }
  check(/recorded on c64-pal/.test(refusal) && /this machine is c64-ntsc/.test(refusal),
    "§7.3 refused, naming both models", refusal.slice(0, 110));
  const onPal = await runScenario(recorded, { budgetMs: 120_000 });
  check(onPal.machine.model === "c64-pal" && onPal.width === 384 && onPal.height === 272,
    "  without a choice it runs on the model it was recorded on", `${onPal.machine.model} ${onPal.width}x${onPal.height}`);
  const written = { ...recorded, model: undefined };
  const onNtsc = await runScenario(written, { model: "c64-ntsc", budgetMs: 120_000 });
  check(onNtsc.machine.model === "c64-ntsc" && onNtsc.height === 247,
    "  a hand-written scenario (no model) runs on NTSC in NTSC frames, on the NTSC canvas", `${onNtsc.width}x${onNtsc.height}`);

  // runtime_sandbox_run: the project's model by default.
  const sb = await tool("runtime_sandbox_run", { project_dir: proj, steps: ["I wait 30 frames"], screen: false, budget_seconds: 120 });
  check(/machine: c64-ntsc .* — the project's model/.test(sb), "runtime_sandbox_run runs the project's model when none is named",
    sb.split("\n").find((l) => /^machine:/.test(l)));
  const sb2 = await tool("runtime_sandbox_run", { project_dir: proj, model: "c64-pal", steps: ["I wait 30 frames"], screen: false, budget_seconds: 120 });
  check(/machine: c64-pal/.test(sb2), "  and `model` picks another", sb2.split("\n").find((l) => /^machine:/.test(l)));
} catch (e) {
  fail++;
  console.log(`  FAIL  ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  if (daemonLog) console.log(daemonLog.split("\n").slice(-10).join("\n"));
} finally {
  mcp?.kill("SIGKILL");
  daemon.kill("SIGKILL");
}

// ── §7.2 — the workspace launcher starts the project's model ─────────────────────────
{
  console.log("\n§7.2 — the workspace starts as the project's model:");
  const wsPort = await freePort();
  const httpPort = await freePort();
  const ws = spawn(process.execPath, [join(ROOT, "scripts/workspace.mjs"), "--project", proj, "--port", String(httpPort)], {
    cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${wsPort}` },
  });
  let out = "";
  ws.stdout.on("data", (d) => { out += d.toString(); });
  ws.stderr.on("data", (d) => { out += d.toString(); });
  const killWs = () => { try { process.kill(-ws.pid, "SIGKILL"); } catch {} };
  cleanups.push(killWs);
  try {
    const W = await rpc(`ws://127.0.0.1:${wsPort}`, 40_000);
    const st = await W.call("session/state", {});
    check(st.model === "c64-ntsc", "§7.2 the project's machine.model makes the workspace start NTSC", st.model);
    check(/machine = c64-ntsc \(knowledge\/project\.json → machine\.model\)/.test(out), "  and the launcher says where the model came from",
      out.split("\n").find((l) => /machine =/.test(l)));
    W.close();
  } catch (e) {
    fail++;
    console.log(`  FAIL  workspace: ${e instanceof Error ? e.message : String(e)}\n${out.split("\n").slice(-8).join("\n")}`);
  } finally {
    killWs();
  }
}

clearTimeout(budget);
for (const c of cleanups) try { c(); } catch {}
console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-863: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
