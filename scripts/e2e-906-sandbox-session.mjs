#!/usr/bin/env node
// A machine of your own that stays: the LLM starts a sandbox session for a purpose, drives it with the same
// runtime_* tools as the shared session, and ends it — or it ends itself.
//
//   S1 start for a purpose      session id, port, machine, deadline; the shared session byte-for-byte unchanged;
//                               no purpose / no budget refused by name
//   S2 the full feature set     every runtime tool on the parity list (derived from the live server, so a new runtime tool
//                               without a verdict fails here) called with a sandbox id and compared with the same
//                               call on a shared session in the same state; the ui-only tools refuse the id by name
//   S3 side by side             two sandboxes started by two MCP processes + the shared session, stepped, breakpointed and
//                               traced at once; no trace holds another machine's events; "not yours"; the UI sees one
//   S4 ending                   reached / failed: daemon gone, port free, scratch removed, captures kept and listed,
//                               outcome in the step log
//   S5 ending itself            budget, idle, owner killed: within seconds, a trace in progress finalized, the id answers
//                               "ended: <reason> at <time>"
//   S6 a long capture           job mode past the grace window (always); the 60M-cycle capture with the drive-mechanism lane
//                               only behind C64RE_E2E_LONG=1
//   S7 doors                    with a fake C64 Ultimate selected: the refusal names runtime_sandbox_start, following it
//                               works, and a store file is read by an emulator reader instead of refused
//
// Daemons of this run's own on free ports, a state directory of the run, synthetic media built here. It SKIPS LOUDLY
// when there is no trx64-daemon binary. Nothing here touches :4312 or the owner's session.
//   Locally:  C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:906
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { d64WithPrg } from "./lib/d64-fixture.mjs";
import { walk, normalize } from "./lib/e2e-906-walk.mjs";
import { Harness, ROOT, counterPrg, findDaemon, listening, load, loopPrg, makeChecker, pidAlive, processesMatching, scratchDirs, sleep } from "./lib/e2e-906-harness.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }

const T = makeChecker("e2e-906");
const { check, head } = T;
const sha = (s) => createHash("sha256").update(s).digest("hex");

const DAEMON = await findDaemon();
if (!DAEMON) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED the daemon half — no trx64-daemon binary (set C64RE_RUNTIME_BIN, or `c64re runtime install`). Skipped, NOT passed. The refusal half is e2e:906-refusals.");
  process.exit(0);
}
process.env.C64RE_RUNTIME_BIN = DAEMON;
console.log(`runtime: ${DAEMON}`);

const H = new Harness("c64re-906-");
process.env.C64RE_STATE_DIR = H.state; // this script reads the process ledger of the run, not the owner's
const { bootSandbox } = await load("reel/session-boot.js");
const { SANDBOX_PARITY } = await load("runtime/sandbox-parity.js");
const { collectToolInventory } = await load("server.js");

const idOf = (s) => /\bsb-[a-z0-9-]+\b/.exec(s)?.[0];
const portOf = (s) => Number(/on port (\d+)/.exec(s)?.[1]);

// ── the synthetic media ─────────────────────────────────────────────────────────────────────────
const proj = await H.project("proj");
const prgA = join(proj, "a.prg");
writeFileSync(prgA, loopPrg());
const d64 = join(proj, "t.d64");
writeFileSync(d64, d64WithPrg("LOOP", loopPrg()));

// the stand-in for the shared session: a daemon of this run's own, in a project of its own
const sharedProj = await H.project("shared-proj");
const shared = await H.daemon(DAEMON, sharedProj);
const sws = await H.ws(shared.port);
const sharedCall = (m, p) => sws.call(m, p ?? {});

