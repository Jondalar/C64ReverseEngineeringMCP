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
  // D3 as decided after S6: a worker is a subagent of the same server and sets no position; it names its card.
  r = await m.call("agent_set_role", { role: "analyst", position: "worker" });
  check(!has(/Agent role set/, r), "there is no worker position to set (a worker would overwrite the architect's)", r.slice(0, 160));
  r = await m.call("agent_set_role", { role: "analyst", position: "unset" });
  r = await m.call("card", { ...base, id: "cx", title: "x", doneWhen: [human] });
  check(has(/issuing a card is the architect's/, r) && has(/unset/, r), "S3: a session that is not the architect cannot issue a card", r);
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

  // S3 second half: a report on a KEPT card is not attached; a worker's report names its card as its author
  r = await m.call("agent_record_step", { step: "straying", card: "c2", result: "DONE", report: "i did it" });
  check(has(/Step recorded/, r) && has(/already KEPT/, r), "S3: a report on a KEPT card: the step is recorded, the report is not attached", r);
  r = await m.call("agent_record_step", { step: "c4 done", card: "c4", result: "DONE", report: "ok" });
  check(has(/WAITING \(human gate\)/, r), "c4 (only a [human] line) waits for the human", r);
  r = await m.call("card", { action: "show", card: "c4" });
  check(has(/worker \(card c4\)/, r), "the worker's report is authored by the card it names", r);
  r = await m.call("agent_set_role", { role: "analyst", position: "architect" });
  r = await m.call("plan", { action: "close", package: "p1" });
  check(has(/cannot close/, r) && has(/c4 \(WAITING/, r), "a WAITING card holds the package open", r);
  await m.call("card", { action: "judge", card: "c4", kept: true, by: "alex", why: "ok" });
  r = await m.call("plan", { action: "close", package: "p1" });
  check(has(/Package "p1" closed/, r), "the package closes once every card is KEPT and its done-when holds", r);
  r = await m.call("agent_set_role", { role: "analyst", position: "unset" });
  r = await m.call("plan", { action: "close", package: "p2" });
  check(has(/closing a package is the architect's/, r), "S3: a session that is not the architect cannot close a package", r);
  {
    // an agent state written with the old "worker" position reads as unset, not as an error
    const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
    const sp = join(proj, "knowledge", "agent-state.json");
    const st = JSON.parse(rf(sp, "utf8")); st.position = "worker"; st.card = "c1"; wf(sp, JSON.stringify(st));
    r = await m.call("agent_set_role", { role: "analyst", position: "architect" });
    check(has(/Position: architect/, r), "an old state with position worker loads (as unset) and can be set again", r);
  }

  // S6: a re-planned card supersedes the one that came back, so the package can close
  {
    const reg = { kind: "registration", text: "nothing unregistered" };
    await m.call("agent_set_role", { role: "analyst", position: "architect" });
    await m.call("plan", { action: "set", packages: [{ id: "p9", title: "re-plan", doneWhen: [reg] }] });
    const sb = { action: "issue", package: "p9", role: "analyst", goal: "g", doneWhen: [reg] };
    await m.call("card", { ...sb, id: "s1", title: "first try" });
    await m.call("agent_record_step", { step: "s1 stopped", card: "s1", result: "STOPPED", report: "tool refused" });
    r = await m.call("plan", { action: "close", package: "p9" });
    check(has(/cannot close/, r) && has(/s1 \(STOPPED\)/, r), "a STOPPED card holds the package open", r);
    r = await m.call("card", { ...sb, id: "sx", title: "bad", supersedes: ["c4"] });
    check(has(/cannot supersede/, r) && has(/c4 belongs to package p1/, r), "a card cannot supersede one of another package", r);
    r = await m.call("card", { ...sb, id: "s2", title: "second try", supersedes: ["s1"] });
    check(has(/supersedes s1/, r), "the re-plan is issued with supersedes", r);
    r = await m.call("card", { action: "show", card: "s1" });
    check(has(/SUPERSEDED/, r) && has(/tool refused/, r), "the old card is SUPERSEDED and keeps its report in the history", r);
    r = await m.call("card", { ...sb, id: "s3", title: "after", requires: ["s1"] });
    check(has(/not issued/, r) && has(/s1 \(ISSUED\)/, r), "requires on a superseded card means its replacement (s2, still ISSUED)", r);
    await m.call("agent_record_step", { step: "s2", card: "s2", result: "DONE", report: "ok" });
    r = await m.call("card", { ...sb, id: "s3", title: "after", requires: ["s1"] });
    check(has(/issued/, r) && !has(/not issued/, r), "  and once the replacement is KEPT it is satisfied", r);
    await m.call("agent_record_step", { step: "s3", card: "s3", result: "DONE", report: "ok" });
    r = await m.call("plan", { action: "close", package: "p9" });
    check(has(/Package "p9" closed/, r), "the package closes: the superseded card no longer counts", r);
    r = await m.call("card", { action: "supersede", card: "s2", replacement: "s3" });
    check(has(/cannot supersede/, r) && has(/only a STOPPED or NOT KEPT card/, r), "a KEPT card is not superseded", r);

    // usage: the architect records what each run cost, from the harness notification
    r = await m.call("card", { action: "usage", card: "s1", model: "sonnet", tokens: 71880, tool_uses: 7, duration_ms: 23056 });
    check(has(/Usage recorded on card "s1": sonnet 71,880 tokens/, r), "usage is recorded on a superseded card too (the failed run cost as much)", r);
    await m.call("card", { action: "usage", card: "s2", model: "sonnet", tokens: 73584 });
    r = await m.call("card", { action: "usage", card: "s2", model: "sonnet", tokens: 0 });
    check(has(/positive whole number/, r), "tokens must be a positive whole number", r);
    r = await m.call("plan", { action: "usage", package: "p9", model: "opus", tokens: 309600, tool_uses: 133 });
    check(has(/Architect usage recorded on package "p9": opus 309,600/, r), "the architect's own run is recorded on the package", r);
    r = await m.call("plan", { action: "show" });
    check(has(/p9 - re-plan \[closed\].*usage 455,064 tokens \(workers 145,464, architect 309,600; sonnet 145,464, opus 309,600\)/, r) && has(/Usage so far: 455,064 tokens/, r), "plan show sums usage per package, by worker/architect and by model", r.split("\n").filter((l) => /usage|Usage/.test(l)).join(" | "));
    r = await m.call("card", { action: "show", card: "s1" });
    check(has(/Usage:/, r) && has(/sonnet 71,880 tokens, 7 tool calls, 23 s/, r), "card show lists its runs' usage", r);
    await m.call("agent_set_role", { role: "analyst", position: "unset" });
    r = await m.call("card", { action: "usage", card: "s2", model: "sonnet", tokens: 1 });
    check(has(/the architect's/, r), "only the architect records usage", r);
    await m.call("agent_set_role", { role: "analyst", position: "architect" });

    // a package whose last line is [human]: the human closes it, and the line shows kept, by whom
    await m.call("plan", { action: "set", packages: [{ id: "p10", title: "read the doc", doneWhen: [reg, { kind: "human", text: "owner read the doc" }] }] });
    r = await m.call("plan", { action: "close", package: "p10" });
    check(has(/WAITING \(human gate\)/, r) && !has(/closed/, r), "a package with a [human] line waits for the human's close", r);
    r = await m.call("plan", { action: "close", package: "p10", by: "alex", why: "read it" });
    check(has(/Package "p10" closed \(human gate: alex: read it\)/, r) && has(/PASS  \[human\] owner read the doc - kept by alex/, r) && !has(/WAITING/, r), "the human's close shows the [human] line as kept, by whom", r);
  }

  // ═══ D1 / D5 / P5 / S0: next step reads the plan, the card is the briefing, change-validate is handed out
  head("D1  next step reads the plan; D5 the card is the briefing; P5 change-validate");
  {
    const q = await H.project("q917");
    const qslug = readProjectSlug(q);
    const { saveContract } = await load("contract/contract.js");
    const m2 = await H.mcp(q, {});
    const stepOf = (t) => (t.match(/"step": "([^"]+)"/u) ?? [])[1];
    const jsonOf = (t) => { const mm = t.match(/```json\n([\s\S]*?)\n```/u); return mm ? JSON.parse(mm[1]) : {}; };
    await m2.call("project_inventory_sync", {});
    const before = await m2.call("agent_next_step", {});
    const baseStep = stepOf(before);
    check(!!baseStep && !/^plan-/u.test(baseStep), "without a plan next step is today's ladder, not a plan step", String(baseStep));

    // onboarding: the plan block when a contract exists and no plan does
    r = await m2.call("agent_onboard", {});
    check(!has(/## ▶ The plan/, r), "onboarding without a contract has no plan block (the contract comes first)");
    saveContract(q, { goal: "name the lift", deliver: { slots: ["context"] } });
    r = await m2.call("agent_onboard", {});
    check(has(/## ▶ The plan/, r) && has(/No plan yet/, r) && has(/work packages, their order/, r) && has(/`plan` action `set`/, r), "onboarding with a contract and no plan asks for the plan and names plan set", r.slice(r.indexOf("## ▶ The plan"), r.indexOf("## ▶ The plan") + 400));

    // change-validate is handed out
    r = await m2.call("agent_run_step", { step_id: "change-validate" });
    check(!has(/blocked until/i, r) && has(/runtime_feature_run/, r), "change-validate is not blocked: agent_run_step names runtime_feature_run", r);
    check(m2.tools.some((t) => t.name === "runtime_feature_run"), "runtime_feature_run is on the default surface");
    {
      const { workflowStep } = await load("agent-orchestrator/workflow-model.js");
      const cv = workflowStep("change-validate");
      check(cv.defaultTool === "runtime_feature_run" && cv.blockedUntil === undefined && /baseline fails/.test(cv.title), "change-validate: tool runtime_feature_run, no blockedUntil, title names the test-mode scenario", cv.title);
    }

    // a [contract] line must name a promise the contract makes — a typo would pass forever
    r = await m2.call("plan", { action: "set", packages: [{ id: "px", title: "typo", doneWhen: [{ kind: "contract", promise: "contxt", text: "slot context" }] }] });
    check(has(/states no promise "contxt"/, r) && has(/context/, r) && !has(/Plan set/, r), "plan set refuses a [contract] line naming an unstated promise, listing the stated ones", r);
    {
      const { evaluateChecks } = await load("work/checks.js");
      const { results: [res] } = await evaluateChecks(q, [{ kind: "contract", promise: "contxt", text: "slot context" }]);
      check(res.pass === false && /states no promise/.test(res.detail), "  and evaluation fails it too (a contract changed after the card was issued)", res.detail);
    }

    // the plan
    r = await m2.call("plan", { action: "set", packages: [
      { id: "p1", title: "Name the lift", doneWhen: [nodeCheck] },
      { id: "p2", title: "Fix the lift", doneWhen: [{ kind: "registration", text: "nothing on disk is unregistered" }] },
    ] });
    check(has(/Plan set: 2 package/, r), "the plan is set (position unset may write it)", r);
    r = await m2.call("agent_onboard", {});
    check(has(/## ▶ The plan/, r) && has(/1\. p1 - Name the lift/, r) && !has(/No plan yet/, r), "onboarding with a plan prints the plan standing", r.slice(r.indexOf("## ▶ The plan"), r.indexOf("## ▶ The plan") + 300));
    r = await m2.call("agent_next_step", {});
    let j = jsonOf(r);
    check(j.step === "plan-next-card" && j.primary_action.tool === "card" && j.primary_action.args.action === "issue" && j.primary_action.args.package === "p1", "open package without a card -> plan-next-card, tool card issue", r);
    await m2.call("agent_set_role", { role: "analyst", position: "architect" });
    r = await m2.call("card", { ...base, id: "a1", title: "name it", doneWhen: [nodeCheck] });
    check(has(/Card "a1" issued/, r), "the architect issues a1", r);
    j = jsonOf(await m2.call("agent_next_step", {}));
    check(j.step === "plan-await-workers" && /a1/.test(j.reason), "a card issued and not reported -> plan-await-workers, naming it", j.reason);

    // the briefing
    {
      const pr = await m2.rpc("prompts/get", { name: "c64re_worker_card", arguments: { card_id: "a1" } });
      const t = pr.result?.messages?.[0]?.content?.text ?? JSON.stringify(pr);
      check(has(/Worker briefing - card a1: name it/, t) && has(/\[graph\] the routine at \$0A20/, t) && has(/main_disasm\.tas:812-840/, t) && has(/the code differs/, t), "c64re_worker_card renders the card: fields and done-when with kind tags", t);
      check(has(/Read only what the card lists/, t) && has(/Start no further subagents/, t) && has(/Stop on any Stop-if line/, t) && has(/agent_record_step\(card="a1", result="DONE"\|"STOPPED", report=<at most 10 lines>\)/, t) && has(/C64RE judges the done-when/, t), "…with the fixed worker rules and the record_step line", t);
      const none = await m2.rpc("prompts/get", { name: "c64re_worker_card", arguments: { card_id: "zz" } });
      check(has(/There is no card "zz"/, none.result?.messages?.[0]?.content?.text ?? ""), "an unknown card id answers with a sentence, not a crash");
      const list = (await m2.rpc("prompts/list", {})).result?.prompts?.map((x) => x.name) ?? [];
      check(list.includes("c64re_worker_card") && !list.includes("c64re_worker_phase"), "the prompt list has c64re_worker_card and no c64re_worker_phase", list.join(","));
    }
    r = await m2.call("agent_propose_next", {});
    check(has(/## Cards/, r) && has(/c64re_worker_card\(card_id="a1"\)/, r) && !has(/worker_phase|Spawn worker subagent/, r), "agent_propose_next: the architect is pointed to c64re_worker_card for the issued card, no phase worker", r);
    await m2.call("agent_set_role", { role: "analyst", position: "unset" });
    r = await m2.call("agent_propose_next", {});
    check(!has(/## Cards|worker_phase|Spawn worker subagent/, r), "agent_propose_next proposes no worker without a card (position unset)", r);

    // NOT KEPT -> re-plan
    await m2.call("agent_record_step", { step: "named", card: "a1", result: "DONE", report: "named" });
    j = jsonOf(await m2.call("agent_next_step", {}));
    check(j.step === "plan-replan" && j.primary_action.tool === "card" && j.primary_action.args.action === "show" && j.primary_action.args.card === "a1", "a card NOT KEPT -> plan-replan, card show", JSON.stringify(j.primary_action));
    check(!(j.secondary_actions ?? []).some((x) => x.step === "plan-gate"), "no human-gate branch is offered when no card waits", JSON.stringify((j.secondary_actions ?? []).map((x) => x.step)));
    {
      // S6: stale views alone must not hide the card; an untracked file still comes first
      const { utimesSync, writeFileSync: wf, rmSync: rm, mkdirSync: md } = await import("node:fs");
      const old = new Date(Date.now() - 3600_000);
      utimesSync(join(q, "views", "project-dashboard.json"), old, old);
      j = jsonOf(await m2.call("agent_next_step", {}));
      check(j.step === "plan-replan" && /view\(s\) stale/.test(j.reason), "stale views do not outrank a NOT KEPT card; the step names them", `${j.step}: ${j.reason.slice(-90)}`);
      md(join(q, "docs"), { recursive: true }); wf(join(q, "docs", "stray.md"), "# stray\n");
      j = jsonOf(await m2.call("agent_next_step", {}));
      check(j.step === "inventory-sync", "an untracked file still comes before the plan (it would make [registration] lie)", j.step);
      rm(join(q, "docs", "stray.md"));
    }
    nameNode(q, { parts: { slug: qslug, ctx: { space: "ram", owner: "main" }, kind: "routine", address: 0x0a20 }, kind: "routine", name: "lift_init" });
    await m2.call("agent_set_role", { role: "analyst", position: "architect" });
    r = await m2.call("card", { action: "check", card: "a1" });
    check(has(/Card a1: KEPT/, r), "after the routine is named a re-check keeps a1", r);
    j = jsonOf(await m2.call("agent_next_step", {}));
    check(j.step === "plan-close" && j.primary_action.tool === "plan" && j.primary_action.args.package === "p1", "every card of the package KEPT, package open -> plan-close", JSON.stringify(j.primary_action));

    // WAITING -> human question
    r = await m2.call("card", { ...base, id: "a3", title: "feels right", doneWhen: [human] });
    await m2.call("agent_record_step", { step: "a3", card: "a3", result: "DONE" });
    r = await m2.call("agent_next_step", {});
    j = jsonOf(r);
    check(j.step === "plan-gate" && /a3/.test(j.human_question ?? "") && /\[human\] the lift feels right in level 3/.test(j.human_question ?? "") && j.blocked_by.some((b) => b.id === "card-gate"), "a card WAITING -> human_question names the card and its [human] line", j.human_question);
    await m2.call("agent_set_role", { role: "analyst", position: "architect" });
    await m2.call("card", { action: "judge", card: "a3", kept: true, by: "alex", why: "ok" });
    j = jsonOf(await m2.call("agent_next_step", {}));
    check(j.step === "plan-close", "after the human gate the package is ready to close again", j.step);
    r = await m2.call("plan", { action: "close", package: "p1" });
    check(has(/Package "p1" closed/, r), "p1 closes", r);
    j = jsonOf(await m2.call("agent_next_step", {}));
    check(j.step === "plan-next-card" && j.primary_action.args.package === "p2", "next open package without a card -> plan-next-card for p2", JSON.stringify(j.primary_action));
  }

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
