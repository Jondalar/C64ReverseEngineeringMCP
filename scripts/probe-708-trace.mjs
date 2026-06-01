#!/usr/bin/env node
// Spec 708 (+ 708.7-708.9 corrective slice) — declarative trace defs + DuckDB evidence.
//
//   G0   validation: a good def passes; malformed + the unsupported fields
//        (checkpointPolicy on-trigger, monitor-stop / manual-mark triggers) +
//        domain-coverage violations are rejected with PRECISE errors (708.7 —
//        no silent no-ops).
//   G1   real LOAD trace: cpu AND iec rows queryable from DuckDB.
//   G2   run links definition + start checkpoint + media + cycle range.
//   G3   tracedb mark → trace_mark row.
//   G4   reproducible event count across identical runs — WITHOUT the 500k cap.
//   G4a  real run did NOT overflow (bounded-complete, 708.8).
//   G5   active run reports explicit cost.
//   G6   teardown: after stop() the run's observer is gone and the channels it
//        enabled are restored to their prior state (708.8).
//   G7   mem-access.access is honoured: a write-only trace keeps only writes (708.7).
//   G8   capture SELECTION: a cpu-row-only def drops iec rows even when an iec
//        trigger matched (708.7 §10.2.1).
//   G9   checkpointPolicy "at-stop" captures + persists a stop checkpoint (708.7).
//   G10  iec-transition.line filter: only events changing the named line kept (708.7).
//   G11  overflow classification: an unbounded flood sets overflowed=true (708.8).

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
console.log(`Spec 708 + corrective slice — declarative trace + DuckDB  (tmp ${dir})`);

// C64-PC (KERNAL serial routines $ED00-$EFFF) + IEC transition trace.
function loadDef() {
  return {
    id: "serial-load-probe", version: 1, name: "Serial LOAD probe",
    domains: ["c64-cpu", "iec"],
    triggers: [
      { kind: "pc-range", domain: "c64-cpu", from: 0xED00, to: 0xEFFF },
      { kind: "iec-transition" },
    ],
    captures: [{ kind: "cpu-row", domain: "c64-cpu" }, { kind: "iec-row" }, { kind: "checkpoint-ref" }],
    stop: { kind: "cycle-budget", value: 999_000_000 },
    retention: "evidence",
    checkpointPolicy: "at-start",
  };
}

// ---- G0 validation + 708.7 precise rejects ----
{
  gate("G0 valid definition passes validation", validateTraceDefinition(loadDef()).ok);
  const bad = validateTraceDefinition({ id: "", version: 0, name: "", domains: [], triggers: [], captures: [], retention: "x" });
  gate("G0 malformed definition rejected with errors", !bad.ok && bad.errors.length >= 4, `${bad.errors.length} errors`);

  const onTrig = validateTraceDefinition({ ...loadDef(), checkpointPolicy: "on-trigger" });
  gate("G0 checkpointPolicy on-trigger rejected (708.7)", !onTrig.ok && onTrig.errors.some((e) => /on-trigger/.test(e)));
  const mon = validateTraceDefinition({ ...loadDef(), triggers: [{ kind: "monitor-stop" }] });
  gate("G0 monitor-stop trigger rejected (708.7)", !mon.ok && mon.errors.some((e) => /monitor-stop/.test(e)));
  const mm = validateTraceDefinition({ ...loadDef(), triggers: [{ kind: "manual-mark" }] });
  gate("G0 manual-mark trigger rejected (708.7)", !mm.ok && mm.errors.some((e) => /manual-mark/.test(e)));

  const cov = validateTraceDefinition({
    id: "c", version: 1, name: "c", domains: ["c64-cpu"],
    triggers: [{ kind: "pc-range", domain: "c64-cpu", from: 0, to: 0xff }],
    captures: [{ kind: "iec-row" }], retention: "transient",
  });
  gate("G0 capture without producing domain rejected (708.7 coverage)", !cov.ok && cov.errors.some((e) => /requires domain "iec"/.test(e)));
  const tcov = validateTraceDefinition({
    id: "t", version: 1, name: "t", domains: ["c64-cpu"],
    triggers: [{ kind: "mem-access", access: "any", from: 0, to: 0xff }],
    captures: [{ kind: "cpu-row", domain: "c64-cpu" }], retention: "transient",
  });
  gate("G0 trigger without producing domain rejected (708.7 coverage)", !tcov.ok && tcov.errors.some((e) => /requires domain "memory"/.test(e)));
}

// ---- real bounded-complete LOAD trace (~2M-cycle window → ~300k events < 500k) ----
async function runRealTrace(out, withMark) {
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.resetCold("pal-default");
    session.runFor(5_000_000, { cycleBudget: 5_000_000 });
    await mountMedia(session, 8, motm);

    const reg = session.kernel.trace();
    const before = { obs: reg.hasObservers(), cpu: reg.isEnabled("cpu"), iec: reg.isEnabled("iec") };
    const tr = new TraceRunController();
    const run = await tr.start(loadDef(), { controller: ctrl, outputPath: out });
    session.typeText('LOAD"*",8,1\r');
    session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    if (withMark) tr.mark("load-midpoint");
    session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    const status = tr.status();
    const finished = await tr.stop();
    const teardown = {
      obsRestored: reg.hasObservers() === before.obs,
      cpuRestored: reg.isEnabled("cpu") === before.cpu,
      iecRestored: reg.isEnabled("iec") === before.iec,
    };
    return { run: finished, status, teardown };
  } finally { stopIntegratedSession(sessionId); }
}

