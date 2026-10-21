#!/usr/bin/env node
// Spec 910 D4 — a sandbox answers every runtime tool the way the shared machine's daemon does, and that is PROVEN, not classified.
//
//   gate     every registered runtime tool has a verdict (SANDBOX_PARITY), the table names no tool that is gone, and
//            every tool whose verdict is "works on a session" has a fixture call (hand-written, or generated for a
//            tool that asks for nothing but a session) — a new tool without a verdict or a fixture turns this red
//   S3       each fixture call is made on a sandbox and on a shared-style daemon (own port, started without --scratch,
//            brought to the same state), and the answers are equal after ids, ports, paths and times are normalised
//   S4       a ui-only tool called with a sandbox id refuses by name, with its reason from the table, and does nothing
//   S8       the monitor's `reset cold` with breakpoints on the reset routine and on a cartridge's cold start stops on
//            both, on both daemons, at the same cycles
//   S12      the registered tool texts and the live replies describe the one run model
//
// Daemons of this run's own on free ports, a state directory of the run, synthetic media built here, no game data. It
// SKIPS LOUDLY when there is no trx64-daemon binary. Nothing here touches :4312.
//   Locally:  C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:910-parity
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { d64WithPrg } from "./lib/d64-fixture.mjs";
import { COLD_START, coldStartCrt } from "./lib/fixtures-910.mjs";
import { generatedFixtures, normalize, placeholderArgs, walk } from "./lib/parity-fixtures.mjs";
import { Harness, ROOT, findDaemon, load, loopPrg, makeChecker, sleep } from "./lib/e2e-906-harness.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-910-parity");
const { check, head } = T;
const isErr = (t) => /^# (?:T|t)ool (?:E|e)rror/.test(t);
const idOf = (s) => /\bsb-[a-z0-9-]+\b/.exec(s)?.[0];
const portOf = (s) => Number(/on port (\d+)/.exec(s)?.[1]);

// ── the gate: verdicts and fixtures (needs no daemon) ───────────────────────────────────────────
const { SANDBOX_PARITY, unclassifiedRuntimeTools, staleParityEntries } = await load("runtime/sandbox-parity.js");
const { collectToolInventory } = await load("server.js");
const registered = collectToolInventory().map((t) => t.name);
head("gate  verdicts and fixtures");
check(unclassifiedRuntimeTools(registered).length === 0, "every registered runtime tool has a sandbox verdict", unclassifiedRuntimeTools(registered).join(", "));
check(staleParityEntries(registered).length === 0, "…and the table names no tool that is not registered", staleParityEntries(registered).join(", "));
const sessionTools = Object.entries(SANDBOX_PARITY).filter(([, v]) => v.verdict === "works" && v.scope === "session").map(([k]) => k);
const hand = walk({ prg: "x", d64: "x" });

const DAEMON = await findDaemon();
if (!DAEMON) {
  const code = T.done();
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED the live half — no trx64-daemon binary (set C64RE_RUNTIME_BIN). Skipped, NOT passed.");
  process.exit(code);
}
process.env.C64RE_RUNTIME_BIN = DAEMON;
console.log(`runtime: ${DAEMON}`);

const H = new Harness("c64re-910p-");
process.env.C64RE_STATE_DIR = H.state;
const { bootSandbox } = await load("reel/session-boot.js");

const proj = await H.project("proj");
const prgA = join(proj, "a.prg");
writeFileSync(prgA, loopPrg());
const d64 = join(proj, "t.d64");
writeFileSync(d64, d64WithPrg("LOOP", loopPrg()));
const crtPath = join(proj, "cold.crt");
writeFileSync(crtPath, coldStartCrt());

const shared = await H.daemon(DAEMON, await H.project("shared-proj"));
const sws = await H.ws(shared.port);
const sharedCall = (m, p) => sws.call(m, p ?? {});
await bootSandbox(sharedCall, { mediaPath: prgA });
const mcp = await H.mcp(proj, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });

