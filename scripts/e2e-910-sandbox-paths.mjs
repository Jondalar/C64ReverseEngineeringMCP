#!/usr/bin/env node
// Spec 910 — a sandbox is a daemon of its own: the three ways to run one agree (S2), nothing it does reaches a project
// file (S5, the C64RE side), the shared machine still writes back on purpose (S6), and every way a sandbox ends takes the
// same steps (S7).
//
//   S2  a cartridge run through runtime_sandbox_run, the reel runner and a session driven by runtime_* calls: the same
//       registers, the same RAM hash, the same cycle
//   S5  a D64 the program SAVEs to and an EasyFlash cartridge it flash-writes, handed over by every door C64RE has (the
//       start, runtime_media_mount, runtime_media_swap, the monitor's mount, runtime_swap_disk_and_continue) and ended by
//       every reason: the source files are byte-identical, and the sandbox saw its own writes
//   S6  a shared-style daemon (own port, no --scratch) + runtime_media_persist writes the original
//   S7  reached, failed, budget, idle, owner gone and the runtime exiting: the trace is finalized and queryable, the
//       outcome is in the step log, the scratch is gone, the port is free
//
// Daemons of this run's own on free ports, a state directory of the run, synthetic media built here, no game data. It
// SKIPS LOUDLY when there is no trx64-daemon binary. Nothing here touches :4312.
//   Locally:  C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:910
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Harness, ROOT, findDaemon, listening, load, loopPrg, makeChecker, pidAlive, scratchDirs, sleep } from "./lib/e2e-906-harness.mjs";
import { COLD_START, blankD64, coldStartCrt, d64Files, efCrt, saveProgram } from "./lib/fixtures-910.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-910");
const { check, head } = T;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const fileSha = (p) => sha(readFileSync(p));

const DAEMON = await findDaemon();
if (!DAEMON) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED — no trx64-daemon binary (set C64RE_RUNTIME_BIN). Skipped, NOT passed.");
  process.exit(0);
}
process.env.C64RE_RUNTIME_BIN = DAEMON;
console.log(`runtime: ${DAEMON}`);

const H = new Harness("c64re-910-");
process.env.C64RE_STATE_DIR = H.state;
const idOf = (s) => /\bsb-[a-z0-9-]+\b/.exec(s)?.[0];
const portOf = (s) => Number(/on port (\d+)/.exec(s)?.[1]);
const waitFor = async (fn, ms, step = 200) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } };
const recordOf = (id) => JSON.parse(readFileSync(join(H.state, "sandbox-sessions", `${id}.json`), "utf8"));
const stepLog = (projectDir) => { try { return JSON.parse(readFileSync(join(projectDir, "knowledge", "agent-state.json"), "utf8")).history.map((h) => h.step).join("\n"); } catch { return ""; } };
const ledger = () => { try { return readdirSync(join(H.state, "processes")).map((f) => JSON.parse(readFileSync(join(H.state, "processes", f), "utf8"))).filter((r) => r.kind === "sandbox"); } catch { return []; } };
const isErr = (t) => /^# [Tt]ool [Ee]rror/.test(t);

const proj = await H.project("proj");
const media = join(proj, "media");
mkdirSync(media, { recursive: true });
const files = {
  crt: join(media, "cold.crt"),
  d64: join(media, "work.d64"), d64b: join(media, "decoy.d64"),
  ef: join(media, "work.crt"), efb: join(media, "decoy.crt"),
  save: join(media, "save.prg"),
};
writeFileSync(files.crt, coldStartCrt());
writeFileSync(files.d64, blankD64("WORK"));
writeFileSync(files.d64b, blankD64("DECOY"));
writeFileSync(files.ef, efCrt());
writeFileSync(files.efb, efCrt({ writes: false }));
writeFileSync(files.save, saveProgram(8));

const shared = await H.daemon(DAEMON, await H.project("shared-proj"));
const mcp = await H.mcp(proj, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });

const peek = async (port, addr, lens = "cpu") => {
  const c = await H.ws(port);
  try {
    const r = await c.call("session/read_memory", { session_id: "integrated-1", ranges: [{ addr, len: 1, lens }] });
    return Buffer.from(r.chunks[0].bytes, "base64")[0];
  } finally { c.close(); }
};
const machineOf = async (port) => {
  const c = await H.ws(port);
  try {
    const st = await c.call("session/state", { session_id: "integrated-1" });
    const half = async (addr) => { const r = await c.call("session/read_memory", { session_id: "integrated-1", ranges: [{ addr, len: 0x8000, lens: "ram" }] }); return Buffer.concat(r.chunks.map((k) => Buffer.from(k.bytes, "base64"))); };
    const ram = Buffer.concat([await half(0), await half(0x8000)]);
    return { cycle: st.c64Cycles, pc: st.cpu.pc, cpu: { a: st.cpu.a, x: st.cpu.x, y: st.cpu.y, sp: st.cpu.sp, flags: st.cpu.flags }, ram: sha(ram), runState: st.runState };
  } finally { c.close(); }
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S2  one-shot, reel and session end in the same machine state");
{
  const N = 60;
  const { runSandbox } = await load("reel/run-sandbox.js");
  const { runScenario } = await load("reel/run-scenario.js");
  const { parseFeature, parseStep } = await load("project-knowledge/scenario-gherkin.js");

  // A: runtime_sandbox_run's runner. The memory it reads is all of RAM, hashed here.
  const a = await runSandbox({
    mediaPath: files.crt, steps: [parseStep(`I wait ${N} frames`).step], budgetMs: 120_000, projectDir: proj,
    reads: [{ label: "lo", addr: 0, len: 0x8000, lens: "ram" }, { label: "hi", addr: 0x8000, len: 0x8000, lens: "ram" }],
  });
  const stateA = { cycle: a.endCycle, pc: a.pc, cpu: a.cpu, ram: sha(Buffer.concat([a.reads[0].bytes, a.reads[1].bytes])) };

  // B: the reel runner — the cartridge goes in at the reset vector; the first capture is the frame boundary the other two boot to.
  const feature = parseFeature(`Feature: f\n  Scenario: s\n    Given the disk "${files.crt}"\n    When I capture "a"\n    And I wait ${N} frames\n    And I capture "b"\n    Then the reel has at least 2 screens\n`);
  if (feature.issues.length) throw new Error(feature.issues.map((i) => i.message).join("; "));
  const sc = feature.scenarios[0];
  sc.steps.pop(); // the closing capture moves the machine to a frame boundary; the others stop on the cycle
  sc.steps.push(...[]);
  const b = await runScenario(sc, { projectDir: proj, budgetMs: 120_000 });
  const stateB = { cycle: b.endState.cycle, pc: b.endState.pc, cpu: b.endState.cpu, ram: b.endState.ramSha256 };

  // C: a session, driven by runtime_* calls
  const t = await mcp.call("runtime_sandbox_start", { purpose: "S2 session path", budget_minutes: 5, media_path: files.crt });
  const id = idOf(t);
  const before = (await machineOf(portOf(t)));
  const F = 19656;
  await mcp.call("runtime_session_run", { session_id: id, max_instructions: 1, cycle_budget: N * F });
  const stateC = await machineOf(portOf(t));
  await mcp.call("runtime_sandbox_end", { session_id: id, outcome: "reached", summary: "S2 done" });
  delete stateC.runState;

  const show = (s) => JSON.stringify(s);
  check(stateA.cycle > 0 && stateB.cycle > 0 && stateC.cycle > 0 && before.cycle === 0, "all three machines ran from the same start (the cartridge parked at the reset vector, cycle 0)", `${stateA.cycle} ${stateB.cycle} ${stateC.cycle} ${before.cycle}`);
  check(show(stateA) === show(stateC), "runtime_sandbox_run and the session driven by runtime_* calls end in the same registers, RAM hash and cycle", `${show(stateA)} vs ${show(stateC)}`);
  check(show(stateA) === show(stateB), "…and the reel runner too", `${show(stateA)} vs ${show(stateB)}`);
  check(stateA.pc >= COLD_START && stateA.pc < COLD_START + 0x10, "…and it is the cartridge's cold-start loop that ran", `PC ${stateA.pc.toString(16)}`);

  // the tools, end to end (the answers name the same cycle)
  const tool = await mcp.call("runtime_sandbox_run", { media_path: files.crt, steps: [`I wait ${N} frames`], project_dir: proj });
  check(!isErr(tool) && tool.includes(String(stateA.cycle)), "runtime_sandbox_run (the tool) reports the same end cycle", tool.slice(0, 300));
  // fresh starts: the same arguments, a new daemon each time, the same machine
  const again = await runSandbox({ mediaPath: files.crt, steps: [parseStep(`I wait ${N} frames`).step], budgetMs: 120_000, projectDir: proj });
  check(again.endCycle === stateA.cycle && again.pc === stateA.pc, "…and a fresh daemon with the same arguments ends on the same cycle and PC", `${again.endCycle} vs ${stateA.cycle}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S5  no write-back, whatever the door and however it ends (C64RE side)");
async function untilMarked(m, id, port, ok, max = 60) {
  for (let i = 0; i < max; i++) {
    if (await ok()) return true;
    await m.call("runtime_session_run", { session_id: id, max_instructions: 1, cycle_budget: 1_000_000 });
  }
  return ok();
}
async function handOver(m, id, way, kind, src, decoy) {
  const out = [];
  if (way === "start") return out;
  if (way === "media_mount") out.push(await m.call("runtime_media_mount", { session_id: id, path: src }));
  if (way === "media_swap") {
    out.push(await m.call("runtime_media_mount", { session_id: id, path: decoy }));
    await m.call("runtime_session_run", { session_id: id, max_instructions: 1, cycle_budget: 1_000_000 });
    out.push(await m.call("runtime_media_swap", { session_id: id, path: src }));
  }
  if (way === "monitor_mount") out.push(await m.call("runtime_monitor", { session_id: id, command: `mount ${src}` }));
  if (way === "swap_disk_and_continue") out.push(await m.call("runtime_swap_disk_and_continue", { session_id: id, path: src, settle_cycles: 100000, post_cycles: 100000, confirm_hold_cycles: 20000 }));
  return out;
}
let caseNo = 0;
async function writeCase(kind, way, endBy) {
  const tag = `${kind}/${way}/${endBy}`;
  const projC = await H.project(`c${++caseNo}`);
  const dir = join(projC, "media");
  mkdirSync(dir, { recursive: true });
  const src = join(dir, kind === "disk" ? "work.d64" : "work.crt");
  const decoy = join(dir, kind === "disk" ? "decoy.d64" : "decoy.crt");
  const savePrg = join(dir, "save.prg");
  writeFileSync(savePrg, saveProgram(8));
  writeFileSync(src, readFileSync(kind === "disk" ? files.d64 : files.ef));
  writeFileSync(decoy, readFileSync(kind === "disk" ? files.d64b : files.efb));
  const [before, decoyBefore] = [fileSha(src), fileSha(decoy)];
  let m = await H.mcp(projC, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
  const startArgs = { purpose: `S5 ${tag}`, budget_minutes: endBy === "budget" ? 0.4 : 10, ...(endBy === "idle" ? { idle_minutes: 0.25 } : {}), ...(way === "start" ? { media_path: src } : {}) };
  const t = await m.call("runtime_sandbox_start", startArgs);
  const id = idOf(t), port = portOf(t);
  if (!id) { check(false, `[${tag}] the sandbox starts`, t.slice(0, 300)); return; }
  const rec = ledger().find((r) => r.port === port);
  const handed = await handOver(m, id, way, kind, src, decoy);
  const bad = handed.find(isErr);
  if (bad) check(false, `[${tag}] the medium is handed over`, bad.slice(0, 300));
  let saw;
  if (kind === "disk") {
    const r = await m.call("runtime_run_prg", { session_id: id, prg_path: savePrg });
    if (isErr(r)) check(false, `[${tag}] the program starts`, r.slice(0, 300));
    saw = await untilMarked(m, id, port, async () => (await peek(port, 2)) === 42);
  } else {
    await m.call("runtime_session_run", { session_id: id, max_instructions: 1, cycle_budget: 2_000_000 });
    saw = (await peek(port, 0x8100)) === 0x42;
  }
  check(saw, `[${tag}] the sandbox saw its own write (${kind === "disk" ? "SAVE + VERIFY through the drive" : "the flash byte reads back"})`);
  check(fileSha(src) === before, `[${tag}] the source is byte-identical while the sandbox runs`);

  if (endBy === "reached" || endBy === "failed") await m.call("runtime_sandbox_end", { session_id: id, outcome: endBy, summary: `S5 ${tag}` });
  else if (endBy === "owner gone") { process.kill(m.proc.pid, "SIGKILL"); }
  else await waitFor(async () => !(await listening(port)), 40_000, 500);
  await waitFor(async () => !(await listening(port)), 30_000, 250);
  check(!(await listening(port)) && (!rec || !pidAlive(rec.pid)), `[${tag}] the sandbox is gone`);
  check(fileSha(src) === before, `[${tag}] the source is byte-identical after the sandbox ended (${endBy})`);
  check(fileSha(decoy) === decoyBefore, `[${tag}] …and the decoy medium too`);
  if (kind === "disk") check(d64Files(readFileSync(src)).length === 0, `[${tag}] …no file was saved into the source image`);
}
for (const way of ["start", "media_mount", "media_swap", "monitor_mount", "swap_disk_and_continue"]) await writeCase("disk", way, "reached");
for (const endBy of ["failed", "budget", "idle", "owner gone"]) await writeCase("disk", "start", endBy);
for (const way of ["start", "media_mount", "monitor_mount"]) await writeCase("crt", way, "reached");
await writeCase("crt", "start", "owner gone");

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S6  the shared machine still writes back on purpose");
{
  const sproj = await H.project("s6-proj");
  const dir = join(sproj, "media");
  mkdirSync(dir, { recursive: true });
  const src = join(dir, "work.d64");
  writeFileSync(src, blankD64("WORK"));
  const savePrg6 = join(dir, "save.prg");
  writeFileSync(savePrg6, saveProgram(8));
  const before = fileSha(src);
  const sd = await H.daemon(DAEMON, await H.project("s6-shared"));
  const m = await H.mcp(sproj, { endpoint: sd.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
  const sws = await H.ws(sd.port);
  const st = await sws.call("session/state", {});
  check(st.noWriteback !== true, "the shared-style daemon (no --scratch) does not claim no-write-back", String(st.noWriteback));
  const { atCycleZero, runCycles } = await import(pathToFileURL(join(ROOT, "scripts/lib/vector-start.mjs")).href);
  await atCycleZero((method, p) => sws.call(method, p ?? {}));
  await runCycles((method, p) => sws.call(method, p ?? {}), 3_000_000);
  const mounted = await m.call("runtime_media_mount", { session_id: "shared", path: src });
  check(!isErr(mounted), "runtime_media_mount on the shared machine", mounted.slice(0, 200));
  await m.call("runtime_run_prg", { session_id: "shared", prg_path: savePrg6 });
  const ok = await untilMarked(m, "shared", sd.port, async () => (await peek(sd.port, 2)) === 42, 80);
  check(ok, "the program on the shared machine saved and verified");
  check(fileSha(src) === before, "…and the disk file is untouched until it is asked to persist");
  const p = await m.call("runtime_media_persist", { session_id: "shared" });
  check(!isErr(p), "runtime_media_persist answers", p.slice(0, 200));
  check(fileSha(src) !== before && d64Files(readFileSync(src)).includes("T"), "…and the disk file now holds the writes", d64Files(readFileSync(src)).join(","));
  sws.close();
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S7  one end: every reason takes the same steps");
{
  const traceHyp = "$0810 INC $C000 in the idle loop (read in the listing the test built)";
  const prgFor = (dir) => { const f = join(dir, "idle.prg"); writeFileSync(f, loopPrg()); return f; };
  async function startTraced(m, projectDir, extra) {
    const t = await m.call("runtime_sandbox_start", { media_path: prgFor(projectDir), ...extra });
    const id = idOf(t), port = portOf(t);
    const tr = await m.call("runtime_trace_start", { session_id: id, hypothesis: traceHyp, domains: ["c64-cpu"] });
    await m.call("runtime_session_run", { session_id: id, max_instructions: 40000 });
    const r = ledger().find((x) => x.port === port);
    return { id, port, store: /Store: (\S+)/.exec(tr)?.[1], pid: r?.pid, scratch: r?.project };
  }
  async function verify(label, reader, projectDir, s, reason) {
    check(await waitFor(async () => !(await listening(s.port)) && !pidAlive(s.pid), 30_000), `[${label}] the daemon is gone and its port is free`);
    const retrace = s.store.replace(/\.duckdb$/, ".c64retrace");
    check(existsSync(retrace) && statSync(retrace).size > 0, `[${label}] the trace is finalized: its .c64retrace is on disk`, retrace);
    const info = await reader.call("trace_store_info", { path: s.store });
    check(!isErr(info) && /cpu|events/i.test(info), `[${label}] …and queryable`, info.slice(0, 160));
    check(await waitFor(async () => stepLog(projectDir).includes(s.id), 20_000), `[${label}] the outcome is in the step log`, stepLog(projectDir).slice(-300));
    check(stepLog(projectDir).includes(`ended (${reason})`), `[${label}] …named "${reason}"`, stepLog(projectDir).slice(-300));
    check(!!s.scratch && !existsSync(s.scratch), `[${label}] the scratch (and its --scratch dir) is gone`, s.scratch);
    const rec = recordOf(s.id);
    check(rec.state === "ended" && rec.reason === reason, `[${label}] the record says "${reason}"`, JSON.stringify(rec).slice(0, 200));
  }
  for (const outcome of ["reached", "failed"]) {
    const p = await H.project(`s7-${outcome}`);
    const m = await H.mcp(p, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
    const s = await startTraced(m, p, { purpose: `S7 ${outcome}`, budget_minutes: 10 });
    const e = await m.call("runtime_sandbox_end", { session_id: s.id, outcome, summary: `S7 ${outcome}` });
    check(new RegExp(`ended: ${outcome}`).test(e), `[${outcome}] the end call answers`, e.slice(0, 160));
    await verify(outcome, m, p, s, outcome);
  }
  {
    const p = await H.project("s7-budget");
    const m = await H.mcp(p, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
    const s = await startTraced(m, p, { purpose: "S7 budget", budget_minutes: 0.12 });
    await verify("budget", m, p, s, "budget");
  }
  {
    const p = await H.project("s7-idle");
    const m = await H.mcp(p, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
    const s = await startTraced(m, p, { purpose: "S7 idle", budget_minutes: 5, idle_minutes: 0.07 });
    await verify("idle", m, p, s, "idle");
  }
  {
    const p = await H.project("s7-owner");
    const doomed = await H.mcp(p, { endpoint: shared.endpoint });
    const s = await startTraced(doomed, p, { purpose: "S7 owner gone", budget_minutes: 10 });
    process.kill(doomed.proc.pid, "SIGKILL");
    const survivor = await H.mcp(p, { endpoint: shared.endpoint });
    await verify("owner gone", survivor, p, s, "owner gone");
  }
  {
    const p = await H.project("s7-exit");
    const m = await H.mcp(p, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
    const s = await startTraced(m, p, { purpose: "S7 runtime exits", budget_minutes: 10 });
    process.kill(s.pid, "SIGKILL");
    check(await waitFor(async () => !(await listening(s.port)), 20_000), "[runtime exited] the port is free");
    const say = await m.call("runtime_monitor_registers", { session_id: s.id });
    check(/ended: runtime exited/.test(say), "[runtime exited] the next call with the id says so", say.slice(0, 200));
    check(await waitFor(async () => stepLog(p).includes("ended (runtime exited)"), 20_000), "[runtime exited] the outcome is in the step log", stepLog(p).slice(-200));
    check(await waitFor(async () => !existsSync(s.scratch), 20_000), "[runtime exited] the scratch is gone", s.scratch);
  }
  check(scratchDirs().length === 0, "no sandbox scratch directory is left behind by the whole run", scratchDirs().join(","));
}

H.stopMcps();
process.exit(T.done());
