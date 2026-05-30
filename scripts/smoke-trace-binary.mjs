// Spec 726.B gate — binary `.c64retrace` timeline + rebuildable DuckDB index.
//
// 1. A live binary trace writes a `.c64retrace` log with magic/version + events
//    + marks, and reports zero drops (no-drop evidence mode).
// 2. The DuckDB index is REBUILDABLE from the log alone (delete + rebuild to a
//    fresh path) and the readers work against the rebuilt store.
// 3. The binary log is the authority: the rebuilt index event count matches the
//    log's decoded event count.
import { existsSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DISK = `${ROOT}/samples/synthetic/1block.g64`;
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

const { startIntegratedSession, stopIntegratedSession } =
  await import(`${ROOT}/dist/runtime/headless/integrated-session-manager.js`);
const sink = await import(`${ROOT}/dist/server-tools/runtime-trace-sink.js`);
const { ensureRuntimeController } = await import(`${ROOT}/dist/runtime/headless/debug/runtime-controller.js`);
const fmt = await import(`${ROOT}/dist/runtime/headless/trace/binary-format.js`);
const { retracePathFor } = await import(`${ROOT}/dist/runtime/headless/trace/trace-run.js`);
const { indexBinaryLog, readBinaryLogMeta } = await import(`${ROOT}/dist/runtime/headless/trace/binary-log-indexer.js`);
const store = await import(`${ROOT}/dist/runtime/headless/trace/trace-run-store.js`);
const q = await import(`${ROOT}/dist/runtime/trace-store/queries.js`);

console.log("Spec 726.B — smoke-trace-binary\n");

const OUTDIR = `${ROOT}/.tmp/smoke-trace-binary`;
try { rmSync(OUTDIR, { recursive: true, force: true }); } catch {}
const TRACE_OUT = `${OUTDIR}/trace.duckdb`;
const RETRACE = retracePathFor(TRACE_OUT);
const N = 300_000;

const domains = ["c64-cpu", "memory"];
const prod = sink.producerOptsForDomains(domains);
const { sessionId, session } = startIntegratedSession({ diskPath: DISK, mode: "true-drive", ...prod });
let runSummary, statusAtStop;
try {
  session.resetCold("pal-default");
  await sink.startSessionTrace(sessionId, session, TRACE_OUT, domains);
  const ctrl = ensureRuntimeController(sessionId, session, () => {});
  ctrl.traceRun.mark("boot");
  const CHUNK = 100_000; let done = 0;
  while (done < N) { const n = Math.min(CHUNK, N - done); session.runFor(n); done += n; await ctrl.traceRun.drain(); }
  ctrl.traceRun.mark("ready");
  statusAtStop = ctrl.traceRun.status();
  runSummary = await ctrl.traceRun.stop();
} finally { try { stopIntegratedSession(sessionId); } catch {} }

// 1 — the binary log exists and is well-formed.
ok(existsSync(RETRACE), ".c64retrace log written", RETRACE);
const buf = new Uint8Array(readFileSync(RETRACE));
let headerOk = true, version = 0, headerLen = 0;
try { const h = fmt.decodeFileHeader(buf); version = h.version; headerLen = h.headerLen; }
catch (e) { headerOk = false; console.log("    decode error:", e.message); }
ok(headerOk, "file header decodes (magic ok)", `version=${version}`);
ok(version === fmt.C64RETRACE_FORMAT_VERSION, "format version matches", `v${version}`);

const meta = readBinaryLogMeta(RETRACE);
ok(meta.runId === runSummary.runId, "header run metadata present", `run=${meta.runId} domains=${meta.domains?.join("+")}`);

const events = fmt.decodeEventStream(buf, headerLen);
const cpuEvents = events.filter((e) => e.op === fmt.TraceOp.CPU_STEP).length;
const markEvents = events.filter((e) => e.op === fmt.TraceOp.MARK);
ok(events.length > 0, "events decode from the log", `events=${events.length}`);
ok(cpuEvents === N, "one CPU_STEP per executed instruction", `cpu=${cpuEvents} expected=${N}`);
ok(markEvents.length === 2 && markEvents.map((m) => m.label).join(",") === "boot,ready",
   "MARK records embedded in the log", markEvents.map((m) => m.label).join(","));

// no-drop invariant
ok(statusAtStop.binary === true, "status reports binary mode", `binary=${statusAtStop.binary}`);
ok(statusAtStop.overflowed === false, "no overflow/backpressure drop flagged");
ok(runSummary.bytesWritten === buf.length, "writer byte count == file size (no truncation)",
   `bytes=${runSummary.bytesWritten} file=${buf.length}`);

// 2 — rebuild the DuckDB index from the log alone, to a FRESH path.
console.log("\nRebuild DuckDB index from the log alone\n");
const REBUILT = `${OUTDIR}/rebuilt.duckdb`;
const idx = await indexBinaryLog(RETRACE, REBUILT);
ok(existsSync(REBUILT), "rebuilt index written to a fresh path", REBUILT);
ok(idx.eventCount === cpuEvents + events.filter((e) =>
   [fmt.TraceOp.RAM_WRITE, fmt.TraceOp.IO_WRITE, fmt.TraceOp.DRIVE_RAM_WRITE, fmt.TraceOp.DRIVE_CPU_STEP,
    fmt.TraceOp.IEC_LINE_CHANGE, fmt.TraceOp.VIC_REG_WRITE, fmt.TraceOp.SID_REG_WRITE].includes(e.op)).length,
   "rebuilt event count == decoded non-mark events", `indexed=${idx.eventCount}`);
ok(idx.markCount === 2, "rebuilt index carries both marks", `marks=${idx.markCount}`);

// 3 — readers work against the rebuilt store.
const st = await store.openTraceRunStore(REBUILT);
try {
  const [[ev]] = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_event");
  ok(Number(ev) === idx.eventCount, "trace_event rows match indexer count", `rows=${ev}`);
} finally { await store.closeTraceRunStore(st); }
const info = await q.getInfo(REBUILT);
ok((info.tableCounts["events:total"] ?? 0n) > 0n, "getInfo reads the rebuilt index", `events:total=${info.tableCounts["events:total"]}`);
const pcs = await q.topPcs(REBUILT, "c64", 3);
ok(pcs.length > 0 && pcs[0].count > 0, "topPcs works on the rebuilt index", pcs[0] ? `pc=$${pcs[0].pc.toString(16)} n=${pcs[0].count}` : "none");
const anchors = await q.listAnchors(REBUILT);
ok(anchors.length === 2, "listAnchors works on the rebuilt index", anchors.map((a) => a.name).join(","));

// 4 — authority equivalence: the live index (built at finalize) and the rebuilt
// index must carry the same event count (DuckDB is a pure projection of the log).
const live = await q.getInfo(TRACE_OUT);
ok(live.tableCounts["events:total"] === info.tableCounts["events:total"],
   "live finalize-index == rebuilt index (DuckDB is a projection of the log)",
   `live=${live.tableCounts["events:total"]} rebuilt=${info.tableCounts["events:total"]}`);

console.log(`\n${fail === 0 ? "GREEN" : "RED"} trace-binary: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
