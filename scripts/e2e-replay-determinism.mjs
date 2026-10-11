// Replay across FRESH starts (issue #67, the retest on 0.8.0). The 899 acceptance proved "the same
// seed, the same run" inside ONE daemon; the reporter's four runs of identical arguments pressed up to
// 15 frames apart because each run was a new daemon that had been running on its own, paced by the wall
// clock, until the pause landed. This gate starts a NEW daemon process for every run, with random
// wall-clock delays between spawn and first call in some of them, and asserts the runs are identical:
//
//   A  runtime_sandbox_run, input_offset_cycles 17199 (the reporter's arguments)   x4
//   B  …with jitter_seed                                                             x4
//   C  …with sweep: 8 (every offset its own machine; they differ ONLY by the offset) x4
//   D  runtime_scene_reel's runner (runScenario): captures, their cycles, their pixels x4
//   E  `c64re scenario run` --input-offset / --jitter-seed / --sweep, a process per run x4
//   F  a candidate run (anchor + variants + an input) across a daemon restart          x4
//
// per run: frames to READY, press/release cycle of each step, end cycle, registers, a digest of all 64K
// of RAM, the check results, the screen. And the negative: another offset gives another press cycle.
//
// Needs a TRX64 with cycle-exact input (0.12.10+). Without a daemon binary it SKIPS LOUDLY. Locally:
//   C64RE_RUNTIME_BIN=/abs/path/to/trx64-daemon npm run e2e:replay-determinism
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { prgWithStub } from "./lib/asm6502-mini.mjs";
import { replayPrg } from "./lib/replay-prgs.mjs";
import { startMcp } from "./lib/mcp-stdio.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const load = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);
const { resolveDaemonSpawn } = await load("runtime/resolve-daemon-spawn.js");
const { SandboxSession } = await load("reel/sandbox-session.js");
const { requireProbeRuntime } = await load("reel/frame-probe.js");
const { runSandbox } = await load("reel/run-sandbox.js");
const { runSweep } = await load("reel/sweep.js");
const { runScenario } = await load("reel/run-scenario.js");
const { parseStep, parseCheck, parseFeature } = await load("project-knowledge/scenario-gherkin.js");
const { ProjectKnowledgeService } = await load("project-knowledge/service.js");
const candStore = await load("candidates/store.js");

