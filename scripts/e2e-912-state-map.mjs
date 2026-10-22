#!/usr/bin/env node
// A game mapped by its moves: `runtime_state_map` and `c64re state map` try every move in every state from an anchor,
// on a private machine, and keep the map in the project's graph.
//
//   S1  a bad description is refused before any run     empty key, unknown action, a goal over no address, a missing
//                                                       anchor, a key the project's reading does not support; the
//                                                       runtime binary is a tripwire: it was never started
//   S2  the whole maze is found                         9 states, 48 runs, 1 crash at $085F; every edge replays as a
//                                                       feature from the anchor; the command line says the same; a
//                                                       checkpoint ring too small to hold the states changes nothing
//   S3  goal mode: a shortest path and a goal anchor     R R R F; a feature from the goal anchor reads $03 = 1; a map
//                                                       from the goal anchor finds the states beyond it
//   S4  a crash after a crash is not a phantom           needs the checkpoint-restore fix in the runtime: SKIPS LOUDLY,
//                                                       naming the runtime version, when the runtime lacks it
//   S5  caps stop and say so                            max_states 3 stops with 3 states, the machine is ended, and
//                                                       the same call again answers from the graph with no machine
//   S6  the map is knowledge                            graph_find / graph_edges / project_search find it, linked to the
//                                                       anchor; the shared machine's cycle did not move
//
// The game is built here from 64tass source of this script's own (scripts/lib/e2e-912-maze.mjs). Real daemons of this
// run's own, a TMPDIR of the run's own (removed on exit), no machine left behind.
//   Locally:  C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:912
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, ROOT, findDaemon, load, makeChecker, processesMatching, sleep } from "./lib/e2e-906-harness.mjs";
import { jsonOf, liveMachines, privateTmp, runCli } from "./lib/e2e-911-env.mjs";
import { buildCounter, buildMaze } from "./lib/e2e-912-maze.mjs";
import { spawnSync } from "node:child_process";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-912-state-map");
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
const tmp = privateTmp("c64re-912-");
const daemonsBefore = processesMatching("trx64-daemon").length;
console.log(`runtime: ${DAEMON}\nTMPDIR:  ${tmp.dir}\ntrx64-daemon processes before: ${daemonsBefore}\n`);

const H = new Harness("h-");
const hex4 = (n) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
const lines = (...l) => [...l, ""].join("\n");
const ACTIONS = ["L", "R", "U", "D", "F", "N"];
const scratch = () => readdirSync(tmp.dir).filter((n) => n.startsWith("c64re-map-") || n.startsWith("c64re-reel-"));
let skipped = 0;

// A runtime binary that records that it was started and then refuses to run: whoever starts a machine shows it.
const tripwire = join(tmp.dir, "tripwire.sh");
const marker = join(tmp.dir, "tripwire.started");
writeFileSync(tripwire, `#!/bin/sh\necho started >> "${marker}"\nexit 1\n`);
chmodSync(tripwire, 0o755);

/** What the runtime does with a checkpoint taken after a JAM was reached: asked of the daemon itself. */
async function probeRestore(anchorAbs, crashPc) {
  const { SandboxSession } = await load("reel/sandbox-session.js");
  const { machineIdentity } = await load("runtime/machine-model.js");
  const box = await SandboxSession.start({ budgetMs: 120_000 });
  try {
    const ping = await box.call("ping");
    const dir = join(tmp.dir, "probe");
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, "anchor.c64re");
    copyFileSync(anchorAbs, copy);
    await box.call("debug/pause", { source: "sandbox" });
    await box.call("media/open", { path: copy });
    await box.call("debug/pause", { source: "sandbox" });
    const F = machineIdentity(await box.call("session/state")).cyclesPerFrame;
    const run = async (n) => (await box.call("session/run", { cycles: n * F }))?.jam?.pc;
    const hold = async (dirs) => {
      await box.call("session/joystick_set", { port: 2, source: "sandbox", ...dirs });
      const a = await run(6);
      await box.call("session/joystick_clear", { port: 2 });
      return a ?? (await run(4));
    };
    await hold({ right: true }); await hold({ right: true });
    const cp = (await box.call("checkpoint/capture")).ref.id;
    const first = await hold({ down: true });
    await box.call("checkpoint/restore", { id: cp, then: "pause" });
    await box.call("session/joystick_clear", {});
    const afterRestore = await run(1);
    const again = await hold({ down: true });
    return { version: ping.version, first, staleAfterRestore: afterRestore !== undefined, again, crashPc };
  } finally { await box.close(); }
}

