#!/usr/bin/env node
// One door for the script and the LLM: `c64re scenario run --json` and the MCP tool `runtime_feature_run` run the
// same file through the same code and say the same thing.
//
//   S5  script and LLM get the same answer   the verdicts and the side effects are identical, so is the text; the
//                                            command line exits 0 when a variant passed, 1 when none did, 2 on a line
//                                            that does not parse or when every run failed to run
//
// Real daemons of this run's own, a TMPDIR of the run's own (removed on exit), a test program built here, fixes assembled
// by the project's assembler (64tass; SKIPS LOUDLY without it).
//   Locally:  C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:911-door
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, ROOT, findDaemon, load, makeChecker, sleep } from "./lib/e2e-906-harness.mjs";
import { jsonOf, liveMachines, privateTmp, runCli } from "./lib/e2e-911-env.mjs";
import { hex4, pollPrg, writeFixes } from "./lib/e2e-911-fixtures.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-911-door");
const { check, head } = T;

const DAEMON = await findDaemon();
if (!DAEMON) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED — no trx64-daemon binary (set C64RE_RUNTIME_BIN, or `c64re runtime install`). Skipped, NOT passed.");
  process.exit(0);
}
const { find64tassBinary } = await load("assemble-source.js");
if (!find64tassBinary()) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and 64tass was not found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED — 64tass not found (put it on PATH). Skipped, NOT passed.");
  process.exit(0);
}
process.env.C64RE_RUNTIME_BIN = DAEMON;
const tmp = privateTmp("c64re-911-door-");
console.log(`runtime: ${DAEMON}\nTMPDIR:  ${tmp.dir}\n`);

const H = new Harness("h-");
const { prg, poll } = pollPrg();
const lines = (...l) => [...l, ""].join("\n");
/** What two answers must agree on: the verdicts, the checks and the side effects of every run. */
const gist = (res) => JSON.stringify(res.results.map((r) => ({
  scenario: r.scenario, verdict: r.verdict,
  runs: (r.runs ?? []).map((x) => ({ name: x.name, verdict: x.verdict, reason: x.reason, checks: x.checks.map((c) => [c.text, c.pass, c.actual]), sideEffects: x.sideEffects ?? null })),
  candidate: r.candidate,
})));

