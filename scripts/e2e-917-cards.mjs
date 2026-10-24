#!/usr/bin/env node
// A step is a contract: the plan, the cards, and the verdict C64RE gives itself.
//
//   S0  the plan          packages stored with their done-when; a card outside every package refused
//   S1  the card form     a bare string and an unknown kind refused naming the line; a valid card is a graph node
//                         with PART_OF / REQUIRES edges, read back through the graph library
//   S2  the verdict       DONE -> NOT KEPT (with the failing line) -> KEPT; a [human] line -> WAITING -> judge -> KEPT;
//                         judge refused when the card is not WAITING; registration + contract lines
//   S3  positions         a non-architect cannot issue; a worker recording against another card: step recorded, report not attached
//   S4  requires          an unkept predecessor refuses the issue, naming it; a package closes only when every card is KEPT
//   S5  scenario line     a real sandbox: `$02A6 is $01` after 50 PAL frames -> KEPT, `$00` -> NOT KEPT
//
// Synthetic project in a TMPDIR of the run's own. No third-party bytes.
//   Locally:  npm run e2e:917
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, ROOT, findDaemon, load, makeChecker, sleep } from "./lib/e2e-906-harness.mjs";
import { liveMachines, privateTmp } from "./lib/e2e-911-env.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing - run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-917-cards");
const { check, head } = T;
const DAEMON = await findDaemon();
if (DAEMON) process.env.C64RE_RUNTIME_BIN = DAEMON;
const tmp = privateTmp("c64re-917-");

const H = new Harness("h917-");
const { nameNode } = await load("knowledge-graph/migrate/human.js");
const { readProjectSlug } = await load("knowledge-graph/store.js");
const { Graph } = await load("knowledge-graph/query.js");

