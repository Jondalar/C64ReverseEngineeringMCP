// Spec 726.B gate — drive8-cpu is a REAL product trace domain.
//
// Before the 726.B review fix, trace_domains=["drive8-cpu"] was exposed but no
// producer published drive_pc into the trace, so the DuckDB store had zero
// drive rows. This proves the sampled drive-PC producer now lands real
// channel='drive_pc' rows that the readers can see.
//
// NOTE: the drive trace is SAMPLED at the C64-instruction boundary (the drive
// advances in bulk via catchUpDrive), not a per-drive-instruction firehose.
// Full per-instruction drive trace is 726.B-2.
import { existsSync, rmSync } from "node:fs";
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
const store = await import(`${ROOT}/dist/runtime/headless/trace/trace-run-store.js`);
const q = await import(`${ROOT}/dist/runtime/trace-store/queries.js`);

console.log("Spec 726.B — smoke-trace-drive8 (drive8-cpu product domain)\n");

const OUTDIR = `${ROOT}/.tmp/smoke-trace-drive8`;
try { rmSync(OUTDIR, { recursive: true, force: true }); } catch {}
const TRACE_OUT = `${OUTDIR}/trace.duckdb`;
const N = 2_000_000; // boot — the drive ROM runs its loop, PC moves

const domains = ["drive8-cpu", "memory"]; // drive8-cpu must produce real rows
const prod = sink.producerOptsForDomains(domains);
ok(prod.traceDrive === true, "drive8-cpu domain enables the traceDrive producer", `traceDrive=${prod.traceDrive}`);

const { sessionId, session } = startIntegratedSession({ diskPath: DISK, mode: "true-drive", ...prod });
let runId = "";
try {
  session.resetCold("pal-default");
  const t = await sink.startSessionTrace(sessionId, session, TRACE_OUT, domains);
  runId = t.runId;
  const ctrl = ensureRuntimeController(sessionId, session, () => {});
  ctrl.traceRun.mark("boot");
  const CHUNK = 200_000; let done = 0;
  while (done < N) { const n = Math.min(CHUNK, N - done); session.runFor(n); done += n; await ctrl.traceRun.drain(); }
  ctrl.traceRun.mark("ready");
  await ctrl.traceRun.stop();
} finally { try { stopIntegratedSession(sessionId); } catch {} }

ok(existsSync(TRACE_OUT), "trace.duckdb written", TRACE_OUT);

const st = await store.openTraceRunStore(TRACE_OUT);
let driveRows = 0;
try {
  const [[d]] = await store.queryTraceRunStore(st, "SELECT count(*) FROM trace_event WHERE channel='drive_pc'");
  driveRows = Number(d);
  ok(driveRows > 0, "channel='drive_pc' rows present (real drive producer)", `drive_pc rows=${driveRows}`);
  // The drive PC rows carry a 'drive' side + a pc in data_json.
  const [[withPc]] = await store.queryTraceRunStore(st,
    "SELECT count(*) FROM trace_event WHERE channel='drive_pc' AND json_extract(data_json,'$.pc') IS NOT NULL");
  ok(Number(withPc) === driveRows, "every drive_pc row carries a pc", `withPc=${withPc}`);
} finally { await store.closeTraceRunStore(st); }

// Readers must surface the drive side.
const info = await q.getInfo(TRACE_OUT);
ok((info.tableCounts["events:total"] ?? 0n) > 0n, "getInfo reads the drive trace", `events:total=${info.tableCounts["events:total"]}`);
const drivePcs = await q.topPcs(TRACE_OUT, "drive8", 5);
ok(drivePcs.length > 0 && drivePcs[0].count > 0, "topPcs(drive8) returns drive PCs",
   drivePcs[0] ? `top drive pc=$${drivePcs[0].pc.toString(16)} n=${drivePcs[0].count}` : "no rows");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} trace-drive8: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