try {
  const proj = await H.project("proj");
  mkdirSync(join(proj, "media"), { recursive: true });
  mkdirSync(join(proj, "scenarios"), { recursive: true });
  writeFileSync(join(proj, "media", "poll.prg"), prg);
  writeFixes(proj);
  const sc = (n) => join(proj, "scenarios", n);
  const m = await H.mcp(proj, { env: { C64RE_FULL_TOOLS: "1", C64RE_SLOT_GATE: "0" } });
  const gated = await H.mcp(proj, { env: { C64RE_FULL_TOOLS: "1" } });

  writeFileSync(sc("make.feature"), lines(
    "Scenario: boot to the waiting loop",
    '  Given the medium "../media/poll.prg"',
    `  When I wait until the CPU reaches ${hex4(poll)} within 600 frames`,
    '  And I set the anchor "a2"',
    `  Then the CPU is at ${hex4(poll)}`,
  ));
  check(runCli([sc("make.feature")]).code === 0, "setup: the anchor a2 is made by a feature");

  head("S5  the same file, the command line and the tool");
  check(m.tools.some((t) => t.name === "runtime_feature_run"), "runtime_feature_run is on the tool surface");
  const desc = m.desc("runtime_feature_run");
  check(/variant/.test(desc) && /Given the mark/.test(desc) && /never build your own/i.test(desc), "…and its description tells the loop: the mark, the variant lines, no stepper of your own");

  writeFileSync(sc("pass.feature"), lines(
    "Feature: a fix passes",
    "Scenario: the lift",
    '  Given the mark "a2"',
    '  And variant "fix1" assembles "../fixes/fix1.tas" at $C100',
    '  And variant "fix2" assembles "../fixes/fix2.tas" at $C100',
    "  When I hold joystick 2 down for 5 frames",
    "  And I wait 2 frames",
    "  Then $C300 is $77",
  ));
  const cli = runCli([sc("pass.feature"), "--json"]);
  const cliJson = jsonOf(cli.stdout);
  const viaTool = JSON.parse(await m.call("runtime_feature_run", { feature_path: "scenarios/pass.feature", json: true }));
  check(cli.code === 0 && cliJson.exitCode === 0, "the command line exits 0: a variant passed", `${cli.code}`);
  check(gist(cliJson) === gist(viaTool), "the tool's JSON and the command line's carry the same verdicts, checks and side effects", `${gist(cliJson).slice(0, 300)}\n${gist(viaTool).slice(0, 300)}`);
  check(viaTool.exitCode === 0 && viaTool.results[0].runs.map((r) => `${r.name}:${r.verdict}`).join(" ") === "baseline:FAIL fix1:PASS fix2:FAIL", "…fix1 passes, fix2 and the baseline do not", viaTool.results[0].runs.map((r) => `${r.name}:${r.verdict}`).join(" "));
  const text1 = runCli([sc("pass.feature")]).stdout.trim();
  const text2 = (await m.call("runtime_feature_run", { feature_path: sc("pass.feature") })).trim();
  check(text1 === text2 && text1.includes("→ candidate"), "the text the tool returns is the text the command line prints", `${text1.slice(0, 200)}\n---\n${text2.slice(0, 200)}`);
  const inline = await m.call("runtime_feature_run", { feature: readFileSync(sc("pass.feature"), "utf8").replace("Scenario: the lift", "Scenario: the lift, passed as text").replaceAll('"../fixes/', '"fixes/') });
  check(/PASS\s+fix1/.test(inline), "the file's text can be passed instead of a path", inline.slice(0, 300));
  check(/give feature_path or feature/.test(await m.call("runtime_feature_run", {}).catch((e) => String(e))), "neither a path nor a text is refused by name");

  const refused = await gated.call("runtime_feature_run", { feature_path: sc("pass.feature") });
  check(/runtime_feature_run refused/.test(refused) && /free-ram/.test(refused), "a fix allocates memory: the slot gate that guards the other doors guards this one when the file has variants", refused.slice(0, 200));
  const plainViaGate = await gated.call("runtime_feature_run", { feature_path: sc("make.feature"), scenario: "nothing matches this" });
  check(!/refused/.test(plainViaGate), "…and a file without variants is not gated", plainViaGate.slice(0, 200));

  head("S5  the exit code");
  writeFileSync(sc("nopass.feature"), lines(
    "Scenario: no fix works",
    '  Given the mark "a2"',
    '  And variant "fix2" assembles "../fixes/fix2.tas" at $C100',
    "  When I hold joystick 2 down for 5 frames",
    "  And I wait 2 frames",
    "  Then $C300 is $77",
  ));
  const np = runCli([sc("nopass.feature")]);
  check(np.code === 1 && /FAIL\s+fix2/.test(np.stdout), "no variant passes: exit 1", `${np.code} ${np.stdout.slice(0, 300)}`);
  writeFileSync(sc("parse.feature"), lines(
    "Scenario: a line that is not one",
    '  Given the mark "a2"',
    '  And variant "fix1" assembles at $C100',
    "  When I wait 2 frames",
    "  Then $C300 is $77",
  ));
  const pe = runCli([sc("parse.feature")]);
  check(pe.code === 2 && /PARSE/.test(pe.stdout) && /a variant is/.test(pe.stdout), "a line that does not parse: exit 2, the line and the form it should have", `${pe.code} ${pe.stdout.slice(0, 300)}`);
  writeFileSync(sc("error.feature"), lines(
    "Scenario: the medium is not there",
    '  Given the disk "../media/nothing.prg"',
    "  When I wait 2 frames",
    "  Then $C300 is $77",
  ));
  const er = runCli([sc("error.feature")]);
  check(er.code === 2 && /ERROR/.test(er.stdout), "every run failing to run: exit 2", `${er.code} ${er.stdout.slice(0, 300)}`);
  const plain = runCli([sc("make.feature"), "--replace-anchors"]);
  check(plain.code === 0, "a scenario without variants passing: exit 0, as before", `${plain.code}`);
  writeFileSync(sc("plainfail.feature"), lines(
    "Scenario: no variants, a failing Then",
    '  Given the mark "a2"',
    "  When I wait 2 frames",
    "  Then $C000 is $55",
  ));
  check(runCli([sc("plainfail.feature")]).code === 1, "…and failing: exit 1");
} catch (e) {
  check(false, "script ran", String((e && e.stack) || e));
} finally {
  H.stopMcps();
  H.cleanup();
}
for (let i = 0; i < 40 && liveMachines(tmp.dir).length > 0; i++) await sleep(250);
check(liveMachines(tmp.dir).length === 0, "no machine of this run is left running");
process.exit(T.done());
