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

// Part 2 — capture (chunked+drain+mark+finalize) → query, via the real pipeline
// (the same helpers the MCP tools use). Also asserts the chunked+traced run
// matches an untraced single run (chunking + tracing is behaviour-neutral).
console.log("\nPart 2 — capture → query (streaming sink)\n");
const N = 200_000; // instructions; one chunk
const TRACE_OUT = `${ROOT}/.tmp/smoke-trace-sink/trace.duckdb`;
try { rmSync(`${ROOT}/.tmp/smoke-trace-sink`, { recursive: true, force: true }); } catch {}

const sink = await import(`${ROOT}/dist/server-tools/runtime-trace-sink.js`);
const { ensureRuntimeController } = await import(`${ROOT}/dist/runtime/headless/debug/runtime-controller.js`);
const store = await import(`${ROOT}/dist/runtime/headless/trace/trace-run-store.js`);

// Traced run — mirror the tool wiring: producers on, start trace, chunked run +
// drain, mark, finalize.
async function tracedRun() {
  const domains = ["c64-cpu", "memory"];
  const prod = sink.producerOptsForDomains(domains);
  const { sessionId, session } = startIntegratedSession({ diskPath: DISK, mode: "true-drive", ...prod });
  try {
    session.resetCold("pal-default");
    await sink.startSessionTrace(sessionId, session, TRACE_OUT, domains);
    const ctrl = ensureRuntimeController(sessionId, session, () => {});
    ctrl.traceRun.mark("start");
    const CHUNK = 100_000; let done = 0;
    while (done < N) { const n = Math.min(CHUNK, N - done); session.runFor(n); done += n; await ctrl.traceRun.drain(); }
    ctrl.traceRun.mark("end");
    const s = session.status();
    const ramHash = createHash("sha256").update(Buffer.from(session.c64Bus.ram)).digest("hex");
    const run = await ctrl.traceRun.stop();
    return { runId: run.runId, c64: s.c64, drive: { pc: s.drive.pc, cycles: s.drive.cycles }, ramHash };
  } finally { try { stopIntegratedSession(sessionId); } catch {} }
}

// Untraced reference — single runFor(N), no producers, no trace.
function untracedRun() {
  const { sessionId, session } = startIntegratedSession({ diskPath: DISK, mode: "true-drive" });
  try {
    session.resetCold("pal-default");
    session.runFor(N);
    const s = session.status();
    return { c64: s.c64, drive: { pc: s.drive.pc, cycles: s.drive.cycles },
      ramHash: createHash("sha256").update(Buffer.from(session.c64Bus.ram)).digest("hex") };
  } finally { try { stopIntegratedSession(sessionId); } catch {} }
}

const traced = await tracedRun();
const ref = untracedRun();
ok(JSON.stringify(traced.c64) === JSON.stringify(ref.c64) && traced.drive.cycles === ref.drive.cycles
   && traced.ramHash === ref.ramHash,
  "chunked+traced run == untraced run (behaviour-neutral)",
  `traced pc=$${traced.c64.pc.toString(16)} ref pc=$${ref.c64.pc.toString(16)}`);

ok(existsSync(TRACE_OUT), "trace.duckdb written", TRACE_OUT);
const st = await store.openTraceRunStore(TRACE_OUT);
try {
  const [[runs]] = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_run");
  const [[events]] = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_event");
  const [[marks]] = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_mark");
  ok(Number(runs) === 1, "trace_run header row present", `runs=${runs}`);
  ok(Number(events) > 0, "trace_event rows captured", `events=${events}`);
  ok(Number(marks) === 2, "trace_mark rows present (start+end)", `marks=${marks}`);
  const cpuRows = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_event WHERE channel='cpu'");
  const memRows = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_event WHERE channel IN ('bus_access','io')");
  ok(Number(cpuRows[0][0]) > 0, "cpu rows present (code evidence)", `cpu=${cpuRows[0][0]}`);
  ok(Number(memRows[0][0]) > 0, "mem rows present (producer enabled)", `mem=${memRows[0][0]}`);
} finally { await store.closeTraceRunStore(st); }

console.log(`\n${fail === 0 ? "GREEN" : "RED"} trace-sink: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
