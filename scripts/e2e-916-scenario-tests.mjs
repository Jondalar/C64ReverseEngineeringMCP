#!/usr/bin/env node
// A scenario tests the build: built bytes are loaded into a start state and judged strictly.
//
//   S1  `loads`                a PRG at its own address, a PRG with `at` (header skipped), a raw .bin with `at`; a raw file
//                              without `at` refused with the reason; a missing file refused; the bytes in memory (and in the
//                              candidate record) are the file's, without a PRG's two header bytes
//   S2  `loads` into a bank    `roml bank 3 $9100` on a synthetic EasyFlash image made here: the bank shows the bytes, the baseline not
//   S3  test mode              build passes + baseline fails: PASS; build fails: FAIL naming the check; baseline passes under
//                              `fails`: FAIL "cannot see the change"; two variants, one failing: FAIL; `passes` honoured; a test
//                              without a variant: parse error, exit 2; no candidate is kept
//   S4  trial mode unchanged   one passing variant of two is PASS, the candidate is kept, and a candidate whose target was loaded
//                              (no source) is listed, chosen, derived (saying so) and verified
//   S5  a suite                a folder of tests from one anchor made by a scenario, run twice on fresh daemons: identical
//                              verdicts and JSON (timings aside)
//   S6  the surface            the tool description and `scenario run --help` name the forms; the doctrine rule and the wiki page exist
//
// Real daemons of this run's own, a TMPDIR of the run's own (removed on exit); programs, cartridge and "builds" are made here
// byte by byte. No third-party bytes.
//   Locally:  C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:916-scenario-tests
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, ROOT, findDaemon, load, makeChecker, sleep } from "./lib/e2e-906-harness.mjs";
import { jsonOf, liveMachines, privateTmp, runCli } from "./lib/e2e-911-env.mjs";
import { efCrt, hex4, pollPrg } from "./lib/e2e-911-fixtures.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-916-scenario-tests");
const { check, head } = T;

const DAEMON = await findDaemon();
if (!DAEMON) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED — no trx64-daemon binary (set C64RE_RUNTIME_BIN, or `c64re runtime install`). Skipped, NOT passed.");
  process.exit(0);
}
process.env.C64RE_RUNTIME_BIN = DAEMON;
const tmp = privateTmp("c64re-916-tests-");
console.log(`runtime: ${DAEMON}\nTMPDIR:  ${tmp.dir}\n`);

const H = new Harness("h-");
const { prg, poll } = pollPrg();
const lines = (...l) => [...l, ""].join("\n");
const store = await load("candidates/store.js");
const { ProjectKnowledgeService } = await load("project-knowledge/service.js");

// "Builds": what a real build would leave behind. GOOD stores $77 in $C300 and returns; BAD stores $78; NOP is an RTS.
const GOOD = [0xa9, 0x77, 0x8d, 0x00, 0xc3, 0x60];
const BAD = [0xa9, 0x78, 0x8d, 0x00, 0xc3, 0x60];
const NOP = [0x60];
const ROMFIX = [0xa9, 0x55, 0x8d, 0x11, 0x03, 0x60];
const withHeader = (addr, body) => Buffer.from([addr & 0xff, addr >> 8, ...body]);
const sha = (body) => createHash("sha256").update(Buffer.from(body)).digest("hex");
const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "elapsedMs" ? undefined : x)));

const BUILD = `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const w = JSON.parse(readFileSync("wired.json", "utf8"));
mkdirSync("out", { recursive: true });
const lo = Math.min(...w.parts.map((p) => p.addr)), hi = Math.max(...w.parts.map((p) => p.addr + p.bytes.length));
const img = new Uint8Array(hi - lo).fill(0xaa);
for (const p of w.parts) img.set(p.bytes, p.addr - lo);
writeFileSync("out/game.prg", Buffer.from([lo & 255, lo >> 8, ...img]));
`;