let firstCount = -1;
{
  const out = join(dir, "run1.duckdb");
  const { run, status, teardown } = await runRealTrace(out, true);

  const store = await openTraceRunStore(out);
  let runRows, cpuN, iecN, markRows;
  try {
    runRows = await queryTraceRunStore(store, "SELECT run_id, def_id, start_checkpoint_id, media_sha, cycle_start, cycle_end FROM trace_run");
    cpuN = Number((await queryTraceRunStore(store, "SELECT count(*) FROM trace_event WHERE channel='cpu'"))[0][0]);
    iecN = Number((await queryTraceRunStore(store, "SELECT count(*) FROM trace_event WHERE channel='iec'"))[0][0]);
    markRows = await queryTraceRunStore(store, "SELECT label FROM trace_mark");
  } finally { await closeTraceRunStore(store); }
  firstCount = run.eventCount;

  gate("G1 trace started + cpu AND iec rows queryable from DuckDB",
    runRows.length === 1 && cpuN > 0 && iecN > 0, `cpu=${cpuN} iec=${iecN} total=${run.eventCount}`);
  const r = runRows[0];
  gate("G2 run links definition + start checkpoint + media + cycle range",
    String(r[1]) === "serial-load-probe" && r[2] != null && r[3] != null && Number(r[5]) > Number(r[4]),
    `def=${r[1]} cp=${r[2]} cyc=${r[4]}..${r[5]}`);
  gate("G3 tracedb mark produced an evidence row",
    markRows.length === 1 && markRows[0][0] === "load-midpoint", `marks=${markRows.length}`);
  gate("G4a real run bounded-complete: did NOT overflow (708.8)",
    status.overflowed === false && run.eventCount < 500_000, `events=${run.eventCount} overflow=${status.overflowed}`);
  gate("G5 active run reports explicit cost (event/byte count)",
    run.eventCount > 0 && run.bytesWritten > 0 && typeof run.overheadMs === "number",
    `events=${run.eventCount} bytes=${run.bytesWritten} overhead=${run.overheadMs}ms`);
  gate("G6 teardown: observer gone + run channels restored after stop (708.8)",
    teardown.obsRestored && teardown.cpuRestored && teardown.iecRestored,
    `obs=${teardown.obsRestored} cpu=${teardown.cpuRestored} iec=${teardown.iecRestored}`);
}

// ---- G4 reproducibility (uncapped) ----
{
  const out = join(dir, "run2.duckdb");
  const { run, status } = await runRealTrace(out, false);
  gate("G4 reproducible event count across identical runs, uncapped (708.8)",
    run.eventCount === firstCount && firstCount > 0 && status.overflowed === false,
    `${firstCount} == ${run.eventCount}, overflow=${status.overflowed}`);
}

