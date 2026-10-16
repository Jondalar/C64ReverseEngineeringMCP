#!/usr/bin/env node
// An anchor is a file in the project, and a feature can make one.
//
//   S1  an anchor outlives the ring   set on a sandbox session, the daemon ended, a new private machine started from the
//                                     file: registers, clock and all of RAM equal the state at the anchor; the file and the
//                                     graph node are in the project; drop deletes the file
//   S1b a feature makes the anchor    `wait until the CPU reaches …`, `And I set the anchor "a2"` with no session at all:
//                                     the file, its PC, the graph node; a second feature starts `Given the mark "a2"`;
//                                     an existing anchor is replaced only with --replace-anchors; a mark with no file is
//                                     SKIP and says so
//
// Real daemons of this run's own on free ports, a TMPDIR of the run's own (removed on exit), synthetic programs built
// here. It SKIPS LOUDLY when there is no trx64-daemon binary. Nothing here touches :4312 or the owner's session.
//   Locally:  C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:911-anchor
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, ROOT, findDaemon, load, makeChecker, pidAlive, sleep } from "./lib/e2e-906-harness.mjs";
import { jsonOf, liveMachines, privateTmp, runCli } from "./lib/e2e-911-env.mjs";
import { hex4, pollPrg } from "./lib/e2e-911-fixtures.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-911-anchor");
const { check, head } = T;

const DAEMON = await findDaemon();
if (!DAEMON) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED — no trx64-daemon binary (set C64RE_RUNTIME_BIN, or `c64re runtime install`). Skipped, NOT passed.");
  process.exit(0);
}
process.env.C64RE_RUNTIME_BIN = DAEMON;
const tmp = privateTmp("c64re-911-anchor-");
console.log(`runtime: ${DAEMON}\nTMPDIR:  ${tmp.dir}\n`);

const H = new Harness("h-");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const idOf = (s) => /\bsb-[a-z0-9-]+\b/.exec(s)?.[0];
const portOf = (s) => Number(/port (\d+)/.exec(s)?.[1] ?? 0);
const { runSandbox } = await load("reel/run-sandbox.js");
const { parseStep } = await load("project-knowledge/scenario-gherkin.js");
const { readAnchor } = await load("anchors/graph.js");
const { copyFileSync } = await import("node:fs");

const { prg, poll } = pollPrg();

