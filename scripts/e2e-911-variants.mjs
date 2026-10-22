#!/usr/bin/env node
// Fixes in the file, beside the baseline, judged by the Then lines.
//
//   S2  variants run beside the baseline, in parallel   a cartridge image with a RAM fix, a cartridge-bank fix and both:
//                                                       four results, each from a machine of its own, at most four
//                                                       alive at once, each variant's bytes in its machine at the
//                                                       stated address before the first step
//   S3  the stop is a condition, not a cycle count      `wait until the CPU reaches $C102 within 30 frames` holds for
//                                                       the fixes and not for the baseline: that one is FAIL "not
//                                                       within 30 frames"; the fix that gets there goes on to its Then
//   S4  Then decides; the diff only informs             a fix that passes and changes other memory is PASS with the
//                                                       other places listed; a variant no different from the baseline
//                                                       with a failing Then is FAIL
//
// Real daemons of this run's own, a TMPDIR of the run's own (removed on exit), a test program and a test cartridge
// built here, fixes assembled by the project's assembler (64tass; SKIPS LOUDLY without it).
//   Locally:  C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:911-variants
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, ROOT, findDaemon, load, makeChecker, sleep } from "./lib/e2e-906-harness.mjs";
import { jsonOf, liveMachines, privateTmp, runCli, runCliAsync } from "./lib/e2e-911-env.mjs";
import { efCrt, hex4, pollPrg, writeFixes } from "./lib/e2e-911-fixtures.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-911-variants");
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
const tmp = privateTmp("c64re-911-variants-");
console.log(`runtime: ${DAEMON}\nTMPDIR:  ${tmp.dir}\n`);

const H = new Harness("h-");
const { prg, poll } = pollPrg();
const lines = (...l) => [...l, ""].join("\n");

