// Spec 899 — the input offset, the sweep, the windowed check and the series, on real private
// machines. Synthetic PRGs, assembled from listings in this repo (scripts/lib/899-prgs.mjs):
//
//   d011  a raster IRQ is armed for line 100, then a fire press does lda $D011 / ora #$10 /
//         sta $D011. Bit 7 reads the beam's line bit 8 and writes the IRQ line's bit 8, so a
//         press with the beam at line 256 or below leaves the IRQ at line 356: dead.
//   glitch  $D01C is held at a wrong value for 3 frames out of every 200.
//
// Needs a runtime with cycle-exact input and the frame probe (TRX64 after 0.12.9). Without a
// runtime binary, or with one that predates them, it SKIPS LOUDLY and says why; against an
// older runtime it also proves the refusal. Locally:
//   C64RE_RUNTIME_BIN=../TRX64/target/release/trx64-daemon npm run e2e:899-sweep
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { d011Prg, glitchPrg } from "./lib/899-prgs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const load = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);
const { resolveDaemonSpawn } = await load("runtime/resolve-daemon-spawn.js");
const { SandboxSession } = await load("reel/sandbox-session.js");
const { requireProbeRuntime } = await load("reel/frame-probe.js");
const { runSandbox } = await load("reel/run-sandbox.js");
const { runSweep } = await load("reel/sweep.js");
const { runScenario } = await load("reel/run-scenario.js");
const { sweepOffsets } = await load("reel/input-offset.js");
const { parseStep, parseCheck, parseFeature } = await load("project-knowledge/scenario-gherkin.js");

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const rejects = async (p) => { try { await p; return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const step = (t) => { const r = parseStep(t); if (!r?.step) throw new Error(`${t}: ${r?.error}`); return r.step; };
const thenCheck = (t, afterSteps) => { const r = parseCheck(t); if (!r || "error" in r) throw new Error(`${t}: ${r?.error}`); return { check: r.check, afterSteps, text: t }; };

console.log("Spec 899 — input offsets, sweeps, windows and series on real machines\n");

// ── is there a runtime, and does it have what 899 needs? ─────────────────────────
const plan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: tmpdir(), port: "0" });
if (plan.mode === "none") {
  console.log("SKIPPED — no runtime daemon binary (set C64RE_RUNTIME_BIN, or `c64re runtime install`).");
  console.log("          This half needs a TRX64 with cycle-exact input and the frame probe (after 0.12.9).");
  process.exit(0);
}
let has901 = true;
{
  const probeBox = await SandboxSession.start({ budgetMs: 60_000 });
  try { await requireProbeRuntime(probeBox.call.bind(probeBox), "the live half"); } catch { has901 = false; }
  finally { await probeBox.close(); }
}

const dir = mkdtempSync(join(tmpdir(), "c64re-899-"));
const prg = (name, bytes) => { const p = join(dir, name); writeFileSync(p, bytes); return p; };
const fault = prg("fault.prg", d011Prg("fault"));
const heal = prg("heal.prg", d011Prg("heal"));
const direct = prg("direct.prg", d011Prg("direct"));
const glitch = prg("glitch.prg", glitchPrg(true));
const clean = prg("clean.prg", glitchPrg(false));

