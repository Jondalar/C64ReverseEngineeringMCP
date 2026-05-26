#!/usr/bin/env node
// Spec 708 — reusable trace-library patterns over DuckDB. Formalizes the ad-hoc
// /tmp diagnostic scripts (PC histogram, IO watch, IEC line) into canonical
// RuntimeTraceDefinitions.
//   P0  the builders produce valid definitions.
//   P1  a pcRegionProfile run lands cpu-rows in DuckDB and a GROUP-BY-pc query
//       reproduces the PC histogram — replacing the one-off PC-sampling script.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { TraceRunController } from "../dist/runtime/headless/trace/trace-run.js";
import { validateTraceDefinition } from "../dist/runtime/headless/trace/trace-definition.js";
import { pcRegionProfile, ioAccessWatch, iecLineTrace, pcHistogramSql } from "../dist/runtime/headless/trace/trace-library.js";
import { openTraceRunStore, queryTraceRunStore, closeTraceRunStore } from "../dist/runtime/headless/trace/trace-run-store.js";

const failures = [];
let passes = 0;
const gate = (n, ok, d) => {
  if (ok) { passes++; console.log(`  PASS  ${n}${d ? ` (${d})` : ""}`); }
  else { failures.push(n); console.log(`  RED   ${n}${d ? ` (${d})` : ""}`); }
};

const dir = mkdtempSync(join(tmpdir(), "c64re-708lib-"));
console.log(`Spec 708 — trace-library patterns  (tmp ${dir})`);

// ---- P0 builders produce valid definitions ----
{
  const a = pcRegionProfile({ from: 0xE000, to: 0xFFFF, cycleBudget: 2_000_000 });
  const b = ioAccessWatch({ from: 0xDD00, to: 0xDD0F, access: "write" });
  const c = iecLineTrace({ line: "clk" });
  gate("P0 pcRegionProfile valid", validateTraceDefinition(a).ok, a.id);
  gate("P0 ioAccessWatch valid", validateTraceDefinition(b).ok, b.id);
  gate("P0 iecLineTrace valid", validateTraceDefinition(c).ok, c.id);
}

// ---- P1 pcRegionProfile → DuckDB histogram ----
{
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.resetCold("pal-default");
    session.runFor(3_000_000, { cycleBudget: 3_000_000 }); // to READY (KERNAL main loop)

    const out = join(dir, "pcprof.duckdb");
    const def = pcRegionProfile({ id: "kernal-mainloop", from: 0xE000, to: 0xFFFF, cycleBudget: 2_000_000, checkpointPolicy: "at-start" });
    const tr = new TraceRunController();
    const run = await tr.start(def, { controller: ctrl, outputPath: out });
    session.runFor(2_000_000, { cycleBudget: 2_000_000 }); // idle KERNAL polling → hot PCs
    await tr.stop();

    const store = await openTraceRunStore(out);
    let hist;
    try { hist = await queryTraceRunStore(store, pcHistogramSql(run.runId, 8)); }
    finally { await closeTraceRunStore(store); }

    const inRange = hist.every((r) => Number(r[0]) >= 0xE000 && Number(r[0]) <= 0xFFFF);
    const topHits = hist.length ? Number(hist[0][1]) : 0;
    gate("P1 pcRegionProfile → PC histogram from DuckDB (replaces /tmp PC-sampling)",
      hist.length > 0 && topHits > 0 && inRange,
      `buckets=${hist.length} topPC=$${hist.length ? Number(hist[0][0]).toString(16) : "-"} hits=${topHits}`);
  } finally { stopIntegratedSession(sessionId); }
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 708 patterns: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 708 patterns: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
