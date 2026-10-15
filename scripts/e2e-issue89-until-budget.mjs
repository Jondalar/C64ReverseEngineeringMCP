#!/usr/bin/env node
// Issue #89 — runtime_until honours its cycle budget and reports honest counters.
// A real trx64-daemon in a SANDBOX session (never the shared one), bare C64 at the BASIC prompt:
//   * an address the CPU never reaches stops after `budget` cycles (not ~10 000 000), budgetExhausted;
//   * cyclesElapsed is the cycle count; instructionsElapsed is the daemon's real instruction count
//     (0 < instructions < cycles), not a copy of the cycles;
//   * a reachable address (the KERNAL IRQ entry $FF48, hit every frame) halts there;
//   * runtime_session_run until + cycle_budget and runtime_step_over budget reach the daemon.
//   C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:issue89-until-budget
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Harness, ROOT, findDaemon, makeChecker } from "./lib/e2e-906-harness.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e:issue89-until-budget");
const { check, head } = T;
const DAEMON = await findDaemon();
if (!DAEMON) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found."); process.exit(1); }
  console.log("SKIPPED — no trx64-daemon binary (set C64RE_RUNTIME_BIN). Skipped, NOT passed.");
  process.exit(0);
}
process.env.C64RE_RUNTIME_BIN = DAEMON;

const H = new Harness("c64re-89-");
const proj = await H.project("proj");
const shared = await H.daemon(DAEMON, await H.project("shared-proj"));
const mcp = await H.mcp(proj, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
const started = await mcp.call("runtime_sandbox_start", { purpose: "issue 89 until budget", budget_minutes: 5 });
const sid = /\bsb-[a-z0-9-]+\b/.exec(started)?.[0];
check(!!sid, "sandbox session started", started.slice(0, 200));

const until = async (addr, budget) => {
  const t = await mcp.call("runtime_until", { session_id: sid, addr, budget });
  try { return JSON.parse(t); } catch { return { raw: t }; }
};

head("unreachable address, budget 1000");
const a = await until(2, 1000);
check(a.halted === false && a.budgetExhausted === true, "not halted, budgetExhausted", JSON.stringify(a));
check(a.cyclesElapsed >= 1000 && a.cyclesElapsed <= 1007, "cyclesElapsed in 1000..1007", JSON.stringify(a));
head("unreachable address, budget 100000");
const b = await until(2, 100000);
check(b.budgetExhausted === true && b.cyclesElapsed >= 100000 && b.cyclesElapsed <= 100007, "cyclesElapsed in 100000..100007", JSON.stringify(b));
check([a, b].every((x) => x.instructionsElapsed > 0 && x.instructionsElapsed < x.cyclesElapsed), "0 < instructionsElapsed < cyclesElapsed", JSON.stringify([a, b]));

head("reachable address");
const c = await until(0xff48, 200000);
check(c.halted === true && c.finalPc === 0xff48 && c.budgetExhausted === false, "halts at $FF48 (IRQ entry)", JSON.stringify(c));
check(c.cyclesElapsed > 0 && c.cyclesElapsed < 20000, "within one frame of cycles", JSON.stringify(c));
const bps = await mcp.call("runtime_breakpoint_list", { session_id: sid });
check(!/__until__/.test(bps), "no leftover breakpoint", bps);
check(c.instructionsElapsed > 0 && c.instructionsElapsed < c.cyclesElapsed, "instructionsElapsed is a real count", JSON.stringify(c));

head("same bound through runtime_session_run until");
const r = await mcp.call("runtime_session_run", { session_id: sid, max_instructions: 1, until: { kind: "pc", pc: "$0002" }, cycle_budget: 5000 });
const adv = Number(/Advanced (\d+) cycles/.exec(r)?.[1]);
check(adv >= 5000 && adv <= 5007 && /Did NOT reach/.test(r), "until + cycle_budget 5000 stops after ~5000 cycles", r);
const r2 = await mcp.call("runtime_session_run", { session_id: sid, max_instructions: 1, until: { kind: "pc", pc: "$FF48" }, cycle_budget: 200000 });
check(/Stopped at \$FF48/.test(r2), "until reaches $FF48", r2);

head("the PC already at the target: the daemon halts at once");
const e = await until(0xff48, 200000);
check(e.halted === true && e.finalPc === 0xff48 && e.cyclesElapsed === 0, "halted, 0 cycles: the PC stands on the target already", JSON.stringify(e));

head("runtime_step_over forwards its budget");
// A JSR to the KERNAL screen clear ($E544, several thousand cycles) planted in RAM at $0334.
await mcp.call("runtime_monitor", { session_id: sid, command: "wr 0334 20 44 e5" });
await mcp.call("runtime_monitor", { session_id: sid, command: "r pc=0334" });
const so = async (budget) => JSON.parse(await mcp.call("runtime_step_over", { session_id: sid, budget }));
const small = await so(100);
check(small.halted === false && small.haltReason === "budget_exhausted" && small.cyclesElapsed >= 100 && small.cyclesElapsed <= 110, "budget 100 ends the step over the JSR in 100..110 cycles (a stolen-cycle instruction over)", JSON.stringify(small));
await mcp.call("runtime_monitor", { session_id: sid, command: "r pc=0334" });
const big = await so(1000000);
check(big.halted === true && big.haltReason === "next_pc" && big.cyclesElapsed > 1000 && big.instructionsElapsed > 1, "a large budget runs the JSR through", JSON.stringify(big));

await mcp.call("runtime_sandbox_end", { session_id: sid, outcome: "reached", summary: "done" });
H.stopMcps();
const code = T.done();
H.cleanup();
process.exit(code);