try {
  const proj = await H.project("proj");
  mkdirSync(join(proj, "media"), { recursive: true });
  mkdirSync(join(proj, "scenarios"), { recursive: true });
  writeFileSync(join(proj, "media", "poll.prg"), prg);
  writeFileSync(join(proj, "media", "game.crt"), efCrt());
  writeFixes(proj);
  const sc = (n) => join(proj, "scenarios", n);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S2  variants run beside the baseline, in parallel");
  // A cartridge starts at its reset vector, at cycle 0, and its boot code (the trampoline) writes the RAM hook itself and
  // selects bank 3. A fix patched in at cycle 0 would be overwritten by that boot code and would land in bank 0, so the
  // cartridge is booted first, into an anchor, and the variants start from the booted machine.
  writeFileSync(sc("cartboot.feature"), lines(
    "Feature: boot the cartridge",
    "Scenario: boot to its loop",
    '  Given the cart "../media/game.crt"',
    "  When I wait until the CPU reaches $9000 within 60 frames",
    '  And I set the anchor "cartup"',
    "  Then the CPU is at $9000",
  ));
  const booted = runCli([sc("cartboot.feature")]);
  check(booted.code === 0 && existsSync(join(proj, "knowledge", "anchors", "cartup.c64re")), "the cartridge boots to its loop from cycle 0 and the anchor cartup is made", booted.stdout.slice(0, 300));
  writeFileSync(sc("cart.feature"), lines(
    "Feature: fixes in RAM and in a cartridge bank",
    "Scenario: three fixes beside the baseline",
    '  Given the mark "cartup"',
    '  And variant "ramfix" assembles "../fixes/ramfix.tas" at $0A20',
    '  And variant "romfix" assembles "../fixes/romfix.tas" at roml bank 3 $9100',
    '  And variant "both" assembles "../fixes/ramfix.tas" at $0A20',
    '  And variant "both" assembles "../fixes/romfix.tas" at roml bank 3 $9100',
    "  Then $0A20 is $A9 $2A $8D $10 $03 $60",
    "  And $9100 is $A9 $55 $8D $11 $03 $60",
    "  When I wait 5 frames",
    "  Then $0310 is $2A",
    "  And $0311 is $55",
  ));
  const run2 = runCliAsync([sc("cart.feature"), "--json"]);
  let most = 0, polls = 0;
  let finished = false;
  run2.done.then(() => { finished = true; });
  while (!finished) { most = Math.max(most, liveMachines(tmp.dir).length); polls++; await sleep(60); }
  const out2 = await run2.done;
  const j2 = jsonOf(out2.stdout);
  const res2 = j2.results[0];
  const byName = Object.fromEntries((res2.runs ?? []).map((r) => [r.name, r]));
  console.log(`  (the command line said)\n${runCli([sc("cart.feature")]).stdout.split("\n").map((l) => `    ${l}`).join("\n")}`);
  check((res2.runs ?? []).map((r) => r.name).join(",") === "baseline,ramfix,romfix,both", "S2: four results come back — the baseline and the three variants, in the order written", (res2.runs ?? []).map((r) => r.name).join(","));
  check(most >= 2, `…they ran in parallel (${most} machines alive at once, looked at ${polls} times)`, String(most));
  check(most <= 4, "…and never more than four alive at once", String(most));
  const pat = (n) => (byName[n]?.checks ?? []).map((c) => (c.pass ? "P" : "f")).join("");
  check(pat("both") === "PPPP", "the variant with both fixes has its RAM bytes AND its bank bytes in the machine before the first step, and they run", pat("both"));
  check(pat("ramfix") === "PfPf", "the RAM fix has its bytes at $0A20 (and not at the cartridge address) before the first step", pat("ramfix"));
  check(pat("romfix") === "fPfP", "the bank fix has its bytes at $9100 in bank 3 (and not in RAM) before the first step", pat("romfix"));
  check(pat("baseline") === "ffff", "the baseline has neither", pat("baseline"));
  check(byName.baseline?.verdict === "FAIL" && byName.both?.verdict === "PASS" && res2.verdict === "PASS" && out2.code === 0, "…verdicts: baseline FAIL, the working variant PASS, the scenario PASS, exit 0", `${byName.baseline?.verdict}/${byName.both?.verdict}/${res2.verdict}/${out2.code}`);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("the anchor the next two start from (made by a feature, no session)");
  writeFileSync(sc("make.feature"), lines(
    "Feature: make an anchor",
    "Scenario: boot to the waiting loop",
    '  Given the medium "../media/poll.prg"',
    `  When I wait until the CPU reaches ${hex4(poll)} within 600 frames`,
    '  And I set the anchor "a2"',
    `  Then the CPU is at ${hex4(poll)}`,
  ));
  const made = runCli([sc("make.feature")]);
  check(made.code === 0 && existsSync(join(proj, "knowledge", "anchors", "a2.c64re")), "knowledge/anchors/a2.c64re exists", made.stdout.slice(0, 300));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S3  the stop is a condition, not a cycle count");
  writeFileSync(sc("stop.feature"), lines(
    "Feature: the stop is a condition",
    "Scenario: the fixes reach $C102, the baseline does not",
    '  Given the mark "a2"',
    '  And variant "fix1" assembles "../fixes/fix1.tas" at $C100',
    '  And variant "fix2" assembles "../fixes/fix2.tas" at $C100',
    "  When I start holding joystick 2 down",
    "  And I wait until the CPU reaches $C102 within 30 frames",
    "  And I release joystick 2",
    "  And I wait 2 frames",
    "  Then $C300 is $77",
  ));
  const s3 = runCli([sc("stop.feature"), "--json"]);
  const r3 = Object.fromEntries((jsonOf(s3.stdout).results[0].runs ?? []).map((r) => [r.name, r]));
  console.log(`  (the command line said)\n${runCli([sc("stop.feature")]).stdout.split("\n").map((l) => `    ${l}`).join("\n")}`);
  check(r3.baseline?.verdict === "FAIL" && /wait until the CPU reaches \$C102/.test(r3.baseline.reason) && /not within 30 frames/.test(r3.baseline.reason), "S3: the baseline is FAIL \"not within 30 frames\" — a FAIL of the wait, not an ERROR", r3.baseline?.reason);
  check(r3.baseline?.checks.length === 0, "…its Then line was never reached, so it did not run", String(r3.baseline?.checks.length));
  check(r3.fix1?.verdict === "PASS" && r3.fix1.checks.length === 1 && r3.fix1.checks[0].pass, "fix1 reaches the address and goes on to its Then line, which holds", JSON.stringify(r3.fix1?.checks));
  check(r3.fix2?.verdict === "FAIL" && r3.fix2.checks.length === 1 && /00/.test(r3.fix2.checks[0].actual), "fix2 reaches it too, and its Then line fails with what was there", JSON.stringify(r3.fix2?.checks));
  check(s3.code === 0, "…the file passes, because a variant did: exit 0", String(s3.code));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S4  Then decides; the difference to the baseline only informs");
  writeFileSync(sc("judge.feature"), lines(
    "Feature: the Then lines decide",
    "Scenario: one fix passes and does more, one is no different and fails",
    '  Given the mark "a2"',
    '  And variant "fix1" assembles "../fixes/fix1.tas" at $C100',
    '  And variant "noop" assembles "../fixes/noop.tas" at $C100',
    "  When I hold joystick 2 down for 5 frames",
    "  And I wait 2 frames",
    "  Then $C300 is $77",
  ));
  const s4 = runCli([sc("judge.feature"), "--json"]);
  const r4 = Object.fromEntries((jsonOf(s4.stdout).results[0].runs ?? []).map((r) => [r.name, r]));
  console.log(`  (the command line said)\n${runCli([sc("judge.feature")]).stdout.split("\n").map((l) => `    ${l}`).join("\n")}`);
  const eff = (n) => (r4[n]?.sideEffects ?? []).map((e) => `${e.space}:${e.from.toString(16)}-${e.to.toString(16)}`).join(" ");
  check(r4.fix1?.verdict === "PASS", "S4: fix1 is PASS", JSON.stringify(r4.fix1?.checks));
  check((r4.fix1?.sideEffects ?? []).some((e) => e.space === "ram" && e.from <= 0xc301 && e.to >= 0xc301) && (r4.fix1?.sideEffects ?? []).some((e) => e.space === "io" && e.from <= 0xd020 && e.to >= 0xd020), "…and the result lists the other changes as side effects: RAM at $C301 and the border register", eff("fix1"));
  check(!(r4.fix1?.sideEffects ?? []).some((e) => e.space === "ram" && e.from <= 0xc100 && e.to >= 0xc100), "…the variant's own bytes ($C100) are not among them", eff("fix1"));
  check(r4.noop?.verdict === "FAIL" && (r4.noop.sideEffects ?? []).length === 0, "a variant with no difference to the baseline but a failing Then is FAIL, with no side effects", `${r4.noop?.verdict} ${eff("noop")}`);
  check(r4.baseline?.verdict === "FAIL", "the baseline fails the same Then", r4.baseline?.verdict);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("a fix that does not assemble where it says");
  writeFileSync(sc("bad.feature"), lines(
    "Feature: wrong address",
    "Scenario: the source's own origin is not the target",
    '  Given the mark "a2"',
    '  And variant "fix1" assembles "../fixes/fix1.tas" at $C200',
    "  When I wait 2 frames",
    "  Then $C300 is $77",
  ));
  const s5 = runCli([sc("bad.feature"), "--json"]);
  const r5 = jsonOf(s5.stdout).results[0];
  check(r5.verdict === "ERROR" && /assembles at \$c100 but the target is \$c200/.test(r5.reason ?? ""), "the load address must equal the target: refused by name, no machine started", r5.reason);
} catch (e) {
  check(false, "script ran", String((e && e.stack) || e));
} finally {
  H.stopMcps();
  H.cleanup();
}
for (let i = 0; i < 40 && liveMachines(tmp.dir).length > 0; i++) await sleep(250);
check(liveMachines(tmp.dir).length === 0, "no machine of this run is left running");
process.exit(T.done());
