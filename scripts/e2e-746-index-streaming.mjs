// Spec 746.x — STREAMING trace indexer + LAZY-ON-READ recovery.
//
// The bug: indexBinaryLog read the whole .c64retrace into one Buffer
// (readFileSync), which throws ERR_FS_FILE_TOO_LARGE past 2 GiB — so a long
// (multi-GB) trace could never be indexed. Real evidence: a 1.5 GB trace got a
// .duckdb, a 4.5 GB one did not.
//
// Fix proved here (without a 2 GiB fixture): force the streaming window loop on a
// SMALL trace via tiny header+window env overrides, so events straddle hundreds of
// window boundaries, and assert the indexed row count is EXACT (no boundary
// drop/dupe). Plus: an ORPHANED store (.c64retrace present, .duckdb deleted) is
// rebuilt lazily on read (ensureIndex), and a corrupt log surfaces a real error.
process.env.C64RE_INDEX_HEADER_BYTES = "4096";   // tiny header window
process.env.C64RE_INDEX_WINDOW_BYTES = "65536";  // 64 KiB event windows → many crossings

import { mkdtempSync, statSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "c64re-746idx-"));
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

const { startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { RuntimeController } = await import("../dist/runtime/headless/debug/runtime-controller.js");
const { TraceRunController } = await import("../dist/runtime/headless/trace/trace-run.js");
const { ensureIndex } = await import("../dist/runtime/headless/trace/background-indexer.js");
const { openTraceRunStore, queryTraceRunStore, closeTraceRunStore } = await import("../dist/runtime/headless/trace/trace-run-store.js");

console.log(`Spec 746.x — streaming indexer + lazy-on-read  (tmp ${dir})`);

const N = 300_000; // ~5 MB .c64retrace at ~16 B/event → ~80 × 64 KiB windows
const out = join(dir, "stream.duckdb");
const retrace = out.replace(/\.duckdb$/, ".c64retrace");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});

let exit = 0, runEvents = 0;
try {
  const ctrl = new RuntimeController(sessionId, session, () => {});
  session.resetCold("pal-default");
  const reg = session.kernel.trace();
  const def = {
    id: "stream", version: 1, name: "stream", domains: ["c64-cpu"],
    triggers: [{ kind: "pc-range", domain: "c64-cpu", from: 0x0000, to: 0xffff }],
    captures: [{ kind: "cpu-row", domain: "c64-cpu" }], retention: "transient",
  };
  const tr = new TraceRunController();
  await tr.start(def, { controller: ctrl, outputPath: out, binary: true });
  // Inject a broad CPU firehose through the observer (broad binary channel → writer).
  for (let i = 0; i < N; i++) reg.publish("cpu", i + 1, { side: 0, pc: 0xE000 + (i & 0x3ff), opcode: 0xEA });
  const run = await tr.stop();          // instant — index builds on the worker
  runEvents = run.eventCount;
  await tr.awaitIndex();                // wait for the (streamed) index

  ok(existsSync(retrace), "0 .c64retrace authority written", existsSync(retrace) ? `${statSync(retrace).size} B` : "missing");
  ok(statSync(retrace).size > 65536 * 4, "0b fixture spans many 64 KiB windows (streaming actually exercised)", `${statSync(retrace).size} B`);
  ok(existsSync(out), "1 background index published the .duckdb (atomic rename)", existsSync(out) ? "present" : "MISSING");

  // 2 streaming decode is EXACT across window boundaries: indexed rows == events.
  let rows = -1;
  { const s = await openTraceRunStore(out);
    try { rows = Number((await queryTraceRunStore(s, "SELECT count(*) FROM trace_event"))[0][0]); }
    finally { await closeTraceRunStore(s); } }
  ok(rows === N && runEvents === N, "2 streamed index is EXACT across window boundaries (no drop/dupe)", `rows=${rows} runEvents=${runEvents} expected=${N}`);

  // 3 LAZY-ON-READ orphan recovery: delete the .duckdb, keep the .c64retrace,
  //   ensureIndex rebuilds it from the authority (the 4.5 GB-orphan scenario).
  unlinkSync(out);
  ok(!existsSync(out), "3 orphan: .duckdb removed, .c64retrace kept", "removed");

  // 3b/3c resolveStorePath must PASS a missing .duckdb through when its .c64retrace
  //   exists (so the trace_store_* path can trigger the lazy rebuild) but still
  //   throw when neither exists.
  const { resolveStorePath } = await import("../dist/server-tools/trace-store.js");
  const ctxStub = { projectDir: () => { throw new Error("no proj"); } };
  let rsThrew = false, rsPath = "";
  try { rsPath = resolveStorePath(out, ctxStub); } catch { rsThrew = true; }
  ok(!rsThrew && rsPath === out, "3b resolveStorePath passes a missing .duckdb through when .c64retrace exists", rsThrew ? "threw" : "ok");
  let negThrew = false;
  try { resolveStorePath(join(dir, "nope.duckdb"), ctxStub); } catch { negThrew = true; }
  ok(negThrew, "3c resolveStorePath still throws when neither .duckdb nor .c64retrace exists");

  await ensureIndex(out);
  ok(existsSync(out), "4 lazy-on-read REBUILT the missing index from the .c64retrace authority");
  let rows2 = -1;
  { const s = await openTraceRunStore(out);
    try { rows2 = Number((await queryTraceRunStore(s, "SELECT count(*) FROM trace_event"))[0][0]); }
    finally { await closeTraceRunStore(s); } }
  ok(rows2 === N, "5 rebuilt index has all rows", `rows=${rows2}`);

  // 6 a corrupt .c64retrace surfaces a REAL error (not silent) via ensureIndex.
  const badDuck = join(dir, "bad.duckdb");
  writeFileSync(badDuck.replace(/\.duckdb$/, ".c64retrace"), Buffer.from("not a c64retrace header at all"));
  let surfaced = "";
  try { await ensureIndex(badDuck); } catch (e) { surfaced = e.message; }
  ok(/index unavailable|trace index|c64retrace/i.test(surfaced) && !existsSync(badDuck),
    "6 corrupt log surfaces a real index error (no silent fail, no phantom store)", surfaced.slice(0, 70) || "(no throw)");
} catch (e) {
  console.error("FATAL", e.stack || e.message); exit = 2;
} finally {
  stopIntegratedSession(sessionId);
}

console.log(`\nSpec 746.x index-streaming: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