try {
  const proj = await H.project("proj");
  for (const d of ["media", "scenarios", "build", "tests", "out"]) mkdirSync(join(proj, d), { recursive: true });
  writeFileSync(join(proj, "media", "poll.prg"), prg);
  writeFileSync(join(proj, "media", "game.crt"), efCrt());
  writeFileSync(join(proj, "build.mjs"), BUILD);
  const b = (name, data) => writeFileSync(join(proj, "build", name), data);
  b("good.prg", withHeader(0xc100, GOOD));
  b("good.bin", Buffer.from(GOOD));
  b("bad.bin", Buffer.from(BAD));
  b("nop.bin", Buffer.from(NOP));
  b("fakehdr.prg", withHeader(0x1234, GOOD));
  b("romfix.bin", Buffer.from(ROMFIX));
  const sc = (n) => join(proj, "scenarios", n);
  const run = (file, extra = []) => runCli([file, ...extra]);
  const runJson = (file) => { const r = runCli([file, "--json"]); return { ...r, j: jsonOf(r.stdout) }; };
  const runs = (res) => Object.fromEntries((res.runs ?? []).map((r) => [r.name, r]));

  writeFileSync(sc("make.feature"), lines(
    "Feature: the start state",
    "Scenario: boot to the waiting loop",
    '  Given the medium "../media/poll.prg"',
    `  When I wait until the CPU reaches ${hex4(poll)} within 600 frames`,
    '  And I set the anchor "a2"',
    `  Then the CPU is at ${hex4(poll)}`,
  ));
  check(run(sc("make.feature")).code === 0 && existsSync(join(proj, "knowledge", "anchors", "a2.c64re")), "setup: the anchor a2 is made by a scenario");

  const press = ["  When I hold joystick 2 down for 5 frames", "  And I wait 2 frames"];
  const body = (header) => [`Scenario: ${header.name}`, '  Given the mark "a2"', ...header.variants, "  Then $C100 is $A9 $77 $8D $00 $C3 $60", ...press, "  Then $C300 is $77", ...(header.extra ?? [])];

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S1  loads");
  writeFileSync(sc("loads.feature"), lines(
    "Feature: built bytes are loaded",
    ...body({ name: "a PRG at its own address", variants: ['  And variant "build" loads "../build/good.prg"'] }),
    "",
    ...body({ name: "a PRG placed elsewhere, header skipped", variants: ['  And variant "build" loads "../build/fakehdr.prg" at $C100'] }),
    "",
    ...body({ name: "raw bytes with an address", variants: ['  And variant "build" loads "../build/good.bin" at $C100'] }),
  ));
  const s1 = runJson(sc("loads.feature"));
  console.log(`  (the command line said)\n${run(sc("loads.feature")).stdout.split("\n").map((l) => `    ${l}`).join("\n")}`);
  check(s1.j.results.length === 3 && s1.code === 0, "S1: three scenarios, all PASS, exit 0", `${s1.code} ${s1.j.results.map((r) => r.verdict)}`);
  for (const r of s1.j.results) {
    const x = runs(r);
    const pat = (n) => (x[n]?.checks ?? []).map((c) => (c.pass ? "P" : "f")).join("");
    check(pat("build") === "PP" && pat("baseline") === "ff", `…"${r.scenario}": the bytes are at $C100 before the first step and they run; the baseline has neither`, `${pat("build")}/${pat("baseline")}`);
  }
  const cands = store.listCandidates(proj);
  const goodSha = sha(GOOD);
  check(cands.length === 3 && cands.every((c) => c.variants[0].targets[0].bytes.join() === GOOD.join() && c.variants[0].targets[0].addr === 0xc100), "…the record holds the file's bytes without a PRG's header, at $C100 in all three", JSON.stringify(cands.map((c) => c.variants[0].targets[0].bytes)));
  check(cands.every((c) => c.variants[0].targets[0].loaded?.sha256 === goodSha && c.variants[0].targets[0].source === ""), "…a loaded target carries its path and the sha256 of the bytes, and no source text", JSON.stringify(cands[0].variants[0].targets[0]).slice(0, 300));
  check(cands.some((c) => c.variants[0].targets[0].loaded.path === "build/fakehdr.prg"), "…the path is the project's own (relative)", cands.map((c) => c.variants[0].targets[0].loaded.path).join());

  writeFileSync(sc("noat.feature"), lines(
    "Scenario: raw bytes without an address",
    '  Given the mark "a2"',
    '  And variant "build" loads "../build/good.bin"',
    ...press, "  Then $C300 is $77",
  ));
  const noat = run(sc("noat.feature"));
  check(noat.code === 2 && /PARSE/.test(noat.stdout) && /not a \.prg/.test(noat.stdout) && /none is guessed/.test(noat.stdout) && /at \$/.test(noat.stdout), "S1: a raw file without `at` is refused at parse time, with the reason (exit 2)", noat.stdout);

  writeFileSync(sc("missing.feature"), lines(
    "Scenario: a file that is not there",
    '  Given the mark "a2"',
    '  And variant "build" loads "../build/not-built.prg"',
    ...press, "  Then $C300 is $77",
  ));
  const missing = runJson(sc("missing.feature"));
  check(missing.code === 2 && missing.j.results[0].verdict === "ERROR" && /no such file/.test(missing.j.results[0].reason) && /not-built\.prg/.test(missing.j.results[0].reason), "S1: a missing file is refused, naming it (ERROR, exit 2)", JSON.stringify(missing.j.results[0]));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S2  loads into a cartridge bank");
  writeFileSync(sc("cartboot.feature"), lines(
    "Feature: boot the cartridge",
    "Scenario: boot to its loop",
    '  Given the cart "../media/game.crt"',
    "  When I wait until the CPU reaches $9000 within 60 frames",
    '  And I set the anchor "cartup"',
    "  Then the CPU is at $9000",
  ));
  check(run(sc("cartboot.feature")).code === 0 && existsSync(join(proj, "knowledge", "anchors", "cartup.c64re")), "setup: the cartridge boots to its loop and the anchor cartup is made");
  writeFileSync(sc("cart.feature"), lines(
    "Feature: a build in a bank",
    "Scenario: the bank holds the build",
    '  Given the mark "cartup"',
    '  And variant "build" loads "../build/romfix.bin" at roml bank 3 $9100',
    "  Then $9100 is $A9 $55 $8D $11 $03 $60",
    "  When I wait 5 frames",
    "  Then $0311 is $55",
    "  And the baseline fails",
  ));
  const s2 = runJson(sc("cart.feature"));
  const s2r = runs(s2.j.results[0]);
  const s2pat = (n) => (s2r[n]?.checks ?? []).map((c) => (c.pass ? "P" : "f")).join("");
  check(s2pat("build") === "PP" && s2pat("baseline") === "ff", "S2: the bank shows the bytes at $9100 before the first step, and they run; the baseline does not", `${s2pat("build")}/${s2pat("baseline")}`);
  check(s2.j.results[0].verdict === "PASS" && s2.j.results[0].mode === "test" && s2.code === 0, "…the test is PASS (mode test), exit 0", `${s2.j.results[0].verdict} ${s2.j.results[0].mode} ${s2.code}`);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S3  test mode");
  const before = store.listCandidates(proj).length;
  const test = (name, variants, thens, expect) => lines(
    "Feature: test mode", `Scenario: ${name}`, '  Given the mark "a2"', ...variants, ...press, ...thens, ...(expect ? [`  Then the baseline ${expect}`] : []),
  );
  const one = (file, text) => { writeFileSync(sc(file), text); return runJson(sc(file)); };

  const t1 = one("t1.feature", test("build good", ['  And variant "build" loads "../build/good.bin" at $C100'], ["  Then $C300 is $77"], "fails"));
  check(t1.j.results[0].verdict === "PASS" && t1.j.results[0].mode === "test" && t1.code === 0 && !t1.j.results[0].candidate, "S3: build passes + baseline fails: PASS, mode test, exit 0, no candidate", JSON.stringify(strip(t1.j.results[0])).slice(0, 400));
  check(runs(t1.j.results[0]).baseline?.verdict === "FAIL" && runs(t1.j.results[0]).baseline?.expected === "fails", "…the baseline's own run is a FAIL, marked as required to fail", JSON.stringify(runs(t1.j.results[0]).baseline).slice(0, 300));

  const t2 = one("t2.feature", test("build bad", ['  And variant "build" loads "../build/bad.bin" at $C100'], ["  Then $C300 is $77"], "fails"));
  const t2t = run(sc("t2.feature")).stdout;
  check(t2.j.results[0].verdict === "FAIL" && t2.code === 1, "S3: the build fails: FAIL, exit 1", `${t2.j.results[0].verdict} ${t2.code}`);
  check(/build failed/.test(t2.j.results[0].reason) && /\$C300 is \$77/.test(t2.j.results[0].reason) && /got/.test(t2.j.results[0].reason) && !/baseline should/.test(t2.j.results[0].reason), "…the reason names the build and the check that failed, not the baseline", t2.j.results[0].reason);
  check(/FAIL/.test(t2t) && /build failed/.test(t2t), "…and the command line prints it", t2t);

  const t3 = one("t3.feature", test("start state already shows it", ['  And variant "build" loads "../build/nop.bin" at $C100'], ["  Then $C000 is $01"], "fails"));
  check(t3.j.results[0].verdict === "FAIL" && t3.code === 1 && /baseline should fail but passed/.test(t3.j.results[0].reason) && /cannot see the change/.test(t3.j.results[0].reason), "S3: the baseline passes under `Then the baseline fails`: FAIL, \"cannot see the change\"", t3.j.results[0].reason);
  check(runs(t3.j.results[0]).build?.verdict === "PASS", "…and the build's own run is shown as the PASS it was (the baseline line is no check on the variants)", JSON.stringify(runs(t3.j.results[0]).build?.verdict));

  const t4 = one("t4.feature", test("two builds, one bad", ['  And variant "good" loads "../build/good.bin" at $C100', '  And variant "bad" loads "../build/bad.bin" at $C100'], ["  Then $C300 is $77"], "fails"));
  check(t4.j.results[0].verdict === "FAIL" && /bad failed/.test(t4.j.results[0].reason) && !/good failed/.test(t4.j.results[0].reason) && runs(t4.j.results[0]).good?.verdict === "PASS", "S3: two variants, one failing: FAIL, naming the failing one only", t4.j.results[0].reason);

  const t5 = one("t5.feature", test("baseline must pass", ['  And variant "build" loads "../build/nop.bin" at $C100'], ["  Then $C000 is $01"], "passes"));
  check(t5.j.results[0].verdict === "PASS" && t5.code === 0 && runs(t5.j.results[0]).baseline?.expected === "passes", "S3: `Then the baseline passes` is honoured (baseline and build both pass: PASS)", JSON.stringify(strip(t5.j.results[0])).slice(0, 300));
  const t5b = one("t5b.feature", test("baseline must pass but fails", ['  And variant "build" loads "../build/good.bin" at $C100'], ["  Then $C300 is $77"], "passes"));
  check(t5b.j.results[0].verdict === "FAIL" && /baseline should pass but failed/.test(t5b.j.results[0].reason), "…and a baseline that fails under `passes` is a FAIL saying so", t5b.j.results[0].reason);

  writeFileSync(sc("t6.feature"), test("no variant", [], ["  Then $C300 is $77"], "fails"));
  const t6 = run(sc("t6.feature"));
  check(t6.code === 2 && /PARSE/.test(t6.stdout) && /no variant/.test(t6.stdout) && /nothing to compare/.test(t6.stdout), "S3: a test without a variant is a parse error, exit 2", t6.stdout);
  writeFileSync(sc("t7.feature"), test("both lines", ['  And variant "build" loads "../build/good.bin" at $C100'], ["  Then $C300 is $77", "  And the baseline passes"], "fails"));
  const t7 = run(sc("t7.feature"));
  check(t7.code === 2 && /cannot both fail and pass/.test(t7.stdout), "…and so is a baseline that must both fail and pass", t7.stdout);
  check(store.listCandidates(proj).length === before, "S3: no test kept a candidate", `${before} -> ${store.listCandidates(proj).length}`);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S4  trial mode unchanged");
  const shared = await H.daemon(DAEMON, proj);
  const m = await H.mcp(proj, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1", C64RE_SLOT_GATE: "0" } });
  new ProjectKnowledgeService(proj).saveProjectProfile({ build: { command: "node build.mjs", outputs: ["out/game.prg"] } });
  writeFileSync(sc("trial.feature"), lines(
    "Feature: a trial",
    "Scenario: two builds to choose between",
    '  Given the mark "a2"',
    '  And variant "good" loads "../build/good.bin" at $C100',
    '  And variant "bad" loads "../build/bad.bin" at $C100',
    ...press, "  Then $C300 is $77",
  ));
  const s4 = runJson(sc("trial.feature"));
  const tr = s4.j.results[0];
  check(tr.verdict === "PASS" && tr.mode === "trial" && s4.code === 0 && runs(tr).bad?.verdict === "FAIL" && runs(tr).baseline?.verdict === "FAIL", "S4: a trial with one passing variant of two is PASS (mode trial), baseline and bad variant FAIL, exit 0", `${tr.verdict} ${tr.mode} ${s4.code}`);
  check(typeof tr.candidate === "string" && store.loadCandidate(proj, tr.candidate)?.variants.length === 2, "…and the candidate is kept", tr.candidate);

  const listed = await m.call("runtime_candidate_list", { id: tr.candidate });
  check(/variant "good"/.test(listed) && /loaded from build\/good\.bin/.test(listed) && new RegExp(goodSha.slice(0, 12)).test(listed) && /no source/.test(listed), "S4: a candidate whose target has no source is listed in full, saying where the bytes came from", listed);
  check(/"good" chosen/.test(await m.call("runtime_candidate_choose", { id: tr.candidate, variant: "good" })), "…chosen");
  const dd = await m.call("runtime_candidate_derive_delta", { id: tr.candidate });
  const asm = readFileSync(join(proj, `delta-${tr.candidate}`, "patch_0_ram_c100.asm"), "utf8");
  check(/Delta of "good" written/.test(dd) && /loaded as built bytes/.test(dd) && /no source to hand over/.test(dd) && dd.includes(goodSha) && /\.byte \$a9,\$77,\$8d,\$00,\$c3,\$60/.test(asm), "…its delta says plainly there is no source, names the file and the sha256, and holds the bytes", `${dd}\n${asm}`);
  writeFileSync(join(proj, "wired.json"), JSON.stringify({ parts: [{ addr: 0xc100, bytes: GOOD }] }));
  const green = await m.call("runtime_candidate_verify_build", { id: tr.candidate });
  check(/^GREEN/.test(green) && /ram \$c100  6 byte\(s\)  ok/.test(green), "…and verify_build is GREEN on a build that holds the bytes", green);
  writeFileSync(join(proj, "wired.json"), JSON.stringify({ parts: [{ addr: 0xc100, bytes: BAD }] }));
  check(/^RED/.test(await m.call("runtime_candidate_verify_build", { id: tr.candidate })), "…and RED on one that does not");
  const viaTool = await m.call("runtime_feature_run", { feature_path: "scenarios/t1.feature", json: true });
  check(JSON.parse(viaTool.slice(viaTool.indexOf("{"))).results[0].mode === "test", "…the tool and the command line are one door: the same file gives mode test through runtime_feature_run");

  // The slot gate guards a fix DELIVERY. A test checks bytes the build already placed, so an engaged project
  // with an empty free-RAM slot refuses the trial and runs the test.
  {
    const { KnowledgeRecords } = await load("knowledge-graph/records.js");
    new KnowledgeRecords(proj).saveFinding({ kind: "observation", title: "stage 1 at $0801", addressRange: { start: 0x0801, end: 0x08ff } });
    const gated = await H.mcp(proj, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
    const trialOut = await gated.call("runtime_feature_run", { feature_path: "scenarios/trial.feature" });
    check(/slot/i.test(trialOut) && !/PASS/.test(trialOut), "S4: with the slot gate on, an engaged project refuses the trial (a fix delivery)", trialOut.split("\n")[0]);
    const testOut = await gated.call("runtime_feature_run", { feature_path: "scenarios/t1.feature", json: true });
    check(testOut.includes("{") && JSON.parse(testOut.slice(testOut.indexOf("{"))).results[0].mode === "test", "…and runs the test: a test is not a delivery", testOut.split("\n")[0]);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S5  a suite");
  const tests = join(proj, "tests");
  const suite = {
    "01-good.feature": test("good build", ['  And variant "build" loads "../build/good.bin" at $C100'], ["  Then $C300 is $77"], "fails"),
    "02-bad.feature": test("bad build", ['  And variant "build" loads "../build/bad.bin" at $C100'], ["  Then $C300 is $77"], "fails"),
    "03-blind.feature": test("blind test", ['  And variant "build" loads "../build/nop.bin" at $C100'], ["  Then $C000 is $01"], "fails"),
    "04-two.feature": test("two builds", ['  And variant "a" loads "../build/good.prg"', '  And variant "b" loads "../build/fakehdr.prg" at $C100'], ["  Then $C300 is $77"], "fails"),
    "05-pass.feature": test("must keep passing", ['  And variant "build" loads "../build/nop.bin" at $C100'], ["  Then $C000 is $01"], "passes"),
  };
  for (const [n, t] of Object.entries(suite)) writeFileSync(join(tests, n), t);
  const first = runCli([tests, "--json"]);
  const second = runCli([tests, "--json"]);
  const a = strip(jsonOf(first.stdout)), c = strip(jsonOf(second.stdout));
  const verdicts = a.results.map((r) => `${r.scenario}=${r.verdict}`).join(", ");
  check(a.results.length === 5 && verdicts === "good build=PASS, bad build=FAIL, blind test=FAIL, two builds=PASS, must keep passing=PASS", "S5: a folder of five tests gives the verdicts the files say", verdicts);
  check(first.code === 1 && second.code === 1, "…exit 1 while one fails", `${first.code}/${second.code}`);
  check(JSON.stringify(a) === JSON.stringify(c), "…run twice on fresh daemons: identical verdicts and JSON (timings aside)", `${JSON.stringify(a).length} vs ${JSON.stringify(c).length}`);
  check(store.listCandidates(proj).length === 4, "…and the suite kept no candidate (the 4 are the earlier trials)", String(store.listCandidates(proj).length));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S6  the surface");
  const desc = m.desc("runtime_feature_run");
  for (const [what, re] of [
    ["the test use", /TEST A BUILD/], ["the snapshot start", /Given the snapshot/], ["a PRG load", /loads \\"build\/trainer\.prg\\"|loads "build\/trainer\.prg"/],
    ["`at`", /loads .{0,6}build\/patch\.bin.{0,6} at \$47A5/], ["a bank", /at roml bank 3 \$8000/], ["both baseline lines", /baseline fails.*baseline passes/s],
    ["the whole folder", /WHOLE folder/], ["mode", /`mode`/],
  ]) check(re.test(desc), `runtime_feature_run's description names ${what}`, desc.slice(0, 300));
  const help = runCli(["--help"]);
  const helpText = help.stdout + help.stderr;
  for (const [what, re] of [
    ["a PRG load", /loads "build\/trainer\.prg"\s/], ["a PRG with at", /trainer\.prg" at \$0900/], ["raw with at", /loads "build\/patch\.bin" at \$47A5/], ["a bank", /roml bank 3 \$8000/],
    ["the baseline lines", /Then the baseline fails[\s\S]*Then the baseline passes/], ["what PASS means in a test", /EVERY variant passes/], ["what PASS means in a trial", /ANY variant passes/],
    ["the snapshot start", /Given the snapshot/], ["the checkout form", /node <checkout>\/dist\/cli\.js scenario run/],
  ]) check(re.test(helpText), `\`scenario run --help\` names ${what}`, helpText.slice(0, 300));
  const doctrine = readFileSync(join(ROOT, "docs/agent-doctrine.md"), "utf8");
  check(/A change to prove after a build\? A test scenario/.test(doctrine) && /never a hand-driven\s+sandbox session/.test(doctrine) && /Then the baseline fails/.test(doctrine), "the doctrine rule exists beside the fix loop");
  check(doctrine.indexOf("A change to prove after a build?") > doctrine.indexOf("A fix to try? A feature file runs it") && doctrine.indexOf("A change to prove after a build?") < doctrine.indexOf("The game's structure? Map it"), "…placed right after the fix-loop rule");
  const wiki = join(ROOT, "docs/wiki/Testing-a-Build.md");
  check(existsSync(wiki) && /loads "build\/trainer\.prg"/.test(readFileSync(wiki, "utf8")) && /Then the baseline fails/.test(readFileSync(wiki, "utf8")) && /\(Testing-a-Build\)/.test(readFileSync(join(ROOT, "docs/wiki/Home.md"), "utf8")), "the wiki page Testing a Build exists, shows the forms, and the Home page links it");
  check(!/\b9\d\d\b/.test(readFileSync(wiki, "utf8").replace(/\$[0-9A-Fa-f]+/g, "")), "…and cites no spec number");
} catch (e) {
  check(false, "script ran", String((e && e.stack) || e));
} finally {
  H.stopMcps();
  H.cleanup();
}
for (let i = 0; i < 40 && liveMachines(tmp.dir).length > 0; i++) await sleep(250);
check(liveMachines(tmp.dir).length === 0, "no machine of this run is left running");
process.exit(T.done());