try {
  if (!has901) {
    console.log("This runtime predates cycle-exact input and the frame probe. What must hold:");
    const press = [step("I wait 20 frames"), step("I hold joystick 2 fire for 3 frames"), step("I wait 5 frames")];
    const msg = await rejects(runSandbox({ budgetMs: 60_000, mediaPath: fault, steps: press, inputOffsetCycles: 1000 }));
    check(/an input offset needs a TRX64 with cycle-exact input and the frame probe/.test(msg ?? ""), "an input offset is refused, naming what is needed", msg?.slice(0, 100));
    const msgW = await rejects(runSandbox({ budgetMs: 60_000, mediaPath: glitch, steps: [step("I wait 20 frames")], checks: [thenCheck("$D01C@io is $04 throughout the next 50 frames", 1)] }));
    check(/a `throughout` check needs a TRX64/.test(msgW ?? ""), "a `throughout` check is refused the same way", msgW?.slice(0, 100));
    const msgS = await rejects(runSandbox({ budgetMs: 60_000, mediaPath: glitch, steps: [step('I read the series "$D01C:1@io" every frame for 50 frames')] }));
    check(/a series read needs a TRX64/.test(msgS ?? ""), "a series read too", msgS?.slice(0, 100));
    const msgSweep = await rejects(runSweep({ budgetMs: 60_000, mediaPath: fault, steps: press, checks: [thenCheck("$C002 is $01", 3)] }, 4));
    check(/needs a TRX64/.test(msgSweep ?? ""), "and a sweep stops at the first run, not 4 failures that look like a bug", msgSweep?.slice(0, 100));
    const plain = await runSandbox({ budgetMs: 60_000, mediaPath: fault, steps: [step("I wait 5 frames")], screen: false });
    check(plain.inputs.length === 0 && plain.series.length === 0 && plain.endCycle > 0, "a run without any of it still works on this runtime");
    console.log("\nSKIPPED the rest — it needs a runtime with cycle-exact input and the frame probe (TRX64 after 0.12.9).");
    console.log(`${fail === 0 ? "GREEN" : "RED"} e2e-899 sweep (refusals only): ${pass} pass, ${fail} fail.`);
    process.exit(fail === 0 ? 0 : 1);
  }

  // ── D1/D2: the $D011 case ────────────────────────────────────────────────────
  console.log("D2. the $D011 read-modify-write: some offsets fail, some pass");
  const steps = [step("I wait 20 frames"), step("I hold joystick 2 fire for 3 frames"), step("I wait 20 frames")];
  const checks = [thenCheck("$C002 is $01", 3)];
  const base = (mediaPath, extra = {}) => ({ budgetMs: 120_000, mediaPath, steps, checks, screen: false, ...extra });

  const plain1 = await runSandbox(base(fault));
  const plain2 = await runSandbox(base(fault));
  check(plain1.inputs.length === 0 && plain1.endCycle === plain2.endCycle && plain1.checks[0].actual === plain2.checks[0].actual,
    "without an option a run carries no offset and replays to the same cycle", `end ${plain1.endCycle}`);

  const w = await runSweep(base(fault), 8);
  check(w.count === 8 && w.runs.length === 8 && w.runs.map((r) => r.offset).join() === sweepOffsets(8, w.cyclesPerFrame).join(), "sweep 8: eight runs, offsets spread across one frame", w.runs.map((r) => r.offset).join(" "));
  check(w.cyclesPerFrame === 19656, "…of the PAL frame the machine reported", String(w.cyclesPerFrame));
  check(w.fail >= 1 && w.pass >= 1 && w.error === 0, "…some offsets FAIL and some PASS", `${w.pass} pass, ${w.fail} fail: ${w.runs.map((r) => r.verdict[0]).join("")}`);
  check(w.firstFailing !== undefined && w.runs.find((r) => r.offset === w.firstFailing).verdict === "FAIL", "…and the first failing offset is named", String(w.firstFailing));
  const failed = w.runs.find((r) => r.verdict === "FAIL");
  check(failed.checks[0].actual === "$FF", "…a failing run says what was there: the IRQ is dead", failed.checks[0].actual);
  check(failed.result.inputs.length === 1 && failed.result.inputs[0].offset === w.firstFailing && failed.result.inputs[0].pressAt > 0, "…and reports the offset and the cycle its press landed on", JSON.stringify(failed.result.inputs[0]));

  const replay = await runSandbox(base(fault, { inputOffsetCycles: w.firstFailing }));
  check(!replay.checks[0].pass && replay.checks[0].actual === "$FF", "replaying the first failing offset fails again");
  check(replay.endCycle === failed.result.endCycle && replay.inputs[0].pressAt === failed.result.inputs[0].pressAt, "…to the same cycle, the press on the same cycle", `end ${replay.endCycle}, press ${replay.inputs[0].pressAt}`);
  const okRun = w.runs.find((r) => r.verdict === "PASS");
  const okAgain = await runSandbox(base(fault, { inputOffsetCycles: okRun.offset }));
  check(okAgain.checks[0].pass && okAgain.endCycle === okRun.result.endCycle, "…and a passing offset passes again, to the same cycle");

  const healed = await runSweep(base(heal), 8);
  check(healed.pass === 8, "the healed build (and #$7F) passes at every offset", healed.runs.map((r) => r.verdict[0]).join(""));
  const direct8 = await runSweep(base(direct), 8);
  check(direct8.pass === 8, "…and so does the build that writes $D011 without reading bit 7", direct8.runs.map((r) => r.verdict[0]).join(""));

  console.log("\nD1. a seed gives each input step its own offset, repeatably");
  const j1 = await runSandbox(base(fault, { jitterSeed: 7 }));
  const j2 = await runSandbox(base(fault, { jitterSeed: 7 }));
  const j3 = await runSandbox(base(fault, { jitterSeed: 8 }));
  check(j1.inputs.length === 1 && j1.inputs[0].offset === j2.inputs[0].offset && j1.endCycle === j2.endCycle && j1.checks[0].actual === j2.checks[0].actual, "the same seed: the same offset, the same run", `offset ${j1.inputs[0].offset}`);
  check(j1.inputs[0].offset !== j3.inputs[0].offset && j1.inputs[0].offset < 19656, "another seed: another offset, inside the frame", `${j1.inputs[0].offset} vs ${j3.inputs[0].offset}`);
  const typed = await runSandbox({ budgetMs: 60_000, steps: [step("I wait 10 frames"), step('I type "A"'), step("I wait 5 frames")], inputOffsetCycles: 3000, screen: false });
  check(typed.inputs.length === 1 && typed.inputs[0].step === 1 && typed.inputs[0].offset === 3000, "`I type` is an input step too", JSON.stringify(typed.inputs[0]));
  const plainT = await runSandbox({ budgetMs: 60_000, steps: [step("I wait 10 frames"), step('I type "A"'), step("I wait 5 frames")], screen: false });
  check(typed.endCycle - plainT.endCycle < 200 && typed.endCycle - plainT.endCycle > -200, "…and the steps after it keep their place in the schedule", `${typed.endCycle} vs ${plainT.endCycle}`);
  const halves = await runSandbox({ budgetMs: 60_000, mediaPath: fault, steps: [step("I wait 20 frames"), step("I start holding joystick 2 fire"), step("I wait 3 frames"), step("I release joystick 2"), step("I wait 20 frames")], checks: [thenCheck("$C002 is $01", 5)], inputOffsetCycles: 7371, screen: false });
  check(halves.inputs.map((i) => i.step).join() === "1,3" && halves.inputs.every((i) => i.offset === 7371) && halves.checks[0].pass, "a press in two halves: both are offset", JSON.stringify(halves.inputs.map((i) => i.pressAt)));

  console.log("\nD3/D4. a register wrong for 3 frames out of 200");
  const gSteps = [step("I wait 20 frames")];
  const gRun = (media, st, cs) => runSandbox({ budgetMs: 120_000, mediaPath: media, steps: st, checks: cs, screen: false });
  const series = await gRun(glitch, [...gSteps, step('I read the series "$D01C:1@io" every frame for 600 frames')], []);
  const sr = series.series[0];
  check(sr.samples === 600 && sr.rows.length <= 8 && sr.rows.length >= 3, "read_series over 600 frames returns only the changing rows", `${sr.rows.length} rows of ${sr.samples} samples`);
  check(sr.rows.every((r, i) => i === 0 || r.bytes.join() !== sr.rows[i - 1].bytes.join()), "…every row differs from the one before it");
  check(sr.rows[0].frame === 0 && sr.rows[0].bytes[0] === 4 && sr.rows[1].bytes[0] === 0 && sr.rows[2].bytes[0] === 4 && sr.rows[2].frame - sr.rows[1].frame === 3, "…it shows the glitch: $04, then $00 for 3 frames, then $04", sr.rows.slice(0, 3).map((r) => `${r.frame}:${r.bytes[0]}`).join(" "));
  check(sr.rows[1].c64Cycles > 0 && sr.rows[1].line === 288, "…each row has its cycle and the raster line it was sampled at", `cycle ${sr.rows[1].c64Cycles}, line ${sr.rows[1].line}`);
  const every3 = await gRun(glitch, [...gSteps, step('I read the series "$D01C:1@io" every 3 frames for 600 frames')], []);
  check(every3.series[0].rows.every((r) => r.frame % 3 === 0) && every3.series[0].samples === 200, "every 3 frames: every row is on a multiple of 3", `${every3.series[0].rows.length} rows`);

  const thr = await gRun(glitch, gSteps, [thenCheck("$D01C@io is $04 throughout the next 600 frames", 1)]);
  const t = thr.checks[0];
  check(!t.pass && t.failedAt?.frame === sr.rows[1].frame && t.failedAt.cycle === sr.rows[1].c64Cycles, "throughout the next 600 frames fails at the first glitch frame and cycle (the series' first change)", `frame ${t.failedAt?.frame}, cycle ${t.failedAt?.cycle}`);
  check(/frame 43, cycle \d+ \(raster line 288, cycle \d+\): \$D01C is \$00, wanted \$04/.test(t.actual), "…naming the frame, the cycle and the value", t.actual);
  const thr2 = await gRun(glitch, gSteps, [thenCheck("$D01C@io is $04 throughout the next 600 frames", 1)]);
  check(thr2.checks[0].actual === t.actual && thr2.endCycle === thr.endCycle, "…the same on a second run");
  check(thr.endCycle === t.cycle, "…and the machine stays where it failed", `end ${thr.endCycle}`);
  const notZero = await gRun(glitch, gSteps, [thenCheck("$D01C@io is not $00 at every frame for 600 frames", 1)]);
  check(!notZero.checks[0].pass && notZero.checks[0].failedAt.frame === t.failedAt.frame, "is not … at every frame for N frames fails at the same frame");
  const oneOf = await gRun(glitch, gSteps, [thenCheck("$D01C@io is one of $04, $05 throughout the next 600 frames at raster line 250", 1)]);
  check(!oneOf.checks[0].pass && oneOf.checks[0].failedAt.line === 250 && oneOf.checks[0].failedAt.frame === t.failedAt.frame, "is one of … at raster line 250 samples that line", `line ${oneOf.checks[0].failedAt?.line}`);
  const short = await gRun(glitch, gSteps, [thenCheck("$D01C@io is $04 throughout the next 40 frames", 1)]);
  check(short.checks[0].pass && /held for 40 frames/.test(short.checks[0].actual), "a window that ends before the glitch passes");
  const cleanRun = await gRun(clean, gSteps, [thenCheck("$D01C@io is $04 throughout the next 600 frames", 1), thenCheck("$D01C@io is not $00 throughout the next 600 frames", 1)]);
  check(cleanRun.checks.every((c) => c.pass), "the same PRG with the glitch removed passes", cleanRun.checks.map((c) => c.actual).join(" | "));
  const cleanSeries = await gRun(clean, [...gSteps, step('I read the series "$D01C:1@io" every frame for 600 frames')], []);
  check(cleanSeries.series[0].rows.length === 1, "…and its series is one row: nothing changed");
  const afterWindow = await gRun(glitch, [...gSteps, step("I wait 5 frames")], [thenCheck("$D01C@io is $04 throughout the next 30 frames", 1), thenCheck("$D01C@io is $04", 2)]);
  check(afterWindow.checks.every((c) => c.pass) && afterWindow.checks[1].cycle > afterWindow.checks[0].cycle, "after a window the steps continue from where it ended");
  const badLine = await rejects(gRun(glitch, gSteps, [thenCheck("$D01C@io is $04 throughout the next 5 frames at raster line 400", 1)]));
  check(/raster line 400 does not exist on c64-pal, which has 312 lines/.test(badLine ?? ""), "a raster line the model does not have is refused, naming the model", badLine?.slice(0, 80));
  const ntsc = await runSandbox({ budgetMs: 120_000, model: "c64-ntsc", mediaPath: glitch, steps: [...gSteps, step('I read the series "$D01C:1@io" every frame for 30 frames')], screen: false });
  check(ntsc.series[0].line === 12 && ntsc.machine.cyclesPerFrame === 17095, "NTSC: the default line is the one after ITS visible area", `line ${ntsc.series[0].line}`);

  console.log("\nthe reel takes the offsets too");
  const reelText = (media) => ["Scenario: one press", `    Given ${media}`, "    When I wait 150 frames", '    And I hold the key "SPACE" for 2 frames', "    And I wait 5 frames", '    And I capture "after"', "    Then the reel has at least 1 screens"].join("\n");
  const reelFeature = parseFeature(reelText("a bare machine"), "r.feature").scenarios[0];
  const r0 = await runScenario(reelFeature, { budgetMs: 120_000 });
  const r1 = await runScenario(reelFeature, { budgetMs: 120_000, inputOffsetCycles: 2457 });
  const r2 = await runScenario(reelFeature, { budgetMs: 120_000, inputOffsetCycles: 2457 });
  check(r0.inputs.length === 0 && r1.inputs.length === 1 && r1.inputs[0].offset === 2457 && r1.inputs[0].releaseAt === r1.inputs[0].pressAt + 2 * 19656, "a reel reports the offset its press used, and none without the option", JSON.stringify(r1.inputs[0]));
  check(r1.shots[0].cycle === r2.shots[0].cycle, "…and replays to the same capture cycle");
  const reelSeries = parseFeature(["Scenario: s", "    Given a bare machine", '    When I read the series "$C000" every frame for 5 frames', '    And I capture "x"', "    Then it works"].join("\n")).scenarios[0];
  const reelMsg = await rejects(runScenario(reelSeries, { budgetMs: 60_000 }));
  check(/a reel assembles pictures and does not read series/.test(reelMsg ?? ""), "a reel refuses a series step, pointing at the tools that report it", reelMsg?.slice(0, 80));

  // ── `c64re scenario run` ─────────────────────────────────────────────────────
  console.log("\nD5. the same notation through `c64re scenario run`");
  const cli = join(ROOT, "dist/cli.js");
  const env = { ...process.env, C64RE_RUNTIME_AUTOSTART: "0" };
  const run = (...args) => spawnSync(process.execPath, [cli, "scenario", "run", ...args], { cwd: dir, env, encoding: "utf8", timeout: 300_000 });
  const featureFor = (name, prgName, tail) => {
    writeFileSync(join(dir, `${name}.feature`), ["Feature: f", `  Scenario: ${name}`, `    Given the disk "${prgName}"`, "    When I wait 20 frames", ...tail].join("\n"));
    return `${name}.feature`;
  };
  const press = ["    And I hold joystick 2 fire for 3 frames", "    And I wait 20 frames", "    Then $C002 is $01"];
  const fFault = featureFor("fault", "fault.prg", press);
  const fHeal = featureFor("heal", "heal.prg", press);
  const a = run(fFault, "--sweep", "8");
  check(a.status === 1 && /^FAIL +fault\.feature/m.test(a.stdout) && /first failing offset: \d+ \(replay: --input-offset \d+\)/.test(a.stdout), "--sweep 8 over the fault build: FAIL, exit 1, the first failing offset to replay", a.stdout.split("\n").filter((l) => /offset/.test(l)).slice(0, 3).join(" | "));
  const firstFailing = Number(/--input-offset (\d+)/.exec(a.stdout)?.[1]);
  const b = run(fFault, "--input-offset", String(firstFailing));
  check(b.status === 1 && /\$C002 is \$01 — got \$FF/.test(b.stdout), "--input-offset <that> fails again, with what was there", b.stdout.split("\n")[1]);
  const c = run(fFault, "--input-offset", "0");
  check(c.status === 0 && /^PASS/m.test(c.stdout), "--input-offset 0 passes (the beam is above line 256 there)");
  const d = run(fHeal, "--sweep", "8");
  check(d.status === 0 && /^PASS +heal\.feature/m.test(d.stdout), "--sweep 8 over the healed build: PASS at every offset, exit 0");
  const e = run(fFault, "--sweep", "8", "--jitter-seed", "3");
  check(e.status !== 0 && /a sweep chooses the offsets itself/.test(e.stdout + e.stderr), "a sweep and a seed together are refused");
  const fGlitch = featureFor("glitch", "glitch.prg", ['    And I read the series "$D01C:1@io" every frame for 600 frames', "    Then $D01C@io is $04 throughout the next 600 frames"]);
  const g = run(fGlitch);
  check(g.status === 1 && /frame \d+, cycle \d+ \(raster line 288, cycle \d+\): \$D01C is \$00, wanted \$04/.test(g.stdout), "a .feature with a series and a throughout: FAIL at the glitch frame", g.stdout.split("\n").filter((l) => /frame \d+, cycle/.test(l))[0]?.trim().slice(0, 100));
  check(/series: \$D01C:1@io — 600 frames/.test(g.stdout) && /\n +4\d +\d+ +288/.test(g.stdout), "…and prints the series' rows");
  const gj = JSON.parse(run(fGlitch, "--json").stdout);
  check(gj.results[0].series?.[0]?.rows?.length >= 3 && gj.results[0].checks[0].failedAt?.frame > 0, "--json carries the series and where the check failed");
  const fClean = featureFor("clean", "clean.prg", ['    Then $D01C@io is $04 throughout the next 600 frames at raster line 250']);
  check(run(fClean).status === 0, "the glitch-free PRG passes the same notation");

  // ── the MCP tool ─────────────────────────────────────────────────────────────
  console.log("\nthe tool");
  const server = spawn(process.execPath, [cli], { cwd: tmpdir(), env: { ...env, C64RE_PROJECT_DIR: dir, C64RE_FULL_TOOLS: "" }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = ""; const pending = new Map(); let nextId = 1;
  server.stdout.on("data", (d) => {
    buf += d.toString(); let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => ((await rpc("tools/call", { name, arguments: args })).result?.content ?? []).map((x) => x.text).join("\n");
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-899", version: "1" } });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await call("project_init", { project_dir: dir, name: "s899" });
    await call("agent_onboard", { project_dir: dir });
    // project_init sorts the media it finds into input/; put the two this block uses back.
    writeFileSync(join(dir, "fault.prg"), d011Prg("fault"));
    writeFileSync(join(dir, "glitch.prg"), glitchPrg(true));
    const sweepText = await call("runtime_sandbox_run", {
      project_dir: dir, media_path: fault, sweep: 8,
      steps: ["I wait 20 frames", "I hold joystick 2 fire for 3 frames", "I wait 20 frames", "Then $C002 is $01"],
    });
    check(/SWEEP — 8 runs/.test(sweepText) && /first failing offset: \d+ cycles — run it again with input_offset_cycles: \d+/.test(sweepText) && /offset \d+ +PASS/.test(sweepText) && /offset \d+ +FAIL/.test(sweepText), "runtime_sandbox_run sweep: 8 — a line per offset and the first failing one", (/first failing[^\n]*/.exec(sweepText) ?? [sweepText.slice(0, 120)])[0]);
    const replayText = await call("runtime_sandbox_run", {
      project_dir: dir, media_path: fault, input_offset_cycles: w.firstFailing,
      steps: ["I wait 20 frames", "I hold joystick 2 fire for 3 frames", "I wait 20 frames", "Then $C002 is $01"],
    });
    check(/checks: 0 passed, 1 failed/.test(replayText) && new RegExp(`\\+${w.firstFailing} +pressed at cycle \\d+, released at \\d+`).test(replayText), "…replayed with input_offset_cycles: FAIL, the offset and the cycles it pressed and released at in the report");
    const seriesText = await call("runtime_sandbox_run", {
      project_dir: dir, media_path: glitch, read_series: ["$D01C:1@io"], series_frames: 600, steps: ["I wait 20 frames", "Then $D01C@io is $04 throughout the next 600 frames"],
    });
    check(/FAIL +\$D01C@io is \$04 throughout the next 600 frames — got frame 43, cycle \d+/.test(seriesText) && /series: \$D01C:1@io — 600 frames/.test(seriesText), "…the windowed check and the series in one report", (/FAIL[^\n]*/.exec(seriesText) ?? [""])[0].slice(0, 100));
    const bad = await call("runtime_sandbox_run", { project_dir: dir, media_path: fault, sweep: 8, jitter_seed: 1, steps: ["I wait 1 frames"] });
    check(/a sweep chooses the offsets itself/.test(bad), "sweep with jitter_seed is refused before a machine starts");
    const noThen = await call("runtime_sandbox_run", { project_dir: dir, media_path: fault, sweep: 4, steps: ["I hold joystick 2 fire for 3 frames"] });
    check(/needs at least one `Then`/.test(noThen), "a sweep with nothing to decide by is refused");
    const reelOut = await call("runtime_scene_reel", {
      project_dir: dir, out_path: join(dir, "r.gif"), input_offset_cycles: 2457, feature: reelText("a bare machine").replace(/^    /gm, "  "),
    });
    check(/input offsets/.test(reelOut) && /\+2457 +pressed at cycle/.test(reelOut), "runtime_scene_reel reports the offset its press used");
  } finally {
    server.stdin.end(); server.kill();
  }
} catch (e) {
  check(false, "harness", e.stack ?? e.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} e2e-899 sweep: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