/** Everything about the shared machine that "unchanged" has to mean: clock, registers, run state, all of RAM. */
async function shot() {
  const st = await sharedCall("session/state");
  const lo = await sharedCall("session/read_memory", { ranges: [{ addr: 0, len: 0x8000, lens: "ram" }] });
  const hi = await sharedCall("session/read_memory", { ranges: [{ addr: 0x8000, len: 0x8000, lens: "ram" }] });
  return JSON.stringify({ cycles: st.c64Cycles, cpu: st.cpu, runState: st.runState, ram: sha(JSON.stringify([lo, hi])) });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S1  start for a purpose");
const mcp = await H.mcp(proj, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
// the shared machine is brought to a state of its own: the same program running
await bootSandbox(sharedCall, { mediaPath: prgA });
const before = await shot();

const noPurpose = await mcp.call("runtime_sandbox_start", { budget_minutes: 5 });
check(/refused/.test(noPurpose) && /purpose/.test(noPurpose) && /Nothing was started/.test(noPurpose), "no purpose is refused, naming `purpose`", noPurpose);
const noBudget = await mcp.call("runtime_sandbox_start", { purpose: "p" });
check(/refused/.test(noBudget) && /budget_minutes/.test(noBudget) && /Nothing was started/.test(noBudget), "no budget is refused, naming `budget_minutes`", noBudget);
check(/budget_minutes must be/.test(await mcp.call("runtime_sandbox_start", { purpose: "p", budget_minutes: 9999 })), "a budget above the maximum is refused");

const started = await mcp.call("runtime_sandbox_start", { purpose: "S1 start for a purpose", budget_minutes: 5, media_path: "a.prg" });
const sbS1 = idOf(started);
check(/^SANDBOX SESSION sb-/.test(started) && !!sbS1, "start answers a session id sb-…", started.slice(0, 200));
check(portOf(started) > 0 && portOf(started) !== shared.port, "…its own port, not the shared one", String(portOf(started)));
check(/machine: c64-pal/.test(started) && /deadline: \d{4}-\d\d-\d\dT/.test(started), "…the machine it booted and the deadline", started);
check(/PAUSED/.test(started) && /cycle \d+/.test(started), "…and says it stands paused at a cycle");
check((await shot()) === before, "the shared session's cycle, registers, run state and all of RAM are byte-for-byte unchanged by the start");
const list1 = await mcp.call("runtime_sandbox_list", {});
check(list1.includes(sbS1) && /S1 start for a purpose/.test(list1) && /1 of 4/.test(list1), "runtime_sandbox_list shows it with its purpose", list1);
const ledger = JSON.parse(readFileSync(join(H.state, "sandbox-sessions", `${sbS1}.json`), "utf8"));
check(ledger.ownerPid === mcp.proc.pid && ledger.port === portOf(started) && ledger.state === "running", "its record names the owner pid and the port", JSON.stringify(ledger).slice(0, 300));
const end1 = await mcp.call("runtime_sandbox_end", { session_id: sbS1, outcome: "reached", summary: "S1 done" });
check(/ended: reached/.test(end1), "ended again at the end of S1", end1.slice(0, 120));
check((await shot()) === before, "…and the shared session is still the same after the sandbox is gone");


// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S1  the limit: four live sandbox sessions per MCP process");
{
  const proj1b = await H.project("s1b");
  const m1b = await H.mcp(proj1b, { endpoint: shared.endpoint });
  const ids = [];
  for (let i = 1; i <= 4; i++) {
    const t = await m1b.call("runtime_sandbox_start", { purpose: `limit ${i}`, budget_minutes: 5 });
    ids.push(idOf(t));
  }
  check(ids.every(Boolean) && new Set(ids).size === 4, "four sandbox sessions start in one MCP process", ids.join(","));
  const fifth = await m1b.call("runtime_sandbox_start", { purpose: "limit 5", budget_minutes: 5 });
  check(/already holds 4 sandbox sessions/.test(fifth) && ids.every((id, i) => fifth.includes(id) && fifth.includes(`limit ${i + 1}`)) && /Nothing was started/.test(fifth), "the 5th is refused, naming the four and their purposes", fifth.slice(0, 400));
  check(/4 of 4/.test(await m1b.call("runtime_sandbox_list", {})), "…and nothing was added");
  const endedOne = await m1b.call("runtime_sandbox_end", { session_id: ids[0], outcome: "reached", summary: "make room" });
  const sixth = await m1b.call("runtime_sandbox_start", { purpose: "limit again", budget_minutes: 5 });
  check(/ended: reached/.test(endedOne) && /^SANDBOX SESSION sb-/.test(sixth), "ending one makes room for another");
  for (const id of [...ids.slice(1), idOf(sixth)]) await m1b.call("runtime_sandbox_end", { session_id: id, outcome: "reached", summary: "limit test over" });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S2  the full feature set, tool by tool");
const calledOnSandbox = new Set();
const isErr = (t) => /^# (?:T|t)ool (?:E|e)rror/.test(t);
// the registered runtime tools come from the live server's code, never from a list kept here
const registered = collectToolInventory().map((t) => t.name);
const parity = await load("runtime/sandbox-parity.js");
check(parity.unclassifiedRuntimeTools(registered).length === 0, "every registered runtime tool has a sandbox verdict (works / ui-only)", parity.unclassifiedRuntimeTools(registered).join(", "));
check(parity.staleParityEntries(registered).length === 0, "…and the table names no tool that is not registered", parity.staleParityEntries(registered).join(", "));
const liveTools = new Set(mcp.tools.map((t) => t.name));
const missingFromSurface = registered.filter((n) => /^runtime_/.test(n) && !liveTools.has(n));
check(missingFromSurface.length === 0, "the MCP server under test (full tool set) lists every registered runtime tool", missingFromSurface.join(", "));

// the shared stand-in is brought to the same state the sandbox is started in
const sharedS2 = await H.daemon(DAEMON, await H.project("shared-s2"));
const sharedS2Ws = await H.ws(sharedS2.port);
await bootSandbox((m, p) => sharedS2Ws.call(m, p ?? {}), { mediaPath: prgA });
const mcpS2 = await H.mcp(proj, { endpoint: sharedS2.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
const s2 = await mcpS2.call("runtime_sandbox_start", { purpose: "S2 parity walk", budget_minutes: 20, media_path: "a.prg" });
const sbS2 = idOf(s2);
check(!!sbS2, "a sandbox session for the walk", s2.slice(0, 200));
{
  const a = await sharedS2Ws.call("session/state");
  const b = JSON.parse((await mcpS2.call("runtime_monitor_registers", { session_id: sbS2 })));
  check(a.cpu.pc === b.pc && a.c64Cycles === b.cycles, "both machines stand in the same state before the walk (same PC, same cycle)", `${a.cpu.pc}/${a.c64Cycles} vs ${b.pc}/${b.cycles}`);
}
const dirOf = (n) => { const d = join(H.dir, `walk-${n}`); mkdirSync(d, { recursive: true }); return d; };
const targets = [
  { tag: "shared", sid: "shared", ids: ["shared"], dir: dirOf("shared") },
  { tag: "sb", sid: sbS2, ids: [sbS2], dir: dirOf("sb") },
];
for (const t of targets) t.file = (n) => join(t.dir, n);
const P = { prg: prgA, d64 };
const mismatches = [];
let compared = 0;
for (const e of walk(P)) {
  const out = [];
  for (const t of targets) {
    if (e.need && !t[e.need]) { out.push(undefined); continue; }
    const args = { session_id: t.sid, ...e.args(t) };
    const text = await mcpS2.call(e.tool, args);
    if (t.tag === "sb") calledOnSandbox.add(e.tool);
    e.keep?.(text, t);
    out.push(text);
  }
  const [a, b] = out;
  if (a === undefined || b === undefined) { console.log(`  SKIPPED  ${e.tool} — an earlier answer it needs did not come`); continue; }
  compared++;
  if (e.expect === "ui-only") {
    check(/refused for sandbox session/.test(b), `${e.tool} refuses a sandbox id by name`, b.slice(0, 200));
    continue;
  }
  if (e.expect === "both-refuse") {
    check(isErr(a) === isErr(b) || (/refus|not found|no active|unknown|none/i.test(a) && /refus|not found|no active|unknown|none/i.test(b)),
      `${e.tool}: both refuse alike`, `${a.slice(0, 160)} <> ${b.slice(0, 160)}`);
    continue;
  }
  const na = normalize(a, targets[0]);
  const nb = normalize(b, targets[1]);
  const same = na === nb;
  if (!same) mismatches.push(e.tool);
  check(same && (e.expect === "both-refuse-or-same" || !isErr(b)), `${e.tool}: the sandbox answers as the shared session does`, same ? b.slice(0, 200) : `\n--- shared:\n${na.slice(0, 500)}\n--- sandbox:\n${nb.slice(0, 500)}`);
}
console.log(`  (${compared} calls compared, ${mismatches.length} differ)`);

// every tool the table says works on a session was called with the sandbox's id in this walk
const sessionTools = Object.entries(SANDBOX_PARITY).filter(([, v]) => v.verdict === "works" && v.scope === "session").map(([k]) => k);
const uncalled = sessionTools.filter((n) => !calledOnSandbox.has(n));
check(uncalled.length === 0, `all ${sessionTools.length} session-scoped tools of the parity table were called with a sandbox id`, uncalled.join(", "));

// the stores the sandbox wrote read like any other, through the trace readers, whichever machine wrote them
{
  const sbDir = targets[1].dir;
  const duck = join(sbDir, "walk.duckdb");
  check(existsSync(join(sbDir, "walk.c64retrace")), "the sandbox's capture is in the place the call chose, not in its scratch", sbDir);
  const info = await mcpS2.call("trace_store_info", { path: duck });
  check(!isErr(info) && /931|events/i.test(info), "trace_store_info reads the sandbox's capture", info.slice(0, 200));
}
// the tools that serve a human's UI refuse a sandbox id, and the sandbox is still there after
for (const [tool, args] of [["runtime_session_close", {}], ["runtime_keep_alive", { minutes: 5 }], ["runtime_session_start", {}]]) {
  const r = await mcpS2.call(tool, { session_id: sbS2, ...args });
  check(/refused for sandbox session/.test(r) && /Nothing was done/.test(r) && r.includes(sbS2), `${tool} refuses the sandbox id by name, with its reason`, r.slice(0, 220));
}
check(/PC=/.test(await mcpS2.call("runtime_session_status", { session_id: sbS2 })), "…and the sandbox is untouched by those refusals");
const endS2 = await mcpS2.call("runtime_sandbox_end", { session_id: sbS2, outcome: "reached", summary: "walk done" });
check(/ended: reached/.test(endS2), "the walk's sandbox ends", endS2.slice(0, 100));

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S3  two sandboxes and the shared session, side by side");
const HYP = "the idle loop counts at $C000 and flashes the border; its PCs are the program's own (read in the listing the test built)";
const loopAt = (pad) => 0x080d + pad + 1; // INC $C000 sits after `pad` INX and the SEI
const projA = await H.project("s3-proj-a");
const projB = await H.project("s3-proj-b");
const prgs = { a: join(projA, "s3-a.prg"), b: join(projB, "s3-b.prg"), shared: join(proj, "s3-shared.prg") };
writeFileSync(prgs.a, loopPrg(0));
writeFileSync(prgs.b, loopPrg(16));
writeFileSync(prgs.shared, loopPrg(32));
const pad = { a: 0, b: 16, shared: 32 };
const sharedS3 = await H.daemon(DAEMON, await H.project("shared-s3"));
const sharedS3Ws = await H.ws(sharedS3.port);
await bootSandbox((m, p) => sharedS3Ws.call(m, p ?? {}), { mediaPath: prgs.shared });
const mA = await H.mcp(projA, { endpoint: sharedS3.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
const mB = await H.mcp(projB, { endpoint: sharedS3.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
const sa = await mA.call("runtime_sandbox_start", { purpose: "S3 process A", budget_minutes: 10, media_path: prgs.a });
const sb = await mB.call("runtime_sandbox_start", { purpose: "S3 process B", budget_minutes: 10, media_path: prgs.b });
const idA = idOf(sa), idB = idOf(sb);
check(!!idA && !!idB && idA !== idB, "two MCP processes each start a sandbox; the ids differ", `${idA} ${idB}`);
check(portOf(sa) !== portOf(sb) && portOf(sa) !== sharedS3.port && portOf(sb) !== sharedS3.port, "…on three different ports (theirs and the shared one's)");

const sharedCycles0 = (await sharedS3Ws.call("session/state")).c64Cycles;
const work = async (m, id, name) => {
  const out = {};
  out.bp = await m.call("runtime_breakpoint_add", { session_id: id, id: "loop", pc: loopAt(pad[name]) + 3, action: "log" });
  out.start = await m.call("runtime_trace_start", { session_id: id, hypothesis: HYP, domains: ["c64-cpu", "memory"] });
  out.run = await m.call("runtime_session_run", { session_id: id, max_instructions: 150000 });
  out.step = await m.call("runtime_step_into", { session_id: id });
  out.regs = JSON.parse(await m.call("runtime_monitor_registers", { session_id: id }));
  out.fin = await m.call("runtime_trace_finalize", { session_id: id });
  return out;
};
const sharedWork = async () => { await sharedS3Ws.call("session/run", { cycles: 300000 }); return (await sharedS3Ws.call("session/state")).cpu.pc; };
const [ra, rb, sharedPc] = await Promise.all([work(mA, idA, "a"), work(mB, idB, "b"), sharedWork()]);
check(/added/.test(ra.bp) && /added/.test(rb.bp), "each sandbox takes its own breakpoint at the same time", ra.bp + rb.bp);
check(/Trace started/.test(ra.start) && /Trace started/.test(rb.start) && /Trace finalized/.test(ra.fin) && /Trace finalized/.test(rb.fin), "…and its own trace, started and finalized side by side", `${ra.fin.slice(0, 100)} | ${rb.fin.slice(0, 100)}`);
const inRange = (pc, name) => pc >= loopAt(pad[name]) && pc < loopAt(pad[name]) + 12;
check(inRange(ra.regs.pc, "a") && inRange(rb.regs.pc, "b") && inRange(sharedPc, "shared"), "each machine stands in ITS program's loop (A, B and the shared one)", `${ra.regs.pc} ${rb.regs.pc} ${sharedPc}`);
const storeOf = (fin) => /Store \(duckdb_path\): (\S+)/.exec(fin)?.[1];
const pcsOf = async (m, fin) => {
  const t = await m.call("trace_store_top_pcs", { path: storeOf(fin), cpu: "c64", limit: 30, hypothesis: HYP });
  return [...t.matchAll(/\$([0-9A-Fa-f]{4})\t/g)].map((x) => parseInt(x[1], 16));
};
const pa = await pcsOf(mA, ra.fin);
const pb = await pcsOf(mB, rb.fin);
const isUser = (pc) => pc >= 0x0800 && pc < 0x0900;
check(pa.filter(isUser).length > 0 && pa.filter(isUser).every((pc) => inRange(pc, "a") || pc < loopAt(0) + 12), "trace A holds only A's program events", pa.map((x) => x.toString(16)).join(","));
check(pb.filter(isUser).length > 0 && pb.filter(isUser).every((pc) => inRange(pc, "b")), "trace B holds only B's program events", pb.map((x) => x.toString(16)).join(","));
check(!pa.some((pc) => inRange(pc, "b") || inRange(pc, "shared")) && !pb.some((pc) => inRange(pc, "a") || inRange(pc, "shared")), "neither trace holds another machine's PCs, the shared one's included");
check(storeOf(ra.fin).startsWith(H.traces) && storeOf(rb.fin).startsWith(H.traces) && storeOf(ra.fin) !== storeOf(rb.fin), "…each in the trace root, under its own project's key");
const ptrA = JSON.parse(readFileSync(join(projA, "runtime", "traces.json"), "utf8"));
const ptrB = JSON.parse(readFileSync(join(projB, "runtime", "traces.json"), "utf8"));
check(JSON.stringify(ptrA).includes(storeOf(ra.fin)) && !JSON.stringify(ptrA).includes(storeOf(rb.fin)) && JSON.stringify(ptrB).includes(storeOf(rb.fin)), "each project's runtime/traces.json points at its own capture only");
const sharedMoved = (await sharedS3Ws.call("session/state")).c64Cycles - sharedCycles0;
check(sharedMoved >= 300000 && sharedMoved < 300064, "the shared session advanced exactly what was asked of it, nothing from the sandboxes", String(sharedMoved));
check((await sharedS3Ws.call("trace/run/status", {})).active !== true, "…and no trace of the sandboxes is recording on it");

const stolenCall = await mB.call("runtime_monitor_registers", { session_id: idA });
check(/not yours/.test(stolenCall) && stolenCall.includes(idA), "process B calling a tool with process A's sandbox id is refused: not yours", stolenCall.slice(0, 300));
const stolenEnd = await mB.call("runtime_sandbox_end", { session_id: idA, outcome: "failed", summary: "mine now" });
check(/not yours/.test(stolenEnd), "…ending it too", stolenEnd.slice(0, 200));
check(!/sb-/.test((await mB.call("runtime_sandbox_list", {})).replace(idB, "")), "…and B's list does not show A's sandbox");
check(/PC=/.test(await mA.call("runtime_session_status", { session_id: idA })), "A's sandbox is untouched by B's attempts");
const uiSessions = await sharedS3Ws.call("session/list");
check(Array.isArray(uiSessions) && uiSessions.length === 1, "the workbench's session list (the shared daemon's) shows exactly one session — no sandbox among them", JSON.stringify(uiSessions));
const ledgerNow = readdirSync(join(H.state, "processes")).map((f) => JSON.parse(readFileSync(join(H.state, "processes", f), "utf8"))).filter((r) => r.kind === "sandbox");
check(ledgerNow.filter((r) => r.owner === mA.proc.pid).length >= 1 && ledgerNow.filter((r) => r.owner === mB.proc.pid).length >= 1, "the process ledger records each sandbox daemon with its owner's pid", JSON.stringify(ledgerNow.map((r) => [r.pid, r.owner])));
await mA.call("runtime_sandbox_end", { session_id: idA, outcome: "reached", summary: "S3 A" });
await mB.call("runtime_sandbox_end", { session_id: idB, outcome: "reached", summary: "S3 B" });


// ═══════════════════════════════════════════════════════════════════════════════════════════════
const waitFor = async (fn, ms, step = 250) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } };
const ledgerSandboxes = () => {
  try { return readdirSync(join(H.state, "processes")).map((f) => JSON.parse(readFileSync(join(H.state, "processes", f), "utf8"))).filter((r) => r.kind === "sandbox"); } catch { return []; }
};
const recordOf = (id) => JSON.parse(readFileSync(join(H.state, "sandbox-sessions", `${id}.json`), "utf8"));
const stepLog = (projectDir) => { try { return JSON.parse(readFileSync(join(projectDir, "knowledge", "agent-state.json"), "utf8")).history.map((h) => h.step).join("\n"); } catch { return ""; } };
const storeOfStart = (t) => /Store: (\S+)/.exec(t)?.[1];

head("S4  ending: reached, failed");
const proj4 = await H.project("s4");
const m4 = await H.mcp(proj4, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
const prg4 = join(proj4, "idle.prg");
writeFileSync(prg4, loopPrg());
for (const outcome of ["reached", "failed"]) {
  const t = await m4.call("runtime_sandbox_start", { purpose: `S4 ends ${outcome}`, budget_minutes: 10, media_path: prg4 });
  const id = idOf(t), port = portOf(t);
  const mine = ledgerSandboxes().find((r) => r.port === port);
  check(!!id && !!mine && (await listening(port)), `[${outcome}] the sandbox runs: its port is held and the ledger knows its daemon`, t.slice(0, 160));
  check(!!mine?.project && existsSync(mine.project) && /c64re-reel-/.test(mine.project), `[${outcome}] it holds a scratch directory of its own (the ledger names it)`, mine?.project);
  const tr = await m4.call("runtime_trace_start", { session_id: id, hypothesis: "$0810 INC $C000 in the idle loop (read in the listing the test built)", domains: ["c64-cpu"] });
  await m4.call("runtime_session_run", { session_id: id, max_instructions: 60000 });
  let snap;
  if (outcome === "reached") {
    await m4.call("runtime_trace_finalize", { session_id: id });
    snap = join(proj4, "s4.vsf");
    await m4.call("runtime_save_vsf", { session_id: id, output_path: snap });
  }
  const store = storeOfStart(tr);
  const t0 = Date.now();
  const e = await m4.call("runtime_sandbox_end", { session_id: id, outcome, summary: `S4 ${outcome} summary` });
  const took = Date.now() - t0;
  check(new RegExp(`ended: ${outcome} at \\d{4}`).test(e), `[${outcome}] runtime_sandbox_end answers the outcome`, e.slice(0, 200));
  check(!(await listening(port)) && !pidAlive(mine.pid), `[${outcome}] the daemon is gone and its port is free (in ${took} ms)`);
  check(!existsSync(mine.project), `[${outcome}] its scratch is removed`);
  const retrace = store.replace(/\.duckdb$/, ".c64retrace");
  check(existsSync(retrace) && statSync(retrace).size > 0, `[${outcome}] the capture is kept${outcome === "failed" ? " — a trace still recording at the end was finished, not lost" : ""}`, retrace);
  check(e.includes(retrace), `[${outcome}] …and the answer lists it`, e);
  if (snap) check(existsSync(snap) && e.length > 0, `[${outcome}] a snapshot written to the project is kept`);
  const info = await m4.call("trace_store_info", { path: store });
  check(!/^# [Tt]ool [Ee]rror/.test(info) && /events|bus_access|cpu/i.test(info), `[${outcome}] the kept capture reads (the index is built on the first read)`, info.slice(0, 160));
  const rec = recordOf(id);
  check(rec.state === "ended" && rec.reason === outcome && rec.summary === `S4 ${outcome} summary` && rec.artefacts.includes(retrace), `[${outcome}] the record says why, what was said, and what was kept`, JSON.stringify(rec).slice(0, 300));
  const log = stepLog(proj4);
  check(log.includes(id) && log.includes(`ended (${outcome})`) && log.includes(`S4 ends ${outcome}`) && log.includes(`S4 ${outcome} summary`) && /after \d+s/.test(log) && log.includes(retrace), `[${outcome}] purpose, outcome, summary, duration and artefacts are in the project's step log`, log.slice(-500));
  const after = await m4.call("runtime_monitor_registers", { session_id: id });
  check(new RegExp(`ended: ${outcome} at`).test(after) && !/no sandbox session/.test(after), `[${outcome}] a later call with the id answers "ended: ${outcome} at <time>"`, after.slice(0, 200));
  const again = await m4.call("runtime_sandbox_end", { session_id: id, outcome, summary: "again" });
  check(/ended: /.test(again), `[${outcome}] ending twice is harmless`, again.slice(0, 120));
}
check(/ended in this process/.test(await m4.call("runtime_sandbox_list", {})), "runtime_sandbox_list remembers what ended in this process");
check(/no sandbox session "sb-never-1"/.test(await m4.call("runtime_monitor_registers", { session_id: "sb-never-1" })), "an id that never existed is told apart from one that ended");

head("S5  ending itself: budget, idle, owner gone");
const proj5 = await H.project("s5");
const m5 = await H.mcp(proj5, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
const traceHyp = "$0810 INC $C000 in the idle loop (read in the listing the test built)";
const prgFor = (dir) => { const f = join(dir, "idle.prg"); writeFileSync(f, loopPrg()); return f; };
async function startTraced(m, projectDir, extra) {
  const t = await m.call("runtime_sandbox_start", { media_path: prgFor(projectDir), ...extra });
  const id = idOf(t), port = portOf(t);
  const tr = await m.call("runtime_trace_start", { session_id: id, hypothesis: traceHyp, domains: ["c64-cpu"] });
  await m.call("runtime_session_run", { session_id: id, max_instructions: 40000 });
  const rec = ledgerSandboxes().find((r) => r.port === port);
  return { id, port, store: storeOfStart(tr), pid: rec?.pid, scratch: rec?.project };
}
async function afterSelfEnd(m, s, reason, label, projectDir) {
  const gone = await waitFor(async () => !(await listening(s.port)) && !pidAlive(s.pid), 20000);
  check(gone, `[${label}] the daemon is gone and its port is free`);
  const say = await m.call("runtime_monitor_registers", { session_id: s.id });
  check(new RegExp(`ended: ${reason} at \\d{4}-`).test(say) && !/no sandbox session/.test(say), `[${label}] the next call with its id answers "ended: ${reason} at <time>", never "no such session"`, say.slice(0, 260));
  const retrace = s.store.replace(/\.duckdb$/, ".c64retrace");
  check(existsSync(retrace) && statSync(retrace).size > 0, `[${label}] the trace that was recording is on disk`, retrace);
  const info = await m.call("trace_store_info", { path: s.store });
  check(!/^# [Tt]ool [Ee]rror/.test(info) && /cpu|events/i.test(info) && !/= 0\b.*cpu/.test(info), `[${label}] …finalized, not lost: it reads, with its events`, info.slice(0, 200));
  check(!!s.scratch && !existsSync(s.scratch), `[${label}] the scratch is removed`, s.scratch);
  const rec = recordOf(s.id);
  check(rec.state === "ended" && rec.reason === reason && rec.outcome === reason, `[${label}] the record says "${reason}"`, JSON.stringify(rec).slice(0, 240));
  return rec;
}

// budget: ends at its age, whether or not anyone listens
{
  const s = await startTraced(m5, proj5, { purpose: "S5 budget", budget_minutes: 0.12 });
  const t0 = Date.now();
  const rec = await afterSelfEnd(m5, s, "budget", "budget", proj5);
  check(Date.now() - t0 < 25000, "[budget] it ended within seconds of the deadline", `${Date.now() - t0} ms`);
  check(stepLog(proj5).includes(s.id) && stepLog(proj5).includes("ended (budget)"), "[budget] the step log has the outcome \"budget\"", stepLog(proj5).slice(-300));
  check(!!rec.endedAt, "[budget] …with its time");
}
// idle: no call reaches it for the limit; any call before that resets the clock
{
  const s = await startTraced(m5, proj5, { purpose: "S5 idle", budget_minutes: 5, idle_minutes: 0.07 });
  let alive = true;
  for (let i = 0; i < 5; i++) { await sleep(2000); alive = alive && /PC=/.test(await m5.call("runtime_session_status", { session_id: s.id })); }
  check(alive, "[idle] calls every 2 s keep a 4 s idle limit from firing over 10 s");
  await afterSelfEnd(m5, s, "idle", "idle", proj5);
  check(stepLog(proj5).includes(s.id) && stepLog(proj5).includes("ended (idle)"), "[idle] the step log has the outcome \"idle\"", stepLog(proj5).slice(-300));
}
// owner gone: the MCP process that started it is killed
{
  const proj5b = await H.project("s5b");
  const mDoomed = await H.mcp(proj5b, { endpoint: shared.endpoint });
  const s = await startTraced(mDoomed, proj5b, { purpose: "S5 owner killed", budget_minutes: 10 });
  check(await listening(s.port) && pidAlive(s.pid), "[owner gone] the sandbox runs, owned by a process that is about to die");
  process.kill(mDoomed.proc.pid, "SIGKILL");
  const t0 = Date.now();
  const survivor = await H.mcp(proj5b, { endpoint: shared.endpoint });
  const gone = await waitFor(async () => !(await listening(s.port)) && !pidAlive(s.pid), 20000);
  check(gone, `[owner gone] the daemon is gone and its port free ${Date.now() - t0} ms after the owner was killed`);
  const say = await survivor.call("runtime_monitor_registers", { session_id: s.id });
  check(/ended: owner gone at/.test(say) && !/no sandbox session/.test(say) && !/not yours/.test(say), "[owner gone] another process asking is told \"ended: owner gone at <time>\"", say.slice(0, 260));
  const retrace = s.store.replace(/\.duckdb$/, ".c64retrace");
  check(existsSync(retrace) && statSync(retrace).size > 0, "[owner gone] the trace that was recording is on disk", retrace);
  const info = await survivor.call("trace_store_info", { path: s.store });
  check(!/^# [Tt]ool [Ee]rror/.test(info) && /cpu|events/i.test(info), "[owner gone] …finalized, not lost: it reads", info.slice(0, 200));
  check(!!s.scratch && !existsSync(s.scratch), "[owner gone] the scratch is removed", s.scratch);
  const rec = recordOf(s.id);
  check(rec.state === "ended" && rec.reason === "owner gone" && rec.outcome === "owner gone", "[owner gone] the record says \"owner gone\"", JSON.stringify(rec).slice(0, 240));
  check(stepLog(proj5b).includes(s.id) && stepLog(proj5b).includes("ended (owner gone)"), "[owner gone] the next process to look wrote the outcome \"owner gone\" into the project's step log", stepLog(proj5b).slice(-300));
  const { listProcesses } = await load("runtime/process-ledger.js");
  check(!(await listProcesses()).some((r) => r.pid === s.pid), "[owner gone] and the process ledger no longer lists it (a record of a gone process is dropped by whoever reads the ledger)");
}


// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S6  a long capture inside a sandbox");
const proj6 = await H.project("s6");
const d64For = (dir) => { const f = join(dir, "t.d64"); writeFileSync(f, d64WithPrg("LOOP", loopPrg())); return f; };
const pollJob = async (m, text, ms = 600000) => {
  const jobId = /job_id: (\S+)/.exec(text)?.[1];
  const t0 = Date.now();
  for (;;) {
    const st = await m.call("analysis_job_status", { job_id: jobId });
    if (!/still running|running/i.test(st) || Date.now() - t0 > ms) return { text: st, waitedMs: Date.now() - t0 };
    await sleep(1000);
  }
};
// The job mode (always run): a grace window of 1.5 s turns any real run into a job; the sandbox's idle
// limit (6 s) is shorter than the run, which is in flight and so is not idleness.
{
  const m6 = await H.mcp(proj6, { endpoint: shared.endpoint, env: { C64RE_JOB_GRACE_MS: "600" } });
  const d64s6 = d64For(proj6);
  // the drive-mechanism lane belongs to a medium whose protection was READ: the recorded verdict the gate asks for
  const verdict = await m6.call("inspect_disk", { image_path: d64s6, substrate_override: "custom-gcr" });
  check(!/^# [Tt]ool [Ee]rror/.test(verdict), "the synthetic medium has a recorded substrate verdict (the drive-mechanism lane's gate)", verdict.slice(0, 160));
  const t = await m6.call("runtime_sandbox_start", { purpose: "S6 job mode", budget_minutes: 15, idle_minutes: 0.03, media_path: d64s6 });
  const id = idOf(t);
  check(!!id, "a sandbox for the job-mode run", t.slice(0, 200));
  const tr = await m6.call("runtime_trace_start", { session_id: id, hypothesis: "$0810 INC $C000 in the idle loop (read in the listing the test built)", domains: ["c64-cpu", "drive-mechanism"] });
  const store6 = storeOfStart(tr);
  const t0 = Date.now();
  const ran = await m6.call("runtime_session_run", { session_id: id, max_instructions: 1, cycle_budget: 40_000_000 });
  const gotJob = /job_id: \S+/.test(ran);
  check(gotJob && /background job mode/.test(ran) && /analysis_job_status/.test(ran), "a run past the grace window answers a job id instead of holding the call", ran.slice(0, 300));
  check(Date.now() - t0 < 12000, "…promptly (the call returned before the run did)", `${Date.now() - t0} ms`);
  const done = gotJob ? await pollJob(m6, ran) : { text: ran, waitedMs: 0 };
  check(/Advanced \d+ cycles/.test(done.text), "analysis_job_status hands over the run's own answer when it is done", done.text.slice(0, 240));
  check(gotJob, "…the run outlasted the 1.8 s idle limit, and the sandbox did not end itself on idle while it ran", `${done.waitedMs} ms`);
  check(/PC=/.test(await m6.call("runtime_session_status", { session_id: id })), "…it is still there afterwards");
  const fin = await m6.call("runtime_trace_finalize", { session_id: id });
  const finDone = /job_id: \S+/.test(fin) ? (await pollJob(m6, fin)).text : fin;
  check(/Trace finalized/.test(finDone) && /Store \(duckdb_path\)/.test(finDone), "finalize likewise: an index that outlasts the grace is a job too, and its answer is the finalize answer", finDone.slice(0, 260));
  const info6 = await m6.call("trace_store_info", { path: store6 });
  check(!/^# [Tt]ool [Ee]rror/.test(info6) && /master_clock range|tables/.test(info6), "the capture reads", info6.slice(0, 120));
  await m6.call("runtime_sandbox_end", { session_id: id, outcome: "reached", summary: "S6 job mode" });
}
// The finalize timeout on a call that is NOT a job: the intact capture is named when the index outlasts the call.
{
  const { finalizeTimeoutMs, isCallTimeout } = await load("server-tools/long-call.js");
  check(finalizeTimeoutMs(0) === 120000 && finalizeTimeoutMs(40_000) === 130000 && finalizeTimeoutMs(1e12) === 3600000, "the finalize allowance grows with the capture (2 min + 0.25 ms per event, at most an hour) — the shared client's 60 s default was what killed the shared session's finalize", `${finalizeTimeoutMs(40_000)}`);
  check(isCallTimeout(new Error("runtime daemon timeout: trace/run/stop")) && isCallTimeout(new Error("trace/run/stop did not answer within 5 ms")) && !isCallTimeout(new Error("No active trace")), "…and a timeout of either client is recognized as one");
}
// The long capture itself, behind C64RE_E2E_LONG=1: 60M cycles with the drive-mechanism lane armed.
if (process.env.C64RE_E2E_LONG === "1") {
  const mL = await H.mcp(proj6, { endpoint: shared.endpoint, env: { C64RE_JOB_GRACE_MS: "30000" } });
  const t = await mL.call("runtime_sandbox_start", { purpose: "S6 long capture", budget_minutes: 60, media_path: d64For(proj6) });
  const id = idOf(t);
  await mL.call("runtime_type", { session_id: id, text: 'LOAD"*",8,1{RETURN}', settle: true });
  const tr = await mL.call("runtime_trace_start", { session_id: id, hypothesis: "$0810 INC $C000 in the idle loop (read in the listing the test built)", domains: ["memory", "drive8-cpu", "drive-mechanism"] });
  const storeL = storeOfStart(tr);
  const tRun = Date.now();
  const ran = await mL.call("runtime_session_run", { session_id: id, max_instructions: 1, cycle_budget: 60_000_000 });
  const ranDone = /job_id: \S+/.test(ran) ? (await pollJob(mL, ran, 3_600_000)).text : ran;
  const runSec = (Date.now() - tRun) / 1000;
  check(/Advanced \d+ cycles/.test(ranDone) && !/^# [Tt]ool [Ee]rror/.test(ranDone), "LONG: a 60M-cycle run completes (job or inline)", ranDone.slice(0, 200));
  const tFin = Date.now();
  const fin = await mL.call("runtime_trace_finalize", { session_id: id });
  const finDone = /job_id: \S+/.test(fin) ? (await pollJob(mL, fin, 3_600_000)).text : fin;
  const finSec = (Date.now() - tFin) / 1000;
  const retraceL = storeL.replace(/\.duckdb$/, ".c64retrace");
  const okIndex = /Store \(duckdb_path\)/.test(finDone);
  const okLazy = finDone.includes(retraceL) && /first read/.test(finDone);
  check(okIndex || okLazy, "LONG: the index exists, or the answer names the intact .c64retrace and the lazy index", finDone.slice(0, 300));
  const ev = /Events: (\d+)/.exec(finDone)?.[1];
  console.log(`  S6 LONG numbers: run ${runSec.toFixed(1)} s · finalize+index ${finSec.toFixed(1)} s · events ${ev ?? "?"} · retrace ${(statSync(retraceL).size / 1e6).toFixed(0)} MB${existsSync(storeL) ? ` · index ${(statSync(storeL).size / 1e6).toFixed(0)} MB` : ""}`);
  await mL.call("runtime_sandbox_end", { session_id: id, outcome: "reached", summary: "S6 long capture" });
} else {
  console.log("  SKIPPED  S6 LONG (60M cycles, drive-mechanism armed) — set C64RE_E2E_LONG=1; skipped, NOT passed");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S7  doors: the C64 Ultimate refusal, and a store read while the device is selected");
{
  const { startFakeUltimate } = await import("./lib/fake-ultimate.mjs");
  const { reapBridges } = await import("./lib/bridge-harness.mjs");
  const sim = await startFakeUltimate({ capabilities: "object", trxmonRunning: true });
  const state7 = join(H.dir, "state7");
  mkdirSync(state7, { recursive: true });
  const proj7 = await H.project("s7");
  // its own state directory: the C64U selection is ONE per machine and every C64RE process of a state dir follows it
  const m7 = await H.mcp(proj7, { env: { C64RE_STATE_DIR: state7 } });
  try {
    const sel = await m7.call("runtime_backend", { action: "select", backend: "c64u", host: `127.0.0.1:${sim.restPort}` });
    check(/Selected: C64 Ultimate/.test(sel), "a (fake) C64 Ultimate is the selected backend", sel.slice(0, 160));
    const refused = await m7.call("runtime_trace_start", { session_id: "shared", hypothesis: "$C000 is written by the loader at $0810 I read", domains: ["c64-cpu"] });
    check(/trace\/start_domains/.test(refused) && /runtime_sandbox_start/.test(refused), "a live trace on the device is refused, and the refusal names runtime_sandbox_start", refused.slice(0, 400));
    // …and following it works
    const prg7 = join(proj7, "idle.prg");
    writeFileSync(prg7, loopPrg());
    const st = await m7.call("runtime_sandbox_start", { purpose: "S7 trace while a C64U is selected", budget_minutes: 5, media_path: prg7 });
    const id7 = idOf(st);
    check(!!id7 && /c64-pal/.test(st), "runtime_sandbox_start works with the device selected — and the machine it boots is the emulator", st.slice(0, 200));
    const status = await m7.call("runtime_session_status", { session_id: id7 });
    check(/Sandbox session/.test(status) && !/C64 Ultimate/.test(status.split("\n")[0]), "…and its status names the sandbox, not the device", status.split("\n").slice(0, 3).join(" | "));
    const tr = await m7.call("runtime_trace_start", { session_id: id7, hypothesis: "$0810 INC $C000 in the idle loop (read in the listing the test built)", domains: ["c64-cpu"] });
    check(/Trace started/.test(tr), "a trace on the sandbox starts, with the device selected", tr.slice(0, 160));
    await m7.call("runtime_session_run", { session_id: id7, max_instructions: 20000 });
    const fin = await m7.call("runtime_trace_finalize", { session_id: id7 });
    check(/Trace finalized/.test(fin), "…and finalizes", fin.slice(0, 160));
    const store = /Store \(duckdb_path\): (\S+)/.exec(fin)?.[1];
    const rpcBefore = sim.rpcLog.length;
    const info = await m7.call("trace_store_info", { path: store });
    check(!/^# [Tt]ool [Ee]rror/.test(info) && /tables:/.test(info), "trace_store_* read a store file while the device is selected (served by an emulator reader, not refused)", info.slice(0, 200));
    const slice = await m7.call("trace_store_top_pcs", { path: store, cpu: "c64", limit: 3, hypothesis: "$0810 INC $C000 in the idle loop (read in the listing the test built)" });
    check(/top 3 PCs/.test(slice), "…the other readers likewise", slice.slice(0, 120));
    check(sim.rpcLog.slice(rpcBefore).every((r) => !/^trace\//.test(r.method)), "the device was never asked to read it", JSON.stringify(sim.rpcLog.slice(rpcBefore).map((r) => r.method)));
    await m7.call("runtime_sandbox_end", { session_id: id7, outcome: "reached", summary: "S7 done" });
  } finally {
    try { await m7.call("runtime_backend", { action: "select", backend: "emulator" }); } catch { /* ending anyway */ }
    await reapBridges(state7);
    await sim.close();
  }
}

// nothing of this run is left behind: with every MCP process gone, every sandbox it still held (the S7 reader, for one)
// ends itself — the owner check doing its work, here at the end of the run. Only what THIS run started is judged: other
// sandboxes on the machine (somebody's real ones) are not ours to wait for.
{
  // the sandboxes the run still holds: the live sandbox records of the run's own ledgers name their scratch directories
  const held = [H.state, join(H.dir, "state7")].flatMap((d) => {
    try { return readdirSync(join(d, "processes")).map((f) => JSON.parse(readFileSync(join(d, "processes", f), "utf8"))).filter((r) => r.kind === "sandbox" && pidAlive(r.pid)); } catch { return []; }
  });
  const ours = held.map((r) => r.project);
  H.stopMcps();
  const gone = await waitFor(async () => ours.every((d) => !existsSync(d)) && held.every((r) => !pidAlive(r.pid)) && ours.every((d) => processesMatching(d).length === 0), 25000);
  check(gone === true, `the ${ours.length} sandbox(es) still held when the last MCP process was killed ended themselves: no daemon, no keeper, no scratch`, ours.join(","));
}

process.exit(T.done());