try {
  const proj = await H.project("proj");
  const maze = await buildMaze(proj);
  mkdirSync(join(proj, "media"), { recursive: true });
  mkdirSync(join(proj, "scenarios"), { recursive: true });
  writeFileSync(join(proj, "media", "maze.prg"), maze.prg);
  const sc = (n) => join(proj, "scenarios", n);
  const anchorAbs = join(proj, "knowledge", "anchors", "maze_loop.c64re");

  writeFileSync(sc("make.feature"), lines(
    "Scenario: boot to the loop",
    '  Given the medium "../media/maze.prg"',
    `  When I wait until the CPU reaches ${hex4(maze.loop)} within 600 frames`,
    '  And I set the anchor "maze_loop"',
    `  Then the CPU is at ${hex4(maze.loop)}`,
  ));
  check(runCli([sc("make.feature")]).code === 0 && existsSync(anchorAbs), `setup: the maze (assembled here from its own source) runs and the anchor maze_loop is at its loop ${hex4(maze.loop)}, the JAM at ${hex4(maze.crash)}`);
  check(maze.prg[maze.crash - 0x0801 + 2] === 0x02, "setup: the byte at the crash address is a JAM opcode ($02)");

  // The stand-in for the shared session: a daemon of this run's own that the MCP is attached to. Its clock must not move.
  const shared = await H.daemon(DAEMON, proj);
  const sharedWs = await H.ws(shared.port);
  const pin = await H.pinShared(sharedWs);

  const m = await H.mcp(proj, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
  const trip = await H.mcp(proj, { env: { C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_BIN: tripwire } });
  const mapJson = async (args, via = m) => JSON.parse(await via.call("runtime_state_map", { json: true, ...args }));
  const BASE = { anchor: "maze_loop", key: ["$02", "$03"], actions: ACTIONS };

  // ── the tool surface ───────────────────────────────────────────────────────────────────────────
  head("the tool");
  check(m.tools.some((t) => t.name === "runtime_state_map"), "runtime_state_map is on the tool surface");
  const desc = m.desc("runtime_state_map");
  check(/key/.test(desc) && /anchor/.test(desc) && /Never drive a game by hand/.test(desc) && /graph/.test(desc), "…and its description tells the loop: key, anchor, no per-move calls, the graph");

  // ── S1 ─────────────────────────────────────────────────────────────────────────────────────────
  head("S1  a bad description is refused before any run");
  const refuses = async (label, args, field, extra = /./) => {
    const out = await trip.call("runtime_state_map", { ...BASE, ...args });
    check(out.startsWith("runtime_state_map: ") && out.includes(`${field} —`) && extra.test(out), `${label}: refused, naming ${field}`, out.slice(0, 260));
  };
  await refuses("an empty key", { key: [] }, "key", /empty/);
  await refuses("a key that is not an address", { key: ["$02", "room"] }, "key");
  await refuses("an unknown action", { actions: ["L", "X"] }, "actions", /X/);
  await refuses("left and right at once", { actions: ["LR"] }, "actions");
  await refuses("no actions", { actions: [] }, "actions");
  await refuses("an unknown key", { actions: ["key:NOPE"] }, "actions", /NOPE/);
  await refuses("a goal over an address that does not exist", { goal: "$12345 == 1" }, "goal", /address/);
  await refuses("a goal in no notation", { goal: "room three" }, "goal");
  await refuses("a goal on a lens that is not one", { goal: "$03@sprite == 1" }, "goal", /lens/);
  await refuses("a dead condition that is not a condition", { dead: ["$02 ~ 3"] }, "dead");
  await refuses("a cap that is not a number", { max_states: 0 }, "max_states");
  await refuses("an anchor that has no file", { anchor: "nowhere" }, "anchor", /runtime_anchor_set/);
  check(!existsSync(marker), "…and no machine was started for any of them (the runtime binary was never run)");
  check(scratch().length === 0, "…no scratch directory of a sandbox was made either", scratch().join(" "));

  // the discipline gate: the key must be something the project has read, and the gate reads the CALL's project
  const { KnowledgeRecords } = await load("knowledge-graph/records.js");
  const readProj = await H.project("read-proj");
  new KnowledgeRecords(readProj).saveFinding({ kind: "observation", title: "stage 1 at $C000", addressRange: { start: 0xc000, end: 0xc0ff } });
  await trip.call("agent_onboard", { project_dir: readProj });
  const gated = await trip.call("runtime_state_map", { ...BASE, project_dir: readProj });
  check(/runtime_state_map: key —/.test(gated) && /resolve|read/.test(gated), "a project that has read something else than the key's addresses: refused, naming key (project_dir of the call, not the server's)", gated.slice(0, 260));
  const ungated = await trip.call("runtime_state_map", { ...BASE, anchor: "nowhere" });
  check(/anchor —/.test(ungated) && !/key —/.test(ungated), "a project with no analysis yet is not gated by the key (the next refusal is the missing anchor)", ungated.slice(0, 200));
  new KnowledgeRecords(proj).saveFinding({ kind: "observation", title: "the room routine", addressRange: { start: 0x0870, end: 0x08c0 } });
  new KnowledgeRecords(proj).saveFinding({ kind: "observation", title: "room and flag", addressRange: { start: 0x0002, end: 0x000f } });
  new KnowledgeRecords(proj).saveFinding({ kind: "observation", title: "the VIC registers", addressRange: { start: 0xd000, end: 0xd02e } });

  // ── S2 ─────────────────────────────────────────────────────────────────────────────────────────
  head("S2  the whole maze is found");
  const t2 = Date.now();
  const full = await mapJson({ ...BASE, name: "rooms" });
  console.log(`  (${Date.now() - t2} ms)`);
  check(full.outcome.kind === "complete" && full.complete, "the answer says complete", JSON.stringify(full.outcome));
  check(full.states.length === 9, "9 states", String(full.states.length));
  check(full.runs === 48, "48 runs", String(full.runs));
  check(full.crashes.length === 1 && full.crashes[0].pc === maze.crash, `1 crash, at ${hex4(maze.crash)}`, JSON.stringify(full.crashes));
  const keys = full.states.filter((s) => !s.crash).map((s) => s.values.join(",")).sort().join(" ");
  check(keys === "0,0 0,1 1,0 1,1 2,0 2,1 3,0 3,1", "the eight rooms: $02 in 0..3 with $03 = 0 and 1", keys);
  const text = await m.call("runtime_state_map", { ...BASE, name: "rooms" });
  check(text.split("\n")[0].startsWith("complete: 9 states, 48 runs, 1 crash") && /answered from the graph/.test(text), "the text begins with the outcome; asked again, it answers from the graph", text.split("\n").slice(0, 2).join(" | "));

  // every edge it lists replays as a feature from the anchor
  const byId = new Map(full.states.map((s) => [s.id, s]));
  const words = { L: "left", R: "right", U: "up", D: "down", F: "fire" };
  const holdLines = (move) => [`  When I hold joystick 2 ${[...move].map((c) => words[c]).join(" and ")} for 6 frames`, "  And I wait 4 frames"];
  const scen = [];
  for (const e of full.edges) {
    const from = byId.get(e.from), to = byId.get(e.to);
    const steps = [...from.path, e.move].flatMap(holdLines).map((l, i) => (i === 0 ? l : l.replace("  When", "  And")));
    const then = to.crash ? [`  Then the CPU is at ${hex4(to.crash.pc)}`] : [`  Then $02 is $${to.values[0].toString(16).padStart(2, "0")}`, `  And $03 is $${to.values[1].toString(16).padStart(2, "0")}`];
    scen.push(["Scenario: " + `${e.from} ${e.move} ${e.to}`, '  Given the mark "maze_loop"', ...steps, ...then].join("\n"));
  }
  writeFileSync(sc("replay.feature"), lines(...scen.map((s) => s + "\n")));
  const replay = jsonOf(runCli([sc("replay.feature"), "--json", "--jobs", "4"]).stdout);
  const failed = replay.results.filter((r) => r.verdict !== "PASS");
  check(replay.results.length === full.edges.length && failed.length === 0, `every one of the ${full.edges.length} edges reproduces when replayed as a feature from the anchor`, failed.map((r) => `${r.scenario}: ${r.verdict} ${r.reason ?? ""}`).join(" | "));

  // the command line is the same function, and a fresh daemon gives the same map
  writeFileSync(join(proj, "rooms.json"), JSON.stringify({ ...BASE, name: "rooms_cli" }));
  const cli = spawnSync(process.execPath, [join(ROOT, "dist/cli.js"), "state", "map", join(proj, "rooms.json"), "--json"], { encoding: "utf8", env: process.env });
  const cliJson = cli.stdout ? JSON.parse(cli.stdout) : {};
  const shape = (j) => JSON.stringify({ o: j.outcome, runs: j.runs, st: j.states.map((s) => [s.id, s.values, s.depth, s.path, s.crash ?? null]), e: j.edges });
  check(cli.status === 0 && shape(cliJson) === shape(full), "`c64re state map file.json` answers what the tool answered, from a fresh machine", `${cli.status} ${cli.stderr.slice(0, 200)}`);
  const cliText = spawnSync(process.execPath, [join(ROOT, "dist/cli.js"), "state", "map", join(proj, "rooms.json")], { encoding: "utf8" });
  check(cliText.status === 0 && /answered from the graph/.test(cliText.stdout), "…and again from the file: answered from the graph", cliText.stdout.slice(0, 200));
  writeFileSync(join(proj, "bad.json"), JSON.stringify({ ...BASE, key: [] }));
  const cliBad = spawnSync(process.execPath, [join(ROOT, "dist/cli.js"), "state", "map", join(proj, "bad.json")], { encoding: "utf8" });
  check(cliBad.status === 2 && /key —/.test(cliBad.stdout), "…a description it refuses exits 2 and names the field", `${cliBad.status} ${cliBad.stdout.slice(0, 160)}`);

  // the ring: states beyond what it holds go to files, and the map is the same
  const { runStateMap } = await load("statemap/run.js");
  const { answerJson } = await load("statemap/render.js");
  const spill = answerJson(await runStateMap({ ...BASE, name: "rooms_spill" }, { projectDir: proj, ringStates: 3 }));
  check(spill.spilled === 5 && shape(spill) === shape(full), "with a ring that holds 3 states the other 5 (of the 8 that hold a machine; the crash holds none) go to files, and the map is the same", `spilled ${spill.spilled}`);

  // dead states end a branch; edges "all" lists the moves that left the state as it was
  const dead = await mapJson({ ...BASE, name: "rooms_dead", dead: ["$02 == 3"] });
  check(dead.complete && dead.states.length === 5 && dead.states.find((s) => !s.crash && s.values[0] === 3)?.dead === true && dead.states.every((s) => s.crash || s.values[1] === 0) && dead.crashes.length === 1, "a dead condition ends a branch: room 3 is a state, its moves are not tried (no fire there, so no state with $03 = 1: 4 rooms and the crash from room 2)", JSON.stringify(dead.states.map((s) => [s.id, s.values, s.dead])));
  const allEdges = await m.call("runtime_state_map", { ...BASE, name: "rooms", edges: "all" });
  check(/Every move tried/.test(allEdges) && /s0: R->s1  L U D F N stay/.test(allEdges), "edges: \"all\" lists the moves that leave the state as it was too", allEdges.split("\n").filter((l) => /^  s0:/.test(l)).join("|"));

  // ── S3 ─────────────────────────────────────────────────────────────────────────────────────────
  head("S3  goal mode gives a shortest path and a goal anchor");
  const solved = await mapJson({ ...BASE, name: "solve", goal: "$03 == 1" });
  check(solved.outcome.kind === "goal" && solved.goal?.path.join(" ") === "R R R F", "the path is R R R F and the search stopped at the goal", JSON.stringify([solved.outcome, solved.goal]));
  check(solved.goal.moves === 4 && solved.goal.frames === 40, "4 moves, 40 frames", JSON.stringify(solved.goal));
  const goalFile = join(proj, "knowledge", "anchors", "solve.goal.c64re");
  check(existsSync(goalFile) && solved.anchors.some((a) => a.name === "solve.goal"), "the goal state is written as an anchor file, solve.goal");
  writeFileSync(sc("goal.feature"), lines(
    "Scenario: the goal anchor holds the goal",
    '  Given the mark "solve.goal"',
    "  When I wait 3 frames",
    "  Then $03 is $01",
    "  And $02 is $03",
  ));
  const gf = jsonOf(runCli([sc("goal.feature"), "--json"]).stdout);
  check(gf.results[0]?.verdict === "PASS", "a feature from the goal anchor reads $03 = 1 (and $02 = 3)", JSON.stringify(gf.results[0]?.checks));
  const beyond = await mapJson({ ...BASE, anchor: "solve.goal", name: "beyond" });
  const beyondKeys = beyond.states.filter((s) => !s.crash).map((s) => s.values.join(",")).sort().join(" ");
  check(beyond.complete && beyondKeys === "0,1 1,1 2,1 3,1" && beyond.crashes.length === 1 && beyond.states.length === 5, "a second map started from the goal anchor finds the states beyond it (rooms 0..3 with $03 = 1, and the crash)", `${beyond.outcome.kind} ${beyondKeys} ${beyond.states.length}`);
  const goOn = await mapJson({ ...BASE, name: "solve_all", goal: "$03 == 1", continue_after_goal: true });
  check(goOn.complete && goOn.states.length === 9 && goOn.runs === 48 && goOn.goal?.path.join(" ") === "R R R F", "continue_after_goal maps on: complete, 9 states, 48 runs, and the path to the first goal is still R R R F", JSON.stringify([goOn.outcome, goOn.runs, goOn.goal]));
  const noGoal = await mapJson({ ...BASE, name: "unreachable", goal: "$02 == 9" });
  check(noGoal.complete && noGoal.goal === null, "a goal that cannot be reached: the map is complete and says the goal was not reached", JSON.stringify([noGoal.outcome, noGoal.goal]));
  const again = await mapJson({ ...BASE, name: "solve", goal: "$03 == 1", save_states: true });
  check(again.fromGraph === null && again.anchors.length === solved.states.length, "a map of the same name with other inputs replaces it (save_states writes every state)", `${again.fromGraph} ${again.anchors.length}/${solved.states.length}`);

  // ── S4 ─────────────────────────────────────────────────────────────────────────────────────────
  head("S4  a crash after a crash is not a phantom");
  const crashOpcodes = full.crashes.every((c) => maze.prg[c.pc - 0x0801 + 2] === 0x02);
  check(crashOpcodes, "every crash the map reports sits on a JAM opcode of the program");
  const probe = await probeRestore(anchorAbs, maze.crash);
  check(probe.first === maze.crash, `premise: down in room 2 jams at ${hex4(maze.crash)} on this runtime (${probe.version})`, JSON.stringify(probe));
  if (probe.staleAfterRestore) {
    skipped++;
    console.log(`  SKIPPED  S4 — runtime ${probe.version} (${DAEMON}) keeps reporting a jam after a checkpoint is restored from a jammed machine, so a search against it meets phantom crashes.`);
    console.log("           The restore fix is on TRX64 main (558c8a3) and not in a release yet. This is NOT a pass: build that daemon and set C64RE_RUNTIME_BIN.");
    check(full.staleJamReports > 0, "the tool did meet them on this runtime and refused to take them for crashes (its answer says so)", `${full.staleJamReports}`);
    check(/reported a jam \d+ times? at a PC that holds no JAM opcode/.test(text) || /reported a jam/.test(await m.call("runtime_state_map", { ...BASE, name: "rooms_note" })), "…and the text of the answer carries the note");
  } else {
    check(!probe.staleAfterRestore && probe.again === maze.crash, `a restore from the jammed machine runs again (no jam reported), and a real JAM after the restore reports its own PC ${hex4(maze.crash)}`, JSON.stringify(probe));
    check(full.staleJamReports === 0, "the search met no phantom: not one jam report at a PC that holds no JAM opcode", `${full.staleJamReports}`);
    check(full.crashes.length === 1 && full.states.length === 9, "…so the states found after the crash are all genuine (9 states, 1 crash)");
  }

  // ── S5 ─────────────────────────────────────────────────────────────────────────────────────────
  head("S5  caps stop and say so");
  const capped = await m.call("runtime_state_map", { ...BASE, name: "capped", max_states: 3 });
  const capJson = await mapJson({ ...BASE, name: "capped", max_states: 3 });
  check(capped.startsWith("stopped: max_states 3") && capJson.states.length === 3 && !capJson.complete, "max_states 3: \"stopped: max_states 3\" with the 3 states found", capped.split("\n")[0]);
  for (let i = 0; i < 40 && (liveMachines(tmp.dir).length > 0 || scratch().length > 0); i++) await sleep(250);
  check(liveMachines(tmp.dir).length === 0 && scratch().length === 0, "…and the sandbox is ended (no machine, no scratch left)", `${liveMachines(tmp.dir).length} ${scratch().join(" ")}`);
  check(capJson.fromGraph !== null, "the same call again answers from the graph", String(capJson.fromGraph));
  const viaTrip = await trip.call("runtime_state_map", { ...BASE, name: "capped", max_states: 3 });
  check(viaTrip.startsWith("stopped: max_states 3") && /answered from the graph/.test(viaTrip) && !existsSync(marker), "…with a runtime that cannot be started: it starts no machine (the tripwire was never run)", viaTrip.slice(0, 160));
  const runsCap = await mapJson({ ...BASE, name: "capped_runs", max_runs: 5 });
  check(runsCap.outcome.kind === "stopped" && runsCap.outcome.cap === "max_runs" && runsCap.runs === 5, "max_runs 5: stopped at 5 runs, naming the cap", JSON.stringify(runsCap.outcome));
  const depthCap = await mapJson({ ...BASE, name: "capped_depth", max_depth: 2 });
  check(depthCap.outcome.kind === "stopped" && depthCap.outcome.cap === "max_depth" && depthCap.states.every((s) => s.depth <= 2), "max_depth 2: stopped at depth 2, naming the cap", JSON.stringify(depthCap.outcome));
  const unstable = await m.call("runtime_state_map", { anchor: "maze_loop", key: ["$0A:2"], actions: ["L", "R", "U", "D", "F"], name: "timer" });
  check(/runtime_state_map: key — changes with every run/.test(unstable) && /Nothing was saved/.test(unstable), "a key that is new with every one of the first 20 runs (a hash of every frame's stick) is refused, and nothing is saved", unstable.slice(0, 220));
  const noTimerMap = await m.call("graph_find", { query: "timer" });
  check(!/state_map/.test(noTimerMap), "…no map of that name is in the graph");

  // ── a key that follows time ──────────────────────────────────────────────────────────────────
  head("a key that follows time is not a map");
  const counter = await buildCounter(proj);
  writeFileSync(join(proj, "media", "counter.prg"), counter.prg);
  writeFileSync(sc("counter.feature"), lines(
    "Scenario: boot to the counter loop",
    '  Given the medium "../media/counter.prg"',
    `  When I wait until the CPU reaches ${hex4(counter.loop)} within 600 frames`,
    '  And I set the anchor "counter_loop"',
    `  Then the CPU is at ${hex4(counter.loop)}`,
  ));
  check(runCli([sc("counter.feature")]).code === 0, "setup: a program with only a frame counter, anchor counter_loop");
  const tick = { anchor: "counter_loop", key: ["$02"], actions: ["L", "R", "U", "D", "F", "N"], frames: 2, release_frames: 2, name: "ticks" };
  new KnowledgeRecords(proj).saveFinding({ kind: "observation", title: "the counter", addressRange: { start: 0x0002, end: 0x0002 } });
  const tickText = await m.call("runtime_state_map", tick);
  check(tickText.startsWith("complete — but the key follows time, not the moves: every move from every state leads to the same next state") && /\$02/.test(tickText.split("\n")[0]), "the answer says so, naming the key", tickText.split("\n")[0].slice(0, 200));
  const tickJson = await mapJson({ ...tick, name: "ticks" });
  check(tickJson.keyFollowsTime === true && tickJson.complete, "the JSON carries keyFollowsTime");
  writeFileSync(join(proj, "ticks.json"), JSON.stringify({ ...tick, name: "ticks_cli" }));
  const tickCli = spawnSync(process.execPath, [join(ROOT, "dist/cli.js"), "state", "map", join(proj, "ticks.json")], { encoding: "utf8" });
  check(tickCli.status === 1 && tickCli.stdout.split("\n")[0] === tickText.split("\n")[0].replace(/ \d+ runs/, (x) => x), "the command line says the same and exits 1", `${tickCli.status} ${tickCli.stdout.slice(0, 120)}`);
  const { loadMap } = await load("statemap/memory.js");
  const { GraphStore } = await load("knowledge-graph/store.js");
  const gs = GraphStore.open(proj, { readOnly: true });
  const row = gs.db.prepare("SELECT attrs FROM nodes WHERE kind = 'state_map' AND name = 'ticks'").get();
  gs.close();
  check(JSON.parse(row.attrs).key_follows_time === true && loadMap(proj, "ticks")?.result.states.length > 2, "the map is saved, and the state_map node is flagged key_follows_time: true", row.attrs.slice(0, 120));
  check(full.keyFollowsTime === false && solved.keyFollowsTime === false && goOn.keyFollowsTime === false, "the maze is not flagged", String(full.keyFollowsTime));
  check(!/key follows time/.test(text), "…and its text says plain complete");

  // ── S6 ─────────────────────────────────────────────────────────────────────────────────────────
  head("S6  the map is knowledge");
  const found = await m.call("graph_find", { query: "rooms" });
  check(/rooms/.test(found) && /state_map/.test(found) && /game_state/.test(found), "graph_find finds the map and its states by name", found.slice(0, 300));
  const mapRef = (found.match(/([A-Za-z0-9_.-]+:sub:statemap\.rooms-[0-9a-f]+)\b/) ?? [])[1];
  check(!!mapRef, "…with an id that round-trips", found.slice(0, 200));
  const edgesOut = await m.call("graph_edges", { ref: mapRef, direction: "out", origin: "human", limit: 50 });
  check(/STARTS_FROM/i.test(edgesOut) && /anchor\.maze_loop/.test(edgesOut), "the map is linked to the anchor (STARTS_FROM anchor.maze_loop)", edgesOut.slice(0, 300));
  const s0Edges = await m.call("graph_edges", { ref: `${mapRef}.s2`, direction: "out", origin: "human", limit: 50 });
  check((s0Edges.match(/^MOVES_TO\s/gm) ?? []).length === 3, "a state's moves are edges: room 2 has three that change the state (L, R, D)", s0Edges.slice(0, 400));
  const search = await m.call("project_search", { query: "rooms" });
  check(/\[state_map\]/.test(search) && /rooms/.test(search), "project_search finds the map by its name", search.slice(0, 300));
  const entities = await m.call("list_entities", {}).catch(() => "");
  check(!/game_state|state_map/.test(entities), "the map's nodes are not listed as entities of the project");
  const sharedNow = await pin.unchanged();
  check(sharedNow.ok, "the shared machine (a paused stand-in) did not move during S2-S5: same cycle, same PC, still paused", sharedNow.text);
  const anchorList = await m.call("runtime_anchor_list", {});
  check(/solve\.goal/.test(anchorList), "the goal anchor is a project anchor like any other: runtime_anchor_list shows it", anchorList.slice(0, 200));

  sharedWs.close();
} catch (e) {
  check(false, "script ran", String((e && e.stack) || e));
} finally {
  H.stopMcps();
  H.cleanup();
}
for (let i = 0; i < 40 && (liveMachines(tmp.dir).length > 0); i++) await sleep(250);
check(liveMachines(tmp.dir).length === 0, "no machine of this run is left running");
const daemonsAfter = processesMatching("trx64-daemon").length;
console.log(`trx64-daemon processes after: ${daemonsAfter} (before: ${daemonsBefore})`);
if (skipped) console.log(`\n${skipped} section(s) SKIPPED — see above. Skipped is not passed.`);
process.exit(T.done(skipped ? `${skipped} skipped` : ""));
