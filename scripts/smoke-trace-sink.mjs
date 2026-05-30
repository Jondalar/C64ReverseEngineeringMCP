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
let capturedRunId = "";
try {
  const [[runs]] = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_run");
  const [[events]] = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_event");
  const [[marks]] = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_mark");
  capturedRunId = String((await store.queryTraceRunStore(st, "SELECT run_id FROM trace_run LIMIT 1"))[0][0]);
  ok(Number(runs) === 1, "trace_run header row present", `runs=${runs}`);
  ok(Number(events) > 0, "trace_event rows captured", `events=${events}`);
  ok(Number(marks) === 2, "trace_mark rows present (start+end)", `marks=${marks}`);
  const cpuRows = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_event WHERE channel='cpu'");
  const memRows = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_event WHERE channel IN ('bus_access','io')");
  ok(Number(cpuRows[0][0]) > 0, "cpu rows present (code evidence)", `cpu=${cpuRows[0][0]}`);
  ok(Number(memRows[0][0]) > 0, "mem rows present (producer enabled)", `mem=${memRows[0][0]}`);
} finally { await store.closeTraceRunStore(st); }

// Part 3 — the SAME trace.duckdb must be readable via the MCP-tool readers
// (trace_store_* + runtime_query_events). They consume the 726 schema directly
// (trace_run / trace_event / trace_mark), per Spec 726 §6a.
console.log("\nPart 3 — readable through the MCP-tool readers (726 schema)\n");
const q = await import(`${ROOT}/dist/runtime/trace-store/queries.js`);

const info = await q.getInfo(TRACE_OUT);
// Spec 726 §6a: getInfo on a live-sink store reports per-channel event counts
// from trace_event directly (events:cpu / events:total / marks), NOT a legacy
// `instructions` table count.
ok((info.tableCounts["events:total"] ?? 0n) > 0n, "getInfo: trace_event counts > 0 (726 schema)",
   `events:total=${info.tableCounts["events:total"]} events:cpu=${info.tableCounts["events:cpu"]} marks=${info.tableCounts.marks}`);
ok(info.meta.source === "live-sink-726" && info.meta.schema?.includes("trace_event"),
   "getInfo: reports the live-sink 726 schema identity",
   `source=${info.meta.source} schema=${info.meta.schema}`);
ok(info.masterClockRange && info.masterClockRange.max > info.masterClockRange.min,
   "getInfo: master_clock range non-empty",
   info.masterClockRange ? `${info.masterClockRange.min}..${info.masterClockRange.max}` : "missing");

const pcs = await q.topPcs(TRACE_OUT, "c64", 5);
ok(pcs.length > 0 && pcs[0].count > 0, "topPcs(c64) returns rows",
   pcs[0] ? `top pc=$${pcs[0].pc.toString(16)} n=${pcs[0].count}` : "no rows");

const anchors = await q.listAnchors(TRACE_OUT);
ok(anchors.length === 2, "listAnchors surfaces both trace marks",
   anchors.map(a => a.name).join(",") || "none");
const startAnchor = await q.findAnchor(TRACE_OUT, "start", 10);
ok(startAnchor.length === 1, "findAnchor('start') returns 1 occurrence",
   `count=${startAnchor.length}`);

// safeQuery is the raw-SQL escape hatch. On a 726 store it queries the real
// schema (trace_event), never a legacy compat table.
const sql = await q.safeQuery(TRACE_OUT,
  "SELECT count(*) FROM trace_event WHERE channel='cpu' AND CAST(json_extract(data_json,'$.pc') AS INTEGER) BETWEEN 57344 AND 65535");
ok(Number(sql[0][0]) > 0, "safeQuery: KERNAL-range cpu event count > 0 (726 schema)", `kernel pcs=${sql[0][0]}`);

// runtime_query_events backend path (Spec 232 → Spec-217 reader).
const { DuckDbQueryBackend } = await import(`${ROOT}/dist/runtime/headless/v2/duckdb-backend.js`);
const { queryEvents } = await import(`${ROOT}/dist/runtime/headless/v2/query-events.js`);
const duckdb = await import("@duckdb/node-api");
const inst = await duckdb.DuckDBInstance.create(TRACE_OUT);
const conn = await inst.connect();
try {
  const backend = new DuckDbQueryBackend(conn);
  const cpuRows = await queryEvents(backend, { runId: capturedRunId, family: "cpu_step", limit: 5 });
  ok(cpuRows.length > 0 && cpuRows[0].family === "cpu_step",
    "runtime_query_events: cpu_step rows materialise from the 726 schema",
    `rows=${cpuRows.length} first pc=$${cpuRows[0]?.pc?.toString(16) ?? "?"}`);
} finally { inst.closeSync?.(); }

// Part 4 — resolveStorePath must use the input as a PATH, not as a project hint
// (Bug 1, pre-Spec 726.4 hotfix). Cover all 3 shapes: absolute file, absolute
// directory containing trace.duckdb, and relative path under a fake project.
console.log("\nPart 4 — trace_store path resolver (Bug 1 fix)\n");
const ts = await import(`${ROOT}/dist/server-tools/trace-store.js`);
const TRACE_DIR = `${ROOT}/.tmp/smoke-trace-sink`;
const fakeCtx = { projectDir: () => TRACE_DIR };
ok(ts.resolveStorePath(TRACE_OUT, fakeCtx) === TRACE_OUT,
   "absolute file path → returned as-is", TRACE_OUT);