// ---- synthetic field battery (deterministic, one session, direct channel publish) ----
{
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.resetCold("pal-default");
    session.runFor(500_000, { cycleBudget: 500_000 });
    const reg = session.kernel.trace();

    // start a def, publish synthetic events through the SAME registry, stop, query.
    async function synth(def, publishFn) {
      const out = join(dir, `${def.id}.duckdb`);
      const tr = new TraceRunController();
      await tr.start(def, { controller: ctrl, outputPath: out });
      let ts = session.c64Cpu.cycles + 1;
      publishFn(reg, () => ts++);
      const status = tr.status();
      const run = await tr.stop();
      const store = await openTraceRunStore(out);
      let rows;
      try { rows = await queryTraceRunStore(store, "SELECT channel, trigger_kind, data_json FROM trace_event ORDER BY seq"); }
      finally { await closeTraceRunStore(store); }
      return { run, status, rows };
    }

    // G7 — mem-access.access=write keeps only writes
    {
      const def = {
        id: "memwrite", version: 1, name: "mw", domains: ["memory"],
        triggers: [{ kind: "mem-access", access: "write", from: 0x1000, to: 0x1fff }],
        captures: [{ kind: "mem-row" }], retention: "transient",
      };
      const { rows } = await synth(def, (r, t) => {
        r.publish("bus_access", t(), { op: "write", addr: 0x1234, value: 1, side: "c64" });
        r.publish("bus_access", t(), { op: "read", addr: 0x1234, value: 1, side: "c64" });
        r.publish("bus_access", t(), { op: "write", addr: 0x1abc, value: 2, side: "c64" });
        r.publish("bus_access", t(), { op: "read", addr: 0x1abc, value: 2, side: "c64" });
        r.publish("bus_access", t(), { op: "write", addr: 0x1fff, value: 3, side: "c64" });
      });
      const ops = rows.map((x) => JSON.parse(x[2]).op);
      gate("G7 mem-access.access=write captures only writes (708.7)",
        rows.length === 3 && ops.every((o) => o === "write"), `rows=${rows.length} ops=[${ops.join(",")}]`);
    }

    // G8 — capture selection drops undeclared iec rows
    {
      const def = {
        id: "capsel", version: 1, name: "cs", domains: ["c64-cpu", "iec"],
        triggers: [{ kind: "pc-range", domain: "c64-cpu", from: 0xE000, to: 0xEFFF }, { kind: "iec-transition" }],
        captures: [{ kind: "cpu-row", domain: "c64-cpu" }], retention: "transient",
      };
      const { rows } = await synth(def, (r, t) => {
        r.publish("cpu", t(), { side: 0, pc: 0xE010, opcode: 0xEA });
        r.publish("iec", t(), { atn: 1, clk: 0, data: 1 });
        r.publish("cpu", t(), { side: 0, pc: 0xE020, opcode: 0xEA });
        r.publish("iec", t(), { atn: 1, clk: 1, data: 1 });
      });
      const chans = rows.map((x) => x[0]);
      gate("G8 capture selection drops undeclared iec rows (708.7)",
        rows.length === 2 && chans.every((c) => c === "cpu"), `rows=${rows.length} chans=[${chans.join(",")}]`);
    }

    // G10 — iec-transition.line=clk keeps only clk changes
    {
      const def = {
        id: "iecclk", version: 1, name: "ic", domains: ["iec"],
        triggers: [{ kind: "iec-transition", line: "clk" }], captures: [{ kind: "iec-row" }], retention: "transient",
      };
      const { rows } = await synth(def, (r, t) => {
        r.publish("iec", t(), { atn: 1, clk: 0, data: 1 }); // prev null → no change logged
        r.publish("iec", t(), { atn: 1, clk: 0, data: 0 }); // data changed, clk same → no match
        r.publish("iec", t(), { atn: 1, clk: 1, data: 0 }); // clk changed → match
        r.publish("iec", t(), { atn: 1, clk: 1, data: 1 }); // data changed, clk same → no match
        r.publish("iec", t(), { atn: 1, clk: 0, data: 1 }); // clk changed → match
      });
      gate("G10 iec-transition.line=clk captures only clk changes (708.7)", rows.length === 2, `rows=${rows.length}`);
    }

    // G9 — checkpointPolicy at-stop captures + persists a stop checkpoint
    {
      const def = {
        id: "atstop", version: 1, name: "as", domains: ["c64-cpu"],
        triggers: [{ kind: "pc-range", domain: "c64-cpu", from: 0xE000, to: 0xEFFF }],
        captures: [{ kind: "cpu-row", domain: "c64-cpu" }, { kind: "checkpoint-ref" }],
        retention: "evidence", checkpointPolicy: "at-stop",
      };
      const out = join(dir, "atstop.duckdb");
      const tr = new TraceRunController();
      await tr.start(def, { controller: ctrl, outputPath: out });
      reg.publish("cpu", session.c64Cpu.cycles + 1, { side: 0, pc: 0xE055, opcode: 0xEA });
      const run = await tr.stop();
      const store = await openTraceRunStore(out);
      let row;
      try { row = (await queryTraceRunStore(store, "SELECT stop_checkpoint_id, start_checkpoint_id FROM trace_run"))[0]; }
      finally { await closeTraceRunStore(store); }
      gate("G9 at-stop checkpoint captured + persisted, no start checkpoint (708.7)",
        run.stopCheckpointId != null && row[0] != null && row[1] == null,
        `stop=${run.stopCheckpointId} startNull=${row[1] == null}`);
    }

    // G11 — unbounded flood classified as overflow
    {
      const def = {
        id: "flood", version: 1, name: "fl", domains: ["c64-cpu"],
        triggers: [{ kind: "pc-range", domain: "c64-cpu", from: 0xE000, to: 0xEFFF }],
        captures: [{ kind: "cpu-row", domain: "c64-cpu" }], retention: "transient",
      };
      const tr = new TraceRunController();
      // overflow classification is a LEGACY-JSON-path concept (bounded queue +
      // QUEUE_SOFT_LIMIT). Since Spec 746.x binary is the default, so request the
      // legacy path explicitly to exercise it. (capturing is NOT asserted false:
      // overflow only flags the queue; it does not stop capture — there is no
      // `stop` condition on this def, so capturing stays true. The prior
      // `capturing===false` clause was a spurious, pre-existing always-false
      // assertion.)
      await tr.start(def, { controller: ctrl, outputPath: join(dir, "flood.duckdb"), binary: false });
      for (let i = 0; i < 500_010; i++) reg.publish("cpu", i, { side: 0, pc: 0xE000, opcode: 0xEA });
      const status = tr.status();
      await tr.stop();
      gate("G11 unbounded flood classified as overflow (708.8, legacy JSON path)",
        status.overflowed === true,
        `events=${status.eventCount} overflow=${status.overflowed}`);
    }
  } finally { stopIntegratedSession(sessionId); }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 708 trace: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 708 trace: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
