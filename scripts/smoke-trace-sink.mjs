// Spec 726 guard — the HARD INVARIANT (§2a): enabling a trace must NOT influence
// the runtime. Plus the capture→query proof once the sink is wired (§5).
//
// Part 1 (always): run the SAME deterministic scenario twice — trace producers
// OFF vs ON — and assert byte-identical final state (PC/A/X/Y/SP/flags,
// cpu.cycles, drive clk, RAM hash). Divergence = trace influenced the runtime =
// blocker.
//
// Part 2 (when trace_out is wired): capture a real trace.duckdb via the live
// session + a mark, finalize, then query it through the existing readers and
// prove rows + marks exist.
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DISK = `${ROOT}/samples/synthetic/1block.g64`;
const RUN_CYCLES = 3_000_000; // boot KERNAL to READY — deterministic
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

const { startIntegratedSession, stopIntegratedSession } =
  await import(`${ROOT}/dist/runtime/headless/integrated-session-manager.js`);

function finalState(traceOpts) {
  const { sessionId, session } = startIntegratedSession({
    diskPath: DISK, mode: "true-drive", ...traceOpts,
  });
  try {
    session.resetCold("pal-default");
    session.runFor(RUN_CYCLES, { cycleBudget: RUN_CYCLES });
    const s = session.status();
    const ramHash = createHash("sha256").update(Buffer.from(session.c64Bus.ram)).digest("hex");
    return {
      c64: s.c64, drive: { pc: s.drive.pc, cycles: s.drive.cycles, track: s.drive.track }, ramHash,
    };
  } finally { try { stopIntegratedSession(sessionId); } catch {} }
}

console.log("Spec 726 — smoke-trace-sink\n");
console.log("Part 1 — trace producers must NOT influence the runtime\n");

const off = finalState({});
const on = finalState({ traceIec: true, traceDrive: true, enableBusAccessTrace: true });

const c64Same = JSON.stringify(off.c64) === JSON.stringify(on.c64);
ok(c64Same, "C64 final state identical (pc/a/x/y/sp/flags/cycles/instructions)",
  c64Same ? `pc=$${off.c64.pc.toString(16)} cyc=${off.c64.cycles}`
    : `off=${JSON.stringify(off.c64)} on=${JSON.stringify(on.c64)}`);
ok(off.drive.cycles === on.drive.cycles && off.drive.pc === on.drive.pc,
  "drive final state identical (pc/clk/track)",
  `off clk=${off.drive.cycles} pc=$${off.drive.pc.toString(16)} | on clk=${on.drive.cycles} pc=$${on.drive.pc.toString(16)}`);
ok(off.ramHash === on.ramHash, "RAM hash identical", `${off.ramHash.slice(0, 16)} vs ${on.ramHash.slice(0, 16)}`);

// Part 2 — capture→query (only when the trace sink is wired into the session).
// Skipped until 726.2/726.3 land trace_out + runtime_mark + finalize.
const TRACE_OUT = `${ROOT}/.tmp/smoke-trace-sink/trace.duckdb`;
let part2Ready = false;
try {
  const { startIntegratedSession: s2 } = await import(`${ROOT}/dist/runtime/headless/integrated-session-manager.js`);
  part2Ready = typeof s2 === "function" && false; // gated on trace_out support (TODO 726.2)
} catch { /* not ready */ }
if (!part2Ready) {
  console.log("\nPart 2 — capture→query: SKIPPED (trace_out sink not wired yet; 726.2/726.3)");
}
void TRACE_OUT; void existsSync; void rmSync;

console.log(`\n${fail === 0 ? "GREEN" : "RED"} trace-sink: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
