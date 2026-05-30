// Spec 726 §6a / 729 E2E-I — trace writer/reader schema contract.
// Proves the convenience readers consume the LIVE-writer schema
// (trace_run / trace_event / trace_mark) directly — NOT the legacy
// meta / instructions tables, and NOT via a raw-SQL workaround.
//
// Fixture (a real 726-written store):
//   /Users/alex/Development/C64/Cracking/Murder/traces/smoke/trace.duckdb
//   run_id = run_live-capture_mprewdk9
//
// Usage: node scripts/smoke-trace-store-writer-reader-e2e.mjs [dbPath] [runId]
import { existsSync, readFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

const DEFAULT_DB = "/Users/alex/Development/C64/Cracking/Murder/traces/smoke/trace.duckdb";
const srcDb = process.argv[2] || DEFAULT_DB;
const runId = process.argv[3] || "run_live-capture_mprewdk9";

console.log(`Spec 726/729-I — trace writer/reader schema contract\n  fixture: ${srcDb}\n  run_id:  ${runId}\n`);

if (!existsSync(srcDb)) {
  console.log(`  PENDING  fixture not present — cannot run the live reader contract.`);
  console.log(`           expected a 726-written store at ${srcDb}`);
  console.log(`\nPENDING (no fixture). 0 pass, 0 fail.`);
  process.exit(0);
}

// Work on a COPY — never open/mutate the user's fixture (DuckDB takes a write
// lock and earlier compat-on-read could add tables). Read-only contract.
const tmpDir = mkdtempSync(join(tmpdir(), "c64re-trace-smoke-"));
const dbPath = join(tmpDir, basename(srcDb));
copyFileSync(srcDb, dbPath);

// ---- A. the fixture itself is the 726 schema (base tables, no meta/instructions) ----
const duckdb = await import("@duckdb/node-api");
async function rawTables() {
  const inst = await duckdb.DuckDBInstance.create(dbPath);
  try {
    const conn = await inst.connect();
    const r = await conn.runAndReadAll(
      "SELECT table_name FROM information_schema.tables WHERE table_type='BASE TABLE' ORDER BY table_name");
    return r.getRows().map((x) => String(x[0]));
  } finally { inst.closeSync?.(); }
}
const baseTables = await rawTables();
ok(["trace_run", "trace_event", "trace_mark"].every((t) => baseTables.includes(t)),
  "A1 fixture is a live-sink store (trace_run/trace_event/trace_mark base tables)", baseTables.join(","));
// The durable writer NEVER creates `instructions` as a base table (that is a
// Spec-217 native-store table). A stray `meta` may exist as a harmless
// pre-existing compat artifact; what matters (E1) is that no reader queries it.
ok(!baseTables.includes("instructions"),
  "A2 live-sink store has NO legacy instructions base table", baseTables.includes("instructions") ? "present" : "none");

// ---- B. convenience readers work against the 726 store ----
const q = await import(`${ROOT}/dist/runtime/trace-store/queries.js`);

try {
  const info = await q.getInfo(dbPath);
  const counts = info.tableCounts || {};
  const totalEvents = Object.values(counts).reduce((a, b) => a + Number(b), 0);
  ok(totalEvents > 0, "B1 trace_store_info reports event/channel/mark counts", `counts=${JSON.stringify(Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])))}`);
} catch (e) { ok(false, "B1 trace_store_info", e.message); }

try {
  const pcs = await q.topPcs(dbPath, "c64", 10);
  ok(Array.isArray(pcs) && pcs.length > 0 && typeof pcs[0].pc === "number",
    "B2 trace_store_top_pcs cpu=c64 returns top PCs", pcs.length ? `top=$${pcs[0].pc.toString(16)} n=${pcs[0].count}` : "empty");
} catch (e) { ok(false, "B2 trace_store_top_pcs", e.message); }

// ---- C. runtime_query_events maps family→channel and returns rows ----
try {
  const { queryEvents } = await import(`${ROOT}/dist/runtime/headless/v2/query-events.js`);
  const { DuckDbQueryBackend } = await import(`${ROOT}/dist/runtime/headless/v2/duckdb-backend.js`);
  const inst = await duckdb.DuckDBInstance.create(dbPath);
  try {
    const conn = await inst.connect();
    const backend = new DuckDbQueryBackend(conn);
    // find a real PC that exists, then query a 1-PC window.
    const pcs = await q.topPcs(dbPath, "c64", 1);
    const targetPc = pcs[0]?.pc ?? 0xe5cd;
    const rows = await queryEvents(backend, { runId, family: "cpu_step", pcRange: [targetPc, targetPc], limit: 50 });
    ok(Array.isArray(rows) && rows.length > 0,
      "C1 runtime_query_events family=cpu_step (pc window) returns rows", `pc=$${targetPc.toString(16)} rows=${rows.length}`);
    ok(rows.length === 0 || (rows[0].pc === targetPc && typeof rows[0].cycle === "number"),
      "C2 returned cpu_step rows carry pc + cycle from the 726 schema", rows[0] ? `pc=$${rows[0].pc.toString(16)} cycle=${rows[0].cycle}` : "n/a");
  } finally { inst.closeSync?.(); }
} catch (e) { ok(false, "C1 runtime_query_events", e.message); }

// ---- D. anchors (marks) read from trace_mark ----
try {
  const anchors = await q.listAnchors(dbPath);
  ok(Array.isArray(anchors), "D1 trace_store_anchor_list reads trace_mark", `${anchors.length} anchors`);
} catch (e) { ok(false, "D1 trace_store_anchor_list", e.message); }

// ---- E. NO active reader SQL references meta / instructions ----
//   Audit the reader source for `FROM meta` / `FROM instructions` (the legacy
//   Spec-217 tables). Convenience readers must target trace_run/trace_event/
//   trace_mark (or neutral CTEs over them), never the legacy names.
const READER_SOURCES = [
  "src/runtime/trace-store/queries.ts",
  "src/runtime/headless/v2/query-events.ts",
];
const offenders = [];
for (const rel of READER_SOURCES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const src = readFileSync(p, "utf8");
  src.split("\n").forEach((ln, i) => {
    if (/^\s*\/\//.test(ln)) return; // skip comments
    if (/\bFROM\s+meta\b/i.test(ln) || /\bFROM\s+instructions\b/i.test(ln)) {
      offenders.push(`${rel}:${i + 1}: ${ln.trim().slice(0, 60)}`);
    }
  });
}
ok(offenders.length === 0, "E1 no active reader SQL references FROM meta / FROM instructions", offenders.slice(0, 6).join(" | ") || "none");

// cleanup the temp copy.
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${fail === 0 ? "GREEN" : "RED"} trace writer/reader contract: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