// fixtures: the hand-written walk, plus a generated call for every tool that asks for nothing but a session
const fixtures = [...hand, ...generatedFixtures(mcp.tools.filter((t) => sessionTools.includes(t.name)), hand)];
const fixtured = new Set(fixtures.filter((e) => e.tool).map((e) => e.tool));
const noFixture = sessionTools.filter((n) => !fixtured.has(n));
check(noFixture.length === 0, `every one of the ${sessionTools.length} session-scoped tools has a fixture call`, noFixture.join(", "));
const liveTools = new Map(mcp.tools.map((t) => [t.name, t]));
const missing = registered.filter((n) => /^runtime_/.test(n) && !liveTools.has(n));
check(missing.length === 0, "the MCP server under test (full tool set) lists every registered runtime tool", missing.join(", "));
// a fixture whose arguments the tool no longer has is stale: it would pass by being ignored
const stale = fixtures.filter((e) => e.tool).flatMap((e) => {
  const props = Object.keys(liveTools.get(e.tool)?.inputSchema?.properties ?? {});
  const args = Object.keys(e.args({ file: (n) => n, tag: "x", cp: "x" }));
  return args.filter((k) => !props.includes(k)).map((k) => `${e.tool}.${k}`);
});
check(stale.length === 0, "every fixture argument is a parameter its tool still has", stale.join(", "));

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S12  the texts tell the truth");
{
  const WRONG = [/free-?runs? between calls/i, /born headless/i, /\bPAUSED\b/, /advances only when a tool/i, /moves only when a tool runs it/i, /because it is a sandbox/i];
  const five = ["runtime_type", "runtime_joystick", "runtime_session_run", "runtime_sandbox_start", "runtime_sandbox_run"];
  for (const n of five) {
    const d = liveTools.get(n)?.description ?? "";
    const hit = WRONG.find((re) => re.test(d));
    check(!!d && !hit, `${n}: its text says neither "free-runs between calls" nor "PAUSED because it is a sandbox"`, hit ? `matched ${hit}: …${d.match(hit)?.[0]}…` : "no such tool");
  }
  const every = [...liveTools.values()].filter((t) => /^runtime_/.test(t.name));
  const offenders = every.filter((t) => WRONG.some((re) => re.test(t.description ?? ""))).map((t) => t.name);
  check(offenders.length === 0, "…and no other runtime tool text does", offenders.join(", "));
  for (const n of ["runtime_session_run", "runtime_type", "runtime_joystick", "runtime_sandbox_start"]) {
    check(/\bstop(ped|s)?\b/i.test(liveTools.get(n)?.description ?? ""), `${n}: the text describes the one model (a run has a stop, the machine is left stopped)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S3  every working tool answers alike on a sandbox and on a shared-style daemon");
const sandboxText = await mcp.call("runtime_sandbox_start", { purpose: "S3 parity walk", budget_minutes: 25, media_path: "a.prg" });
const sbId = idOf(sandboxText), sbPort = portOf(sandboxText);
check(!!sbId, "a sandbox session for the walk", sandboxText.slice(0, 200));
check(/stopped here by the boot/.test(sandboxText) && !/PAUSED/.test(sandboxText), "runtime_sandbox_start's reply describes the one model (stopped by the boot, not paused because it is a sandbox)", sandboxText.split("\n").find((l) => /^now:/.test(l)));
{
  const a = await sharedCall("session/state");
  const bws = await H.ws(sbPort);
  const b = await bws.call("session/state", { session_id: "integrated-1" });
  bws.close();
  check(a.cpu.pc === b.cpu.pc && a.c64Cycles === b.c64Cycles, "both machines stand in the same state before the walk (same PC, same cycle)", `${a.cpu.pc}/${a.c64Cycles} vs ${b.cpu.pc}/${b.c64Cycles}`);
}
const dirOf = (n) => { const d = join(proj, `walk-${n}`); mkdirSync(d, { recursive: true }); return d; };
const targets = [
  { tag: "shared", sid: "shared", ids: ["shared"], dir: dirOf("shared"), port: shared.port },
  { tag: "sb", sid: sbId, ids: [sbId], dir: dirOf("sb"), port: sbPort },
];
for (const t of targets) t.file = (n) => join(t.dir, n);
const stoppedOn = async (port) => {
  const c = await H.ws(port);
  try {
    for (let i = 0; i < 1500; i++) { const s = await c.call("debug/state", { session_id: "integrated-1" }); if (s.runState !== "running") return s; await sleep(4); }
  } finally { c.close(); }
  return undefined;
};
const P = { prg: prgA, d64 };
const calledOnSandbox = new Set();
const mismatches = [];
let compared = 0;
for (const e of [...walk(P), ...generatedFixtures(mcp.tools.filter((t) => sessionTools.includes(t.name)), hand)]) {
  if (e.park) {
    const both = await Promise.all(targets.map((t) => stoppedOn(t.port)));
    check(both.every(Boolean) && both[0].cycles === both[1].cycles && both[0].pc === both[1].pc, "a program started with a stop armed stands on the same instruction on both machines", JSON.stringify(both.map((s) => s && [s.cycles, s.pc])));
    continue;
  }
  const out = [];
  for (const t of targets) {
    if (e.need && !t[e.need]) { out.push(undefined); continue; }
    const args = { session_id: t.sid, ...e.args(t) };
    const text = await mcp.call(e.tool, args);
    if (t.tag === "sb") calledOnSandbox.add(e.tool);
    e.keep?.(text, t);
    out.push(text);
  }
  const [a, b] = out;
  if (a === undefined || b === undefined) { console.log(`  SKIPPED  ${e.tool} — an earlier answer it needs did not come`); continue; }
  compared++;
  if (e.expect === "both-refuse") {
    check(isErr(a) === isErr(b) || (/refus|not found|no active|unknown|none/i.test(a) && /refus|not found|no active|unknown|none/i.test(b)),
      `${e.tool}: both refuse alike`, `${a.slice(0, 160)} <> ${b.slice(0, 160)}`);
    continue;
  }
  const na = normalize(a, targets[0]);
  const nb = normalize(b, targets[1]);
  const same = na === nb;
  if (!same) mismatches.push(e.tool);
  check(same && (e.expect === "both-refuse-or-same" || !isErr(b)), `${e.tool}${e.generated ? " (generated call)" : ""}: the sandbox answers as the shared-style daemon does`, same ? b.slice(0, 200) : `\n--- shared:\n${na.slice(0, 700)}\n--- sandbox:\n${nb.slice(0, 700)}`);
}
console.log(`  (${compared} calls compared, ${mismatches.length} differ)`);
const uncalled = sessionTools.filter((n) => !calledOnSandbox.has(n));
check(uncalled.length === 0, `all ${sessionTools.length} session-scoped tools were called with a sandbox id`, uncalled.join(", "));

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S4  a ui-only tool refuses by name, with its reason, and does nothing");
{
  const uiOnly = Object.entries(SANDBOX_PARITY).filter(([, v]) => v.verdict === "ui-only");
  check(uiOnly.length > 0, `the table has ${uiOnly.length} ui-only tools`);
  for (const [tool, v] of uiOnly) {
    const schema = liveTools.get(tool)?.inputSchema;
    const r = await mcp.call(tool, { ...placeholderArgs(schema), session_id: sbId });
    check(/refused for sandbox session/.test(r) && r.includes(sbId) && r.includes(tool) && r.includes(v.reason) && /Nothing was done/.test(r), `${tool} refuses the sandbox id by name, with its reason from the table`, r.slice(0, 260));
  }
  check(/PC=/.test(await mcp.call("runtime_session_status", { session_id: sbId })), "…and the sandbox is untouched by those refusals");
  await mcp.call("runtime_sandbox_end", { session_id: sbId, outcome: "reached", summary: "walk done" });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
head("S8  reset cold stops at the cartridge's cold start, on both daemons");
{
  const seen = {};
  const sh2 = await H.daemon(DAEMON, await H.project("shared-s8"));
  const sh2ws = await H.ws(sh2.port);
  await bootSandbox((m, p) => sh2ws.call(m, p ?? {}), {});
  const mcp8 = await H.mcp(proj, { endpoint: sh2.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
  const t2 = await mcp8.call("runtime_sandbox_start", { purpose: "S8 cold start", budget_minutes: 10 });
  const sb8 = idOf(t2), sb8Port = portOf(t2);
  for (const [label, sid, port, m] of [["shared-style", "shared", sh2.port, mcp8], ["sandbox", sb8, sb8Port, mcp8]]) {
    const mounted = await m.call("runtime_media_mount", { session_id: sid, path: crtPath });
    check(!isErr(mounted), `[${label}] the cartridge goes in`, mounted.slice(0, 160));
    await stoppedOn(port).catch(() => undefined);
    await m.call("runtime_breakpoint_add", { session_id: sid, id: "vec", pc: 0xfce2 });
    await m.call("runtime_breakpoint_add", { session_id: sid, id: "cold", pc: COLD_START });
    const r = await m.call("runtime_monitor", { session_id: sid, command: "reset cold" });
    check(!isErr(r), `[${label}] runtime_monitor "reset cold"`, r.slice(0, 160));
    const first = await stoppedOn(port);
    check(first?.stop?.reason === "breakpoint" && first.pc === 0xfce2 && first.cycles === 0, `[${label}] it stops at $FCE2 on cycle 0, not 5 M cycles later`, JSON.stringify(first?.stop));
    await m.call("runtime_session_run", { session_id: sid, max_instructions: 1, cycle_budget: 600_000 });
    const second = await stoppedOn(port);
    check(second?.stop?.reason === "breakpoint" && second.pc === COLD_START && second.cycles < 400_000, `[${label}] then at the cartridge's cold start $${COLD_START.toString(16)} within a few hundred thousand cycles`, JSON.stringify(second?.stop));
    seen[label] = [first?.stop, second?.stop];
    await m.call("runtime_breakpoint_remove", { session_id: sid, id: "vec" });
    await m.call("runtime_breakpoint_remove", { session_id: sid, id: "cold" });
  }
  check(JSON.stringify(seen["shared-style"]) === JSON.stringify(seen.sandbox), "both daemons answer identically (the same stops on the same cycles)", JSON.stringify(seen));
  await mcp8.call("runtime_sandbox_end", { session_id: sb8, outcome: "reached", summary: "S8 done" });
}

H.stopMcps();
process.exit(T.done());