try {
  const proj = await H.project("proj");
  mkdirSync(join(proj, "media"), { recursive: true });
  writeFileSync(join(proj, "media", "poll.prg"), prg);
  const shared = await H.daemon(DAEMON, proj);
  const m = await H.mcp(proj, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
  const sharedWs = await H.ws(shared.port);
  const sharedCycle = async () => (await sharedWs.call("session/state")).c64Cycles;
  const sharedBefore = await sharedCycle();

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S1  an anchor outlives the ring");
  const started = await m.call("runtime_sandbox_start", { purpose: "S1 an anchor that outlives its daemon", budget_minutes: 10, media_path: "media/poll.prg" });
  const sb = idOf(started);
  check(!!sb, "a sandbox session is started on the test program", started.slice(0, 200));
  await m.call("runtime_session_run", { session_id: sb, max_instructions: 600000 });
  const ws = await H.ws(portOf(started));
  const ram = async (c) => sha(JSON.stringify([
    await c.call("session/read_memory", { ranges: [{ addr: 0, len: 0x8000, lens: "ram" }] }).then((r) => r.chunks.map((x) => x.bytes)),
    await c.call("session/read_memory", { ranges: [{ addr: 0x8000, len: 0x8000, lens: "ram" }] }).then((r) => r.chunks.map((x) => x.bytes)),
  ]));
  const before = { st: await ws.call("session/state"), ram: await ram(ws) };
  check(before.st.cpu.pc >= 0x0800 && before.st.cpu.pc < 0x0900, "…and stands in the program's own code", hex4(before.st.cpu.pc));

  const set = await m.call("runtime_anchor_set", { name: "a1", why: "S1: the instant the test program waits for the stick", session_id: sb });
  const file = join(proj, "knowledge", "anchors", "a1.c64re");
  check(/ANCHOR a1 /.test(set) && existsSync(file), "runtime_anchor_set on the sandbox writes knowledge/anchors/a1.c64re into the project", set.slice(0, 400));
  check(/File knowledge\/anchors\/a1\.c64re written/.test(set), "…and says which file it wrote", set);
  const node = readAnchor(proj, "a1");
  check(node?.file === "knowledge/anchors/a1.c64re" && node.cycle === before.st.c64Cycles, "…the graph node names the file and the cycle", JSON.stringify(node));
  const again = await m.call("runtime_anchor_set", { name: "a1", session_id: sb });
  check(/not set|refused/.test(again), "setting the same name again is refused, not silently written over", again.slice(0, 200));
  const after = { st: await ws.call("session/state"), ram: await ram(ws) };
  check(JSON.stringify(after.st.cpu) === JSON.stringify(before.st.cpu) && after.st.c64Cycles === before.st.c64Cycles && after.ram === before.ram, "setting the anchor did not move the machine");
  const listed = await m.call("runtime_anchor_list", { session_id: sb });
  check(/a1 .*file: yes/.test(listed), "runtime_anchor_list shows that it has a file", listed);

  ws.close();
  await m.call("runtime_sandbox_end", { session_id: sb, outcome: "reached", summary: "S1: the anchor is set" });
  for (let i = 0; i < 40 && liveMachines(tmp.dir).length > 0; i++) await sleep(250);
  check(liveMachines(tmp.dir).length === 0, "the sandbox and its daemon are ended — the ring that held the anchor is gone", String(liveMachines(tmp.dir).length));
  check(existsSync(file), "…the anchor's file is still in the project");

  // a new private machine, from the file
  const scratch = join(tmp.dir, "from-a1"); mkdirSync(scratch, { recursive: true });
  const copy = join(scratch, "a1.c64re"); copyFileSync(file, copy);
  const reads = [{ label: "lo", addr: 0, len: 0x8000, lens: "ram" }, { label: "hi", addr: 0x8000, len: 0x8000, lens: "ram" }];
  const r = await runSandbox({ budgetMs: 120000, mediaPath: copy, steps: [], reads, screen: false, startExactly: true });
  const ramNow = sha(JSON.stringify([[Buffer.from(r.reads[0].bytes).toString("base64")], [Buffer.from(r.reads[1].bytes).toString("base64")]]));
  check(r.endCycle === before.st.c64Cycles, "S1: the new machine's clock is the anchor's", `${r.endCycle} vs ${before.st.c64Cycles}`);
  check(r.pc === before.st.cpu.pc && r.cpu.a === before.st.cpu.a && r.cpu.x === before.st.cpu.x && r.cpu.y === before.st.cpu.y && r.cpu.sp === before.st.cpu.sp && r.cpu.flags === before.st.cpu.flags, "…its registers are the anchor's", `${JSON.stringify(r.cpu)} pc ${r.pc} vs ${JSON.stringify(before.st.cpu)}`);
  check(ramNow === before.ram, "…and all 64 KiB of RAM equal the anchor's", "differs");

  // drop
  const dropped = await m.call("runtime_anchor_drop", { name: "a1" });
  check(!existsSync(file) && /deleted/.test(dropped), "runtime_anchor_drop deletes the anchor's file even though the ring (a sandbox's, long gone) does not hold it", dropped.slice(0, 300));
  check(readAnchor(proj, "a1")?.droppedAt !== undefined && readAnchor(proj, "a1")?.file === undefined, "…and the graph keeps the record, marked dropped, without the file", JSON.stringify(readAnchor(proj, "a1")));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  head("S1b  a feature makes the anchor itself");
  mkdirSync(join(proj, "scenarios"), { recursive: true });
  writeFileSync(join(proj, "scenarios", "make.feature"), [
    "Feature: make an anchor",
    "Scenario: boot to the waiting loop",
    '  Given the medium "../media/poll.prg"',
    `  When I wait until the CPU reaches ${hex4(poll)} within 600 frames`,
    '  And I set the anchor "a2"',
    `  Then the CPU is at ${hex4(poll)}`,
    "",
  ].join("\n"));
  const made = runCli([join(proj, "scenarios", "make.feature"), "--json"]);
  const mj = jsonOf(made.stdout);
  const f2 = join(proj, "knowledge", "anchors", "a2.c64re");
  check(made.code === 0 && mj.results[0].verdict === "PASS", "S1b: the feature runs and passes with no shared session", `${made.code} ${made.stdout.slice(0, 400)} ${made.stderr.slice(0, 200)}`);
  check(existsSync(f2), "knowledge/anchors/a2.c64re exists");
  check(mj.results[0].anchors?.[0]?.pc === poll, `…its PC is the address waited for (${hex4(poll)})`, JSON.stringify(mj.results[0].anchors));
  const n2 = readAnchor(proj, "a2");
  check(n2?.file === "knowledge/anchors/a2.c64re" && n2.cycle === mj.results[0].anchors[0].cycle, "…and a graph anchor node names the file", JSON.stringify(n2));

  writeFileSync(join(proj, "scenarios", "use.feature"), [
    "Feature: start from the anchor",
    "Scenario: the stick is pressed",
    '  Given the mark "a2"',
    "  When I hold joystick 2 down for 5 frames",
    "  And I wait 2 frames",
    "  Then $C000 is $01",
    "",
    "Scenario: a mark that has no file",
    '  Given the mark "never_set"',
    "  When I wait 1 frames",
    "  Then $C000 is $00",
    "",
  ].join("\n"));
  const used = runCli([join(proj, "scenarios", "use.feature"), "--json"]);
  const uj = jsonOf(used.stdout);
  check(uj.results[0].verdict === "PASS", "a second feature starting `Given the mark \"a2\"` runs from that state: the press reaches the program", JSON.stringify(uj.results[0]).slice(0, 400));
  check(uj.results[1].verdict === "SKIP" && /never_set/.test(uj.results[1].reason) && /no file|has no file/.test(uj.results[1].reason), "a mark without a file is still SKIP and says so", uj.results[1].reason);
  check(used.code === 0, "…and a SKIP does not fail the file", String(used.code));

  const clash = runCli([join(proj, "scenarios", "make.feature"), "--json"]);
  const cj = jsonOf(clash.stdout);
  check(cj.results[0].verdict === "ERROR" && /already exists/.test(cj.results[0].reason) && /--replace-anchors/.test(cj.results[0].reason), "an anchor of that name that exists is an ERROR naming it, unless --replace-anchors", cj.results[0].reason);
  check(clash.code === 2, "…and every run being an ERROR is exit code 2", String(clash.code));
  const before2 = readFileSync(f2);
  const repl = runCli([join(proj, "scenarios", "make.feature"), "--replace-anchors", "--json"]);
  check(jsonOf(repl.stdout).results[0].verdict === "PASS" && repl.code === 0, "--replace-anchors replaces it", repl.stdout.slice(0, 300));
  check(existsSync(f2) && readFileSync(f2).length > 0 && before2.length > 0, "…and the file is there");

  const sharedAfter = await sharedCycle();
  check(sharedAfter === sharedBefore, "the shared session's cycle did not move across S1 and S1b", `${sharedBefore} -> ${sharedAfter}`);
  sharedWs.close();
} catch (e) {
  check(false, "script ran", String((e && e.stack) || e));
} finally {
  H.stopMcps();
  H.cleanup();
}
for (let i = 0; i < 40 && liveMachines(tmp.dir).length > 0; i++) await sleep(250);
check(liveMachines(tmp.dir).length === 0, "no machine of this run is left running");
process.exit(T.done());