try {
  const proj = await H.project("p917");
  const slug = readProjectSlug(proj);
  const m = await H.mcp(proj, { env: DAEMON ? { C64RE_RUNTIME_BIN: DAEMON, TMPDIR: tmp.dir } : {} });
  const has = (re, text) => re.test(text);
  const routine = { slug, ctx: { space: "ram", owner: "main" }, kind: "routine", address: 0x0a20 };
  const nodeCheck = { kind: "graph", subject: "node", nodeKind: "routine", owner: "main", address: "$0A20", named: true, text: "the routine at $0A20 carries a human name" };
  const human = { kind: "human", text: "the lift feels right in level 3" };

  check(m.tools.some((t) => t.name === "plan") && m.tools.some((t) => t.name === "card"), "the tools plan and card are on the default surface");

  // ═══ S3 (first half): nobody has a position yet
  head("S3  positions: a session with no position cannot issue");
  let r = await m.call("card", { action: "issue", id: "c0", title: "t", package: "p1", role: "analyst", goal: "g", doneWhen: [human] });
  check(has(/issuing a card is the architect's/, r) && has(/position is unset/, r), "card issue by an unset session is refused, naming the position", r);

  // ═══ S0
  head("S0  the plan");
  r = await m.call("plan", { action: "set", packages: [
    { id: "p1", title: "Name the lift", doneWhen: [nodeCheck] },
    { id: "p2", title: "Fix the lift", doneWhen: [{ kind: "registration", text: "nothing on disk is unregistered" }] },
  ] });
  check(has(/Plan set: 2 package/, r) && r.indexOf("1. p1") >= 0 && r.indexOf("2. p2") > r.indexOf("1. p1"), "plan set stores two packages in the given order", r);
  r = await m.call("plan", { action: "set", packages: [{ id: "bad", title: "x", doneWhen: ["routine named"] }] });
  check(has(/packages\[0\]\.doneWhen\[0\]/, r) && has(/prose is a \[human\] line/, r), "a package with a prose done-when is refused, naming the line", r);
  r = await m.call("agent_set_role", { role: "analyst", position: "architect" });
  check(has(/Position: architect/, r), "agent_set_role takes the position", r);
  r = await m.call("card", { action: "issue", id: "c0", title: "t", package: "nope", role: "analyst", goal: "g", doneWhen: [human] });
  check(has(/belongs to no package/, r), "S0: a card outside every package is refused", r);

  // ═══ S1
  head("S1  the card form");
  const base = { action: "issue", package: "p1", role: "analyst", goal: "Name the routine at $0A20", read: ["main_disasm.tas:812-840"], change: "annotations only", not: ["no fix"], stopIf: ["the code differs"] };
  r = await m.call("card", { ...base, id: "c1", title: "name", doneWhen: ["the routine is named"] });
  check(has(/doneWhen\[0\]/, r) && has(/prose is a \[human\] line/, r) && has(/Allowed forms/, r), "a bare string done-when is refused: prose is a [human] line", r);
  r = await m.call("card", { ...base, id: "c1", title: "name", doneWhen: [{ kind: "vibes", text: "feels ok" }] });
  check(has(/doneWhen\[0\]/, r) && has(/"vibes" is unknown/, r) && has(/Allowed forms/, r), "an unknown kind is refused naming the line and the allowed forms", r);
  r = await m.call("card", { ...base, id: "c1", title: "name", doneWhen: [{ kind: "graph", subject: "node", address: "zz", text: "x" }] });
  check(has(/not a 16-bit address/, r), "a missing/invalid field is refused", r);
  r = await m.call("card", { ...base, id: "c1", title: "name", doneWhen: [] });
  check(has(/empty doneWhen/, r), "an empty done-when is refused", r);
  r = await m.call("card", { ...base, id: "c1", title: "name the lift routine", doneWhen: [nodeCheck] });
  check(has(/Card "c1" issued in package "p1"/, r), "a valid card is issued", r);
  r = await m.call("card", { ...base, id: "c1", title: "again", doneWhen: [nodeCheck] });
  check(has(/exists already/, r), "an existing id is refused", r);
  {
    const g = Graph.open(proj);
    try {
      const cardId = `${slug}:card:c1`;
      const part = g.edgesOutOf(cardId, ["PART_OF"]).map((e) => e.toNode.id);
      check(part.length === 1 && part[0] === `${slug}:plan:p1`, "the card is a graph node with a PART_OF edge to its package", JSON.stringify(part));
    } finally { g.close(); }
  }

  // ═══ S2
  head("S2  the verdict is C64RE's");
  r = await m.call("agent_set_role", { role: "analyst", position: "worker", card: "c1" });
  check(has(/Position: worker \(card c1\)/, r), "the worker is bound to its card", r);
  r = await m.call("card", { ...base, id: "cx", title: "x", doneWhen: [human] });
  check(has(/issuing a card is the architect's/, r) && has(/worker \(card c1\)/, r), "S3: a worker cannot issue a card", r);
  r = await m.call("agent_record_step", { step: "named it", card: "c1", result: "DONE", report: "named lift_init" });
  check(has(/Step recorded/, r) && has(/worker says DONE/, r) && has(/Verdict \(C64RE\): NOT KEPT/, r) && has(/FAIL  \[graph\] the routine at \$0A20 carries a human name/, r) && has(/0 routine owner main at \$0A20 with a human name/, r), "DONE with the graph line failing -> NOT KEPT, naming the failing line", r);
  r = await m.call("card", { action: "show", card: "c1" });
  check(has(/\[NOT KEPT\]/, r) && has(/Worker's report .*DONE - named lift_init/, r) && has(/Verdict \(C64RE/, r), "the worker's claim sits beside the verdict, not instead of it", r);
  nameNode(proj, { parts: routine, kind: "routine", name: "lift_init" });
  r = await m.call("agent_record_step", { step: "named it for real", card: "c1", result: "DONE", report: "named lift_init" });
  check(has(/Verdict \(C64RE\): KEPT/, r) && has(/PASS  \[graph\]/, r), "DONE with the graph line holding -> KEPT", r);

  r = await m.call("agent_set_role", { role: "analyst", position: "architect" });
  r = await m.call("card", { ...base, id: "c2", title: "judged by a human", requires: ["c1"], doneWhen: [nodeCheck, human] });
  check(has(/Card "c2" issued/, r) && has(/requires c1/, r), "a card whose requires is KEPT is issued", r);
  {
    const g = Graph.open(proj);
    try {
      const req = g.edgesOutOf(`${slug}:card:c2`, ["REQUIRES"]).map((e) => e.toNode.id);
      check(req.length === 1 && req[0] === `${slug}:card:c1`, "a REQUIRES edge runs from the card to the card it requires", JSON.stringify(req));
    } finally { g.close(); }
  }
  r = await m.call("card", { action: "judge", card: "c2", kept: true, by: "alex", why: "feels right" });
  check(has(/not WAITING/, r), "judge is refused while the card is not WAITING", r);
  r = await m.call("agent_set_role", { role: "analyst", position: "worker", card: "c2" });
  r = await m.call("agent_record_step", { step: "did c2", card: "c2", result: "DONE" });
  check(has(/Verdict \(C64RE\): WAITING \(human gate\)/, r) && has(/WAITING  \[human\]/, r), "machine lines hold and a [human] line is left -> WAITING (human gate)", r);
  r = await m.call("agent_set_role", { role: "analyst", position: "architect" });
  r = await m.call("card", { action: "judge", card: "c2", kept: true, by: "alex", why: "feels right" });
  check(has(/KEPT by the human gate \(alex\)/, r), "the human gate decides, and who is recorded", r);
  r = await m.call("card", { action: "show", card: "c2" });
  check(has(/\[KEPT\]/, r) && has(/Human gate \(alex.*kept - feels right/, r), "the card shows the gate decision with its author", r);
  r = await m.call("card", { action: "judge", card: "c2", kept: false, by: "alex", why: "again" });
  check(has(/not WAITING/, r), "judge is refused on a KEPT card", r);
  r = await m.call("card", { action: "check", card: "c2" });
  check(has(/Card c2: KEPT/, r), "a re-check keeps the standing human decision", r);

  r = await m.call("card", { ...base, id: "c5", package: "p2", title: "hygiene", doneWhen: [{ kind: "registration", text: "nothing unregistered" }, { kind: "contract", text: "nothing owed" }] });
  check(has(/Card "c5" issued/, r), "a registration + contract card is issued", r);
  r = await m.call("card", { action: "check", card: "c5" });
  check(has(/Card c5: KEPT/, r) && has(/PASS  \[registration\]/, r) && has(/PASS  \[contract\]/, r), "registration and contract lines are judged", r);

  // ═══ S4
  head("S4  requires and the package close");
  r = await m.call("card", { ...base, id: "c4", title: "left open", doneWhen: [human] });
  check(has(/Card "c4" issued/, r), "c4 is issued (not yet done)");
  r = await m.call("card", { ...base, id: "c3", title: "needs c4", requires: ["c4"], doneWhen: [nodeCheck] });
  check(has(/not issued/, r) && has(/c4 \(ISSUED\)/, r), "S4: a requires card that is not KEPT refuses the issue, naming it and its state", r);
  r = await m.call("plan", { action: "close", package: "p1" });
  check(has(/cannot close/, r) && has(/c4 \(ISSUED\)/, r) && !has(/c1/, r.split("Get each")[0]), "a package does not close while a card is not KEPT, naming it", r);
  r = await m.call("plan", { action: "show" });
  check(has(/Cards NOT KEPT: none/, r) && has(/Cards WAITING \(human gate\): none/, r) && has(/Open packages: p1, p2/, r), "plan show lists open packages, NOT KEPT and WAITING cards", r);

  // S3 second half: a worker bound to c4 reports on c2
  r = await m.call("agent_set_role", { role: "analyst", position: "worker", card: "c4" });
  r = await m.call("agent_record_step", { step: "straying", card: "c2", result: "DONE", report: "i did it" });
  check(has(/Step recorded/, r) && has(/report NOT attached/, r) && has(/bound to card "c4"/, r), "S3: a worker recording against another card: the step is recorded, the report is not attached", r);
  r = await m.call("card", { action: "show", card: "c2" });
  check(!has(/i did it/, r), "…and the other card does not carry that report", r);
  r = await m.call("agent_record_step", { step: "c4 done", card: "c4", result: "DONE", report: "ok" });
  check(has(/WAITING \(human gate\)/, r), "c4 (only a [human] line) waits for the human", r);
  r = await m.call("agent_set_role", { role: "analyst", position: "architect" });
  r = await m.call("plan", { action: "close", package: "p1" });
  check(has(/cannot close/, r) && has(/c4 \(WAITING/, r), "a WAITING card holds the package open", r);
  await m.call("card", { action: "judge", card: "c4", kept: true, by: "alex", why: "ok" });
  r = await m.call("plan", { action: "close", package: "p1" });
  check(has(/Package "p1" closed/, r), "the package closes once every card is KEPT and its done-when holds", r);
  r = await m.call("agent_set_role", { role: "analyst", position: "worker", card: "c1" });
  r = await m.call("plan", { action: "close", package: "p2" });
  check(has(/closing a package is the architect's/, r), "S3: a worker cannot close a package", r);
  r = await m.call("agent_set_role", { role: "analyst", position: "worker", card: "nothere" });
  check(has(/There is no card "nothere"/, r), "a worker cannot be bound to a card that does not exist", r);

  // ═══ S5
  head("S5  a scenario line, in a real sandbox");
  if (!DAEMON) {
    if (process.env.C64RE_REQUIRE_RUNTIME === "1") check(false, "C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found");
    else console.log("  SKIPPED - no trx64-daemon (`node dist/cli.js runtime install`). Skipped, NOT passed.");
  } else {
    mkdirSync(join(proj, "tests"), { recursive: true });
    const feat = (v) => ["Feature: a bare machine", "# model: c64-pal", "Scenario: the keyboard buffer length", "  Given a bare machine", "  When I wait 50 frames", `  Then $02A6 is ${v}`, ""].join("\n");
    writeFileSync(join(proj, "tests", "pal-ok.feature"), feat("$01"));
    writeFileSync(join(proj, "tests", "pal-bad.feature"), feat("$00"));
    await m.call("agent_set_role", { role: "analyst", position: "architect" });
    await m.call("plan", { action: "set", packages: [{ id: "p3", title: "Scenario", doneWhen: [{ kind: "registration", text: "r" }] }] });
    for (const [id, file] of [["s-ok", "tests/pal-ok.feature"], ["s-bad", "tests/pal-bad.feature"]]) {
      r = await m.call("card", { ...base, id, package: "p3", title: id, doneWhen: [{ kind: "scenario", file, text: `${file} passes` }] });
      check(has(/issued/, r), `card ${id} is issued`, r);
    }
    r = await m.call("card", { action: "check", card: "s-ok" });
    check(has(/Card s-ok: KEPT/, r) && has(/PASS  \[scenario\]/, r), "S5: `$02A6 is $01` after 50 PAL frames -> KEPT", r);
    r = await m.call("card", { action: "check", card: "s-bad" });
    check(has(/Card s-bad: NOT KEPT/, r) && has(/FAIL  \[scenario\]/, r), "S5: `$02A6 is $00` -> NOT KEPT, naming the scenario", r);
  }
} catch (e) {
  check(false, "script ran", String((e && e.stack) || e));
} finally {
  H.stopMcps();
  H.cleanup();
}
for (let i = 0; i < 40 && liveMachines(tmp.dir).length > 0; i++) await sleep(250);
check(liveMachines(tmp.dir).length === 0, "no machine of this run is left running");
process.exit(T.done());
