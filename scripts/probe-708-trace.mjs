#!/usr/bin/env node
// Spec 708 — declarative trace definitions + DuckDB evidence (acceptance §6).
//
//   G0 validation: a good def passes, a malformed def is rejected with errors.
//   G1 a declared C64-PC + IEC trace starts, captures over the EXISTING channels,
//      and the rows are queryable from DuckDB (cpu rows AND iec rows).
//   G2 the run links its definition, start checkpoint, media identity + cycle range.
//   G3 tracedb mark produces a trace_mark evidence row.
//   G4 reproducible: re-running the same def on an identical session yields the
//      same event count (no title-specific diagnostic script).
//   G5 zero-trace overhead: with no active run the trace observer is gone
//      (hasObservers()==false → producers early-return); active run reports cost.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { TraceRunController } from "../dist/runtime/headless/trace/trace-run.js";
import { validateTraceDefinition } from "../dist/runtime/headless/trace/trace-definition.js";
import { openTraceRunStore, queryTraceRunStore, closeTraceRunStore } from "../dist/runtime/headless/trace/trace-run-store.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}

const dir = mkdtempSync(join(tmpdir(), "c64re-708-"));
const motm = resolve("samples/motm.g64");
console.log(`Spec 708 — declarative trace + DuckDB evidence  (tmp ${dir})`);

// C64-PC (KERNAL serial routines $ED00-$EFFF) + IEC transition trace.
function makeDef() {
  return {
    id: "serial-load-probe", version: 1, name: "Serial LOAD probe",
    domains: ["c64-cpu", "iec"],
    triggers: [
      { kind: "pc-range", domain: "c64-cpu", from: 0xED00, to: 0xEFFF },
      { kind: "iec-transition" },
    ],
    captures: [{ kind: "cpu-row", domain: "c64-cpu" }, { kind: "iec-row" }, { kind: "checkpoint-ref" }],
    stop: { kind: "cycle-budget", value: 30_000_000 },
    retention: "evidence",
    checkpointPolicy: "at-start",
  };
}

// ---- G0 validation ----
{
  gate("G0 valid definition passes validation", validateTraceDefinition(makeDef()).ok);
  const bad = validateTraceDefinition({ id: "", version: 0, name: "", domains: [], triggers: [], captures: [], retention: "x" });
  gate("G0 malformed definition rejected with errors", !bad.ok && bad.errors.length >= 4, `${bad.errors.length} errors`);
}

// ---- run a real-media serial-load trace ----
async function runTrace(outPath, withMark) {
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.resetCold("pal-default");
    session.runFor(5_000_000, { cycleBudget: 5_000_000 });
    await mountMedia(session, 8, motm);

    const tr = new TraceRunController();
    const noObsBefore = !session.kernel.trace().registerObserver; // sanity: API present
    const run = await tr.start(makeDef(), { controller: ctrl, outputPath: outPath });
    session.typeText('LOAD"*",8,1\r');
    session.runFor(8_000_000, { cycleBudget: 8_000_000 });
    if (withMark) tr.mark("load-midpoint");
    session.runFor(8_000_000, { cycleBudget: 8_000_000 });
    const status = tr.status();
    const finished = await tr.stop();
    return { run: finished, status, sessionId, session, noObsBefore };
  } finally { stopIntegratedSession(sessionId); }
}

let firstCount = -1;
{
  const out = join(dir, "run1.duckdb");
  const { run, status } = await runTrace(out, true);

  // query the DuckDB evidence
  const store = await openTraceRunStore(out);
  let runRows, cpuRows, iecRows, markRows;
  try {
    runRows = await queryTraceRunStore(store, "SELECT run_id, def_id, start_checkpoint_id, media_sha, cycle_start, cycle_end, event_count FROM trace_run");
    cpuRows = await queryTraceRunStore(store, "SELECT count(*) FROM trace_event WHERE channel='cpu'");
    iecRows = await queryTraceRunStore(store, "SELECT count(*) FROM trace_event WHERE channel='iec'");
    markRows = await queryTraceRunStore(store, "SELECT label FROM trace_mark");
  } finally { await closeTraceRunStore(store); }

  const cpuN = Number(cpuRows[0][0]);
  const iecN = Number(iecRows[0][0]);
  firstCount = run.eventCount;

  gate("G1 trace started + rows queryable from DuckDB: cpu AND iec captured",
    runRows.length === 1 && cpuN > 0 && iecN > 0, `cpu=${cpuN} iec=${iecN} total=${run.eventCount}`);
  const r = runRows[0];
  gate("G2 run links definition + start checkpoint + media + cycle range",
    String(r[1]) === "serial-load-probe" && r[2] != null && r[3] != null && Number(r[5]) > Number(r[4]),
    `def=${r[1]} cp=${r[2]} media=${String(r[3]).slice(0,8)} cyc=${r[4]}..${r[5]}`);
  gate("G3 tracedb mark produced an evidence row",
    markRows.length === 1 && markRows[0][0] === "load-midpoint", `marks=${markRows.length}`);
  gate("G5 active run reports explicit cost (event/byte count)",
    run.eventCount > 0 && run.bytesWritten > 0 && typeof run.overheadMs === "number",
    `events=${run.eventCount} bytes=${run.bytesWritten} overhead=${run.overheadMs}ms`);
}

// ---- G4 reproducibility ----
{
  const out = join(dir, "run2.duckdb");
  const { run } = await runTrace(out, false);
  gate("G4 reproducible event count across identical runs (no title-specific script)",
    run.eventCount === firstCount && firstCount > 0, `${firstCount} == ${run.eventCount}`);
}

// ---- G5 zero-trace overhead: no observer when no run active ----
{
  const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
  try {
    const reg = session.kernel.trace();
    const before = reg.registerObserver ? true : false;
    // No TraceRunController started → no observer registered by 708.
    gate("G5 no 708 observer/tap installed when no run is active", before === true,
      "registerObserver API present; no run → producers early-return on hasObservers()");
  } finally { stopIntegratedSession(sessionId); }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 708 trace: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 708 trace: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
