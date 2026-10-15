#!/usr/bin/env node
// Issue #89 — runtime_until honours its cycle budget and reports real instruction counts.
//
// Before: every run went about 10 000 000 cycles whatever `budget` said, and
// `instructionsElapsed` repeated `cyclesElapsed`. On a bare sandbox at the BASIC prompt:
//   U1  budget 1000, unreachable target    -> stops at 1000..1007 cycles, budgetExhausted
//   U2  budget 100000, unreachable target  -> stops at 100000..100007 cycles
//   U3  instructionsElapsed < cyclesElapsed (a 6510 instruction takes 2..7 cycles), and > 0
//   U4  a reachable target ($E5CD, the KERNAL's wait-for-key loop) still halts at that PC
// Daemons of this run's own on free ports. SKIPS LOUDLY without a trx64-daemon binary.
//   Locally:  C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:issue89-until-budget
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Harness, ROOT, findDaemon, makeChecker } from "./lib/e2e-906-harness.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }

const T = makeChecker("e2e-issue89");
const { check, head } = T;

const DAEMON = await findDaemon();
if (!DAEMON) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED — no trx64-daemon binary (set C64RE_RUNTIME_BIN, or `c64re runtime install`). Skipped, NOT passed.");
  process.exit(0);
}
process.env.C64RE_RUNTIME_BIN = DAEMON;
console.log(`runtime: ${DAEMON}`);

const H = new Harness("c64re-89-");
process.env.C64RE_STATE_DIR = H.state;
const proj = await H.project("proj");
const shared = await H.daemon(DAEMON, await H.project("shared"));
const mcp = await H.mcp(proj, { endpoint: shared.endpoint });

const started = await mcp.call("runtime_sandbox_start", { purpose: "issue 89: runtime_until budget", budget_minutes: 5 });
const sb = /\bsb-[a-z0-9-]+\b/.exec(started)?.[0];
check(!!sb, "a bare sandbox session", started.slice(0, 200));

const until = async (addr, budget) => {
  const text = await mcp.call("runtime_until", { session_id: sb, addr, budget });
  try { return JSON.parse(text); } catch { return { text }; }
};
const show = (r) => JSON.stringify(r);

head("U1  budget 1000, a target the CPU never reaches");
const r1 = await until(2, 1000);
console.log(`  runtime_until(addr 2, budget 1000) -> ${show(r1)}`);
check(r1.cyclesElapsed >= 1000 && r1.cyclesElapsed <= 1007, "cyclesElapsed in 1000..1007", show(r1));
check(r1.budgetExhausted === true && r1.halted === false, "budgetExhausted true, halted false", show(r1));

head("U2  budget 100000");
const r2 = await until(2, 100000);
console.log(`  runtime_until(addr 2, budget 100000) -> ${show(r2)}`);
check(r2.cyclesElapsed >= 100000 && r2.cyclesElapsed <= 100007, "cyclesElapsed in 100000..100007", show(r2));
check(r2.budgetExhausted === true, "budgetExhausted true", show(r2));

head("U3  instructions are counted, not cycles");
for (const [n, r] of [["1000", r1], ["100000", r2]]) {
  check(r.instructionsElapsed > 0 && r.instructionsElapsed < r.cyclesElapsed, `budget ${n}: 0 < instructionsElapsed < cyclesElapsed`, show(r));
  check(r.instructionsElapsed * 2 <= r.cyclesElapsed + 7, `budget ${n}: at least 2 cycles per instruction`, show(r));
}

head("U4  a reachable target still halts there");
const r4 = await until(0xe5cd, 100000);
console.log(`  runtime_until(addr $E5CD, budget 100000) -> ${show(r4)}`);
check(r4.halted === true && r4.finalPc === 0xe5cd, "halted true at $E5CD", show(r4));
check(r4.budgetExhausted === false && r4.cyclesElapsed <= 100007, "…within the budget", show(r4));

await mcp.call("runtime_sandbox_end", { session_id: sb, outcome: "reached", summary: "issue 89 checks done" });
process.exit(T.done());