ok(ts.resolveStorePath(TRACE_DIR, fakeCtx) === TRACE_OUT,
   "absolute dir path → resolves to trace.duckdb inside", `${TRACE_DIR}/trace.duckdb`);
ok(ts.resolveStorePath("trace.duckdb", fakeCtx) === TRACE_OUT,
   "relative path → joined under projectDir, not stripped", `trace.duckdb under ${TRACE_DIR}`);
let badThrew = false;
try { ts.resolveStorePath("does-not-exist.duckdb", fakeCtx); } catch { badThrew = true; }
ok(badThrew, "missing path → throws (no silent fallback to project root)");

// Part 5 — Spec 726 §6a direct-read contract. A live-sink store has ONLY the
// base tables (trace_run / trace_event / trace_mark). The readers must work
// against that schema DIRECTLY, without any meta / instructions compat table.
// Simulate the pure durable store by dropping every compat artifact, then read.
console.log("\nPart 5 — readers consume the 726 schema directly (no compat tables)\n");
const duckdb2 = await import("@duckdb/node-api");
const inst2 = await duckdb2.DuckDBInstance.create(TRACE_OUT);
const conn2 = await inst2.connect();
for (const ddl of [
  "DROP VIEW IF EXISTS instructions",
  "DROP VIEW IF EXISTS bus_events",
  "DROP VIEW IF EXISTS chip_events",
  "DROP VIEW IF EXISTS anchors",
  "DROP VIEW IF EXISTS rollups",
  "DROP TABLE IF EXISTS meta",
]) await conn2.run(ddl);
inst2.closeSync?.();
// Confirm the store is now pure 726 (the legacy table really is gone).
const inst3 = await duckdb2.DuckDBInstance.create(TRACE_OUT);
const conn3 = await inst3.connect();
let legacyGone = false;
try { await conn3.runAndReadAll("SELECT count(*) FROM instructions"); }
catch { legacyGone = true; }
inst3.closeSync?.();
ok(legacyGone, "pure 726 store: no `instructions` table present");

// The readers must read the 726 schema directly — no compat install needed.
const info2 = await q.getInfo(TRACE_OUT);
ok((info2.tableCounts["events:total"] ?? 0n) > 0n,
   "direct read: getInfo works on a pure 726 store",
   `events:total=${info2.tableCounts["events:total"]}`);
ok(info2.meta.source === "live-sink-726",
   "direct read: getInfo reports the live-sink 726 schema identity",
   `source=${info2.meta.source}`);
const pcs2 = await q.topPcs(TRACE_OUT, "c64", 3);
ok(pcs2.length > 0 && pcs2[0].count > 0,
   "direct read: topPcs works on a pure 726 store",
   pcs2[0] ? `top pc=$${pcs2[0].pc.toString(16)} n=${pcs2[0].count}` : "no rows");
const anchors2 = await q.listAnchors(TRACE_OUT);
ok(anchors2.length === 2,
   "direct read: listAnchors works on a pure 726 store",
   anchors2.map(a => a.name).join(",") || "none");
// runtime_query_events backend must read 726 directly (no compat install).
const inst4 = await duckdb2.DuckDBInstance.create(TRACE_OUT);
const conn4 = await inst4.connect();
try {
  const backend2 = new DuckDbQueryBackend(conn4);
  const rows2 = await queryEvents(backend2, { runId: capturedRunId, family: "cpu_step", limit: 3 });
  ok(rows2.length > 0 && rows2[0].family === "cpu_step",
    "direct read: runtime_query_events reads the 726 schema",
    `rows=${rows2.length}`);
} finally { inst4.closeSync?.(); }

// Part 6 — DuckDB lock-leak fix. Before the fix, runtime.ts reader handlers
// opened the file without closing the instance — the second call on the same
// file failed with "Conflicting lock is held". The new withDuckDb helper
// must close in finally so two successive reader calls succeed.
console.log("\nPart 6 — reader instance close (no lock leak across calls)\n");
const rt = await import(`${ROOT}/dist/server-tools/runtime.js`);
let leak = null;
try {
  await rt.withDuckDb(TRACE_OUT, async (conn) => {
    await conn.runAndReadAll("SELECT count(*) FROM trace_event LIMIT 1");
  });
  await rt.withDuckDb(TRACE_OUT, async (conn) => {
    await conn.runAndReadAll("SELECT count(*) FROM trace_event LIMIT 1");
  });
} catch (e) { leak = e?.message ?? String(e); }
ok(leak === null, "two successive withDuckDb calls succeed (no lock leak)", leak ?? "no error");

// Plus: alternating reader paths (queries.ts withConn + runtime.ts withDuckDb)
// must not deadlock either — the same lock-discipline must hold across modules.
let cross = null;
try {
  await q.getInfo(TRACE_OUT);
  await rt.withDuckDb(TRACE_OUT, async (conn) => {
    await conn.runAndReadAll("SELECT count(*) FROM trace_event");
  });
  await q.getInfo(TRACE_OUT);
} catch (e) { cross = e?.message ?? String(e); }
ok(cross === null, "alternating queries.ts + runtime.ts readers succeed", cross ?? "no error");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} trace-sink: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