const N = 4;
const HOSTILE_MS = 2500;
let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${!c && d ? `  (${String(d).slice(0, 900)})` : d ? `  (${String(d).slice(0, 160)})` : ""}`); };
const head = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const step = (t) => { const r = parseStep(t); if (!r?.step) throw new Error(`${t}: ${r?.error}`); return r.step; };
const thenCheck = (t, afterSteps) => { const r = parseCheck(t); if (!r || "error" in r) throw new Error(`${t}: ${r?.error}`); return { check: r.check, afterSteps, text: t }; };

console.log("Replay across fresh starts — identical arguments, a new daemon every time\n");

const plan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: tmpdir(), port: "0" });
if (plan.mode === "none") {
  console.log("SKIPPED — no runtime daemon binary (set C64RE_RUNTIME_BIN to an absolute path, or `c64re runtime install`).");
  process.exit(0);
}
{
  const probe = await SandboxSession.start({ budgetMs: 60_000 });
  let ok = true;
  try { await requireProbeRuntime(probe.call.bind(probe), "the replay gate"); } catch { ok = false; }
  finally { await probe.close(); }
  if (!ok) { console.log("SKIPPED — this runtime predates cycle-exact input (TRX64 0.12.10 or later is needed)."); process.exit(0); }
}

const dir = mkdtempSync(join(tmpdir(), "c64re-replay-"));
const cleanups = [];
process.on("exit", () => { for (const f of cleanups.reverse()) { try { f(); } catch { /* gone */ } } try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
const prgPath = join(dir, "replay.prg");
writeFileSync(prgPath, replayPrg());

// The wall clock between spawn and first call is the thing the reporter's runs differed in. Every
// in-process run below gets a random wait there, except the first (no wait: the plain case).
const orig = SandboxSession.prototype.call;
const waited = new WeakSet();
let hostile = false;
SandboxSession.prototype.call = async function (method, ...rest) {
  if (hostile && method !== "ping" && !waited.has(this)) {
    waited.add(this);
    await sleep(Math.floor(Math.random() * HOSTILE_MS));
  }
  return orig.call(this, method, ...rest);
};
const hostileFor = (i) => { hostile = i > 0; };

const REPORTER_STEPS = ["I wait 20 frames", "I hold joystick 2 fire for 3 frames", "I wait 10 frames"].map(step);
const REPORTER_CHECK = [thenCheck("$FB is $01", 3)];
const fullRam = [{ label: "lo", addr: 0, len: 0x8000, lens: "ram" }, { label: "hi", addr: 0x8000, len: 0x8000, lens: "ram" }];
const sandboxBase = (extra = {}) => ({ budgetMs: 120_000, mediaPath: prgPath, steps: REPORTER_STEPS, checks: REPORTER_CHECK, reads: fullRam, screen: true, ...extra });

const warmFrames = (log) => (/warmed to the BASIC prompt \((\d+) frames\)/.exec(log.find((l) => /warmed to the BASIC prompt/.test(l)) ?? "") ?? [])[1];
const fingerprint = (r) => JSON.stringify({
  warm: warmFrames(r.log),
  inputs: r.inputs.map((i) => [i.step, i.offset, i.pressAt, i.releaseAt]),
  end: r.endCycle, pc: r.pc, cpu: r.cpu,
  checks: r.checks.map((c) => [c.pass, c.actual, c.cycle]),
  ram: sha(Buffer.concat(r.reads.map((x) => Buffer.from(x.bytes)))),
  screen: sha((r.screenRows ?? []).join("\n")),
  waits: r.waits,
});
/** All N fingerprints equal; on a difference say which fields moved. */
function allSame(label, prints) {
  const same = prints.every((p) => p === prints[0]);
  let why = "";
  if (!same) {
    const objs = prints.map((p) => JSON.parse(p));
    why = Object.keys(objs[0]).filter((k) => objs.some((o) => JSON.stringify(o[k]) !== JSON.stringify(objs[0][k])))
      .map((k) => `${k}: ${objs.map((o) => JSON.stringify(o[k])).join(" / ")}`).join(" ; ");
  }
  check(same, `${label}: ${prints.length} fresh daemons, identical`, same ? prints[0].slice(0, 150) : why);
  return same;
}

try {
  // ── A ─────────────────────────────────────────────────────────────────────────
  head("A  runtime_sandbox_run, input_offset_cycles: 17199, the reporter's steps");
  const A = [];
  for (let i = 0; i < N; i++) { hostileFor(i); A.push(await runSandbox(sandboxBase({ inputOffsetCycles: 17199 }))); }
  allSame("A", A.map(fingerprint));
  check(A[0].inputs.length === 1 && A[0].inputs[0].offset === 17199 && A[0].inputs[0].releaseAt === A[0].inputs[0].pressAt + 3 * 19656, "…the press carries the offset and releases 3 frames later", JSON.stringify(A[0].inputs[0]));
  check(Number(warmFrames(A[0].log)) > 0 && A.every((r) => warmFrames(r.log) === warmFrames(A[0].log)), "…the warm-up to READY took the same frames every time", `${warmFrames(A[0].log)} frames`);
  hostileFor(0);
  const other = await runSandbox(sandboxBase({ inputOffsetCycles: 4914 }));
  check(other.inputs[0].pressAt !== A[0].inputs[0].pressAt && other.inputs[0].pressAt - A[0].inputs[0].pressAt === 4914 - 17199, "negative: another offset presses at another cycle, exactly by the difference", `${other.inputs[0].pressAt} vs ${A[0].inputs[0].pressAt}`);
  check(!other.checks[0].pass && A[0].checks[0].pass, "…and it is the case where the check fails: the test sees the beam position", `${other.checks[0].actual} vs ${A[0].checks[0].actual}`);
  const plain = [];
  for (let i = 0; i < 2; i++) { hostileFor(i); plain.push(await runSandbox(sandboxBase())); }
  allSame("A0 (no offset option)", plain.map(fingerprint));

  // ── B ─────────────────────────────────────────────────────────────────────────
  head("B  jitter_seed: 42");
  const B = [];
  for (let i = 0; i < N; i++) { hostileFor(i); B.push(await runSandbox(sandboxBase({ jitterSeed: 42 }))); }
  allSame("B", B.map(fingerprint));
  hostileFor(0);
  const B2 = await runSandbox(sandboxBase({ jitterSeed: 43 }));
  check(B2.inputs[0].offset !== B[0].inputs[0].offset, "negative: another seed gives another offset", `${B2.inputs[0].offset} vs ${B[0].inputs[0].offset}`);

  // ── C ─────────────────────────────────────────────────────────────────────────
  head("C  sweep: 8 — every offset its own machine");
  const sweepPrint = (w) => JSON.stringify({
    count: w.count, cpf: w.cyclesPerFrame, first: w.firstFailing, pass: w.pass, fail: w.fail, error: w.error,
    runs: w.runs.map((r) => [r.offset, r.verdict, r.result ? JSON.parse(fingerprint(r.result)) : r.error]),
  });
  const C = [];
  for (let i = 0; i < N; i++) { hostileFor(i); C.push(await runSweep(sandboxBase(), 8)); }
  allSame("C", C.map(sweepPrint));
  check(C[0].fail >= 1 && C[0].pass >= 1 && C[0].error === 0, "…some offsets fail and some pass (the sweep means something)", `${C[0].pass} pass, ${C[0].fail} fail`);
  // the runs of a sweep differ ONLY by the offset: the machine the press lands on is the same
  const warms = new Set(C[0].runs.map((r) => warmFrames(r.result.log)));
  const dist = C[0].runs.map((r) => r.result.inputs[0].pressAt - r.offset);
  check(warms.size === 1 && new Set(dist).size === 1, "…every run of one sweep pressed at (the same base + its offset): same warm-up, same base cycle", `warm ${[...warms]}, base ${[...new Set(dist)]}`);

  // ── D ─────────────────────────────────────────────────────────────────────────
  head("D  runtime_scene_reel's runner: captures, their cycles and pixels");
  // A bare machine (a reel cannot mount a PRG): a typed line is the input step, the cursor blink and the
  // typed text make the pictures depend on every cycle that came before.
  const reelFeature = [
    "Feature: f", "  Scenario: reel", "    Given a bare machine",
    "    When I wait 130 frames", '    And I type "PRINT 42{RETURN}"', "    And I wait 10 frames", '    And I capture "a"',
    "    And I wait 37 frames", '    And I capture "b"', "    Then the reel has at least 2 screens",
  ].join("\n");
  const reelScenario = parseFeature(reelFeature, "r.feature").scenarios[0];
  const reelPrint = (r) => JSON.stringify({
    shots: r.shots.map((s) => [s.label, s.cycle, s.rasterLine, sha(s.indices)]),
    end: r.endCycle, inputs: r.inputs.map((i) => [i.step, i.offset, i.pressAt, i.releaseAt]),
    waits: r.waits, w: r.width, h: r.height,
  });
  const D = [];
  for (let i = 0; i < N; i++) {
    hostileFor(i);
    D.push(await runScenario(reelScenario, { budgetMs: 120_000, inputOffsetCycles: 17199, resolveMedium: (n) => n }));
  }
  allSame("D", D.map(reelPrint));
  check(D[0].shots.length === 2 && D[0].shots[0].indices.length > 1000, "…two captures with a picture each", String(D[0].shots.map((s) => s.indices.length)));
  hostileFor(0);
  const Dj = [];
  for (let i = 0; i < 2; i++) { hostileFor(i); Dj.push(await runScenario(reelScenario, { budgetMs: 120_000, jitterSeed: 42, resolveMedium: (n) => n })); }
  allSame("D (jitter_seed 42)", Dj.map(reelPrint));
  hostileFor(0);

  // ── E ─────────────────────────────────────────────────────────────────────────
  head("E  `c64re scenario run`, a process per run");
  writeFileSync(join(dir, "replay.feature"), ["Feature: f", "  Scenario: replay", '    Given the disk "replay.prg"', "    When I wait 20 frames", "    And I hold joystick 2 fire for 3 frames", "    And I wait 10 frames", "    Then $FB is $01"].join("\n"));
  const cli = join(ROOT, "dist/cli.js");
  const hook = join(ROOT, "scripts/lib/replay-delay-hook.mjs");
  const cliRun = (args, i) => spawnSync(process.execPath, [...(i > 0 ? ["--import", pathToFileURL(hook).href] : []), cli, "scenario", "run", "replay.feature", ...args],
    { cwd: dir, env: { ...process.env, C64RE_RUNTIME_AUTOSTART: "0", REPLAY_HOSTILE_DELAY_MS: String(HOSTILE_MS) }, encoding: "utf8", timeout: 600_000 });
  const cliPrint = (r) => {
    let doc; try { doc = JSON.parse(r.stdout); } catch { return `unparsable: exit ${r.status} ${r.stdout.slice(0, 200)} ${r.stderr.slice(-200)}`; }
    const strip = (v) => Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !/^elapsed/i.test(k)).map(([k, x]) => [k, strip(x)])) : v;
    return JSON.stringify(strip(doc));
  };
  for (const [label, args] of [["--input-offset 17199", ["--input-offset", "17199"]], ["--jitter-seed 42", ["--jitter-seed", "42"]], ["--sweep 8", ["--sweep", "8"]]]) {
    const prints = [];
    for (let i = 0; i < N; i++) prints.push(cliPrint(cliRun([...args, "--json"], i)));
    const ok = prints.every((p) => p === prints[0]) && !prints[0].startsWith("unparsable");
    check(ok, `E ${label}: ${N} fresh processes, identical --json`, ok ? prints[0].slice(0, 120) : prints.map((p) => sha(p) + (p.startsWith("unparsable") ? " " + p.slice(0, 150) : "")).join(" / "));
  }
  {
    const doc = JSON.parse(cliRun(["--input-offset", "17199", "--json"], 0).stdout);
    const doc2 = JSON.parse(cliRun(["--input-offset", "4914", "--json"], 0).stdout);
    check(doc.results[0].inputs[0].pressAt !== doc2.results[0].inputs[0].pressAt, "negative: another --input-offset presses at another cycle");
  }

  // ── F ─────────────────────────────────────────────────────────────────────────
  head("F  a candidate run from a re-set anchor, across a daemon restart");
  const CPRG = prgWithStub(["SEI", "loop:", "LDA $DC00", "AND #$10", "BNE nofire", "INC $C001", "nofire:", "INC $C000", "JMP loop"]);
  const cprg = join(dir, "cand.prg");
  writeFileSync(cprg, CPRG);
  const LOOP_INC_OPERAND = 0x0819, FIRE_INC_OPERAND = 0x0816;
  const proj = join(dir, "proj");
  mkdirSync(proj, { recursive: true });
  new ProjectKnowledgeService(proj).initProject({ name: "replay" });
  const startDaemon = async () => {
    const port = await freePort();
    // the shared-machine start (NOT headless): the candidate loop is driven on the machine a person co-drives
    const p = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: proj, port: String(port) });
    const c = spawn(p.cmd, p.args, { stdio: "ignore" });
    const stop = () => { try { c.kill("SIGTERM"); } catch { /* gone */ } };
    cleanups.push(stop);
    for (let i = 0; i < 80; i++) { try { const ws = new WebSocket(`ws://127.0.0.1:${port}/?av=0`); await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); }); ws.close(); break; } catch { await sleep(250); } }
    return { port, endpoint: `ws://127.0.0.1:${port}`, stop: async () => { stop(); await new Promise((r) => (c.exitCode !== null ? r() : c.once("exit", r))); } };
  };
  const fPrints = [];
  for (let i = 0; i < N; i++) {
    const d = await startDaemon();
    if (i > 0) await sleep(Math.floor(Math.random() * HOSTILE_MS));
    const m = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_STATE_DIR: join(dir, "state"), C64RE_RUNTIME_ENDPOINT: d.endpoint } });
    try {
      await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-replay", version: "1" } });
      await m.call("agent_onboard", {});
      await m.call("runtime_session_start", {});
      await m.call("runtime_run_prg", { session_id: "shared", prg_path: cprg, run: "080d" });
      await m.call("runtime_session_run", { session_id: "shared", cycle_budget: 300000, max_instructions: 10000000 });
      const set = await m.call("runtime_anchor_set", { name: "a1" });
      const anchorCycle = /cycle (\d+)/.exec(set)?.[1];
      const id = `c${i}`;
      await m.call("runtime_candidate_create", { anchor: "a1", cycle_budget: 200000, id, inputs: [{ atCycle: 40000, kind: "joystick2", payload: { fire: true } }] });
      await m.call("runtime_candidate_variant", { id, name: "fire_to_c101", targets: [{ addr: FIRE_INC_OPERAND, bytes: [0x01, 0xc1] }] });
      await m.call("runtime_candidate_variant", { id, name: "loop_to_c100", targets: [{ addr: LOOP_INC_OPERAND, bytes: [0x00, 0xc1] }] });
      await m.call("runtime_candidate_variant", { id, name: "no_change", targets: [{ addr: LOOP_INC_OPERAND, bytes: [0x00, 0xc0] }] });
      await m.call("runtime_candidate_run", { id });
      const c = candStore.loadCandidate(proj, id);
      const v = (x) => x && [x.state, x.cycles, x.registers, x.ramDigest, x.identical, x.differing, x.changes, x.inputsPlayed, x.inputsSkipped];
      fPrints.push(JSON.stringify({ anchorCycle, baseline: v(c.baseline), variants: c.variants.map((x) => [x.name, v(x.verdict)]) }));
    } finally { m.stop(); await d.stop(); }
  }
  const fSame = fPrints.every((p) => p === fPrints[0]);
  check(fSame, `F: ${N} daemon restarts, anchor re-set, candidate re-run: same anchor cycle, verdicts, cycles, registers, RAM digests`, fSame ? fPrints[0].slice(0, 160) : fPrints.map(sha).join(" / ") + "\n" + fPrints.join("\n"));
  const f0 = JSON.parse(fPrints[0]);
  check(f0.baseline?.[0] === "done" && f0.variants.length === 3 && f0.baseline[8] !== undefined, "…and the runs are real ones (done, with inputs played)", fPrints[0].slice(0, 200));
} finally {
  SandboxSession.prototype.call = orig;
}
console.log(`\n${fail === 0 ? "GREEN" : "RED"} e2e replay-determinism: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
