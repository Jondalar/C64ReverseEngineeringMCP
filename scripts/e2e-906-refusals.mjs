#!/usr/bin/env node
// Sandbox sessions: everything that needs no daemon.
//
//   S1 a call without a purpose or a budget is refused by name; a runtime that does not start leaves nothing behind
//   S2 every registered runtime tool has a sandbox verdict, derived from the live server (a new runtime tool without
//      one fails here); every tool that serves a human's UI refuses a sandbox id by name, with its reason
//   S3 an id that is another process's is "not yours"; one that ended says so; one that never was says that
//   S5 a record the keeper closed ("budget", "owner gone") is what the next caller is told
//   S7 the C64U refusal of a live trace names runtime_sandbox_start; the doors and the doctrine describe sandbox sessions
//
// No daemon, no ROM, no :4312: the MCP server under test is pointed at a closed port. The runtime half is e2e:906.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, ROOT, load, makeChecker, pidAlive, sleep } from "./lib/e2e-906-harness.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }

const T = makeChecker("e2e-906-refusals");
const { check, head } = T;
const H = new Harness("c64re-906r-");
const proj = await H.project("proj");
const noRuntime = "ws://127.0.0.1:9";
const isErr = (t) => /^# [Tt]ool [Ee]rror/.test(t);

const { collectToolInventory } = await load("server.js");
const parity = await load("runtime/sandbox-parity.js");
const { DEFAULT_TOOLS, DEFAULT_TIER_CAP, tierForTool } = await load("server-tools/tier-tools.js");
const routing = await load("runtime/c64u/routing.js");

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("the doors exist, on the default surface, and say what they are");
const inventory = collectToolInventory();
const registered = inventory.map((t) => t.name);
const desc = (n) => inventory.find((t) => t.name === n)?.description ?? "";
for (const n of ["runtime_sandbox_start", "runtime_sandbox_end", "runtime_sandbox_list"]) {
  check(registered.includes(n) && DEFAULT_TOOLS.has(n) && tierForTool(n) === "default", `${n} is registered and in DEFAULT_TOOLS (a tool that is not listed there is invisible)`);
}
check(inventory.filter((t) => tierForTool(t.name) === "default").length <= DEFAULT_TIER_CAP, "the default surface is within its documented cap");
{
  const d = desc("runtime_sandbox_start");
  check(/OWN/.test(d) && /purpose/.test(d) && /budget/.test(d), "runtime_sandbox_start says the machine is your own, started for a purpose, with a budget");
  check(/invisible to the workbench UI/.test(d) && /not yours/.test(d) && /never reaches the shared session/.test(d), "…that it is invisible to the UI and to other processes and never reaches the shared session");
  check(/ends\s+ITSELF/i.test(d) && /idle limit/.test(d) && /MCP process dies/.test(d), "…that it ends itself on its budget, its idle limit and its owner's death");
  check(/COPY/.test(d) && /step log/.test(d), "…that a medium is mounted as a copy and the outcome goes into the step log");
  check(/runtime_sandbox_run/.test(d) && /runtime_session_start/.test(d) && /runtime_scene_reel/.test(d), "…and points at the one-call run, the shared session and the reel for what it is not");
  check(!/\bSpec\s+\d/i.test(d), "no spec citation in a default description");
  check(/\bUse\b/.test(d) && /Not a|Not for/.test(d), "it carries the Use-trigger and the alternatives");
}
check(/runtime_sandbox_start/.test(desc("runtime_sandbox_run")) && /NO session id/.test(desc("runtime_sandbox_run")), "runtime_sandbox_run still says it returns no session id — and now where the machine that stays is");
check(!/second shared machine/.test(desc("runtime_sandbox_run")), "…and no longer argues that a machine you could come back to would be a second shared one");
check(/runtime_sandbox_start/.test(desc("runtime_session_start")) && /SHARED/.test(desc("runtime_session_start")), "runtime_session_start says it is the shared machine and names runtime_sandbox_start for one of your own");
check(/runtime_sandbox_start/.test(desc("runtime_keep_alive")), "runtime_keep_alive names the sandbox session's own lifetime");
for (const n of ["runtime_session_run", "runtime_trace_finalize", "runtime_until"]) {
  check(registered.includes(n), `${n} is there for the long-call path`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S2  every runtime tool has a verdict — from the code");
check(parity.unclassifiedRuntimeTools(registered).length === 0, "no registered runtime tool lacks a sandbox verdict", parity.unclassifiedRuntimeTools(registered).join(", "));
check(parity.staleParityEntries(registered).length === 0, "the table names no tool that is not registered", parity.staleParityEntries(registered).join(", "));
const verdicts = Object.entries(parity.SANDBOX_PARITY);
const uiOnly = verdicts.filter(([, v]) => v.verdict === "ui-only");
check(uiOnly.length >= 9 && uiOnly.every(([, v]) => v.reason.length > 20), `${uiOnly.length} tools are ui-only, each with a reason`, uiOnly.map(([k]) => k).join(", "));
{
  // the live server, full tool set: the ui-only tools take a session_id (added at registration) and refuse a sandbox id before anything runs
  const m = await H.mcp(proj, { endpoint: noRuntime, env: { C64RE_FULL_TOOLS: "1" } });
  const live = new Set(m.tools.map((t) => t.name));
  check(uiOnly.every(([k]) => live.has(k)), "the full server lists every ui-only tool", uiOnly.filter(([k]) => !live.has(k)).map(([k]) => k).join(","));
  for (const [tool, v] of uiOnly) {
    const schemaHasSid = !!m.tools.find((t) => t.name === tool)?.inputSchema?.properties?.session_id;
    // minimal valid arguments for the ones that require some
    const extra = tool === "runtime_input_save_config" ? { action: { kind: "key", matrix: "A" } }
      : tool === "runtime_backend" ? { action: "list" }
      : tool === "runtime_session_export_audio" ? { out_path: join(H.dir, "a.wav"), duration_sec: 1 } : {};
    const r = await m.call(tool, { session_id: "sb-fake-1", ...extra });
    check(schemaHasSid && /refused for sandbox session sb-fake-1/.test(r) && /Nothing was done/.test(r) && r.includes(v.reason.slice(0, 30)), `${tool} refuses a sandbox id by name and says why`, r.slice(0, 220));
  }
  // …and does NOT refuse the shared session's id, nor no id at all: the guard is for sandbox ids only
  const ok = await m.call("runtime_keep_alive", { session_id: "shared" });
  check(!/refused for sandbox session/.test(ok), "the shared session's id passes the guard");
  m.stop();
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S1  refusals by name, and a runtime that does not start leaves nothing");
{
  const m = await H.mcp(proj, { endpoint: noRuntime });
  const a = await m.call("runtime_sandbox_start", { budget_minutes: 5 });
  check(/refused/.test(a) && /`purpose` is required/.test(a) && /Nothing was started/.test(a), "no purpose: refused, naming `purpose`", a);
  check(/refused/.test(await m.call("runtime_sandbox_start", { purpose: "   ", budget_minutes: 5 })), "a blank purpose is no purpose");
  const b = await m.call("runtime_sandbox_start", { purpose: "p" });
  check(/refused/.test(b) && /`budget_minutes` is required/.test(b) && /Nothing was started/.test(b), "no budget: refused, naming `budget_minutes`", b);
  check(/budget_minutes must be above 0 and at most 240/.test(await m.call("runtime_sandbox_start", { purpose: "p", budget_minutes: 241 })), "a budget above 240 minutes is refused");
  check(/budget_minutes must be above 0/.test(await m.call("runtime_sandbox_start", { purpose: "p", budget_minutes: 0 })), "a budget of 0 is refused");
  check(/no such medium/.test(await m.call("runtime_sandbox_start", { purpose: "p", budget_minutes: 5, media_path: "nope.prg" })), "a medium that does not exist is refused before a daemon starts");
  check(/run must be an address/.test(await m.call("runtime_sandbox_start", { purpose: "p", budget_minutes: 5, run: "zz" })), "a `run` that is not an address is refused");
  m.stop();

  // a runtime binary that quits at once: the start fails with the runtime's own words and nothing is left running or recorded
  const stub = join(H.dir, "dies.mjs");
  writeFileSync(stub, 'console.error("[stub] cannot start: no ROMs here"); process.exit(3);\n');
  const m2 = await H.mcp(proj, { endpoint: noRuntime, env: { C64RE_RUNTIME_BIN: stub } });
  const r = await m2.call("runtime_sandbox_start", { purpose: "a runtime that does not start", budget_minutes: 5 });
  check(/did not start/.test(r) && /no ROMs here/.test(r), "a runtime that exits at once: the start says so, with the runtime's own words", r.slice(0, 260));
  const list = await m2.call("runtime_sandbox_list", {});
  check(/0 of 4/.test(list), "…and no session is held", list);
  const recs = existsSync(join(H.state, "sandbox-sessions")) ? readdirSync(join(H.state, "sandbox-sessions")) : [];
  check(recs.every((f) => { try { return JSON.parse(readFileSync(join(H.state, "sandbox-sessions", f), "utf8")).state !== "running"; } catch { return true; } }), "…and no record claims a running sandbox", recs.join(","));
  m2.stop();
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S3 / S5  not yours, ended, and never was — from the records");
{
  const recDir = join(H.state, "sandbox-sessions");
  mkdirSync(recDir, { recursive: true });
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  H.cleanups.push(() => other.kill("SIGKILL"));
  const rec = (id, o) => writeFileSync(join(recDir, `${id}.json`), JSON.stringify({
    v: 1, id, ownerPid: other.pid, port: 1, purpose: "somebody else's work", projectDir: proj,
    startedAt: new Date(Date.now() - 60000).toISOString(), deadline: new Date(Date.now() + 60000).toISOString(),
    budgetMinutes: 5, idleMinutes: 10, state: "running", ...o,
  }));
  rec("sb-theirs-1", {});
  rec("sb-budget-1", { state: "ended", reason: "budget", outcome: "budget", endedAt: "2026-10-14T12:00:00.000Z" });
  rec("sb-gone-1", { ownerPid: 2147483646 });
  rec("sb-idle-1", { state: "ended", reason: "idle", outcome: "idle", endedAt: "2026-10-14T12:30:00.000Z", logged: true });
  const m = await H.mcp(proj, { endpoint: noRuntime });
  const notYours = await m.call("runtime_monitor_registers", { session_id: "sb-theirs-1" });
  check(/not yours/.test(notYours) && /somebody else's work/.test(notYours) && /runtime_sandbox_start/.test(notYours), "a running sandbox of another live process: \"not yours\", naming whose and what for", notYours.slice(0, 300));
  check(/not yours/.test(await m.call("runtime_sandbox_end", { session_id: "sb-theirs-1", outcome: "failed", summary: "mine now" })), "…and it cannot be ended by anyone else");
  check(!/sb-theirs-1/.test(await m.call("runtime_sandbox_list", {})), "…and it is not in this process's list");
  const budget = await m.call("runtime_monitor_registers", { session_id: "sb-budget-1" });
  check(/ended: budget at 2026-10-14T12:00:00/.test(budget) && !/no sandbox session/.test(budget), "a sandbox the keeper ended on its budget: \"ended: budget at <time>\"", budget.slice(0, 260));
  const idle = await m.call("runtime_monitor_registers", { session_id: "sb-idle-1" });
  check(/ended: idle at/.test(idle), "…on its idle limit: \"ended: idle at <time>\"");
  const gone = await m.call("runtime_monitor_registers", { session_id: "sb-gone-1" });
  check(/ended: owner gone at/.test(gone) && !/not yours/.test(gone), "a running record whose owner process is dead: \"ended: owner gone\", not \"not yours\"", gone.slice(0, 260));
  const never = await m.call("runtime_monitor_registers", { session_id: "sb-never-1" });
  check(/no sandbox session "sb-never-1"/.test(never) && /runtime_sandbox_start/.test(never), "an id that never existed is told apart from an ended one", never.slice(0, 200));
  // the keeper's close of a record is logged by the next process that looks at it, once
  const logged = (() => { try { return JSON.parse(readFileSync(join(proj, "knowledge", "agent-state.json"), "utf8")).history.map((h) => h.step).join("\n"); } catch { return ""; } })();
  check(logged.includes("sb-budget-1") && logged.includes("ended (budget)") && logged.includes("somebody else's work"), "the budget end the keeper recorded is written into the project's step log by the first process that asks", logged.slice(-300));
  const again = await m.call("runtime_monitor_registers", { session_id: "sb-budget-1" });
  const logged2 = JSON.parse(readFileSync(join(proj, "knowledge", "agent-state.json"), "utf8")).history.filter((h) => h.step.includes("sb-budget-1"));
  check(/ended: budget/.test(again) && logged2.length === 1, "…once, not on every ask", String(logged2.length));
  m.stop();
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S7  the C64U refusal names the way out; the doctrine says what is built");
{
  const w = routing.routeOf("trace/start_domains");
  check(w.kind === "refuse" && /runtime_sandbox_start/.test(w.wayOut), "a live trace on the C64 Ultimate is refused, and the way out names runtime_sandbox_start", w.wayOut);
  check(/runtime_sandbox_start/.test(routing.routeOf("runtime/overlay_run").wayOut) && /runtime_sandbox_run/.test(routing.routeOf("runtime/overlay_run").wayOut), "the emulator-only methods name both machines of your own");
  const r = routing.routeOf("trace/read");
  check(r.kind === "refuse" && /emulator reader/.test(r.wayOut), "a direct trace/read on the device says the tools read a store with an emulator reader instead", r.wayOut ?? "");
  const rd = (p) => readFileSync(join(ROOT, p), "utf8");
  const doctrine = rd("DOCTRINE.md");
  check(/runtime_sandbox_start/.test(doctrine) && /purpose/.test(doctrine) && /owner gone/.test(doctrine), "DOCTRINE.md rule 2 describes sandbox sessions: purpose, budget, the ends");
  check(!/Spec 836[^.]*no session id/i.test(doctrine.replace(/\n/g, " ").split("Retired")[0] ?? ""), "…and the no-session-id rule is not carried as current");
  const doc = rd("docs/runtime-sandbox.md");
  check(/runtime_sandbox_start/.test(doc) && /runtime_sandbox_end/.test(doc) && /ended: /.test(doc) && /not yours/.test(doc), "docs/runtime-sandbox.md describes the session: start, end, how it ends itself, whose it is");
  check(!/deliberate-limitation: runtime_sandbox_run — it returns no session id BY DESIGN/.test(doc) || /runtime_sandbox_start/.test(doc), "…and does not present 'no session' as the only shape of a sandbox");
  const tool = rd("docs/tools/headless.md");
  check(/runtime_sandbox_start/.test(tool) && /runtime_sandbox_end/.test(tool) && /runtime_sandbox_list/.test(tool) && /analysis_job_status/.test(tool), "docs/tools/headless.md documents the three doors and the long-call path", "");
  check(/runtime_sandbox_start/.test(rd("docs/tools/sandbox.md")), "docs/tools/sandbox.md (the CPU sandbox) points at the machine that stays");
  check(!/\bSpec\s+\d{3}/.test(doc) && !/\b906\b/.test(doc) && !/\b906\b/.test(tool), "the user docs carry no spec number for this behaviour (docs/runtime-sandbox.md has none at all)");
  const agentDoc = rd("docs/agent-doctrine.md");
  check(/runtime_sandbox_start/.test(agentDoc) && !/still needs a daemon you\s+start yourself/.test(agentDoc), "docs/agent-doctrine.md points the interactive loop at runtime_sandbox_start, not at a daemon to start by hand");
  const trace = rd("src/server-tools/trace-read.ts");
  check(!/have no native reader yet/.test(trace), "the stale comment about trace/read ops with no native reader is gone");
}

H.cleanup();
process.exit(T.done("no daemon"));
